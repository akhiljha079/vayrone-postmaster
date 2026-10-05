// Restores (docs/ARCHITECTURE.md §7).
//
// Full restore (technician CLI, services stopped): every table is replaced by
// the backup's rows exactly — UIDVALIDITY, UIDs, MODSEQs and POP3 UIDLs come
// back verbatim, so Outlook/Thunderbird never re-download.
//
// Partial restore (live, from the admin panel): a user, a folder or a date range.
//   * A folder that no longer exists is recreated with its ORIGINAL UIDVALIDITY,
//     UIDs and UIDLs (exact).
//   * A folder that still exists only receives the missing messages, appended
//     with new UIDs — existing UIDs are never renumbered.
//   * mode 'restore_folder' puts everything under "Restored <date>/…" instead.
import { copyFile, mkdir, readdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import mysql from 'mysql2/promise';
import type { DbConfig } from '../config.js';
import type { Db } from '../db.js';
import { exec, one, rows, tx } from '../db.js';
import { migrate } from '../migrate.js';
import type { MailStore } from '../store/mailstore.js';
import { pathHash } from '../store/mailstore.js';
import type { MailEvents } from '../events.js';
import { backupChain, verifyBackup, type BackupManifest } from './backup.js';
import { readDump, sha256File } from './format.js';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

async function storeLocator(chain: { dir: string; manifest: BackupManifest }[]): Promise<Map<string, { dir: string; sha256: string; size: number }>> {
  const map = new Map<string, { dir: string; sha256: string; size: number }>();
  // Oldest first so newer runs win (they never differ: files are content-addressed).
  for (const c of [...chain].reverse()) {
    for await (const e of readDump(join(c.dir, c.manifest.store.file))) {
      if ('row' in e) map.set(String(e.row.p), { dir: c.dir, sha256: String(e.row.h), size: Number(e.row.s) });
    }
  }
  return map;
}

async function restoreFile(locator: Map<string, { dir: string; sha256: string; size: number }>, rel: string, dataPath: string): Promise<boolean> {
  const dst = join(dataPath, rel);
  const src = locator.get(rel);
  if (!src) return existsSync(dst);
  if (existsSync(dst)) {
    const cur = await sha256File(dst);
    if (cur.size === src.size) return true;
  }
  await mkdir(dirname(dst), { recursive: true });
  const tmp = `${dst}.restore`;
  await copyFile(join(src.dir, rel), tmp);
  const got = await sha256File(tmp);
  if (got.sha256 !== src.sha256) throw new Error(`Backup file ${rel} failed its integrity check`);
  await rename(tmp, dst);
  return true;
}

/** Rows of one table in a backup run (decoded). */
export async function* tableRows(dir: string, table: string): AsyncGenerator<Record<string, unknown>> {
  const p = join(dir, 'db', `${table}.jsonl.gz`);
  if (!existsSync(p)) return;
  for await (const e of readDump(p)) if ('row' in e) yield e.row;
}

// ---------------------------------------------------------------------------
// Full restore
// ---------------------------------------------------------------------------

export interface FullRestoreResult {
  tables: number;
  rows: number;
  files: number;
  schemaVersion: number;
}

export async function restoreFull(o: {
  db: DbConfig;
  dataPath: string;
  migrationsPath: string;
  backupDir: string;
  log?: (m: string) => void;
  /** Drop every table first, so the schema is rebuilt from migrationsPath (update rollback to an older version). */
  dropExisting?: boolean;
}): Promise<FullRestoreResult> {
  const log = o.log ?? (() => {});
  const chain = await backupChain(o.backupDir);
  for (const c of chain) {
    log(`Verifying ${c.dir} …`);
    const v = await verifyBackup(c.dir);
    if (!v.ok) throw new Error(`Backup ${c.dir} failed verification: ${v.problems.slice(0, 5).join('; ')}`);
  }
  const manifest = chain[0]!.manifest;
  const available = (await readdir(join(o.migrationsPath, 'migrations'))).filter((f) => /^\d{3}_/.test(f)).map((f) => Number(f.slice(0, 3)));
  if (manifest.schemaVersion > Math.max(...available)) {
    throw new Error(`This backup was made by a newer version (schema ${manifest.schemaVersion}). Update the software before restoring.`);
  }
  if (o.dropExisting) {
    const c = await mysql.createConnection({ ...o.db });
    try {
      const [t] = await c.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
      await c.query('SET FOREIGN_KEY_CHECKS = 0');
      for (const r of t as { t: string }[]) await c.query(`DROP TABLE \`${r.t}\``);
      log(`Dropped ${(t as unknown[]).length} tables`);
    } finally {
      await c.end();
    }
  }
  await migrate(o.db, o.migrationsPath, log);

  const conn = await mysql.createConnection({ ...o.db, timezone: 'Z', supportBigNumbers: true, bigNumberStrings: false, charset: 'utf8mb4_unicode_ci' });
  let total = 0;
  try {
    await conn.query("SET time_zone = '+00:00', FOREIGN_KEY_CHECKS = 0");
    const [tablesRes] = await conn.query("SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE = 'BASE TABLE'");
    const current = new Set((tablesRes as { t: string }[]).map((r) => r.t));
    for (const t of current) if (t !== 'schema_migrations') await conn.query(`DELETE FROM \`${t}\``);
    for (const t of manifest.tables) {
      if (t.name === 'schema_migrations' || !current.has(t.name)) continue;
      const [colsRes] = await conn.query('SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [t.name]);
      const have = new Set((colsRes as { c: string }[]).map((r) => r.c));
      let cols: string[] = [];
      let batch: unknown[][] = [];
      const flush = async () => {
        if (!batch.length) return;
        await conn.query(`INSERT INTO \`${t.name}\` (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES ?`, [batch]);
        total += batch.length;
        batch = [];
      };
      for await (const e of readDump(join(chain[0]!.dir, t.file))) {
        if ('header' in e) {
          const extra = e.header.columns.filter((c) => !have.has(c));
          if (extra.length) throw new Error(`Table ${t.name} in the backup has columns this version does not know (${extra.join(', ')})`);
          cols = e.header.columns;
          continue;
        }
        batch.push(cols.map((c) => e.row[c]));
        if (batch.length >= 1000) await flush();
      }
      await flush();
      log(`Restored ${t.name} (${t.rows} rows)`);
    }
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
  } finally {
    await conn.end();
  }

  log('Restoring message files …');
  const locator = await storeLocator(chain);
  let files = 0;
  for (const rel of locator.keys()) {
    await restoreFile(locator, rel, o.dataPath);
    files++;
  }
  return { tables: manifest.tables.length, rows: total, files, schemaVersion: manifest.schemaVersion };
}

// ---------------------------------------------------------------------------
// Partial restore
// ---------------------------------------------------------------------------

export interface PartialScope {
  /** User whose mail is taken from the backup. */
  sourceUserId: number;
  /** User to restore into (defaults to the source user). */
  targetUserId?: number | null;
  /** Folder path (includes its subfolders); all folders when omitted. */
  folderPath?: string | null;
  from?: Date | null;
  to?: Date | null;
  mode?: 'original' | 'restore_folder';
  /** Recreate the user (and its addresses) when it no longer exists. */
  recreateUser?: boolean;
}

export interface PartialResult {
  targetUserId: number;
  recreatedUser: boolean;
  folders: { path: string; mode: 'exact' | 'merged'; restored: number }[];
  items: number;
}

interface BFolder {
  id: number;
  path: string;
  special_use: string | null;
  uidvalidity: number;
  uidnext: number;
  highest_modseq: number;
  subscribed: number;
}
interface BItem {
  id: number;
  folder_id: number;
  uid: number;
  modseq: number;
  message_id: number;
  pop3_uidl: string;
  flags: number;
  internal_date: Date;
  size: number;
}

export async function restorePartial(
  deps: { db: Db; store: MailStore; events: MailEvents; dataPath: string },
  backupDir: string,
  scope: PartialScope,
): Promise<PartialResult> {
  const { db, store } = deps;
  const chain = await backupChain(backupDir);
  const dir = chain[0]!.dir;

  // ---- read what we need from the dump ----
  const bUser = await (async () => {
    for await (const r of tableRows(dir, 'users')) if (Number(r.id) === scope.sourceUserId) return r;
    return null;
  })();
  if (!bUser) throw new Error('That user is not in this backup');
  const prefix = scope.folderPath?.replace(/\/+$/, '');
  const bFolders: BFolder[] = [];
  for await (const r of tableRows(dir, 'folders')) {
    if (Number(r.user_id) !== scope.sourceUserId) continue;
    const p = String(r.path);
    if (prefix && p.toLowerCase() !== prefix.toLowerCase() && !p.toLowerCase().startsWith(prefix.toLowerCase() + '/')) continue;
    bFolders.push(r as unknown as BFolder);
  }
  if (!bFolders.length) throw new Error('No matching folders in this backup');
  const folderIds = new Set(bFolders.map((f) => Number(f.id)));
  const bItems: BItem[] = [];
  for await (const r of tableRows(dir, 'mail_items')) {
    if (!folderIds.has(Number(r.folder_id))) continue;
    const d = new Date(r.internal_date as Date);
    if ((scope.from && d < scope.from) || (scope.to && d > scope.to)) continue;
    bItems.push(r as unknown as BItem);
  }
  const itemIds = new Set(bItems.map((i) => Number(i.id)));
  const keywords = new Map<number, string[]>();
  for await (const r of tableRows(dir, 'mail_item_keywords')) {
    const id = Number(r.item_id);
    if (itemIds.has(id)) keywords.set(id, [...(keywords.get(id) ?? []), String(r.keyword)]);
  }
  const msgIds = new Set(bItems.map((i) => Number(i.message_id)));
  const bMessages = new Map<number, Record<string, unknown>>();
  for await (const r of tableRows(dir, 'messages')) if (msgIds.has(Number(r.id))) bMessages.set(Number(r.id), r);

  // ---- target user ----
  let recreated = false;
  let target = scope.targetUserId ?? null;
  if (!target) {
    const cur = await one<{ id: number }>(db, 'SELECT id FROM users WHERE id = ? AND login = ?', [scope.sourceUserId, bUser.login]);
    if (cur) target = cur.id;
    else if (scope.recreateUser) {
      if (await one(db, 'SELECT id FROM users WHERE login = ?', [bUser.login])) throw new Error(`A different account named ${String(bUser.login)} exists now; restore into it explicitly`);
      const idFree = !(await one(db, 'SELECT id FROM users WHERE id = ?', [scope.sourceUserId]));
      const cols = Object.keys(bUser).filter((c) => c !== 'id' || idFree);
      const r = await exec(db, `INSERT INTO users (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (?)`, [cols.map((c) => (c === 'used_bytes' ? 0 : bUser[c]))]);
      target = idFree ? scope.sourceUserId : r.insertId;
      for await (const a of tableRows(dir, 'addresses')) {
        if (Number(a.user_id) !== scope.sourceUserId) continue;
        await exec(db, "INSERT IGNORE INTO addresses (domain_id, local_part, kind, user_id, is_primary, is_enabled, created_at) VALUES (?,?,'mailbox',?,?,?,?)", [
          a.domain_id,
          a.local_part,
          target,
          a.is_primary,
          a.is_enabled,
          a.created_at,
        ]);
      }
      recreated = true;
    } else {
      throw new Error('The user no longer exists. Choose "recreate the user" or another mailbox to restore into.');
    }
  }
  const sameIdentity = target === scope.sourceUserId || recreated;

  // ---- message rows (re-use by content hash; otherwise copy the file and insert) ----
  const locator = await storeLocator(chain);
  const msgMap = new Map<number, { id: number; sha: string }>();
  for (const [bid, m] of bMessages) {
    const sha = Buffer.from(m.sha256 as Buffer);
    const cur = await one<{ id: number }>(db, 'SELECT id FROM messages WHERE sha256 = ?', [sha]);
    if (cur) {
      msgMap.set(bid, { id: cur.id, sha: sha.toString('hex') });
      continue;
    }
    if (!(await restoreFile(locator, String(m.storage_path), deps.dataPath))) throw new Error(`Message file ${String(m.storage_path)} is missing from the backup`);
    const cols = Object.keys(m).filter((c) => c !== 'id');
    const r = await exec(db, `INSERT INTO messages (${cols.map((c) => `\`${c}\``).join(', ')}) VALUES (?)`, [cols.map((c) => (c === 'refcount' ? 0 : m[c]))]);
    msgMap.set(bid, { id: r.insertId, sha: sha.toString('hex') });
  }

  // ---- folders and items ----
  const result: PartialResult = { targetUserId: target, recreatedUser: recreated, folders: [], items: 0 };
  const day = new Date().toISOString().slice(0, 10);
  const touched = new Set<number>();
  for (const bf of [...bFolders].sort((a, b) => a.path.split('/').length - b.path.split('/').length)) {
    const items = bItems.filter((i) => Number(i.folder_id) === Number(bf.id)).sort((a, b) => a.uid - b.uid);
    const restorePath = scope.mode === 'restore_folder' ? `Restored ${day}/${bf.path}` : bf.path;
    const existing = await store.getFolder(target, restorePath);
    const uvTaken = await one(db, 'SELECT id FROM folders WHERE user_id = ? AND uidvalidity = ?', [target, bf.uidvalidity]);
    const exact = scope.mode !== 'restore_folder' && sameIdentity && !existing && !uvTaken;

    if (exact) {
      // Recreate with the original identity: same UIDVALIDITY, UIDs, MODSEQs and UIDLs.
      const n = await tx(db, async (c) => {
        const parentPath = bf.path.includes('/') ? bf.path.slice(0, bf.path.lastIndexOf('/')) : null;
        const parent = parentPath ? await store.getFolder(target!, parentPath, c) : undefined;
        const now = new Date();
        const fr = await exec(
          c,
          `INSERT INTO folders (user_id, parent_id, path, path_hash, special_use, uidvalidity, uidnext, highest_modseq, subscribed, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [target, parent?.id ?? null, bf.path, pathHash(bf.path), bf.special_use, bf.uidvalidity, bf.uidnext, bf.highest_modseq, bf.subscribed, now, now],
        );
        let count = 0;
        let bytes = 0;
        for (const it of items) {
          const mm = msgMap.get(Number(it.message_id))!;
          const uidlFree = !(await one(c, 'SELECT id FROM mail_items WHERE user_id = ? AND pop3_uidl = ?', [target, it.pop3_uidl]));
          const ir = await exec(
            c,
            `INSERT INTO mail_items (user_id, folder_id, uid, modseq, message_id, pop3_uidl, flags, internal_date, size, origin, created_at)
             VALUES (?,?,?,?,?,?,?,?,?,'restore',?)`,
            [target, fr.insertId, it.uid, it.modseq, mm.id, uidlFree ? it.pop3_uidl : `${bf.uidvalidity}.${it.uid}r`, it.flags, it.internal_date, it.size, now],
          );
          const kw = keywords.get(Number(it.id));
          if (kw?.length) await exec(c, 'INSERT IGNORE INTO mail_item_keywords (item_id, keyword) VALUES ?', [kw.map((k) => [ir.insertId, k])]);
          await exec(c, 'UPDATE messages SET refcount = refcount + 1 WHERE id = ?', [mm.id]);
          count++;
          bytes += Number(it.size);
        }
        await exec(
          c,
          `UPDATE folders SET message_count = (SELECT COUNT(*) FROM mail_items WHERE folder_id = ?),
             unseen_count = (SELECT COUNT(*) FROM mail_items WHERE folder_id = ? AND (flags & 1) = 0),
             total_bytes = (SELECT COALESCE(SUM(size), 0) FROM mail_items WHERE folder_id = ?) WHERE id = ?`,
          [fr.insertId, fr.insertId, fr.insertId, fr.insertId],
        );
        await exec(c, 'UPDATE users SET used_bytes = used_bytes + ?, next_uidvalidity = GREATEST(next_uidvalidity, ?) WHERE id = ?', [bytes, Number(bf.uidvalidity) + 1, target]);
        touched.add(fr.insertId);
        return count;
      });
      result.folders.push({ path: bf.path, mode: 'exact', restored: n });
      result.items += n;
      continue;
    }

    // Merge: append only what the folder does not have yet; existing UIDs stay untouched.
    const folder = existing ?? (await store.createFolder(target, restorePath));
    const have = new Set(
      (await rows<{ sha: Buffer; d: Date }>(db, 'SELECT m.sha256 AS sha, i.internal_date AS d FROM mail_items i JOIN messages m ON m.id = i.message_id WHERE i.folder_id = ?', [folder.id])).map(
        (r) => `${Buffer.from(r.sha).toString('hex')}:${new Date(r.d).getTime()}`,
      ),
    );
    let n = 0;
    for (const it of items) {
      const mm = msgMap.get(Number(it.message_id))!;
      if (have.has(`${mm.sha}:${new Date(it.internal_date).getTime()}`)) continue;
      const message = { id: mm.id, size: Number(it.size) } as Parameters<MailStore['append']>[0]['message'];
      await tx(db, (c) =>
        store.appendInTx(c, {
          userId: target!,
          folderId: folder.id,
          message,
          flags: Number(it.flags),
          keywords: keywords.get(Number(it.id)) ?? [],
          internalDate: new Date(it.internal_date),
          origin: 'restore',
        }),
      );
      n++;
    }
    touched.add(folder.id);
    result.folders.push({ path: restorePath, mode: 'merged', restored: n });
    result.items += n;
  }
  for (const f of touched) deps.events.folderChanged(f);
  return result;
}
