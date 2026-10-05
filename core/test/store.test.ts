import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { one, rows } from '../src/db.js';
import { dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from './helpers.js';
import { simpleMessage, mid } from './fixtures.js';

describe.skipIf(!dbConfig())('mail store: UID / UIDVALIDITY / UIDL rules', () => {
  let core: TestCore;
  let userId: number;
  const domain = uniqueDomain();

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(domain);
    userId = await makeUser(core.ctx, `ram@${domain}`);
  });
  afterAll(() => core.stop());

  const deliverTo = async (uid: number, raw: string, folder?: number) => {
    const message = await core.ctx.store.ingest(Buffer.from(raw));
    const [o] = await core.ctx.delivery.deliver({ message, targets: [{ userId: uid, ...(folder ? { folderId: folder } : {}) }], origin: 'fetch', envelopeFrom: 'x@y' });
    return o!;
  };

  it('creates default folders with distinct, time-seeded UIDVALIDITY', async () => {
    const folders = await core.ctx.store.listFolders(userId);
    expect(folders.map((f) => f.path).sort()).toEqual(['Archive', 'Drafts', 'INBOX', 'Junk', 'Sent', 'Trash']);
    const vals = folders.map((f) => f.uidvalidity);
    expect(new Set(vals).size).toBe(vals.length);
    expect(Math.min(...vals)).toBeGreaterThan(1_700_000_000);
  });

  it('allocates strictly increasing UIDs and never reuses them after expunge', async () => {
    const inbox = (await core.ctx.store.getSpecialFolder(userId, 'inbox'))!;
    const a = await deliverTo(userId, simpleMessage());
    const b = await deliverTo(userId, simpleMessage());
    expect(b.uid).toBe(a.uid! + 1);
    await core.ctx.store.storeFlags(inbox.id, [b.uid!], 'add', 8, null);
    expect(await core.ctx.store.expunge(inbox.id)).toEqual([b.uid]);
    const c = await deliverTo(userId, simpleMessage());
    expect(c.uid).toBe(b.uid! + 1);
    const f = (await core.ctx.store.getFolderById(inbox.id))!;
    expect(f.uidnext).toBe(c.uid! + 1);
    expect(f.uidvalidity).toBe(inbox.uidvalidity);
  });

  it('gives a recreated folder a new UIDVALIDITY; rename keeps it', async () => {
    const f1 = await core.ctx.store.createFolder(userId, 'Projects/Agra');
    await core.ctx.store.deleteFolder(userId, 'Projects/Agra');
    const f2 = await core.ctx.store.createFolder(userId, 'Projects/Agra');
    expect(f2.uidvalidity).toBeGreaterThan(f1.uidvalidity);

    await deliverTo(userId, simpleMessage(), f2.id);
    await core.ctx.store.renameFolder(userId, 'Projects', 'Clients');
    const renamed = (await core.ctx.store.getFolder(userId, 'Clients/Agra'))!;
    expect(renamed.id).toBe(f2.id);
    expect(renamed.uidvalidity).toBe(f2.uidvalidity);
    expect(renamed.message_count).toBe(1);
    expect(await core.ctx.store.getFolder(userId, 'Projects/Agra')).toBeUndefined();
  });

  it('MOVE keeps the item and its POP3 UIDL; COPY gets a new UIDL', async () => {
    const inbox = (await core.ctx.store.getSpecialFolder(userId, 'inbox'))!;
    const archive = (await core.ctx.store.getSpecialFolder(userId, 'archive'))!;
    const d = await deliverTo(userId, simpleMessage());
    const before = await one<{ id: number; pop3_uidl: string }>(core.ctx.db, 'SELECT id, pop3_uidl FROM mail_items WHERE folder_id = ? AND uid = ?', [inbox.id, d.uid]);

    const mv = await core.ctx.store.move(inbox.id, [d.uid!], archive.id);
    const moved = await one<{ id: number; pop3_uidl: string; folder_id: number }>(core.ctx.db, 'SELECT id, pop3_uidl, folder_id FROM mail_items WHERE id = ?', [before!.id]);
    expect(moved).toMatchObject({ id: before!.id, pop3_uidl: before!.pop3_uidl, folder_id: archive.id });
    const exp = await one(core.ctx.db, 'SELECT uid FROM folder_expunges WHERE folder_id = ? AND uid = ?', [inbox.id, d.uid]);
    expect(exp).toBeTruthy();

    const back = await core.ctx.store.move(archive.id, [mv.map[0]![1]], inbox.id);
    const again = await one<{ pop3_uidl: string; uid: number }>(core.ctx.db, 'SELECT pop3_uidl, uid FROM mail_items WHERE id = ?', [before!.id]);
    expect(again!.pop3_uidl).toBe(before!.pop3_uidl);
    expect(again!.uid).toBe(back.map[0]![1]);
    expect(again!.uid).toBeGreaterThan(d.uid!); // new UID in INBOX, never the old one

    const cp = await core.ctx.store.copy(inbox.id, [again!.uid], archive.id);
    const copy = await one<{ pop3_uidl: string }>(core.ctx.db, 'SELECT pop3_uidl FROM mail_items WHERE folder_id = ? AND uid = ?', [archive.id, cp.map[0]![1]]);
    expect(copy!.pop3_uidl).not.toBe(before!.pop3_uidl);
  });

  it('suppresses duplicate deliveries (re-download / second account) but not different content', async () => {
    const m = simpleMessage({ messageId: mid(), subject: 'dedup check' });
    expect((await deliverTo(userId, m)).status).toBe('delivered');
    expect((await deliverTo(userId, `Received: from other-provider\r\nX-Spam: no\r\n${m}`)).status).toBe('duplicate');
    expect((await deliverTo(userId, m.replace('dedup check', 'dedup check 2'))).status).toBe('delivered');
  });

  it('stores a message once for many recipients (single-instance)', async () => {
    const u2 = await makeUser(core.ctx, `sita@${domain}`);
    const u3 = await makeUser(core.ctx, `lakshman@${domain}`);
    const message = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'fan-out' })));
    const res = await core.ctx.delivery.deliver({ message, targets: [{ userId }, { userId: u2 }, { userId: u3 }, { userId: u2 }], origin: 'lan_smtp', envelopeFrom: 'a@b' });
    expect(res.map((r) => r.status)).toEqual(['delivered', 'delivered', 'delivered']);
    const row = await one<{ refcount: number; storage_path: string }>(core.ctx.db, 'SELECT refcount, storage_path FROM messages WHERE id = ?', [message.id]);
    expect(row!.refcount).toBe(3);
    expect(existsSync(join(core.dataPath, row!.storage_path))).toBe(true);
    const again = await core.ctx.store.ingest(Buffer.from(message.raw));
    expect(again.id).toBe(message.id);
  });

  it('conditional STORE (UNCHANGEDSINCE) fails for items modified later', async () => {
    const inbox = (await core.ctx.store.getSpecialFolder(userId, 'inbox'))!;
    const d = await deliverTo(userId, simpleMessage());
    const r1 = await core.ctx.store.storeFlags(inbox.id, [d.uid!], 'add', 4, ['$Important']);
    expect(r1.changed).toEqual([d.uid]);
    const r2 = await core.ctx.store.storeFlags(inbox.id, [d.uid!], 'add', 1, null, r1.modseq - 1);
    expect(r2.failed).toEqual([d.uid]);
    const [it] = await core.ctx.store.itemsMeta(inbox.id, [d.uid!]);
    expect(it!.flags).toBe(4);
    expect(it!.keywords).toEqual(['$Important']);
  });

  it('keeps folder counters consistent', async () => {
    const folders = await rows<{ id: number; message_count: number; unseen_count: number; total_bytes: number }>(
      core.ctx.db,
      'SELECT id, message_count, unseen_count, total_bytes FROM folders WHERE user_id = ?',
      [userId],
    );
    for (const f of folders) {
      const real = await one<{ n: number; u: number; b: number }>(
        core.ctx.db,
        'SELECT COUNT(*) n, COALESCE(SUM((flags & 1) = 0),0) u, COALESCE(SUM(size),0) b FROM mail_items WHERE folder_id = ?',
        [f.id],
      );
      expect([f.message_count, f.unseen_count, Number(f.total_bytes)]).toEqual([Number(real!.n), Number(real!.u), Number(real!.b)]);
    }
  });
});
