// DB-backed job queue (no Redis needed). The worker claims and runs jobs;
// any process may enqueue. A dedupe key makes "enqueue once per slot" safe
// with several workers.
import type { Queryable } from './db.js';
import { exec, one } from './db.js';

export interface EnqueueOptions {
  queue?: string;
  type: string;
  payload?: Record<string, unknown>;
  dedupeKey?: string | null;
  runAt?: Date;
  priority?: number;
  maxAttempts?: number;
}

/** Returns the job id, or null when a job with the same dedupe key already exists. */
export async function enqueueJob(q: Queryable, o: EnqueueOptions): Promise<number | null> {
  const now = new Date();
  const r = await exec(
    q,
    `INSERT IGNORE INTO jobs (queue, type, payload, dedupe_key, status, priority, run_at, max_attempts, created_at, updated_at)
     VALUES (?,?,?,?,'pending',?,?,?,?,?)`,
    [o.queue ?? 'default', o.type, JSON.stringify(o.payload ?? {}), o.dedupeKey ?? null, o.priority ?? 0, o.runAt ?? now, o.maxAttempts ?? 3, now, now],
  );
  return r.affectedRows === 1 ? r.insertId : null;
}

export async function jobStatus(q: Queryable, id: number) {
  return one<{ id: number; status: string; progress: number | null; last_error: string | null; result: unknown }>(q, 'SELECT id, status, progress, last_error, result FROM jobs WHERE id = ?', [id]);
}
