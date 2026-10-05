// Update state shared by the web role (download, stage, request), the worker
// (daily check) and the privileged updater (apply). Package verification lives
// in @vpm/license-client/update.
//
//   <data>/updates/download/   downloaded or uploaded .vpmupdate files
//   <data>/updates/apply.json  install request → picked up by the updater
//                              (Linux: systemd path unit; Windows: updater service)
//   <data>/updates/pre-update/ database snapshot taken before each update
//   <data>/updates/update.log  updater log
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Db } from './db.js';
import { exec, one } from './db.js';
import type { Settings } from './settings.js';

export const DEFAULT_UPDATE_URL = 'https://updates.vayrone.com/postmaster';

export interface UpdateSettings {
  channel: 'stable' | 'beta';
  url: string;
  autoCheck: boolean;
}

export const UPDATE_DEFAULTS: UpdateSettings = { channel: 'stable', url: DEFAULT_UPDATE_URL, autoCheck: true };

export async function updateSettings(s: Settings): Promise<UpdateSettings> {
  return { ...UPDATE_DEFAULTS, ...(await s.get<Partial<UpdateSettings>>('updates', 'config', {})) };
}

export function updatesDir(dataPath: string, ...sub: string[]): string {
  const d = join(dataPath, 'updates', ...sub);
  mkdirSync(d, { recursive: true });
  return d;
}

export interface ApplyRequest {
  historyId: number;
  /** Absolute path of the verified package under <data>/updates/download. */
  package: string;
  version: string;
  requestedAt: string;
  requestedBy: string | null;
}

export function applyRequestFile(dataPath: string): string {
  return join(updatesDir(dataPath), 'apply.json');
}

export function writeApplyRequest(dataPath: string, r: ApplyRequest): void {
  const f = applyRequestFile(dataPath);
  writeFileSync(`${f}.tmp`, JSON.stringify(r), { mode: 0o640 });
  renameSync(`${f}.tmp`, f);
}

/** Takes the pending request (moves it aside so it runs once). Paths outside the download folder are refused. */
export function takeApplyRequest(dataPath: string): ApplyRequest | null {
  const f = applyRequestFile(dataPath);
  if (!existsSync(f)) return null;
  const running = `${f}.running`;
  renameSync(f, running);
  try {
    const r = JSON.parse(readFileSync(running, 'utf8')) as ApplyRequest;
    const allowed = resolve(updatesDir(dataPath, 'download')) + sep;
    if (!resolve(r.package).startsWith(allowed) || !existsSync(r.package) || !statSync(r.package).isFile()) throw new Error('package outside the update folder');
    return r;
  } catch (e) {
    rmSync(running, { force: true });
    throw new Error(`Invalid update request: ${(e as Error).message}`);
  } finally {
    rmSync(running, { force: true });
  }
}

export type UpdateStatus = 'downloading' | 'verifying' | 'backing_up' | 'migrating' | 'installed' | 'rolled_back' | 'failed';

export async function startUpdateHistory(db: Db, h: { from: string; to: string; channel: 'stable' | 'beta' | 'offline'; sha256: string; userId: number | null }): Promise<number> {
  const r = await exec(db, "INSERT INTO update_history (from_version, to_version, channel, package_sha256, status, started_by, started_at, log) VALUES (?,?,?,?,'verifying',?,?,'')", [
    h.from,
    h.to,
    h.channel,
    h.sha256,
    h.userId,
    new Date(),
  ]);
  return r.insertId;
}

export async function updateHistory(db: Db, id: number, status: UpdateStatus | null, line: string | null, finished = false): Promise<void> {
  await exec(
    db,
    `UPDATE update_history SET status = COALESCE(?, status), log = CONCAT(COALESCE(log, ''), ?), finished_at = IF(?, ?, finished_at) WHERE id = ?`,
    [status, line ? `${new Date().toISOString()} ${line}\n` : '', finished ? 1 : 0, new Date(), id],
  );
}

/** Whether a privileged updater is installed to apply requests. */
export function updaterInstalled(dataPath: string): { ok: boolean; how: string } {
  if (process.platform === 'linux' && existsSync('/usr/lib/systemd/system/vayrone-postmaster-updater.path')) return { ok: true, how: 'systemd' };
  const alive = join(dataPath, 'updates', 'updater.alive');
  if (existsSync(alive) && Date.now() - statSync(alive).mtimeMs < 3 * 60_000) return { ok: true, how: 'service' };
  return { ok: false, how: 'none' };
}

export async function latestSchemaVersion(db: Db): Promise<number> {
  return Number((await one<{ v: number | null }>(db, 'SELECT MAX(version) AS v FROM schema_migrations'))?.v ?? 0);
}
