import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import { buildConfig, createContext, db as dbm, LicenseLimitError, SecretBox, type CoreContext, type Db } from '@vpm/core';
import { dbConfig } from '../../core/test/helpers.js';
import { checkIntegrity, decodeRequest, INTEGRITY_FORMAT, LicenseManager, signDoc, type Fingerprint, type IntegrityPayload, type LicenseManagerOptions } from '../src/index.js';
import { FP, fakeFetch, fpWith, KEY, KEYS, KID, payload, revocation, sign, type Handler } from './helpers.js';

const { exec, one, rows } = dbm;
const DAY = 86_400_000;

describe.skipIf(!dbConfig())('LicenseManager', () => {
  let db: Db;
  const secrets = new SecretBox(new Map([[1, randomBytes(32)]]), 1);
  const config = { dataPath: mkdtempSync(join(tmpdir(), 'vpm-lic-')), installId: 'lic-test', hostname: 'mail.agrasteel.local' };
  let server: Handler;
  const calls: { path: string; body: Record<string, unknown> }[] = [];

  const open = (o: LicenseManagerOptions & { fp?: Fingerprint } = {}) =>
    LicenseManager.open({ db, secrets, config }, { keys: KEYS, serverUrl: 'https://ls.test', fingerprint: async () => o.fp ?? FP, integrity: async () => ({ status: 'ok', problems: [], checkedAt: new Date() }), fetch: fakeFetch((p, b) => server(p, b), calls), ...o });

  /** A License Server that activates LIC-TEST-0001 and refreshes it on heartbeat. */
  const goodServer = (over: Parameters<typeof payload>[0] = {}): Handler => (path, body) => {
    if (path === '/api/v1/activate') return { body: { license: sign(payload(over)), token: 'tok-1' } };
    if (path === '/api/v1/heartbeat') return body.token === 'tok-1' ? { body: { license: sign(payload(over)), serverTime: new Date().toISOString() } } : { status: 401, body: { error: 'BAD_TOKEN', message: 'Unknown activation token' } };
    if (path === '/api/v1/deactivate') return { body: { revocation: revocation() } };
    return { status: 404, body: { error: 'NOT_FOUND', message: 'no' } };
  };

  beforeAll(async () => {
    db = dbm.createPool({ ...dbConfig()!, connectionLimit: 5 });
  });
  afterAll(async () => {
    await db.end();
  });
  beforeEach(async () => {
    await exec(db, 'DELETE FROM license_state');
    await exec(db, 'DELETE FROM license_events');
    server = goodServer();
    calls.length = 0;
  });

  it('a fresh install is in evaluation and enforces the 5-user limit through the core', async () => {
    const m = await open();
    expect(m.mode()).toBe('unlicensed');
    expect(m.maxUsers()).toBe(5);
    let ctx: CoreContext | null = null;
    try {
      ctx = await createContext(buildConfig({ db: dbConfig()!, dataPath: config.dataPath, installId: 'x' }), { log: pino({ level: 'silent' }), license: m });
      const domain = `eval${Date.now()}.test`;
      await ctx.directory.createDomain(domain);
      const existing = Number((await one<{ n: number }>(db, "SELECT COUNT(*) n FROM users WHERE is_enabled = 1 AND has_mailbox = 1 AND role <> 'vayrone_support'"))!.n);
      for (let i = existing; i < 5; i++) await ctx.directory.createUser({ email: `u${i}@${domain}`, password: 'Passw0rd#1' });
      await expect(ctx.directory.createUser({ email: `sixth@${domain}`, password: 'Passw0rd#1' })).rejects.toBeInstanceOf(LicenseLimitError);
      // Disabled users do not use a seat.
      await ctx.directory.createUser({ email: `off@${domain}`, password: 'Passw0rd#1', enabled: false });
    } finally {
      await ctx?.db.end();
    }
    const row = await one<{ status: string; state_seal: Buffer }>(db, 'SELECT status, state_seal FROM license_state WHERE id = 1');
    expect(row?.status).toBe('unlicensed');
    expect(row?.state_seal.length).toBeGreaterThan(29);
  });

  it('activates online; every other process picks the licence up on refresh', async () => {
    const web = await open();
    const worker = await open();
    await web.activateOnline('vpm-' + 'x'.repeat(10)).catch((e) => expect(e.code).toBe('INVALID_KEY'));
    const key = (await import('../src/index.js')).generateLicenseKey();
    await web.activateOnline(key.toLowerCase());
    expect(web.mode()).toBe('active');
    expect(web.maxUsers()).toBe(25);
    expect(calls[0]).toMatchObject({ path: '/api/v1/activate', body: { key, machine: { id: FP.machineId }, product: { installId: 'lic-test' } } });
    expect(worker.maxUsers()).toBe(5);
    await worker.refresh();
    expect(worker.maxUsers()).toBe(25);
    expect(worker.feature('support_access')).toBe(true);
    const info = await web.info();
    expect(info).toMatchObject({ status: 'active', license: { licenseId: 'LIC-TEST-0001', plan: { name: 'Business' }, activationMode: 'online', amcActive: true }, machine: { id: FP.machineId } });
    expect(JSON.stringify(info)).not.toContain('tok-1');
    const ev = await rows<{ event: string }>(db, 'SELECT event FROM license_events ORDER BY id');
    expect(ev.map((e) => e.event)).toEqual(expect.arrayContaining(['activated', 'active']));
    // The token and key are sealed, never stored in clear.
    const raw = await one<{ secret_seal: Buffer }>(db, 'SELECT secret_seal FROM license_state WHERE id = 1');
    expect(raw!.secret_seal.toString('latin1')).not.toContain('tok-1');
  });

  it('activation errors from the License Server are reported clearly', async () => {
    server = () => ({ status: 409, body: { error: 'ALREADY_ACTIVATED', message: 'This key is already activated on machine AAAAA-…' } });
    const m = await open();
    const key = (await import('../src/index.js')).generateLicenseKey();
    await expect(m.activateOnline(key)).rejects.toMatchObject({ code: 'ALREADY_ACTIVATED', message: expect.stringContaining('already activated') });
    const offline = await open({ fetch: (async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); }) as typeof fetch });
    await expect(offline.activateOnline(key)).rejects.toMatchObject({ code: 'NETWORK', message: expect.stringMatching(/Could not reach .* \(ENOTFOUND\).*offline activation/) });
    // A licence for different hardware is refused.
    server = () => ({ body: { license: sign(payload({ activation: { id: 'A', mode: 'online', machineId: 'X', components: fpWith({ os: 'a', board: 'b', uuid: 'c' }).components } })), token: 't' } });
    await expect(m.activateOnline(key)).rejects.toMatchObject({ code: 'WRONG_MACHINE' });
    expect(m.mode()).toBe('unlicensed');
  });

  it('heartbeat refreshes entitlements; failures are counted and retried, the licence keeps working', async () => {
    const t = { now: new Date() };
    const m = await open({ now: () => t.now });
    await m.activateOnline((await import('../src/index.js')).generateLicenseKey());
    expect(await m.heartbeatDue()).toBe(true);
    server = goodServer({ maxUsers: 50, plan: { code: 'enterprise', name: 'Enterprise' } });
    expect(await m.heartbeat()).toEqual({ ok: true });
    expect(m.maxUsers()).toBe(50);
    expect(calls.at(-1)).toMatchObject({ path: '/api/v1/heartbeat', body: { licenseId: 'LIC-TEST-0001', activationId: 'ACT-1', token: 'tok-1', usage: { activeUsers: expect.any(Number) } } });
    expect(await m.heartbeatDue()).toBe(false);
    t.now = new Date(Date.now() + 25 * 3600_000);
    expect(await m.heartbeatDue()).toBe(true);

    server = () => ({ status: 503, body: { error: 'DOWN', message: 'maintenance' } });
    expect(await m.heartbeat()).toMatchObject({ ok: false, error: 'maintenance' });
    expect(m.mode()).toBe('active');
    expect(await m.heartbeatDue()).toBe(false);
    t.now = new Date(t.now.getTime() + 3600_000);
    expect(await m.heartbeatDue()).toBe(true); // hourly retry
    expect((await m.info()).activation).toMatchObject({ heartbeatFailures: 1, lastError: 'maintenance' });
  });

  it('without validation for 30 days: grace, then read-only; a successful heartbeat restores it', async () => {
    const t = { now: new Date() };
    const m = await open({ now: () => t.now });
    await m.activateOnline((await import('../src/index.js')).generateLicenseKey());
    t.now = new Date(Date.now() + 31 * DAY);
    await m.refresh();
    expect(m.mode()).toBe('grace');
    expect(await one(db, "SELECT id FROM admin_alerts WHERE dedupe_key = 'license.state' AND resolved_at IS NULL AND code = 'license.grace'")).toBeTruthy();
    t.now = new Date(Date.now() + 46 * DAY);
    await m.refresh();
    expect(m.mode()).toBe('readonly');
    expect(m.maxUsers()).toBe(25);
    // The License Server is reachable again: fresh licence, signed at the (future) test time.
    server = (path) => (path === '/api/v1/heartbeat' ? { body: { license: sign(payload({}, t.now)), serverTime: t.now.toISOString() } } : { status: 404, body: {} });
    expect(await m.heartbeat()).toEqual({ ok: true });
    expect(m.mode()).toBe('active');
    expect(await one(db, "SELECT id FROM admin_alerts WHERE dedupe_key = 'license.state' AND resolved_at IS NULL")).toBeUndefined();
    const ev = (await rows<{ event: string }>(db, 'SELECT event FROM license_events ORDER BY id')).map((e) => e.event);
    expect(ev).toEqual(expect.arrayContaining(['grace_start', 'expired', 'active']));
  });

  it('detects the clock being set back, and recovers when it is corrected', async () => {
    const t = { now: new Date(Date.now() + 10 * DAY) };
    const m = await open({ now: () => t.now });
    await m.activateOnline((await import('../src/index.js')).generateLicenseKey());
    await m.refresh();
    t.now = new Date();
    await m.refresh();
    expect(m.evaluation()).toMatchObject({ status: 'tampered', mode: 'readonly' });
    // Editing the plain DB column does not help: the high-water mark is sealed.
    await exec(db, 'UPDATE license_state SET high_water_clock = ? WHERE id = 1', [new Date(0)]);
    await m.refresh();
    expect(m.mode()).toBe('readonly');
    t.now = new Date(Date.now() + 10 * DAY);
    await m.refresh();
    expect(m.mode()).toBe('active');
  });

  it('an online check that agrees with the local clock resets a wrong-forward high-water mark', async () => {
    const t = { now: new Date(Date.now() + 200 * DAY) }; // someone typed the wrong year
    const m = await open({ now: () => t.now });
    await m.refresh();
    t.now = new Date();
    await m.refresh();
    expect(m.evaluation().status).toBe('tampered');
    await m.activateOnline((await import('../src/index.js')).generateLicenseKey()); // signed issuedAt ≈ real now
    expect(m.mode()).toBe('active');
  });

  it('a licence edited in the database is rejected; a destroyed seal is logged and rebuilt', async () => {
    const m = await open();
    await m.activateOnline((await import('../src/index.js')).generateLicenseKey());
    const blob = (await one<{ license_blob: string }>(db, 'SELECT license_blob FROM license_state WHERE id = 1'))!.license_blob;
    const env = JSON.parse(Buffer.from(blob.split('\n').slice(1, -2).join(''), 'base64').toString());
    const p = JSON.parse(Buffer.from(env.payload, 'base64url').toString());
    p.maxUsers = 9999;
    env.payload = Buffer.from(JSON.stringify(p)).toString('base64url');
    await exec(db, 'UPDATE license_state SET license_blob = ?, max_users = 9999 WHERE id = 1', [JSON.stringify(env)]);
    await m.refresh();
    expect(m.evaluation()).toMatchObject({ status: 'tampered', mode: 'readonly', maxUsers: 5 });
    expect(m.evaluation().reason).toMatch(/signature is not valid/);

    await exec(db, 'UPDATE license_state SET license_blob = ?, state_seal = ? WHERE id = 1', [blob, randomBytes(80)]);
    await m.refresh();
    expect(m.mode()).toBe('active');
    expect(await one(db, "SELECT id FROM license_events WHERE event = 'tamper' AND JSON_EXTRACT(detail, '$.what') = 'state_seal'")).toBeTruthy();
  });

  it('offline activation: request file → portal → licence file import; wrong machine and older files are refused', async () => {
    const m = await open();
    const { generateLicenseKey } = await import('../src/index.js');
    const key = generateLicenseKey();
    await expect(m.offlineRequest(null)).rejects.toMatchObject({ code: 'NEED_KEY' });
    const req = await m.offlineRequest(key);
    expect(req.fileName).toMatch(/^postmaster-request-.*\.vreq$/);
    const r = decodeRequest(req.text);
    expect(r).toMatchObject({ key, licenseId: null, machine: { id: FP.machineId, components: FP.components }, product: { hostname: 'mail.agrasteel.local' } });
    expect(calls).toHaveLength(0); // nothing went over the network

    await expect(m.importFile(req.text)).rejects.toMatchObject({ code: 'WRONG_TYPE' });
    const other = sign(payload({ activation: { id: 'A', mode: 'offline', machineId: 'X', components: fpWith({ os: '1', board: '2', uuid: '3' }).components } }));
    await expect(m.importFile(other)).rejects.toMatchObject({ code: 'WRONG_MACHINE', message: expect.stringContaining(FP.machineId) });

    const issued = new Date();
    const lic = payload({ checkBy: new Date(issued.getTime() + 90 * DAY).toISOString(), activation: { id: 'ACT-OFF', mode: 'offline', machineId: FP.machineId, components: r.machine.components } }, issued);
    await m.importFile(sign(lic));
    expect(m.mode()).toBe('active');
    expect((await m.info()).license).toMatchObject({ activationMode: 'offline' });
    expect(await m.heartbeatDue()).toBe(false);
    expect(await m.heartbeat()).toMatchObject({ skipped: true });

    // Re-validation request carries the licence id, not the key.
    expect(decodeRequest((await m.offlineRequest()).text)).toMatchObject({ key: null, licenseId: 'LIC-TEST-0001' });
    await expect(m.importFile(sign({ ...lic, issuedAt: new Date(issued.getTime() - DAY).toISOString() }))).rejects.toMatchObject({ code: 'OLDER_FILE' });
    expect(await rows(db, "SELECT id FROM license_events WHERE event IN ('offline_request','offline_import')")).toHaveLength(3);
  });

  it('hardware change: one part keeps working; a move to new hardware gets 15 days from first detection', async () => {
    const t = { now: new Date() };
    const hw = { fp: FP };
    const m = await LicenseManager.open({ db, secrets, config }, { keys: KEYS, now: () => t.now, fingerprint: async () => hw.fp, integrity: async () => ({ status: 'ok', problems: [], checkedAt: new Date() }), fetch: fakeFetch((p, b) => server(p, b)) });
    await m.activateOnline((await import('../src/index.js')).generateLicenseKey());
    hw.fp = fpWith({ disk: 'NEW-SSD' });
    await m.fingerprint(true);
    await m.refresh();
    expect(m.mode()).toBe('active');
    hw.fp = fpWith({ disk: 'NEW-SSD', board: 'NEW-BOARD', uuid: 'NEW-UUID' });
    await m.fingerprint(true);
    await m.refresh();
    expect(m.evaluation()).toMatchObject({ status: 'fingerprint_mismatch', mode: 'grace' });
    t.now = new Date(Date.now() + 10 * DAY);
    await m.refresh();
    expect(m.evaluation().reason).toMatch(/5 day\(s\) left/); // counted from first detection, not restarted
    const other = await LicenseManager.open({ db, secrets, config }, { keys: KEYS, now: () => t.now, fingerprint: async () => hw.fp, integrity: async () => ({ status: 'ok', problems: [], checkedAt: new Date() }) });
    expect(other.evaluation().reason).toMatch(/5 day\(s\) left/);
    t.now = new Date(Date.now() + 16 * DAY);
    await m.refresh();
    expect(m.mode()).toBe('readonly');
  });

  it('transfer: deactivating releases the machine and starts the 15-day grace; a server-side revocation arrives by heartbeat', async () => {
    const m = await open();
    await m.activateOnline((await import('../src/index.js')).generateLicenseKey());
    await expect(m.deactivate()).resolves.toMatchObject({ mode: 'grace' });
    expect(m.evaluation().reason).toMatch(/transferred/);
    expect(calls.at(-1)).toMatchObject({ path: '/api/v1/deactivate', body: { token: 'tok-1' } });
    await expect(m.heartbeat()).resolves.toMatchObject({ ok: false, error: expect.stringMatching(/no activation token/) });

    await exec(db, 'DELETE FROM license_state');
    const n = await open();
    await n.activateOnline((await import('../src/index.js')).generateLicenseKey());
    server = (path) => (path === '/api/v1/heartbeat' ? { body: { revocation: revocation({ reason: 'suspended', message: 'Payment pending. Call Vayrone: 0562-0000000.' }), serverTime: new Date().toISOString() } } : { status: 404, body: {} });
    expect(await n.heartbeat()).toEqual({ ok: true });
    expect(n.evaluation()).toMatchObject({ mode: 'grace' });
    expect(n.evaluation().reason).toMatch(/suspended by Vayrone\. Payment pending/);
  });
});

describe('program file integrity', () => {
  it('verifies the signed manifest of the install folder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vpm-app-'));
    writeFileSync(join(root, 'vpm.exe'), 'binary');
    writeFileSync(join(root, 'app.js'), 'code');
    const { sha256File } = await import('../src/index.js');
    const files = { 'vpm.exe': await sha256File(join(root, 'vpm.exe')), 'app.js': await sha256File(join(root, 'app.js')) };
    writeFileSync(join(root, 'integrity.vsig'), signDoc<IntegrityPayload>({ format: INTEGRITY_FORMAT, version: '1.0.0', files, issuedAt: new Date().toISOString() }, KEY.privateKey, KID));
    expect((await checkIntegrity(root, KEYS, true)).status).toBe('ok');
    writeFileSync(join(root, 'app.js'), 'patched code');
    expect(await checkIntegrity(root, KEYS, true)).toMatchObject({ status: 'failed', problems: ['app.js: modified'] });
    expect(await checkIntegrity(mkdtempSync(join(tmpdir(), 'vpm-app-')), KEYS, true)).toMatchObject({ status: 'failed', problems: ['integrity.vsig is missing'] });
    expect((await checkIntegrity(null, KEYS, false)).status).toBe('skipped');
  });
});
