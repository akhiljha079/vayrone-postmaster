// Backups (docs/ARCHITECTURE.md §7: UIDVALIDITY, UIDs and UIDLs are kept verbatim).
//
// <target>/<dirName>/
//   manifest.json            what is in the backup, with SHA-256 of every file
//   db/<table>.jsonl.gz      every table, from ONE consistent snapshot
//   store-index.jsonl.gz     message files in this run: {p: path, s: size, h: sha256}
//   store/ab/cd/<sha>.eml.*  the message files (full: all; incremental: new since base)
//
// A run is written to "<dirName>.partial" and renamed only when complete, so an
// interrupted backup can never be mistaken for a good one.
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Db } from '../db.js';
import { APP_VERSION } from '../migrate.js';
import { DumpWriter, encodeCell, readDump, sha256File } from './format.js';

export const BACKUP_FORMAT = 'vpm-backup';
/** Never backed up: live session tokens, locks and transient jobs. */
export const EXCLUDED_TABLES = new Set(['sessions', 'app_locks', 'jobs']);

export interface BackupManifest {
  format: typeof BACKUP_FORMAT;
  version: 1;
  appVersion: string;
  schemaVersion: number;
  installId: string;
  hostname: string;
  kind: 'full' | 'incremental' | 'pre_update';
  runId: number;
  createdAt: string;
  /** Directory name of the base run (incremental only). */
  base: string | null;
  highMessageId: number;
  tables: { name: string; rows: number; file: string; sha256: string }[];
  store: { file: string; sha256: string; files: number; bytes: number; missing: string[] };
}

export interface BackupResult {
  dirName: string;
  manifest: BackupManifest;
  manifestSha256: string;
  files: number;
  bytes: number;
}

export interface BackupOptions {
  db: Db;
  dataPath: string;
  targetPath: string;
  kind: 'full' | 'incremental' | 'pre_update';
  runId: number;
  installId: string;
  hostname: string;
  /** Base run for incrementals. */
  base?: { dirName: string; highMessageId: number } | null;
  /** Database only (pre-update snapshot): message files are left out; they are not changed by updates. */
  dbOnly?: boolean;
  onProgress?: (pct: number) => void;
}

function stamp(d = new Date()): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
}

async function copyWithHash(src: string, dst: string): Promise<{ sha256: string; size: number }> {
  await mkdir(dirname(dst), { recursive: true });
  const h = createHash('sha256');
  let size = 0;
  const tap = new PassThrough();
  tap.on('data', (c: Buffer) => {
    h.update(c);
    size += c.length;
  });
  await pipeline(createReadStream(src), tap, createWriteStream(dst, { mode: 0o640 }));
  return { sha256: h.digest('hex'), size };
}

export async function runBackup(o: BackupOptions): Promise<BackupResult> {
  const kind = o.kind === 'incremental' && !o.base ? 'full' : o.kind;
  const dirName = `vpm-${kind}-${stamp()}-r${o.runId}`;
  const tmp = join(o.targetPath, `${dirName}.partial`);
  await mkdir(join(tmp, 'db'), { recursive: true });
  await mkdir(join(tmp, 'store'), { recursive: true });
  const conn = await o.db.getConnection();
  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    const q = async <T>(sql: string, params: unknown[] = []) => (await conn.query(sql, params))[0] as T[];

    const tables = (await q<{ t: string }>("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME"))
      .map((r) => r.t)
      .filter((t) => !EXCLUDED_TABLES.has(t));
    const schemaVersion = (await q<{ v: number | null }>('SELECT MAX(version) AS v FROM schema_migrations'))[0]?.v ?? 0;
    const highMessageId = Number((await q<{ m: number | null }>('SELECT MAX(id) AS m FROM messages'))[0]?.m ?? 0);
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      version: 1,
      appVersion: APP_VERSION,
      schemaVersion: Number(schemaVersion),
      installId: o.installId,
      hostname: o.hostname,
      kind,
      runId: o.runId,
      createdAt: new Date().toISOString(),
      base: kind === 'incremental' ? o.base!.dirName : null,
      highMessageId,
      tables: [],
      store: { file: 'store-index.jsonl.gz', sha256: '', files: 0, bytes: 0, missing: [] },
    };

    // ---- database (every table from the same snapshot) ----
    for (const [ti, table] of tables.entries()) {
      const cols = await q<{ c: string; t: string }>(
        'SELECT COLUMN_NAME AS c, DATA_TYPE AS t FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? ORDER BY ORDINAL_POSITION',
        [table],
      );
      // JSON columns go into the dump as JSON text (encodeCell), whether MySQL or MariaDB returned them parsed.
      const types = cols.map((c) => c.t);
      const pk = (await q<{ c: string }>(
        "SELECT COLUMN_NAME AS c FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION",
        [table],
      )).map((r) => r.c);
      const file = `db/${table}.jsonl.gz`;
      const w = new DumpWriter(join(tmp, file), { table, columns: cols.map((c) => c.c), types });
      const order = pk.length ? pk.map((c) => `\`${c}\``).join(', ') : cols.map((c) => `\`${c.c}\``).join(', ');
      let last: unknown[] | null = null;
      for (;;) {
        const where: string = last && pk.length ? `WHERE (${order}) > (${pk.map(() => '?').join(', ')})` : '';
        const batch: Record<string, unknown>[] = await q<Record<string, unknown>>(`SELECT * FROM \`${table}\` ${where} ORDER BY ${order} LIMIT 5000${!pk.length && last ? ` OFFSET ${w.rows}` : ''}`, last ?? []);
        for (const r of batch) await w.write(cols.map((c, i) => encodeCell(r[c.c], types[i]!)));
        if (batch.length < 5000) break;
        const lastRow: Record<string, unknown> = batch[batch.length - 1]!;
        last = pk.length ? pk.map((c) => lastRow[c]) : [0];
      }
      const rowsWritten = w.rows;
      manifest.tables.push({ name: table, rows: rowsWritten, file, sha256: await w.close() });
      o.onProgress?.(Math.round(((ti + 1) / tables.length) * 30));
    }

    // ---- message files (all for full; only new ones for incremental) ----
    const from = kind === 'incremental' ? o.base!.highMessageId : 0;
    const index = new DumpWriter(join(tmp, manifest.store.file), { table: '$store', columns: ['p', 's', 'h'], types: [] });
    const total = o.dbOnly ? 0 : Number((await q<{ n: number }>('SELECT COUNT(*) AS n FROM messages WHERE id > ?', [from]))[0]?.n ?? 0);
    let lastId = from;
    let done = 0;
    for (; !o.dbOnly; ) {
      const batch = await q<{ id: number; storage_path: string; refcount: number }>('SELECT id, storage_path, refcount FROM messages WHERE id > ? ORDER BY id LIMIT 2000', [lastId]);
      for (const m of batch) {
        const src = join(o.dataPath, m.storage_path);
        if (!existsSync(src)) {
          if (m.refcount > 0) manifest.store.missing.push(m.storage_path); // reported; GC'd garbage is skipped silently
          continue;
        }
        const r = await copyWithHash(src, join(tmp, m.storage_path));
        await index.write([m.storage_path, r.size, r.sha256]);
        manifest.store.files++;
        manifest.store.bytes += r.size;
      }
      done += batch.length;
      if (total) o.onProgress?.(30 + Math.round((done / total) * 69));
      if (batch.length < 2000) break;
      lastId = batch[batch.length - 1]!.id;
    }
    manifest.store.sha256 = await index.close();
    await conn.query('COMMIT');

    const manifestText = JSON.stringify(manifest, null, 2);
    await writeFile(join(tmp, 'manifest.json'), manifestText, { mode: 0o640 });
    await rename(tmp, join(o.targetPath, dirName));
    o.onProgress?.(100);
    const dbBytes = await Promise.all(manifest.tables.map(async (t) => (await stat(join(o.targetPath, dirName, t.file))).size));
    return {
      dirName,
      manifest,
      manifestSha256: createHash('sha256').update(manifestText).digest('hex'),
      files: manifest.store.files + manifest.tables.length,
      bytes: manifest.store.bytes + dbBytes.reduce((a, b) => a + b, 0),
    };
  } catch (e) {
    await conn.query('ROLLBACK').catch(() => {});
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

export async function readManifest(dir: string): Promise<BackupManifest> {
  const m = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as BackupManifest;
  if (m.format !== BACKUP_FORMAT) throw new Error(`${dir} is not a Vayrone PostMaster backup`);
  return m;
}

/** The run and its base runs (newest first) — message files of an incremental live in the chain. */
export async function backupChain(dir: string): Promise<{ dir: string; manifest: BackupManifest }[]> {
  const out: { dir: string; manifest: BackupManifest }[] = [];
  let cur: string | null = dir;
  while (cur) {
    const manifest = await readManifest(cur);
    out.push({ dir: cur, manifest });
    cur = manifest.base ? join(dirname(cur), manifest.base) : null;
    if (out.length > 1000) throw new Error('Backup chain is too long or circular');
  }
  return out;
}

export interface VerifyResult {
  ok: boolean;
  checkedFiles: number;
  problems: string[];
  /** Not backup corruption, but worth an admin's attention. */
  warnings: string[];
}

/** Re-hashes every file listed in the manifest (and, for incrementals, checks the base exists). */
export async function verifyBackup(dir: string, opts: { ignoreChain?: boolean } = {}): Promise<VerifyResult> {
  const problems: string[] = [];
  let checked = 0;
  let m: BackupManifest;
  try {
    m = await readManifest(dir);
  } catch (e) {
    return { ok: false, checkedFiles: 0, problems: [(e as Error).message], warnings: [] };
  }
  const check = async (rel: string, sha: string, size?: number) => {
    const p = join(dir, rel);
    if (!existsSync(p)) return problems.push(`missing: ${rel}`);
    const r = await sha256File(p);
    checked++;
    if (r.sha256 !== sha || (size !== undefined && r.size !== size)) problems.push(`corrupt: ${rel}`);
  };
  for (const t of m.tables) await check(t.file, t.sha256);
  await check(m.store.file, m.store.sha256);
  if (existsSync(join(dir, m.store.file))) {
    for await (const e of readDump(join(dir, m.store.file))) {
      if ('row' in e) await check(String(e.row.p), String(e.row.h), Number(e.row.s));
      if (problems.length > 50) break;
    }
  }
  if (m.base && !opts.ignoreChain && !existsSync(join(dirname(dir), m.base, 'manifest.json'))) problems.push(`base backup ${m.base} is missing`);
  const warnings = m.store.missing.length ? [`${m.store.missing.length} message file(s) were already missing on the server when this backup ran`] : [];
  return { ok: problems.length === 0, checkedFiles: checked, problems, warnings };
}
