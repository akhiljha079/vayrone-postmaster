// Update packages (.vpmupdate) and the channel index (latest.vidx).
//
//   package = "VPMUPDATE/1\n" | u32 BE manifest length | signed manifest (armoured) | data
//   data    = the gzip-compressed files, back to back, at the offsets in the manifest
//
// The manifest is signed with the Vayrone key (same key ring as licences) and
// lists every file with its size and SHA-256, so a package is verified before
// anything is installed and again by the root updater just before it is applied.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, open, readdir, rm, stat, chmod } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Writable } from 'node:stream';
import { createGunzip, createGzip } from 'node:zlib';
import { UPDATE_FORMAT, UPDATE_INDEX_FORMAT, verifyDoc, type KeyRing } from './format.js';

const MAGIC = Buffer.from('VPMUPDATE/1\n');
const MAX_MANIFEST = 8 * 1024 * 1024;

export type Channel = 'stable' | 'beta';

export interface UpdateFile {
  path: string;
  size: number;
  sha256: string;
  offset: number;
  gzSize: number;
  mode: number;
}

export interface UpdatePayload {
  format: typeof UPDATE_FORMAT;
  product: 'postmaster';
  version: string;
  /** linux-x64, linux-arm64, win-x64, … */
  target: string;
  packageFormat: 'sea' | 'node';
  channel: Channel;
  releasedAt: string;
  /** Oldest installed version that may update directly to this one. */
  minVersion: string;
  notes: string;
  files: UpdateFile[];
}

export interface UpdateIndexPayload {
  format: typeof UPDATE_INDEX_FORMAT;
  product: 'postmaster';
  version: string;
  target: string;
  channel: Channel;
  releasedAt: string;
  minVersion: string;
  notes: string;
  /** Package file name, relative to the index URL. */
  file: string;
  size: number;
  sha256: string;
}

export class UpdateError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Numeric version compare: 1.10.0 > 1.9.3. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number(x) || 0);
  const pb = b.split(/[.-]/).map((x) => Number(x) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d < 0 ? -1 : 1;
  }
  return 0;
}

async function listFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    for (const e of (await readdir(d, { withFileTypes: true })).sort((x, y) => x.name.localeCompare(y.name))) {
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else if (e.isFile()) out.push(relative(dir, p).split(sep).join('/'));
    }
  }
  await walk(dir);
  return out;
}

/** Packs a release folder. `sign` signs the manifest (scripts/make-update.mts). */
export async function writeUpdatePackage(
  releaseDir: string,
  outFile: string,
  meta: Omit<UpdatePayload, 'format' | 'product' | 'files'>,
  sign: (p: UpdatePayload) => string,
): Promise<{ payload: UpdatePayload; size: number; sha256: string }> {
  const skip = new Set(['release.json']);
  const paths = (await listFiles(releaseDir)).filter((p) => !skip.has(p));
  const tmpData = `${outFile}.data`;
  const out = createWriteStream(tmpData);
  const files: UpdateFile[] = [];
  let offset = 0;
  for (const p of paths) {
    const src = join(releaseDir, p);
    const st = await stat(src);
    const h = createHash('sha256');
    let gzSize = 0;
    const tap = new PassThrough();
    tap.on('data', (c: Buffer) => h.update(c));
    const sink = new Writable({
      write(chunk: Buffer, _enc, cb) {
        gzSize += chunk.length;
        out.write(chunk, cb);
      },
    });
    await pipeline(createReadStream(src), tap, createGzip({ level: 9 }), sink);
    files.push({ path: p, size: st.size, sha256: h.digest('hex'), offset, gzSize, mode: st.mode & 0o777 });
    offset += gzSize;
  }
  await new Promise<void>((ok, fail) => out.end((e?: Error | null) => (e ? fail(e) : ok())));
  const payload: UpdatePayload = { format: UPDATE_FORMAT, product: 'postmaster', ...meta, files };
  const manifest = Buffer.from(sign(payload), 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(manifest.length);
  const final = createWriteStream(outFile);
  final.write(Buffer.concat([MAGIC, len, manifest]));
  await pipeline(createReadStream(tmpData), final);
  await rm(tmpData);
  const h = createHash('sha256');
  await pipeline(createReadStream(outFile), new Writable({ write: (c: Buffer, _e, cb) => (h.update(c), cb()) }));
  return { payload, size: (await stat(outFile)).size, sha256: h.digest('hex') };
}

/** Reads and verifies the signed manifest. */
export async function readUpdateManifest(file: string, keys: KeyRing): Promise<{ payload: UpdatePayload; dataStart: number }> {
  const fh = await open(file, 'r');
  try {
    const head = Buffer.alloc(MAGIC.length + 4);
    await fh.read(head, 0, head.length, 0);
    if (!head.subarray(0, MAGIC.length).equals(MAGIC)) throw new UpdateError('NOT_UPDATE', 'This is not a Vayrone PostMaster update file');
    const len = head.readUInt32BE(MAGIC.length);
    if (len > MAX_MANIFEST) throw new UpdateError('DAMAGED', 'The update file is damaged');
    const m = Buffer.alloc(len);
    await fh.read(m, 0, len, head.length);
    let payload: UpdatePayload;
    try {
      payload = verifyDoc<UpdatePayload>(UPDATE_FORMAT, m.toString('utf8'), keys).payload;
    } catch (e) {
      throw new UpdateError('BAD_SIGNATURE', `The update is not signed by Vayrone Infratech (${(e as Error).message})`);
    }
    if (payload.product !== 'postmaster') throw new UpdateError('WRONG_PRODUCT', 'This update is for another product');
    return { payload, dataStart: head.length + len };
  } finally {
    await fh.close();
  }
}

/** Streams one file out of the package, checking its size and SHA-256. */
async function streamFile(pkg: string, dataStart: number, f: UpdateFile, sink: Writable): Promise<void> {
  if (!f.gzSize) {
    sink.end();
    if (f.size !== 0) throw new UpdateError('DAMAGED', `${f.path}: damaged`);
    return;
  }
  const h = createHash('sha256');
  let size = 0;
  const tap = new PassThrough();
  tap.on('data', (c: Buffer) => {
    h.update(c);
    size += c.length;
  });
  try {
    await pipeline(createReadStream(pkg, { start: dataStart + f.offset, end: dataStart + f.offset + f.gzSize - 1 }), createGunzip(), tap, sink);
  } catch (e) {
    throw new UpdateError('DAMAGED', `${f.path}: ${(e as Error).message}`);
  }
  if (size !== f.size || h.digest('hex') !== f.sha256) throw new UpdateError('DAMAGED', `${f.path}: content does not match the signed manifest`);
}

const nullSink = () => new Writable({ write: (_c, _e, cb) => cb() });

function safePath(root: string, rel: string): string {
  const p = resolve(root, rel);
  if (!p.startsWith(resolve(root) + sep) || rel.includes('\0')) throw new UpdateError('DAMAGED', `Unsafe path in update: ${rel}`);
  return p;
}

/** Full verification: signature plus every file's hash. */
export async function verifyUpdatePackage(pkg: string, keys: KeyRing): Promise<UpdatePayload> {
  const { payload, dataStart } = await readUpdateManifest(pkg, keys);
  for (const f of payload.files) {
    safePath('/x', f.path);
    await streamFile(pkg, dataStart, f, nullSink());
  }
  return payload;
}

/** Writes every file under destDir (verified on the way). */
export async function extractUpdate(pkg: string, keys: KeyRing, destDir: string): Promise<UpdatePayload> {
  const { payload, dataStart } = await readUpdateManifest(pkg, keys);
  for (const f of payload.files) {
    const dst = safePath(destDir, f.path);
    await mkdir(dirname(dst), { recursive: true });
    await streamFile(pkg, dataStart, f, createWriteStream(dst, { mode: f.mode || 0o644 }));
    if (process.platform !== 'win32') await chmod(dst, f.mode || 0o644);
  }
  return payload;
}

export function verifyUpdateIndex(text: string, keys: KeyRing): UpdateIndexPayload {
  const p = verifyDoc<UpdateIndexPayload>(UPDATE_INDEX_FORMAT, text, keys).payload;
  if (p.product !== 'postmaster') throw new UpdateError('WRONG_PRODUCT', 'Index for another product');
  return p;
}

/** Platform/format string of the running program. */
export function currentTarget(): string {
  return `${process.platform === 'win32' ? 'win' : process.platform}-${process.arch}`;
}
