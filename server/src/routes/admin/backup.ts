// Backup targets, schedules, runs, verification and restore requests.
// The worker does the heavy lifting; these endpoints enqueue jobs and report status.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Cron } from 'croner';
import {
  checkTarget,
  db as dbm,
  enqueueJob,
  isRemoteTarget,
  jobStatus,
  materializeRun,
  readBackupTable,
  readManifest,
  targetPath,
  type BackupTargetRow,
  type CoreContext,
  type FtpConfig,
  type RemoteEncryption,
  type S3Config,
} from '@vpm/core';
import { audit, requireAdmin } from '../../guards.js';
import { badRequest, conflict, forbidden, notFound, parsePatch } from '../../http.js';

const { exec, json, one, rows } = dbm;
const Id = z.coerce.number().int().positive();

const Encryption = z.object({ enabled: z.boolean(), passphrase: z.string().min(12, 'Use a passphrase of at least 12 characters').max(200).nullish() });
const TargetBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.enum(['local', 'smb', 'nfs', 'usb']),
    name: z.string().trim().min(1).max(100),
    /** Folder: local path, mounted NAS share, USB drive or Windows UNC path (\\nas\backups). */
    path: z.string().trim().min(1).max(500),
    isEnabled: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('s3'),
    name: z.string().trim().min(1).max(100),
    s3: z.object({
      endpoint: z.url().max(300),
      region: z.string().trim().min(1).max(50),
      bucket: z.string().trim().min(3).max(63),
      prefix: z.string().trim().max(200).default('postmaster'),
      accessKeyId: z.string().trim().min(3).max(200),
      /** Write-only; omit to keep the stored secret. */
      secretAccessKey: z.string().max(200).nullish(),
      pathStyle: z.boolean().default(false),
    }),
    encryption: Encryption,
    isEnabled: z.boolean().default(true),
  }),
  z.object({
    kind: z.literal('ftp'),
    name: z.string().trim().min(1).max(100),
    ftp: z.object({
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65535).default(21),
      secure: z.enum(['none', 'explicit', 'implicit']).default('explicit'),
      user: z.string().trim().min(1).max(200),
      password: z.string().max(200).nullish(),
      path: z.string().trim().max(500).default('/postmaster'),
      tlsVerify: z.boolean().default(true),
    }),
    encryption: Encryption,
    isEnabled: z.boolean().default(true),
  }),
]);
type TargetInput = z.infer<typeof TargetBody>;

/** Stored config: secrets sealed with the master key; previous secrets kept when not re-entered. */
function targetConfig(ctx: CoreContext, b: TargetInput, prev: Record<string, unknown> | null): Record<string, unknown> {
  const seal = (v: string) => ctx.secrets.seal(v).toString('base64');
  if (b.kind === 's3' || b.kind === 'ftp') {
    const prevEnc = (prev?.encryption ?? null) as RemoteEncryption | null;
    const encryption: RemoteEncryption = { enabled: b.encryption.enabled, passphrase: b.encryption.passphrase ? seal(b.encryption.passphrase) : (prevEnc?.passphrase ?? null) };
    if (encryption.enabled && !encryption.passphrase) throw badRequest('Choose an encryption passphrase (and write it down: backups cannot be read without it)');
    if (b.kind === 's3') {
      const old = (prev ?? {}) as Partial<S3Config>;
      const secret = b.s3.secretAccessKey ? seal(b.s3.secretAccessKey) : (old.secretAccessKey ?? null);
      if (!secret) throw badRequest('Enter the secret access key');
      return { ...b.s3, secretAccessKey: secret, encryption };
    }
    const old = (prev ?? {}) as Partial<FtpConfig>;
    const password = b.ftp.password ? seal(b.ftp.password) : (old.password ?? null);
    return { ...b.ftp, password, encryption };
  }
  return { path: b.path };
}

function publicConfig(t: BackupTargetRow): Record<string, unknown> {
  const c = json<Record<string, unknown>>(t.config) ?? {};
  const enc = c.encryption as RemoteEncryption | undefined;
  if (t.kind === 's3') return { s3: { ...c, secretAccessKey: undefined, encryption: undefined, secretSet: Boolean(c.secretAccessKey) }, encryption: { enabled: Boolean(enc?.enabled), passphraseSet: Boolean(enc?.passphrase) } };
  if (t.kind === 'ftp') return { ftp: { ...c, password: undefined, encryption: undefined, passwordSet: Boolean(c.password) }, encryption: { enabled: Boolean(enc?.enabled), passphraseSet: Boolean(enc?.passphrase) } };
  return { path: (c.path as string | undefined) ?? '' };
}

const ScheduleBody = z.object({
  name: z.string().trim().min(1).max(100),
  targetId: Id,
  kind: z.enum(['full', 'incremental']),
  cron: z
    .string()
    .trim()
    .max(100)
    .refine((c) => {
      try {
        new Cron(c, { paused: true });
        return true;
      } catch {
        return false;
      }
    }, 'Invalid schedule (cron format, e.g. "0 1 * * *" for 01:00 every day)'),
  keepFull: z.number().int().min(1).max(365).default(4),
  isEnabled: z.boolean().default(true),
});

export function backupRoutes(ctx: CoreContext) {
  const read = requireAdmin(ctx, 'read');
  const write = requireAdmin(ctx, 'write');
  const superOnly = requireAdmin(ctx, 'super');

  const target = async (id: number) => {
    const t = await one<BackupTargetRow>(ctx.db, 'SELECT * FROM backup_targets WHERE id = ?', [id]);
    if (!t) throw notFound('Backup target not found');
    return t;
  };
  /** The run must exist; folder targets must also be reachable (cloud runs are checked by the worker job). */
  const runCheck = async (runId: number) => {
    const r = await one<{ id: number; target_id: number; dir_name: string | null; status: string }>(ctx.db, 'SELECT id, target_id, dir_name, status FROM backup_runs WHERE id = ?', [runId]);
    if (!r?.dir_name || r.status === 'expired') throw notFound('Backup not found or already removed');
    const t = await target(r.target_id);
    if (!isRemoteTarget(t) && !existsSync(join(targetPath(t), r.dir_name, 'manifest.json'))) throw badRequest('The backup files are not reachable (is the drive or share connected?)');
    return { run: r as typeof r & { dir_name: string }, t };
  };

  return async (app: FastifyInstance) => {
    // ------------------------------------------------------------ targets
    app.get('/backup/targets', { preHandler: read }, async () =>
      (await rows<BackupTargetRow & { last_check_at: Date | null; last_check_ok: number | null }>(ctx.db, 'SELECT * FROM backup_targets ORDER BY id')).map((t) => ({
        id: t.id,
        name: t.name,
        kind: t.kind,
        ...publicConfig(t),
        isEnabled: Boolean(t.is_enabled),
        lastCheckAt: t.last_check_at,
        lastCheckOk: t.last_check_ok === null ? null : Boolean(t.last_check_ok),
      })),
    );
    app.post('/backup/targets', { preHandler: superOnly }, async (req) => {
      const b = TargetBody.parse(req.body);
      if ((b.kind === 's3' || b.kind === 'ftp') && !ctx.license.feature('backup_cloud')) throw forbidden('Cloud backup (S3/FTP) is not included in this licence', 'LICENSE_FEATURE');
      const encrypted = b.kind === 's3' || b.kind === 'ftp' ? b.encryption.enabled : false;
      const r = await exec(ctx.db, 'INSERT INTO backup_targets (name, kind, config, encrypt_backups, is_enabled, created_at) VALUES (?,?,?,?,?,?)', [
        b.name,
        b.kind,
        JSON.stringify(targetConfig(ctx, b, null)),
        encrypted ? 1 : 0,
        b.isEnabled ? 1 : 0,
        new Date(),
      ]);
      await audit(ctx, req, 'backup.target_create', 'backup_target', r.insertId, { name: b.name, kind: b.kind });
      return { id: r.insertId };
    });
    app.patch<{ Params: { id: string } }>('/backup/targets/:id', { preHandler: superOnly }, async (req) => {
      const id = Id.parse(req.params.id);
      const t = await target(id);
      // Full replacement of the settings (secrets may be omitted to keep them); kind cannot change.
      const b = TargetBody.parse({ ...(req.body as object), kind: t.kind });
      const encrypted = b.kind === 's3' || b.kind === 'ftp' ? b.encryption.enabled : false;
      await exec(ctx.db, 'UPDATE backup_targets SET name = ?, config = ?, encrypt_backups = ?, is_enabled = ? WHERE id = ?', [
        b.name,
        JSON.stringify(targetConfig(ctx, b, json<Record<string, unknown>>(t.config))),
        encrypted ? 1 : 0,
        b.isEnabled ? 1 : 0,
        id,
      ]);
      await audit(ctx, req, 'backup.target_update', 'backup_target', id, { name: b.name });
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/backup/targets/:id', { preHandler: superOnly }, async (req) => {
      const id = Id.parse(req.params.id);
      if (await one(ctx.db, "SELECT id FROM backup_runs WHERE target_id = ? AND status NOT IN ('expired','failed') LIMIT 1", [id])) {
        throw conflict('This target still holds backups. Disable it instead, or remove the backups first.');
      }
      await exec(ctx.db, 'DELETE FROM backup_runs WHERE target_id = ?', [id]);
      await exec(ctx.db, 'DELETE FROM backup_targets WHERE id = ?', [id]);
      await audit(ctx, req, 'backup.target_delete', 'backup_target', id);
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>('/backup/targets/:id/check', { preHandler: write }, async (req) => {
      const t = await target(Id.parse(req.params.id));
      const r = await checkTarget(t, ctx.secrets);
      await exec(ctx.db, 'UPDATE backup_targets SET last_check_at = ?, last_check_ok = ? WHERE id = ?', [new Date(), r.ok ? 1 : 0, t.id]);
      return r;
    });

    // ------------------------------------------------------------ schedules
    app.get('/backup/schedules', { preHandler: read }, async () =>
      (await rows<{ id: number; name: string; target_id: number; kind: string; cron: string; keep_full: number; is_enabled: number }>(ctx.db, 'SELECT * FROM backup_schedules ORDER BY id')).map((s) => {
        let next: Date | null = null;
        try {
          next = s.is_enabled ? new Cron(s.cron, { paused: true }).nextRun() : null;
        } catch {
          /* invalid */
        }
        return { id: s.id, name: s.name, targetId: s.target_id, kind: s.kind, cron: s.cron, keepFull: s.keep_full, isEnabled: Boolean(s.is_enabled), nextRun: next };
      }),
    );
    app.post('/backup/schedules', { preHandler: superOnly }, async (req) => {
      const b = ScheduleBody.parse(req.body);
      await target(b.targetId);
      const r = await exec(ctx.db, 'INSERT INTO backup_schedules (name, target_id, kind, cron, keep_full, is_enabled, created_at) VALUES (?,?,?,?,?,?,?)', [
        b.name,
        b.targetId,
        b.kind,
        b.cron,
        b.keepFull,
        b.isEnabled ? 1 : 0,
        new Date(),
      ]);
      await audit(ctx, req, 'backup.schedule_create', 'backup_schedule', r.insertId, b);
      return { id: r.insertId };
    });
    app.patch<{ Params: { id: string } }>('/backup/schedules/:id', { preHandler: superOnly }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(ScheduleBody, req.body);
      const map: Record<string, string> = { name: 'name', targetId: 'target_id', kind: 'kind', cron: 'cron', keepFull: 'keep_full', isEnabled: 'is_enabled' };
      const sets = Object.keys(b).map((k) => `${map[k]} = ?`);
      if (sets.length) await exec(ctx.db, `UPDATE backup_schedules SET ${sets.join(', ')} WHERE id = ?`, [...Object.values(b).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)), id]);
      await audit(ctx, req, 'backup.schedule_update', 'backup_schedule', id, b);
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/backup/schedules/:id', { preHandler: superOnly }, async (req) => {
      const id = Id.parse(req.params.id);
      await exec(ctx.db, 'UPDATE backup_runs SET schedule_id = NULL WHERE schedule_id = ?', [id]);
      await exec(ctx.db, 'DELETE FROM backup_schedules WHERE id = ?', [id]);
      await audit(ctx, req, 'backup.schedule_delete', 'backup_schedule', id);
      return { ok: true };
    });

    // ------------------------------------------------------------ runs
    app.get<{ Querystring: { targetId?: string } }>('/backup/runs', { preHandler: read }, async (req) =>
      rows(
        ctx.db,
        `SELECT r.id, r.target_id AS targetId, t.name AS target, r.schedule_id AS scheduleId, r.kind, r.base_run_id AS baseRunId, r.status, r.progress,
                r.started_at AS startedAt, r.finished_at AS finishedAt, r.file_count AS files, r.bytes, r.verified_at AS verifiedAt, r.error, r.dir_name AS dirName
           FROM backup_runs r JOIN backup_targets t ON t.id = r.target_id ${req.query.targetId ? 'WHERE r.target_id = ?' : ''} ORDER BY r.id DESC LIMIT 200`,
        req.query.targetId ? [Number(req.query.targetId)] : [],
      ),
    );
    app.post('/backup/run', { preHandler: write }, async (req) => {
      const b = z.object({ targetId: Id, kind: z.enum(['full', 'incremental']).default('full') }).parse(req.body);
      await target(b.targetId);
      const jobId = await enqueueJob(ctx.db, { queue: 'backup', type: 'backup', payload: { targetId: b.targetId, kind: b.kind }, maxAttempts: 1, priority: 10 });
      await audit(ctx, req, 'backup.run_now', 'backup_target', b.targetId, b);
      return { jobId };
    });
    app.post<{ Params: { id: string } }>('/backup/runs/:id/verify', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      await runCheck(id);
      return { jobId: await enqueueJob(ctx.db, { queue: 'backup', type: 'verify_backup', payload: { runId: id }, maxAttempts: 1 }) };
    });
    /** Users and folders contained in a backup (for choosing what to restore). */
    app.get<{ Params: { id: string } }>('/backup/runs/:id/contents', { preHandler: write }, async (req) => {
      const { run, t } = await runCheck(Id.parse(req.params.id));
      // Cloud targets: only the database part is downloaded to list users and folders.
      const local = await materializeRun(ctx, t, run.dir_name, { dbOnly: true }).catch((e: Error) => {
        throw badRequest(`Could not read the backup: ${e.message}`);
      });
      const dir = local.dir;
      try {
      const m = await readManifest(dir);
      const users = new Map<number, { userId: number; login: string; displayName: string; existsNow: boolean; folders: { path: string; messages: number }[] }>();
      for await (const u of readBackupTable(dir, 'users')) {
        if (!u.has_mailbox) continue;
        users.set(Number(u.id), { userId: Number(u.id), login: String(u.login), displayName: String(u.display_name), existsNow: false, folders: [] });
      }
      for await (const f of readBackupTable(dir, 'folders')) {
        users.get(Number(f.user_id))?.folders.push({ path: String(f.path), messages: Number(f.message_count) });
      }
      const ids = [...users.keys()];
      if (ids.length) {
        for (const r of await rows<{ id: number; login: string }>(ctx.db, 'SELECT id, login FROM users WHERE id IN (?)', [ids])) {
          const u = users.get(r.id);
          if (u && u.login === r.login) u.existsNow = true;
        }
      }
      return { createdAt: m.createdAt, kind: m.kind, users: [...users.values()].sort((a, b) => a.login.localeCompare(b.login)) };
      } finally {
        await local.cleanup();
      }
    });

    // ------------------------------------------------------------ restores
    const RestoreBody = z.object({
      backupRunId: Id,
      sourceUserId: Id,
      targetUserId: Id.nullable().optional(),
      folderPath: z.string().max(1000).nullable().optional(),
      from: z.coerce.date().nullable().optional(),
      to: z.coerce.date().nullable().optional(),
      mode: z.enum(['original', 'restore_folder']).default('original'),
      recreateUser: z.boolean().default(false),
    });
    app.post('/backup/restore', { preHandler: write }, async (req) => {
      const b = RestoreBody.parse(req.body);
      await runCheck(b.backupRunId);
      const scope = b.folderPath ? 'folder' : b.from || b.to ? 'date_range' : 'user';
      const r = await exec(ctx.db, 'INSERT INTO restore_runs (backup_run_id, scope, target_user_id, criteria, mode, requested_by) VALUES (?,?,?,?,?,?)', [
        b.backupRunId,
        scope,
        b.targetUserId ?? null,
        JSON.stringify({ sourceUserId: b.sourceUserId, folderPath: b.folderPath ?? null, from: b.from ?? null, to: b.to ?? null, recreateUser: b.recreateUser }),
        b.mode,
        req.auth!.user.id,
      ]);
      const jobId = await enqueueJob(ctx.db, { type: 'restore', payload: { restoreRunId: r.insertId }, maxAttempts: 1, priority: 5 });
      await audit(ctx, req, 'backup.restore_request', 'restore_run', r.insertId, b);
      return { restoreRunId: r.insertId, jobId };
    });
    app.get('/backup/restores', { preHandler: read }, async () =>
      (
        await rows(
          ctx.db,
          `SELECT r.id, r.backup_run_id AS backupRunId, r.scope, r.mode, r.criteria, r.status, r.items_restored AS itemsRestored, r.result, r.error,
                  r.started_at AS startedAt, r.finished_at AS finishedAt, u.login AS requestedBy
             FROM restore_runs r LEFT JOIN users u ON u.id = r.requested_by ORDER BY r.id DESC LIMIT 100`,
        )
      ).map((r) => ({ ...r, criteria: json(r.criteria), result: json(r.result) })),
    );
    app.get<{ Params: { id: string } }>('/jobs/:id', { preHandler: read }, async (req) => {
      const j = await jobStatus(ctx.db, Id.parse(req.params.id));
      if (!j) throw notFound('Job not found');
      return { ...j, result: json(j.result) };
    });
  };
}
