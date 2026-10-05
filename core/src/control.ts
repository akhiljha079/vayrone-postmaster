// Service control shared by all roles: a restart request is a timestamp in
// the settings table. Every process polls it and exits with EXIT_RESTART;
// systemd (Restart=always) and WinSW (<onfailure action="restart"/>) start it
// again with the new configuration (ports, TLS certificate).
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Db } from './db.js';
import { exec, one } from './db.js';

export const EXIT_RESTART = 75;

export async function requestRestart(db: Db, reason: string): Promise<Date> {
  const at = new Date();
  await exec(
    db,
    `INSERT INTO settings (namespace, name, value, updated_at) VALUES ('system', 'restart', ?, ?)
     ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)`,
    [JSON.stringify({ at: at.toISOString(), reason }), at],
  );
  return at;
}

/** Calls onRestart once when a restart is requested after `since`. */
export function watchRestart(db: Db, since: Date, onRestart: (reason: string) => void, everyMs = 5000): () => void {
  let fired = false;
  const t = setInterval(async () => {
    if (fired) return;
    try {
      const r = await one<{ value: unknown }>(db, "SELECT value FROM settings WHERE namespace = 'system' AND name = 'restart'");
      if (!r) return;
      const v = (typeof r.value === 'string' ? JSON.parse(r.value) : r.value) as { at: string; reason: string };
      if (new Date(v.at) > since) {
        fired = true;
        onRestart(v.reason);
      }
    } catch {
      /* DB briefly unavailable: try again */
    }
  }, everyMs);
  t.unref();
  return () => clearInterval(t);
}

// ---------------------------------------------------------------- setup token
// Until the setup wizard is completed, its API needs this token (or a request
// from the server itself). The installer prints it with the wizard URL.
export const SETUP_TOKEN_FILE = 'setup.token';

export function ensureSetupToken(dataPath: string): string {
  const file = join(dataPath, SETUP_TOKEN_FILE);
  if (existsSync(file)) {
    const t = readFileSync(file, 'utf8').trim();
    if (t.length >= 16) return t;
  }
  const token = randomBytes(12).toString('base64url');
  writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

export function setupTokenMatches(dataPath: string, candidate: string | undefined): boolean {
  const file = join(dataPath, SETUP_TOKEN_FILE);
  if (!candidate || !existsSync(file)) return false;
  const want = Buffer.from(readFileSync(file, 'utf8').trim());
  const got = Buffer.from(candidate.trim());
  return want.length === got.length && timingSafeEqual(want, got);
}

export function removeSetupToken(dataPath: string): void {
  rmSync(join(dataPath, SETUP_TOKEN_FILE), { force: true });
}
