import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import mysql from 'mysql2/promise';
import type { DbConfig } from './config.js';

export const APP_VERSION = '0.6.6';

interface MigrationFile {
  version: number;
  name: string;
  file: string;
  sql: string;
  sha256: string;
}

function loadMigrations(dbDir: string): MigrationFile[] {
  const dir = join(dbDir, 'migrations');
  return readdirSync(dir)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((file) => {
      const sql = readFileSync(join(dir, file), 'utf8');
      return {
        version: Number(file.slice(0, 3)),
        name: file.replace(/\.sql$/, ''),
        file,
        sql,
        sha256: createHash('sha256').update(sql).digest('hex'),
      };
    });
}

export interface MigrateResult {
  fresh: boolean;
  applied: number[];
}

/**
 * Fresh database: runs schema.sql and records the versions it contains.
 * Existing database: applies migrations newer than the highest recorded one.
 * Applied migrations whose checksum changed are reported, never re-run.
 */
export async function migrate(cfg: DbConfig, dbDir: string, log: (m: string) => void = () => {}): Promise<MigrateResult> {
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    socketPath: cfg.socketPath,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    multipleStatements: true,
    timezone: 'Z',
  });
  try {
    await conn.query("SET time_zone = '+00:00'");
    const files = loadMigrations(dbDir);
    const [t] = await conn.query("SHOW TABLES LIKE 'schema_migrations'");
    const now = new Date();

    if ((t as unknown[]).length === 0) {
      const schemaPath = join(dbDir, 'schema.sql');
      const manifestPath = join(dbDir, 'schema.manifest.json');
      if (!existsSync(schemaPath) || !existsSync(manifestPath)) throw new Error('schema.sql / schema.manifest.json missing');
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: number; file: string; sha256: string }[];
      log(`Fresh install: loading schema.sql (migrations ${manifest.map((m) => m.version).join(', ')})`);
      await conn.query(readFileSync(schemaPath, 'utf8'));
      for (const m of manifest) {
        await conn.query(
          'INSERT INTO schema_migrations (version, name, checksum, app_version, applied_at) VALUES (?,?,?,?,?)',
          [m.version, m.file.replace(/\.sql$/, ''), m.sha256, APP_VERSION, now],
        );
      }
      // Migrations newer than schema.sql (e.g. schema.sql not regenerated) still apply below.
    }

    const [appliedRows] = await conn.query('SELECT version, checksum FROM schema_migrations');
    const applied = new Map((appliedRows as { version: number; checksum: string }[]).map((r) => [r.version, r.checksum]));
    const fresh = (t as unknown[]).length === 0;
    const done: number[] = [];

    for (const m of files) {
      const known = applied.get(m.version);
      if (known !== undefined) {
        if (known !== m.sha256) log(`WARNING: migration ${m.file} changed after it was applied`);
        continue;
      }
      log(`Applying ${m.file}`);
      const started = Date.now();
      await conn.query(m.sql);
      await conn.query(
        'INSERT INTO schema_migrations (version, name, checksum, app_version, applied_at, duration_ms) VALUES (?,?,?,?,?,?)',
        [m.version, m.name, m.sha256, APP_VERSION, new Date(), Date.now() - started],
      );
      done.push(m.version);
    }
    return { fresh, applied: done };
  } finally {
    await conn.end();
  }
}
