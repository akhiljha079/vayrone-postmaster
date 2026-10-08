import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { X509Certificate } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { db as dbm, ensureSetupToken, readRuntimeOverrides, type CoreContext } from '@vpm/core';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const { exec, one, rows } = dbm;
// 1×1 transparent PNG
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe.skipIf(!dbConfig())('setup wizard API', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let token: string;
  const domain = uniqueDomain();
  const backupDir = mkdtempSync(join(tmpdir(), 'vpm-setup-bk-'));

  /** A browser on another LAN machine, holding the installer's token. */
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, body?: unknown, tok: string | null = token, remoteAddress = '192.168.1.50') =>
    app.inject({ method, url: `/api/setup${url}`, remoteAddress, headers: tok ? { 'x-vpm-setup': tok } : {}, ...(body !== undefined ? { payload: body as object } : {}) });

  let archivePolicy: unknown;
  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    await exec(ctx.db, 'DELETE FROM setup_state');
    await exec(ctx.db, 'DELETE FROM company_profile');
    archivePolicy = await ctx.settings.get('archive', 'policy', null);
    token = ensureSetupToken(ctx.config.dataPath);
  });
  afterAll(async () => {
    // The test database is shared by all server test files: undo what the wizard set globally.
    await exec(ctx.db, 'INSERT INTO setup_state (id, current_step, completed_steps, completed_at) VALUES (1, 9, ?, ?) ON DUPLICATE KEY UPDATE completed_at = VALUES(completed_at)', ['{"steps":[]}', new Date()]);
    if (archivePolicy) await ctx.settings.set('archive', 'policy', archivePolicy, null);
    else await exec(ctx.db, "DELETE FROM settings WHERE namespace = 'archive' AND name = 'policy'");
    await exec(ctx.db, "DELETE FROM retention_policies WHERE name LIKE 'Setup:%'");
    await exec(ctx.db, "DELETE FROM backup_targets WHERE name = 'Setup: nightly backup'");
    await exec(ctx.db, "UPDATE relay_accounts SET is_default = 0, is_enabled = 0 WHERE host = '127.0.0.1' AND port = 1");
    await close();
  });

  it('is protected by the setup token, except from the server itself', async () => {
    expect((await call('GET', '/status', undefined, null)).json()).toMatchObject({ required: true, needsToken: true });
    expect((await call('GET', '/status', undefined, null, '127.0.0.1')).json()).toMatchObject({ needsToken: false });
    expect((await call('GET', '/state', undefined, null)).json()).toMatchObject({ error: 'SETUP_TOKEN' });
    expect((await call('GET', '/state', undefined, 'wrong-token-1234')).statusCode).toBe(401);
    expect((await call('GET', '/state', undefined, null, '127.0.0.1')).statusCode).toBe(200);
    const s = (await call('GET', '/state')).json();
    expect(s).toMatchObject({ steps: [], network: { webPort: expect.any(Number) }, storage: { dataPath: ctx.config.dataPath } });
    expect((await call('POST', '/complete')).json().message).toMatch(/^Still needed: company details, .*the super admin account$/);
  });

  it('licence, company with logo, domains', async () => {
    expect((await call('POST', '/license/activate', { key: 'VPM-AAAAA-BBBBB-CCCCC-DDDDD-E' })).json().error).toBe('LICENSE_UNMANAGED');
    expect((await call('POST', '/license/evaluate')).statusCode).toBe(200);

    const svg = `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64')}`;
    expect((await call('PUT', '/company', { companyName: 'Agra Steel Traders', logo: svg })).json().message).toMatch(/not a PNG/);
    expect((await call('PUT', '/company', { companyName: 'Agra Steel Traders', gstin: '09ABCDE1234F1Z5', contactPerson: 'Ravi', logo: PNG })).statusCode).toBe(200);
    const branding = (await app.inject({ url: '/api/public/branding' })).json();
    expect(branding.company).toMatchObject({ name: 'Agra Steel Traders', logoUrl: expect.stringMatching(/^\/api\/public\/logo\?v=\d+$/) });
    const logo = await app.inject({ url: branding.company.logoUrl });
    expect(logo.headers['content-type']).toBe('image/png');

    expect((await call('PUT', '/domains', { domains: ['not a domain'] })).statusCode).toBe(400);
    expect((await call('PUT', '/domains', { domains: [domain, domain] })).json().domains).toContain(domain);
  });

  it('super admin: created once, can be corrected before finishing', async () => {
    expect((await call('PUT', '/admin', { login: 'admin', displayName: 'Admin', password: 'short' })).statusCode).toBe(400);
    expect((await call('PUT', '/admin', { login: `boss@nowhere-${domain}`, displayName: 'Boss', password: 'Str0ngPassw0rd!', mailbox: true })).json().message).toMatch(/Add the domain/);
    const a = (await call('PUT', '/admin', { login: `boss-${domain}`, displayName: 'Boss', password: 'Str0ngPassw0rd!' })).json();
    const b = (await call('PUT', '/admin', { login: `boss-${domain}`, displayName: 'The Boss', password: 'An0therPassw0rd!' })).json();
    expect(b.id).toBe(a.id);
    const c = (await call('PUT', '/admin', { login: `chief-${domain}`, displayName: 'Chief', password: 'An0therPassw0rd!' })).json();
    expect(await one(ctx.db, 'SELECT id FROM users WHERE id = ?', [a.id])).toBeUndefined();
    const u = await one<{ role: string; display_name: string }>(ctx.db, 'SELECT role, display_name FROM users WHERE id = ?', [c.id]);
    expect(u).toMatchObject({ role: 'super_admin', display_name: 'Chief' });
    const login = await new Client(app).login(`chief-${domain}`, 'An0therPassw0rd!');
    expect(login.statusCode).toBe(200);
  });

  it('relay: stored with a sealed password, connection test reports errors', async () => {
    expect((await call('PUT', '/relay', { host: '127.0.0.1', port: 1, security: 'none', authUser: `mailserver@${domain}`, password: 'RelaySecret!' })).statusCode).toBe(200);
    const r = await one<{ auth_secret: Buffer; is_default: number }>(ctx.db, 'SELECT auth_secret, is_default FROM relay_accounts WHERE is_default = 1');
    expect(r!.auth_secret.toString('latin1')).not.toContain('RelaySecret');
    expect(ctx.secrets.open(r!.auth_secret)).toBe('RelaySecret!');
    const t = (await call('POST', '/relay/test', {})).json();
    expect(t).toMatchObject({ ok: false, message: expect.stringMatching(/ECONNREFUSED|connect/i) });
    expect(JSON.stringify((await call('GET', '/state')).json().relay)).not.toContain('RelaySecret');
  });

  it('network: validates ports and certificates, writes runtime settings, needs a restart', async () => {
    const base = { hostname: 'mail.agrasteel.local', listenHost: '0.0.0.0', ports: { submission: 587, smtps: 465, imap: 143, imaps: 993, pop3: 110, pop3s: 995 }, webPort: 8443 };
    expect((await call('PUT', '/network', { ...base, webPort: 993, tls: { mode: 'keep' } })).json().message).toMatch(/Port 993 is used twice/);
    expect((await call('PUT', '/network', { ...base, listenHost: '10.255.255.254', tls: { mode: 'keep' } })).json().message).toMatch(/not an address of this server/);
    expect((await call('PUT', '/network', { ...base, tls: { mode: 'upload', cert: 'x'.repeat(200), key: 'y'.repeat(200) } })).json().message).toMatch(/not a valid PEM certificate/);
    const r = (await call('PUT', '/network', { ...base, tls: { mode: 'selfsigned' } })).json();
    expect(r).toEqual({ ok: true, restartNeeded: true });
    expect(readRuntimeOverrides(ctx.config.dataPath)).toMatchObject({ hostname: 'mail.agrasteel.local', web: { port: 8443 }, ports: { imaps: 993 }, tls: {} });
    const cert = new X509Certificate(readFileSync(join(ctx.config.dataPath, 'certs', 'selfsigned.crt')));
    expect(cert.subjectAltName).toContain('DNS:mail.agrasteel.local');
    expect(cert.subjectAltName).toContain('IP Address:127.0.0.1');
    expect((await call('GET', '/state')).json().network.tls).toMatchObject({ selfSigned: true, names: expect.arrayContaining(['mail.agrasteel.local']) });
  });

  it('storage: nightly backup schedules, archive and trash retention', async () => {
    expect((await call('PUT', '/storage', { backupPath: join(backupDir, 'missing'), archiveEnabled: true, archiveDays: 2555, trashDays: 30 })).json().message).toMatch(/Backup folder: .*does not exist/);
    // Fresh install: no start date chosen yet (the wizard then defaults to "now").
    expect((await call('GET', '/state')).json().storage.fetchStartAt).toBeUndefined();
    expect((await call('PUT', '/storage', { backupPath: backupDir, backupTime: '02:30', keepFull: 6, archiveEnabled: true, archiveDays: 3650, trashDays: 30, fetchStartAt: '2026-10-08T10:30' })).statusCode).toBe(200);
    expect((await call('GET', '/state')).json().storage.fetchStartAt).toBe('2026-10-08T10:30');
    await ctx.settings.set('fetch', 'policy', { startAt: null }); // shared test database: leave other suites unaffected
    ctx.settings.invalidate();
    const sched = await rows<{ kind: string; cron: string; keep_full: number }>(
      ctx.db,
      "SELECT s.kind, s.cron, s.keep_full FROM backup_schedules s JOIN backup_targets t ON t.id = s.target_id WHERE t.name = 'Setup: nightly backup' ORDER BY s.kind",
    );
    expect(sched).toEqual([
      { kind: 'full', cron: '30 2 * * 0', keep_full: 6 },
      { kind: 'incremental', cron: '30 2 * * 1-6', keep_full: 6 },
    ]);
    expect(await ctx.settings.get('archive', 'policy', {})).toMatchObject({ enabled: true, retentionDays: 3650 });
    const kept = await rows<{ special_use: string }>(ctx.db, "SELECT special_use FROM retention_policies WHERE name LIKE 'Setup:%'");
    expect(kept.map((k) => k.special_use).sort()).toEqual(['junk', 'trash']);
    // Running the step again replaces, never duplicates.
    await call('PUT', '/storage', { backupPath: backupDir, archiveEnabled: false, archiveDays: null, trashDays: 15 });
    expect(await rows(ctx.db, "SELECT s.id FROM backup_schedules s JOIN backup_targets t ON t.id = s.target_id WHERE t.name = 'Setup: nightly backup'")).toHaveLength(2);
    expect(await rows(ctx.db, "SELECT keep_days FROM retention_policies WHERE name LIKE 'Setup:%' AND keep_days = 15")).toHaveLength(2);
  });

  it('finishing closes the wizard, removes the token, records it and requests a restart', async () => {
    const r = (await call('POST', '/complete')).json();
    expect(r).toEqual({ ok: true, restart: true, url: 'http://mail.agrasteel.local:8443/login' });
    expect(existsSync(join(ctx.config.dataPath, 'setup.token'))).toBe(false);
    expect((await call('GET', '/state')).statusCode).toBe(410);
    expect((await call('GET', '/state', undefined, null, '127.0.0.1')).json().error).toBe('SETUP_DONE');
    expect((await call('GET', '/status', undefined, null)).json()).toMatchObject({ required: false });
    await new Promise((res) => setTimeout(res, 1800));
    const restart = await one<{ value: unknown }>(ctx.db, "SELECT value FROM settings WHERE namespace = 'system' AND name = 'restart'");
    expect(dbm.json<{ reason: string }>(restart!.value).reason).toMatch(/setup wizard/);
    const audit = (await rows<{ action: string }>(ctx.db, "SELECT action FROM audit_log WHERE action LIKE 'setup.%' ORDER BY id")).map((a) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['setup.license_evaluation', 'setup.company', 'setup.domains', 'setup.admin', 'setup.relay', 'setup.network', 'setup.storage', 'setup.complete']));
    expect(JSON.stringify(await rows(ctx.db, "SELECT details FROM audit_log WHERE action LIKE 'setup.%'"))).not.toMatch(/RelaySecret|An0therPassw0rd/);
  });

  it('admins change network settings later; that requests a restart', async () => {
    const boss = new Client(app);
    await boss.login(`chief-${domain}`, 'An0therPassw0rd!');
    const cur = (await boss.get('/api/admin/network')).json();
    expect(cur).toMatchObject({ hostname: 'mail.agrasteel.local', webPort: 8443, tls: { selfSigned: true } });
    const r = (await boss.put('/api/admin/network', { hostname: cur.hostname, listenHost: '0.0.0.0', ports: cur.ports, webPort: 9443, tls: { mode: 'keep' } })).json();
    expect(r).toEqual({ ok: true, restart: true, url: 'http://mail.agrasteel.local:9443/admin/network' });
    expect(readRuntimeOverrides(ctx.config.dataPath).web).toEqual({ port: 9443 });
    expect((await boss.put('/api/admin/network', { ...cur, listenHost: '0.0.0.0', webPort: 110, tls: { mode: 'keep' } })).json().message).toMatch(/used twice/);
  });

  it('admins manage the logo afterwards', async () => {
    const boss = new Client(app);
    await boss.login(`chief-${domain}`, 'An0therPassw0rd!');
    expect((await boss.put('/api/admin/company/logo', { logo: null })).json()).toEqual({ ok: true, logoUrl: null });
    expect((await app.inject({ url: '/api/public/branding' })).json().company.logoUrl).toBeNull();
    expect((await boss.put('/api/admin/company/logo', { logo: PNG })).json().logoUrl).toBe('/api/public/logo');
    const about = (await boss.get('/api/about')).json();
    expect(about).toMatchObject({ product: { tagline: 'Vayrone PostMaster by Vayrone Infratech' }, company: 'Agra Steel Traders', license: { status: 'active' } });
    expect((await app.inject({ url: '/api/about' })).statusCode).toBe(401);
  });
});
