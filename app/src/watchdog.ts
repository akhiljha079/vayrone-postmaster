// Keeps PostMaster running on Windows. Two independent paths call this:
//   - the Updater service, every 30 s between update checks;
//   - the "Vayrone PostMaster\Start services" boot task (`vpm ensure-services`), as a backstop
//     for a boot where the database or a service failed to start (Windows never retries a
//     service whose dependency failed at boot).
// A service is started only when its start type is automatic: setting a service to Manual
// or Disabled in services.msc is how an administrator keeps it stopped.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Start order: the database first, the services that depend on it after. */
export const WATCHED = ['VayronePostMasterDB', 'VayronePostMaster', 'VayronePostMasterWorker', 'VayronePostMasterUpdater'];

export interface ServiceState {
  name: string;
  exists: boolean;
  running: boolean;
  automatic: boolean;
}

/** Parses `sc query` + `sc qc` output. Exported for tests. */
export function parseServiceState(name: string, query: string, qc: string): ServiceState {
  const exists = /STATE\s*:/.test(query);
  return {
    name,
    exists,
    running: /STATE\s*:\s*\d+\s+(RUNNING|START_PENDING)/.test(query),
    automatic: /START_TYPE\s*:\s*2\s/.test(qc), // 2 = AUTO_START (also "delayed")
  };
}

async function sc(...args: string[]): Promise<string> {
  // sc.exe exits non-zero for a stopped or missing service; the text is still what we need.
  return run('sc.exe', args, { windowsHide: true })
    .then((r) => r.stdout)
    .catch((e: { stdout?: string }) => e.stdout ?? '');
}

export async function serviceState(name: string): Promise<ServiceState> {
  return parseServiceState(name, await sc('query', name), await sc('qc', name));
}

/** Starts every automatic PostMaster service that is stopped. Returns the ones it started. */
export async function ensureServices(log: (m: string) => void, skip: string[] = []): Promise<string[]> {
  if (process.platform !== 'win32') return [];
  const started: string[] = [];
  for (const name of WATCHED) {
    if (skip.includes(name)) continue;
    const s = await serviceState(name);
    if (!s.exists || s.running || !s.automatic) continue;
    log(`watchdog: ${name} was stopped, starting it`);
    await sc('start', name);
    // Let the database accept connections before its dependants start.
    for (let i = 0; i < 30 && !(await serviceState(name)).running; i++) await new Promise((r) => setTimeout(r, 1000));
    started.push(name);
  }
  return started;
}
