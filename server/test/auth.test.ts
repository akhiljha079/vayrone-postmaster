import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generate } from 'otplib';
import { db as dbm, type CoreContext, type LicenseGate } from '@vpm/core';
import type { FastifyInstance } from 'fastify';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const { exec, one } = dbm;
const PW = 'Passw0rd#1';

describe.skipIf(!dbConfig())('unified login, roles, sessions, 2FA', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  const domain = uniqueDomain();
  const admin = `admin@${domain}`;
  const user = `ravi@${domain}`;
  const auditor = `audit-${domain}`;

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    await ctx.directory.createDomain(domain);
    await ctx.directory.createUser({ email: admin, password: PW, displayName: 'Admin', role: 'super_admin' });
    await ctx.directory.createUser({ email: user, password: PW, displayName: 'Ravi' });
    await ctx.directory.createStaffUser({ login: auditor, password: PW, displayName: 'Auditor', role: 'auditor' });
  });
  afterAll(() => close());

  it('one login page for every role; routes by role', async () => {
    const u = new Client(app);
    expect((await u.login(user, 'wrong')).statusCode).toBe(401);
    const r = await u.login(user, PW);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ mfaRequired: false, mode: 'mail' });
    expect(u.cookies.has('vpm_sid')).toBe(true);
    const me = (await u.get('/api/auth/me')).json();
    expect(me).toMatchObject({ user: { login: user, role: 'user' }, canUseAdmin: false, canUseMail: true });
    expect((await u.get('/api/admin/users')).statusCode).toBe(403);
    expect((await u.post('/api/auth/mode', { mode: 'admin' })).statusCode).toBe(403);

    const a = new Client(app);
    await a.login(admin, PW);
    expect((await a.get('/api/auth/me')).json()).toMatchObject({ canUseAdmin: true, canUseMail: true, mode: 'mail' });
    expect((await a.post('/api/auth/mode', { mode: 'admin' })).json()).toEqual({ mode: 'admin' });
    expect((await a.get('/api/auth/me')).json().mode).toBe('admin');

    const au = new Client(app);
    expect((await au.login(auditor, PW)).json().mode).toBe('admin'); // staff account without mailbox
    expect((await au.get('/api/admin/audit')).statusCode).toBe(200);
    expect((await au.get('/api/admin/users')).statusCode).toBe(403);
    expect((await au.post('/api/auth/mode', { mode: 'mail' })).statusCode).toBe(403);
  });

  it('rejects state-changing calls without the CSRF header', async () => {
    const a = new Client(app);
    await a.login(admin, PW);
    const r = await a.req('POST', '/api/auth/mode', { mode: 'admin' }, { csrf: false });
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('CSRF');
  });

  it('locks an account after repeated failures (all protocols) and admin can unlock', async () => {
    await ctx.settings.set('security', 'policy', { lockoutThreshold: 3 });
    const victim = `lock@${domain}`;
    const id = await ctx.directory.createUser({ email: victim, password: PW });
    const c = new Client(app);
    for (let i = 0; i < 3; i++) await c.login(victim, 'nope');
    const r = await c.login(victim, PW);
    expect(r.statusCode).toBe(401);
    expect(r.json().message).toMatch(/locked/i);
    expect(await ctx.directory.authenticate(victim, PW, 'imap', '192.168.1.9')).toBeNull();

    const a = new Client(app);
    await a.login(admin, PW);
    expect((await a.patch(`/api/admin/users/${id}`, { unlock: true })).statusCode).toBe(200);
    expect((await c.login(victim, PW)).statusCode).toBe(200);
    await ctx.settings.set('security', 'policy', {});
  });

  it('TOTP enrolment, MFA challenge, recovery codes', async () => {
    const totpUser = `totp@${domain}`;
    await ctx.directory.createUser({ email: totpUser, password: PW });
    const c = new Client(app);
    await c.login(totpUser, PW);
    const setup = (await c.post('/api/auth/totp/setup')).json();
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/Vayrone%20PostMaster/);
    expect(setup.qr).toMatch(/^data:image\/png;base64,/);
    expect((await c.post('/api/auth/totp/enable', { code: '000000' })).statusCode).toBe(400);
    const en = (await c.post('/api/auth/totp/enable', { code: await generate({ secret: setup.secret }) })).json();
    expect(en.recoveryCodes).toHaveLength(10);
    const stored = await one<{ totp_secret: Buffer }>(ctx.db, 'SELECT totp_secret FROM users WHERE login = ?', [totpUser]);
    expect(Buffer.from(stored!.totp_secret).toString('latin1')).not.toContain(setup.secret); // encrypted at rest

    const r = await c.login(totpUser, PW);
    expect(r.json().mfaRequired).toBe(true);
    expect((await c.get('/api/auth/sessions')).json().error).toBe('MFA_REQUIRED');
    expect((await c.post('/api/auth/mfa', { code: '123456' })).statusCode).toBe(401);
    expect((await c.post('/api/auth/mfa', { code: await generate({ secret: setup.secret }) })).json()).toEqual({ ok: true });
    expect((await c.get('/api/auth/sessions')).statusCode).toBe(200);

    await c.login(totpUser, PW);
    expect((await c.post('/api/auth/mfa', { code: en.recoveryCodes[0] })).statusCode).toBe(200);
    await c.login(totpUser, PW);
    expect((await c.post('/api/auth/mfa', { code: en.recoveryCodes[0] })).statusCode).toBe(401); // single use
  });

  it('lists sessions, revokes a remote session, and a password change logs out other sessions', async () => {
    const pc = new Client(app);
    const phone = new Client(app);
    phone.ip = '192.168.1.77';
    await pc.login(user, PW);
    await phone.login(user, PW);
    const list = (await pc.get('/api/auth/sessions')).json() as { handle: string; ip: string; current: boolean }[];
    const remote = list.find((s) => s.ip === '192.168.1.77' && !s.current)!;
    expect(remote).toBeTruthy();
    expect((await pc.del(`/api/auth/sessions/${remote.handle}`)).statusCode).toBe(200);
    expect((await phone.get('/api/auth/me')).statusCode).toBe(401);

    await phone.login(user, PW);
    expect((await pc.post('/api/auth/password', { current: PW, next: 'NewPassw0rd' })).json().otherSessionsRevoked).toBeGreaterThanOrEqual(1);
    expect((await phone.get('/api/auth/me')).statusCode).toBe(401);
    expect((await pc.get('/api/auth/me')).statusCode).toBe(200);
    expect(await ctx.directory.authenticate(user, 'NewPassw0rd', 'imap', '10.0.0.1')).toBeTruthy();
  });

  it('IP allowlist: refuses self-lockout, then restricts admin and IMAP by network', async () => {
    const a = new Client(app);
    a.ip = '192.168.1.10';
    await a.login(admin, PW);
    const bad = await a.post('/api/admin/security/ip-allowlist', { cidr: '10.0.0.0/8', appliesTo: ['admin', 'imap'] });
    expect(bad.json().error).toBe('SELF_LOCKOUT');
    const ok = await a.post('/api/admin/security/ip-allowlist', { cidr: '192.168.1.0/24', appliesTo: ['admin', 'imap'] });
    expect(ok.statusCode).toBe(200);
    expect((await a.get('/api/admin/users')).statusCode).toBe(200);

    const outside = new Client(app);
    outside.ip = '172.16.5.5';
    await outside.login(admin, PW);
    expect((await outside.get('/api/admin/users')).json().error).toBe('IP_DENIED');
    expect(await ctx.directory.authenticate(admin, PW, 'imap', '172.16.5.5')).toBeNull();
    expect(await ctx.directory.authenticate(admin, PW, 'imap', '192.168.1.99')).toBeTruthy();
    expect(await ctx.directory.authenticate(admin, PW, 'imap', '::ffff:127.0.0.1')).toBeTruthy(); // loopback always allowed

    await a.del(`/api/admin/security/ip-allowlist/${ok.json().id}`);
  });

  it('Vayrone Support login only when enabled by the site, and its actions are flagged in the audit log', async () => {
    await ctx.directory.createStaffUser({ login: `support-${domain}`, password: PW, displayName: 'Vayrone Support', role: 'vayrone_support' });
    const s = new Client(app);
    expect((await s.login(`support-${domain}`, PW)).json().message).toMatch(/not enabled/);
    const a = new Client(app);
    await a.login(admin, PW);
    await a.put('/api/admin/security/policy', { supportAccessEnabled: true });
    ctx.settings.invalidate();
    expect((await s.login(`support-${domain}`, PW)).statusCode).toBe(200);
    expect((await s.post('/api/admin/domains', { name: `sup-${domain}` })).statusCode).toBe(200);
    const row = await one<{ is_support: number }>(ctx.db, "SELECT is_support FROM audit_log WHERE action = 'domain.create' ORDER BY id DESC LIMIT 1");
    expect(row!.is_support).toBe(1);
    const hidden = (await a.get('/api/admin/users?role=vayrone_support')).json();
    expect(hidden.total).toBe(1); // super admin sees it
    await a.put('/api/admin/security/policy', { supportAccessEnabled: false });
  });
});

describe.skipIf(!dbConfig())('licence enforcement hooks', () => {
  let mode: 'active' | 'readonly' = 'active';
  const gate: LicenseGate = { maxUsers: () => 2, maxExternalAccounts: () => null, feature: () => true, mode: () => mode };
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  const domain = uniqueDomain();

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer(gate));
    await exec(ctx.db, "UPDATE users SET is_enabled = 0 WHERE role <> 'vayrone_support'"); // isolate seat count
    await ctx.directory.createDomain(domain);
    await ctx.directory.createUser({ email: `boss@${domain}`, password: PW, role: 'super_admin' });
  });
  afterAll(async () => {
    await exec(ctx.db, 'UPDATE users SET is_enabled = 1');
    await close();
  });

  it('blocks creating or enabling users beyond the licensed count', async () => {
    const a = new Client(app);
    await a.login(`boss@${domain}`, PW);
    expect((await a.post('/api/admin/users', { email: `one@${domain}`, displayName: 'One', password: PW })).statusCode).toBe(200);
    const over = await a.post('/api/admin/users', { email: `two@${domain}`, displayName: 'Two', password: PW });
    expect(over.statusCode).toBe(403);
    expect(over.json().error).toBe('LICENSE_LIMIT');
    const disabled = await a.post('/api/admin/users', { email: `three@${domain}`, displayName: 'Three', password: PW, isEnabled: false });
    expect(disabled.statusCode).toBe(200);
    expect((await a.patch(`/api/admin/users/${disabled.json().id}`, { isEnabled: true })).json().error).toBe('LICENSE_LIMIT');
    const list = (await a.get('/api/admin/users')).json();
    expect(list.licensed).toEqual({ used: 2, max: 2 });
  });

  it('read-only licence: admin panel read-only, user web login blocked, mail login still works', async () => {
    mode = 'readonly';
    const a = new Client(app);
    await a.login(`boss@${domain}`, PW);
    expect((await a.get('/api/admin/users')).statusCode).toBe(200);
    expect((await a.post('/api/admin/domains', { name: `x-${domain}` })).json().error).toBe('LICENSE_READONLY');
    const u = new Client(app);
    expect((await u.login(`one@${domain}`, PW)).json().error).toBe('LICENSE_READONLY');
    expect(await ctx.directory.authenticate(`one@${domain}`, PW, 'imap', '192.168.1.2')).toBeTruthy();
    mode = 'active';
  });
});
