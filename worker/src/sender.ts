// Outbound relay sender. Claims due rows from outbound_queue, sends each
// through its resolved relay with nodemailer, records per-recipient results,
// retries temporary failures and bounces permanent ones back to the local
// sender. Mail is never dropped: with no relay configured, messages wait
// (deferred, with an admin alert) until the queue entry expires.
import { hostname as osHostname } from 'node:os';
import type { Transporter } from 'nodemailer';
import { buildDsn, createTransport, raiseAlert, resolveAlert, resolveRelay, relayTargetFromRow, type CoreContext, type DsnFailure, type RelayTarget } from '@vpm/core';
import { db as dbm } from '@vpm/core';

const { exec, one, rows } = dbm;

/** Minutes until the next attempt after attempt n (1-based); hourly afterwards. */
export const RETRY_MINUTES = [1, 5, 15, 30, 60];
const LOCK_MS = 5 * 60_000;
const NO_BOUNCE_SOURCES = new Set(['bounce', 'autoreply', 'journal']);

interface QueueRow {
  id: number;
  message_id: number;
  envelope_from: string;
  sender_user_id: number | null;
  source: string;
  relay_account_id: number | null;
  via_external_account_id: number | null;
  status: string;
  attempts: number;
  next_attempt_at: Date;
  expires_at: Date;
  created_at: Date;
}

interface RcptRow {
  id: number;
  rcpt: string;
  status: 'pending' | 'sent' | 'deferred' | 'failed';
  attempts: number;
}

interface SmtpError extends Error {
  code?: string;
  responseCode?: number;
  response?: string;
  command?: string;
  rejected?: string[];
  rejectedErrors?: SmtpError[];
  recipient?: string;
}

export interface SendResult {
  queueId: number;
  status: string;
}

export class OutboundSender {
  private readonly transports = new Map<string, Transporter>();
  private readonly windows = new Map<string, { start: number; count: number }>();
  private readonly owner = `${osHostname()}:${process.pid}:sender`;
  private timer: NodeJS.Timeout | null = null;
  private busy: Promise<number> | null = null;
  private claims = 0;

  constructor(
    private readonly ctx: CoreContext,
    private readonly opts: { batch?: number; concurrency?: number } = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick().catch((err) => this.ctx.log.error({ err }, 'relay tick failed')), this.ctx.config.worker.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.busy) await this.busy.catch(() => 0);
    for (const t of this.transports.values()) t.close();
    this.transports.clear();
  }

  /** Processes one batch of due messages. Returns how many were handled. Safe to call concurrently. */
  tick(): Promise<number> {
    if (this.busy) return this.busy;
    this.busy = this.runBatch().finally(() => {
      this.busy = null;
    });
    return this.busy;
  }

  private async runBatch(): Promise<number> {
    const token = `${this.owner}:${++this.claims}`;
    const now = new Date();
    await exec(
      this.ctx.db,
      `UPDATE outbound_queue SET status = 'sending', locked_by = ?, locked_until = ?, updated_at = ?
        WHERE (status IN ('queued','deferred') AND next_attempt_at <= ?) OR (status = 'sending' AND locked_until < ?)
        ORDER BY priority DESC, next_attempt_at, id LIMIT ?`,
      [token, new Date(now.getTime() + LOCK_MS), now, now, now, this.opts.batch ?? 50],
    );
    const claimed = await rows<QueueRow>(this.ctx.db, "SELECT * FROM outbound_queue WHERE locked_by = ? AND status = 'sending' ORDER BY id", [token]);
    const conc = Math.max(1, this.opts.concurrency ?? 8);
    let i = 0;
    const workers = Array.from({ length: Math.min(conc, claimed.length) }, async () => {
      while (i < claimed.length) {
        const q = claimed[i++]!;
        try {
          await this.process(q);
        } catch (err) {
          this.ctx.log.error({ err, queueId: q.id }, 'relay processing failed');
          await this.defer(q, (err as Error).message);
        }
      }
    });
    await Promise.all(workers);
    return claimed.length;
  }

  private async target(q: QueueRow): Promise<RelayTarget | null> {
    if (q.relay_account_id) {
      const r = await one(this.ctx.db, 'SELECT * FROM relay_accounts WHERE id = ? AND is_enabled = 1', [q.relay_account_id]);
      if (r) return relayTargetFromRow(r as Parameters<typeof relayTargetFromRow>[0]);
    }
    return resolveRelay(this.ctx.db, q.sender_user_id, q.envelope_from);
  }

  private transport(t: RelayTarget): Transporter {
    let tr = this.transports.get(t.key);
    if (!tr) {
      // A changed account (new updated_at) gets a new key; drop the stale pool.
      for (const [k, old] of this.transports) {
        if (k.startsWith(`${t.kind}:${t.id}:`)) {
          old.close();
          this.transports.delete(k);
        }
      }
      tr = createTransport(t, this.ctx.secrets, { hostname: this.ctx.config.hostname, pool: true });
      this.transports.set(t.key, tr);
    }
    return tr;
  }

  /** Simple per-relay sliding minute window. Returns ms to wait, or 0. */
  private rateWait(t: RelayTarget): number {
    if (!t.maxPerMinute) return 0;
    const w = this.windows.get(t.key);
    const now = Date.now();
    if (!w || now - w.start >= 60_000) {
      this.windows.set(t.key, { start: now, count: 1 });
      return 0;
    }
    if (w.count >= t.maxPerMinute) return 60_000 - (now - w.start);
    w.count++;
    return 0;
  }

  private async process(q: QueueRow): Promise<void> {
    const pending = await rows<RcptRow>(this.ctx.db, "SELECT id, rcpt, status, attempts FROM outbound_recipients WHERE queue_id = ? AND status IN ('pending','deferred')", [q.id]);
    if (!pending.length) return this.finalize(q, false);

    const t = await this.target(q);
    if (!t) {
      await raiseAlert(this.ctx.db, { severity: 'critical', code: 'relay.missing', message: 'Outgoing mail is waiting: no SMTP relay account is configured or enabled.', dedupeKey: 'relay.missing' });
      return this.defer(q, 'No SMTP relay configured', pending);
    }
    if (t.kind === 'relay' && q.relay_account_id !== t.id) {
      await exec(this.ctx.db, 'UPDATE outbound_queue SET relay_account_id = ? WHERE id = ?', [t.id, q.id]);
    }
    const wait = this.rateWait(t);
    if (wait > 0) {
      await exec(this.ctx.db, "UPDATE outbound_queue SET status = 'queued', next_attempt_at = ?, locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ?", [
        new Date(Date.now() + wait),
        new Date(),
        q.id,
      ]);
      return;
    }

    const msg = await one<{ storage_path: string; codec: number; header_raw: Buffer | null }>(this.ctx.db, 'SELECT storage_path, codec, header_raw FROM messages WHERE id = ?', [q.message_id]);
    if (!msg) throw new Error(`message ${q.message_id} missing`);
    let raw = await this.ctx.store.loadRaw(msg);

    const envFrom = q.envelope_from === '' ? '' : t.envelopeFrom === 'relay_account' && t.authUser ? t.authUser : q.envelope_from;
    if (t.setSenderHeader && t.authUser && t.authUser.toLowerCase() !== q.envelope_from.toLowerCase()) {
      const hdrEnd = raw.indexOf('\r\n\r\n');
      const head = raw.subarray(0, hdrEnd === -1 ? raw.length : hdrEnd).toString('latin1');
      if (!/^sender:/im.test(head)) raw = Buffer.concat([Buffer.from(`Sender: <${t.authUser}>\r\n`), raw]);
    }

    const results = new Map<string, { ok: boolean; permanent: boolean; code: number | null; response: string }>();
    try {
      const info = await this.transport(t).sendMail({ envelope: { from: envFrom, to: pending.map((p) => p.rcpt) }, raw });
      for (const a of (info.accepted as string[]) ?? []) results.set(String(a).toLowerCase(), { ok: true, permanent: false, code: 250, response: String(info.response ?? '250 OK') });
      for (const e of ((info as unknown as { rejectedErrors?: SmtpError[] }).rejectedErrors ?? [])) {
        if (e.recipient) results.set(e.recipient.toLowerCase(), this.classify(e));
      }
      for (const r of (info.rejected as string[]) ?? []) {
        if (!results.has(String(r).toLowerCase())) results.set(String(r).toLowerCase(), { ok: false, permanent: false, code: null, response: 'Rejected by relay' });
      }
      await resolveAlert(this.ctx.db, `relay.auth.${t.key.split(':').slice(0, 2).join(':')}`);
    } catch (err) {
      const e = err as SmtpError;
      if (e.code === 'EAUTH') {
        await raiseAlert(this.ctx.db, {
          severity: 'critical',
          code: 'relay.auth',
          message: `SMTP relay "${t.name}" rejected the login: ${e.response ?? e.message}`,
          dedupeKey: `relay.auth.${t.key.split(':').slice(0, 2).join(':')}`,
        });
      }
      if (e.rejectedErrors?.length) {
        for (const re of e.rejectedErrors) if (re.recipient) results.set(re.recipient.toLowerCase(), this.classify(re));
      } else {
        // Whole-transaction failure (connect, auth, MAIL FROM, DATA): applies to every recipient.
        const c = e.code === 'EAUTH' ? { ...this.classify(e), permanent: false } : this.classify(e);
        for (const p of pending) results.set(p.rcpt.toLowerCase(), c);
        if (e.command === 'MAIL FROM' && c.permanent) {
          await raiseAlert(this.ctx.db, {
            severity: 'warning',
            code: 'relay.sender_refused',
            message: `Relay "${t.name}" refused sender <${envFrom}>: ${e.response ?? e.message}. Consider a per-user route via the employee's own account.`,
            dedupeKey: `relay.sender_refused.${t.id}`,
          });
        }
      }
    }

    const now = new Date();
    for (const p of pending) {
      const r = results.get(p.rcpt.toLowerCase()) ?? { ok: false, permanent: false, code: null, response: 'No response for recipient' };
      const status = r.ok ? 'sent' : r.permanent ? 'failed' : 'deferred';
      p.status = status;
      await exec(this.ctx.db, 'UPDATE outbound_recipients SET status = ?, attempts = attempts + 1, smtp_code = ?, smtp_response = ?, updated_at = ? WHERE id = ?', [
        status,
        r.code,
        r.response.slice(0, 1000),
        now,
        p.id,
      ]);
      await this.mailLog(q, p.rcpt, r.ok ? 'relayed' : r.permanent ? 'bounced' : 'deferred', `${t.name}: ${r.response}`.slice(0, 1000));
    }

    const stillDeferred = pending.filter((p) => p.status === 'deferred');
    if (stillDeferred.length) {
      const attempts = q.attempts + 1;
      if (now >= new Date(q.expires_at)) {
        for (const p of stillDeferred) {
          await exec(this.ctx.db, "UPDATE outbound_recipients SET status = 'failed', smtp_response = CONCAT('Expired after retries: ', COALESCE(smtp_response, '')) WHERE id = ?", [p.id]);
        }
        return this.finalize(q, true);
      }
      const delayMin = RETRY_MINUTES[attempts - 1] ?? 60;
      const lastErr = [...results.values()].find((r) => !r.ok)?.response ?? null;
      await exec(
        this.ctx.db,
        "UPDATE outbound_queue SET status = 'deferred', attempts = ?, next_attempt_at = ?, last_error = ?, locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ?",
        [attempts, new Date(now.getTime() + delayMin * 60_000), lastErr?.slice(0, 1000) ?? null, now, q.id],
      );
      return;
    }
    await exec(this.ctx.db, 'UPDATE outbound_queue SET attempts = attempts + 1 WHERE id = ?', [q.id]);
    return this.finalize(q, false);
  }

  private classify(e: SmtpError): { ok: boolean; permanent: boolean; code: number | null; response: string } {
    const code = typeof e.responseCode === 'number' ? e.responseCode : null;
    return { ok: false, permanent: code !== null && code >= 500, code, response: (e.response ?? e.message ?? 'Unknown error').toString() };
  }

  /** Terminal state: computes final status, releases the message reference, bounces failures. */
  private async finalize(q: QueueRow, expired: boolean): Promise<void> {
    const all = await rows<{ rcpt: string; status: string; smtp_code: number | null; smtp_response: string | null }>(
      this.ctx.db,
      'SELECT rcpt, status, smtp_code, smtp_response FROM outbound_recipients WHERE queue_id = ?',
      [q.id],
    );
    const sent = all.filter((r) => r.status === 'sent').length;
    const failed = all.filter((r) => r.status === 'failed');
    const status = failed.length === 0 ? 'sent' : sent === 0 ? 'failed' : 'partial';
    const now = new Date();
    const res = await exec(
      this.ctx.db,
      "UPDATE outbound_queue SET status = ?, completed_at = ?, locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ? AND status = 'sending'",
      [status, now, now, q.id],
    );
    if (res.affectedRows !== 1) return; // someone (admin delete/hold) changed it meanwhile
    await exec(this.ctx.db, 'UPDATE messages SET refcount = refcount - 1 WHERE id = ? AND refcount > 0', [q.message_id]);
    if (failed.length && q.envelope_from && !NO_BOUNCE_SOURCES.has(q.source)) {
      await this.bounce(
        q,
        failed.map((f) => ({ rcpt: f.rcpt, code: f.smtp_code, response: f.smtp_response ?? 'Delivery failed' })),
        expired,
      );
    }
  }

  private async bounce(q: QueueRow, failures: DsnFailure[], expired: boolean): Promise<void> {
    const res = await this.ctx.directory.resolve(q.envelope_from);
    if (res.kind !== 'local' || !res.userIds.length) {
      this.ctx.log.warn({ queueId: q.id, sender: q.envelope_from }, 'bounce for non-local sender dropped');
      return;
    }
    const hdr = await one<{ header_raw: Buffer | null }>(this.ctx.db, 'SELECT header_raw FROM messages WHERE id = ?', [q.message_id]);
    const dsn = buildDsn({
      hostname: this.ctx.config.hostname,
      to: q.envelope_from,
      originalHeaders: hdr?.header_raw ?? Buffer.alloc(0),
      failures,
      queueId: q.id,
      arrival: new Date(q.created_at),
      expired,
    });
    const message = await this.ctx.store.ingest(dsn);
    await this.ctx.delivery.deliver({ message, targets: res.userIds.map((userId) => ({ userId })), origin: 'internal', envelopeFrom: '', dedup: false, ignoreQuota: true });
  }

  private async defer(q: QueueRow, error: string, pending?: RcptRow[]): Promise<void> {
    const now = new Date();
    const attempts = q.attempts + 1;
    if (now >= new Date(q.expires_at)) {
      await exec(this.ctx.db, "UPDATE outbound_recipients SET status = 'failed', smtp_response = ? WHERE queue_id = ? AND status IN ('pending','deferred')", [
        `Expired: ${error}`.slice(0, 1000),
        q.id,
      ]);
      return this.finalize(q, true);
    }
    if (pending) for (const p of pending) await this.mailLog(q, p.rcpt, 'deferred', error);
    await exec(
      this.ctx.db,
      "UPDATE outbound_queue SET status = 'deferred', attempts = ?, next_attempt_at = ?, last_error = ?, locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ? AND status = 'sending'",
      [attempts, new Date(now.getTime() + (RETRY_MINUTES[attempts - 1] ?? 60) * 60_000), error.slice(0, 1000), now, q.id],
    );
  }

  private async mailLog(q: QueueRow, rcpt: string, event: string, detail: string): Promise<void> {
    await exec(
      this.ctx.db,
      `INSERT INTO mail_log (at, event, direction, envelope_from, rcpt, user_id, ref_type, ref_id, detail) VALUES (?,?,'out',?,?,?,'queue',?,?)`,
      [new Date(), event, q.envelope_from, rcpt, q.sender_user_id, q.id, detail],
    ).catch(() => {});
  }
}
