import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import mysql from 'mysql2/promise';
import type { LsConfig } from './config.js';

/** Applies db/migrations/NNN_*.sql in order; each file is recorded with its checksum. */
export async function migrate(cfg: LsConfig['db'], dbDir: string, log: (m: string) => void = () => {}): Promise<number[]> {
  const conn = await mysql.createConnection({ ...cfg, multipleStatements: true });
  try {
    await conn.query('SELECT GET_LOCK(?, 60)', ['vls_migrate']);
    const [t] = await conn.query<mysql.RowDataPacket[]>("SELECT COUNT(*) n FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = 'ls_migrations'");
    const done = new Map<number, string>();
    if (Number(t[0]!.n) > 0) {
      const [r] = await conn.query<mysql.RowDataPacket[]>('SELECT version, checksum FROM ls_migrations');
      for (const x of r) done.set(Number(x.version), String(x.checksum));
    }
    const applied: number[] = [];
    const dir = join(dbDir, 'migrations');
    for (const file of readdirSync(dir).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).sort()) {
      const version = Number(file.slice(0, 3));
      const sql = readFileSync(join(dir, file), 'utf8');
      const sum = createHash('sha256').update(sql).digest('hex');
      if (done.has(version)) {
        if (done.get(version) !== sum) throw new Error(`Migration ${file} was changed after it was applied`);
        continue;
      }
      log(`applying ${file}`);
      await conn.query(sql);
      await conn.query('INSERT INTO ls_migrations (version, name, checksum, applied_at) VALUES (?,?,?,?)', [version, file, sum, new Date()]);
      applied.push(version);
    }
    return applied;
  } finally {
    await conn.query('SELECT RELEASE_LOCK(?)', ['vls_migrate']).catch(() => undefined);
    await conn.end();
  }
}
