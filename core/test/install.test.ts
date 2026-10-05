import { afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { applyRuntimeOverrides, buildConfig, loadConfig, readRuntimeOverrides, writeRuntimeOverrides } from '../src/config.js';
import { ensureSetupToken, removeSetupToken, requestRestart, setupTokenMatches, watchRestart } from '../src/control.js';
import { initInstall } from '../src/install.js';
import { createPool, exec } from '../src/db.js';
import { dbConfig } from './helpers.js';

const DB_DIR = resolve(import.meta.dirname, '..', '..', 'db');

describe('runtime overrides (network settings from the setup wizard)', () => {
  it('merge over the config file without touching it', () => {
    const data = mkdtempSync(join(tmpdir(), 'vpm-rt-'));
    const cfgFile = join(data, 'vpm.config.json');
    writeFileSync(cfgFile, JSON.stringify({ installId: 'x', dataPath: data, db: { user: 'u', database: 'd' }, hostname: 'old.local', tls: { certFile: '/etc/a.crt', keyFile: '/etc/a.key' } }));
    expect(loadConfig(cfgFile)).toMatchObject({ hostname: 'old.local', web: { port: 443 }, ports: { imap: 143 } });
    writeRuntimeOverrides(data, { hostname: 'mail.new.local', ports: { imap: 0 }, web: { port: 8443 } });
    writeRuntimeOverrides(data, { listenHost: '192.168.1.10' });
    const c = loadConfig(cfgFile);
    expect(c).toMatchObject({ hostname: 'mail.new.local', listenHost: '192.168.1.10', web: { port: 8443, tls: true }, ports: { imap: 0, imaps: 993 }, tls: { certFile: '/etc/a.crt' } });
    // tls: {} means "use the self-signed certificate"
    writeRuntimeOverrides(data, { tls: {} });
    expect(loadConfig(cfgFile).tls).toEqual({});
    writeRuntimeOverrides(data, { tls: { certFile: '/d/s.crt', keyFile: '/d/s.key' } });
    expect(applyRuntimeOverrides(buildConfig({ db: { user: 'u', database: 'd' }, dataPath: data })).tls).toEqual({ certFile: '/d/s.crt', keyFile: '/d/s.key' });
    expect(JSON.parse(readFileSync(cfgFile, 'utf8')).hostname).toBe('old.local');
    writeFileSync(join(data, 'runtime.json'), '{broken');
    expect(readRuntimeOverrides(data)).toEqual({});
  });

  it('setup token: created once, compared in constant time, removed at the end', () => {
    const data = mkdtempSync(join(tmpdir(), 'vpm-tok-'));
    const t = ensureSetupToken(data);
    expect(ensureSetupToken(data)).toBe(t);
    expect(setupTokenMatches(data, t)).toBe(true);
    expect(setupTokenMatches(data, `${t} `)).toBe(true);
    expect(setupTokenMatches(data, 'nope')).toBe(false);
    expect(setupTokenMatches(data, undefined)).toBe(false);
    if (process.platform !== 'win32') expect(statSync(join(data, 'setup.token')).mode & 0o077).toBe(0);
    removeSetupToken(data);
    expect(setupTokenMatches(data, t)).toBe(false);
  });
});

describe.skipIf(!dbConfig())('vpm init (installer) and service restart', () => {
  const name = `vpm_init_${Date.now() % 1_000_000}`;
  const { database: _d, ...server } = dbConfig() ?? { database: '', user: 'root' };

  afterAll(async () => {
    const c = await mysql.createConnection(server);
    await c.query(`DROP DATABASE IF EXISTS \`${name}\``);
    for (const h of ['localhost', '127.0.0.1', '::1']) await c.query('DROP USER IF EXISTS ?@?', [`u_${name}`.slice(0, 32), h]);
    await c.end();
  });

  it('creates the database, a dedicated user, config, master key and setup token; a second run only upgrades', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vpm-init-'));
    const logs: string[] = [];
    const r = await initInstall({
      configPath: join(dir, 'etc', 'vpm.config.json'),
      dataPath: join(dir, 'data'),
      migrationsPath: DB_DIR,
      db: { database: name, user: `u_${name}`.slice(0, 32), ...(server.socketPath ? { socketPath: server.socketPath } : { host: server.host, port: server.port }) },
      dbAdmin: server,
      hostname: 'mail.agrasteel.local',
      webPort: 8443,
      masterKey: { file: join(dir, 'etc', 'master.key') },
      log: (m) => logs.push(m),
    });
    expect(r).toMatchObject({ created: true, setupToken: expect.any(String), setupUrl: `https://mail.agrasteel.local:8443/setup?token=${r.setupToken}` });
    const cfg = loadConfig(r.configPath);
    expect(cfg).toMatchObject({ hostname: 'mail.agrasteel.local', web: { port: 8443 }, db: { database: name }, masterKeyFile: join(dir, 'etc', 'master.key') });
    expect(cfg.db.password).toMatch(/^[\w-]{20,}$/);
    expect(cfg.installId).toMatch(/^[0-9a-f]{16}$/);
    expect(readFileSync(join(dir, 'etc', 'master.key'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
    if (process.platform !== 'win32') {
      expect(statSync(r.configPath).mode & 0o007).toBe(0);
      expect(statSync(join(dir, 'etc', 'master.key')).mode & 0o007).toBe(0);
    }
    // The services connect with the generated account, not root.
    const pool = createPool({ ...cfg.db, connectionLimit: 1 });
    await exec(pool, 'SELECT COUNT(*) FROM users');
    await pool.end();

    const again = await initInstall({ configPath: r.configPath, dataPath: 'ignored', migrationsPath: 'ignored', db: { database: 'ignored' }, masterKey: {}, log: (m) => logs.push(m) });
    expect(again).toMatchObject({ created: false, setupToken: r.setupToken, applied: [] });
    expect(loadConfig(r.configPath).installId).toBe(cfg.installId);
    expect(logs.join('\n')).not.toContain(cfg.db.password!);
    expect(existsSync(join(dir, 'data', 'setup.token'))).toBe(true);
  });

  it('a restart request reaches every running process once', async () => {
    const pool = createPool({ ...dbConfig()!, connectionLimit: 2 });
    const since = new Date();
    const seen: string[] = [];
    const stop = watchRestart(pool, since, (r) => seen.push(r), 50);
    await new Promise((r) => setTimeout(r, 120));
    expect(seen).toEqual([]);
    await requestRestart(pool, 'new TLS certificate');
    await new Promise((r) => setTimeout(r, 200));
    expect(seen).toEqual(['new TLS certificate']);
    stop();
    // A process started after the request is not restarted again.
    const later: string[] = [];
    const stop2 = watchRestart(pool, new Date(Date.now() + 1000), (r) => later.push(r), 50);
    await new Promise((r) => setTimeout(r, 150));
    expect(later).toEqual([]);
    stop2();
    await pool.end();
  });
});
