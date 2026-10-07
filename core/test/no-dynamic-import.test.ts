// The release executable runs V8 bytecode (scripts/build-release.mjs --format sea),
// which has no loader for import() at run time: "A dynamic import callback was not
// specified". Every module must be imported statically.
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const DIRS = ['core/src', 'server/src', 'worker/src', 'app/src', 'license-client/src'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('release executable compatibility', () => {
  it('runtime code has no dynamic import()', () => {
    const offenders: string[] = [];
    for (const d of DIRS) {
      for (const f of files(join(ROOT, d))) {
        readFileSync(f, 'utf8')
          .split('\n')
          .forEach((line, i) => {
            const code = line.replace(/\/\/.*$/, '');
            if (/\bimport\(\s*['"`a-zA-Z.]/.test(code) && !/typeof import\(|:\s*import\(|as import\(/.test(code)) offenders.push(`${f.slice(ROOT.length + 1)}:${i + 1}: ${line.trim()}`);
          });
      }
    }
    expect(offenders).toEqual([]);
  });
});
