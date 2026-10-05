import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db as dbm, type CoreContext, type LicenseGate } from '@vpm/core';
import type { FastifyInstance } from 'fastify';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const { exec, one } = dbm;
const PW = 'Passw0rd#1';

describe.skipIf(!dbConfig())('external accounts admin API', () => {
  let maxExt: number | null = null;
  const gate: LicenseGate = { maxUsers: () => null, maxExternalAccounts: () => maxExt, feature: () => true, mode: () => 'active' };
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let a: Client;
  let userId: number;
  const domain = uniqueDomain();

  const body = (over: Record<string, unknown> = {}) => ({
    userId,
    protocol: 'imap',
    host: 'imap.hostinger.com',
    port: 993,
    security: 'tls',
    username: `ravi@${domain}`,
    password: 'Pr0vider-Secret',
    providerPreset: 'hostinger',
    ...over,
  });

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer(gate));
    await ctx.directory.createDomain(domain);
    await ctx.directory.createUser({ email: `boss@${domain}`, password: PW, role: 'super_admin' });
    userId = await ctx.directory.createUser({ email: `ravi@${domain}`, password: PW });
    a = new Client(app);
    await a.login(`boss@${domain}`, PW);
  });
  afterAll(() => close());

  it('creates an account; the provider password is encrypted and never returned', async () => {
    const r = await a.post('/api/admin/external-accounts', body());
    expect(r.statusCode).toBe(200);
    const id = r.json().id;
    const list = (await a.get(`/api/admin/external-accounts?userId=${userId}`)).json();
    expect(JSON.stringify(list)).not.toContain('Pr0vider-Secret');
    expect(list.items[0]).toMatchObject({ id, userLogin: `ravi@${domain}`, passwordSet: 1, status: 'idle', targetFolder: 'INBOX', leavePolicy: 'keep_days' });
    const raw = await one<{ secret: Buffer; next_run_at: Date | null }>(ctx.db, 'SELECT secret, next_run_at FROM external_accounts WHERE id = ?', [id]);
    expect(Buffer.from(raw!.secret).toString('latin1')).not.toContain('Pr0vider');
    expect(ctx.secrets.open(Buffer.from(raw!.secret))).toBe('Pr0vider-Secret');
    expect(raw!.next_run_at).not.toBeNull(); // scheduled immediately
  });

  it('validates the user, the password and the target folder', async () => {
    expect((await a.post('/api/admin/external-accounts', body({ password: undefined }))).statusCode).toBe(400);
    const staff = await ctx.directory.createStaffUser({ login: `aud-${domain}`, password: PW, displayName: 'A', role: 'auditor' });
    expect((await a.post('/api/admin/external-accounts', body({ userId: staff }))).statusCode).toBe(400);
    expect((await a.post('/api/admin/external-accounts', body({ targetFolder: 'No/Such' }))).statusCode).toBe(400);
    await ctx.store.createFolder(userId, 'From Provider');
    const r = await a.post('/api/admin/external-accounts', body({ targetFolder: 'From Provider', protocol: 'pop3', port: 995 }));
    expect((await a.get(`/api/admin/external-accounts/${r.json().id}`)).json().targetFolder).toBe('From Provider');
  });

  it('changing the password of a paused account re-arms it and clears the alert', async () => {
    const id = (await a.post('/api/admin/external-accounts', body())).json().id;
    await exec(ctx.db, "UPDATE external_accounts SET status = 'auth_failed', next_run_at = NULL, consecutive_fails = 3, last_error = 'bad' WHERE id = ?", [id]);
    await exec(ctx.db, "INSERT INTO admin_alerts (severity, code, message, dedupe_key, first_at, last_at) VALUES ('critical','fetch.auth','x',?,?,?)", [`ext.auth.${id}`, new Date(), new Date()]);
    await a.patch(`/api/admin/external-accounts/${id}`, { intervalSec: 60 }); // not a connection change
    expect((await one<{ status: string }>(ctx.db, 'SELECT status FROM external_accounts WHERE id = ?', [id]))!.status).toBe('auth_failed');
    await a.patch(`/api/admin/external-accounts/${id}`, { password: 'new-one' });
    const row = await one<{ status: string; next_run_at: Date | null; consecutive_fails: number; last_error: string | null }>(ctx.db, 'SELECT * FROM external_accounts WHERE id = ?', [id]);
    expect(row).toMatchObject({ status: 'idle', consecutive_fails: 0, last_error: null });
    expect(row!.next_run_at).not.toBeNull();
    expect((await one<{ resolved_at: Date | null }>(ctx.db, 'SELECT resolved_at FROM admin_alerts WHERE dedupe_key = ?', [`ext.auth.${id}`]))!.resolved_at).not.toBeNull();

    await a.patch(`/api/admin/external-accounts/${id}`, { isEnabled: false });
    expect((await one<{ status: string }>(ctx.db, 'SELECT status FROM external_accounts WHERE id = ?', [id]))!.status).toBe('disabled');
    expect((await a.post(`/api/admin/external-accounts/${id}/fetch-now`)).statusCode).toBe(400);
    await a.patch(`/api/admin/external-accounts/${id}`, { isEnabled: true });
    expect((await a.post(`/api/admin/external-accounts/${id}/fetch-now`)).json()).toMatchObject({ ok: true });
  });

  it('test connection reports unreachable servers without throwing', async () => {
    const r = await a.post('/api/admin/external-accounts/test', { protocol: 'pop3', host: '127.0.0.1', port: 1, security: 'none', username: 'x', password: 'y' });
    expect(r.json()).toMatchObject({ ok: false, kind: 'network' });
  });

  it('enforces the licensed number of external accounts', async () => {
    const used = (await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM external_accounts WHERE is_enabled = 1'))!.n;
    maxExt = Number(used);
    const r = await a.post('/api/admin/external-accounts', body());
    expect(r.json().error).toBe('LICENSE_LIMIT');
    expect((await a.post('/api/admin/external-accounts', body({ isEnabled: false }))).statusCode).toBe(200);
    maxExt = null;
  });

  it('serves provider presets', async () => {
    const p = (await a.get('/api/admin/external-accounts/presets')).json() as { key: string }[];
    expect(p.map((x) => x.key)).toEqual(expect.arrayContaining(['hostinger', 'godaddy', 'zoho_in', 'cpanel', 'custom']));
  });
});
