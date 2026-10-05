#!/usr/bin/env node
// Dependency licence gate (spec §11). Walks every installed package in
// node_modules and fails if a package that ships to customers is not under an
// allowed licence and is not explicitly approved in license-policy.json.
//
//   node scripts/license-audit.mjs            # audit, exit 1 on violations
//   node scripts/license-audit.mjs --report   # also print a full table
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const policy = JSON.parse(readFileSync(join(root, 'scripts', 'license-policy.json'), 'utf8'));
const allowed = new Set(policy.allowed);
const approved = policy.approvedExceptions ?? {};
const report = process.argv.includes('--report');

function* walk(dir) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const p = join(dir, name);
    if (name.startsWith('@')) {
      for (const sub of readdirSync(p)) yield* pkg(join(p, sub));
    } else {
      yield* pkg(p);
    }
  }
}
function* pkg(p) {
  const pj = join(p, 'package.json');
  if (!existsSync(pj)) return;
  yield JSON.parse(readFileSync(pj, 'utf8'));
  yield* walk(join(p, 'node_modules'));
}

function normalise(lic) {
  if (!lic) return 'UNKNOWN';
  if (typeof lic === 'object') return lic.type ?? 'UNKNOWN';
  return String(lic).trim();
}

// "(MIT OR EUPL-1.1+)" passes if any OR-branch is allowed. AND requires all.
function isAllowed(expr) {
  const e = expr.replace(/[()]/g, '').trim();
  if (e.includes(' OR ')) return e.split(' OR ').some((x) => isAllowed(x));
  if (e.includes(' AND ')) return e.split(' AND ').every((x) => isAllowed(x));
  return allowed.has(e);
}

const seen = new Map();
for (const dir of [join(root, 'node_modules'), ...policy.workspaces.map((w) => join(root, w, 'node_modules'))]) {
  for (const p of walk(dir)) {
    const key = `${p.name}@${p.version}`;
    if (!seen.has(key)) seen.set(key, normalise(p.license ?? p.licenses?.[0]));
  }
}

const violations = [];
for (const [key, lic] of [...seen].sort()) {
  const name = key.slice(0, key.lastIndexOf('@'));
  if (name.startsWith('@vpm/')) continue; // our own workspaces
  // Exceptions may end in '*' to cover platform-specific binaries (e.g. lightningcss-darwin-x64).
  const exceptionKey = Object.keys(approved).find((k) => (k.endsWith('*') ? name.startsWith(k.slice(0, -1)) : k === name));
  const note = exceptionKey ? approved[exceptionKey] : undefined;
  const ok = isAllowed(lic) || note !== undefined;
  if (report) console.log(`${ok ? '  ok ' : ' FAIL'}  ${lic.padEnd(28)} ${key}${note ? `  (approved: ${note})` : ''}`);
  if (!ok) violations.push(`${key}: ${lic}`);
}

console.log(`\nScanned ${seen.size} packages.`);
if (violations.length) {
  console.error(`\n${violations.length} package(s) need review before they can ship:\n  ` + violations.join('\n  '));
  process.exit(1);
}
console.log('All packages are under allowed or approved licences.');
