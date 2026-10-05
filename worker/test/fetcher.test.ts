// External fetcher tests. The "provider" is this server's own POP3/IMAP
// listeners serving mailboxes in a separate provider domain, so every test is
// a real protocol round-trip (UIDL, UIDVALIDITY, IDLE, DELE, EXPUNGE).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { db as dbm, testExternalAccount } from '@vpm/core';
import { RawClient, dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from '../../core/test/helpers.js';
import { Fetcher } from '../src/fetcher.js';

const { exec, one, rows } = dbm;
const PW = 'Fetch#Test1';
const REMOTE_PW = 'Provider#Pw1';

describe.skipIf(!dbConfig())('external POP3/IMAP fetcher', () => {
  let core: TestCore;
  let fetcher: Fetcher;
  const lan = uniqueDomain();
  const prov = `prov-${uniqueDomain()}`;
  let aliceId: number;
  let n = 0;

  const msg = (subject: string) =>
    `From: Client <client@outside.test>\r\nTo: alice@${prov}\r\nSubject: ${subject}\r\nMessage-ID: <${randomBytes(6).toString('hex')}@outside.test>\r\nDate: Mon, 05 Oct 2026 10:00:00 +0000\r\n\r\nBody of ${subject}\r\n.leading dot line\r\n`;

  /** A fresh remote mailbox at the "provider" with `count` messages. */
  async function remoteBox(count: number): Promise<{ email: string; userId: number }> {
    const email = `box${++n}@${prov}`;
    const userId = await core.ctx.directory.createUser({ email, password: REMOTE_PW });
    for (let i = 1; i <= count; i++) await putRemote(userId, `${email} #${i}`);
    return { email, userId };
  }

  async function putRemote(userId: number, subject: string, folder = 'INBOX'): Promise<void> {
    const f = (await core.ctx.store.getFolder(userId, folder))!;
    const message = await core.ctx.store.ingest(Buffer.from(msg(subject)));
    await core.ctx.store.append({ userId, folderId: f.id, message, origin: 'internal' });
  }

  const remoteCount = async (userId: number, folder = 'INBOX') => (await core.ctx.store.getFolder(userId, folder))!.message_count;
  const localCount = async () => (await core.ctx.store.getSpecialFolder(aliceId, 'inbox'))!.message_count;

  async function addAccount(o: { protocol: 'pop3' | 'imap'; username: string; password?: string; port?: number; leave?: 'keep' | 'delete' | 'keep_days'; keepDays?: number; idle?: boolean; folders?: string[]; user?: number }): Promise<number> {
    const now = new Date();
    const r = await exec(
      core.ctx.db,
      `INSERT INTO external_accounts (user_id, protocol, host, port, security, tls_verify, username, secret, remote_folders, interval_sec, use_idle,
         leave_policy, keep_days, created_at, updated_at) VALUES (?,?,?,?,?,0,?,?,?,30,?,?,?,?,?)`,
      [
        o.user ?? aliceId,
        o.protocol,
        '127.0.0.1',
        o.port ?? (o.protocol === 'pop3' ? core.ports.pop3 : core.ports.imap),
        o.protocol === 'imap' ? 'starttls' : 'none',
        o.username,
        core.ctx.secrets.seal(o.password ?? REMOTE_PW),
        o.folders ? JSON.stringify(o.folders) : null,
        o.idle ? 1 : 0,
        o.leave ?? 'keep',
        o.keepDays ?? 14,
        now,
        now,
      ],
    );
    return r.insertId;
  }

  async function runOnce(id: number): Promise<Record<string, unknown>> {
    await exec(core.ctx.db, 'UPDATE external_accounts SET next_run_at = ? WHERE id = ?', [new Date(Date.now() - 1000), id]);
    await fetcher.tick();
    await fetcher.idleWait();
    return (await one(core.ctx.db, 'SELECT * FROM external_accounts WHERE id = ?', [id]))!;
  }
  const lastRun = (id: number) => one<{ fetched: number; duplicates: number; deleted_remote: number; result: string }>(core.ctx.db, 'SELECT * FROM fetch_runs WHERE account_id = ? ORDER BY id DESC LIMIT 1', [id]);

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(lan);
    await core.ctx.directory.createDomain(prov);
    aliceId = await makeUser(core.ctx, `alice@${lan}`, PW);
    fetcher = new Fetcher(core.ctx, { idle: false, timeoutMs: 10_000 });
  });
  afterAll(async () => {
    await fetcher.stop();
    await core.stop();
  });

  it('POP3, leave on server: downloads once, never again, keeps remote copies', async () => {
    const box = await remoteBox(3);
    const before = await localCount();
    const id = await addAccount({ protocol: 'pop3', username: box.email });
    const acc = await runOnce(id);
    expect(acc).toMatchObject({ status: 'idle', consecutive_fails: 0, remote_count: 3, fetched_total: 3, last_error: null });
    expect(await localCount()).toBe(before + 3);
    expect(await remoteCount(box.userId)).toBe(3);
    // byte-stuffed line survived the round trip
    const inbox = (await core.ctx.store.getSpecialFolder(aliceId, 'inbox'))!;
    const [item] = await core.ctx.store.itemsFull(inbox.id, (await core.ctx.store.listUids(inbox.id)).slice(-1));
    expect((await core.ctx.store.loadRaw(item!)).toString()).toContain('\r\n.leading dot line\r\n');

    await runOnce(id);
    expect(await lastRun(id)).toMatchObject({ fetched: 0, duplicates: 0, result: 'ok' });
    expect(await localCount()).toBe(before + 3);
  });

  it('POP3, delete policy: removes remote copies only after local delivery', async () => {
    const box = await remoteBox(2);
    const before = await localCount();
    const id = await addAccount({ protocol: 'pop3', username: box.email, leave: 'delete' });
    await runOnce(id);
    expect(await localCount()).toBe(before + 2);
    expect(await remoteCount(box.userId)).toBe(0);
    expect(await lastRun(id)).toMatchObject({ fetched: 2, deleted_remote: 2 });
  });

  it('a local delivery failure never deletes the remote copy', async () => {
    const box = await remoteBox(1);
    const id = await addAccount({ protocol: 'pop3', username: box.email, leave: 'delete' });
    const real = core.ctx.delivery.deliver.bind(core.ctx.delivery);
    core.ctx.delivery.deliver = async () => {
      throw new Error('disk on fire');
    };
    try {
      const acc = await runOnce(id);
      expect(acc.status).toBe('backoff');
      expect(await remoteCount(box.userId)).toBe(1);
    } finally {
      core.ctx.delivery.deliver = real;
    }
    await runOnce(id);
    expect(await remoteCount(box.userId)).toBe(0);
    expect(await lastRun(id)).toMatchObject({ fetched: 1, deleted_remote: 1 });
  });

  it('keep for N days: deletes remote copies after the period, without re-downloading', async () => {
    const box = await remoteBox(2);
    const before = await localCount();
    const id = await addAccount({ protocol: 'pop3', username: box.email, leave: 'keep_days', keepDays: 7 });
    await runOnce(id);
    expect(await remoteCount(box.userId)).toBe(2);
    await exec(core.ctx.db, 'UPDATE external_seen SET first_seen_at = ? WHERE account_id = ?', [new Date(Date.now() - 8 * 86400_000), id]);
    await runOnce(id);
    expect(await remoteCount(box.userId)).toBe(0);
    expect(await localCount()).toBe(before + 2);
    expect(await lastRun(id)).toMatchObject({ fetched: 0, deleted_remote: 2 });
  });

  it('duplicate prevention: provider UIDL reset and a second account for the same mailbox', async () => {
    const box = await remoteBox(2);
    const before = await localCount();
    const pop = await addAccount({ protocol: 'pop3', username: box.email });
    await runOnce(pop);
    await exec(core.ctx.db, 'DELETE FROM external_seen WHERE account_id = ?', [pop]); // as if the provider re-issued UIDLs
    await runOnce(pop);
    expect(await lastRun(pop)).toMatchObject({ fetched: 0, duplicates: 2 });
    const imap = await addAccount({ protocol: 'imap', username: box.email });
    await runOnce(imap);
    expect(await lastRun(imap)).toMatchObject({ fetched: 0, duplicates: 2 });
    expect(await localCount()).toBe(before + 2);
  });

  it('IMAP: STARTTLS, incremental UIDs, delete policy expunges remotely', async () => {
    const box = await remoteBox(2);
    const before = await localCount();
    const id = await addAccount({ protocol: 'imap', username: box.email });
    await runOnce(id);
    expect(await localCount()).toBe(before + 2);
    await putRemote(box.userId, 'third');
    await runOnce(id);
    expect(await lastRun(id)).toMatchObject({ fetched: 1 });
    const st = await one<{ last_uid: number }>(core.ctx.db, 'SELECT last_uid FROM external_imap_state WHERE account_id = ?', [id]);
    expect(st!.last_uid).toBe(3);
    await exec(core.ctx.db, "UPDATE external_accounts SET leave_policy = 'delete' WHERE id = ?", [id]);
    await runOnce(id);
    expect(await remoteCount(box.userId)).toBe(0);
    expect(await localCount()).toBe(before + 3);
  });

  it('IMAP: a rebuilt remote folder (new UIDVALIDITY) does not re-download mail', async () => {
    const box = await remoteBox(0);
    await core.ctx.store.createFolder(box.userId, 'Bills');
    await putRemote(box.userId, 'bill 1', 'Bills');
    await putRemote(box.userId, 'bill 2', 'Bills');
    const before = await localCount();
    const id = await addAccount({ protocol: 'imap', username: box.email, folders: ['Bills'] });
    await runOnce(id);
    expect(await localCount()).toBe(before + 2);

    // Provider rebuilds the folder: same messages, new UIDVALIDITY and UIDs.
    const old = (await core.ctx.store.getFolder(box.userId, 'Bills'))!;
    const tmp = await core.ctx.store.createFolder(box.userId, 'Tmp');
    await core.ctx.store.move(old.id, await core.ctx.store.listUids(old.id), tmp.id);
    await core.ctx.store.deleteFolder(box.userId, 'Bills');
    const fresh = await core.ctx.store.createFolder(box.userId, 'Bills');
    await core.ctx.store.move(tmp.id, await core.ctx.store.listUids(tmp.id), fresh.id);
    expect(fresh.uidvalidity).not.toBe(old.uidvalidity);

    await runOnce(id);
    expect(await lastRun(id)).toMatchObject({ fetched: 0, duplicates: 2 });
    expect(await localCount()).toBe(before + 2);
  });

  it('wrong provider password: pauses the account with a critical alert', async () => {
    const box = await remoteBox(1);
    const id = await addAccount({ protocol: 'pop3', username: box.email, password: 'wrong-password' });
    const acc = await runOnce(id);
    expect(acc).toMatchObject({ status: 'auth_failed', next_run_at: null });
    expect(String(acc.last_error)).toMatch(/PASS|AUTH|credentials/i);
    const alert = await one<{ severity: string }>(core.ctx.db, 'SELECT severity FROM admin_alerts WHERE dedupe_key = ?', [`ext.auth.${id}`]);
    expect(alert?.severity).toBe('critical');
    const runs = (await rows(core.ctx.db, 'SELECT id FROM fetch_runs WHERE account_id = ?', [id])).length;
    await fetcher.tick();
    await fetcher.idleWait();
    expect((await rows(core.ctx.db, 'SELECT id FROM fetch_runs WHERE account_id = ?', [id])).length).toBe(runs); // not retried
  });

  it('unreachable provider backs off without affecting other accounts', async () => {
    const box = await remoteBox(1);
    const before = await localCount();
    const bad = await addAccount({ protocol: 'pop3', username: 'x@nowhere.test', port: 1 });
    const good = await addAccount({ protocol: 'pop3', username: box.email });
    await exec(core.ctx.db, 'UPDATE external_accounts SET next_run_at = ? WHERE id IN (?)', [new Date(Date.now() - 1000), [bad, good]]);
    await fetcher.tick();
    await fetcher.idleWait();
    const b = (await one<{ status: string; consecutive_fails: number; next_run_at: Date }>(core.ctx.db, 'SELECT * FROM external_accounts WHERE id = ?', [bad]))!;
    expect(b.status).toBe('backoff');
    expect(b.consecutive_fails).toBe(1);
    const wait = new Date(b.next_run_at).getTime() - Date.now();
    expect(wait).toBeGreaterThan(20_000);
    expect(wait).toBeLessThan(40_000);
    expect(await localCount()).toBe(before + 1); // the good account was fetched in the same tick
    await exec(core.ctx.db, 'UPDATE external_accounts SET is_enabled = 0 WHERE id = ?', [bad]);
  });

  it('full local mailbox: mail waits on the provider, then arrives once space is freed', async () => {
    const box = await remoteBox(2);
    const bob = await makeUser(core.ctx, `bob@${lan}`, PW);
    await exec(core.ctx.db, 'UPDATE users SET quota_bytes = 10 WHERE id = ?', [bob]);
    const id = await addAccount({ protocol: 'pop3', username: box.email, leave: 'delete', user: bob });
    const acc = await runOnce(id);
    expect(acc.status).toBe('quota_full');
    expect(await remoteCount(box.userId)).toBe(2);
    expect(await one(core.ctx.db, 'SELECT id FROM admin_alerts WHERE dedupe_key = ?', [`ext.quota.${id}`])).toBeTruthy();
    await exec(core.ctx.db, 'UPDATE users SET quota_bytes = NULL WHERE id = ?', [bob]);
    expect((await runOnce(id)).status).toBe('idle');
    expect(await remoteCount(box.userId)).toBe(0);
    expect((await core.ctx.store.getSpecialFolder(bob, 'inbox'))!.message_count).toBe(2);
  });

  it('test connection reports message count, IDLE support and clear errors', async () => {
    const box = await remoteBox(2);
    const base = { host: '127.0.0.1', tls_verify: 0, username: box.email };
    expect(await testExternalAccount({ ...base, protocol: 'pop3', port: core.ports.pop3!, security: 'none' }, REMOTE_PW)).toMatchObject({ ok: true, messages: 2 });
    expect(await testExternalAccount({ ...base, protocol: 'imap', port: core.ports.imap!, security: 'starttls' }, REMOTE_PW)).toMatchObject({ ok: true, messages: 2, idle: true });
    expect(await testExternalAccount({ ...base, protocol: 'imap', port: core.ports.imap!, security: 'starttls' }, 'bad')).toMatchObject({ ok: false, kind: 'auth' });
    expect(await testExternalAccount({ ...base, protocol: 'pop3', port: 1, security: 'none' }, 'x')).toMatchObject({ ok: false, kind: 'network' });
  });

  it('IMAP IDLE push: new provider mail reaches an idling Outlook within seconds', async () => {
    const box = await remoteBox(0);
    const id = await addAccount({ protocol: 'imap', username: box.email, idle: true });
    const live = new Fetcher(core.ctx, { idle: true, timeoutMs: 10_000 });
    live.start();
    try {
      // Wait for the watcher to be connected and idling.
      for (let i = 0; i < 50 && !(await one<{ idle_active: number }>(core.ctx.db, 'SELECT idle_active FROM external_accounts WHERE id = ?', [id]))?.idle_active; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      await live.idleWait();

      // Alice's Outlook is idling on her local INBOX.
      const outlook = await RawClient.connect(core.ports.imap!);
      await outlook.readUntil(/\r\n/);
      await outlook.imap(`LOGIN alice@${lan} ${PW}`);
      const sel = await outlook.imap('SELECT INBOX');
      const exists = Number(/\* (\d+) EXISTS/.exec(sel.text)![1]);
      outlook.write('I1 IDLE\r\n');
      await outlook.readUntil(/\+ idling\r\n/);

      const t0 = Date.now();
      await putRemote(box.userId, 'pushed from provider');
      await outlook.readUntil(new RegExp(`\\* ${exists + 1} EXISTS\\r\\n`), 8000);
      const latency = Date.now() - t0;
      expect(latency).toBeLessThan(5000);
      outlook.write('DONE\r\n');
      await outlook.readUntil(/I1 OK/);
      await outlook.imap('LOGOUT');
    } finally {
      await live.stop();
    }
  });
});
