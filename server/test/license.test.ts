import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { db as dbm, type CoreContext } from '@vpm/core';
import { LicenseManager } from '@vpm/license-client';
import { FP, fakeFetch, KEYS, payload, sign } from '../../license-client/test/helpers.js';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const DAY = 86_400_000;
const PW = 'Passw0rd#1';

describe.skipIf(!dbConfig())('licence page and enforcement in the admin panel', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let manager: LicenseManager;
  const clock = { now: new Date() };
  const domain = uniqueDomain();
  let boss: Client;
  let deputy: Client;
  const licensed = sign(payload({ maxUsers: 100_000 }));

  beforeAll(async () => {
    const pool = dbm.createPool({ ...dbConfig()!, connectionLimit: 2 });
    await dbm.exec(pool, 'DELETE FROM license_state');
    await pool.end();
    ({ ctx, app, close } = await makeServer(async (d) => {
      manager = await LicenseManager.open(d, {
        keys: KEYS,
        now: () => clock.now,
        fingerprint: async () => FP,
        integrity: async () => ({ status: 'ok', problems: [], checkedAt: new Date() }),
        fetch: fakeFetch((path) => (path === '/api/v1/activate' ? { body: { license: licensed, token: 'tok' } } : { status: 404, body: { error: 'INVALID_KEY', message: 'This licence key does not exist.' } })),
      });
      return manager;
    }));
    await ctx.directory.createStaffUser({ login: `boss-${domain}`, password: PW, displayName: 'Boss', role: 'super_admin' });
    await ctx.directory.createStaffUser({ login: `deputy-${domain}`, password: PW, displayName: 'Deputy', role: 'admin' });
    boss = new Client(app);
    await boss.login(`boss-${domain}`, PW);
    deputy = new Client(app);
    await deputy.login(`deputy-${domain}`, PW);
  });
  afterAll(() => close());

  it('shows the evaluation state with a banner for admins only', async () => {
    const info = (await boss.get('/api/admin/license')).json();
    expect(info).toMatchObject({ managed: true, mode: expect.stringMatching(/unlicensed|readonly/), machine: { id: FP.machineId } });
    expect((await boss.get('/api/auth/me')).json().license).toMatchObject({ level: expect.any(String), message: expect.any(String) });
  });

  it('only super admins activate; activation is audited and lifts the limits immediately', async () => {
    expect((await deputy.post('/api/admin/license/activate', { key: 'VPM-AAAAA-BBBBB-CCCCC-DDDDD-E' })).statusCode).toBe(403);
    const bad = await boss.post('/api/admin/license/activate', { key: 'VPM-AAAAA-BBBBB-CCCCC-DDDDD-E' });
    expect(bad.json()).toMatchObject({ error: 'INVALID_KEY' });
    const { generateLicenseKey } = await import('@vpm/license-client');
    const ok = await boss.post('/api/admin/license/activate', { key: generateLicenseKey() });
    expect(ok.statusCode, ok.body).toBe(200);
    expect(ok.json()).toMatchObject({ status: 'active', license: { maxUsers: 100_000 } });
    expect(ctx.license.maxUsers()).toBe(100_000);
    expect((await boss.get('/api/auth/me')).json().license).toEqual({ mode: 'active', level: null, message: null });
    const audit = await dbm.rows<{ action: string }>(ctx.db, "SELECT action FROM audit_log WHERE action LIKE 'license.%' ORDER BY id");
    expect(audit.map((a) => a.action)).toEqual(['license.activate_failed', 'license.activate']);
    expect((await deputy.get('/api/admin/license')).statusCode).toBe(200);
  });

  it('after the grace period: admin panel read-only, new webmail logins blocked, the licence page still works', async () => {
    await ctx.directory.createDomain(domain);
    await ctx.directory.createUser({ email: `alice@${domain}`, password: PW });
    clock.now = new Date(Date.now() + 46 * DAY); // checkBy (30 days) + 15 days grace passed
    await manager.refresh();
    expect(ctx.license.mode()).toBe('readonly');
    const me = (await boss.get('/api/auth/me')).json().license;
    expect(me).toMatchObject({ mode: 'readonly', level: 'critical', message: expect.stringContaining('Mail keeps flowing') });

    const write = await boss.post('/api/admin/domains', { name: `x-${domain}` });
    expect(write.json()).toMatchObject({ error: 'LICENSE_READONLY' });
    expect((await boss.get('/api/admin/domains')).statusCode).toBe(200);
    const alice = new Client(app);
    expect((await alice.login(`alice@${domain}`, PW)).json()).toMatchObject({ error: 'LICENSE_READONLY' });

    // Renewal by file works while read-only (signed "now" by the License Server).
    const req = (await boss.post('/api/admin/license/offline-request', {})).json();
    expect(req.text).toContain('BEGIN VAYRONE POSTMASTER ACTIVATION REQUEST');
    const renewed = sign(payload({ maxUsers: 100_000, checkBy: new Date(clock.now.getTime() + 90 * DAY).toISOString(), activation: { id: 'ACT-2', mode: 'offline', machineId: FP.machineId, components: FP.components } }, clock.now));
    const imp = await boss.post('/api/admin/license/import', { text: renewed });
    expect(imp.statusCode, imp.body).toBe(200);
    expect(ctx.license.mode()).toBe('active');
    expect((await boss.post('/api/admin/domains', { name: `x-${domain}` })).statusCode).toBe(200);
    expect((await alice.login(`alice@${domain}`, PW)).statusCode).toBe(200);
  });

  it('rejects files that are not a licence for this server', async () => {
    expect((await boss.post('/api/admin/license/import', { text: 'x'.repeat(60) })).json()).toMatchObject({ error: 'WRONG_TYPE' });
    const transfer = await boss.post('/api/admin/license/deactivate', { confirm: 'TRANSFER' });
    expect(transfer.json()).toMatchObject({ error: 'OFFLINE' });
    expect((await boss.post('/api/admin/license/deactivate', {})).statusCode).toBe(400);
  });
});
