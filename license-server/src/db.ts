import mysql, { type Pool, type PoolConnection, type ResultSetHeader, type RowDataPacket } from 'mysql2/promise';
import type { LsConfig } from './config.js';

export type Db = Pool;
export type Q = Pool | PoolConnection;

export function createPool(cfg: LsConfig['db']): Db {
  return mysql.createPool({ ...cfg, connectionLimit: cfg.connectionLimit ?? 10, timezone: 'Z', dateStrings: false, supportBigNumbers: true, bigNumberStrings: false, decimalNumbers: true });
}

export async function rows<T = RowDataPacket>(q: Q, sql: string, params: unknown[] = []): Promise<T[]> {
  const [r] = await q.query<RowDataPacket[]>(sql, params);
  return r as T[];
}

export async function one<T = RowDataPacket>(q: Q, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await rows<T>(q, sql, params))[0];
}

export async function exec(q: Q, sql: string, params: unknown[] = []): Promise<ResultSetHeader> {
  const [r] = await q.query<ResultSetHeader>(sql, params);
  return r;
}

export async function tx<T>(db: Db, fn: (c: PoolConnection) => Promise<T>): Promise<T> {
  const c = await db.getConnection();
  try {
    await c.beginTransaction();
    const r = await fn(c);
    await c.commit();
    return r;
  } catch (e) {
    await c.rollback().catch(() => undefined);
    throw e;
  } finally {
    c.release();
  }
}

export function json<T>(v: unknown): T {
  return (typeof v === 'string' ? JSON.parse(v) : v) as T;
}
