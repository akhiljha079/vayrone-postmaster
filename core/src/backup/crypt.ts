// Client-side encryption of backups sent to cloud targets (S3, FTP).
//
//   key  = scrypt(passphrase, salt)              — salt in <run>/encryption.json (not secret)
//   file = "VPMENC1\n" | iv(12) | chunk*          — chunk = len(u32 BE) | ciphertext | tag(16)
//   chunk nonce = iv with the chunk counter XOR-ed into its last 8 bytes
//   AAD = chunk counter (u64) | final flag (1 byte) — reordering or truncation fails
import { createCipheriv, createDecipheriv, createHmac, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number, o: { N: number; r: number; p: number; maxmem: number }) => Promise<Buffer>;
const MAGIC = Buffer.from('VPMENC1\n');
export const CHUNK = 64 * 1024;
const KDF = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export interface EncryptionInfo {
  format: 'vpm-backup-enc/1';
  kdf: 'scrypt';
  N: number;
  r: number;
  p: number;
  salt: string;
  /** HMAC of a fixed label: tells "wrong passphrase" apart from "damaged file". */
  check: string;
}

export async function newEncryption(passphrase: string): Promise<{ key: Buffer; info: EncryptionInfo }> {
  const salt = randomBytes(16);
  const key = await scrypt(passphrase.normalize('NFKC'), salt, 32, KDF);
  return { key, info: { format: 'vpm-backup-enc/1', kdf: 'scrypt', N: KDF.N, r: KDF.r, p: KDF.p, salt: salt.toString('base64'), check: createHmac('sha256', key).update('vpm-backup-key-check').digest('base64') } };
}

export async function keyFromInfo(passphrase: string, info: EncryptionInfo): Promise<Buffer> {
  const key = await scrypt(passphrase.normalize('NFKC'), Buffer.from(info.salt, 'base64'), 32, { N: info.N, r: info.r, p: info.p, maxmem: 256 * 1024 * 1024 });
  const want = Buffer.from(info.check, 'base64');
  const got = createHmac('sha256', key).update('vpm-backup-key-check').digest();
  if (want.length !== got.length || !timingSafeEqual(want, got)) throw new Error('Wrong backup passphrase');
  return key;
}

/** Size of the encrypted form of a file of `size` bytes. */
export function encryptedSize(size: number): number {
  const chunks = Math.max(1, Math.ceil(size / CHUNK));
  return MAGIC.length + 12 + size + chunks * (4 + 16);
}

function nonce(iv: Buffer, counter: bigint): Buffer {
  const n = Buffer.from(iv);
  const c = Buffer.alloc(8);
  c.writeBigUInt64BE(counter);
  for (let i = 0; i < 8; i++) n[4 + i]! ^= c[i]!;
  return n;
}

function aad(counter: bigint, final: boolean): Buffer {
  const a = Buffer.alloc(9);
  a.writeBigUInt64BE(counter);
  a[8] = final ? 1 : 0;
  return a;
}

export function encryptStream(key: Buffer): Transform {
  const iv = randomBytes(12);
  let buf = Buffer.alloc(0);
  let counter = 0n;
  let headerSent = false;
  const seal = (t: Transform, data: Buffer, final: boolean) => {
    const c = createCipheriv('aes-256-gcm', key, nonce(iv, counter));
    c.setAAD(aad(counter, final));
    const ct = Buffer.concat([c.update(data), c.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ct.length);
    t.push(Buffer.concat([len, ct, c.getAuthTag()]));
    counter++;
  };
  return new Transform({
    transform(chunk: Buffer, _e, cb: TransformCallback) {
      if (!headerSent) {
        this.push(Buffer.concat([MAGIC, iv]));
        headerSent = true;
      }
      buf = Buffer.concat([buf, chunk]);
      // Keep at least one byte back so the last chunk can be marked final.
      while (buf.length > CHUNK) {
        seal(this, buf.subarray(0, CHUNK), false);
        buf = buf.subarray(CHUNK);
      }
      cb();
    },
    flush(cb: TransformCallback) {
      if (!headerSent) this.push(Buffer.concat([MAGIC, iv]));
      seal(this, buf, true);
      cb();
    },
  });
}

export function decryptStream(key: Buffer): Transform {
  let buf = Buffer.alloc(0);
  let iv: Buffer | null = null;
  let counter = 0n;
  let done = false;
  return new Transform({
    transform(chunk: Buffer, _e, cb: TransformCallback) {
      buf = Buffer.concat([buf, chunk]);
      try {
        if (!iv) {
          if (buf.length < MAGIC.length + 12) return cb();
          if (!buf.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Not an encrypted backup file');
          iv = Buffer.from(buf.subarray(MAGIC.length, MAGIC.length + 12));
          buf = buf.subarray(MAGIC.length + 12);
        }
        for (;;) {
          if (buf.length < 4) break;
          const len = buf.readUInt32BE(0);
          if (len > CHUNK) throw new Error('Damaged encrypted backup file');
          if (buf.length < 4 + len + 16) break;
          if (done) throw new Error('Data after the final chunk');
          const ct = buf.subarray(4, 4 + len);
          const tag = buf.subarray(4 + len, 4 + len + 16);
          buf = buf.subarray(4 + len + 16);
          // The final chunk is the one with nothing after it; try both flags (only the right one authenticates).
          let out: Buffer | null = null;
          for (const final of buf.length === 0 ? [true, false] : [false]) {
            try {
              const d = createDecipheriv('aes-256-gcm', key, nonce(iv, counter));
              d.setAAD(aad(counter, final));
              d.setAuthTag(tag);
              out = Buffer.concat([d.update(ct), d.final()]);
              if (final) done = true;
              break;
            } catch {
              /* try the other flag */
            }
          }
          if (!out) throw new Error('Encrypted backup file failed authentication (damaged, or wrong passphrase)');
          counter++;
          this.push(out);
        }
        cb();
      } catch (e) {
        cb(e as Error);
      }
    },
    flush(cb: TransformCallback) {
      cb(done && buf.length === 0 ? null : new Error('Encrypted backup file is truncated'));
    },
  });
}
