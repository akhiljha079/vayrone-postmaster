import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db as dbm, type CoreContext } from '@vpm/core';
import type { FastifyInstance } from 'fastify';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const { exec, one } = dbm;
const PW = 'Passw0rd#1';

describe.skipIf(!dbConfig())('admin panel API', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let a: Client;
  const domain = uniqueDomain();
  const superAdmin = `owner@${domain}`;

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    await ctx.directory.createDomain(domain);
    await ctx.directory.createUser({ email: superAdmin, password: PW, role: 'super_admin' });
    a = new Client(app);
    await a.login(superAdmin, PW);
  });
  afterAll(() => close());

  it('manages domains with validation and in-use protection', async () => {
    expect((await a.post('/api/admin/domains', { name: 'not a domain' })).statusCode).toBe(400);
    const d2 = `second-${domain}`;
    const r = await a.post('/api/admin/domains', { name: d2, unknownRecipientAction: 'reject' });
    expect(r.statusCode).toBe(200);
    expect((await a.post('/api/admin/domains', { name: d2 })).statusCode).toBe(409);
    const list = (await a.get('/api/admin/domains')).json() as { name: string; unknownRecipientAction: string }[];
    expect(list.find((d) => d.name === d2)?.unknownRecipientAction).toBe('reject');
    expect((await a.del(`/api/admin/domains/${(list.find((d) => d.name === domain) as unknown as { id: number }).id}`)).json().error).toBe('DOMAIN_IN_USE');
    expect((await a.del(`/api/admin/domains/${r.json().id}`)).statusCode).toBe(200);
  });

  it('creates and edits users with quota and per-protocol access', async () => {
    const r = await a.post('/api/admin/users', {
      email: `meena@${domain}`,
      displayName: 'Meena Sharma',
      password: PW,
      quotaBytes: 1024 * 1024 * 1024,
      allowPop3: false,
    });
    expect(r.statusCode).toBe(200);
    const id = r.json().id;
    const u = (await a.get(`/api/admin/users/${id}`)).json();
    expect(u).toMatchObject({ login: `meena@${domain}`, allowPop3: 0, allowImap: 1, quotaBytes: 1073741824 });
    expect(u.folders.map((f: { path: string }) => f.path)).toContain('INBOX');
    expect(await ctx.directory.authenticate(`meena@${domain}`, PW, 'pop3', '10.0.0.5')).toBeNull();
    expect(await ctx.directory.authenticate(`meena@${domain}`, PW, 'imap', '10.0.0.5')).toBeTruthy();

    await a.patch(`/api/admin/users/${id}`, { isEnabled: false });
    expect(await ctx.directory.authenticate(`meena@${domain}`, PW, 'imap', '10.0.0.5')).toBeNull();
    await a.patch(`/api/admin/users/${id}`, { isEnabled: true, password: 'Changed123' });
    expect(await ctx.directory.authenticate(`meena@${domain}`, 'Changed123', 'imap', '10.0.0.5')).toBeTruthy();
    expect((await a.post('/api/admin/users', { email: `meena@${domain}`, displayName: 'Dup', password: PW })).json().error).toBe('ADDRESS_TAKEN');
    expect((await a.post('/api/admin/users', { email: 'x@unknown-domain.test', displayName: 'X', password: PW })).json().error).toBe('UNKNOWN_DOMAIN');
    expect((await a.post('/api/admin/users', { email: `weak@${domain}`, displayName: 'W', password: 'short' })).statusCode).toBe(400);
  });

  it('enforces role rules: admins cannot create super admins; last super admin is protected; no self-disable', async () => {
    const r = await a.post('/api/admin/users', { email: `deputy@${domain}`, displayName: 'Deputy', password: PW, role: 'admin' });
    const deputy = new Client(app);
    await deputy.login(`deputy@${domain}`, PW);
    expect((await deputy.post('/api/admin/users', { email: `boss2@${domain}`, displayName: 'B', password: PW, role: 'super_admin' })).statusCode).toBe(403);
    const me = (await a.get('/api/auth/me')).json().user.id;
    expect((await deputy.patch(`/api/admin/users/${me}`, { isEnabled: false })).statusCode).toBe(403);
    expect((await a.patch(`/api/admin/users/${me}`, { isEnabled: false })).statusCode).toBe(400);
    expect((await a.del(`/api/admin/users/${me}`)).statusCode).toBe(400);
    expect((await deputy.get('/api/admin/security/policy')).statusCode).toBe(200);
    expect((await deputy.put('/api/admin/security/policy', { lockoutThreshold: 5 })).statusCode).toBe(403); // super only
    await a.del(`/api/admin/users/${r.json().id}`);
  });

  it('partial updates never reset fields that were not sent', async () => {
    const id = (await a.post('/api/admin/users', { email: `partial@${domain}`, displayName: 'Partial', password: PW, role: 'admin', allowPop3: false, quotaBytes: 12345678 })).json().id;
    expect((await a.patch(`/api/admin/users/${id}`, { displayName: 'Renamed' })).statusCode).toBe(200);
    expect((await a.get(`/api/admin/users/${id}`)).json()).toMatchObject({ displayName: 'Renamed', role: 'admin', allowPop3: 0, quotaBytes: 12345678, isEnabled: 1 });

    const relay = (await a.post('/api/admin/relays', { name: 'Partial relay', host: 'smtp.partial.test', port: 465, security: 'tls', envelopeFrom: 'original_sender', setSenderHeader: false, isDefault: false })).json().id;
    await a.patch(`/api/admin/relays/${relay}`, { port: 587 });
    const r = (await a.get('/api/admin/relays')).json().find((x: { id: number }) => x.id === relay);
    expect(r).toMatchObject({ port: 587, security: 'tls', envelopeFrom: 'original_sender', setSenderHeader: 0 });

    const d = await a.post('/api/admin/domains', { name: `partial-${domain}`, unknownRecipientAction: 'reject', defaultQuotaBytes: 999999 });
    await a.patch(`/api/admin/domains/${d.json().id}`, { isEnabled: false });
    const dom = (await a.get('/api/admin/domains')).json().find((x: { id: number }) => x.id === d.json().id);
    expect(dom).toMatchObject({ isEnabled: 0, unknownRecipientAction: 'reject', defaultQuotaBytes: 999999 });
  });

  it('deleting a user releases stored message references', async () => {
    const r = await a.post('/api/admin/users', { email: `temp@${domain}`, displayName: 'Temp', password: PW });
    const id = r.json().id;
    const message = await ctx.store.ingest(Buffer.from(`Subject: bye\r\nMessage-ID: <${Date.now()}@x>\r\n\r\nx\r\n`));
    await ctx.delivery.deliver({ message, targets: [{ userId: id }], origin: 'internal', envelopeFrom: 'a@b' });
    expect((await one<{ refcount: number }>(ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [message.id]))!.refcount).toBe(1);
    expect((await a.del(`/api/admin/users/${id}`)).statusCode).toBe(200);
    expect((await one<{ refcount: number }>(ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [message.id]))!.refcount).toBe(0);
    expect(await one(ctx.db, 'SELECT id FROM folders WHERE user_id = ?', [id])).toBeUndefined();
  });

  it('aliases, groups and distribution lists drive mail routing', async () => {
    const u1 = (await a.post('/api/admin/users', { email: `sales1@${domain}`, displayName: 'S1', password: PW })).json().id;
    const u2 = (await a.post('/api/admin/users', { email: `sales2@${domain}`, displayName: 'S2', password: PW })).json().id;
    const al = await a.post('/api/admin/aliases', { address: `info@${domain}`, targets: [{ userId: u1 }, { external: 'partner@outside.test' }] });
    expect(al.statusCode).toBe(200);
    expect(await ctx.directory.resolve(`info@${domain}`)).toEqual({ kind: 'local', userIds: [u1], external: ['partner@outside.test'] });
    expect((await a.post('/api/admin/aliases', { address: `sales1@${domain}`, targets: [{ userId: u2 }] })).json().error).toBe('ADDRESS_TAKEN');
    await a.patch(`/api/admin/aliases/${al.json().id}`, { isEnabled: false });
    expect((await ctx.directory.resolve(`info@${domain}`)).kind).toBe('unknown-local');

    const g = await a.post('/api/admin/groups', { name: `Sales ${domain}`, memberIds: [u1, u2] });
    const groups = (await a.get('/api/admin/groups')).json() as { id: number; members: unknown[] }[];
    expect(groups.find((x) => x.id === g.json().id)!.members).toHaveLength(2);

    const l = await a.post('/api/admin/lists', {
      address: `team@${domain}`,
      name: 'Team',
      senderPolicy: 'members',
      members: [{ userId: u1 }, { userId: u2 }, { external: 'consultant@outside.test' }],
      expandExternal: false,
    });
    const res = await ctx.directory.resolve(`team@${domain}`);
    expect(res.kind === 'local' && res.userIds.sort()).toEqual([u1, u2].sort());
    expect(res.kind === 'local' && res.external).toEqual([]); // expandExternal off
    const listId = res.kind === 'local' ? res.listId! : 0;
    expect(await ctx.directory.listAllowsSender(listId, `sales1@${domain}`)).toBe(true);
    expect(await ctx.directory.listAllowsSender(listId, `owner@${domain}`)).toBe(false);
    expect(await ctx.directory.listAllowsSender(listId, 'consultant@outside.test')).toBe(true);
    await a.patch(`/api/admin/lists/${l.json().id}`, { senderPolicy: 'domain' });
    expect(await ctx.directory.listAllowsSender(listId, `owner@${domain}`)).toBe(true);
  });

  it('relay accounts: password write-only and encrypted; single default', async () => {
    const r1 = await a.post('/api/admin/relays', { name: 'Hostinger', host: 'smtp.hostinger.test', port: 587, authUser: 'mailserver@client.test', password: 'S3cr3t-relay', isDefault: true });
    const r2 = await a.post('/api/admin/relays', { name: 'Backup', host: 'smtp.backup.test', port: 465, security: 'tls', password: 'x', isDefault: true });
    const list = (await a.get('/api/admin/relays')).json() as Record<string, unknown>[];
    expect(JSON.stringify(list)).not.toContain('S3cr3t-relay');
    expect(list.find((x) => x.id === r1.json().id)).toMatchObject({ passwordSet: 1, isDefault: 0 });
    expect(list.find((x) => x.id === r2.json().id)).toMatchObject({ isDefault: 1 });
    const raw = await one<{ auth_secret: Buffer }>(ctx.db, 'SELECT auth_secret FROM relay_accounts WHERE id = ?', [r1.json().id]);
    expect(Buffer.from(raw!.auth_secret).toString('latin1')).not.toContain('S3cr3t');
    expect(ctx.secrets.open(Buffer.from(raw!.auth_secret))).toBe('S3cr3t-relay');
    await a.patch(`/api/admin/relays/${r1.json().id}`, { port: 2525 });
    const after = await one<{ auth_secret: Buffer; port: number }>(ctx.db, 'SELECT auth_secret, port FROM relay_accounts WHERE id = ?', [r1.json().id]);
    expect(after!.port).toBe(2525);
    expect(ctx.secrets.open(Buffer.from(after!.auth_secret))).toBe('S3cr3t-relay'); // unchanged when omitted
    const t = await a.post(`/api/admin/relays/${r1.json().id}/test`, {});
    expect(t.json().ok).toBe(false); // unreachable host reports, never throws
    const route = await a.put('/api/admin/relay-routes', { scope: 'domain', domainId: (await one<{ id: number }>(ctx.db, 'SELECT id FROM domains WHERE name = ?', [domain]))!.id, relayAccountId: r1.json().id });
    expect(route.statusCode).toBe(200);
    expect((await a.put('/api/admin/relay-routes', { scope: 'user', userId: 1 })).statusCode).toBe(400);
  });

  it('queue viewer: hold, release, retry and delete keep message references balanced', async () => {
    const sender = (await one<{ id: number }>(ctx.db, 'SELECT id FROM users WHERE login = ?', [superAdmin]))!.id;
    const message = await ctx.store.ingest(Buffer.from(`Subject: queued\r\nMessage-ID: <q${Date.now()}@x>\r\n\r\nx\r\n`));
    const qid = await ctx.delivery.enqueueOutbound({ message, envelopeFrom: superAdmin, recipients: ['x@outside.test'], senderUserId: sender, source: 'submission' });
    const ref = async () => (await one<{ refcount: number }>(ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [message.id]))!.refcount;
    expect(await ref()).toBe(1);

    const list = (await a.get('/api/admin/queue?status=queued')).json();
    expect(list.items.some((i: { id: number; subject: string }) => i.id === qid && i.subject === 'queued')).toBe(true);
    expect((await a.post(`/api/admin/queue/${qid}/hold`, { reason: 'Check with sales' })).statusCode).toBe(200);
    expect((await a.post(`/api/admin/queue/${qid}/hold`)).statusCode).toBe(409);
    expect((await a.post(`/api/admin/queue/${qid}/release`)).statusCode).toBe(200);

    await exec(ctx.db, "UPDATE outbound_queue SET status = 'failed' WHERE id = ?", [qid]);
    await exec(ctx.db, "UPDATE outbound_recipients SET status = 'failed' WHERE queue_id = ?", [qid]);
    await exec(ctx.db, 'UPDATE messages SET refcount = refcount - 1 WHERE id = ?', [message.id]); // what the sender does on finalize
    expect((await a.post(`/api/admin/queue/${qid}/retry`)).statusCode).toBe(200);
    expect(await ref()).toBe(1);
    const detail = (await a.get(`/api/admin/queue/${qid}`)).json();
    expect(detail.status).toBe('queued');
    expect(detail.recipients[0].status).toBe('pending');
    expect((await a.del(`/api/admin/queue/${qid}`)).statusCode).toBe(200);
    expect(await ref()).toBe(0);
  });

  it('audit log records admin actions and detects tampering', async () => {
    const log = (await a.get('/api/admin/audit?action=user.')).json();
    expect(log.items.length).toBeGreaterThan(3);
    expect(JSON.stringify(log.items)).not.toContain(PW);
    expect((await a.get('/api/admin/audit/verify')).json()).toMatchObject({ ok: true });
    const victim = await one<{ id: number }>(ctx.db, "SELECT id FROM audit_log WHERE action = 'user.create' ORDER BY id DESC LIMIT 1");
    await exec(ctx.db, "UPDATE audit_log SET action = 'user.view' WHERE id = ?", [victim!.id]);
    const v = (await a.get('/api/admin/audit/verify')).json();
    expect(v).toMatchObject({ ok: false, brokenAt: victim!.id });
    await exec(ctx.db, "UPDATE audit_log SET action = 'user.create' WHERE id = ?", [victim!.id]);
  });

  it('dashboard and company profile', async () => {
    const d = (await a.get('/api/admin/dashboard')).json();
    expect(d.users.total).toBeGreaterThan(0);
    expect(d).toHaveProperty('queue');
    expect((await a.put('/api/admin/company', { companyName: 'Sharma Exports Pvt Ltd', gstin: '09AAACS1234A1Z5', phone: '+91 562 000000' })).statusCode).toBe(200);
    const b = (await new Client(app).get('/api/public/branding')).json();
    expect(b).toMatchObject({ product: { tagline: 'Vayrone PostMaster by Vayrone Infratech' }, company: { name: 'Sharma Exports Pvt Ltd' } });
    expect((await a.put('/api/admin/company', { companyName: 'X', gstin: 'BAD' })).statusCode).toBe(400);
  });
});
