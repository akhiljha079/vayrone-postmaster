// Fetches one external POP3/IMAP account into its local mailbox.
//
// Safety rules (docs/ARCHITECTURE.md §5.1):
//   * A remote message is deleted only after the local copy is committed
//     (POP3: deletions only take effect at a successful QUIT).
//   * Every downloaded message is recorded in external_seen, so it is never
//     downloaded again; the per-mailbox dedup ledger catches the rest.
//   * When the local mailbox is full, the run stops and the mail stays on the
//     provider — nothing is dropped.
//   * "Download mail received from <date>" (fetch_since): older provider mail is
//     remembered as skipped, never downloaded, and never deleted by the
//     leave-on-server policy (PostMaster never had a copy of it).
import { createHash } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import type { CoreContext } from '../context.js';
import { exec, json, one, rows } from '../db.js';
import { messageIdHash } from '../mime/mime.js';
import { StoreError } from '../store/mailstore.js';
import { FetchError, Pop3Client } from './pop3-client.js';

export type Protocol = 'pop3' | 'imap';
export type Security = 'none' | 'starttls' | 'tls';

export interface ExternalAccount {
  id: number;
  user_id: number;
  protocol: Protocol;
  host: string;
  port: number;
  security: Security;
  tls_verify: number;
  username: string;
  secret: Buffer;
  remote_folders: unknown;
  target_folder_id: number | null;
  leave_policy: 'delete' | 'keep' | 'keep_days';
  keep_days: number;
  use_idle: number;
  /** Only mail that reached the provider on or after this moment is downloaded. */
  fetch_since?: Date | null;
}

export interface FetchResult {
  fetched: number;
  duplicates: number;
  deletedRemote: number;
  bytes: number;
  remoteCount: number;
  remoteBytes: number | null;
  /** More new messages remain on the server (per-run limit reached). */
  more: boolean;
  /** Older than the account's "download mail received from" date: left alone. */
  skipped: number;
}

export interface FetchOptions {
  maxPerRun: number;
  timeoutMs?: number;
}

const keyHash = (k: string) => createHash('sha256').update(k).digest();

/** Raised when the local mailbox has no room; the remote copy is left in place. */
export class QuotaFullError extends FetchError {
  constructor() {
    super('quota', 'Local mailbox is full; mail is being left on the provider until space is freed');
  }
}

class Run {
  readonly result: FetchResult = { fetched: 0, duplicates: 0, deletedRemote: 0, bytes: 0, remoteCount: 0, remoteBytes: null, more: false, skipped: 0 };
  private seen = new Map<string, Date>(); // hex hash → first_seen_at
  private skippedKeys = new Set<string>(); // hex hashes of mail older than fetch_since
  private targetFolderId: number | null = null;

  constructor(
    readonly ctx: CoreContext,
    readonly acc: ExternalAccount,
  ) {}

  async init(): Promise<void> {
    const r = await rows<{ remote_key_hash: Buffer; first_seen_at: Date; skipped: number }>(
      this.ctx.db,
      'SELECT remote_key_hash, first_seen_at, skipped FROM external_seen WHERE account_id = ? AND remote_deleted_at IS NULL',
      [this.acc.id],
    );
    for (const x of r) {
      const h = Buffer.from(x.remote_key_hash).toString('hex');
      this.seen.set(h, new Date(x.first_seen_at));
      if (x.skipped) this.skippedKeys.add(h);
    }
    if (this.acc.target_folder_id) {
      const f = await one<{ id: number }>(this.ctx.db, 'SELECT id FROM folders WHERE id = ? AND user_id = ?', [this.acc.target_folder_id, this.acc.user_id]);
      this.targetFolderId = f?.id ?? null;
    }
  }

  isSeen(key: string): boolean {
    return this.seen.has(keyHash(key).toString('hex'));
  }

  firstSeen(key: string): Date | undefined {
    return this.seen.get(keyHash(key).toString('hex'));
  }

  async markSeen(key: string, itemId: number | null): Promise<void> {
    const h = keyHash(key);
    await exec(this.ctx.db, 'INSERT IGNORE INTO external_seen (account_id, remote_key_hash, remote_key, first_seen_at, item_id) VALUES (?,?,?,?,?)', [
      this.acc.id,
      h,
      key.slice(0, 600),
      new Date(),
      itemId,
    ]);
    this.seen.set(h.toString('hex'), new Date());
  }

  /** Mail older than fetch_since: remembered so it is never looked at again, but not downloaded. */
  async markSkipped(key: string): Promise<void> {
    const h = keyHash(key);
    await exec(this.ctx.db, 'INSERT IGNORE INTO external_seen (account_id, remote_key_hash, remote_key, first_seen_at, item_id, skipped) VALUES (?,?,?,?,NULL,1)', [
      this.acc.id,
      h,
      key.slice(0, 600),
      new Date(),
    ]);
    this.seen.set(h.toString('hex'), new Date());
    this.skippedKeys.add(h.toString('hex'));
    this.result.skipped++;
  }

  /** Before the start date (by the time it reached the provider)? */
  tooOld(arrived: Date | null): boolean {
    const since = this.acc.fetch_since ? new Date(this.acc.fetch_since) : null;
    return Boolean(since && arrived && arrived.getTime() < since.getTime());
  }

  async markDeleted(keys: string[]): Promise<void> {
    for (const k of keys) {
      await exec(this.ctx.db, 'UPDATE external_seen SET remote_deleted_at = ? WHERE account_id = ? AND remote_key_hash = ?', [new Date(), this.acc.id, keyHash(k)]);
      this.seen.delete(keyHash(k).toString('hex'));
    }
  }

  /** Seen keys (of this run's key prefix) that are no longer on the server: mark them gone. */
  async forgetMissing(prefix: string, present: Set<string>): Promise<void> {
    const r = await rows<{ remote_key: string }>(
      this.ctx.db,
      'SELECT remote_key FROM external_seen WHERE account_id = ? AND remote_deleted_at IS NULL AND remote_key LIKE ?',
      [this.acc.id, `${prefix}%`],
    );
    const gone = r.map((x) => x.remote_key).filter((k) => !present.has(k));
    if (gone.length) await this.markDeleted(gone);
  }

  async checkQuota(size: number): Promise<void> {
    try {
      await this.ctx.store.assertQuota(this.acc.user_id, size);
    } catch (e) {
      if (e instanceof StoreError && e.code === 'OVERQUOTA') throw new QuotaFullError();
      throw e;
    }
  }

  /**
   * Stores and delivers one downloaded message. Returns the local item id (null when it was a duplicate).
   * `receivedAt` (when it reached the provider) becomes its received date, so mail programs show the
   * original date rather than the moment PostMaster downloaded it.
   */
  async deliver(raw: Buffer, receivedAt: Date | null): Promise<number | null> {
    const message = await this.ctx.store.ingest(raw);
    const rp = message.parsed.headers.find((h) => h.key === 'return-path')?.value.replace(/[<>\s]/g, '') ?? '';
    const [o] = await this.ctx.mailflow.inbound({
      message,
      recipients: [{ userId: this.acc.user_id, folderId: this.targetFolderId }],
      origin: 'fetch',
      direction: 'in',
      envelopeFrom: rp,
      externalAccountId: this.acc.id,
      receivedAt: plausible(receivedAt),
    });
    if (!o) throw new Error('no delivery outcome');
    if (o.status === 'overquota') throw new QuotaFullError();
    if (o.status === 'failed') throw new FetchError('protocol', `Local delivery failed: ${o.error ?? 'unknown'}`);
    this.result.bytes += message.size;
    if (o.status === 'discarded' || o.status === 'rejected') return null; // handled by a mail rule
    if (o.status === 'duplicate') {
      this.result.duplicates++;
      return null;
    }
    this.result.fetched++;
    const item = await one<{ id: number }>(this.ctx.db, 'SELECT id FROM mail_items WHERE folder_id = ? AND uid = ?', [o.folderId, o.uid]);
    return item?.id ?? null;
  }

  shouldDeleteOld(key: string): boolean {
    // Never delete provider mail that was skipped (PostMaster has no copy of it).
    if (this.skippedKeys.has(keyHash(key).toString('hex'))) return false;
    const first = this.firstSeen(key);
    if (this.acc.leave_policy === 'delete') return true;
    if (this.acc.leave_policy !== 'keep_days' || !first) return false;
    return Date.now() - first.getTime() >= this.acc.keep_days * 86400_000;
  }
}

/** An arrival time worth keeping: not in the future (clock skew allowed) and not before 1995. */
function plausible(d: Date | null): Date | null {
  if (!d || Number.isNaN(d.getTime())) return null;
  if (d.getTime() > Date.now() + 86_400_000 || d.getFullYear() < 1995) return null;
  return d;
}

/**
 * When a message reached the provider: the date of the topmost Received: header
 * (added by the provider on arrival), else the Date: header. Null when unknown,
 * in which case the message is downloaded (never skip mail by guessing).
 */
export function arrivalDate(head: Buffer | string): Date | null {
  const text = (typeof head === 'string' ? head : head.toString('latin1')).split(/\r?\n\r?\n/)[0]!.replace(/\r?\n[ \t]+/g, ' ');
  const lines = text.split(/\r?\n/);
  const received = lines.find((l) => /^received:/i.test(l));
  const when = received?.includes(';') ? received.slice(received.lastIndexOf(';') + 1) : lines.find((l) => /^date:/i.test(l))?.slice(5);
  if (!when) return null;
  const t = Date.parse(when.trim().replace(/\s*\([^)]*\)\s*$/, ''));
  return Number.isNaN(t) ? null : new Date(t);
}

// ---------------------------------------------------------------------------
// POP3
// ---------------------------------------------------------------------------

async function fetchPop3(ctx: CoreContext, acc: ExternalAccount, password: string, opts: FetchOptions): Promise<FetchResult> {
  const run = new Run(ctx, acc);
  await run.init();
  const c = await Pop3Client.connect({ host: acc.host, port: acc.port, security: acc.security, tlsVerify: Boolean(acc.tls_verify), timeoutMs: opts.timeoutMs });
  try {
    await c.login(acc.username, password);
    const stat = await c.stat();
    run.result.remoteCount = stat.count;
    run.result.remoteBytes = stat.size;
    if (stat.count === 0) {
      await run.forgetMissing('pop3', new Set());
      await c.quit();
      return run.result;
    }
    const sizes = await c.list();
    let uidl = await c.uidl();
    const keyOf = new Map<number, string>();
    if (uidl) {
      for (const [n, u] of uidl) keyOf.set(n, `pop3:${u}`);
    } else {
      // No UIDL support: identify messages by a hash of their headers (TOP n 0).
      uidl = new Map();
      for (const n of sizes.keys()) {
        const head = await c.top(n, 0);
        keyOf.set(n, `pop3h:${createHash('sha256').update(head).update(String(sizes.get(n))).digest('hex')}`);
      }
    }

    const toDelete: { n: number; key: string }[] = [];
    let downloaded = 0;
    for (const n of [...sizes.keys()].sort((a, b) => a - b)) {
      const key = keyOf.get(n);
      if (!key) continue;
      if (run.isSeen(key)) {
        if (run.shouldDeleteOld(key)) toDelete.push({ n, key });
        continue;
      }
      if (acc.fetch_since && run.tooOld(arrivalDate(await c.top(n, 0)))) {
        await run.markSkipped(key);
        continue;
      }
      if (downloaded >= opts.maxPerRun) {
        run.result.more = true;
        break;
      }
      await run.checkQuota(sizes.get(n) ?? 0);
      const raw = await c.retr(n);
      const itemId = await run.deliver(raw, arrivalDate(raw));
      await run.markSeen(key, itemId);
      downloaded++;
      if (acc.leave_policy === 'delete') toDelete.push({ n, key });
    }

    for (const d of toDelete) await c.dele(d.n);
    const committed = await c.quit();
    if (committed && toDelete.length) {
      await run.markDeleted(toDelete.map((d) => d.key));
      run.result.deletedRemote = toDelete.length;
    }
    const present = new Set([...keyOf.values()].filter((k) => !toDelete.some((d) => d.key === k)));
    await run.forgetMissing(uidl.size ? 'pop3:' : 'pop3h:', present);
    return run.result;
  } catch (e) {
    c.close(); // no QUIT: the server rolls back any DELE of this session
    throw e;
  }
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

export function imapClient(acc: Pick<ExternalAccount, 'host' | 'port' | 'security' | 'tls_verify' | 'username'>, password: string, timeoutMs = 60_000): ImapFlow {
  return new ImapFlow({
    host: acc.host,
    port: acc.port,
    secure: acc.security === 'tls',
    doSTARTTLS: acc.security === 'starttls' ? true : acc.security === 'none' ? false : undefined,
    auth: { user: acc.username, pass: password },
    tls: { rejectUnauthorized: Boolean(acc.tls_verify) },
    logger: false,
    connectionTimeout: timeoutMs,
    greetingTimeout: Math.min(timeoutMs, 30_000),
    socketTimeout: timeoutMs * 5,
    disableAutoIdle: true,
  });
}

/** Maps imapflow/socket errors to scheduler categories. */
export function classifyImapError(e: unknown): FetchError {
  if (e instanceof FetchError) return e;
  const err = e as { authenticationFailed?: boolean; code?: string; message?: string; responseText?: string; serverResponseCode?: string };
  const msg = err.responseText || err.message || String(e);
  if (err.authenticationFailed || err.serverResponseCode === 'AUTHENTICATIONFAILED' || /auth/i.test(err.code ?? '')) return new FetchError('auth', `Login failed: ${msg}`);
  if (err.code && /^(E[A-Z]+|NoConnection|ETIMEOUT)/.test(err.code)) return new FetchError('network', msg);
  if (/timeout|ECONN|ENOTFOUND|EHOSTUNREACH|socket|closed/i.test(msg)) return new FetchError('network', msg);
  return new FetchError('protocol', msg);
}

async function fetchImap(ctx: CoreContext, acc: ExternalAccount, password: string, opts: FetchOptions): Promise<FetchResult> {
  const run = new Run(ctx, acc);
  await run.init();
  const client = imapClient(acc, password, opts.timeoutMs);
  await client.connect().catch((e) => {
    throw classifyImapError(e);
  });
  try {
    const folders = (json<string[] | null>(acc.remote_folders) ?? ['INBOX']).filter(Boolean);
    let downloaded = 0;
    for (const folder of folders) {
      const lock = await client.getMailboxLock(folder);
      try {
        const mb = client.mailbox;
        if (!mb) continue;
        const uidvalidity = Number(mb.uidValidity);
        run.result.remoteCount += mb.exists;
        const state = await one<{ uidvalidity: number; last_uid: number }>(ctx.db, 'SELECT uidvalidity, last_uid FROM external_imap_state WHERE account_id = ? AND remote_folder = ?', [
          acc.id,
          folder,
        ]);
        // UIDVALIDITY changed (mailbox rebuilt at the provider): every UID is new. Re-sync by
        // Message-ID so mail we already have is not downloaded again.
        const resync = Boolean(state && Number(state.uidvalidity) !== uidvalidity);
        let lastUid = state && !resync ? Number(state.last_uid) : 0;
        await exec(
          ctx.db,
          `INSERT INTO external_imap_state (account_id, remote_folder, uidvalidity, last_uid, updated_at) VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE uidvalidity = VALUES(uidvalidity), last_uid = VALUES(last_uid), updated_at = VALUES(updated_at)`,
          [acc.id, folder, uidvalidity, lastUid, new Date()],
        );
        const prefix = `imap:${folder}:${uidvalidity}:`;
        const all = mb.exists ? ((await client.search({ all: true }, { uid: true })) || []).sort((a, b) => a - b) : [];
        const fresh = all.filter((u) => u > lastUid && !run.isSeen(prefix + u));

        let knownIds = new Set<string>();
        if (resync && fresh.length) {
          const have = await rows<{ h: Buffer }>(
            ctx.db,
            'SELECT DISTINCT m.hdr_message_id_hash AS h FROM mail_items i JOIN messages m ON m.id = i.message_id WHERE i.user_id = ? AND m.hdr_message_id_hash IS NOT NULL',
            [acc.user_id],
          );
          knownIds = new Set(have.map((x) => Buffer.from(x.h).toString('hex')));
        }

        // "Download mail received from": the provider's arrival date (INTERNALDATE). SEARCH works by
        // whole days (and imapflow rounds a BEFORE with a time up to the next day), so ask only for
        // mail before the start day; mail on the start day itself is checked to the minute below.
        const since = acc.fetch_since ? new Date(acc.fetch_since) : null;
        const startDay = since ? new Date(Date.UTC(since.getUTCFullYear(), since.getUTCMonth(), since.getUTCDate())) : null;
        const tooOld = new Set<number>(startDay && fresh.length ? ((await client.search({ before: startDay }, { uid: true })) || []) : []);

        const toDelete: number[] = [];
        for (const uid of fresh) {
          if (tooOld.has(uid)) {
            await run.markSkipped(prefix + uid);
            continue;
          }
          if (downloaded >= opts.maxPerRun) {
            run.result.more = true;
            break;
          }
          if (resync) {
            const env = await client.fetchOne(String(uid), { envelope: true }, { uid: true });
            const h = env && env.envelope?.messageId ? messageIdHash(env.envelope.messageId) : null;
            if (h && knownIds.has(h.toString('hex'))) {
              await run.markSeen(prefix + uid, null);
              run.result.duplicates++;
              lastUid = uid;
              continue;
            }
          }
          const meta = await client.fetchOne(String(uid), { size: true, source: true, internalDate: true }, { uid: true });
          if (!meta || !meta.source) continue; // expunged meanwhile
          const arrived = meta.internalDate ? new Date(meta.internalDate) : arrivalDate(meta.source);
          // SEARCH BEFORE works by day; on the start day itself compare the exact time.
          if (run.tooOld(arrived)) {
            await run.markSkipped(prefix + uid);
            continue;
          }
          await run.checkQuota(meta.size ?? meta.source.length);
          const itemId = await run.deliver(meta.source, arrived);
          await run.markSeen(prefix + uid, itemId);
          downloaded++;
          lastUid = uid;
          await exec(ctx.db, 'UPDATE external_imap_state SET last_uid = GREATEST(last_uid, ?), updated_at = ? WHERE account_id = ? AND remote_folder = ?', [uid, new Date(), acc.id, folder]);
          if (acc.leave_policy === 'delete') toDelete.push(uid);
        }

        // Old messages we already have: delete per policy.
        if (acc.leave_policy !== 'keep') {
          for (const uid of all) {
            if (toDelete.includes(uid) || !run.isSeen(prefix + uid)) continue;
            if (run.shouldDeleteOld(prefix + uid)) toDelete.push(uid);
          }
        }
        if (toDelete.length) {
          const ok = await client.messageDelete(toDelete.join(','), { uid: true });
          if (ok) {
            await run.markDeleted(toDelete.map((u) => prefix + u));
            run.result.deletedRemote += toDelete.length;
          }
        }
        await run.forgetMissing(`imap:${folder}:`, new Set(all.filter((u) => !toDelete.includes(u)).map((u) => prefix + u)));
      } finally {
        lock.release();
      }
      if (run.result.more) break;
    }
    await client.logout().catch(() => {});
    return run.result;
  } catch (e) {
    client.close();
    throw e instanceof QuotaFullError ? e : classifyImapError(e);
  }
}

// ---------------------------------------------------------------------------

/**
 * PostMaster's start date (setting fetch.policy.startAt): external mail that reached the provider
 * before it is never downloaded, for every mailbox without a date of its own. Set in the setup
 * wizard (default: the moment of setup) and in Admin → External mailboxes.
 */
export interface FetchPolicy {
  startAt: string | null;
}

export async function fetchStartDate(ctx: Pick<CoreContext, 'settings'>): Promise<Date | null> {
  const p = await ctx.settings.get<Partial<FetchPolicy>>('fetch', 'policy', {});
  const d = p.startAt ? new Date(p.startAt) : null;
  return d && !Number.isNaN(d.getTime()) ? d : null;
}

export async function fetchAccount(ctx: CoreContext, acc: ExternalAccount, opts: FetchOptions): Promise<FetchResult> {
  const password = ctx.secrets.open(Buffer.from(acc.secret));
  const a = acc.fetch_since ? acc : { ...acc, fetch_since: await fetchStartDate(ctx) };
  return a.protocol === 'pop3' ? fetchPop3(ctx, a, password, opts) : fetchImap(ctx, a, password, opts);
}

export interface TestResult {
  ok: boolean;
  message: string;
  messages?: number;
  idle?: boolean;
  kind?: string;
}

/** Connects and logs in without downloading anything (admin "Test connection"). */
export async function testExternalAccount(
  acc: Pick<ExternalAccount, 'protocol' | 'host' | 'port' | 'security' | 'tls_verify' | 'username'>,
  password: string,
  timeoutMs = 20_000,
): Promise<TestResult> {
  try {
    if (acc.protocol === 'pop3') {
      const c = await Pop3Client.connect({ host: acc.host, port: acc.port, security: acc.security, tlsVerify: Boolean(acc.tls_verify), timeoutMs });
      try {
        await c.login(acc.username, password);
        const s = await c.stat();
        const hasUidl = (await c.uidl()) !== null;
        await c.quit();
        return { ok: true, messages: s.count, message: `Connected. ${s.count} message(s) on the server.${hasUidl ? '' : ' Note: server has no UIDL support; a slower fallback will be used.'}` };
      } finally {
        c.close();
      }
    }
    const client = imapClient(acc, password, timeoutMs);
    await client.connect();
    try {
      const st = await client.status('INBOX', { messages: true });
      const count = st ? (st.messages ?? 0) : 0;
      const idle = client.capabilities.has('IDLE');
      return { ok: true, messages: count, idle, message: `Connected. ${count} message(s) in INBOX.${idle ? ' Push (IDLE) supported.' : ' No IDLE support; polling will be used.'}` };
    } finally {
      await client.logout().catch(() => client.close());
    }
  } catch (e) {
    const fe = e instanceof FetchError ? e : classifyImapError(e);
    return { ok: false, kind: fe.kind, message: fe.message };
  }
}

export { FetchError };
