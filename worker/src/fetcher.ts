// External account scheduler (docs/ARCHITECTURE.md §8).
//   * Each account runs in isolation; one slow or broken provider never blocks others.
//   * Global and per-provider-host concurrency caps (Hostinger etc. rate-limit by IP).
//   * A DB lease (next_run_at pushed forward while running) keeps several workers
//     from fetching the same account; a crashed run is retried when the lease ends.
//   * Network/protocol errors back off 30 s → 15 min; a failed login pauses the
//     account until an admin edits it; a full local mailbox waits 15 min.
//   * IMAP accounts with IDLE get a persistent watcher that triggers a fetch the
//     moment the provider announces new mail; polling remains as a safety net.
import type { ImapFlow } from 'imapflow';
import { classifyImapError, fetchAccount, FetchError, imapClient, raiseAlert, resolveAlert, db as dbm, type CoreContext, type ExternalAccount } from '@vpm/core';

const { exec, rows } = dbm;

export const BACKOFF_SEC = [30, 60, 120, 240, 480, 900];
const LEASE_MS = 10 * 60_000;
const IDLE_SAFETY_POLL_SEC = 300;
const QUOTA_RETRY_SEC = 900;

type AccountRow = ExternalAccount & {
  username: string;
  interval_sec: number;
  consecutive_fails: number;
  updated_at: Date;
  status: string;
  label: string | null;
};

export interface FetcherOptions {
  concurrency: number;
  perHost: number;
  maxPerRun: number;
  tickMs: number;
  timeoutMs: number;
  /** Run IMAP IDLE watchers (disable in tests that only exercise polling). */
  idle: boolean;
}

function jitter(sec: number): number {
  return Math.round(sec * 1000 * (0.9 + Math.random() * 0.2));
}

class IdleWatcher {
  active = false;
  private client: ImapFlow | null = null;
  private stopped = false;
  private retryMs = 5_000;

  constructor(
    private readonly ctx: CoreContext,
    readonly acc: AccountRow,
    /** 'exists': the provider announced new mail; 'connect': catch up after (re)connecting. */
    private readonly onNew: (reason: 'exists' | 'connect') => void,
  ) {}

  get key(): string {
    return `${this.acc.id}:${new Date(this.acc.updated_at).getTime()}`;
  }

  start(): void {
    void this.loop();
  }

  private async setActive(v: boolean): Promise<void> {
    this.active = v;
    await exec(this.ctx.db, 'UPDATE external_accounts SET idle_active = ? WHERE id = ?', [v ? 1 : 0, this.acc.id]).catch(() => {});
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const password = this.ctx.secrets.open(Buffer.from(this.acc.secret));
        const client = imapClient(this.acc, password);
        this.client = client;
        await client.connect();
        if (!client.capabilities.has('IDLE')) {
          this.ctx.log.info({ account: this.acc.id }, 'provider has no IDLE; polling only');
          await client.logout().catch(() => {});
          return;
        }
        const folders = (dbm.json<string[] | null>(this.acc.remote_folders) ?? ['INBOX']).filter(Boolean);
        await client.mailboxOpen(folders[0] ?? 'INBOX', { readOnly: true });
        client.on('exists', () => this.onNew('exists'));
        await this.setActive(true);
        this.retryMs = 5_000;
        this.onNew('connect'); // catch up on anything that arrived while disconnected
        while (!this.stopped && client.usable) await client.idle();
      } catch (e) {
        const fe = classifyImapError(e);
        if (fe.kind === 'auth') {
          this.stopped = true; // the scheduler reports and pauses auth failures
        } else if (!this.stopped) {
          this.ctx.log.debug({ err: fe.message, account: this.acc.id }, 'idle watcher disconnected');
        }
      } finally {
        if (this.active) await this.setActive(false);
        this.client?.close();
        this.client = null;
      }
      if (this.stopped) return;
      await new Promise((r) => setTimeout(r, this.retryMs));
      this.retryMs = Math.min(this.retryMs * 2, 5 * 60_000);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const c = this.client;
    if (c) await c.logout().catch(() => c.close());
    if (this.active) await this.setActive(false);
  }
}

export class Fetcher {
  private readonly opts: FetcherOptions;
  private readonly running = new Map<number, Promise<void>>();
  private readonly hostCount = new Map<string, number>();
  private readonly watchers = new Map<number, IdleWatcher>();
  private readonly rerun = new Set<number>();
  /** Accounts whose provider just announced new mail: fetched before routine work. */
  private readonly urgent = new Set<number>();
  /** Why an account was kicked, so fetch history shows push-triggered runs. */
  private readonly kickReason = new Map<number, 'idle' | 'manual'>();
  private timer: NodeJS.Timeout | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  private ticking = false;

  constructor(
    private readonly ctx: CoreContext,
    opts: Partial<FetcherOptions> = {},
  ) {
    const w = ctx.config.worker;
    this.opts = {
      concurrency: w.fetchConcurrency,
      perHost: w.fetchPerHost,
      maxPerRun: w.fetchMaxPerRun,
      tickMs: 1000,
      timeoutMs: 60_000,
      idle: true,
      ...opts,
    };
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.opts.tickMs);
    if (this.opts.idle) {
      void this.reconcileWatchers();
      // Every 5 s, so a newly connected or edited account gets push within seconds.
      this.reconcileTimer = setInterval(() => void this.reconcileWatchers(), 5_000);
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    this.timer = this.reconcileTimer = null;
    await Promise.all([...this.watchers.values()].map((w) => w.stop()));
    this.watchers.clear();
    await Promise.all(this.running.values());
  }

  /** Starts every due account that fits within the concurrency limits. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const free = this.opts.concurrency - this.running.size;
      if (free <= 0) return;
      const now = new Date();
      const urgentIds = [...this.urgent].filter((id) => !this.running.has(id)).slice(0, free * 3);
      const urgentRows = urgentIds.length
        ? await rows<AccountRow>(this.ctx.db, "SELECT * FROM external_accounts WHERE id IN (?) AND is_enabled = 1 AND status <> 'auth_failed' AND (next_run_at IS NULL OR next_run_at <= ?)", [urgentIds, now])
        : [];
      const routine = await rows<AccountRow>(
        this.ctx.db,
        `SELECT * FROM external_accounts WHERE is_enabled = 1 AND status <> 'auth_failed'
           AND (next_run_at IS NULL OR next_run_at <= ?) ORDER BY next_run_at IS NOT NULL, next_run_at LIMIT ?`,
        [now, free * 3],
      );
      const due = [...urgentRows, ...routine.filter((r) => !urgentIds.includes(r.id))];
      let started = 0;
      for (const acc of due) {
        if (started >= free) break;
        if (this.running.has(acc.id)) continue;
        const host = acc.host.toLowerCase();
        if ((this.hostCount.get(host) ?? 0) >= this.opts.perHost) continue;
        const claimed = await dbm.exec(
          this.ctx.db,
          `UPDATE external_accounts SET status = 'fetching', next_run_at = ?, last_attempt_at = ?
            WHERE id = ? AND is_enabled = 1 AND status <> 'auth_failed' AND (next_run_at IS NULL OR next_run_at <= ?)`,
          [new Date(now.getTime() + LEASE_MS), now, acc.id, now],
        );
        if (claimed.affectedRows !== 1) continue;
        started++;
        this.urgent.delete(acc.id);
        this.hostCount.set(host, (this.hostCount.get(host) ?? 0) + 1);
        const trigger = this.kickReason.get(acc.id) ?? 'schedule';
        this.kickReason.delete(acc.id);
        const p = this.run(acc, trigger).finally(() => {
          this.hostCount.set(host, (this.hostCount.get(host) ?? 1) - 1);
          this.running.delete(acc.id);
          if (this.rerun.delete(acc.id)) void this.kick(acc.id);
        });
        this.running.set(acc.id, p);
      }
    } catch (err) {
      this.ctx.log.error({ err }, 'fetch scheduler tick failed');
    } finally {
      this.ticking = false;
    }
  }

  /** Requests an immediate fetch (IDLE push, admin "Fetch now"); it goes ahead of routine polling. */
  async kick(accountId: number, reason: 'idle' | 'manual' = 'idle'): Promise<void> {
    this.kickReason.set(accountId, reason);
    this.urgent.add(accountId);
    if (this.running.has(accountId)) {
      this.rerun.add(accountId);
      return;
    }
    await exec(this.ctx.db, "UPDATE external_accounts SET next_run_at = ? WHERE id = ? AND status NOT IN ('auth_failed','fetching','connecting')", [new Date(), accountId]);
    setImmediate(() => void this.tick());
  }

  /** Waits until no fetch is running (tests). */
  async idleWait(): Promise<void> {
    while (this.running.size) await Promise.all(this.running.values());
  }

  private async run(acc: AccountRow, trigger: 'schedule' | 'idle' | 'manual'): Promise<void> {
    const started = new Date();
    const runRow = await exec(this.ctx.db, 'INSERT INTO fetch_runs (account_id, started_at, trigger_kind) VALUES (?,?,?)', [acc.id, started, trigger]);
    const name = `${acc.username} at ${acc.host}`;
    try {
      const res = await fetchAccount(this.ctx, acc, { maxPerRun: this.opts.maxPerRun, timeoutMs: this.opts.timeoutMs });
      const watching = this.watchers.get(acc.id)?.active ?? false;
      const interval = watching ? Math.max(acc.interval_sec, IDLE_SAFETY_POLL_SEC) : acc.interval_sec;
      const next = res.more ? new Date() : new Date(Date.now() + jitter(interval));
      await exec(
        this.ctx.db,
        `UPDATE external_accounts SET status = ?, last_error = NULL, last_success_at = ?, next_run_at = ?, consecutive_fails = 0,
           fetched_total = fetched_total + ?, remote_count = ?, remote_bytes = ? WHERE id = ?`,
        [watching ? 'idling' : 'idle', new Date(), next, res.fetched, res.remoteCount, res.remoteBytes, acc.id],
      );
      await exec(this.ctx.db, 'UPDATE fetch_runs SET finished_at = ?, fetched = ?, duplicates = ?, deleted_remote = ?, bytes = ?, result = ? WHERE id = ?', [
        new Date(),
        res.fetched,
        res.duplicates,
        res.deletedRemote,
        res.bytes,
        res.more ? 'partial' : 'ok',
        runRow.insertId,
      ]);
      for (const k of ['auth', 'fail', 'quota']) await resolveAlert(this.ctx.db, `ext.${k}.${acc.id}`);
      if (res.more) setImmediate(() => void this.tick());
    } catch (e) {
      const fe = e instanceof FetchError ? e : new FetchError('protocol', (e as Error).message);
      const fails = acc.consecutive_fails + 1;
      let status = 'backoff';
      let next: Date | null = new Date(Date.now() + jitter(BACKOFF_SEC[Math.min(fails, BACKOFF_SEC.length) - 1]!));
      let result = fe.kind === 'network' ? 'network' : 'protocol';
      if (fe.kind === 'auth') {
        status = 'auth_failed';
        next = null;
        result = 'auth_failed';
        await raiseAlert(this.ctx.db, {
          severity: 'critical',
          code: 'fetch.auth',
          message: `Login to the external mailbox ${name} failed (${fe.message}). Fetching is paused until the password is updated.`,
          dedupeKey: `ext.auth.${acc.id}`,
        });
      } else if (fe.kind === 'quota') {
        status = 'quota_full';
        next = new Date(Date.now() + QUOTA_RETRY_SEC * 1000);
        result = 'quota_full';
        await raiseAlert(this.ctx.db, { severity: 'warning', code: 'fetch.quota', message: `Mailbox for ${name} is full; new mail is waiting on the provider.`, dedupeKey: `ext.quota.${acc.id}` });
      } else if (fails >= 5) {
        await raiseAlert(this.ctx.db, { severity: 'warning', code: 'fetch.failing', message: `Fetching ${name} has failed ${fails} times in a row: ${fe.message}`, dedupeKey: `ext.fail.${acc.id}` });
      }
      await exec(this.ctx.db, 'UPDATE external_accounts SET status = ?, last_error = ?, next_run_at = ?, consecutive_fails = ? WHERE id = ?', [
        status,
        fe.message.slice(0, 1000),
        next,
        fe.kind === 'quota' ? acc.consecutive_fails : fails,
        acc.id,
      ]);
      await exec(this.ctx.db, 'UPDATE fetch_runs SET finished_at = ?, result = ?, error = ? WHERE id = ?', [new Date(), result, fe.message.slice(0, 1000), runRow.insertId]);
      this.ctx.log.warn({ account: acc.id, kind: fe.kind, err: fe.message }, 'fetch failed');
    }
  }

  /** New mail announced → fetch now; a (re)connect only catches up if the last fetch is older than a minute. */
  private async onWatcherNews(accountId: number, reason: 'exists' | 'connect'): Promise<void> {
    if (reason === 'connect') {
      const a = await dbm.one<{ last_success_at: Date | null }>(this.ctx.db, 'SELECT last_success_at FROM external_accounts WHERE id = ?', [accountId]);
      if (a?.last_success_at && Date.now() - new Date(a.last_success_at).getTime() < 60_000) return;
    }
    await this.kick(accountId);
  }

  /** IMAP accounts whose IDLE connection is up (diagnostics, load tests). */
  get activeWatchers(): number {
    return [...this.watchers.values()].filter((w) => w.active).length;
  }

  /** Keeps one IDLE watcher per enabled IMAP account that asks for push. */
  async reconcileWatchers(): Promise<void> {
    try {
      const want = await rows<AccountRow>(
        this.ctx.db,
        "SELECT * FROM external_accounts WHERE protocol = 'imap' AND use_idle = 1 AND is_enabled = 1 AND status <> 'auth_failed'",
      );
      const wantIds = new Set(want.map((a) => a.id));
      for (const [id, w] of this.watchers) {
        const fresh = want.find((a) => a.id === id);
        if (!wantIds.has(id) || (fresh && `${fresh.id}:${new Date(fresh.updated_at).getTime()}` !== w.key)) {
          await w.stop();
          this.watchers.delete(id);
        }
      }
      let starting = 0;
      for (const acc of want) {
        if (this.watchers.has(acc.id)) continue;
        const w = new IdleWatcher(this.ctx, acc, (reason) => void this.onWatcherNews(acc.id, reason));
        this.watchers.set(acc.id, w);
        // Stagger connections (25 per 100 ms): no connection storm towards the providers at start-up.
        setTimeout(() => w.start(), Math.floor(starting++ / 25) * 100);
      }
    } catch (err) {
      this.ctx.log.error({ err }, 'idle watcher reconcile failed');
    }
  }
}
