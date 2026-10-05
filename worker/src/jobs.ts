// Runs jobs from the `jobs` table. Each queue runs one job at a time per
// worker (backups and restores are heavy); claims are atomic, so several
// workers can share the table. A job whose worker died is retried when its
// lock expires.
import { hostname } from 'node:os';
import { db as dbm, type CoreContext } from '@vpm/core';

const { exec, json, rows } = dbm;

export interface JobContext {
  id: number;
  attempts: number;
  progress: (pct: number) => Promise<void>;
}

export type JobHandler = (payload: Record<string, unknown>, job: JobContext) => Promise<unknown>;

const LOCK_MS = 6 * 3600_000; // long backups

export class JobRunner {
  private readonly owner = `${hostname()}:${process.pid}:jobs`;
  private timer: NodeJS.Timeout | null = null;
  private readonly busy = new Map<string, Promise<void>>();
  private seq = 0;

  constructor(
    private readonly ctx: CoreContext,
    private readonly handlers: Record<string, JobHandler>,
    private readonly queues: string[] = ['default', 'backup', 'maintenance'],
    private readonly pollMs = 2000,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await Promise.all(this.busy.values());
  }

  /** Runs at most one job per idle queue. Resolves when the started jobs finish. */
  async tick(): Promise<void> {
    const now = new Date();
    await exec(this.ctx.db, "UPDATE jobs SET status = 'pending', locked_by = NULL WHERE status = 'running' AND locked_until < ?", [now]).catch(() => {});
    const started: Promise<void>[] = [];
    for (const queue of this.queues) {
      if (this.busy.has(queue)) continue;
      const token = `${this.owner}:${++this.seq}`;
      const r = await exec(
        this.ctx.db,
        `UPDATE jobs SET status = 'running', locked_by = ?, locked_until = ?, attempts = attempts + 1, updated_at = ?
          WHERE queue = ? AND status = 'pending' AND run_at <= ? ORDER BY priority DESC, id LIMIT 1`,
        [token, new Date(now.getTime() + LOCK_MS), now, queue, now],
      );
      if (r.affectedRows !== 1) continue;
      const [job] = await rows<{ id: number; type: string; payload: unknown; attempts: number; max_attempts: number }>(this.ctx.db, "SELECT * FROM jobs WHERE locked_by = ? AND status = 'running'", [token]);
      if (!job) continue;
      const p = this.run(job).finally(() => this.busy.delete(queue));
      this.busy.set(queue, p);
      started.push(p);
    }
    await Promise.all(started);
  }

  private async run(job: { id: number; type: string; payload: unknown; attempts: number; max_attempts: number }): Promise<void> {
    const handler = this.handlers[job.type];
    const fin = async (status: string, extra: { result?: unknown; error?: string; runAt?: Date }) =>
      exec(this.ctx.db, 'UPDATE jobs SET status = ?, result = ?, last_error = ?, run_at = COALESCE(?, run_at), locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ?', [
        status,
        extra.result === undefined ? null : JSON.stringify(extra.result),
        extra.error ?? null,
        extra.runAt ?? null,
        new Date(),
        job.id,
      ]);
    if (!handler) {
      await fin('failed', { error: `No handler for job type ${job.type}` });
      return;
    }
    try {
      const result = await handler(json<Record<string, unknown>>(job.payload) ?? {}, {
        id: job.id,
        attempts: job.attempts,
        progress: async (pct) => {
          await exec(this.ctx.db, 'UPDATE jobs SET progress = ? WHERE id = ?', [pct, job.id]).catch(() => {});
        },
      });
      await fin('done', { result: result ?? null });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      this.ctx.log.error({ err: e, job: job.id, type: job.type }, 'job failed');
      const noRetry = (e as { noRetry?: boolean }).noRetry === true;
      if (!noRetry && job.attempts < job.max_attempts) await fin('pending', { error: msg, runAt: new Date(Date.now() + 2 ** job.attempts * 60_000) });
      else await fin('failed', { error: msg });
    }
  }
}
