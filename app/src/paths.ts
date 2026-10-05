// Install layout of a packaged release:
//   <home>/bin/vpm(.exe)  single executable (V8 bytecode inside), or
//   <home>/app/vpm.mjs + <home>/runtime/node  (portable/development builds)
//   <home>/db/            migrations + schema.sql
//   <home>/web/           built SPA
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Single-executable builds (bin/vpm) define this at build time.
declare const __VPM_SEA__: boolean | undefined;
export const SEA: boolean = typeof __VPM_SEA__ !== 'undefined' && __VPM_SEA__ === true;

export function installHome(): string {
  if (process.env.VPM_HOME) return resolve(process.env.VPM_HOME);
  // <home>/bin/vpm(.exe)
  if (SEA) return resolve(dirname(process.execPath), '..');
  const here = dirname(fileURLToPath(import.meta.url));
  // Release: <home>/app/vpm.mjs. Source checkout: <repo>/app/src/vpm.ts.
  const release = resolve(here, '..');
  if (existsSync(join(release, 'db', 'schema.sql'))) return release;
  return resolve(here, '..', '..');
}

/** Default config file for this OS (the installers write it here). */
export function defaultConfigPath(): string {
  if (process.env.VPM_CONFIG) return process.env.VPM_CONFIG;
  if (existsSync('vpm.config.json')) return resolve('vpm.config.json');
  if (process.platform === 'win32') return join(process.env.ProgramData ?? 'C:\\ProgramData', 'Vayrone PostMaster', 'vpm.config.json');
  return '/etc/vayrone-postmaster/vpm.config.json';
}
