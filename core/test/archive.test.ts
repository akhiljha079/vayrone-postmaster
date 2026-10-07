import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import nodemailer from 'nodemailer';
import { exec, one, rows } from '../src/db.js';
import { collectGarbage, purgeArchive, purgeMailboxFolders } from '../src/archive/maintenance.js';
import { fulltextQuery, indexPending } from '../src/archive/search-index.js';
import { dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from './helpers.js';
import { complexMessage, simpleMessage } from './fixtures.js';

const PW = 'Archive#Test1';

describe('full-text query builder', () => {
  it('requires every word, prefix-matches, keeps phrases, drops operators and short words', () => {
    expect(fulltextQuery('invoice sharma')).toBe('+invoice* +sharma*');
    expect(fulltextQuery('"purchase order" 42 to')).toBe('+"purchase order"');
    expect(fulltextQuery('-evil +(x) a@b.com')).toBe('+evil* +com*');
    expect(fulltextQuery('a b')).toBeNull();
    expect(fulltextQuery('कोटेशन मूल्य')).toBe('+कोटेशन* +मूल्य*');
  });
});

describe.skipIf(!dbConfig())('compliance archive, search index and maintenance', () => {
  let core: TestCore;
  const domain = uniqueDomain();
  let alice: number;
  let bob: number;

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(domain);
    alice = await makeUser(core.ctx, `alice@${domain}`, PW);
    bob = await makeUser(core.ctx, `bob@${domain}`, PW);
  });
  afterAll(() => core.stop());

  const archiveRow = (messageId: number) =>
    one<{ id: number; direction: string; envelope_rcpts: unknown; retention_until: Date | null }>(core.ctx.db, 'SELECT * FROM archive_items WHERE message_id = ? ORDER BY id DESC LIMIT 1', [messageId]);

  it('archives received mail once (not per recipient, not on re-download)', async () => {
    const message = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'Archive me' })));
    await core.ctx.mailflow.inbound({ message, recipients: [{ userId: alice }, { userId: bob }], origin: 'fetch', direction: 'in', envelopeFrom: 'client@outside.test' });
    await core.ctx.mailflow.inbound({ message, recipients: [{ userId: alice }], origin: 'fetch', direction: 'in', envelopeFrom: 'client@outside.test' });
    const items = await rows<{ id: number; direction: string }>(core.ctx.db, 'SELECT id, direction FROM archive_items WHERE message_id = ?', [message.id]);
    expect(items).toEqual([{ id: items[0]!.id, direction: 'in' }]);
    const users = await rows<{ user_id: number }>(core.ctx.db, 'SELECT user_id FROM archive_item_users WHERE archive_id = ? ORDER BY user_id', [items[0]!.id]);
    expect(users.map((u) => u.user_id)).toEqual([alice, bob].sort((a, b) => a - b));
    const row = await archiveRow(message.id);
    expect(new Date(row!.retention_until!).getTime() - Date.now()).toBeGreaterThan(2500 * 86400_000); // default 7 years
  });

  it('archives sent mail as outgoing with sender and all recipients', async () => {
    const t = nodemailer.createTransport({ host: '127.0.0.1', port: core.ports.submission!, secure: false, auth: { user: `alice@${domain}`, pass: PW }, tls: { rejectUnauthorized: false } });
    await t.sendMail({ from: `alice@${domain}`, to: ['buyer@outside.test', `bob@${domain}`], subject: 'Quotation 77', text: 'Price list' });
    const a = await one<{ id: number; direction: string; envelope_rcpts: unknown }>(core.ctx.db, "SELECT * FROM archive_items WHERE subject = 'Quotation 77'");
    expect(a!.direction).toBe('out');
    const rcpts = typeof a!.envelope_rcpts === 'string' ? JSON.parse(a!.envelope_rcpts) : a!.envelope_rcpts;
    expect(rcpts).toEqual(['buyer@outside.test', `bob@${domain}`]);
    const users = (await rows<{ user_id: number }>(core.ctx.db, 'SELECT user_id FROM archive_item_users WHERE archive_id = ?', [a!.id])).map((u) => u.user_id).sort();
    expect(users).toEqual([alice, bob].sort((x, y) => x - y));
    // Mailbox folders: Alice's "Sent", Bob's "Received", each under the address at the time.
    const links = await rows<{ user_id: number; role: string; address: string }>(core.ctx.db, 'SELECT user_id, role, address FROM archive_item_users WHERE archive_id = ? ORDER BY role', [a!.id]);
    expect(links).toEqual([
      { user_id: bob, role: 'received', address: `bob@${domain}` },
      { user_id: alice, role: 'sent', address: `alice@${domain}` },
    ]);
  });

  it('keeps archived mail after the user deletes it, empties Trash, and after the account is deleted', async () => {
    const carol = await makeUser(core.ctx, `carol@${domain}`, PW);
    const message = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'Contract signed' })));
    await core.ctx.mailflow.inbound({ message, recipients: [{ userId: carol }], origin: 'fetch', direction: 'in', envelopeFrom: 'client@outside.test' });
    const a = await one<{ id: number }>(core.ctx.db, 'SELECT id FROM archive_items WHERE message_id = ?', [message.id]);
    expect(a).toBeDefined();
    // The user deletes it for good (flag \Deleted + expunge, like Outlook emptying Trash).
    const inbox = (await core.ctx.store.getFolder(carol, 'INBOX'))!;
    const item = await one<{ uid: number }>(core.ctx.db, 'SELECT uid FROM mail_items WHERE folder_id = ? AND message_id = ?', [inbox.id, message.id]);
    await core.ctx.store.storeFlags(inbox.id, [item!.uid], 'add', 8, null);
    await core.ctx.store.expunge(inbox.id);
    expect(await one(core.ctx.db, 'SELECT id FROM mail_items WHERE user_id = ? AND message_id = ?', [carol, message.id])).toBeUndefined();
    // Then the account itself is deleted (same statements as Admin > Users > Delete).
    await exec(core.ctx.db, 'DELETE FROM users WHERE id = ?', [carol]);
    await collectGarbage(core.ctx.db, core.ctx.blobs, 0);
    // The archive still has the message, under the address it was received at.
    const kept = await one<{ storage_path: string; codec: number; refcount: number }>(core.ctx.db, 'SELECT storage_path, codec, refcount FROM messages WHERE id = ?', [message.id]);
    expect(kept!.refcount).toBeGreaterThanOrEqual(1);
    expect((await core.ctx.blobs.get(kept!.storage_path, kept!.codec)).toString()).toContain('Contract signed');
    expect(await one(core.ctx.db, 'SELECT role, address FROM archive_item_users WHERE archive_id = ?', [a!.id])).toEqual({ role: 'received', address: `carol@${domain}` });
  });

  it('retention policies: longest matching wins; disabled archive stores nothing', async () => {
    await exec(core.ctx.db, "INSERT INTO retention_policies (name, target, scope, scope_id, keep_days, created_at) VALUES ('legal team', 'archive', 'user', ?, 4000, ?)", [bob, new Date()]);
    const m1 = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'for bob' })));
    await core.ctx.mailflow.inbound({ message: m1, recipients: [{ userId: bob }], origin: 'fetch', direction: 'in', envelopeFrom: 'x@y.test' });
    const r1 = await archiveRow(m1.id);
    expect(new Date(r1!.retention_until!).getTime() - Date.now()).toBeGreaterThan(3990 * 86400_000);

    await core.ctx.settings.set('archive', 'policy', { enabled: false });
    core.ctx.settings.invalidate();
    const m2 = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'not archived' })));
    await core.ctx.mailflow.inbound({ message: m2, recipients: [{ userId: alice }], origin: 'fetch', direction: 'in', envelopeFrom: 'x@y.test' });
    expect(await archiveRow(m2.id)).toBeUndefined();
    await core.ctx.settings.set('archive', 'policy', {});
    core.ctx.settings.invalidate();
  });

  it('purges expired archive items except those on legal hold', async () => {
    const m = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'old' })));
    await core.ctx.mailflow.inbound({ message: m, recipients: [{ userId: alice }], origin: 'fetch', direction: 'in', envelopeFrom: 'x@y.test' });
    const held = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'evidence' })));
    await core.ctx.mailflow.inbound({ message: held, recipients: [{ userId: alice }], origin: 'fetch', direction: 'in', envelopeFrom: 'x@y.test' });
    const past = new Date(Date.now() - 1000);
    await exec(core.ctx.db, 'UPDATE archive_items SET retention_until = ? WHERE message_id IN (?)', [past, [m.id, held.id]]);
    await exec(core.ctx.db, 'UPDATE archive_items SET legal_hold = 1 WHERE message_id = ?', [held.id]);
    const rcBefore = (await one<{ refcount: number }>(core.ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [m.id]))!.refcount;
    expect(await purgeArchive(core.ctx.db)).toBeGreaterThanOrEqual(1);
    expect(await archiveRow(m.id)).toBeUndefined();
    expect(await archiveRow(held.id)).toBeTruthy();
    expect((await one<{ refcount: number }>(core.ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [m.id]))!.refcount).toBe(rcBefore - 1);
  });

  it('garbage collection removes files nothing refers to, and repairs wrong counters', async () => {
    const m = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'orphan' })));
    const path = join(core.dataPath, (await one<{ storage_path: string }>(core.ctx.db, 'SELECT storage_path FROM messages WHERE id = ?', [m.id]))!.storage_path);
    expect(existsSync(path)).toBe(true);
    const kept = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'still used' })));
    await core.ctx.store.append({ userId: alice, folderId: (await core.ctx.store.getSpecialFolder(alice, 'inbox'))!.id, message: kept, origin: 'internal' });
    await exec(core.ctx.db, 'UPDATE messages SET created_at = ?, refcount = 0 WHERE id IN (?)', [new Date(Date.now() - 2 * 86400_000), [m.id, kept.id]]); // kept's counter is wrong on purpose
    const r = await collectGarbage(core.ctx.db, core.ctx.blobs);
    expect(r.removed).toBeGreaterThanOrEqual(1);
    expect(r.repaired).toBeGreaterThanOrEqual(1);
    expect(existsSync(path)).toBe(false);
    expect(await one(core.ctx.db, 'SELECT id FROM messages WHERE id = ?', [m.id])).toBeUndefined();
    expect((await one<{ refcount: number }>(core.ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [kept.id]))!.refcount).toBe(1);
  });

  it('mailbox retention empties old Trash items', async () => {
    const trash = (await core.ctx.store.getSpecialFolder(alice, 'trash'))!;
    const m = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'binned long ago' })));
    await core.ctx.store.append({ userId: alice, folderId: trash.id, message: m, origin: 'internal', internalDate: new Date(Date.now() - 40 * 86400_000) });
    const fresh = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'binned today' })));
    await core.ctx.store.append({ userId: alice, folderId: trash.id, message: fresh, origin: 'internal' });
    await exec(core.ctx.db, "INSERT INTO retention_policies (name, target, scope, special_use, keep_days, created_at) VALUES ('trash 30d', 'mailbox_folder', 'all', 'trash', 30, ?)", [new Date()]);
    expect(await purgeMailboxFolders(core.ctx.db, core.ctx.store)).toBe(1);
    expect((await core.ctx.store.getFolderById(trash.id))!.message_count).toBe(1);
  });

  it('indexes message text, attachment names and addresses for full-text search', async () => {
    const m = await core.ctx.store.ingest(Buffer.from(complexMessage()));
    await core.ctx.store.append({ userId: alice, folderId: (await core.ctx.store.getSpecialFolder(alice, 'inbox'))!.id, message: m, origin: 'internal' });
    while ((await indexPending(core.ctx.db, core.ctx.blobs, 500)) > 0);
    const hit = async (q: string) =>
      (await rows<{ message_id: number }>(core.ctx.db, 'SELECT message_id FROM message_search WHERE MATCH(subject, addresses, attachment_names, body_text) AGAINST (? IN BOOLEAN MODE)', [fulltextQuery(q)])).map(
        (r) => r.message_id,
      );
    expect(await hit('searchable-token')).toContain(m.id); // QP-decoded body
    expect(await hit('plan.pdf')).toContain(m.id); // attachment name
    expect(await hit('carol example.org')).toContain(m.id); // address
    expect(await hit('nonexistentword')).not.toContain(m.id);
  });

  it('finds Hindi (Devanagari) text', async () => {
    const raw = `From: a@b.test\r\nTo: alice@${domain}\r\nSubject: =?UTF-8?B?${Buffer.from('मूल्य सूची').toString('base64')}?=\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Transfer-Encoding: 8bit\r\n\r\nकृपया कोटेशन भेजें\r\n`;
    const m = await core.ctx.store.ingest(Buffer.from(raw, 'utf8'));
    await core.ctx.store.append({ userId: alice, folderId: (await core.ctx.store.getSpecialFolder(alice, 'inbox'))!.id, message: m, origin: 'internal' });
    while ((await indexPending(core.ctx.db, core.ctx.blobs, 500)) > 0);
    const hit = async (q: string) =>
      (await rows<{ message_id: number }>(core.ctx.db, 'SELECT message_id FROM message_search WHERE MATCH(subject, addresses, attachment_names, body_text) AGAINST (? IN BOOLEAN MODE)', [fulltextQuery(q)])).map(
        (r) => r.message_id,
      );
    expect(await hit('कोटेशन')).toContain(m.id);
    expect(await hit('मूल्य')).toContain(m.id);
  });
});
