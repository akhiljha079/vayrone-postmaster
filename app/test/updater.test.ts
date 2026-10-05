import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import mysql from 'mysql2/promise';
import { buildConfig, db as dbm, migrate, startUpdateHistory, updatesDir, writeApplyRequest, type CoreConfig } from '@vpm/core';
import {
  compareVersions,
  currentTarget,
  generateSigningKey,
  readUpdateManifest,
  signDoc,
  UPDATE_FORMAT,
  verifyUpdatePackage,
  writeUpdatePackage,
  type UpdatePayload,
} from '@vpm/license-client';
import { dbConfig } from '../../core/test/helpers.js';
import { applyPendingUpdate, type ServiceControl } from '../src/updater.js';

const DB_DIR = resolve(import.meta.dirname, '..', '..', 'db');
const KEY = generateSigningKey();
const OTHER = generateSigningKey();
const KEYS = { 'upd-1': KEY.publicKey };
const sign = (p: UpdatePayload) => signDoc(p, createPrivateKey(KEY.privateKey), 'upd-1');

function releaseDir(version: string, extra: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), `vpm-rel-${version}-`));
  mkdirSync(join(d, 'bin'), { recursive: true });
  mkdirSync(join(d, 'web', 'assets'), { recursive: true });
  writeFileSync(join(d, 'bin', process.platform === 'win32' ? 'vpm.exe' : 'vpm'), `program ${version}`, { mode: 0o755 });
  writeFileSync(join(d, 'web', 'index.html'), `<html>${version}</html>`);
  writeFileSync(join(d, 'VERSION'), `${version}\n`);
  cpSync(DB_DIR, join(d, 'db'), { recursive: true });
  for (const [k, v] of Object.entries(extra)) {
    mkdirSync(join(d, k, '..'), { recursive: true });
    writeFileSync(join(d, k), v);
  }
  return d;
}

async function pack(dir: string, version: string, over: Partial<UpdatePayload> = {}): Promise<string> {
  const out = join(mkdtempSync(join(tmpdir(), 'vpm-pkg-')), `u-${version}.vpmupdate`);
  await writeUpdatePackage(dir, out, { version, target: currentTarget(), packageFormat: 'sea', channel: 'stable', releasedAt: new Date().toISOString(), minVersion: '0.1.0', notes: 'test', ...over }, sign);
  return out;
}

describe('update packages', () => {
  it('round-trip, and refuse tampering, foreign keys and unsafe paths', async () => {
    expect(compareVersions('1.10.0', '1.9.3')).toBe(1);
    expect(compareVersions('0.3.0', '0.3')).toBe(0);
    expect(compareVersions('0.3.0', '0.4.0')).toBe(-1);
    const dir = releaseDir('0.4.0');
    const pkg = await pack(dir, '0.4.0');
    const p = await verifyUpdatePackage(pkg, KEYS);
    expect(p).toMatchObject({ version: '0.4.0', target: currentTarget(), notes: 'test' });
    expect(p.files.map((f) => f.path)).toEqual(expect.arrayContaining(['bin/vpm', 'web/index.html', 'db/schema.sql', 'VERSION']));
    await expect(verifyUpdatePackage(pkg, { 'upd-1': OTHER.publicKey })).rejects.toMatchObject({ code: 'BAD_SIGNATURE' });

    const bytes = readFileSync(pkg);
    bytes[bytes.length - 100] = bytes[bytes.length - 100]! ^ 0xff;
    const bad = `${pkg}.bad`;
    writeFileSync(bad, bytes);
    await expect(verifyUpdatePackage(bad, KEYS)).rejects.toMatchObject({ code: 'DAMAGED' });

    const evil = join(mkdtempSync(join(tmpdir(), 'vpm-pkg-')), 'evil.vpmupdate');
    await writeUpdatePackage(dir, evil, { version: '0.4.0', target: currentTarget(), packageFormat: 'sea', channel: 'stable', releasedAt: new Date().toISOString(), minVersion: '0', notes: '' }, (pl) =>
      sign({ ...pl, files: pl.files.map((f, i) => (i === 0 ? { ...f, path: '../../etc/evil' } : f)) }),
    );
    await expect(verifyUpdatePackage(evil, KEYS)).rejects.toThrow(/Unsafe path/);
    expect((await readUpdateManifest(pkg, KEYS)).payload.format).toBe(UPDATE_FORMAT);
    await expect(readUpdateManifest(join(dir, 'VERSION'), KEYS)).rejects.toMatchObject({ code: 'NOT_UPDATE' });
  });
});

describe.skipIf(!dbConfig())('applying an update', () => {
  const name = `vpm_upd_${Date.now() % 1_000_000}`;
  const { database: _d, ...server } = dbConfig() ?? { database: '', user: 'root' };
  let config: CoreConfig;
  let db: dbm.Db;

  beforeAll(async () => {
    const c = await mysql.createConnection(server);
    await c.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    await c.end();
    config = buildConfig({ db: { ...server, database: name } as CoreConfig['db'], dataPath: mkdtempSync(join(tmpdir(), 'vpm-upd-data-')), installId: 'upd', web: { port: 1, tls: false } });
    await migrate(config.db, DB_DIR);
    db = dbm.createPool({ ...config.db, connectionLimit: 2 });
  });
  afterAll(async () => {
    await db.end();
    const c = await mysql.createConnection(server);
    await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
    await c.end();
  });

  /** An installed 0.3.0 program folder with one web asset the new version no longer has. */
  const installed = () => releaseDir('0.3.0', { 'web/assets/old-123.js': 'old' });
  const request = async (pkg: string, version: string) => {
    const dl = updatesDir(config.dataPath, 'download');
    const target = join(dl, `${version}.vpmupdate`);
    cpSync(pkg, target);
    const id = await startUpdateHistory(db, { from: '0.3.0', to: version, channel: 'offline', sha256: 'x'.repeat(64), userId: null });
    writeApplyRequest(config.dataPath, { historyId: id, package: target, version, requestedAt: new Date().toISOString(), requestedBy: 'boss' });
    return id;
  };
  const services = (onStart?: () => Promise<void>): ServiceControl & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      async stop() {
        calls.push('stop');
      },
      async start() {
        calls.push('start');
        await onStart?.();
      },
    };
  };

  it('installs: snapshot, swap files (old kept for rollback), restart, health check', async () => {
    const home = installed();
    const pkg = await pack(releaseDir('0.4.0'), '0.4.0');
    const id = await request(pkg, '0.4.0');
    const svc = services();
    const r = await applyPendingUpdate({ config, home, keys: KEYS, services: svc, health: async () => '0.4.0', log: () => {} });
    expect(r).toMatchObject({ result: 'installed', version: '0.4.0', binaryChanged: true });
    expect(svc.calls).toEqual(['stop', 'start']);
    expect(readFileSync(join(home, 'bin', 'vpm'), 'utf8')).toBe('program 0.4.0');
    expect(readFileSync(join(home, 'VERSION'), 'utf8').trim()).toBe('0.4.0');
    expect(existsSync(join(home, 'web/assets/old-123.js'))).toBe(false);
    expect(readFileSync(join(home, '.rollback', 'bin', 'vpm'), 'utf8')).toBe('program 0.3.0');
    expect(existsSync(join(home, '.update-staging'))).toBe(false);
    const h = await dbm.one<{ status: string; log: string; finished_at: Date }>(db, 'SELECT status, log, finished_at FROM update_history WHERE id = ?', [id]);
    expect(h).toMatchObject({ status: 'installed', finished_at: expect.any(Date) });
    expect(h!.log).toMatch(/Package verified[\s\S]*Snapshot: vpm-pre_update-[\s\S]*is running/);
    expect(existsSync(join(config.dataPath, 'updates', 'apply.json'))).toBe(false);
    expect(await applyPendingUpdate({ config, home, keys: KEYS, services: svc, health: async () => null })).toEqual({ result: 'none' });
  });

  it('a version that does not come up is rolled back: old files, and the database from the snapshot', async () => {
    const home = installed();
    await dbm.exec(db, "INSERT INTO domains (name, created_at, updated_at) VALUES ('before-update.test', NOW(3), NOW(3))");
    const pkg = await pack(releaseDir('0.5.0'), '0.5.0');
    const id = await request(pkg, '0.5.0');
    // The new version migrates its database on start, then fails its health check.
    const svc = services(async () => {
      if (svc.calls.filter((c) => c === 'start').length === 1) {
        await dbm.exec(db, 'CREATE TABLE IF NOT EXISTS upd_new_feature (id INT PRIMARY KEY)');
        await dbm.exec(db, "INSERT INTO schema_migrations (version, name, checksum, app_version, applied_at) VALUES (900, '900_new_feature', REPEAT('0', 64), '0.5.0', NOW(3))");
      }
    });
    const r = await applyPendingUpdate({ config, home, keys: KEYS, services: svc, health: async () => '0.3.0', healthTimeoutMs: 2500, log: () => {} });
    expect(r).toMatchObject({ result: 'rolled_back', version: '0.5.0', message: expect.stringMatching(/did not come up/) });
    expect(svc.calls).toEqual(['stop', 'start', 'stop', 'start']);
    expect(readFileSync(join(home, 'bin', 'vpm'), 'utf8')).toBe('program 0.3.0');
    expect(readFileSync(join(home, 'web/assets/old-123.js'), 'utf8')).toBe('old');
    expect(await dbm.one(db, "SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'upd_new_feature'")).toBeUndefined();
    expect(await dbm.one(db, 'SELECT version FROM schema_migrations WHERE version = 900')).toBeUndefined();
    expect(await dbm.one(db, "SELECT id FROM domains WHERE name = 'before-update.test'")).toBeTruthy();
    const h = await dbm.one<{ status: string; log: string }>(db, 'SELECT status, log FROM update_history WHERE id = ?', [id]);
    expect(h!.status).toBe('rolled_back');
    expect(h!.log).toMatch(/Rolling back[\s\S]*restoring the snapshot[\s\S]*Rolled back to 0\.3\.0/);
  });

  it('refuses downgrades, other platforms and packages not signed by Vayrone, without touching anything', async () => {
    const home = installed();
    const svc = services();
    await request(await pack(releaseDir('0.2.0'), '0.2.0'), '0.2.0');
    expect(await applyPendingUpdate({ config, home, keys: KEYS, services: svc, health: async () => null })).toMatchObject({ result: 'failed', message: /not newer/ });
    await request(await pack(releaseDir('0.6.0'), '0.6.0', { target: 'plan9-mips' }), '0.6.0');
    expect(await applyPendingUpdate({ config, home, keys: KEYS, services: svc, health: async () => null })).toMatchObject({ result: 'failed', message: /plan9-mips/ });
    await request(await pack(releaseDir('0.6.0'), '0.6.0'), '0.6.0');
    expect(await applyPendingUpdate({ config, home, keys: { 'upd-1': OTHER.publicKey }, services: svc, health: async () => null })).toMatchObject({ result: 'failed', message: /not signed by Vayrone/ });
    await request(await pack(releaseDir('0.6.0'), '0.6.0', { minVersion: '0.5.0' }), '0.6.0');
    expect(await applyPendingUpdate({ config, home, keys: KEYS, services: svc, health: async () => null })).toMatchObject({ result: 'failed', message: /first be updated to 0\.5\.0/ });
    expect(svc.calls).toEqual([]);
    expect(readFileSync(join(home, 'bin', 'vpm'), 'utf8')).toBe('program 0.3.0');

    writeFileSync(join(config.dataPath, 'updates', 'apply.json'), JSON.stringify({ historyId: 1, package: '/etc/passwd', version: '9' }));
    await expect(applyPendingUpdate({ config, home, keys: KEYS, services: svc })).rejects.toThrow(/outside the update folder/);
  });
});
