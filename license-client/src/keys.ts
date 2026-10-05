// Public keys that sign Vayrone PostMaster licences, revocations and the
// program-file integrity manifest. Only public keys live here; the private
// key stays on the License Server host (see scripts/license-keygen.mjs).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KeyRing } from './format.js';
import { RELEASE } from './release.js';

/** Production keys, by key id. Filled in by `node scripts/license-keygen.mjs`. */
export const VAYRONE_KEYS: KeyRing = {
  // BEGIN VAYRONE KEYS (managed by scripts/license-keygen.mjs)
  // END VAYRONE KEYS
};

/**
 * Development builds additionally trust `<dataPath>/dev-license-keys/<kid>.pem`
 * (public keys only)
 * so a local License Server can issue test licences. Release builds never do.
 */
export function trustedKeys(dataPath: string): KeyRing {
  if (RELEASE) return { ...VAYRONE_KEYS };
  const ring: KeyRing = { ...VAYRONE_KEYS };
  const dir = join(dataPath, 'dev-license-keys');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) if (f.endsWith('.pem') && !(f.slice(0, -4) in VAYRONE_KEYS)) ring[f.slice(0, -4)] = readFileSync(join(dir, f), 'utf8');
  }
  return ring;
}
