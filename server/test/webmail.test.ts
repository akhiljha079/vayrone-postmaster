import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { io as ioClient } from 'socket.io-client';
import { db as dbm, ipcToken, subscribeIpcStream, type CoreContext } from '@vpm/core';
import type { FastifyInstance } from 'fastify';
import { pino } from 'pino';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';
import { startCore, type TestCore } from '../../core/test/helpers.js';

const { exec, one, rows } = dbm;
const PW = 'Passw0rd#1';

describe.skipIf(!dbConfig())('webmail API', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let alice: Client;
  let aliceId: number;
  let bobId: number;
  const domain = uniqueDomain();
  const A = `alice@${domain}`;
  const B = `bob@${domain}`;

  const inboxOf = async (userId: number) => (await ctx.store.getSpecialFolder(userId, 'inbox'))!;
  const folderOf = async (userId: number, su: 'sent' | 'drafts' | 'trash' | 'junk' | 'inbox') => (await ctx.store.getSpecialFolder(userId, su))!;

  async function deliver(userId: number, raw: string): Promise<number> {
    const message = await ctx.store.ingest(Buffer.from(raw));
    const [o] = await ctx.mailflow.inbound({ message, recipients: [{ userId }], origin: 'fetch', direction: 'in', envelopeFrom: 'x@outside.test' });
    const it = await one<{ id: number }>(ctx.db, 'SELECT id FROM mail_items WHERE folder_id = ? AND uid = ?', [o!.folderId, o!.uid]);
    return it!.id;
  }

  const htmlMail = (subject = 'Newsletter') =>
    [
      'From: Shop <news@shop.test>',
      `To: ${A}`,
      `Subject: ${subject}`,
      `Message-ID: <${randomBytes(6).toString('hex')}@shop.test>`,
      'MIME-Version: 1.0',
      'Content-Type: multipart/related; boundary="rel"',
      '',
      '--rel',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p onclick="steal()">Hello <b>Alice</b> <a href="javascript:alert(1)">bad</a> <a href="https://shop.test/deal">deal</a></p><script>alert(1)</script>',
      '<img src="https://tracker.test/pixel.gif"><img src="cid:logo@shop"><iframe src="https://evil.test"></iframe><form action="https://evil.test"><input></form>',
      '--rel',
      'Content-Type: image/png',
      'Content-ID: <logo@shop>',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--rel',
      'Content-Type: application/pdf; name="price list.pdf"',
      'Content-Disposition: attachment; filename="price list.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from('%PDF-1.4 fake').toString('base64'),
      '--rel--',
      '',
    ].join('\r\n');

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    await ctx.directory.createDomain(domain);
    aliceId = await ctx.directory.createUser({ email: A, password: PW, displayName: 'Alice Rao' });
    bobId = await ctx.directory.createUser({ email: B, password: PW, displayName: 'Bob Singh' });
    alice = new Client(app);
    await alice.login(A, PW);
  });
  afterAll(() => close());

  it('lists folders in a sensible order with counts and quota', async () => {
    await deliver(aliceId, htmlMail());
    const r = (await alice.get('/api/mail/folders')).json();
    expect(r.folders.map((f: { path: string }) => f.path)).toEqual(['INBOX', 'Drafts', 'Sent', 'Archive', 'Junk', 'Trash']);
    expect(r.folders[0]).toMatchObject({ messages: 1, unseen: 1, specialUse: 'inbox' });
    expect(r.quota.used).toBeGreaterThan(0);
  });

  it('reads a message with sanitised HTML, blocked remote images, inline cid images and attachments', async () => {
    const id = await deliver(aliceId, htmlMail('Sale'));
    const m = (await alice.get(`/api/mail/messages/${id}`)).json();
    expect(m.subject).toBe('Sale');
    expect(m.from).toEqual([{ name: 'Shop', address: 'news@shop.test' }]);
    expect(m.html).not.toMatch(/<script|onclick|javascript:|<iframe|<form/i);
    expect(m.html).toContain('target="_blank"');
    expect(m.html).toContain('data-vpm-src="https://tracker.test/pixel.gif"');
    expect(m.html).not.toMatch(/\ssrc="https:\/\/tracker/); // only as data-vpm-src, never as a live src
    expect(m.html).toContain('src="data:image/png;base64,');
    expect(m.remoteImages).toBe(true);
    expect(m.attachments).toEqual([{ index: 1, filename: 'price list.pdf', contentType: 'application/pdf', size: 13, cid: null, inline: false }]);
    const st = await one<{ flags: number }>(ctx.db, 'SELECT flags FROM mail_items WHERE id = ?', [id]);
    expect(st!.flags & 1).toBe(1); // opened = read

    const withImages = (await alice.get(`/api/mail/messages/${id}?images=1`)).json();
    expect(withImages.html).toContain('src="https://tracker.test/pixel.gif"');

    const att = await alice.get(`/api/mail/messages/${id}/attachments/1`);
    expect(att.headers['content-type']).toBe('application/pdf');
    expect(att.headers['content-disposition']).toContain("filename*=UTF-8''price%20list.pdf");
    expect(att.headers['x-content-type-options']).toBe('nosniff');
    expect(att.body).toBe('%PDF-1.4 fake');
    const raw = await alice.get(`/api/mail/messages/${id}/raw`);
    expect(raw.headers['content-type']).toContain('message/rfc822');
    expect(raw.body).toContain('Subject: Sale');
  });

  it('lists messages newest first with previews, search and paging', async () => {
    for (let i = 1; i <= 5; i++) await deliver(aliceId, `From: Vendor <v${i}@vendor.test>\r\nTo: ${A}\r\nSubject: Invoice ${i}\r\nMessage-ID: <inv${i}${Date.now()}@v>\r\n\r\nPlease find invoice number ${i} attached.\r\n`);
    const inbox = await inboxOf(aliceId);
    const p1 = (await alice.get(`/api/mail/folders/${inbox.id}/messages?limit=3&q=invoice`)).json();
    expect(p1.items.map((m: { subject: string }) => m.subject)).toEqual(['Invoice 5', 'Invoice 4', 'Invoice 3']);
    expect(p1.items[0]).toMatchObject({ preview: 'Please find invoice number 5 attached.', seen: false, from: 'Vendor <v5@vendor.test>' });
    const p2 = (await alice.get(`/api/mail/folders/${inbox.id}/messages?limit=3&q=invoice&before=${p1.nextBefore}`)).json();
    expect(p2.items.map((m: { subject: string }) => m.subject)).toEqual(['Invoice 2', 'Invoice 1']);
    expect(p2.nextBefore).toBeNull();
    expect((await alice.get(`/api/mail/folders/${inbox.id}/messages?unread=1`)).json().items.every((m: { seen: boolean }) => !m.seen)).toBe(true);
  });

  it('keeps users out of each other’s mail', async () => {
    const bobItem = await deliver(bobId, `From: x@y.test\r\nTo: ${B}\r\nSubject: private\r\n\r\nsecret\r\n`);
    expect((await alice.get(`/api/mail/messages/${bobItem}`)).statusCode).toBe(404);
    expect((await alice.get(`/api/mail/folders/${(await inboxOf(bobId)).id}/messages`)).statusCode).toBe(404);
    expect((await alice.post('/api/mail/messages/actions', { ids: [bobItem], action: 'delete' })).statusCode).toBe(200);
    expect(await one(ctx.db, 'SELECT id FROM mail_items WHERE id = ?', [bobItem])).toBeTruthy(); // untouched
  });

  it('flags, moves, deletes to Trash and deletes for good from Trash', async () => {
    const id = await deliver(aliceId, `From: a@b.test\r\nTo: ${A}\r\nSubject: tidy me\r\nMessage-ID: <tidy${Date.now()}@b>\r\n\r\nx\r\n`);
    await alice.post('/api/mail/messages/actions', { ids: [id], action: 'flag' });
    await alice.post('/api/mail/messages/actions', { ids: [id], action: 'read' });
    expect((await one<{ flags: number }>(ctx.db, 'SELECT flags FROM mail_items WHERE id = ?', [id]))!.flags & 5).toBe(5);
    const archive = (await ctx.store.getSpecialFolder(aliceId, 'archive'))!;
    await alice.post('/api/mail/messages/actions', { ids: [id], action: 'move', folderId: archive.id });
    expect((await one<{ folder_id: number }>(ctx.db, 'SELECT folder_id FROM mail_items WHERE id = ?', [id]))!.folder_id).toBe(archive.id);
    await alice.post('/api/mail/messages/actions', { ids: [id], action: 'delete' });
    const trash = await folderOf(aliceId, 'trash');
    expect((await one<{ folder_id: number }>(ctx.db, 'SELECT folder_id FROM mail_items WHERE id = ?', [id]))!.folder_id).toBe(trash.id);
    await alice.post('/api/mail/messages/actions', { ids: [id], action: 'delete' });
    expect(await one(ctx.db, 'SELECT id FROM mail_items WHERE id = ?', [id])).toBeUndefined();
  });

  it('sends: local delivery, external queue, Bcc kept only in Sent, reply marks \\Answered', async () => {
    const original = await deliver(aliceId, `From: Bob Singh <${B}>\r\nTo: ${A}\r\nSubject: Lunch?\r\nMessage-ID: <lunch@b>\r\n\r\nLunch at 1?\r\n`);
    const r = await alice.post('/api/mail/send', {
      from: A,
      to: [`Bob Singh <${B}>`],
      bcc: ['boss@outside.test'],
      subject: 'Re: Lunch?',
      html: '<p>Yes, <b>1 pm</b> works.</p>',
      inReplyTo: '<lunch@b>',
      references: '<lunch@b>',
      replyToItemId: original,
    });
    expect(r.json()).toMatchObject({ ok: true, queued: true, delivered: 1 });
    const bobInbox = await inboxOf(bobId);
    const [got] = await ctx.store.itemsFull(bobInbox.id, (await ctx.store.listUids(bobInbox.id)).slice(-1));
    const bobRaw = (await ctx.store.loadRaw(got!)).toString();
    expect(bobRaw).toMatch(/^Received: from webmail/);
    expect(bobRaw).toContain('In-Reply-To: <lunch@b>');
    expect(bobRaw).not.toMatch(/^Bcc:/im);
    expect(bobRaw).toContain('Content-Type: text/plain'); // text alternative generated
    const sent = await folderOf(aliceId, 'sent');
    const [sentItem] = await ctx.store.itemsFull(sent.id, (await ctx.store.listUids(sent.id)).slice(-1));
    expect((await ctx.store.loadRaw(sentItem!)).toString()).toMatch(/^Bcc: boss@outside\.test/im);
    expect(sentItem!.flags & 1).toBe(1);
    const q = await one<{ id: number }>(ctx.db, "SELECT q.id FROM outbound_queue q JOIN outbound_recipients r ON r.queue_id = q.id WHERE r.rcpt = 'boss@outside.test'");
    expect(q).toBeTruthy();
    expect((await one<{ flags: number }>(ctx.db, 'SELECT flags FROM mail_items WHERE id = ?', [original]))!.flags & 2).toBe(2);
  });

  it('refuses sending as someone else or to unknown local mailboxes', async () => {
    expect((await alice.post('/api/mail/send', { from: B, to: [A], subject: 'x', html: 'x' })).statusCode).toBe(403);
    await exec(ctx.db, "UPDATE domains SET unknown_recipient_action = 'reject' WHERE name = ?", [domain]);
    const r = await alice.post('/api/mail/send', { from: A, to: [`ghost@${domain}`], subject: 'x', html: 'x' });
    expect(r.json().error).toBe('UNKNOWN_RECIPIENT');
    expect((await alice.post('/api/mail/send', { from: A, to: ['not-an-address'], subject: 'x', html: 'x' })).statusCode).toBe(400);
  });

  it('drafts: save, update (old draft replaced), send (draft removed)', async () => {
    const drafts = await folderOf(aliceId, 'drafts');
    const d1 = (await alice.post('/api/mail/drafts', { from: A, to: [B], subject: 'Plan', html: '<p>v1</p>' })).json().draftItemId;
    const d2 = (await alice.post('/api/mail/drafts', { from: A, to: [B], subject: 'Plan', html: '<p>v2</p>', draftItemId: d1 })).json().draftItemId;
    const ids = (await rows<{ id: number; flags: number }>(ctx.db, 'SELECT id, flags FROM mail_items WHERE folder_id = ?', [drafts.id])).map((x) => x.id);
    expect(ids).toEqual([d2]);
    const draft = (await alice.get(`/api/mail/messages/${d2}?markRead=0`)).json();
    expect(draft).toMatchObject({ flags: { draft: true }, subject: 'Plan', to: [{ address: B }] });
    await alice.post('/api/mail/send', { from: A, to: [B], subject: 'Plan', html: '<p>final</p>', draftItemId: d2 });
    expect(await ctx.store.listUids(drafts.id)).toEqual([]);
  });

  it('uploads attachments and forwards carried attachments', async () => {
    const boundary = '----vpmtest';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="रिपोर्ट.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from('quarterly numbers'),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const up = await app.inject({
      method: 'POST',
      url: '/api/mail/uploads',
      payload: body,
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        cookie: [...alice.cookies].map(([k, v]) => `${k}=${v}`).join('; '),
        'x-vpm-csrf': alice.cookies.get('vpm_csrf')!,
      },
      remoteAddress: alice.ip,
    });
    expect(up.statusCode).toBe(200);
    const meta = up.json();
    expect(meta).toMatchObject({ filename: 'रिपोर्ट.txt', size: 17, contentType: 'text/plain' });

    const withPdf = await deliver(aliceId, htmlMail('With price list'));
    await alice.post('/api/mail/send', { from: A, to: [B], subject: 'Fwd: price list', html: '<p>FYI</p>', uploads: [meta.id], carried: [{ itemId: withPdf, index: 1 }], forwardOfItemId: withPdf });
    const bobInbox = await inboxOf(bobId);
    const last = (await rows<{ id: number }>(ctx.db, 'SELECT id FROM mail_items WHERE folder_id = ? ORDER BY uid DESC LIMIT 1', [bobInbox.id]))[0]!.id;
    const bob = new Client(app);
    await bob.login(B, PW);
    const m = (await bob.get(`/api/mail/messages/${last}`)).json();
    expect(m.attachments.map((a: { filename: string }) => a.filename).sort()).toEqual(['price list.pdf', 'रिपोर्ट.txt']);
    expect((await one<{ flags: number }>(ctx.db, 'SELECT flags FROM mail_items WHERE id = ?', [withPdf]))!.flags & 32).toBe(32); // $Forwarded
    expect((await alice.post('/api/mail/send', { from: A, to: [B], subject: 'x', html: 'x', uploads: [meta.id] })).statusCode).toBe(400); // upload consumed
  });

  it('suggests contacts from the directory and recent correspondents', async () => {
    const c = (await alice.get('/api/mail/contacts?q=bob')).json();
    expect(c[0]).toMatchObject({ name: 'Bob Singh', address: B });
    const v = (await alice.get('/api/mail/contacts?q=vendor')).json();
    expect(v.some((x: { address: string }) => x.address.endsWith('@vendor.test'))).toBe(true);
    expect((await alice.get('/api/mail/identities')).json()).toMatchObject({ displayName: 'Alice Rao', addresses: [A] });
  });

  it('manages personal folders but protects system folders', async () => {
    const f = (await alice.post('/api/mail/folders', { path: 'Projects/Agra' })).json();
    expect((await alice.patch(`/api/mail/folders/${f.id}`, { path: 'Projects/Mathura' })).statusCode).toBe(200);
    expect((await alice.del(`/api/mail/folders/${(await folderOf(aliceId, 'sent')).id}`)).statusCode).toBe(400);
    expect((await alice.del(`/api/mail/folders/${f.id}`)).statusCode).toBe(200);
  });

  it('"Always move from sender" and Run now: a rule files new and existing mail into a folder', async () => {
    const vendorMail = (subject: string) => `From: Sharma Steel <orders@sharma.test>\r\nTo: ${A}\r\nSubject: ${subject}\r\nMessage-ID: <${randomBytes(6).toString('hex')}@sharma.test>\r\n\r\nPlease confirm.\r\n`;
    await deliver(aliceId, vendorMail('PO 1'));
    await deliver(aliceId, vendorMail('PO 2'));
    await deliver(aliceId, `From: other@else.test\r\nTo: ${A}\r\nSubject: Unrelated\r\nMessage-ID: <${randomBytes(6).toString('hex')}@else.test>\r\n\r\nhi\r\n`);
    // What the webmail dialog does: folder, rule, run on the Inbox.
    expect((await alice.post('/api/mail/folders', { path: 'Clients/Sharma' })).statusCode).toBe(200);
    const rule = (await alice.post('/api/mail/rules', { name: 'From orders@sharma.test', stage: 'inbound', conditions: [{ field: 'from', op: 'contains', value: 'orders@sharma.test' }], actions: [{ type: 'move', folder: 'Clients/Sharma' }], stopProcessing: true })).json();
    const inbox = await inboxOf(aliceId);
    const run = (await alice.post(`/api/mail/rules/${rule.id}/run`, { folderId: inbox.id })).json();
    expect(run).toMatchObject({ matched: 2, moved: 2 });
    const sharma = (await ctx.store.getFolder(aliceId, 'Clients/Sharma'))!;
    const subjects = async (folderId: number) => (await rows<{ s: string }>(ctx.db, 'SELECT m.hdr_subject s FROM mail_items i JOIN messages m ON m.id = i.message_id WHERE i.folder_id = ? ORDER BY s', [folderId])).map((r) => r.s);
    expect(await subjects(sharma.id)).toEqual(['PO 1', 'PO 2']);
    expect(await subjects(inbox.id)).toContain('Unrelated');
    // New mail from that sender goes straight to the folder.
    await deliver(aliceId, vendorMail('PO 3'));
    expect(await subjects(sharma.id)).toEqual(['PO 1', 'PO 2', 'PO 3']);
    // Someone else's rule cannot be run.
    const bob = new Client(app);
    await bob.login(B, PW);
    expect((await bob.post(`/api/mail/rules/${rule.id}/run`, {})).statusCode).toBe(404);
  });
});

describe.skipIf(!dbConfig())('realtime push to browsers', () => {
  let core: TestCore;
  let web: { ctx: CoreContext; app: FastifyInstance; close(): Promise<void> };
  let port = 0;
  let stopStream: () => void;
  const domain = uniqueDomain();
  const email = `live@${domain}`;
  let userId: number;

  beforeAll(async () => {
    // Two "processes": core (mail listeners + IPC) and the web app with its own event bus.
    core = await startCore();
    web = await makeServer();
    stopStream = subscribeIpcStream(web.ctx.events, core.ports.ipc!, await ipcToken(core.dataPath), pino({ level: 'silent' }));
    await core.ctx.directory.createDomain(domain);
    userId = await core.ctx.directory.createUser({ email, password: PW });
    await web.app.listen({ port: 0, host: '127.0.0.1' });
    port = (web.app.server.address() as AddressInfo).port;
    await new Promise((r) => setTimeout(r, 200)); // stream connected
  });
  afterAll(async () => {
    stopStream();
    await web.close();
    await core.stop();
  });

  it('rejects sockets without a valid session', async () => {
    const s = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false });
    const err = await new Promise<Error>((resolve) => s.on('connect_error', resolve));
    expect(err.message).toBe('unauthorized');
    s.close();
  });

  it('pushes new mail delivered by another process within a second', async () => {
    const c = new Client(web.app);
    await c.login(email, PW);
    const cookie = [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    const s = ioClient(`http://127.0.0.1:${port}`, { transports: ['websocket'], reconnection: false, extraHeaders: { cookie } });
    await new Promise<void>((resolve, reject) => {
      s.on('connect', () => resolve());
      s.on('connect_error', reject);
    });
    const inbox = (await core.ctx.store.getSpecialFolder(userId, 'inbox'))!;
    const got = new Promise<{ folders: number[] }>((resolve) => s.on('mail', resolve));
    const t0 = Date.now();
    const message = await core.ctx.store.ingest(Buffer.from(`From: a@b.test\r\nTo: ${email}\r\nSubject: live\r\n\r\nx\r\n`));
    await core.ctx.mailflow.inbound({ message, recipients: [{ userId }], origin: 'fetch', direction: 'in', envelopeFrom: 'a@b.test' });
    const ev = await got;
    expect(ev.folders).toContain(inbox.id);
    expect(Date.now() - t0).toBeLessThan(1500);
    s.close();
  });

});
