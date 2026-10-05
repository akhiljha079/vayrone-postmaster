// Program-file integrity. Release packages ship `integrity.vsig`: a signed list
// of SHA-256 hashes of the executable, web assets and migrations
// (scripts/sign-integrity.mjs, run by the Phase 10 build). A changed or
// missing file puts the licence into the 'tampered' state (admin panel
// read-only; mail keeps flowing).
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { INTEGRITY_FORMAT, verifyDoc, type IntegrityPayload, type KeyRing } from './format.js';
import { RELEASE } from './release.js';

export const INTEGRITY_FILE = 'integrity.vsig';

export interface IntegrityResult {
  status: 'ok' | 'skipped' | 'failed';
  problems: string[];
  checkedAt: Date;
}

/** Install folder of a release build: the executable is <root>/bin/vpm(.exe). */
export function appRoot(): string | null {
  return RELEASE ? resolve(dirname(process.execPath), '..') : null;
}

export function sha256File(path: string): Promise<string> {
  return new Promise((ok, fail) => {
    const h = createHash('sha256');
    createReadStream(path)
      .on('data', (c) => h.update(c))
      .on('end', () => ok(h.digest('hex')))
      .on('error', fail);
  });
}

export async function checkIntegrity(root: string | null, keys: KeyRing, required = RELEASE): Promise<IntegrityResult> {
  const checkedAt = new Date();
  const manifest = root ? join(root, INTEGRITY_FILE) : null;
  if (!manifest || !existsSync(manifest)) {
    return required ? { status: 'failed', problems: [`${INTEGRITY_FILE} is missing`], checkedAt } : { status: 'skipped', problems: [], checkedAt };
  }
  let payload: IntegrityPayload;
  try {
    payload = verifyDoc<IntegrityPayload>(INTEGRITY_FORMAT, readFileSync(manifest, 'utf8'), keys).payload;
  } catch (e) {
    return { status: 'failed', problems: [`${INTEGRITY_FILE}: ${(e as Error).message}`], checkedAt };
  }
  const problems: string[] = [];
  const base = resolve(root!);
  for (const [rel, want] of Object.entries(payload.files)) {
    const file = resolve(base, rel);
    if (!file.startsWith(base + sep)) {
      problems.push(`${rel}: path outside the install folder`);
      continue;
    }
    if (!existsSync(file)) problems.push(`${rel}: missing`);
    else if ((await sha256File(file)) !== want) problems.push(`${rel}: modified`);
  }
  return { status: problems.length ? 'failed' : 'ok', problems, checkedAt };
}
