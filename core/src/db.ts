import mysql from 'mysql2/promise';
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise';
import type { DbConfig } from './config.js';

export type Db = Pool;
/** Anything that can run a query: the pool or a connection inside a transaction. */
export type Queryable = Pool | PoolConnection;
export type Row = RowDataPacket;
export type { PoolConnection, ResultSetHeader };

export function createPool(cfg: DbConfig): Db {
  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    socketPath: cfg.socketPath,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    connectionLimit: cfg.connectionLimit ?? 20,
    charset: 'utf8mb4_unicode_ci',
    timezone: 'Z',
    supportBigNumbers: true,
    bigNumberStrings: false,
    dateStrings: false,
    enableKeepAlive: true,
  });
  pool.pool.on('connection', (conn) => {
    conn.query("SET time_zone = '+00:00', sql_mode = 'STRICT_ALL_TABLES,NO_ENGINE_SUBSTITUTION'");
  });
  return pool;
}

export async function rows<T = Row>(q: Queryable, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await q.query(sql, params);
  return r as T[];
}

export async function one<T = Row>(q: Queryable, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(q, sql, params))[0];
}

export async function exec(q: Queryable, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [r] = await q.query(sql, params);
  return r as ResultSetHeader;
}

const RETRYABLE = new Set([1213 /* deadlock */, 1205 /* lock wait timeout */]);

/** Runs fn in a transaction, retrying on deadlock / lock-wait timeout. */
export async function tx<T>(db: Db, fn: (c: PoolConnection) => Promise<T>, retries = 3): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    const c = await db.getConnection();
    try {
      await c.beginTransaction();
      const result = await fn(c);
      await c.commit();
      return result;
    } catch (err) {
      await c.rollback().catch(() => {});
      const errno = (err as { errno?: number }).errno;
      if (errno !== undefined && RETRYABLE.has(errno) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 20 * (attempt + 1) + Math.random() * 30));
        continue;
      }
      throw err;
    } finally {
      c.release();
    }
  }
}

/** JSON columns come back parsed on MySQL and as strings on MariaDB. */
export function json<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}
