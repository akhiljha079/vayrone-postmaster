// Privileged updater: applies a staged update package.
//   Linux:   vayrone-postmaster-updater.path → .service (root, oneshot) → `vpm update-apply`
//   Windows: service "Vayrone PostMaster Updater" (LocalSystem) → `vpm updater` (polls every 10 s)
//
//  1. take <data>/updates/apply.json and re-verify the package (signature + every file hash)
//  2. check: same platform, newer version, direct update allowed (minVersion)
//  3. database snapshot (pre-update backup)
//  4. stop the services, swap the files (old files kept in <home>/.rollback)
//  5. start the services (they migrate the database) and wait for /api/health to report the new version
//  6. on any failure: stop, put the old files back, restore the database if its schema changed, start again
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync, appendFileSync } from 'node:fs';
import { mkdir, rename, rm, readdir } from 'node:fs/promises';
import { request } from 'node:https';
import { request as httpRequest } from 'node:http';
import { dirname, join, relative, sep } from 'node:path';
import { promisify } from 'node:util';
import {
  db as dbm,
  latestSchemaVersion,
  restoreFull,
  runBackup,
  takeApplyRequest,
  updateHistory,
  updatesDir,
  type CoreConfig,
} from '@vpm/core';
import { compareVersions, currentTarget, extractUpdate, readUpdateManifest, trustedKeys, type KeyRing, type UpdatePayload } from '@vpm/license-client';
import { ensureServices } from './watchdog.js';

const run = promisify(execFile);

export interface ServiceControl {
  stop(): Promise<void>;
  start(): Promise<void>;
}

export const SERVICES = { linux: ['vayrone-postmaster-worker', 'vayrone-postmaster'], win: ['VayronePostMasterWorker', 'VayronePostMaster'] };

async function waitWindows(name: string, state: 'STOPPED' | 'RUNNING', ms = 90_000): Promise<void> {
  const until = Date.now() + ms;
  for (;;) {
    const { stdout } = await run('sc.exe', ['query', name]).catch(() => ({ stdout: '' }));
    if (stdout.includes(state)) return;
    if (Date.now() > until) throw new Error(`${name} did not reach ${state}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

export function systemServices(): ServiceControl {
  if (process.platform === 'win32') {
    return {
      async stop() {
        for (const s of SERVICES.win) {
          await run('sc.exe', ['stop', s]).catch(() => undefined);
          await waitWindows(s, 'STOPPED');
        }
      },
      async start() {
        for (const s of [...SERVICES.win].reverse()) {
          await run('sc.exe', ['start', s]).catch(() => undefined);
          await waitWindows(s, 'RUNNING');
        }
      },
    };
  }
  return {
    async stop() {
      await run('systemctl', ['stop', ...SERVICES.linux]);
    },
    async start() {
      await run('systemctl', ['start', ...[...SERVICES.linux].reverse()]);
    },
  };
}

/** GET /api/health on the local web port; resolves with the reported version. */
export function localHealth(config: CoreConfig): Promise<string | null> {
  const host = ['0.0.0.0', '::', ''].includes(config.listenHost) ? '127.0.0.1' : config.listenHost;
  const req = config.web.tls ? request : httpRequest;
  return new Promise((ok) => {
    const r = req({ host, port: config.web.port, path: '/api/health', method: 'GET', rejectUnauthorized: false, timeout: 5000 }, (res) => {
      let body = '';
      res.on('data', (c: Buffer) => (body += c.toString()));
      res.on('end', () => {
        try {
          ok((JSON.parse(body) as { version?: string }).version ?? null);
        } catch {
          ok(null);
        }
      });
    });
    r.on('error', () => ok(null));
    r.on('timeout', () => r.destroy());
    r.end();
  });
}

async function listFiles(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(relative(dir, p).split(sep).join('/'));
    }
  }
  await walk(dir);
  return out;
}

/** Program files this updater manages: everything in the new package, plus the old bin/, db/, web/ trees. */
async function managedOldFiles(home: string, p: UpdatePayload): Promise<string[]> {
  const set = new Set(p.files.map((f) => f.path));
  for (const d of ['bin', 'db', 'web']) for (const f of await listFiles(join(home, d))) set.add(`${d}/${f}`);
  return [...set].filter((f) => existsSync(join(home, f)));
}

export interface ApplyOptions {
  config: CoreConfig;
  home: string;
  keys?: KeyRing;
  services?: ServiceControl;
  health?: (config: CoreConfig) => Promise<string | null>;
  healthTimeoutMs?: number;
  installedVersion?: string;
  log?: (m: string) => void;
}

export type ApplyOutcome = { result: 'none' } | { result: 'installed' | 'rolled_back' | 'failed'; version: string; message: string; binaryChanged: boolean };

export async function applyPendingUpdate(o: ApplyOptions): Promise<ApplyOutcome> {
  const { config, home } = o;
  const logFile = join(updatesDir(config.dataPath), 'update.log');
  const lines: string[] = [];
  const say = (m: string) => {
    const line = `${new Date().toISOString()} ${m}`;
    lines.push(line);
    appendFileSync(logFile, `${line}\n`);
    o.log?.(m);
  };
  const req = takeApplyRequest(config.dataPath);
  if (!req) return { result: 'none' };
  const db = dbm.createPool({ ...config.db, connectionLimit: 2 });
  const services = o.services ?? systemServices();
  const health = o.health ?? localHealth;
  const step = async (status: Parameters<typeof updateHistory>[2], line: string) => {
    say(line);
    await updateHistory(db, req.historyId, status, line).catch(() => undefined);
  };
  const installed = o.installedVersion ?? (existsSync(join(home, 'VERSION')) ? readFileSync(join(home, 'VERSION'), 'utf8').trim() : '0.0.0');
  const staging = join(home, '.update-staging');
  const rollback = join(home, '.rollback');
  let swapped: { moved: string[]; added: string[] } | null = null;
  let stopped = false;
  let schemaBefore = 0;
  let snapshot: string | null = null;
  let payload: UpdatePayload | null = null;

  try {
    // 1–2. verify
    await step('verifying', `Update to ${req.version} requested (${req.requestedBy ?? 'unknown'}); verifying ${req.package}`);
    const keys = o.keys ?? trustedKeys(config.dataPath);
    payload = (await readUpdateManifest(req.package, keys)).payload;
    if (payload.version !== req.version) throw new Error(`Package is version ${payload.version}, request was for ${req.version}`);
    if (payload.target !== currentTarget()) throw new Error(`Package is for ${payload.target}; this server is ${currentTarget()}`);
    if (compareVersions(payload.version, installed) <= 0) throw new Error(`Version ${payload.version} is not newer than the installed ${installed}`);
    if (compareVersions(installed, payload.minVersion) < 0) throw new Error(`Version ${installed} must first be updated to ${payload.minVersion} or later`);
    await rm(staging, { recursive: true, force: true });
    await extractUpdate(req.package, keys, staging);
    await step(null, `Package verified: ${payload.files.length} files`);

    // 3. database snapshot
    await step('backing_up', 'Saving a database snapshot');
    schemaBefore = await latestSchemaVersion(db);
    const snapRoot = updatesDir(config.dataPath, 'pre-update');
    const b = await runBackup({ db, dataPath: config.dataPath, targetPath: snapRoot, kind: 'pre_update', runId: req.historyId, installId: config.installId, hostname: config.hostname, dbOnly: true });
    snapshot = join(snapRoot, b.dirName);
    await step(null, `Snapshot: ${b.dirName} (${b.manifest.tables.length} tables)`);
    for (const old of readdirSync(snapRoot).filter((d) => d.startsWith('vpm-pre_update-')).sort().slice(0, -3)) await rm(join(snapRoot, old), { recursive: true, force: true });

    // 4. swap files
    await step('migrating', 'Stopping services');
    await services.stop();
    stopped = true;
    await rm(rollback, { recursive: true, force: true });
    const moved: string[] = [];
    const added: string[] = [];
    swapped = { moved, added };
    for (const f of await managedOldFiles(home, payload)) {
      await mkdir(dirname(join(rollback, f)), { recursive: true });
      await rename(join(home, f), join(rollback, f)); // works for the running executable too (Windows allows renaming it)
      moved.push(f);
    }
    for (const f of payload.files) {
      await mkdir(dirname(join(home, f.path)), { recursive: true });
      await rename(join(staging, f.path), join(home, f.path));
      added.push(f.path);
    }
    await rm(staging, { recursive: true, force: true });
    await step(null, `Installed ${added.length} files; starting services`);

    // 5. start and check
    await services.start();
    const until = Date.now() + (o.healthTimeoutMs ?? 180_000);
    let seen: string | null = null;
    while (Date.now() < until) {
      seen = await health(config);
      if (seen === payload.version) break;
      await new Promise((r) => setTimeout(r, 2000));
    }
    if (seen !== payload.version) throw new Error(`The new version did not come up (health check reported ${seen ?? 'no answer'})`);
    await step('installed', `Vayrone PostMaster ${payload.version} is running`);
    await updateHistory(db, req.historyId, 'installed', null, true);
    return { result: 'installed', version: payload.version, message: 'installed', binaryChanged: payload.files.some((f) => f.path.startsWith('bin/')) };
  } catch (e) {
    const why = (e as Error).message;
    await step(null, `Update failed: ${why}`);
    if (!swapped) {
      await rm(staging, { recursive: true, force: true });
      if (stopped) await services.start().catch(() => undefined);
      await updateHistory(db, req.historyId, 'failed', null, true).catch(() => undefined);
      await db.end();
      return { result: 'failed', version: req.version, message: why, binaryChanged: false };
    }
    // 6. roll back
    try {
      await step(null, 'Rolling back to the previous version');
      await services.stop().catch(() => undefined);
      for (const f of swapped.added) await rm(join(home, f), { force: true });
      for (const f of swapped.moved) {
        await mkdir(dirname(join(home, f)), { recursive: true });
        await rename(join(rollback, f), join(home, f));
      }
      const schemaNow = await latestSchemaVersion(db).catch(() => schemaBefore);
      if (schemaNow !== schemaBefore && snapshot) {
        await step(null, `Database schema changed (${schemaBefore} → ${schemaNow}); restoring the snapshot`);
        await restoreFull({ db: config.db, dataPath: config.dataPath, migrationsPath: join(home, 'db'), backupDir: snapshot, dropExisting: true, log: say });
        // The snapshot predates this run's log lines: write them back.
        await dbm.exec(db, 'UPDATE update_history SET log = ? WHERE id = ?', [`${lines.join('\n')}\n`, req.historyId]);
      }
      await services.start();
      await step('rolled_back', `Rolled back to ${installed}`);
      await updateHistory(db, req.historyId, 'rolled_back', null, true);
      return { result: 'rolled_back', version: req.version, message: why, binaryChanged: false };
    } catch (e2) {
      await step('failed', `ROLLBACK FAILED: ${(e2 as Error).message}. Old files are in ${rollback}; database snapshot in ${snapshot}. Contact Vayrone support.`);
      await updateHistory(db, req.historyId, 'failed', null, true).catch(() => undefined);
      return { result: 'failed', version: req.version, message: `${why}; rollback failed: ${(e2 as Error).message}`, binaryChanged: false };
    }
  } finally {
    await db.end().catch(() => undefined);
  }
}

/** Windows updater service: poll for requests; restart self (exit 75) after the executable was replaced. */
export async function runUpdaterLoop(o: Omit<ApplyOptions, 'log'> & { log: (m: string) => void }): Promise<never> {
  const alive = join(updatesDir(o.config.dataPath), 'updater.alive');
  for (let tick = 0; ; tick++) {
    writeFileSync(alive, new Date().toISOString());
    // Watchdog: restart PostMaster if it is not running (after a failed boot, a crash loop WinSW gave up on, …).
    if (tick % 3 === 0) await ensureServices(o.log, ['VayronePostMasterUpdater']).catch((err) => o.log(`watchdog error: ${(err as Error).message}`));
    try {
      const r = await applyPendingUpdate(o);
      if (r.result !== 'none') {
        o.log(`update ${r.result}: ${r.message}`);
        if (r.result === 'installed' && r.binaryChanged) process.exit(75);
      }
    } catch (err) {
      o.log(`updater error: ${(err as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, 10_000));
  }
}
