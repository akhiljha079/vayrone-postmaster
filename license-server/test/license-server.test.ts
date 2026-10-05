import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inject } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { db as coreDb, SecretBox, type Db as CoreDb } from '@vpm/core';
import { decodeRequest, fingerprintOf, LicenseManager, normalizeLicenseKey, type Fingerprint, type RawComponents } from '@vpm/license-client';
import { exec, one, rows } from '../src/db.js';
import type { LsContext } from '../src/context.js';
import { runReminders } from '../src/services/reminders.js';
import { putSetting } from '../src/services/notify.js';
import { addStaff, Client, KID, lsdb, makeLs, productFetch, type SentMail } from './helpers.js';

const DAY = 86_400_000;
const RAW: RawComponents = { os: 'guid-agra-1', board: 'MB-1001', uuid: 'UUID-1001', disk: 'SSD-1001', cpu: 'Xeon|8' };
const machine = (over: Partial<RawComponents> = {}): Fingerprint => fingerprintOf({ ...RAW, ...over });

describe.skipIf(!lsdb() || !inject('db'))('Vayrone License Server', () => {
  let ctx: LsContext;
  let app: FastifyInstance;
  let publicKey: string;
  let mails: SentMail[];
  let whatsapp: { url: string; body: unknown }[];
  let close: () => Promise<void>;
  let owner: Client;
  let productDb: CoreDb;
  let planId: number;
  let perpetualPlanId: number;
  let resellerId: number;
  let clientId: number;
  const secrets = new SecretBox(new Map([[1, randomBytes(32)]]), 1);

  /** A PostMaster install talking to this License Server. */
  async function install(fp: Fingerprint = machine(), now?: () => Date): Promise<LicenseManager> {
    await coreDb.exec(productDb, 'DELETE FROM license_state');
    return LicenseManager.open(
      { db: productDb, secrets, config: { dataPath: mkdtempSync(join(tmpdir(), 'vls-prod-')), installId: 'inst-1', hostname: 'mail.agrasteel.local' } },
      { keys: { [KID]: publicKey }, serverUrl: 'https://license.test', fetch: productFetch(app), fingerprint: async () => fp, integrity: async () => ({ status: 'ok', problems: [], checkedAt: new Date() }), ...(now ? { now } : {}) },
    );
  }

  async function newLicense(body: Record<string, unknown> = {}, as: Client = owner) {
    const r = await as.post('/api/licenses', { clientId, planId, maxUsers: 25, amount: 30000, invoiceRef: 'INV-1', ...body });
    expect(r.statusCode, r.body).toBe(200);
    return r.json() as { id: number; licenseId: string; licenseKey: string };
  }

  beforeAll(async () => {
    ({ ctx, app, publicKey, mails, whatsapp, close } = await makeLs());
    productDb = coreDb.createPool({ ...inject('db')!, connectionLimit: 5 });
    await addStaff(ctx, 'owner@vayrone.com', 'owner');
    owner = new Client(app);
    expect((await owner.login('owner@vayrone.com')).statusCode).toBe(200);
    const slabs = [
      { upTo: 25, pricePerUser: 1200 },
      { upTo: null, pricePerUser: 950 },
    ];
    planId = (await owner.post('/api/plans', { code: 'business', name: 'Business', features: ['archive', 'support_access'], maxExternalAccounts: null, slabs, termMonths: 12, amcPct: 0 })).json().id;
    perpetualPlanId = (await owner.post('/api/plans', { code: 'perpetual', name: 'Perpetual', features: ['archive'], maxExternalAccounts: 50, minUsers: 10, slabs, termMonths: 0, amcPct: 20 })).json().id;
    resellerId = (await owner.post('/api/resellers', { name: 'Taj IT Solutions', email: 'sales@tajit.test', phone: '9876500000', discountPct: 15, quotaLicenses: 2, quotaUsers: 60 })).json().id;
    clientId = (await owner.post('/api/clients', { company: 'Agra Steel Traders', contactName: 'Ravi Gupta', email: 'ravi@agrasteel.test', phone: '9876543210', city: 'Agra', gstin: '09ABCDE1234F1Z5' })).json().id;
  });
  afterAll(async () => {
    await productDb.end();
    await close();
  });

  it('plans: slab quotes with partner discount', async () => {
    const q = (await owner.get(`/api/plans/${planId}/quote?users=40&years=1&resellerId=${resellerId}`)).json();
    expect(q).toMatchObject({ unitPrice: 950, base: 38000, discountPct: 15, net: 32300, gst: 5814, total: 38114 });
    expect((await owner.post('/api/plans', { code: 'bad', name: 'Bad', features: [], maxExternalAccounts: null, slabs: [{ upTo: 10, pricePerUser: 1 }], termMonths: 12, amcPct: 0 })).statusCode).toBe(400);
  });

  it('generates keys; the product activates online and receives a signed licence', async () => {
    const lic = await newLicense();
    expect(lic.licenseId).toMatch(/^LIC-\d{4}-\d{6}$/);
    expect(normalizeLicenseKey(lic.licenseKey)).toBe(lic.licenseKey);
    const m = await install();
    await expect(m.activateOnline('VPM-00000-00000-00000-00000-0')).rejects.toMatchObject({ code: expect.stringMatching(/INVALID_KEY/) });
    await m.activateOnline(lic.licenseKey);
    expect(m.mode()).toBe('active');
    expect(m.maxUsers()).toBe(25);
    expect(m.feature('support_access')).toBe(true);
    const info = await m.info();
    expect(info.license).toMatchObject({ licenseId: lic.licenseId, client: { name: 'Agra Steel Traders', gstin: '09ABCDE1234F1Z5' }, plan: { code: 'business' }, activationMode: 'online' });
    const detail = (await owner.get(`/api/licenses/${lic.id}`)).json();
    expect(detail.activations).toEqual([expect.objectContaining({ status: 'active', mode: 'online', hostname: 'mail.agrasteel.local', machineId: machine().machineId })]);
    expect(detail.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(['license_create', 'activate']));
    expect(detail.renewals).toEqual([expect.objectContaining({ kind: 'new', amount: 30000, invoiceRef: 'INV-1' })]);
  });

  it('one machine per licence: a second server is refused; reinstalling on the same server (one part changed) is fine', async () => {
    const lic = await newLicense();
    const first = await install();
    await first.activateOnline(lic.licenseKey);
    const firstAct = (await first.info()).license!.licensedMachineId;
    const other = await install(machine({ os: 'x', board: 'y', uuid: 'z' }));
    await expect(other.activateOnline(lic.licenseKey)).rejects.toMatchObject({ code: 'ALREADY_ACTIVATED', message: expect.stringContaining('mail.agrasteel.local') });
    const reinstalled = await install(machine({ disk: 'NEW-SSD' }));
    await reinstalled.activateOnline(lic.licenseKey);
    expect(reinstalled.mode()).toBe('active');
    const acts = (await owner.get(`/api/licenses/${lic.id}`)).json().activations;
    expect(acts).toHaveLength(1);
    expect(acts[0].machineId).not.toBe(firstAct);
  });

  it('heartbeat reports usage and delivers upgrades; suspension arrives as a signed notice', async () => {
    const lic = await newLicense();
    const m = await install();
    await m.activateOnline(lic.licenseKey);
    expect((await owner.patch(`/api/licenses/${lic.id}`, { maxUsers: 50, features: ['archive', 'support_access', 'backup_cloud'], amount: 20000, invoiceRef: 'INV-UP' })).statusCode).toBe(200);
    expect(await m.heartbeat()).toEqual({ ok: true });
    expect(m.maxUsers()).toBe(50);
    expect(m.feature('backup_cloud')).toBe(true);
    const usage = (await owner.get(`/api/licenses/${lic.id}`)).json().usage;
    expect(usage[0]).toMatchObject({ activeUsers: expect.any(Number), version: expect.any(String) });

    expect((await owner.post(`/api/licenses/${lic.id}/status`, { status: 'suspended' })).statusCode).toBe(400); // reason required
    await owner.post(`/api/licenses/${lic.id}/status`, { status: 'suspended', reason: 'Invoice INV-UP unpaid' });
    expect(await m.heartbeat()).toEqual({ ok: true });
    expect(m.evaluation()).toMatchObject({ mode: 'grace' });
    expect(m.evaluation().reason).toContain('Invoice INV-UP unpaid');
    await owner.post(`/api/licenses/${lic.id}/status`, { status: 'active' });
    expect(await m.heartbeat()).toEqual({ ok: true });
    expect(m.mode()).toBe('active');
  });

  it('machine transfer by Vayrone, or deactivation on the old server, frees the slot', async () => {
    const lic = await newLicense();
    const oldServer = await install();
    await oldServer.activateOnline(lic.licenseKey);
    const act = (await owner.get(`/api/licenses/${lic.id}`)).json().activations[0];
    expect((await owner.post(`/api/activations/${act.id}/release`, { reason: 'Moved to new Dell server' })).statusCode).toBe(200);
    expect(await oldServer.heartbeat()).toEqual({ ok: true });
    expect(oldServer.evaluation().reason).toMatch(/transferred to another server/);
    const newServer = await install(machine({ os: 'n1', board: 'n2', uuid: 'n3' }));
    await newServer.activateOnline(lic.licenseKey);
    expect(newServer.mode()).toBe('active');

    await newServer.deactivate();
    expect(newServer.mode()).toBe('grace');
    const third = await install(machine({ os: 't1', board: 't2', uuid: 't3' }));
    await third.activateOnline(lic.licenseKey);
    expect(third.mode()).toBe('active');
    const kinds = (await rows<{ kind: string }>(ctx.db, 'SELECT kind FROM events WHERE license_id = ? ORDER BY id', [lic.id])).map((e) => e.kind);
    expect(kinds).toEqual(expect.arrayContaining(['transfer', 'deactivate']));
  });

  it('offline: request file → inspect → issue (admin or public portal) → import; re-validation needs the activated machine', async () => {
    const lic = await newLicense();
    const m = await install();
    const req = await m.offlineRequest(lic.licenseKey);
    const inspect = (await owner.post('/api/offline/inspect', { request: req.text })).json();
    expect(inspect).toMatchObject({ request: { kind: 'activation', machineId: machine().machineId, hostname: 'mail.agrasteel.local' }, license: { licenseId: lic.licenseId }, sameMachine: false });
    const issued = (await owner.post('/api/offline/issue', { request: req.text })).json();
    expect(issued.fileName).toMatch(new RegExp(`^${lic.licenseId}-.*\\.vlic$`));
    await m.importFile(issued.license);
    expect(m.mode()).toBe('active');
    expect((await m.info()).license?.activationMode).toBe('offline');
    const checkBy = new Date((await m.info()).license!.checkBy).getTime();
    expect(checkBy - Date.now()).toBeGreaterThan(85 * DAY);

    // Re-validation through the public portal (no login), before the 90 days run out.
    const again = await m.offlineRequest();
    expect(decodeRequest(again.text)).toMatchObject({ key: null, licenseId: lic.licenseId });
    const portal = await app.inject({ method: 'POST', url: '/api/v1/offline', payload: { request: again.text } });
    expect(portal.statusCode).toBe(200);
    await m.importFile(portal.json().license);
    expect(m.mode()).toBe('active');

    const elsewhere = await install(machine({ os: 'e1', board: 'e2', uuid: 'e3' }));
    const foreign = decodeRequest(again.text);
    const forged = (await elsewhere.offlineRequest(lic.licenseKey)).text;
    const r = await app.inject({ method: 'POST', url: '/api/v1/offline', payload: { request: forged } });
    expect(r.json()).toMatchObject({ error: 'ALREADY_ACTIVATED' });
    expect(foreign.licenseId).toBe(lic.licenseId);
  });

  it('renewals extend from the current end date; perpetual licences renew AMC only', async () => {
    const lic = await newLicense();
    const before = (await owner.get(`/api/licenses/${lic.id}`)).json();
    const r = (await owner.post(`/api/licenses/${lic.id}/renew`, { kind: 'renewal', months: 12, amount: 28000, invoiceRef: 'INV-R1' })).json();
    expect(new Date(r.expiresAt).getTime() - new Date(before.expiresAt).getTime()).toBeGreaterThan(360 * DAY);
    const after = (await owner.get(`/api/licenses/${lic.id}`)).json();
    expect(after.amcExpiresAt).toBe(after.expiresAt); // subscriptions include AMC
    expect(after.renewals[0]).toMatchObject({ kind: 'renewal', amount: 28000 });

    const p = (await owner.post('/api/licenses', { clientId, planId: perpetualPlanId, maxUsers: 12 })).json();
    expect((await owner.get(`/api/licenses/${p.id}`)).json()).toMatchObject({ expiresAt: null, maxExternalAccounts: 50 });
    expect((await owner.post(`/api/licenses/${p.id}/renew`, { kind: 'renewal', months: 12 })).statusCode).toBe(400);
    expect((await owner.post(`/api/licenses/${p.id}/renew`, { kind: 'amc', months: 12, amount: 4560 })).statusCode).toBe(200);
  });

  it('partners: own clients and licences only, within their quota, plan defaults only', async () => {
    await addStaff(ctx, 'partner@tajit.test', 'reseller', resellerId);
    const p = new Client(app);
    expect((await p.login('partner@tajit.test')).statusCode).toBe(200);
    expect((await p.get('/api/auth/me')).json().reseller).toMatchObject({ name: 'Taj IT Solutions', quotaUsers: 60 });
    const c = (await p.post('/api/clients', { company: 'Mathura Textiles', email: 'it@mathuratex.test', resellerId: 999 })).json().id;
    expect((await owner.get(`/api/clients/${c}`)).json().resellerId).toBe(resellerId);
    expect((await p.get(`/api/clients/${clientId}`)).statusCode).toBe(404);
    expect((await p.get('/api/licenses')).json().items).toHaveLength(0);

    expect((await p.post('/api/licenses', { clientId, planId, maxUsers: 10 })).statusCode).toBe(400); // not their client
    expect((await p.post('/api/licenses', { clientId: c, planId, maxUsers: 10, maxActivations: 3 })).statusCode).toBe(403);
    const l1 = (await p.post('/api/licenses', { clientId: c, planId, maxUsers: 40 })).json();
    expect(l1.licenseKey).toBeTruthy();
    const over = await p.post('/api/licenses', { clientId: c, planId, maxUsers: 30 });
    expect(over.json()).toMatchObject({ error: 'QUOTA', message: expect.stringContaining('60 users') });
    await p.post('/api/licenses', { clientId: c, planId, maxUsers: 20 });
    expect((await p.post('/api/licenses', { clientId: c, planId, maxUsers: 1 })).json().message).toMatch(/2 licences/);
    expect((await p.patch(`/api/licenses/${l1.id}`, { maxUsers: 45 })).json().error).toBe('QUOTA');
    expect((await p.patch(`/api/licenses/${l1.id}`, { features: ['antivirus'] })).statusCode).toBe(403);
    expect((await p.post(`/api/licenses/${l1.id}/status`, { status: 'revoked', reason: 'x' })).statusCode).toBe(403);
    expect((await p.get('/api/settings')).statusCode).toBe(403);
    expect((await p.get('/api/resellers')).statusCode).toBe(403);
    const lic = (await owner.get(`/api/licenses?resellerId=${resellerId}`)).json();
    expect(lic.items).toHaveLength(2);
    expect((await p.get('/api/reports/summary')).json().revenue).toEqual([]);
  });

  it('expiry and AMC reminders go out once by email and WhatsApp, with the partner in copy', async () => {
    await putSetting(ctx.db, 'whatsapp', { provider: 'meta', meta: { phoneNumberId: '1234', token: ctx.vault.seal('EAAB-token'), language: 'en', templates: { expiry: 'licence_expiry', amc: 'amc_expiry' } } });
    await putSetting(ctx.db, 'notifications', { salesEmail: 'sales@vayrone.com', expiryDays: [7], amcDays: [], supportPhone: '0562-4000000' });
    const c = (await owner.post('/api/clients', { company: 'Firozabad Glass Works', contactName: 'Meena', email: 'meena@fgw.test', whatsapp: '98765 11111', resellerId })).json().id;
    const lic = await newLicense({ clientId: c, startsAt: new Date(Date.now() - 365 * DAY + 7 * DAY).toISOString() });
    mails.length = 0;
    whatsapp.length = 0;
    const r = await runReminders(ctx.db, ctx.notifier, { tz: 'Asia/Kolkata' });
    expect(r.sent).toBeGreaterThanOrEqual(2);
    const mail = mails.find((m) => m.to === 'meena@fgw.test')!;
    expect(mail).toMatchObject({ cc: 'sales@tajit.test', subject: expect.stringContaining('expires on') });
    expect(mail.text).toMatch(/Dear Meena,[\s\S]*in 7 day\(s\)[\s\S]*contact Taj IT Solutions \(9876500000\)/);
    const wa = whatsapp.find((w) => (w.body as { to: string }).to === '919876511111')!;
    expect(wa.url).toBe('https://graph.facebook.com/v21.0/1234/messages');
    expect(wa.body).toMatchObject({ type: 'template', template: { name: 'licence_expiry', language: { code: 'en' } } });
    expect(mails.find((m) => m.to === 'sales@vayrone.com')?.text).toContain(lic.licenseId);
    const again = await runReminders(ctx.db, ctx.notifier, { tz: 'Asia/Kolkata' });
    expect(again.sent).toBe(0);
    expect(await rows(ctx.db, 'SELECT channel, status FROM reminders WHERE license_id = ?', [lic.id])).toHaveLength(2);
  });

  it('reports: seats sold vs used, upsell candidates, CSV safe for Excel', async () => {
    const s = (await owner.get('/api/reports/summary')).json();
    expect(s.licenses.active).toBeGreaterThan(3);
    expect(s.seats.sold).toBeGreaterThan(s.seats.used);
    expect(s.revenue.length).toBeGreaterThan(0);
    expect(s.byReseller.map((r: { reseller: string }) => r.reseller)).toEqual(expect.arrayContaining(['Taj IT Solutions', 'Direct (Vayrone)']));
    await owner.post('/api/clients', { company: '=HYPERLINK("http://evil")' });
    const cid = (await one<{ id: number }>(ctx.db, "SELECT id FROM clients WHERE company LIKE '=HYPERLINK%'"))!.id;
    await newLicense({ clientId: cid });
    const csv = await owner.get('/api/reports/licenses.csv');
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.body).toContain(`"'=HYPERLINK(""http://evil"")"`);
  });

  it('admin security: CSRF, lockout, write-only credentials, public key for the product', async () => {
    expect((await owner.req('POST', '/api/clients', { company: 'No CSRF' }, { csrf: false })).statusCode).toBe(403);
    await addStaff(ctx, 'staff@vayrone.com', 'staff');
    const s = new Client(app);
    for (let i = 0; i < 5; i++) expect((await s.login('staff@vayrone.com', 'wrong-password')).statusCode).toBe(401);
    expect((await s.login('staff@vayrone.com')).statusCode).toBe(429);
    await exec(ctx.db, "UPDATE staff_users SET locked_until = NULL WHERE email = 'staff@vayrone.com'");
    expect((await s.login('staff@vayrone.com')).statusCode).toBe(200);
    expect((await s.post('/api/plans', {})).statusCode).toBe(403);

    expect((await owner.put('/api/settings/smtp', { host: 'smtp.zoho.in', port: 465, secure: true, user: 'licensing@vayrone.com', password: 'SmtpSecret!', from: 'Vayrone <licensing@vayrone.com>' })).statusCode).toBe(200);
    const st = (await owner.get('/api/settings')).json();
    expect(st.smtp).toMatchObject({ host: 'smtp.zoho.in', password: null, passwordSet: true });
    expect(JSON.stringify(st)).not.toContain('SmtpSecret');
    expect(JSON.stringify(st)).not.toContain('EAAB-token');
    expect(st.signing).toEqual({ kid: KID, publicKey });
    const raw = (await one<{ value: string }>(ctx.db, "SELECT CAST(value AS CHAR) value FROM settings WHERE name = 'smtp'"))!.value;
    expect(raw).not.toContain('SmtpSecret');
    // The private key is never part of any response.
    expect(JSON.stringify(st)).not.toContain('PRIVATE KEY');
  });

  it('the product API validates input and rate-limits activation attempts', async () => {
    const bad = await app.inject({ method: 'POST', url: '/api/v1/activate', payload: { key: 'x' }, remoteAddress: '192.0.2.50' });
    expect(bad.json()).toMatchObject({ error: 'BAD_REQUEST' });
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await app.inject({ method: 'POST', url: '/api/v1/activate', payload: { key: 'x' }, remoteAddress: '192.0.2.51' })).statusCode;
    expect(last).toBe(429);
    const hb = await app.inject({ method: 'POST', url: '/api/v1/heartbeat', payload: { licenseId: 'LIC-X', activationId: 'ACT-X', token: 't', machine: { id: 'AAAAA', components: { os: null, board: null, uuid: null, disk: null, cpu: null } }, product: { version: '1', installId: 'i', hostname: 'h' }, usage: { activeUsers: 1, externalAccounts: 0 } } });
    expect(hb.json()).toMatchObject({ error: 'ACTIVATION_NOT_FOUND' });
  });
});
