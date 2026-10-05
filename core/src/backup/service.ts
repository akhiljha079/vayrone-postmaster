// Backup runs end to end: target checks, incremental base selection,
// verification right after writing, rotation and admin alerts.
import { createReadStream, existsSync } from 'node:fs';
import { access, mkdir, readdir, readFile, rm, stat, writeFile, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { Readable } from 'node:stream';
import type { CoreContext } from '../context.js';
import type { SecretBox } from '../secrets.js';
import { exec, json, one, rows } from '../db.js';
import { raiseAlert, resolveAlert } from '../alerts.js';
import { readManifest, runBackup, verifyBackup } from './backup.js';
import { decryptStream, encryptedSize, encryptStream, keyFromInfo, newEncryption, type EncryptionInfo } from './crypt.js';
import { isRemoteKind, openRemote, type RemoteStore } from './remote.js';

export interface BackupTargetRow {
  id: number;
  name: string;
  kind: 'local' | 'smb' | 'nfs' | 'usb' | 's3' | 'ftp' | 'sftp';
  config: unknown;
  is_enabled: number;
}

export interface RemoteEncryption {
  enabled: boolean;
  /** Sealed with the master key (base64). */
  passphrase: string | null;
}

export function isRemoteTarget(t: BackupTargetRow): boolean {
  return isRemoteKind(t.kind);
}

/** Folder of a folder-type target; cloud targets write to a local staging folder first. */
export function targetPath(t: BackupTargetRow, dataPath?: string): string {
  if (isRemoteKind(t.kind)) {
    if (!dataPath) throw new Error(`${t.kind.toUpperCase()} target "${t.name}" needs a staging folder`);
    return join(dataPath, 'backup-staging', `target-${t.id}`);
  }
  if (!['local', 'smb', 'nfs', 'usb'].includes(t.kind)) throw new Error(`${t.kind.toUpperCase()} targets are not supported; use a folder, NAS share, USB drive, S3 or FTP`);
  const p = json<{ path?: string }>(t.config)?.path;
  if (!p) throw new Error(`Backup target "${t.name}" has no folder configured`);
  return p;
}

function remoteOf(t: BackupTargetRow, secrets: SecretBox): RemoteStore {
  return openRemote(t.kind as 's3' | 'ftp', json(t.config), secrets);
}

async function walkFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  };
  await walk(dir);
  return out;
}

/** Uploads a finished, verified run; returns what the remote now holds for it. */
async function uploadRun(t: BackupTargetRow, secrets: SecretBox, root: string, dirName: string, onProgress?: (pct: number) => void): Promise<{ objects: number; bytes: number }> {
  const store = remoteOf(t, secrets);
  const enc = json<{ encryption?: RemoteEncryption }>(t.config)?.encryption;
  try {
    const local = join(root, dirName);
    let key: Buffer | null = null;
    if (enc?.enabled) {
      if (!enc.passphrase) throw new Error('Encryption is on but no passphrase is stored');
      const e = await newEncryption(secrets.open(Buffer.from(enc.passphrase, 'base64')));
      key = e.key;
      await writeFile(join(local, 'encryption.json'), JSON.stringify(e.info));
    }
    const files = (await walkFiles(local)).sort((a, b) => (a === 'manifest.json' ? 1 : b === 'manifest.json' ? -1 : a.localeCompare(b))); // manifest last = complete
    let bytes = 0;
    let i = 0;
    for (const f of files) {
      const size = (await stat(join(local, f))).size;
      const plain = f === 'encryption.json' || !key;
      const body = plain ? createReadStream(join(local, f)) : createReadStream(join(local, f)).pipe(encryptStream(key!));
      const len = plain ? size : encryptedSize(size);
      await store.put(`${dirName}/${f}`, body as unknown as Readable, len);
      bytes += len;
      onProgress?.(Math.round((++i / files.length) * 100));
    }
    const listed = await store.list(`${dirName}/`);
    if (listed.length !== files.length) throw new Error(`Upload check failed: ${listed.length} of ${files.length} files are on ${store.label}`);
    const listedBytes = listed.reduce((a, o) => a + o.size, 0);
    if (listedBytes !== bytes) throw new Error(`Upload check failed: ${listedBytes} of ${bytes} bytes are on ${store.label}`);
    return { objects: files.length, bytes };
  } finally {
    await store.close();
  }
}

/**
 * Makes a run (and the runs it builds on) available as local folders and
 * returns the run's folder. Folder targets: the folder itself. Cloud targets:
 * downloaded (and decrypted) into staging; call `cleanup` afterwards.
 */
export async function materializeRun(
  ctx: CoreContext,
  t: BackupTargetRow,
  dirName: string,
  opts: { dbOnly?: boolean; passphrase?: string } = {},
): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  if (!isRemoteKind(t.kind)) return { dir: join(targetPath(t), dirName), cleanup: async () => {} };
  const root = join(ctx.config.dataPath, 'backup-staging', `restore-${t.id}-${Date.now()}`);
  const store = remoteOf(t, ctx.secrets);
  const cfg = json<{ encryption?: RemoteEncryption }>(t.config)?.encryption;
  try {
    let next: string | null = dirName;
    while (next) {
      const listed = await store.list(`${next}/`);
      if (!listed.length) throw new Error(`Backup ${next} is not on ${store.label}`);
      let key: Buffer | null = null;
      if (listed.some((o) => o.key === `${next}/encryption.json`)) {
        await store.getTo(`${next}/encryption.json`, join(root, next, 'encryption.json'));
        const info = JSON.parse(await readFile(join(root, next, 'encryption.json'), 'utf8')) as EncryptionInfo;
        const pass = opts.passphrase ?? (cfg?.passphrase ? ctx.secrets.open(Buffer.from(cfg.passphrase, 'base64')) : null);
        if (!pass) throw new Error('This backup is encrypted; the passphrase is needed');
        key = await keyFromInfo(pass, info);
      }
      for (const o of listed) {
        const rel = o.key.slice(next.length + 1);
        if (rel === 'encryption.json') continue;
        if (opts.dbOnly && !(rel === 'manifest.json' || rel.startsWith('db/'))) continue;
        const k = key;
        await store.getTo(o.key, join(root, next, rel), k ? () => decryptStream(k) : undefined);
      }
      next = opts.dbOnly ? null : (await readManifest(join(root, next))).base;
    }
    return { dir: join(root, dirName), cleanup: () => rm(root, { recursive: true, force: true }) };
  } catch (e) {
    await rm(root, { recursive: true, force: true });
    throw e;
  } finally {
    await store.close();
  }
}

/** Checks that the target is reachable and writable (folder mounted, USB plugged in, cloud credentials valid). */
export async function checkTarget(t: BackupTargetRow, secrets?: SecretBox): Promise<{ ok: boolean; message: string }> {
  if (isRemoteKind(t.kind)) {
    if (!secrets) return { ok: false, message: 'internal: secrets needed for cloud targets' };
    const store = remoteOf(t, secrets);
    try {
      const key = `.vpm-write-test-${process.pid}`;
      await store.put(key, Readable.from([Buffer.from('ok')]), 2);
      const seen = (await store.list(key)).some((o) => o.key === key);
      await store.remove([key]);
      return seen ? { ok: true, message: `${store.label} is reachable and writable` } : { ok: false, message: `Wrote a test file to ${store.label} but could not list it` };
    } catch (e) {
      return { ok: false, message: (e as Error).message };
    } finally {
      await store.close();
    }
  }
  try {
    const p = targetPath(t);
    if (!existsSync(p)) return { ok: false, message: `Folder ${p} does not exist (is the drive or share connected?)` };
    await access(p, constants.W_OK);
    const probe = join(p, `.vpm-write-test-${process.pid}`);
    await writeFile(probe, 'ok');
    await unlink(probe);
    return { ok: true, message: `Folder ${p} is writable` };
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
}

export interface PerformBackupOptions {
  targetId: number;
  scheduleId?: number | null;
  kind: 'full' | 'incremental' | 'pre_update';
  onProgress?: (pct: number) => void;
}

export async function performBackup(ctx: CoreContext, o: PerformBackupOptions): Promise<{ runId: number; status: string; dirName: string | null; error?: string }> {
  const t = await one<BackupTargetRow>(ctx.db, 'SELECT * FROM backup_targets WHERE id = ?', [o.targetId]);
  if (!t) throw new Error('Backup target not found');
  const schema = await one<{ v: number }>(ctx.db, 'SELECT MAX(version) AS v FROM schema_migrations');
  const run = await exec(
    ctx.db,
    "INSERT INTO backup_runs (schedule_id, target_id, kind, status, started_at, app_version, schema_version) VALUES (?,?,?, 'running', ?, ?, ?)",
    [o.scheduleId ?? null, t.id, o.kind, new Date(), (await import('../migrate.js')).APP_VERSION, Number(schema?.v ?? 0)],
  );
  const runId = run.insertId;
  const alertKey = `backup.failed.${t.id}`;
  let lastPct = -1;
  const remote = isRemoteKind(t.kind);
  try {
    if (remote && !ctx.license.feature('backup_cloud')) throw new Error('Cloud backup (S3/FTP) is not included in this licence');
    const path = targetPath(t, ctx.config.dataPath);
    await mkdir(path, { recursive: true });
    const check = await checkTarget(t, ctx.secrets);
    if (!check.ok) throw new Error(check.message);

    // Incremental: based on the newest good run on this target whose folder still exists.
    let base: { id: number; dirName: string; highMessageId: number } | null = null;
    if (o.kind === 'incremental') {
      const b = await one<{ id: number; dir_name: string; high_message_id: number }>(
        ctx.db,
        "SELECT id, dir_name, high_message_id FROM backup_runs WHERE target_id = ? AND status IN ('ok','verified') AND dir_name IS NOT NULL ORDER BY id DESC LIMIT 1",
        [t.id],
      );
      // Folder targets: the base folder must still exist. Cloud targets: trust the record (checked nightly).
      if (b && (remote || existsSync(join(path, b.dir_name, 'manifest.json')))) base = { id: b.id, dirName: b.dir_name, highMessageId: Number(b.high_message_id) };
    }
    const kind = o.kind === 'incremental' && !base ? 'full' : o.kind;
    const res = await runBackup({
      db: ctx.db,
      dataPath: ctx.config.dataPath,
      targetPath: path,
      kind,
      runId,
      installId: ctx.config.installId,
      hostname: ctx.config.hostname,
      base: base ? { dirName: base.dirName, highMessageId: base.highMessageId } : null,
      onProgress: (pct) => {
        if (pct === lastPct || (pct % 5 !== 0 && pct !== 100)) return;
        lastPct = pct;
        o.onProgress?.(pct);
        void exec(ctx.db, 'UPDATE backup_runs SET progress = ? WHERE id = ?', [pct, runId]).catch(() => {});
      },
    });
    await exec(
      ctx.db,
      `UPDATE backup_runs SET kind = ?, base_run_id = ?, status = 'verifying', finished_at = ?, high_message_id = ?, file_count = ?, bytes = ?,
         manifest_path = ?, manifest_sha256 = ?, dir_name = ?, progress = 100 WHERE id = ?`,
      [kind, base?.id ?? null, new Date(), res.manifest.highMessageId, res.files, res.bytes, join(path, res.dirName, 'manifest.json'), res.manifestSha256, res.dirName, runId],
    );
    // Incrementals on cloud targets: the base run lives remotely; verify this run's own files only.
    const v = await verifyBackup(join(path, res.dirName), remote ? { ignoreChain: true } : undefined);
    const status = v.ok ? 'verified' : 'corrupt';
    await exec(ctx.db, 'UPDATE backup_runs SET status = ?, verified_at = ?, error = ? WHERE id = ?', [status, new Date(), [...v.problems, ...v.warnings].join('\n').slice(0, 60000) || null, runId]);
    if (!v.ok) throw new Error(`Backup written but failed verification: ${v.problems.slice(0, 3).join('; ')}`);
    if (remote) {
      try {
        const up = await uploadRun(t, ctx.secrets, path, res.dirName);
        await exec(ctx.db, 'UPDATE backup_runs SET remote_objects = ?, remote_bytes = ? WHERE id = ?', [up.objects, up.bytes, runId]);
      } finally {
        await rm(join(path, res.dirName), { recursive: true, force: true });
      }
    }
    if (v.warnings.length) await raiseAlert(ctx.db, { severity: 'warning', code: 'store.missing', message: v.warnings.join('; '), dedupeKey: 'store.missing' });
    await resolveAlert(ctx.db, alertKey);
    await resolveAlert(ctx.db, 'backup.stale');
    if (o.scheduleId) await rotate(ctx, t, path, o.scheduleId);
    if (remote) await rm(path, { recursive: true, force: true }).catch(() => undefined);
    return { runId, status, dirName: res.dirName };
  } catch (e) {
    const msg = (e as Error).message;
    await exec(ctx.db, "UPDATE backup_runs SET status = IF(status = 'corrupt', 'corrupt', 'failed'), finished_at = ?, error = ? WHERE id = ?", [new Date(), msg.slice(0, 60000), runId]);
    await raiseAlert(ctx.db, { severity: 'critical', code: 'backup.failed', message: `Backup to "${t.name}" failed: ${msg}`, dedupeKey: alertKey });
    return { runId, status: 'failed', dirName: null, error: msg };
  }
}

/** Keeps the newest `keep_full` full backups of a schedule (and the incrementals built on them). */
async function rotate(ctx: CoreContext, t: BackupTargetRow, path: string, scheduleId: number): Promise<void> {
  const s = await one<{ keep_full: number }>(ctx.db, 'SELECT keep_full FROM backup_schedules WHERE id = ?', [scheduleId]);
  if (!s || s.keep_full < 1) return;
  const fulls = await rows<{ id: number }>(
    ctx.db,
    "SELECT id FROM backup_runs WHERE target_id = ? AND schedule_id = ? AND kind = 'full' AND status IN ('ok','verified') ORDER BY id DESC",
    [t.id, scheduleId],
  );
  for (const old of fulls.slice(s.keep_full)) {
    // The full run plus every incremental chained on it.
    const doomed = [old.id];
    for (let i = 0; i < doomed.length; i++) {
      const kids = await rows<{ id: number }>(ctx.db, "SELECT id FROM backup_runs WHERE base_run_id = ? AND status <> 'expired'", [doomed[i]]);
      doomed.push(...kids.map((k) => k.id));
    }
    for (const id of doomed) {
      const r = await one<{ dir_name: string | null }>(ctx.db, 'SELECT dir_name FROM backup_runs WHERE id = ?', [id]);
      if (r?.dir_name) {
        if (isRemoteKind(t.kind)) {
          const store = remoteOf(t, ctx.secrets);
          try {
            await store.remove((await store.list(`${r.dir_name}/`)).map((o) => o.key));
          } finally {
            await store.close();
          }
        } else await rm(join(path, r.dir_name), { recursive: true, force: true });
      }
      await exec(ctx.db, "UPDATE backup_runs SET status = 'expired' WHERE id = ?", [id]);
    }
  }
}

/** Re-verifies the newest good backup of every target (nightly integrity check). */
export async function verifyLatestBackups(ctx: CoreContext): Promise<void> {
  const targets = await rows<BackupTargetRow>(ctx.db, 'SELECT * FROM backup_targets WHERE is_enabled = 1');
  for (const t of targets) {
    const r = await one<{ id: number; dir_name: string; remote_objects: number | null; remote_bytes: number | null }>(
      ctx.db,
      "SELECT id, dir_name, remote_objects, remote_bytes FROM backup_runs WHERE target_id = ? AND status IN ('ok','verified') AND dir_name IS NOT NULL ORDER BY id DESC LIMIT 1",
      [t.id],
    );
    if (!r) continue;
    let ok = false;
    let detail = '';
    try {
      if (isRemoteKind(t.kind)) {
        // Nightly: every uploaded file is still there with its size (a full download check runs on request).
        const store = remoteOf(t, ctx.secrets);
        try {
          const listed = await store.list(`${r.dir_name}/`);
          const bytes = listed.reduce((a, o) => a + o.size, 0);
          ok = listed.length === Number(r.remote_objects) && bytes === Number(r.remote_bytes);
          detail = ok ? '' : `${listed.length} of ${r.remote_objects} files (${bytes} of ${r.remote_bytes} bytes) are on ${store.label}`;
        } finally {
          await store.close();
        }
      } else {
        const v = await verifyBackup(join(targetPath(t), r.dir_name));
        ok = v.ok;
        detail = v.problems.slice(0, 3).join('; ');
      }
    } catch (e) {
      detail = (e as Error).message;
    }
    await exec(ctx.db, 'UPDATE backup_runs SET status = ?, verified_at = ?, error = ? WHERE id = ?', [ok ? 'verified' : 'corrupt', new Date(), ok ? null : detail, r.id]);
    if (!ok) await raiseAlert(ctx.db, { severity: 'critical', code: 'backup.corrupt', message: `The latest backup on "${t.name}" failed its integrity check: ${detail}`, dedupeKey: `backup.corrupt.${t.id}` });
    else await resolveAlert(ctx.db, `backup.corrupt.${t.id}`);
  }
}

/** Alerts when backups are scheduled but none has succeeded for `hours`. */
export async function checkBackupFreshness(ctx: CoreContext, hours = 48): Promise<void> {
  const sched = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM backup_schedules WHERE is_enabled = 1');
  if (!Number(sched?.n)) return;
  const last = await one<{ t: Date | null }>(ctx.db, "SELECT MAX(finished_at) t FROM backup_runs WHERE status IN ('ok','verified')");
  const age = last?.t ? Date.now() - new Date(last.t).getTime() : Infinity;
  if (age > hours * 3600_000) {
    await raiseAlert(ctx.db, { severity: 'critical', code: 'backup.stale', message: `No successful backup in the last ${hours} hours.`, dedupeKey: 'backup.stale' });
  }
}
