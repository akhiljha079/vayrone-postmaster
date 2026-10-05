import { randomBytes } from 'node:crypto';
import {
  fingerprintOf,
  generateSigningKey,
  LICENSE_FORMAT,
  machineIdOf,
  REVOCATION_FORMAT,
  signDoc,
  type Components,
  type Fingerprint,
  type LicensePayload,
  type RawComponents,
  type RevocationPayload,
} from '../src/index.js';

export const KEY = generateSigningKey();
export const KID = 'test-1';
export const KEYS = { [KID]: KEY.publicKey };
const DAY = 86_400_000;

export const RAW: RawComponents = { os: 'os-guid-1', board: 'BOARD-SN-1', uuid: '4C4C4544-0042-3510-8051-B2C04F563132', disk: 'WD-WX12345', cpu: 'Intel Xeon|GenuineIntel/6/85/7|8' };
export const FP: Fingerprint = fingerprintOf(RAW);

export function fpWith(changes: Partial<RawComponents>): Fingerprint {
  return fingerprintOf({ ...RAW, ...changes });
}

export function payload(over: Partial<LicensePayload> = {}, now = new Date()): LicensePayload {
  const components: Components = over.activation?.components ?? FP.components;
  return {
    format: LICENSE_FORMAT,
    product: 'postmaster',
    licenseId: 'LIC-TEST-0001',
    keyHint: 'ABCD7',
    client: { name: 'Agra Steel Traders' },
    reseller: null,
    plan: { code: 'business', name: 'Business' },
    maxUsers: 25,
    maxExternalAccounts: null,
    features: ['archive', 'support_access'],
    issuedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + 365 * DAY).toISOString(),
    amcExpiresAt: new Date(now.getTime() + 365 * DAY).toISOString(),
    checkBy: new Date(now.getTime() + 30 * DAY).toISOString(),
    heartbeatHours: 24,
    ...over,
    activation: { id: 'ACT-1', mode: 'online', machineId: machineIdOf(components), components, ...over.activation },
  };
}

export function sign(p: LicensePayload): string {
  return signDoc(p, KEY.privateKey, KID);
}

export function revocation(over: Partial<RevocationPayload> = {}): string {
  return signDoc<RevocationPayload>({ format: REVOCATION_FORMAT, licenseId: 'LIC-TEST-0001', activationId: 'ACT-1', reason: 'transferred', message: '', issuedAt: new Date().toISOString(), ...over }, KEY.privateKey, KID);
}

export type Handler = (path: string, body: Record<string, unknown>) => { status?: number; body: unknown } | Promise<{ status?: number; body: unknown }>;

/** fetch() replacement that routes License Server calls to a handler. */
export function fakeFetch(handler: Handler, calls: { path: string; body: Record<string, unknown> }[] = []): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ path, body });
    const r = await handler(path, body);
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

export const token = () => randomBytes(16).toString('hex');
