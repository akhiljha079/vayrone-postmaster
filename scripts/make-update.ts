// Signs a release folder as an update package and writes the channel index.
//
//   npx tsx scripts/make-update.ts <release-dir> --key <private.pem> --kid <id>
//        [--channel stable|beta] [--min-version 0.3.0] [--notes notes.txt] [--out dist/updates]
//
// Upload the output to the update server:
//   <updateUrl>/<channel>/<target>/latest.vidx      signed index (version, size, SHA-256, notes)
//   <updateUrl>/<channel>/<target>/<package file>   the .vpmupdate
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createPrivateKey } from 'node:crypto';
import { signDoc, UPDATE_INDEX_FORMAT, writeUpdatePackage, type Channel, type UpdateIndexPayload, type UpdatePayload } from '../license-client/src/index.js';

const args = process.argv.slice(2);
const dir = args[0];
const opt = (k: string, d?: string) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
if (!dir || !opt('key') || !opt('kid')) {
  console.error('Usage: npx tsx scripts/make-update.ts <release-dir> --key <private.pem> --kid <id> [--channel stable|beta] [--min-version x] [--notes file] [--out dir]');
  process.exit(1);
}
const release = JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8')) as { version: string; target: string; format: 'sea' | 'node'; release: boolean };
if (!release.release) console.warn('Warning: this is not a --release build (development keys, integrity not enforced).');
const channel = (opt('channel', 'stable') as Channel) ?? 'stable';
const key = createPrivateKey(readFileSync(opt('key')!, 'utf8'));
const kid = opt('kid')!;
const outDir = resolve(opt('out', join('dist', 'updates', channel, release.target))!);
mkdirSync(outDir, { recursive: true });
const file = `vayrone-postmaster-${release.version}-${release.target}.vpmupdate`;
const meta = {
  version: release.version,
  target: release.target,
  packageFormat: release.format,
  channel,
  releasedAt: new Date().toISOString(),
  minVersion: opt('min-version', '0.0.0')!,
  notes: opt('notes') ? readFileSync(opt('notes')!, 'utf8').slice(0, 20_000) : '',
};
const r = await writeUpdatePackage(resolve(dir), join(outDir, file), meta, (p: UpdatePayload) => signDoc(p, key, kid));
const index: UpdateIndexPayload = { format: UPDATE_INDEX_FORMAT, product: 'postmaster', ...meta, file, size: r.size, sha256: r.sha256 };
writeFileSync(join(outDir, 'latest.vidx'), signDoc(index, key, kid));
console.log(`${basename(file)}: ${r.payload.files.length} files, ${(r.size / 1048576).toFixed(1)} MB, sha256 ${r.sha256}`);
console.log(`Index: ${join(outDir, 'latest.vidx')}`);
