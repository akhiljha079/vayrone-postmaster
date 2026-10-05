import { describe, expect, it } from 'vitest';
import {
  armor,
  decodeRequest,
  encodeRequest,
  generateLicenseKey,
  generateSigningKey,
  LICENSE_FORMAT,
  LicenseFormatError,
  normalizeLicenseKey,
  REQUEST_FORMAT,
  REVOCATION_FORMAT,
  signDoc,
  verifyDoc,
  type LicensePayload,
  type RevocationPayload,
} from '../src/index.js';
import { FP, KEYS, payload, revocation, sign } from './helpers.js';

describe('signed licence documents', () => {
  it('round-trips through the armoured text form, also after email line-ending changes', () => {
    const text = sign(payload());
    expect(text).toMatch(/^-----BEGIN VAYRONE POSTMASTER LICENSE-----\n/);
    expect(text.split('\n').every((l) => l.length <= 64)).toBe(true);
    const { payload: p, kid } = verifyDoc<LicensePayload>(LICENSE_FORMAT, `  forwarded mail\r\n${text.replace(/\n/g, '\r\n')}\r\n-- signature`, KEYS);
    expect(kid).toBe('test-1');
    expect(p).toMatchObject({ licenseId: 'LIC-TEST-0001', maxUsers: 25, activation: { components: FP.components } });
  });

  it('rejects any change to the payload', () => {
    const env = JSON.parse(Buffer.from(sign(payload()).split('\n').slice(1, -2).join(''), 'base64').toString());
    const p = JSON.parse(Buffer.from(env.payload, 'base64url').toString());
    p.maxUsers = 500;
    env.payload = Buffer.from(JSON.stringify(p)).toString('base64url');
    const forged = armor(LICENSE_FORMAT, JSON.stringify(env));
    expect(() => verifyDoc(LICENSE_FORMAT, forged, KEYS)).toThrow(expect.objectContaining({ code: 'BAD_SIGNATURE' }));
  });

  it('rejects keys it does not trust and documents of another type', () => {
    const other = generateSigningKey();
    expect(() => verifyDoc(LICENSE_FORMAT, signDoc(payload(), other.privateKey, 'test-1'), KEYS)).toThrow(LicenseFormatError);
    expect(() => verifyDoc(LICENSE_FORMAT, signDoc(payload(), other.privateKey, 'rogue'), KEYS)).toThrow(/unknown key/);
    // A revocation can never be presented as a licence (the type is part of the signed message).
    expect(() => verifyDoc(LICENSE_FORMAT, revocation(), KEYS)).toThrow(/not a .*license file/i);
    expect(verifyDoc<RevocationPayload>(REVOCATION_FORMAT, revocation(), KEYS).payload.reason).toBe('transferred');
  });

  it('encodes and validates offline request files', () => {
    const text = encodeRequest({
      format: REQUEST_FORMAT,
      key: 'VPM-X',
      licenseId: null,
      machine: { id: FP.machineId, components: FP.components },
      product: { version: '0.3.0', installId: 'abc', hostname: 'mail.local' },
      usage: { activeUsers: 3, externalAccounts: 1 },
      createdAt: new Date().toISOString(),
      nonce: 'n',
    });
    expect(text).toContain('BEGIN VAYRONE POSTMASTER ACTIVATION REQUEST');
    expect(decodeRequest(text).machine.id).toBe(FP.machineId);
    expect(() => decodeRequest(sign(payload()))).toThrow(/not a/);
    expect(() => decodeRequest('garbage')).toThrow(LicenseFormatError);
  });
});

describe('licence keys', () => {
  it('generates well-formed keys and accepts sloppy typing', () => {
    const k = generateLicenseKey();
    expect(k).toMatch(/^VPM-[0-9A-Z]{5}(-[0-9A-Z]{5}){3}-[0-9A-Z]$/);
    expect(normalizeLicenseKey(k)).toBe(k);
    expect(normalizeLicenseKey(` ${k.toLowerCase().replace(/-/g, ' ')} `)).toBe(k);
    const withO = k.replace(/0/g, 'O');
    expect(normalizeLicenseKey(withO)).toBe(k);
  });

  it('catches typing mistakes with the check character', () => {
    let caught = 0;
    for (let i = 0; i < 200; i++) {
      const k = generateLicenseKey();
      const pos = 4 + Math.floor(Math.random() * 5);
      const c = k[pos]!;
      const typo = k.slice(0, pos) + (c === 'A' ? 'B' : 'A') + k.slice(pos + 1);
      if (normalizeLicenseKey(typo) === null) caught++;
    }
    expect(caught).toBeGreaterThan(180);
    expect(normalizeLicenseKey('VPM-123')).toBeNull();
  });
});
