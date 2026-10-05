// vpm — the one Vayrone PostMaster executable.
//
//   vpm core     mail listeners (SMTP/IMAP/POP3) + HTTPS web (API, SPA, setup wizard)
//   vpm worker   fetcher, outbound queue, jobs, scheduler, licence heartbeat
//   vpm all      both roles in one process (small sites, development)
//   vpm cli …    technician commands (init, migrate, license, backup, …)
//   vpm version
//
// Services: Windows (WinSW) `VayronePostMaster` + `VayronePostMasterWorker`;
// Linux `vayrone-postmaster.service` + `vayrone-postmaster-worker.service`.
// Exit code 75 means "restart me" (new ports/TLS from the setup wizard).
import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import {
  APP_VERSION,
  checkInstallSecurity,
  raiseAlert,
  resolveAlert,
  attachIpcPublisher,
  CoreService,
  ensureSetupToken,
  EXIT_RESTART,
  ipcToken,
  loadConfig,
  migrate,
  setupCompleted,
  watchRestart,
} from '@vpm/core';
import { runCli } from '@vpm/core/cli';
import { createLicensedContext } from '@vpm/license-client';
import { startWeb } from '@vpm/server/service';
import { startWorker } from '@vpm/worker/service';
import { defaultConfigPath, installHome } from './paths.js';
import { applyPendingUpdate, runUpdaterLoop } from './updater.js';

type Role = 'core' | 'worker' | 'all';

export async function runRole(role: Role): Promise<void> {
  const startedAt = new Date();
  const config = loadConfig(defaultConfigPath());
  const log = pino({ level: config.logLevel, base: { svc: `vpm-${role}` } });
  log.info({ version: APP_VERSION, role, config: defaultConfigPath() }, 'Vayrone PostMaster starting');
  await migrate(config.db, config.migrationsPath, (m) => log.info(m));
  const { ctx, license } = await createLicensedContext(config, { log });
  log.info({ mode: license.mode() }, license.evaluation().reason);
  // A failed promise somewhere must not take mail down; a real crash restarts the service.
  process.on('unhandledRejection', (err) => log.error({ err }, 'unhandled promise rejection'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'uncaught exception; exiting so the service manager restarts the process');
    setTimeout(() => process.exit(1), 500).unref();
  });
  const findings = checkInstallSecurity(config, defaultConfigPath());
  for (const f of findings) log.warn(f.message);
  if (role !== 'worker') {
    if (findings.length) await raiseAlert(ctx.db, { severity: findings.some((f) => f.severity === 'critical') ? 'critical' : 'warning', code: 'security.files', message: findings.map((f) => f.message).join(' '), dedupeKey: 'security.files' });
    else await resolveAlert(ctx.db, 'security.files');
  }

  const stops: (() => Promise<void>)[] = [];
  if (role === 'core' || role === 'all') {
    const svc = new CoreService(ctx);
    const ports = await svc.start();
    stops.push(() => svc.stop());
    log.info({ ports }, 'mail listeners started');
    const web = await startWeb(ctx, license);
    stops.push(() => web.stop());
    if (!(await setupCompleted(config.db))) {
      const token = ensureSetupToken(config.dataPath);
      log.warn(`Setup is not finished. Open ${config.web.tls ? 'https' : 'http'}://${config.hostname}:${web.port}/setup?token=${token}`);
    }
  }
  if (role === 'worker') {
    if (config.ipc.port > 0) attachIpcPublisher(ctx.events, config.ipc.port, await ipcToken(config.dataPath), ctx.log);
  }
  if (role === 'worker' || role === 'all') {
    const w = await startWorker(ctx, license);
    stops.push(() => w.stop());
  }

  let stopping = false;
  const stop = async (why: string, code: number) => {
    if (stopping) return;
    stopping = true;
    log.info({ why }, 'shutting down');
    const force = setTimeout(() => process.exit(code), 15_000);
    force.unref();
    for (const s of stops.reverse()) await s().catch((err) => log.error({ err }, 'stop failed'));
    license.stop();
    await ctx.db.end().catch(() => undefined);
    process.exit(code);
  };
  watchRestart(ctx.db, startedAt, (reason) => {
    log.warn({ reason }, 'restart requested; the service manager starts this process again');
    void stop(`restart: ${reason}`, EXIT_RESTART);
  });
  process.on('SIGINT', () => void stop('SIGINT', 0));
  process.on('SIGTERM', () => void stop('SIGTERM', 0));
}

/** Commands that need root on Linux; everything else runs as the service account. */
const ROOT_COMMANDS = new Set(['init', 'hwid', 'update-apply', 'updater']);

/**
 * Technician commands started by root (sudo vpm cli …) switch to the `vpm`
 * account first, so files they create stay usable by the services.
 */
export function dropRootPrivileges(cmd: string | undefined): boolean {
  if (process.platform === 'win32' || typeof process.getuid !== 'function' || process.getuid() !== 0) return false;
  if ((cmd && ROOT_COMMANDS.has(cmd)) || process.env.VPM_AS_ROOT) return false;
  try {
    (process as NodeJS.Process & { initgroups?: (user: string, group: string) => void }).initgroups?.('vpm', 'vpm');
    process.setgid!('vpm');
    process.setuid!('vpm');
    return true;
  } catch {
    return false; // no vpm account (development machine)
  }
}

export async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  dropRootPrivileges(cmd);
  switch (cmd) {
    case 'core':
    case 'worker':
    case 'all':
      return runRole(cmd);
    case 'cli':
      return runCli(rest, { home: installHome(), configPath: defaultConfigPath() });
    case 'init':
    case 'hwid':
    case 'setup-token':
    case 'migrate':
      return runCli([cmd, ...rest], { home: installHome(), configPath: defaultConfigPath() });
    case 'update-apply': {
      // Linux: started by vayrone-postmaster-updater.service (root) when apply.json appears.
      const config = loadConfig(defaultConfigPath());
      const r = await applyPendingUpdate({ config, home: installHome(), log: (m) => console.log(m) });
      if (r.result === 'none') console.log('No update request pending.');
      else if (r.result !== 'installed') process.exitCode = 1;
      return;
    }
    case 'updater': {
      // Windows: the "Vayrone PostMaster Updater" service.
      const config = loadConfig(defaultConfigPath());
      return runUpdaterLoop({ config, home: installHome(), log: (m) => console.log(m) });
    }
    case 'gen-secret':
      // Installers use this for the bundled database's root password.
      console.log(randomBytes(Math.min(64, Math.max(16, Number(rest[0]) || 24))).toString('base64url'));
      return;
    case 'version':
    case '--version':
      console.log(`Vayrone PostMaster ${APP_VERSION} — Vayrone Infratech`);
      return;
    default:
      console.log(`Vayrone PostMaster ${APP_VERSION} by Vayrone Infratech
Usage: vpm <core|worker|all|cli|init|setup-token|hwid|version>
  core     mail server + web admin (service)
  worker   fetcher, outbound queue, backups (service)
  all      everything in one process
  cli      technician commands (vpm cli help)`);
      if (cmd && cmd !== 'help') process.exitCode = 1;
  }
}
