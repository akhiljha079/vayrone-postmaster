import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { APP_VERSION, db as dbm, type CoreContext } from '@vpm/core';
import { currentTarget, generateSigningKey, signDoc, UPDATE_INDEX_FORMAT, writeUpdatePackage, type UpdatePayload } from '@vpm/license-client';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const KEY = generateSigningKey();
const PW = 'Passw0rd#1';
const sign = <T extends { format: never }>(p: T) => signDoc(p as never, createPrivateKey(KEY.privateKey), 'dev-upd');
const bump = (v: string) => v.replace(/\d+$/, (n) => String(Number(n) + 1));

async function makePackage(version: string, target = currentTarget()): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'vpm-rel-'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'vpm'), `program ${version}`);
  writeFileSync(join(dir, 'VERSION'), version);
  const out = join(mkdtempSync(join(tmpdir(), 'vpm-pkg-')), `vayrone-postmaster-${version}-${target}.vpmupdate`);
  await writeUpdatePackage(dir, out, { version, target, packageFormat: 'node', channel: 'stable', releasedAt: new Date().toISOString(), minVersion: '0.0.1', notes: `Release ${version}` }, (p: UpdatePayload) => sign(p as never));
  return out;
}

function multipart(file: string, name: string): { payload: Buffer; headers: Record<string, string> } {
  const b = `----vpm${Date.now()}`;
  const payload = Buffer.concat([
    Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`),
    readFileSync(file),
    Buffer.from(`\r\n--${b}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
}

describe.skipIf(!dbConfig())('updates API', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let boss: Client;
  let deputy: Client;
  let srv: Server;
  const domain = uniqueDomain();
  const next = bump(APP_VERSION);

  const upload = async (c: Client, file: string, name = 'update.vpmupdate') => {
    const m = multipart(file, name);
    return app.inject({ method: 'POST', url: '/api/admin/updates/upload', payload: m.payload, remoteAddress: c.ip, headers: { ...m.headers, cookie: [...c.cookies].map(([k, v]) => `${k}=${v}`).join('; '), 'x-vpm-csrf': c.cookies.get('vpm_csrf')! } });
  };

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    mkdirSync(join(ctx.config.dataPath, 'dev-license-keys'), { recursive: true });
    writeFileSync(join(ctx.config.dataPath, 'dev-license-keys', 'dev-upd.pem'), KEY.publicKey);
    await ctx.directory.createStaffUser({ login: `boss-${domain}`, password: PW, displayName: 'Boss', role: 'super_admin' });
    await ctx.directory.createStaffUser({ login: `deputy-${domain}`, password: PW, displayName: 'Deputy', role: 'admin' });
    boss = new Client(app);
    await boss.login(`boss-${domain}`, PW);
    deputy = new Client(app);
    await deputy.login(`deputy-${domain}`, PW);
    await dbm.exec(ctx.db, "DELETE FROM settings WHERE namespace = 'updates'");
    await ctx.settings.set('updates', 'staged', null, null);
    await ctx.settings.set('updates', 'available', null, null);
  });
  afterAll(async () => {
    await dbm.exec(ctx.db, "DELETE FROM settings WHERE namespace = 'updates'");
    srv?.close();
    await close();
  });

  it('offline: upload, verify against the Vayrone signature, stage; only super admins', async () => {
    const pkg = await makePackage(next);
    expect((await upload(deputy, pkg)).statusCode).toBe(403);
    const bad = `${pkg}.x`;
    const bytes = readFileSync(pkg);
    bytes[bytes.length - 3] = bytes[bytes.length - 3]! ^ 0xff; // gzip trailer (size) of the last file
    writeFileSync(bad, bytes);
    expect((await upload(boss, bad)).json()).toMatchObject({ error: 'UPDATE_INVALID' });
    expect((await upload(boss, await makePackage(next, 'plan9-mips'))).json()).toMatchObject({ error: 'UPDATE_WRONG_PLATFORM' });
    const r = await upload(boss, pkg);
    expect(r.statusCode, r.body).toBe(200);
    expect(r.json()).toMatchObject({ version: next, source: 'offline', notes: `Release ${next}` });
    const info = (await boss.get('/api/admin/updates')).json();
    expect(info).toMatchObject({ current: APP_VERSION, staged: { version: next }, updater: { ok: false } });
  });

  it('install: needs the updater, writes the request and history; one at a time', async () => {
    expect((await boss.post('/api/admin/updates/install', { version: next })).json()).toMatchObject({ error: 'UPDATER_MISSING' });
    mkdirSync(join(ctx.config.dataPath, 'updates'), { recursive: true });
    writeFileSync(join(ctx.config.dataPath, 'updates', 'updater.alive'), new Date().toISOString());
    expect((await deputy.post('/api/admin/updates/install', { version: next })).statusCode).toBe(403);
    expect((await boss.post('/api/admin/updates/install', { version: '9.9.9' })).statusCode).toBe(400);
    const r = (await boss.post('/api/admin/updates/install', { version: next })).json();
    expect(r).toMatchObject({ ok: true, historyId: expect.any(Number) });
    const req = JSON.parse(readFileSync(join(ctx.config.dataPath, 'updates', 'apply.json'), 'utf8'));
    expect(req).toMatchObject({ historyId: r.historyId, version: next, requestedBy: `boss-${domain}` });
    expect(req.package.startsWith(join(ctx.config.dataPath, 'updates', 'download'))).toBe(true);
    expect((await boss.post('/api/admin/updates/install', { version: next })).json()).toMatchObject({ error: 'UPDATE_PENDING' });
    expect((await boss.get(`/api/admin/updates/history/${r.historyId}`)).json()).toMatchObject({ fromVersion: APP_VERSION, toVersion: next, status: 'verifying' });
    expect(await dbm.one(ctx.db, "SELECT id FROM audit_log WHERE action = 'update.install'")).toBeTruthy();
  });

  it('online: checks the signed channel index and downloads with checksum verification', async () => {
    const newer = bump(next);
    const pkg = await makePackage(newer);
    const pkgBytes = readFileSync(pkg);
    const { createHash } = await import('node:crypto');
    const index = sign({
      format: UPDATE_INDEX_FORMAT,
      product: 'postmaster',
      version: newer,
      target: currentTarget(),
      channel: 'beta',
      releasedAt: new Date().toISOString(),
      minVersion: '0.0.1',
      notes: 'Beta build',
      file: 'pkg.vpmupdate',
      size: pkgBytes.length,
      sha256: createHash('sha256').update(pkgBytes).digest('hex'),
    } as never);
    const hits: string[] = [];
    srv = createServer((req, res) => {
      hits.push(req.url!);
      if (req.url === `/beta/${currentTarget()}/latest.vidx`) res.end(index);
      else if (req.url === `/beta/${currentTarget()}/pkg.vpmupdate`) res.end(pkgBytes);
      else res.writeHead(404).end();
    });
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
    const port = (srv.address() as { port: number }).port;
    expect((await deputy.put('/api/admin/updates/settings', { channel: 'beta', autoCheck: true })).statusCode).toBe(403);
    await boss.put('/api/admin/updates/settings', { channel: 'beta', autoCheck: true, url: `http://127.0.0.1:${port}` });
    const c = (await deputy.post('/api/admin/updates/check')).json();
    expect(c).toMatchObject({ current: APP_VERSION, newer: true, latest: { version: newer, notes: 'Beta build' } });
    await boss.post('/api/admin/updates/download');
    for (let i = 0; i < 50 && (await boss.get('/api/admin/updates')).json().download.active; i++) await new Promise((r) => setTimeout(r, 100));
    const info = (await boss.get('/api/admin/updates')).json();
    expect(info.download.error).toBeNull();
    expect(info.staged).toMatchObject({ version: newer, source: 'online', channel: 'beta' });
    expect(existsSync(join(ctx.config.dataPath, 'updates', 'download', 'pkg.vpmupdate'))).toBe(true);
    expect(hits).toEqual([`/beta/${currentTarget()}/latest.vidx`, `/beta/${currentTarget()}/pkg.vpmupdate`]);
  });
});
