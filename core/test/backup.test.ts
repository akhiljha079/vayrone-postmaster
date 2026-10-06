// Acceptance tests for backup/restore: after a restore, Outlook (IMAP) and
// POP3 clients see exactly the same UIDVALIDITY, UIDs and UIDLs, so nothing is
// downloaded again (docs/ARCHITECTURE.md §7).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { exec, one } from '../src/db.js';
import { restoreFull, restorePartial } from '../src/backup/restore.js';
import { readManifest, runBackup, verifyBackup } from '../src/backup/backup.js';
import { decodeCell, encodeCell } from '../src/backup/format.js';
import { RawClient, dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from './helpers.js';
import { simpleMessage } from './fixtures.js';

const PW = 'Backup#Test1';
const DB_DIR = resolve(import.meta.dirname, '..', '..', 'db');

interface Snapshot {
  uidvalidity: Record<string, number>;
  uids: Record<string, number[]>;
  uidl: string[];
}

async function snapshot(core: TestCore, email: string, boxes: string[]): Promise<Snapshot> {
  const c = await RawClient.connect(core.ports.imap!);
  await c.readUntil(/\r\n/);
  await c.imap(`LOGIN "${email}" "${PW}"`);
  const snap: Snapshot = { uidvalidity: {}, uids: {}, uidl: [] };
  for (const box of boxes) {
    const s = await c.imap(`EXAMINE "${box}"`);
    if (s.status !== 'OK') continue;
    snap.uidvalidity[box] = Number(/UIDVALIDITY (\d+)/.exec(s.text)![1]);
    const r = await c.imap('UID SEARCH ALL');
    snap.uids[box] = (/\* SEARCH([\d ]*)/.exec(r.text)![1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
  }
  await c.imap('LOGOUT');
  const p = await RawClient.connect(core.ports.pop3!);
  await p.readUntil(/\r\n/);
  await p.pop(`USER ${email}`);
  await p.pop(`PASS ${PW}`);
  snap.uidl = (await p.pop('UIDL', true)).split('\r\n').slice(1).filter((l) => /^\d+ /.test(l));
  await p.pop('QUIT');
  return snap;
}

describe('dump cell encoding', () => {
  it('stores JSON values as JSON text, also when MariaDB reports the column as longtext', () => {
    for (const type of ['json', 'longtext']) {
      expect(encodeCell(['a@x.test', 'b@x.test'], type)).toBe('["a@x.test","b@x.test"]');
      expect(encodeCell({ k: 1 }, type)).toBe('{"k":1}');
    }
    expect(encodeCell('["kept"]', 'longtext')).toBe('["kept"]');
    const d = new Date('2026-10-06T10:00:00Z');
    expect(decodeCell(encodeCell(d, 'datetime') as never)).toEqual(d);
    expect(decodeCell(encodeCell(Buffer.from('hi'), 'blob') as never)).toEqual(Buffer.from('hi'));
  });
});

describe.skipIf(!dbConfig())('backup and restore keep mailbox identities exactly', () => {
  let core: TestCore;
  const domain = uniqueDomain();
  const email = `ledger@${domain}`;
  let userId: number;
  const target = mkdtempSync(join(tmpdir(), 'vpm-backups-'));
  let fullDir = '';
  let incDir = '';
  let before: Snapshot;

  const deliver = async (subject: string) => {
    const message = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject })));
    await core.ctx.mailflow.inbound({ message, recipients: [{ userId }], origin: 'fetch', direction: 'in', envelopeFrom: 'x@y.test' });
  };

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(domain);
    userId = await makeUser(core.ctx, email, PW);
    for (let i = 1; i <= 6; i++) await deliver(`msg ${i}`);
    const inbox = (await core.ctx.store.getSpecialFolder(userId, 'inbox'))!;
    const archive = (await core.ctx.store.getSpecialFolder(userId, 'archive'))!;
    await core.ctx.store.move(inbox.id, [2, 3], archive.id); // history: UIDs are not 1..n
    await core.ctx.store.storeFlags(inbox.id, [4], 'add', 8 | 4, ['$Label1']);
    await core.ctx.store.expunge(inbox.id, [4]);
    await core.ctx.store.storeFlags(inbox.id, [5], 'add', 1 | 4, ['$Important']);
  });
  afterAll(() => core.stop());

  it('full backup: consistent, hashed, verifiable; tampering is detected', async () => {
    const r = await runBackup({ db: core.ctx.db, dataPath: core.dataPath, targetPath: target, kind: 'full', runId: 1, installId: 'testinstall', hostname: 'mail.test.local' });
    fullDir = join(target, r.dirName);
    expect(r.manifest.store.files).toBeGreaterThanOrEqual(6);
    expect(r.manifest.tables.map((t) => t.name)).toEqual(expect.arrayContaining(['folders', 'mail_items', 'messages', 'users']));
    expect(r.manifest.tables.map((t) => t.name)).not.toContain('sessions');
    expect(readdirSync(target).some((d) => d.endsWith('.partial'))).toBe(false);
    expect(await verifyBackup(fullDir)).toMatchObject({ ok: true, problems: [] });

    const copy = join(mkdtempSync(join(tmpdir(), 'vpm-tamper-')), r.dirName);
    cpSync(fullDir, copy, { recursive: true });
    const m = await readManifest(copy);
    writeFileSync(join(copy, m.tables.find((t) => t.name === 'mail_items')!.file), 'garbage');
    const v = await verifyBackup(copy);
    expect(v.ok).toBe(false);
    expect(v.problems.join()).toContain('corrupt: db/mail_items.jsonl.gz');
    before = await snapshot(core, email, ['INBOX', 'Archive']);
  });

  it('incremental backup copies only new message files', async () => {
    await deliver('msg 7');
    await deliver('msg 8');
    before = await snapshot(core, email, ['INBOX', 'Archive']);
    const base = await readManifest(fullDir);
    const r = await runBackup({
      db: core.ctx.db,
      dataPath: core.dataPath,
      targetPath: target,
      kind: 'incremental',
      runId: 2,
      installId: 'testinstall',
      hostname: 'mail.test.local',
      base: { dirName: fullDir.split('/').pop()!, highMessageId: base.highMessageId },
    });
    incDir = join(target, r.dirName);
    expect(r.manifest.kind).toBe('incremental');
    expect(r.manifest.store.files).toBe(2);
    expect((await verifyBackup(incDir)).ok).toBe(true);
  });

  it('full restore into an empty server: identical UIDVALIDITY, UIDs and POP3 UIDLs', async () => {
    const admin = await mysql.createConnection({ ...dbConfig()!, database: undefined });
    await admin.query('DROP DATABASE IF EXISTS vpm_restore_test');
    await admin.query('CREATE DATABASE vpm_restore_test CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci');
    await admin.end();
    const db2 = { ...dbConfig()!, database: 'vpm_restore_test' };
    const data2 = mkdtempSync(join(tmpdir(), 'vpm-restored-'));
    const r = await restoreFull({ db: db2, dataPath: data2, migrationsPath: DB_DIR, backupDir: incDir });
    expect(r.files).toBeGreaterThanOrEqual(8); // files from the full run + the incremental
    const restored = await startCore(data2, db2);
    try {
      const after = await snapshot(restored, email, ['INBOX', 'Archive']);
      expect(after).toEqual(before);
      // Flags and keywords survive too.
      const inbox = (await restored.ctx.store.getSpecialFolder(userId, 'inbox'))!;
      const [five] = await restored.ctx.store.itemsMeta(inbox.id, [5]);
      expect(five).toMatchObject({ flags: 5, keywords: ['$Important'] });
    } finally {
      await restored.stop();
    }
  });

  it('partial restore: a deleted folder comes back with its original identity', async () => {
    const archive = (await core.ctx.store.getSpecialFolder(userId, 'archive'))!;
    await core.ctx.store.deleteFolder(userId, 'Archive');
    const res = await restorePartial({ db: core.ctx.db, store: core.ctx.store, events: core.ctx.events, dataPath: core.dataPath }, incDir, { sourceUserId: userId, folderPath: 'Archive' });
    expect(res.folders).toEqual([{ path: 'Archive', mode: 'exact', restored: 2 }]);
    const back = (await core.ctx.store.getFolder(userId, 'Archive'))!;
    expect(back.uidvalidity).toBe(archive.uidvalidity);
    const after = await snapshot(core, email, ['INBOX', 'Archive']);
    expect(after.uids.Archive).toEqual(before.uids.Archive);
    expect(after.uidl).toEqual(before.uidl);
  });

  it('partial restore of a date range into an existing folder appends only what is missing', async () => {
    const inbox = (await core.ctx.store.getSpecialFolder(userId, 'inbox'))!;
    const uidsBefore = await core.ctx.store.listUids(inbox.id);
    const lost = uidsBefore.slice(0, 2);
    await core.ctx.store.storeFlags(inbox.id, lost, 'add', 8, null);
    await core.ctx.store.expunge(inbox.id, lost);
    const res = await restorePartial({ db: core.ctx.db, store: core.ctx.store, events: core.ctx.events, dataPath: core.dataPath }, incDir, { sourceUserId: userId, folderPath: 'INBOX' });
    expect(res.folders).toEqual([{ path: 'INBOX', mode: 'merged', restored: 2 }]);
    const now = await core.ctx.store.listUids(inbox.id);
    expect(now.slice(0, uidsBefore.length - 2)).toEqual(uidsBefore.slice(2)); // untouched
    expect(now).toHaveLength(uidsBefore.length);
    expect(Math.min(...now.slice(-2))).toBeGreaterThan(Math.max(...uidsBefore)); // appended, never renumbered
    const again = await restorePartial({ db: core.ctx.db, store: core.ctx.store, events: core.ctx.events, dataPath: core.dataPath }, incDir, { sourceUserId: userId, folderPath: 'INBOX' });
    expect(again.items).toBe(0); // idempotent
  });

  it('a deleted user can be recreated exactly from the backup', async () => {
    const snap = await snapshot(core, email, ['INBOX', 'Archive']);
    // what the backup has: the incremental-time snapshot
    await exec(core.ctx.db, 'UPDATE messages m JOIN (SELECT message_id, COUNT(*) n FROM mail_items WHERE user_id = ? GROUP BY message_id) x ON m.id = x.message_id SET m.refcount = m.refcount - x.n', [userId]);
    await exec(core.ctx.db, 'DELETE FROM users WHERE id = ?', [userId]);
    await expect(restorePartial({ db: core.ctx.db, store: core.ctx.store, events: core.ctx.events, dataPath: core.dataPath }, incDir, { sourceUserId: userId })).rejects.toThrow(/no longer exists/);
    const res = await restorePartial({ db: core.ctx.db, store: core.ctx.store, events: core.ctx.events, dataPath: core.dataPath }, incDir, { sourceUserId: userId, recreateUser: true });
    expect(res).toMatchObject({ targetUserId: userId, recreatedUser: true });
    expect(res.folders.every((f) => f.mode === 'exact')).toBe(true);
    const after = await snapshot(core, email, ['INBOX', 'Archive']);
    expect(after.uidvalidity).toEqual(snap.uidvalidity);
    expect(after.uids).toEqual(before.uids);
    expect(after.uidl).toEqual(before.uidl);
    expect(await core.ctx.directory.authenticate(email, PW, 'imap', '10.0.0.1')).toBeTruthy();
    const u = await one<{ used_bytes: number }>(core.ctx.db, 'SELECT used_bytes FROM users WHERE id = ?', [userId]);
    expect(Number(u!.used_bytes)).toBeGreaterThan(0);
  });
});
