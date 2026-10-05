// Time-based work: backup schedules (cron, from the DB), nightly maintenance,
// and the background search indexer. Scheduled work is enqueued with a
// per-slot dedupe key, so with several workers each slot runs exactly once.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Cron } from 'croner';
import {
  checkBackupFreshness,
  collectGarbage,
  db as dbm,
  enqueueJob,
  indexPending,
  performBackup,
  pruneHousekeeping,
  purgeArchive,
  purgeMailboxFolders,
  restorePartial,
  targetPath,
  verifyBackup,
  materializeRun,
  isRemoteTarget,
  verifyLatestBackups,
  type BackupTargetRow,
  type CoreContext,
  type MailPolicy,
  raiseAlert,
  resolveAlert,
  updateSettings,
  runMonitorChecks,
  notifyAlerts,
} from '@vpm/core';
import { checkForUpdates, trustedKeys, type LicenseManager } from '@vpm/license-client';
import type { JobHandler } from './jobs.js';

const { exec, json, one, rows } = dbm;

/** Fixed maintenance tasks (server time zone from the mail policy). */
export const MAINTENANCE: { task: string; cron: string }[] = [
  { task: 'retention', cron: '15 2 * * *' },
  { task: 'gc', cron: '15 3 * * *' },
  { task: 'housekeeping', cron: '45 3 * * *' },
  { task: 'verify_backups', cron: '0 5 * * *' },
  { task: 'backup_health', cron: '30 * * * *' },
  { task: 'update_check', cron: '20 4 * * *' },
  { task: 'monitor', cron: '*/5 * * * *' },
  { task: 'audit_verify', cron: '40 3 * * *' },
];

export function jobHandlers(ctx: CoreContext): Record<string, JobHandler> {
  return {
    backup: async (p, job) =>
      performBackup(ctx, { targetId: Number(p.targetId), scheduleId: (p.scheduleId as number | undefined) ?? null, kind: (p.kind as 'full') ?? 'full', onProgress: (pct) => void job.progress(pct) }),

    backup_scheduled: async (p, job) => {
      const s = await one<{ id: number; target_id: number; kind: 'full' | 'incremental'; is_enabled: number }>(ctx.db, 'SELECT * FROM backup_schedules WHERE id = ?', [p.scheduleId]);
      if (!s || !s.is_enabled) return { skipped: true };
      const r = await performBackup(ctx, { targetId: s.target_id, scheduleId: s.id, kind: s.kind, onProgress: (pct) => void job.progress(pct) });
      if (r.status === 'failed') throw new Error(r.error ?? 'backup failed');
      return r;
    },

    verify_backup: async (p) => {
      const r = await one<{ id: number; target_id: number; dir_name: string }>(ctx.db, 'SELECT id, target_id, dir_name FROM backup_runs WHERE id = ?', [p.runId]);
      const t = r && (await one<BackupTargetRow>(ctx.db, 'SELECT * FROM backup_targets WHERE id = ?', [r.target_id]));
      if (!r || !t || !r.dir_name) throw new Error('Backup run not found');
      // Cloud targets: download (and decrypt) the run, then check every file — the full check.
      const m = await materializeRun(ctx, t, r.dir_name);
      let v;
      try {
        v = await verifyBackup(m.dir);
      } finally {
        await m.cleanup();
      }
      await exec(ctx.db, 'UPDATE backup_runs SET status = ?, verified_at = ?, error = ? WHERE id = ?', [v.ok ? 'verified' : 'corrupt', new Date(), v.ok ? null : v.problems.join('\n').slice(0, 60000), r.id]);
      return v;
    },

    restore: async (p) => {
      const rr = await one<{ id: number; backup_run_id: number; criteria: unknown; mode: 'original' | 'restore_folder'; target_user_id: number | null }>(ctx.db, 'SELECT * FROM restore_runs WHERE id = ?', [p.restoreRunId]);
      if (!rr) throw new Error('Restore request not found');
      const run = await one<{ target_id: number; dir_name: string }>(ctx.db, 'SELECT target_id, dir_name FROM backup_runs WHERE id = ?', [rr.backup_run_id]);
      const t = run && (await one<BackupTargetRow>(ctx.db, 'SELECT * FROM backup_targets WHERE id = ?', [run.target_id]));
      await exec(ctx.db, "UPDATE restore_runs SET status = 'running', started_at = ? WHERE id = ?", [new Date(), rr.id]);
      try {
        if (!run || !t || !run.dir_name) throw new Error('The backup for this restore no longer exists');
        if (!isRemoteTarget(t) && !existsSync(join(targetPath(t), run.dir_name, 'manifest.json'))) {
          throw new Error(`The backup files for this run no longer exist on "${t.name}" (removed by rotation, or the drive is not connected)`);
        }
        const c = json<{ sourceUserId: number; folderPath?: string | null; from?: string | null; to?: string | null; recreateUser?: boolean }>(rr.criteria);
        const local = await materializeRun(ctx, t, run.dir_name);
        const res = await restorePartial({ db: ctx.db, store: ctx.store, events: ctx.events, dataPath: ctx.config.dataPath }, local.dir, {
          sourceUserId: c.sourceUserId,
          targetUserId: rr.target_user_id,
          folderPath: c.folderPath ?? null,
          from: c.from ? new Date(c.from) : null,
          to: c.to ? new Date(c.to) : null,
          mode: rr.mode,
          recreateUser: Boolean(c.recreateUser),
        }).finally(() => local.cleanup());
        await exec(ctx.db, "UPDATE restore_runs SET status = 'ok', finished_at = ?, items_restored = ?, result = ? WHERE id = ?", [new Date(), res.items, JSON.stringify(res), rr.id]);
        return res;
      } catch (e) {
        await exec(ctx.db, "UPDATE restore_runs SET status = 'failed', finished_at = ?, error = ? WHERE id = ?", [new Date(), (e as Error).message, rr.id]);
        throw Object.assign(e as Error, { noRetry: true });
      }
    },

    maintenance: async (p) => {
      switch (p.task) {
        case 'retention':
          return { archive: await purgeArchive(ctx.db), mailbox: await purgeMailboxFolders(ctx.db, ctx.store) };
        case 'gc':
          return collectGarbage(ctx.db, ctx.blobs);
        case 'housekeeping':
          await pruneHousekeeping(ctx.db, { queueDays: 30, dedupDays: 30, loginDays: 180 });
          return { ok: true };
        case 'verify_backups':
          await verifyLatestBackups(ctx);
          return { ok: true };
        case 'backup_health':
          await checkBackupFreshness(ctx);
          return { ok: true };
        case 'audit_verify': {
          // The admin audit log is hash-chained: an edited or deleted row breaks the chain.
          const v = await ctx.audit.verify();
          if (!v.ok) await raiseAlert(ctx.db, { severity: 'critical', code: 'audit.tampered', message: `The audit log was altered near entry #${v.brokenAt}. Contact Vayrone support.`, dedupeKey: 'audit.tampered' });
          else await resolveAlert(ctx.db, 'audit.tampered');
          return v;
        }
        case 'monitor': {
          const h = await runMonitorChecks(ctx);
          const sent = await notifyAlerts(ctx);
          return { db: h.db.ok, diskFreePct: h.disk?.freePct ?? null, alertsEmailed: sent };
        }
        case 'update_check': {
          const cfg = await updateSettings(ctx.settings);
          if (!cfg.autoCheck || process.env.VPM_DOCKER === '1') return { skipped: true };
          const r = await checkForUpdates(ctx.settings, trustedKeys(ctx.config.dataPath));
          if (r.newer && r.latest) {
            await raiseAlert(ctx.db, { severity: 'info', code: 'update.available', message: `Vayrone PostMaster ${r.latest.version} is available (installed: ${r.current}). Admin → Updates.`, dedupeKey: 'update.available' });
          } else await resolveAlert(ctx.db, 'update.available');
          return { current: r.current, latest: r.latest?.version ?? null };
        }
        default:
          throw new Error(`Unknown maintenance task ${String(p.task)}`);
      }
    },
  };
}

export class Scheduler {
  private crons = new Map<string, { cron: Cron; key: string }>();
  private reconcileTimer: NodeJS.Timeout | null = null;
  private indexTimer: NodeJS.Timeout | null = null;
  private indexing = false;
  private licenseTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: CoreContext,
    private readonly license: LicenseManager | null = null,
  ) {}

  /** Online licences call the License Server when due (daily; hourly retries after a failure). */
  async licenseHeartbeat(): Promise<void> {
    if (!this.license) return;
    try {
      if (await this.license.heartbeatDue()) await this.license.heartbeat();
    } catch (err) {
      this.ctx.log.error({ err }, 'licence heartbeat failed');
    }
  }

  private async timezone(): Promise<string> {
    return (await this.ctx.settings.get<Partial<MailPolicy>>('mail', 'policy', {})).timezone ?? 'Asia/Kolkata';
  }

  async start(): Promise<void> {
    await this.reconcile();
    this.reconcileTimer = setInterval(() => void this.reconcile(), 60_000);
    this.indexTimer = setInterval(() => void this.indexSome(), 5_000);
    if (this.license) {
      void this.licenseHeartbeat();
      this.licenseTimer = setInterval(() => void this.licenseHeartbeat(), 10 * 60_000);
    }
  }

  stop(): void {
    for (const c of this.crons.values()) c.cron.stop();
    this.crons.clear();
    if (this.reconcileTimer) clearInterval(this.reconcileTimer);
    if (this.indexTimer) clearInterval(this.indexTimer);
    if (this.licenseTimer) clearInterval(this.licenseTimer);
  }

  private async indexSome(): Promise<void> {
    if (this.indexing) return;
    this.indexing = true;
    try {
      while ((await indexPending(this.ctx.db, this.ctx.blobs, 200)) === 200);
    } catch (err) {
      this.ctx.log.error({ err }, 'search indexing failed');
    } finally {
      this.indexing = false;
    }
  }

  private schedule(id: string, pattern: string, tz: string, fire: (slot: string) => Promise<unknown>): void {
    const key = `${pattern}|${tz}`;
    const cur = this.crons.get(id);
    if (cur?.key === key) return;
    cur?.cron.stop();
    const cron = new Cron(pattern, { timezone: tz, protect: true }, async () => {
      const slot = new Date().toISOString().slice(0, 16); // minute resolution
      await fire(slot).catch((err) => this.ctx.log.error({ err, id }, 'schedule enqueue failed'));
    });
    this.crons.set(id, { cron, key });
  }

  /** Brings cron jobs in line with the DB (backup schedules can change at any time). */
  async reconcile(): Promise<void> {
    try {
      const tz = await this.timezone();
      const wanted = new Set<string>();
      for (const m of MAINTENANCE) {
        const id = `maint:${m.task}`;
        wanted.add(id);
        this.schedule(id, m.cron, tz, (slot) => enqueueJob(this.ctx.db, { queue: 'maintenance', type: 'maintenance', payload: { task: m.task }, dedupeKey: `maint:${m.task}:${slot}`, maxAttempts: 1 }));
      }
      const schedules = await rows<{ id: number; cron: string }>(this.ctx.db, 'SELECT id, cron FROM backup_schedules WHERE is_enabled = 1');
      for (const s of schedules) {
        const id = `backup:${s.id}`;
        wanted.add(id);
        try {
          this.schedule(id, s.cron, tz, (slot) => enqueueJob(this.ctx.db, { queue: 'backup', type: 'backup_scheduled', payload: { scheduleId: s.id }, dedupeKey: `backup:${s.id}:${slot}`, maxAttempts: 2 }));
        } catch (err) {
          this.ctx.log.error({ err, schedule: s.id }, 'invalid backup schedule');
        }
      }
      for (const [id, c] of this.crons) {
        if (!wanted.has(id)) {
          c.cron.stop();
          this.crons.delete(id);
        }
      }
    } catch (err) {
      this.ctx.log.error({ err }, 'scheduler reconcile failed');
    }
  }

  /** Next run time per schedule id (for diagnostics/tests). */
  nextRuns(): Record<string, Date | null> {
    return Object.fromEntries([...this.crons].map(([id, c]) => [id, c.cron.nextRun()]));
  }
}
