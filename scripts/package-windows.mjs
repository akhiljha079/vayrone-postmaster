#!/usr/bin/env node
// Builds the Windows installer:
//   1. release\win-x64 (scripts/build-release.mjs --target win-x64)
//   2. .cache\win\WinSW-x64.exe            (WinSW, MIT)
//   3. .cache\win\mariadb\                 (MariaDB LTS portable zip, GPLv2, unmodified)
//   4. ISCC installer\windows\vayrone-postmaster.iss → dist\VayronePostMaster-Setup-<ver>.exe
//
//   node scripts/package-windows.mjs [--mariadb 11.4] [--mariadb-zip path.zip] [--release] [--no-iscc]
// Steps 1–3 run on any OS; step 4 needs Windows with Inno Setup 6 (ISCC.exe on PATH
// or in "C:\Program Files (x86)\Inno Setup 6").
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const cache = join(root, '.cache', 'win');
const WINSW = { version: 'v2.12.0', file: 'WinSW-x64.exe' };
const log = (m) => console.log(`[win] ${m}`);
const sha256 = (f) => createHash('sha256').update(readFileSync(f)).digest('hex');
const curl = (url, out) => execFileSync('curl', ['-fsSL', ...(out ? ['-o', out] : []), url]);

mkdirSync(cache, { recursive: true });

// 1. program files: bin\vpm.exe is compiled on Windows (V8 bytecode is platform-specific).
const passthrough = ['--release', '--sign-key', '--kid'].flatMap((k) => (args.includes(k) ? (k === '--release' ? [k] : [k, opt(k.slice(2))]) : []));
if (process.platform === 'win32' && !args.includes('--skip-build')) {
  execFileSync(process.execPath, [join(root, 'scripts/build-release.mjs'), '--target', 'win-x64', '--format', 'sea', ...passthrough], { stdio: 'inherit' });
} else if (!existsSync(join(root, 'release/win-x64/bin/vpm.exe'))) {
  log('release\\win-x64 is built on Windows (CI: .github/workflows/release.yml); preparing the third-party inputs only.');
}
const version = existsSync(join(root, 'release/win-x64/VERSION')) ? readFileSync(join(root, 'release/win-x64/VERSION'), 'utf8').trim() : '0.0.0';

// 2. WinSW
const winsw = join(cache, WINSW.file);
if (!existsSync(winsw)) {
  log(`downloading WinSW ${WINSW.version}`);
  curl(`https://github.com/winsw/winsw/releases/download/${WINSW.version}/${WINSW.file}`, winsw);
}
log(`WinSW sha256 ${sha256(winsw)}`);
const winswLicense = join(cache, 'WinSW-LICENSE.txt');
if (!existsSync(winswLicense)) curl(`https://raw.githubusercontent.com/winsw/winsw/${WINSW.version}/LICENSE.txt`, winswLicense);

// 3. MariaDB portable (latest patch release of the chosen LTS line, checksum from mariadb.org)
const mdir = join(cache, 'mariadb');
if (!existsSync(join(mdir, 'bin', 'mariadb-install-db.exe'))) {
  let zip = opt('mariadb-zip');
  if (!zip) {
    const line = opt('mariadb', '11.4');
    const rel = JSON.parse(curl(`https://downloads.mariadb.org/rest-api/mariadb/${line}/latest/`).toString());
    const files = Object.values(rel.releases)[0].files;
    const f = files.find((x) => /winx64\.zip$/.test(x.file_name) && !/debugsymbols/.test(x.file_name));
    if (!f) throw new Error(`No Windows zip for MariaDB ${line}`);
    zip = join(cache, f.file_name);
    if (!existsSync(zip)) {
      // archive.mariadb.org serves every release directly (the download URL redirects to random mirrors).
      const ver = /mariadb-([\d.]+)-winx64/.exec(f.file_name)[1];
      log(`downloading ${f.file_name}`);
      curl(`https://archive.mariadb.org/mariadb-${ver}/winx64-packages/${f.file_name}`, zip);
    }
    if (f.checksum?.sha256sum && sha256(zip) !== f.checksum.sha256sum) throw new Error('MariaDB checksum mismatch');
  }
  const tmp = join(cache, 'mariadb-x');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp);
  // Windows: the system bsdtar (Git-Bash's GNU tar and unzip are not reliable with drive-letter paths).
  if (process.platform === 'win32') execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', tmp]);
  else execFileSync('unzip', ['-q', zip, '-d', tmp]);
  const top = join(tmp, readdirSync(tmp)[0]);
  rmSync(mdir, { recursive: true, force: true });
  mkdirSync(mdir);
  // Server, tools, error messages, licence; no test suite or debug symbols.
  for (const d of ['bin', 'lib', 'share']) if (existsSync(join(top, d))) cpSync(join(top, d), join(mdir, d), { recursive: true });
  for (const f of readdirSync(top)) if (/^(COPYING|README|THIRDPARTY)/i.test(f)) cpSync(join(top, f), join(mdir, f));
  rmSync(join(mdir, 'share', 'mysql-test'), { recursive: true, force: true });
  // Keep the server, installer, client, dump/upgrade tools and their DLLs; drop the rest
  // (duplicate mysql* names, backup/aria tools, import libraries, debug symbols).
  const KEEP = new Set(['mariadbd.exe', 'mysqld.exe', 'mariadb-install-db.exe', 'mariadb.exe', 'mariadb-admin.exe', 'mariadb-dump.exe', 'mariadb-upgrade.exe', 'mariadb-check.exe', 'my_print_defaults.exe']);
  for (const f of readdirSync(join(mdir, 'bin'))) if (!KEEP.has(f.toLowerCase()) && !/\.dll$/i.test(f)) rmSync(join(mdir, 'bin', f), { recursive: true });
  for (const f of readdirSync(join(mdir, 'lib'))) if (/\.(lib|pdb)$/i.test(f)) rmSync(join(mdir, 'lib', f));
  rmSync(tmp, { recursive: true, force: true });
  const ver = /mariadb-([\d.]+)-winx64/.exec(zip)?.[1] ?? 'unknown';
  writeFileSync(
    join(mdir, 'SOURCE.txt'),
    `MariaDB Server ${ver} is included unmodified as a separate program, under the GNU General Public License v2 (see COPYING).\r\n` +
      `The complete corresponding source code is available at https://archive.mariadb.org/mariadb-${ver}/source/\r\n` +
      'or on request from Vayrone Infratech, Agra, India, for at least three years from the date of distribution.\r\n',
  );
  log(`MariaDB prepared from ${zip}`);
}

// 4. installer
if (args.includes('--no-iscc') || process.platform !== 'win32') {
  log(`Inputs ready. On Windows run: ISCC /DAppVersion=${version} installer\\windows\\vayrone-postmaster.iss`);
} else {
  const installed = 'C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe';
  const iscc = existsSync(installed) ? installed : 'ISCC.exe';
  execFileSync(iscc, [`/DAppVersion=${version}`, join(root, 'installer/windows/vayrone-postmaster.iss')], { stdio: 'inherit' });
}
