import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretBox, loadSecretBox } from '../src/secrets.js';
import { redact } from '../src/audit.js';
import { parseCidr } from '../src/ippolicy.js';

describe('secrets', () => {
  it('seals with AES-256-GCM and detects tampering', async () => {
    const box = await loadSecretBox({ dataPath: mkdtempSync(join(tmpdir(), 'vpm-key-')) });
    const env = box.seal('provider-password');
    expect(env[0]).toBe(1); // key version
    expect(env.toString('latin1')).not.toContain('provider-password');
    expect(box.open(env)).toBe('provider-password');
    expect(box.seal('x').equals(box.seal('x'))).toBe(false); // random IV
    const bad = Buffer.from(env);
    bad[bad.length - 1]! ^= 1;
    expect(() => box.open(bad)).toThrow();
  });

  it('concurrent starters share one master key', async () => {
    const dataPath = mkdtempSync(join(tmpdir(), 'vpm-key-'));
    const boxes = await Promise.all([1, 2, 3, 4].map(() => loadSecretBox({ dataPath })));
    const sealed = boxes[0]!.seal('shared');
    for (const b of boxes) expect(b.open(sealed)).toBe('shared');
    expect(readFileSync(join(dataPath, 'master.key'), 'utf8').trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects keys of the wrong length', () => {
    expect(() => new SecretBox(new Map([[1, Buffer.alloc(16)]]), 1)).toThrow();
  });
});

describe('audit redaction and CIDR parsing', () => {
  it('redacts credential-like keys recursively', () => {
    expect(redact({ name: 'x', password: 'p', nested: { authSecret: 's', ok: 1 }, list: [{ token: 't' }] })).toEqual({
      name: 'x',
      password: '[redacted]',
      nested: { authSecret: '[redacted]', ok: 1 },
      list: [{ token: '[redacted]' }],
    });
  });

  it('parses single addresses and ranges', () => {
    expect(parseCidr('192.168.1.5')[1]).toBe(32);
    expect(parseCidr('10.0.0.0/8')[1]).toBe(8);
    expect(parseCidr('fd00::/8')[1]).toBe(8);
    expect(() => parseCidr('999.1.1.1')).toThrow();
  });
});
