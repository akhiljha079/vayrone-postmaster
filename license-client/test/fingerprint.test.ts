import { describe, expect, it } from 'vitest';
import { clean, collectFingerprint, hashComponent, matchFingerprint } from '../src/index.js';
import { FP, fpWith } from './helpers.js';

describe('machine fingerprint', () => {
  it('ignores OEM placeholder values', () => {
    for (const v of ['To be filled by O.E.M.', 'Default string', '0', '00000000-0000-0000-0000-000000000000', 'System Serial Number', '  ', 'None']) expect(clean(v)).toBeNull();
    expect(clean(' PF3ABC12 ')).toBe('PF3ABC12');
    expect(hashComponent('board', 'Default string')).toBeNull();
    expect(hashComponent('board', 'ABC')).toBe(hashComponent('board', 'abc'));
    expect(hashComponent('board', 'ABC')).not.toBe(hashComponent('disk', 'ABC'));
  });

  it('tolerates one changed component, not two', () => {
    expect(matchFingerprint(FP.components, FP.components)).toMatchObject({ ok: true, changed: [] });
    expect(matchFingerprint(FP.components, fpWith({ disk: 'NEW-DISK' }).components)).toMatchObject({ ok: true, changed: ['disk'] });
    expect(matchFingerprint(FP.components, fpWith({ disk: 'NEW-DISK', board: 'NEW-BOARD' }).components)).toMatchObject({ ok: false, changed: ['board', 'disk'] });
    // A component the machine did not expose at activation is not counted.
    const noDisk = fpWith({ disk: null }).components;
    expect(matchFingerprint(noDisk, fpWith({ disk: 'ADDED-LATER' }).components).ok).toBe(true);
    expect(matchFingerprint(noDisk, fpWith({ disk: 'X', cpu: 'Y' }).components).ok).toBe(true);
    expect(matchFingerprint(noDisk, fpWith({ cpu: 'Y', os: 'reinstalled' }).components).ok).toBe(false);
  });

  it('gives a stable display id that changes with the hardware', () => {
    expect(FP.machineId).toMatch(/^[0-9A-Z]{5}(-[0-9A-Z]{5}){3}$/);
    expect(fpWith({}).machineId).toBe(FP.machineId);
    expect(fpWith({ disk: 'other' }).machineId).not.toBe(FP.machineId);
  });

  it('reads this machine', async () => {
    const a = await collectFingerprint(process.cwd());
    const b = await collectFingerprint(process.cwd());
    expect(a.machineId).toBe(b.machineId);
    expect(a.available.length).toBeGreaterThanOrEqual(1);
  });
});
