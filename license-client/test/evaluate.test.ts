import { describe, expect, it } from 'vitest';
import { evaluate, type EvalInput, type RevocationPayload } from '../src/index.js';
import { FP, fpWith, payload } from './helpers.js';

const DAY = 86_400_000;
const T0 = new Date('2026-04-01T06:00:00Z');
const at = (days: number) => new Date(T0.getTime() + days * DAY);

function input(over: Partial<EvalInput> = {}): EvalInput {
  return { now: T0, license: payload({}, T0), licenseError: null, revocation: null, fingerprint: FP, clockFloor: T0, mismatchSince: null, installedAt: at(-10), integrity: 'ok', ...over };
}

describe('licence evaluation', () => {
  it('a fresh install runs a 30-day, 5-user evaluation, then the admin panel turns read-only', () => {
    const e = evaluate(input({ license: null, installedAt: at(-3) }));
    expect(e).toMatchObject({ status: 'unlicensed', mode: 'unlicensed', maxUsers: 5 });
    expect(e.reason).toContain('27 day(s) left');
    expect(e.features).toContain('archive');
    expect(e.features).not.toContain('support_access');
    expect(evaluate(input({ license: null, installedAt: at(-31) }))).toMatchObject({ status: 'unlicensed', mode: 'readonly' });
  });

  it('an active licence applies its limits and features', () => {
    const e = evaluate(input());
    expect(e).toMatchObject({ status: 'active', mode: 'active', maxUsers: 25, maxExternalAccounts: null, warning: null });
    expect(e.features).toEqual(['archive', 'support_access']);
  });

  it('warns 30 days before expiry, then 15 days of grace, then read-only — limits stay', () => {
    const lic = payload({ expiresAt: at(20).toISOString(), checkBy: at(30).toISOString() }, T0);
    expect(evaluate(input({ license: lic })).warning).toMatch(/expires on 2026-04-21 \(20 day/);
    const grace = evaluate(input({ license: lic, now: at(25) }));
    expect(grace).toMatchObject({ status: 'grace', mode: 'grace', maxUsers: 25 });
    expect(grace.reason).toMatch(/expired on 2026-04-21.*10 day\(s\) left.*Mail keeps flowing/);
    const ro = evaluate(input({ license: lic, now: at(36) }));
    expect(ro).toMatchObject({ status: 'expired', mode: 'readonly', maxUsers: 25 });
    expect(ro.graceEndsAt?.toISOString().slice(0, 10)).toBe('2026-05-06');
  });

  it('missed validation (no heartbeat / offline file) leads to grace and read-only', () => {
    const online = payload({ checkBy: at(30).toISOString() }, T0);
    expect(evaluate(input({ license: online, now: at(25) })).warning).toMatch(/could not reach the Vayrone License Server/);
    expect(evaluate(input({ license: online, now: at(31) })).reason).toMatch(/could not be validated/);
    const offline = payload({ checkBy: at(90).toISOString(), activation: { id: 'A', mode: 'offline', machineId: FP.machineId, components: FP.components } }, T0);
    expect(evaluate(input({ license: offline, now: at(85) })).warning).toMatch(/Offline re-validation is due by/);
    expect(evaluate(input({ license: offline, now: at(95) }))).toMatchObject({ mode: 'grace' });
    expect(evaluate(input({ license: offline, now: at(106) }))).toMatchObject({ mode: 'readonly', status: 'expired' });
  });

  it('a perpetual licence still needs validation', () => {
    const lic = payload({ expiresAt: null, checkBy: at(30).toISOString() }, T0);
    expect(evaluate(input({ license: lic, now: at(29) })).mode).toBe('active');
    expect(evaluate(input({ license: lic, now: at(31) })).mode).toBe('grace');
  });

  it('setting the clock back is detected; correcting it recovers', () => {
    const e = evaluate(input({ now: at(-2), clockFloor: T0 }));
    expect(e).toMatchObject({ status: 'tampered', mode: 'readonly', maxUsers: 25 });
    expect(e.reason).toMatch(/clock/);
    expect(evaluate(input({ now: new Date(T0.getTime() - 3600_000), clockFloor: T0 })).mode).toBe('active'); // small corrections are fine
  });

  it('an altered licence or program files make the state tampered', () => {
    expect(evaluate(input({ license: null, licenseError: 'The signature is not valid' }))).toMatchObject({ status: 'tampered', mode: 'readonly', maxUsers: 5 });
    expect(evaluate(input({ integrity: 'failed' }))).toMatchObject({ status: 'tampered', mode: 'readonly' });
  });

  it('new hardware: one part is fine; more gives 15 days to re-activate', () => {
    expect(evaluate(input({ fingerprint: fpWith({ disk: 'NEW' }) })).mode).toBe('active');
    const moved = fpWith({ disk: 'NEW', board: 'NEW', uuid: 'NEW' });
    const e = evaluate(input({ fingerprint: moved, mismatchSince: at(-5) }));
    expect(e).toMatchObject({ status: 'fingerprint_mismatch', mode: 'grace' });
    expect(e.reason).toMatch(/different hardware \(changed: board, uuid, disk\).*10 day/);
    expect(evaluate(input({ fingerprint: moved, mismatchSince: at(-16) }))).toMatchObject({ status: 'fingerprint_mismatch', mode: 'readonly' });
  });

  it('a revocation applies to its activation only, and a newer licence supersedes it', () => {
    const r: RevocationPayload = { format: 'vpm-revocation/1', licenseId: 'LIC-TEST-0001', activationId: 'ACT-1', reason: 'transferred', message: '', issuedAt: at(-3).toISOString() };
    const lic = payload({}, at(-10));
    expect(evaluate(input({ license: lic, revocation: r }))).toMatchObject({ mode: 'grace' });
    expect(evaluate(input({ license: lic, revocation: r })).reason).toMatch(/transferred to another server/);
    expect(evaluate(input({ license: lic, revocation: { ...r, activationId: 'ACT-2' } })).mode).toBe('active');
    expect(evaluate(input({ license: payload({}, at(-1)), revocation: r })).mode).toBe('active');
    expect(evaluate(input({ license: lic, revocation: r, now: at(13) })).mode).toBe('readonly');
  });
});
