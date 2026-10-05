#!/usr/bin/env node
// Creates the Vayrone licence signing key pair.
//
//   node scripts/license-keygen.mjs <kid> [private-key-path]
//
// * The PRIVATE key is written outside the repository (default
//   ~/.vayrone/license-signing-<kid>.pem, mode 600). Copy it to the License
//   Server host (config signingKeyFile) and to the offline release-signing
//   machine; never commit it and never ship it.
// * The PUBLIC key is added to license-client/src/keys.ts so product builds
//   trust it. Several kids can coexist (key rotation): keep old public keys
//   until every licence signed with them has been re-issued.
import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [kid, out] = process.argv.slice(2);
if (!kid || !/^[a-z0-9][a-z0-9-]{2,30}$/.test(kid)) {
  console.error('Usage: node scripts/license-keygen.mjs <kid, e.g. vy-2026-1> [private-key-path]');
  process.exit(1);
}
const keyPath = resolve(out ?? join(homedir(), '.vayrone', `license-signing-${kid}.pem`));
if (!relative(root, keyPath).startsWith('..')) {
  console.error(`Refusing to write the private key inside the repository (${keyPath}).`);
  process.exit(1);
}
if (existsSync(keyPath)) {
  console.error(`${keyPath} already exists; choose another kid or path.`);
  process.exit(1);
}
const keysFile = join(root, 'license-client', 'src', 'keys.ts');
const src = readFileSync(keysFile, 'utf8');
if (src.includes(`'${kid}':`)) {
  console.error(`Key id ${kid} is already in license-client/src/keys.ts`);
  process.exit(1);
}

const { privateKey, publicKey } = generateKeyPairSync('ed25519');
mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
const pub = publicKey.export({ type: 'spki', format: 'pem' }).toString().trim();
const entry = `  '${kid}': \`${pub}\n\`,\n`;
writeFileSync(keysFile, src.replace('  // END VAYRONE KEYS', `${entry}  // END VAYRONE KEYS`));
console.log(`Private key: ${keyPath}  (keep it secret; back it up offline)`);
console.log(`Public key added to license-client/src/keys.ts as '${kid}'.`);
console.log(`License Server config: "signingKeyFile": "<path on the server>", "signingKeyId": "${kid}"`);
