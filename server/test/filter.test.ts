import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { db as dbm, type CoreContext } from '@vpm/core';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const PW = 'Passw0rd#1';
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

describe.skipIf(!dbConfig())('filtering admin API', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let boss: Client;
  let deputy: Client;
  let alice: number;
  const domain = uniqueDomain();

  const deliver = async (raw: string) => {
    const message = await ctx.store.ingest(Buffer.from(raw));
    return ctx.mailflow.inbound({ message, recipients: [{ userId: alice }], origin: 'fetch', direction: 'in', envelopeFrom: 'x@vendor.test' });
  };

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    await ctx.directory.createDomain(domain);
    await ctx.directory.createUser({ email: `boss@${domain}`, password: PW, role: 'super_admin' });
    await ctx.directory.createUser({ email: `deputy@${domain}`, password: PW, role: 'admin' });
    alice = await ctx.directory.createUser({ email: `alice@${domain}`, password: PW });
    boss = new Client(app);
    await boss.login(`boss@${domain}`, PW);
    deputy = new Client(app);
    await deputy.login(`deputy@${domain}`, PW);
  });
  afterAll(async () => {
    await dbm.exec(ctx.db, "DELETE FROM settings WHERE namespace = 'filter'");
    await close();
  });

  it('settings: validated, super admin only', async () => {
    const cur = (await boss.get('/api/admin/filter')).json();
    expect(cur).toMatchObject({ spam: { engine: 'builtin' }, attachments: { enabled: true, blocked: expect.arrayContaining(['exe', 'js']) }, antivirusLicensed: true });
    const { defaults: _d, antivirusLicensed: _a, ...body } = cur;
    expect((await deputy.put('/api/admin/filter', body)).statusCode).toBe(403);
    expect((await boss.put('/api/admin/filter', { ...body, spam: { ...body.spam, quarantineScore: 3 } })).json().message).toMatch(/higher than the Junk score/);
    const r = await boss.put('/api/admin/filter', { ...body, attachments: { ...body.attachments, blocked: ['.EXE', 'js', 'exe'] } });
    expect(r.json().attachments.blocked).toEqual(['exe', 'js']);
    expect((await boss.post('/api/admin/filter/test-antivirus')).json()).toMatchObject({ ok: false, message: expect.stringMatching(/not reachable/) });
  });

  it('quarantine: list, details without content, release (viruses: super admin only), delete', async () => {
    await deliver(`From: x@vendor.test\r\nTo: alice@${domain}\r\nSubject: Tool\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary=b\r\n\r\n--b\r\nContent-Type: text/plain\r\n\r\nhi\r\n--b\r\nContent-Type: application/javascript; name="run.js"\r\nContent-Disposition: attachment; filename="run.js"\r\n\r\nalert(1)\r\n--b--\r\n`);
    const list = (await deputy.get('/api/admin/quarantine')).json();
    const held = list.items.find((i: { subject: string }) => i.subject === 'Tool');
    expect(held).toMatchObject({ kind: 'attachment', reason: 'Blocked attachment type: run.js', recipients: [`alice@${domain}`] });
    const d = (await deputy.get(`/api/admin/quarantine/${held.id}`)).json();
    expect(d.attachments).toEqual([{ name: 'run.js', size: expect.any(Number) }]);
    expect(d.headers).toContain('Subject: Tool');
    expect(JSON.stringify(d)).not.toContain('alert(1)');
    expect((await deputy.post(`/api/admin/quarantine/${held.id}/release`)).json()).toEqual({ ok: true, delivered: 1 });
    expect((await deputy.post(`/api/admin/quarantine/${held.id}/release`)).statusCode).toBe(404);

    // A held "virus" (simulated row) can only be released by a super admin.
    const msg = await ctx.store.ingest(Buffer.from(`From: x@vendor.test\r\nSubject: v\r\n\r\n${EICAR}\r\n`));
    await dbm.exec(ctx.db, 'UPDATE messages SET refcount = refcount + 1 WHERE id = ?', [msg.id]);
    const v = await dbm.exec(ctx.db, "INSERT INTO quarantine (message_id, direction, kind, reason, envelope_from, recipients, subject, size, origin, created_at) VALUES (?, 'in', 'virus', 'Virus found: EICAR', 'x@vendor.test', ?, 'v', 10, 'fetch', ?)", [msg.id, JSON.stringify([{ userId: alice }]), new Date()]);
    expect((await deputy.post(`/api/admin/quarantine/${v.insertId}/release`)).json().message).toMatch(/super admin/);
    expect((await deputy.post(`/api/admin/quarantine/${v.insertId}/delete`)).json()).toEqual({ ok: true });
    expect((await deputy.get('/api/admin/quarantine?state=deleted&kind=virus')).json().items.map((i: { id: number }) => i.id)).toContain(v.insertId);
    expect(await dbm.one(ctx.db, "SELECT id FROM audit_log WHERE action = 'quarantine.release'")).toBeTruthy();
  });

  it('server-wide sender lists, and webmail Junk / Not junk teach the user list', async () => {
    expect((await deputy.post('/api/admin/sender-lists', { pattern: 'bad', kind: 'block' })).statusCode).toBe(400);
    expect((await deputy.post('/api/admin/sender-lists', { pattern: '@spammy.test', kind: 'block' })).statusCode).toBe(200);
    expect((await deputy.get('/api/admin/sender-lists')).json()).toEqual(expect.arrayContaining([expect.objectContaining({ pattern: '@spammy.test', kind: 'block' })]));

    await deliver(`From: Promo <promo@shop.test>\r\nTo: alice@${domain}\r\nSubject: Sale\r\nMessage-ID: <sale1@shop.test>\r\n\r\nBig sale\r\n`);
    const a = new Client(app);
    await a.login(`alice@${domain}`, PW);
    const inbox = (await ctx.store.getSpecialFolder(alice, 'inbox'))!;
    const items = (await a.get(`/api/mail/folders/${inbox.id}/messages`)).json().items as { id: number; subject: string }[];
    const sale = items.find((i) => i.subject === 'Sale')!;
    expect((await a.post('/api/mail/messages/actions', { ids: [sale.id], action: 'junk' })).statusCode).toBe(200);
    expect(await dbm.one(ctx.db, "SELECT kind FROM sender_lists WHERE user_id = ? AND pattern = 'promo@shop.test'", [alice])).toEqual({ kind: 'block' });
    // The next mail from that sender goes straight to Junk.
    await deliver(`From: Promo <promo@shop.test>\r\nTo: alice@${domain}\r\nSubject: Sale 2\r\nMessage-ID: <sale2@shop.test>\r\n\r\nBig sale\r\n`);
    const junk = (await ctx.store.getSpecialFolder(alice, 'junk'))!;
    expect((await a.get(`/api/mail/folders/${junk.id}/messages`)).json().items.map((i: { subject: string }) => i.subject)).toEqual(expect.arrayContaining(['Sale', 'Sale 2']));
  });
});
