#!/usr/bin/env node
// Builds an installable release folder for one platform.
//
// --format sea (default; must run ON the target platform, e.g. in CI):
//   release/<target>/
//     bin/vpm(.exe)          one executable: Node.js 24 + the server compiled to V8
//                            bytecode (no JavaScript source inside), licensing code
//                            obfuscated before compilation
//     db/  web/              migrations + schema, built SPA
//     LEGAL.txt              licence notices of the bundled open-source code
//     integrity.vsig         signed SHA-256 list of every file (with --sign-key)
//
// --format node (any build machine; development, Docker, cross builds):
//     app/vpm.mjs + runtime/node(.exe) + bin/vpm launcher
//
//   node scripts/build-release.mjs [--target linux-x64|linux-arm64|win-x64|darwin-x64]
//        [--format sea|node] [--release] [--sign-key key.pem --kid vy-2026-1] [--no-runtime]
//
// --release turns off development behaviour (dev licence keys, missing integrity
// manifest tolerated) and requires a production public key and --sign-key.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, transform } from 'esbuild';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const hostTarget = `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
const target = opt('target', hostTarget);
const format = opt('format', target === hostTarget ? 'sea' : 'node');
const out = resolve(opt('out', join(root, 'release', target)));
const release = args.includes('--release');
const signKey = opt('sign-key');
const kid = opt('kid');
const nodeLine = opt('node', 'latest-v24.x');
const [os, arch] = target.split('-');
const exe = os === 'win' ? '.exe' : '';
if (!['linux', 'win', 'darwin'].includes(os) || !['x64', 'arm64'].includes(arch)) throw new Error(`Unknown target ${target}`);
if (!['sea', 'node'].includes(format)) throw new Error('--format must be sea or node');
if (format === 'sea' && target !== hostTarget) {
  throw new Error(`--format sea compiles V8 bytecode with the target's Node.js and must run on ${target} (this machine is ${hostTarget}). Use CI (.github/workflows/release.yml) or --format node.`);
}
const appVersion = /APP_VERSION = '([^']+)'/.exec(readFileSync(join(root, 'core/src/migrate.ts'), 'utf8'))[1];
const log = (m) => console.log(`[build] ${m}`);

if (release) {
  if (!/BEGIN PUBLIC KEY/.test(readFileSync(join(root, 'license-client/src/keys.ts'), 'utf8'))) {
    throw new Error('--release needs a production public key in license-client/src/keys.ts (scripts/license-keygen.mjs)');
  }
  if (!signKey || !kid) throw new Error('--release needs --sign-key <pem> --kid <id> (release builds refuse to start without a signed integrity manifest)');
}

// ---------------------------------------------------------------- Node.js runtime
function nodeRuntime() {
  const base = `https://nodejs.org/dist/${nodeLine}`;
  const cache = join(root, '.cache', 'node-dist');
  mkdirSync(cache, { recursive: true });
  const ext = os === 'win' ? 'zip' : 'tar.xz';
  const sums = execFileSync('curl', ['-fsSL', `${base}/SHASUMS256.txt`]).toString();
  const line = sums.split('\n').find((l) => new RegExp(`node-v24\\.[0-9.]+-${os}-${arch}\\.${ext.replace('.', '\\.')}$`).test(l));
  if (!line) throw new Error(`No Node.js 24 build for ${target}`);
  const [sha, file] = line.trim().split(/\s+/);
  const archive = join(cache, file);
  if (!existsSync(archive)) {
    log(`downloading ${file}`);
    execFileSync('curl', ['-fsSL', '-o', archive, `${base}/${file}`]);
  }
  if (createHash('sha256').update(readFileSync(archive)).digest('hex') !== sha) throw new Error(`Checksum mismatch for ${file}`);
  const dir = join(cache, file.replace(/\.(zip|tar\.xz)$/, ''));
  if (!existsSync(dir)) {
    if (ext === 'zip') execFileSync(os === 'win' && process.platform === 'win32' ? 'tar' : 'unzip', os === 'win' && process.platform === 'win32' ? ['-xf', archive, '-C', cache] : ['-q', archive, '-d', cache]);
    else execFileSync('tar', ['-xJf', archive, '-C', cache]);
  }
  return { bin: os === 'win' ? join(dir, 'node.exe') : join(dir, 'bin/node'), license: join(dir, 'LICENSE'), file };
}

// ---------------------------------------------------------------- licensing code obfuscation
/** esbuild plugin: obfuscates license-client sources (javascript-obfuscator, BSD-2-Clause). */
const obfuscateLicensing = {
  name: 'obfuscate-licensing',
  setup(b) {
    b.onLoad({ filter: /license-client[\\/]src[\\/].*\.ts$/ }, async (a) => {
      const { default: JavaScriptObfuscator } = await import('javascript-obfuscator');
      const js = (await transform(readFileSync(a.path, 'utf8'), { loader: 'ts', format: 'esm', target: 'node22' })).code;
      const obf = JavaScriptObfuscator.obfuscate(js, {
        target: 'node',
        sourceType: 'module',
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.5,
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 0.2,
        identifierNamesGenerator: 'hexadecimal',
        renameGlobals: false,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayThreshold: 1, // every string literal is encoded
        seed: 0x56504d, // reproducible builds
        splitStrings: true,
        splitStringsChunkLength: 8,
        transformObjectKeys: true,
        selfDefending: false,
        sourceMap: false,
      });
      return { contents: obf.getObfuscatedCode(), loader: 'js' };
    });
  },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'bin'), { recursive: true });
const work = join(tmpdir(), `vpm-build-${process.pid}`);
mkdirSync(work, { recursive: true });

// 1. Web SPA
log('building web SPA');
execFileSync(process.execPath, [join(root, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: join(root, 'web'), stdio: 'inherit' });
cpSync(join(root, 'web/dist'), join(out, 'web'), { recursive: true });

// 2. Server bundle
log(`bundling server code (${format})`);
const define = {
  ...(release ? { __VPM_RELEASE__: 'true' } : {}),
  ...(format === 'sea' ? { __VPM_SEA__: 'true', 'import.meta.url': '__vpmImportMetaUrl' } : {}),
};
const bundleFile = format === 'sea' ? join(work, 'vpm.cjs') : join(out, 'app/vpm.mjs');
await build({
  entryPoints: [join(root, 'app/src/bin.ts')],
  outfile: bundleFile,
  bundle: true,
  platform: 'node',
  format: format === 'sea' ? 'cjs' : 'esm',
  target: 'node22',
  minify: true,
  sourcemap: false,
  legalComments: 'external',
  plugins: [obfuscateLicensing],
  define,
  banner: {
    js:
      format === 'sea'
        ? 'const __vpmImportMetaUrl = require("node:url").pathToFileURL(process.execPath).href;'
        : "import { createRequire as __vpmCreateRequire } from 'node:module'; const require = __vpmCreateRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
cpSync(`${bundleFile}.LEGAL.txt`, join(out, 'LEGAL.txt'));
if (format === 'node') rmSync(`${bundleFile}.LEGAL.txt`);

// 3. Executable
if (format === 'sea') {
  const node = nodeRuntime();
  log(`compiling to V8 bytecode with ${node.file}`);
  const info = JSON.parse(execFileSync(node.bin, [join(root, 'scripts/sea/compile-bytecode.cjs'), bundleFile, join(work, 'vpm.jsc')]).toString());
  log(`bytecode: ${(info.bytes / 1048576).toFixed(1)} MB for ${(info.sourceLength / 1048576).toFixed(1)} MB of JavaScript`);
  writeFileSync(
    join(work, 'sea.json'),
    JSON.stringify({ main: join(root, 'scripts/sea/loader.cjs'), output: join(work, 'sea.blob'), disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false, assets: { 'vpm.jsc': join(work, 'vpm.jsc') } }),
  );
  execFileSync(node.bin, ['--experimental-sea-config', join(work, 'sea.json')], { stdio: 'inherit' });
  const target = join(out, 'bin', `vpm${exe}`);
  cpSync(node.bin, target);
  chmodSync(target, 0o755);
  if (os === 'darwin') execFileSync('codesign', ['--remove-signature', target]);
  execFileSync(process.execPath, [
    join(root, 'node_modules/postject/dist/cli.js'),
    target,
    'NODE_SEA_BLOB',
    join(work, 'sea.blob'),
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(os === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ]);
  if (os === 'darwin') execFileSync('codesign', ['--sign', '-', target]);
  // Windows Authenticode signing (CI): VPM_SIGN_CMD="signtool sign /fd sha256 /tr <tsa> /td sha256 /f cert.pfx /p ..."
  if (os === 'win' && process.env.VPM_SIGN_CMD) execFileSync(`${process.env.VPM_SIGN_CMD} "${target}"`, { shell: true, stdio: 'inherit' });
  cpSync(node.license, join(out, 'NODEJS-LICENSE.txt'));
  const v = execFileSync(target, ['version']).toString().trim();
  log(`executable runs: ${v}`);
} else {
  if (os === 'win') writeFileSync(join(out, 'bin/vpm.cmd'), '@echo off\r\n"%~dp0..\\runtime\\node.exe" "%~dp0..\\app\\vpm.mjs" %*\r\n');
  else {
    writeFileSync(join(out, 'bin/vpm'), ['#!/bin/sh', '# Vayrone PostMaster launcher', 'HOME_DIR=$(CDPATH= cd -- "$(dirname -- "$(readlink -f -- "$0")")/.." && pwd)', 'exec "$HOME_DIR/runtime/node" "$HOME_DIR/app/vpm.mjs" "$@"', ''].join('\n'));
    chmodSync(join(out, 'bin/vpm'), 0o755);
  }
  if (!args.includes('--no-runtime')) {
    const node = nodeRuntime();
    mkdirSync(join(out, 'runtime'), { recursive: true });
    cpSync(node.bin, join(out, 'runtime', `node${exe}`));
    chmodSync(join(out, 'runtime', `node${exe}`), 0o755);
    cpSync(node.license, join(out, 'NODEJS-LICENSE.txt'));
    log(`runtime: ${node.file}`);
  }
}

// 4. Database migrations, notices
mkdirSync(join(out, 'db'), { recursive: true });
cpSync(join(root, 'db/migrations'), join(out, 'db/migrations'), { recursive: true });
for (const f of ['schema.sql', 'schema.manifest.json']) cpSync(join(root, 'db', f), join(out, 'db', f));
cpSync(join(root, 'THIRD_PARTY_LICENSES.md'), join(out, 'THIRD_PARTY_LICENSES.md'));
writeFileSync(join(out, 'VERSION'), `${appVersion}\n`);
const nl = os === 'win' ? '\r\n' : '\n';
writeFileSync(
  join(out, 'README.txt'),
  [
    `Vayrone PostMaster ${appVersion} by Vayrone Infratech`,
    '',
    'Services:  core (mail server + web admin) and worker (fetching, relay queue, backups).',
    os === 'win'
      ? 'Windows:   services "Vayrone PostMaster" and "Vayrone PostMaster Worker"; config in %ProgramData%\\Vayrone PostMaster.'
      : 'Linux:     systemctl status vayrone-postmaster vayrone-postmaster-worker; config in /etc/vayrone-postmaster, data in /var/lib/vayrone-postmaster.',
    'Setup:     vpm setup-token shows the setup wizard address until setup is finished.',
    'Commands:  vpm cli help',
    '',
    'Licences of included open-source components: THIRD_PARTY_LICENSES.md, LEGAL.txt, NODEJS-LICENSE.txt.',
    '(c) Vayrone Infratech, Agra, India. Proprietary software; redistribution is not permitted.',
    '',
  ].join(nl),
);

// 5. Checks: nothing that reveals source ships.
const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p);
    else files.push(relative(out, p).split('\\').join('/'));
  }
})(out);
const bad = files.filter((f) => /\.(map|ts|tsx|cjs)$/.test(f) || /(^|\/)(src|test)\//.test(f));
if (bad.length) throw new Error(`Refusing to ship source files: ${bad.join(', ')}`);
const shipped = format === 'sea' ? readFileSync(join(out, 'bin', `vpm${exe}`)) : readFileSync(bundleFile);
// (Only our bundle is checked: the Node.js binary carries its own internal sourceURL comments.)
if (/^\/\/[#@] sourceMappingURL=/m.test(readFileSync(bundleFile, 'utf8'))) throw new Error('Bundle references a source map');
// Any embedded private key fails the build, except smtp-server's public demo key
// (its fallback when no certificate is given; PostMaster always passes its own).
const KNOWN_PUBLIC_DEMO_KEYS = ['MIIEpAIBAAKCAQEA6Z5Qqhw+oWfhtEiMHE32Ht94mwTBpAfjt3vPpX8M7DMCTwHs'];
for (const m of shipped.toString('latin1').matchAll(/-----BEGIN [A-Z ]*PRIVATE KEY-----(?:\\n|\s)*([A-Za-z0-9+/]{40,64})/g)) {
  if (!KNOWN_PUBLIC_DEMO_KEYS.includes(m[1])) throw new Error(`Build contains a private key (${m[1].slice(0, 16)}…)`);
}
if (format === 'sea') {
  // The bundled JavaScript must not be inside the executable. Samples of it are
  // searched for; a few may match long string constants (SQL, templates), which
  // V8 keeps in the bytecode's constant table — embedded source would match all.
  const js = readFileSync(bundleFile, 'utf8');
  let tested = 0;
  const found = [];
  for (let i = 1; i < 200; i++) {
    const at = Math.floor((js.length * i) / 200);
    const s = js.slice(at, at + 80);
    if (!/[{}();=]/.test(s)) continue;
    tested++;
    if (shipped.includes(Buffer.from(s))) found.push(s);
  }
  if (found.length > tested * 0.1) throw new Error(`JavaScript source found inside the executable (${found.length}/${tested} samples): ${found[0]}`);
  if (found.length) log(`source check: ${found.length}/${tested} samples matched string constants, e.g. ${JSON.stringify(found[0].slice(0, 60))}`);
  // Licensing functions and constants must be obfuscated (renamed, strings encoded) before
  // compilation. Public method/property names stay: other modules and the UI use them.
  for (const marker of ['vpm-fp/1|', 'matchFingerprint', 'machineIdOf', 'fingerprintOf', 'graceOrReadonly']) {
    if (js.includes(marker)) throw new Error(`Licensing identifier "${marker}" survived obfuscation`);
  }
}
rmSync(work, { recursive: true, force: true });

// 6. Signed integrity manifest (verified by the product at every start)
if (signKey) {
  execFileSync(process.execPath, [join(root, 'node_modules/tsx/dist/cli.mjs'), join(root, 'scripts/sign-integrity.ts'), out, signKey, kid, appVersion], { stdio: 'inherit' });
}

writeFileSync(join(out, 'release.json'), JSON.stringify({ product: 'Vayrone PostMaster', version: appVersion, target, format, release, builtAt: new Date().toISOString(), files: files.length }, null, 2));
log(`done: ${out} (${format}, ${files.length} files)`);
