// Writes integrity.vsig for a release folder: the SHA-256 of every shipped
// file, signed with the Vayrone licence key. Run by the Phase 10 release build
// after compilation, on the signing machine.
//
//   npx tsx scripts/sign-integrity.ts <release-folder> <private-key.pem> <kid> <version>
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { INTEGRITY_FORMAT, signDoc, type IntegrityPayload } from '../license-client/src/format.js';

const [dir, keyFile, kid, version] = process.argv.slice(2);
if (!dir || !keyFile || !kid || !version) {
  console.error('Usage: npx tsx scripts/sign-integrity.ts <release-folder> <private-key.pem> <kid> <version>');
  process.exit(1);
}
// Data, logs and configuration live outside the install folder and are not hashed.
const SKIP = new Set(['integrity.vsig']);
const files: Record<string, string> = {};
(function walk(d: string): void {
  for (const name of readdirSync(d).sort()) {
    const p = join(d, name);
    if (statSync(p).isDirectory()) walk(p);
    else {
      const rel = relative(dir!, p).split(sep).join('/');
      if (SKIP.has(rel)) continue;
      if (rel.endsWith('.map')) {
        console.error(`Refusing to sign: source map in release (${rel})`);
        process.exit(1);
      }
      files[rel] = createHash('sha256').update(readFileSync(p)).digest('hex');
    }
  }
})(dir!);
writeFileSync(join(dir!, 'integrity.vsig'), signDoc<IntegrityPayload>({ format: INTEGRITY_FORMAT, version: version!, files, issuedAt: new Date().toISOString() }, readFileSync(keyFile!, 'utf8'), kid!));
console.log(`integrity.vsig: ${Object.keys(files).length} files signed with ${kid}`);
