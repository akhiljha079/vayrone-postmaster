import { createCipheriv, createDecipheriv, randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const PARAMS = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const h = await scryptAsync(pw.normalize('NFKC'), salt, 32, PARAMS);
  return `scrypt$${PARAMS.N}$${salt.toString('base64')}$${h.toString('base64')}`;
}

export async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [alg, n, salt, hash] = stored.split('$');
  if (alg !== 'scrypt' || !n || !salt || !hash) return false;
  const h = await scryptAsync(pw.normalize('NFKC'), Buffer.from(salt, 'base64'), 32, { ...PARAMS, N: Number(n) });
  const want = Buffer.from(hash, 'base64');
  return h.length === want.length && timingSafeEqual(h, want);
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest();

/** AES-256-GCM for credentials kept in the settings table. */
export class Vault {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('Secret key must be 32 bytes (64 hex characters)');
  }
  static fromFile(path: string): Vault {
    const hex = readFileSync(path, 'utf8').trim();
    if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`${path} must contain 64 hex characters`);
    return new Vault(Buffer.from(hex, 'hex'));
  }
  seal(s: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(s, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]).toString('base64');
  }
  open(b64: string): string {
    const b = Buffer.from(b64, 'base64');
    const d = createDecipheriv('aes-256-gcm', this.key, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  }
}
