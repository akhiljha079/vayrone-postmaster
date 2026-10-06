// Portable table dump format: one gzipped JSON-lines file per table.
//   line 1: {"table": "...", "columns": [...], "types": [...]}
//   then:   one JSON array per row, values encoded so they round-trip exactly:
//             Buffer → {"$b": base64}, Date → {"$d": ISO-8601}, JSON column → its JSON text
// Works identically on MySQL and MariaDB and needs no external tools.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { createGunzip, createGzip } from 'node:zlib';
import { PassThrough } from 'node:stream';
import { finished } from 'node:stream/promises';

export type Cell = string | number | boolean | null | { $b: string } | { $d: string };

export function encodeCell(v: unknown, type: string): Cell {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return { $b: v.toString('base64') };
  if (v instanceof Date) return { $d: v.toISOString() };
  if (type === 'json') return typeof v === 'string' ? v : JSON.stringify(v);
  // MariaDB reports JSON columns as longtext, yet the driver may still hand back the parsed value.
  if (typeof v === 'object') return JSON.stringify(v);
  if (typeof v === 'bigint') return v.toString();
  return v as Cell;
}

export function decodeCell(v: Cell): unknown {
  if (v && typeof v === 'object') {
    if ('$b' in v) return Buffer.from(v.$b, 'base64');
    if ('$d' in v) return new Date(v.$d);
  }
  return v;
}

export interface DumpHeader {
  table: string;
  columns: string[];
  types: string[];
}

/** Writes a gzipped JSONL file and returns its SHA-256 (of the bytes on disk). */
export class DumpWriter {
  private readonly gz = createGzip({ level: 6 });
  private readonly hash = createHash('sha256');
  private readonly out;
  rows = 0;

  constructor(path: string, header: DumpHeader) {
    this.out = createWriteStream(path, { mode: 0o640 });
    const tap = new PassThrough();
    tap.on('data', (c: Buffer) => this.hash.update(c));
    this.gz.pipe(tap).pipe(this.out);
    this.gz.write(JSON.stringify(header) + '\n');
  }

  async write(line: unknown): Promise<void> {
    if (!this.gz.write(JSON.stringify(line) + '\n')) await new Promise((r) => this.gz.once('drain', r));
    this.rows++;
  }

  async close(): Promise<string> {
    this.gz.end();
    await finished(this.out);
    return this.hash.digest('hex');
  }
}

/** Reads a dump: header first, then decoded rows (as objects keyed by column). */
export async function* readDump(path: string): AsyncGenerator<{ header: DumpHeader } | { row: Record<string, unknown> }> {
  const rl = createInterface({ input: createReadStream(path).pipe(createGunzip()), crlfDelay: Infinity });
  let header: DumpHeader | null = null;
  for await (const line of rl) {
    if (!line) continue;
    if (!header) {
      header = JSON.parse(line) as DumpHeader;
      yield { header };
      continue;
    }
    const arr = JSON.parse(line) as Cell[];
    const row: Record<string, unknown> = {};
    header.columns.forEach((c, i) => (row[c] = decodeCell(arr[i] ?? null)));
    yield { row };
  }
}

export async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const h = createHash('sha256');
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: h.digest('hex'), size };
}
