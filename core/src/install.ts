// `vpm init`: run by the Windows installer and the Linux package scripts.
// Creates the database and its user, writes the config file, creates the
// master key, migrates, and issues the setup-wizard token. Running it again
// on an existing install only migrates (package upgrades).
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { hostname as osHostname } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import mysql from 'mysql2/promise';
import { buildConfig, type ConfigInput, type CoreConfig, type DbConfig } from './config.js';
import { createMasterKey } from './secrets.js';
import { migrate } from './migrate.js';
import { createPool, one } from './db.js';
import { ensureSetupToken } from './control.js';

export interface InitOptions {
  configPath: string;
  dataPath: string;
  migrationsPath: string;
  webRoot?: string;
  /** Connection the services use. Without user/password a dedicated user is created through dbAdmin. */
  db: Partial<DbConfig> & { database: string };
  /** Privileged connection used once to create the database and user (MariaDB root, socket auth on Linux). */
  dbAdmin?: { host?: string; port?: number; socketPath?: string; user: string; password?: string };
  hostname?: string;
  webPort?: number;
  masterKey: { file?: string; dpapiFile?: string };
  logDir?: string;
  force?: boolean;
  log?: (m: string) => void;
}

export interface InitResult {
  configPath: string;
  created: boolean;
  setupToken: string | null;
  setupUrl: string | null;
  applied: number[];
}

const ident = (s: string) => {
  if (!/^[A-Za-z0-9_]{1,64}$/.test(s)) throw new Error(`Invalid database identifier: ${s}`);
  return s;
};

export async function setupCompleted(cfg: DbConfig): Promise<boolean> {
  const pool = createPool({ ...cfg, connectionLimit: 1 });
  try {
    const r = await one<{ completed_at: Date | null }>(pool, 'SELECT completed_at FROM setup_state WHERE id = 1');
    return Boolean(r?.completed_at);
  } finally {
    await pool.end();
  }
}

function setupUrl(cfg: CoreConfig, token: string): string {
  const scheme = cfg.web.tls ? 'https' : 'http';
  const port = (cfg.web.tls && cfg.web.port === 443) || (!cfg.web.tls && cfg.web.port === 80) ? '' : `:${cfg.web.port}`;
  return `${scheme}://${cfg.hostname}${port}/setup?token=${token}`;
}

export async function initInstall(o: InitOptions): Promise<InitResult> {
  const log = o.log ?? (() => {});
  const configPath = resolve(o.configPath);

  if (existsSync(configPath) && !o.force) {
    const cfg = buildConfig(JSON.parse(readFileSync(configPath, 'utf8')) as ConfigInput);
    log(`Existing installation (${configPath}); upgrading the database`);
    const r = await migrate(cfg.db, cfg.migrationsPath, log);
    const done = await setupCompleted(cfg.db);
    const token = done ? null : ensureSetupToken(cfg.dataPath);
    return { configPath, created: false, setupToken: token, setupUrl: token ? setupUrl(cfg, token) : null, applied: r.applied };
  }

  mkdirSync(o.dataPath, { recursive: true, mode: 0o750 });
  if (o.logDir) mkdirSync(o.logDir, { recursive: true, mode: 0o750 });

  const db: DbConfig = {
    database: ident(o.db.database),
    user: o.db.user ?? 'vpm',
    ...(o.db.host ? { host: o.db.host } : {}),
    ...(o.db.port ? { port: o.db.port } : {}),
    ...(o.db.socketPath ? { socketPath: o.db.socketPath } : {}),
    ...(o.db.password !== undefined ? { password: o.db.password } : {}),
  };
  if (o.dbAdmin) {
    const admin = await mysql.createConnection({ ...o.dbAdmin });
    try {
      await admin.query(`CREATE DATABASE IF NOT EXISTS \`${db.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
      if (o.db.password === undefined) {
        db.password = randomBytes(18).toString('base64url');
        const user = ident(db.user);
        for (const host of ['localhost', '127.0.0.1', '::1']) {
          await admin.query(`CREATE USER IF NOT EXISTS ?@? IDENTIFIED BY ?`, [user, host, db.password]);
          await admin.query(`ALTER USER ?@? IDENTIFIED BY ?`, [user, host, db.password]);
          await admin.query(`GRANT ALL PRIVILEGES ON \`${db.database}\`.* TO ?@?`, [user, host]);
        }
        await admin.query('FLUSH PRIVILEGES');
      }
      log(`Database ${db.database} ready (user ${db.user})`);
    } finally {
      await admin.end();
    }
  }

  const input: ConfigInput = {
    installId: randomBytes(8).toString('hex'),
    hostname: o.hostname ?? osHostname().toLowerCase(),
    dataPath: resolve(o.dataPath),
    migrationsPath: resolve(o.migrationsPath),
    ...(o.webRoot ? { webRoot: resolve(o.webRoot) } : {}),
    db,
    ...(o.masterKey.dpapiFile ? { masterKeyDpapiFile: resolve(o.masterKey.dpapiFile) } : {}),
    ...(o.masterKey.file ? { masterKeyFile: resolve(o.masterKey.file) } : {}),
    ...(o.webPort ? { web: { port: o.webPort } } : {}),
    logLevel: 'info',
  };
  const cfg = buildConfig(input);

  if (o.masterKey.dpapiFile ? !existsSync(o.masterKey.dpapiFile) : !existsSync(cfg.masterKeyFile ?? join(cfg.dataPath, 'master.key'))) {
    log(`Master key created: ${await createMasterKey(cfg)}`);
  } else log('Master key exists; kept');

  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(input, null, 2)}\n`, { mode: 0o640 });
  log(`Config written: ${configPath}`);

  const r = await migrate(cfg.db, cfg.migrationsPath, log);
  const token = (await setupCompleted(cfg.db)) ? null : ensureSetupToken(cfg.dataPath);
  return { configPath, created: true, setupToken: token, setupUrl: token ? setupUrl(cfg, token) : null, applied: r.applied };
}
