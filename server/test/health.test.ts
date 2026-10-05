import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { db as dbm, notifyAlerts, runMonitorChecks, type CoreContext } from '@vpm/core';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const PW = 'Passw0rd#1';

describe.skipIf(!dbConfig())('monitoring', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let boss: Client;
  let deputy: Client;
  let itUser: number;
  const domain = uniqueDomain();

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    await ctx.directory.createDomain(domain);
    await ctx.directory.createUser({ email: `boss@${domain}`, password: PW, role: 'super_admin' });
    await ctx.directory.createUser({ email: `deputy@${domain}`, password: PW, role: 'admin' });
    itUser = await ctx.directory.createUser({ email: `it@${domain}`, password: PW });
    boss = new Client(app);
    await boss.login(`boss@${domain}`, PW);
    deputy = new Client(app);
    await deputy.login(`deputy@${domain}`, PW);
    await dbm.exec(ctx.db, "UPDATE admin_alerts SET resolved_at = NOW(3) WHERE resolved_at IS NULL");
  });
  afterAll(async () => {
    await dbm.exec(ctx.db, "DELETE FROM settings WHERE namespace = 'monitor'");
    await dbm.exec(ctx.db, "UPDATE admin_alerts SET resolved_at = NOW(3) WHERE resolved_at IS NULL");
    await close();
  });

  it('reports database, disk, queue, fetch, backup and TLS state', async () => {
    const res = await deputy.get('/api/admin/health');
    expect(res.headers['cache-control']).toBe('no-store');
    const r = res.json();
    expect(r.health).toMatchObject({ db: { ok: true, latencyMs: expect.any(Number) }, disk: { freeBytes: expect.any(Number) }, queue: { queued: expect.any(Number) }, license: { mode: 'active' } });
    expect(r.settings).toMatchObject({ emails: [], minSeverity: 'critical' });
  });

  it('raises and resolves a stuck-queue alert', async () => {
    const message = await ctx.store.ingest(Buffer.from(`From: it@${domain}\r\nTo: x@remote.test\r\nSubject: stuck\r\n\r\nbody\r\n`));
    const q = await ctx.delivery.enqueueOutbound({ message, envelopeFrom: `it@${domain}`, recipients: ['x@remote.test'], senderUserId: itUser, source: 'webmail' });
    await dbm.exec(ctx.db, 'UPDATE outbound_queue SET created_at = ? WHERE id = ?', [new Date(Date.now() - 2 * 3600_000), q]);
    await runMonitorChecks(ctx);
    const a = await dbm.one<{ severity: string; message: string }>(ctx.db, "SELECT severity, message FROM admin_alerts WHERE dedupe_key = 'queue.stuck' AND resolved_at IS NULL");
    expect(a).toMatchObject({ severity: 'warning', message: expect.stringMatching(/waiting for 1[12]\d minutes/) });
    await dbm.exec(ctx.db, "UPDATE outbound_queue SET status = 'sent' WHERE id = ?", [q]);
    await runMonitorChecks(ctx);
    expect(await dbm.one(ctx.db, "SELECT id FROM admin_alerts WHERE dedupe_key = 'queue.stuck' AND resolved_at IS NULL")).toBeUndefined();
  });

  it('e-mails alerts to local mailboxes and external addresses, once per day', async () => {
    expect((await deputy.put('/api/admin/health/settings', { emails: [`it@${domain}`] })).statusCode).toBe(403);
    expect((await boss.put('/api/admin/health/settings', { emails: [`it@${domain}`, 'noc@partner.test'], minSeverity: 'warning' })).statusCode).toBe(200);
    await dbm.exec(ctx.db, "INSERT INTO admin_alerts (severity, code, message, dedupe_key, first_at, last_at) VALUES ('critical', 'disk.low', 'Only 1.2 GB free', 'test.disk', NOW(3), NOW(3))");
    expect(await notifyAlerts(ctx)).toBeGreaterThanOrEqual(1);
    const inbox = (await ctx.store.getSpecialFolder(itUser, 'inbox'))!;
    expect((await ctx.store.getFolderById(inbox.id))!.message_count).toBeGreaterThanOrEqual(1);
    const out = await dbm.one<{ envelope_from: string; rcpt: string }>(
      ctx.db,
      "SELECT q.envelope_from, r.rcpt FROM outbound_queue q JOIN outbound_recipients r ON r.queue_id = q.id WHERE q.source = 'system' ORDER BY q.id DESC LIMIT 1",
    );
    expect(out).toEqual({ envelope_from: `postmaster@${ctx.config.hostname}`, rcpt: 'noc@partner.test' });
    expect(await notifyAlerts(ctx)).toBe(0); // already notified
    const t = (await boss.post('/api/admin/health/test-email')).json();
    expect(t).toMatchObject({ ok: true, recipients: [`it@${domain}`, 'noc@partner.test'] });
    expect(await dbm.one(ctx.db, "SELECT id FROM admin_alerts WHERE dedupe_key = 'monitor.test' AND resolved_at IS NULL")).toBeUndefined();
  });

  it('offers the public certificate for download, never the key', async () => {
    const r = await app.inject({ url: '/api/public/certificate' });
    expect(r.headers['content-type']).toContain('x509');
    expect(r.body).toMatch(/^-----BEGIN CERTIFICATE-----/);
    expect(r.body).not.toContain('PRIVATE KEY');
  });

  it('/metrics needs the bearer token, which is shown once and stored hashed', async () => {
    expect((await app.inject({ url: '/metrics' })).statusCode).toBe(401);
    expect((await deputy.post('/api/admin/health/metrics-token', { enabled: true })).statusCode).toBe(403);
    const { token } = (await boss.post('/api/admin/health/metrics-token', { enabled: true })).json();
    expect(token).toMatch(/^vpm_/);
    expect(JSON.stringify(await ctx.settings.get('monitor', 'metricsToken', null))).not.toContain(token);
    expect((await app.inject({ url: '/metrics', headers: { authorization: 'Bearer wrong' } })).statusCode).toBe(401);
    const m = await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${token}` } });
    expect(m.headers['content-type']).toContain('text/plain');
    expect(m.body).toMatch(/^vpm_db_up 1$/m);
    expect(m.body).toMatch(/^vpm_info\{version="[\d.]+",hostname="mail\.test\.local"\} 1$/m);
    await boss.post('/api/admin/health/metrics-token', { enabled: false });
    expect((await app.inject({ url: '/metrics', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(401);
  });
});
