import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, rename, readFile, stat, unlink } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import zlib from 'node:zlib';
import { promisify } from 'node:util';

export const CODEC_NONE = 0;
export const CODEC_GZIP = 1;
export const CODEC_ZSTD = 2;

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);
// zstd landed in node:zlib in Node 22.15 / 23.8. Optional at runtime.
const z = zlib as unknown as {
  zstdCompress?: (b: Buffer, cb: (e: Error | null, r: Buffer) => void) => void;
  zstdDecompress?: (b: Buffer, cb: (e: Error | null, r: Buffer) => void) => void;
};
const zstdCompress = z.zstdCompress ? promisify(z.zstdCompress) : undefined;
const zstdDecompress = z.zstdDecompress ? promisify(z.zstdDecompress) : undefined;

export const zstdAvailable = zstdCompress !== undefined;

export interface StoredBlob {
  sha256: Buffer;
  storagePath: string;
  codec: number;
  sizeRaw: number;
  sizeStored: number;
}

const EXT: Record<number, string> = { [CODEC_NONE]: '.eml', [CODEC_GZIP]: '.eml.gz', [CODEC_ZSTD]: '.eml.zst' };

/**
 * Content-addressed, single-instance message store.
 * Files are immutable: store/ab/cd/<sha256><ext>. Writes go to tmp/ on the
 * same volume, are fsynced, then atomically renamed into place.
 */
export class BlobStore {
  private readonly codec: number;
  private cache = new Map<string, Buffer>();
  private cacheBytes = 0;

  constructor(
    private readonly root: string,
    codec: 'zstd' | 'gzip' | 'none' = 'zstd',
    private readonly cacheLimit = 64 * 1024 * 1024,
  ) {
    this.codec = codec === 'none' ? CODEC_NONE : codec === 'zstd' && zstdAvailable ? CODEC_ZSTD : CODEC_GZIP;
  }

  async init(): Promise<void> {
    await mkdir(join(this.root, 'store'), { recursive: true });
    await mkdir(join(this.root, 'tmp'), { recursive: true });
  }

  async put(raw: Buffer): Promise<StoredBlob> {
    const sha256 = createHash('sha256').update(raw).digest();
    const hex = sha256.toString('hex');
    const storagePath = `store/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex}${EXT[this.codec]}`;
    const abs = join(this.root, storagePath);

    const existing = await stat(abs).catch(() => undefined);
    if (existing) return { sha256, storagePath, codec: this.codec, sizeRaw: raw.length, sizeStored: existing.size };

    const data = await this.compress(raw);
    const tmp = join(this.root, 'tmp', `${hex}.${randomBytes(4).toString('hex')}`);
    const fh = await open(tmp, 'w', 0o640);
    try {
      await fh.writeFile(data);
      await fh.sync();
    } finally {
      await fh.close();
    }
    await mkdir(dirname(abs), { recursive: true });
    await rename(tmp, abs);
    return { sha256, storagePath, codec: this.codec, sizeRaw: raw.length, sizeStored: data.length };
  }

  async get(storagePath: string, codec: number): Promise<Buffer> {
    const cached = this.cache.get(storagePath);
    if (cached) {
      // refresh LRU position
      this.cache.delete(storagePath);
      this.cache.set(storagePath, cached);
      return cached;
    }
    const data = await readFile(join(this.root, storagePath));
    const raw = await this.decompress(data, codec);
    this.remember(storagePath, raw);
    return raw;
  }

  async remove(storagePath: string): Promise<void> {
    this.forget(storagePath);
    await unlink(join(this.root, storagePath)).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'ENOENT') throw e;
    });
  }

  private remember(key: string, raw: Buffer): void {
    if (raw.length > this.cacheLimit / 4) return;
    this.cache.set(key, raw);
    this.cacheBytes += raw.length;
    for (const [k, v] of this.cache) {
      if (this.cacheBytes <= this.cacheLimit) break;
      this.cache.delete(k);
      this.cacheBytes -= v.length;
    }
  }

  private forget(key: string): void {
    const v = this.cache.get(key);
    if (v) {
      this.cache.delete(key);
      this.cacheBytes -= v.length;
    }
  }

  private async compress(raw: Buffer): Promise<Buffer> {
    if (this.codec === CODEC_ZSTD && zstdCompress) return zstdCompress(raw);
    if (this.codec === CODEC_GZIP) return gzip(raw, { level: 6 });
    return raw;
  }

  private async decompress(data: Buffer, codec: number): Promise<Buffer> {
    if (codec === CODEC_NONE) return data;
    if (codec === CODEC_GZIP) return gunzip(data);
    if (codec === CODEC_ZSTD) {
      if (!zstdDecompress) throw new Error('zstd-compressed message but this runtime has no zstd support');
      return zstdDecompress(data);
    }
    throw new Error(`Unknown codec ${codec}`);
  }
}

/** Converts bare LF line endings to CRLF so stored size == octets served over IMAP/POP3. */
export function normalizeCrlf(raw: Buffer): Buffer {
  let bare = 0;
  for (let i = raw.indexOf(0x0a); i !== -1; i = raw.indexOf(0x0a, i + 1)) {
    if (i === 0 || raw[i - 1] !== 0x0d) bare++;
  }
  if (bare === 0) return raw;
  const out = Buffer.allocUnsafe(raw.length + bare);
  let o = 0;
  let start = 0;
  for (let i = raw.indexOf(0x0a); i !== -1; i = raw.indexOf(0x0a, i + 1)) {
    if (i === 0 || raw[i - 1] !== 0x0d) {
      o += raw.copy(out, o, start, i);
      out[o++] = 0x0d;
      out[o++] = 0x0a;
      start = i + 1;
    }
  }
  o += raw.copy(out, o, start);
  return out.subarray(0, o);
}
