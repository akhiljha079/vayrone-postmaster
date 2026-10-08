// "Client servers": PostMaster's health reports reach the License Server and show on one screen.
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { db as coreDb, SecretBox, type Db as CoreDb, type HealthReport } from '@vpm/core';
import { fingerprintOf, LicenseManager } from '@vpm/license-client';
import type { LsContext } from '../src/context.js';
import { exec } from '../src/db.js';
import { serverState } from '../src/routes/servers.js';
import { addStaff, Client, KID, lsdb, makeLs, productFetch } from './helpers.js';

const health = (over: Partial<HealthReport> = {}): HealthReport => ({
  at: new Date().toISOString(),
  status: 'ok',
  issues: [],
  version: '0.6.6',
  uptimeHours: 50,
  diskFreePct: 62.5,
  diskFreeGb: 410,
  dbOk: true,
  mailboxes: 24,
  queue: { waiting: 0, oldestMinutes: null, failed24h: 0, sent24h: 312 },
  fetch: { accounts: 24, failing: 0, authFailed: 0 },
  backup: { lastOkAt: new Date(Date.now() - 6 * 3600_000).toISOString(), ageHours: 6, scheduled: true },
  certDaysLeft: 300,
  alerts: { critical: 0, warning: 0 },
  licenseMode: 'active',
  ...over,
});

describe.skipIf(!lsdb() || !inject('db'))('client servers overview', () => {
  let ctx: LsContext;
  let app: FastifyInstance;
  let publicKey: string;
  let close: () => Promise<void>;
  let owner: Client;
  let productDb: CoreDb;
  const secrets = new SecretBox(new Map([[1, randomBytes(32)]]), 1);
  const company = `Firozabad Glass Works ${Date.now()}`;
  let m: LicenseManager;

  const row = async () => ((await owner.get('/api/servers')).json().items as { company: string; state: string; health: HealthReport | null; hostname: string }[]).find((s) => s.company === company)!;

  beforeAll(async () => {
    ({ ctx, app, publicKey, close } = await makeLs());
    productDb = coreDb.createPool({ ...inject('db')!, connectionLimit: 5 });
    await addStaff(ctx, `owner-${Date.now()}@vayrone.com`, 'owner').then(async (id) => {
      owner = new Client(app);
      const login = (await ctx.db.query('SELECT email FROM staff_users WHERE id = ?', [id]))[0] as { email: string }[];
      expect((await owner.login(login[0]!.email)).statusCode).toBe(200);
    });
    const planId = (await owner.post('/api/plans', { code: `hb${Date.now() % 1e6}`, name: 'Business', features: ['archive'], maxExternalAccounts: null, slabs: [{ upTo: null, pricePerUser: 1000 }], termMonths: 12, amcPct: 0 })).json().id;
    const clientId = (await owner.post('/api/clients', { company, city: 'Firozabad', phone: '9876500011' })).json().id;
    const lic = (await owner.post('/api/licenses', { clientId, planId, maxUsers: 30 })).json();
    await coreDb.exec(productDb, 'DELETE FROM license_state');
    m = await LicenseManager.open(
      { db: productDb, secrets, config: { dataPath: mkdtempSync(join(tmpdir(), 'vls-h-')), installId: 'inst-h', hostname: 'mail.fgw.local' } },
      {
        keys: { [KID]: publicKey },
        serverUrl: 'https://license.test',
        fetch: productFetch(app),
        fingerprint: async () => fingerprintOf({ os: 'g-h', board: 'b-h', uuid: 'u-h', disk: 'd-h', cpu: 'c|4' }),
        integrity: async () => ({ status: 'ok', problems: [], checkedAt: new Date() }),
      },
    );
    await m.activateOnline(lic.licenseKey);
  });
  afterAll(async () => {
    await productDb.end();
    await close();
  });

  it('a server that only checked in (older version) shows "no health data"', async () => {
    expect((await row()).state).toBe('no_data');
  });

  it('the daily check-in carries health; the hourly report updates it; problems are listed first', async () => {
    expect((await m.heartbeat(health())).ok).toBe(true);
    expect(await row()).toMatchObject({ state: 'ok', hostname: 'mail.fgw.local', health: { mailboxes: 24, diskFreePct: 62.5 } });
    expect(m.healthReportDue()).toBe(false); // sent with the check-in: no separate report this hour

    const bad = health({ status: 'problem', issues: [{ level: 'problem', text: 'No successful backup yet' }, { level: 'warning', text: 'Disk getting full: 8% free' }] });
    expect(await m.reportHealth(bad)).toBe(true);
    const r = await row();
    expect(r.state).toBe('problem');
    expect(r.health!.issues.map((i) => i.text)).toEqual(['No successful backup yet', 'Disk getting full: 8% free']);
    const all = (await owner.get('/api/servers')).json();
    expect(all.items[0].state).toBe('problem'); // worst first
    expect(all.summary.problem).toBeGreaterThanOrEqual(1);
  });

  it('a server that stops reporting turns "not reporting"; only its own token may report', async () => {
    await exec(ctx.db, 'UPDATE activations a JOIN licenses l ON l.id = a.license_id JOIN clients c ON c.id = l.client_id SET a.health_at = ? WHERE c.company = ?', [new Date(Date.now() - 4 * 3600_000), company]);
    expect((await row()).state).toBe('silent');
    const forged = await app.inject({ method: 'POST', url: '/api/v1/health', payload: { licenseId: 'LIC-2026-000001', activationId: 'ACT-NOPE', token: 'x', health: health() } });
    expect(forged.statusCode).toBe(404);
    const junk = await app.inject({ method: 'POST', url: '/api/v1/health', payload: { licenseId: 'x', activationId: 'y', token: 'z', health: { status: 'ok' } } });
    expect(junk.statusCode).toBe(400);
  });

  it('state rules', () => {
    const now = Date.now();
    const h = health({ status: 'warning' });
    expect(serverState({ mode: 'offline', lastSeenAt: null, healthAt: null, health: null }, now)).toBe('offline');
    expect(serverState({ mode: 'online', lastSeenAt: new Date(now - 3600_000), healthAt: new Date(now - 3600_000), health: h }, now)).toBe('warning');
    expect(serverState({ mode: 'online', lastSeenAt: new Date(now - 30 * 3600_000), healthAt: null, health: null }, now)).toBe('silent');
  });
});
