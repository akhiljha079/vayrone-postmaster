import { scrypt, randomBytes, timingSafeEqual, createHash } from 'node:crypto';

// scrypt$<log2N>$<r>$<p>$<salt b64>$<hash b64>
const LOG_N = 15;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 128 * 1024 * 1024;

function derive(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password.normalize('NFC'), salt, KEYLEN, { N: 2 ** logN, r, p, maxmem: MAXMEM }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt, LOG_N, R, P);
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

// Mail clients open many connections and re-authenticate constantly. Cache
// successful verifications briefly so IMAP/POP3 logins don't each cost ~50 ms
// of CPU. Keyed by a hash of (stored hash, password); never stores the password.
const okCache = new Map<string, number>();
const CACHE_MS = 10 * 60 * 1000;

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const cacheKey = createHash('sha256').update(stored).update('\0').update(password).digest('base64');
  const hit = okCache.get(cacheKey);
  if (hit !== undefined && hit > Date.now()) return true;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, logN, r, p, saltB64, hashB64] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hashB64, 'base64');
  const key = await derive(password, Buffer.from(saltB64, 'base64'), Number(logN), Number(r), Number(p));
  const ok = key.length === expected.length && timingSafeEqual(key, expected);
  if (ok) {
    if (okCache.size > 5000) okCache.clear();
    okCache.set(cacheKey, Date.now() + CACHE_MS);
  }
  return ok;
}
