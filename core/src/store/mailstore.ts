// Mailbox state: folders, items, UIDs, flags, MODSEQs. All IMAP/POP3
// identity rules from docs/ARCHITECTURE.md §7 are enforced here:
//   * UIDVALIDITY comes from users.next_uidvalidity and is never recomputed.
//   * UIDs come from folders.uidnext, which only ever increases.
//   * POP3 UIDLs are assigned once at insert and carried through MOVE.
// Lock order (deadlock avoidance): folders (ascending id) → users.
import { createHash } from 'node:crypto';
import type { Db, PoolConnection, Queryable } from '../db.js';
import { exec, json, one, rows, tx } from '../db.js';
import type { BlobStore } from './blobstore.js';
import { normalizeCrlf } from './blobstore.js';
import type { MailEvents } from '../events.js';
import type { Envelope, MimeEntity, ParsedMessage } from '../mime/mime.js';
import { messageIdHash, parseMessage } from '../mime/mime.js';
import { previewText } from '../imap/search.js';

export type SpecialUse = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'outbox';
export type ItemOrigin = 'lan_smtp' | 'fetch' | 'webmail' | 'internal' | 'journal' | 'restore' | 'import' | 'rule' | 'imap_append';

export const SEEN_BIT = 1;
export const DELETED_BIT = 8;
export const DELIMITER = '/';

export interface Folder {
  id: number;
  user_id: number;
  parent_id: number | null;
  path: string;
  special_use: SpecialUse | null;
  uidvalidity: number;
  uidnext: number;
  highest_modseq: number;
  message_count: number;
  unseen_count: number;
  total_bytes: number;
  subscribed: number;
}

export interface ItemMeta {
  id: number;
  uid: number;
  modseq: number;
  flags: number;
  internal_date: Date;
  size: number;
  message_id: number;
  pop3_uidl: string;
  keywords: string[];
}

export interface ItemFull extends ItemMeta {
  storage_path: string;
  codec: number;
  envelope: Envelope;
  tree: MimeEntity;
  header_raw: Buffer | null;
}

export interface StoredMessage {
  id: number;
  size: number;
  parsed: ParsedMessage;
  raw: Buffer;
}

export interface AppendInput {
  userId: number;
  folderId: number;
  message: StoredMessage;
  flags?: number;
  keywords?: string[];
  internalDate?: Date;
  origin: ItemOrigin;
  externalAccountId?: number | null;
}

export interface AppendResult {
  itemId: number;
  uid: number;
  uidvalidity: number;
  modseq: number;
  pop3Uidl: string;
}

export interface Changes {
  highestModseq: number;
  newUids: number[];
  expunged: { uid: number; modseq: number }[];
  changed: ItemMeta[];
}

export class StoreError extends Error {
  constructor(
    public readonly code: 'NONEXISTENT' | 'ALREADYEXISTS' | 'CANNOT' | 'OVERQUOTA' | 'INUSE',
    message: string,
  ) {
    super(message);
  }
}

const DEFAULT_FOLDERS: [string, SpecialUse][] = [
  ['INBOX', 'inbox'],
  ['Sent', 'sent'],
  ['Drafts', 'drafts'],
  ['Trash', 'trash'],
  ['Junk', 'junk'],
  ['Archive', 'archive'],
];

const CHUNK = 2000;

function chunks<T>(arr: T[], n = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

/** Canonical folder path: INBOX is case-insensitive, no leading/trailing delimiter. */
export function normalizePath(path: string): string {
  let p = path.replace(/^\/+|\/+$/g, '');
  if (p.toUpperCase() === 'INBOX') p = 'INBOX';
  else if (p.toUpperCase().startsWith('INBOX/')) p = 'INBOX' + p.slice(5);
  return p;
}

export function pathHash(path: string): Buffer {
  return createHash('sha256').update(normalizePath(path).toLowerCase()).digest();
}

function clampDate(d: Date | null): Date | null {
  if (!d) return null;
  const y = d.getUTCFullYear();
  return y >= 1000 && y <= 9999 ? d : null;
}

export class MailStore {
  constructor(
    readonly db: Db,
    readonly blobs: BlobStore,
    readonly events: MailEvents,
  ) {}

  // -------------------------------------------------------------------------
  // Messages (single-instance)
  // -------------------------------------------------------------------------

  /** Writes the message file (if new) and returns its messages row. refcount is NOT incremented here. */
  async ingest(input: Buffer): Promise<StoredMessage> {
    const raw = normalizeCrlf(input);
    const parsed = parseMessage(raw);
    const blob = await this.blobs.put(raw);
    const now = new Date();
    const r = await exec(
      this.db,
      `INSERT INTO messages (sha256, content_hash, storage_path, codec, size_raw, size_stored, refcount,
         hdr_message_id, hdr_message_id_hash, hdr_date, hdr_subject, hdr_from, preview, has_attachments,
         envelope_json, bodystructure_json, header_raw, created_at)
       VALUES (?,?,?,?,?,?,0,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE id = LAST_INSERT_ID(id), created_at = IF(refcount = 0, ?, created_at)`,
      [
        blob.sha256,
        parsed.contentHash,
        blob.storagePath,
        blob.codec,
        blob.sizeRaw,
        blob.sizeStored,
        parsed.messageId?.slice(0, 255) ?? null,
        messageIdHash(parsed.messageId),
        clampDate(parsed.date),
        parsed.subject?.slice(0, 998) ?? null,
        parsed.from?.slice(0, 512) ?? null,
        previewText(raw, parsed.tree)?.slice(0, 255) ?? null,
        parsed.hasAttachments ? 1 : 0,
        JSON.stringify(parsed.envelope),
        JSON.stringify(parsed.tree),
        parsed.headerRaw,
        now,
        now,
      ],
    );
    return { id: r.insertId, size: raw.length, parsed, raw };
  }

  async loadRaw(item: { storage_path: string; codec: number }): Promise<Buffer> {
    return this.blobs.get(item.storage_path, item.codec);
  }

  // -------------------------------------------------------------------------
  // Folders
  // -------------------------------------------------------------------------

  async listFolders(userId: number): Promise<Folder[]> {
    return rows<Folder>(this.db, 'SELECT * FROM folders WHERE user_id = ? ORDER BY path', [userId]);
  }

  async getFolder(userId: number, path: string, q: Queryable = this.db): Promise<Folder | undefined> {
    return one<Folder>(q, 'SELECT * FROM folders WHERE user_id = ? AND path_hash = ?', [userId, pathHash(path)]);
  }

  async getFolderById(id: number, q: Queryable = this.db): Promise<Folder | undefined> {
    return one<Folder>(q, 'SELECT * FROM folders WHERE id = ?', [id]);
  }

  async getSpecialFolder(userId: number, special: SpecialUse): Promise<Folder | undefined> {
    return one<Folder>(this.db, 'SELECT * FROM folders WHERE user_id = ? AND special_use = ? ORDER BY id LIMIT 1', [userId, special]);
  }

  async createDefaultFolders(userId: number): Promise<void> {
    for (const [path, su] of DEFAULT_FOLDERS) {
      if (!(await this.getFolder(userId, path))) await this.createFolder(userId, path, su);
    }
  }

  /** Creates a folder (and missing parents). Each new folder takes the next per-user UIDVALIDITY. */
  async createFolder(userId: number, rawPath: string, specialUse: SpecialUse | null = null): Promise<Folder> {
    const path = normalizePath(rawPath);
    if (!path || path.split(DELIMITER).some((s) => s === '')) throw new StoreError('CANNOT', 'Invalid folder name');
    if (path.length > 1000) throw new StoreError('CANNOT', 'Folder name too long');
    const id = await tx(this.db, async (c) => {
      const u = await one<{ next_uidvalidity: number }>(c, 'SELECT next_uidvalidity FROM users WHERE id = ? FOR UPDATE', [userId]);
      if (!u) throw new StoreError('NONEXISTENT', 'No such user');
      if (await this.getFolder(userId, path, c)) throw new StoreError('ALREADYEXISTS', 'Folder already exists');
      let uidvalidity = u.next_uidvalidity;
      let parentId: number | null = null;
      const segs = path.split(DELIMITER);
      const now = new Date();
      let createdId = 0;
      for (let i = 1; i <= segs.length; i++) {
        const sub = segs.slice(0, i).join(DELIMITER);
        const existing = await this.getFolder(userId, sub, c);
        if (existing) {
          parentId = existing.id;
          continue;
        }
        const r = await exec(
          c,
          `INSERT INTO folders (user_id, parent_id, path, path_hash, special_use, uidvalidity, uidnext, highest_modseq, created_at, updated_at)
           VALUES (?,?,?,?,?,?,1,1,?,?)`,
          [userId, parentId, sub, pathHash(sub), i === segs.length ? specialUse : null, uidvalidity, now, now],
        );
        uidvalidity++;
        parentId = r.insertId;
        createdId = r.insertId;
      }
      await exec(c, 'UPDATE users SET next_uidvalidity = ? WHERE id = ?', [uidvalidity, userId]);
      return createdId;
    });
    return (await this.getFolderById(id))!;
  }

  async deleteFolder(userId: number, rawPath: string): Promise<void> {
    const path = normalizePath(rawPath);
    if (path === 'INBOX') throw new StoreError('CANNOT', 'INBOX cannot be deleted');
    await tx(this.db, async (c) => {
      const f = await one<Folder>(c, 'SELECT * FROM folders WHERE user_id = ? AND path_hash = ? FOR UPDATE', [userId, pathHash(path)]);
      if (!f) throw new StoreError('NONEXISTENT', 'No such folder');
      const child = await one(c, 'SELECT id FROM folders WHERE parent_id = ? LIMIT 1', [f.id]);
      if (child) throw new StoreError('CANNOT', 'Folder has subfolders');
      await exec(
        c,
        `UPDATE messages m JOIN (SELECT message_id, COUNT(*) AS n FROM mail_items WHERE folder_id = ? GROUP BY message_id) x
           ON m.id = x.message_id SET m.refcount = m.refcount - x.n`,
        [f.id],
      );
      const sum = await one<{ s: number | null }>(c, 'SELECT SUM(size) AS s FROM mail_items WHERE folder_id = ?', [f.id]);
      await exec(c, 'DELETE FROM folders WHERE id = ?', [f.id]);
      await exec(c, 'UPDATE users SET used_bytes = GREATEST(0, CAST(used_bytes AS SIGNED) - ?) WHERE id = ?', [Number(sum?.s ?? 0), userId]);
    });
  }

  /** Renames a folder and its subfolders. UIDVALIDITY is preserved. Renaming INBOX moves its messages. */
  async renameFolder(userId: number, fromRaw: string, toRaw: string): Promise<void> {
    const from = normalizePath(fromRaw);
    const to = normalizePath(toRaw);
    if (to === 'INBOX') throw new StoreError('ALREADYEXISTS', 'INBOX already exists');
    if (to.toLowerCase().startsWith(from.toLowerCase() + DELIMITER)) throw new StoreError('CANNOT', 'Cannot move a folder into itself');
    const src = await this.getFolder(userId, from);
    if (!src) throw new StoreError('NONEXISTENT', 'No such folder');
    if (await this.getFolder(userId, to)) throw new StoreError('ALREADYEXISTS', 'Target already exists');

    if (from === 'INBOX') {
      const dst = await this.createFolder(userId, to);
      const uids = await this.listUids(src.id);
      if (uids.length) await this.move(src.id, uids, dst.id);
      return;
    }

    // Make sure the new parent exists, then rewrite paths.
    const toSegs = to.split(DELIMITER);
    let parentId: number | null = null;
    if (toSegs.length > 1) {
      const parentPath = toSegs.slice(0, -1).join(DELIMITER);
      parentId = (await this.getFolder(userId, parentPath))?.id ?? (await this.createFolder(userId, parentPath)).id;
    }
    await tx(this.db, async (c) => {
      const all = await rows<{ id: number; path: string }>(c, 'SELECT id, path FROM folders WHERE user_id = ? FOR UPDATE', [userId]);
      const now = new Date();
      for (const f of all) {
        let np: string | null = null;
        if (f.path.toLowerCase() === from.toLowerCase()) np = to;
        else if (f.path.toLowerCase().startsWith(from.toLowerCase() + DELIMITER)) np = to + f.path.slice(from.length);
        if (np === null) continue;
        await exec(c, 'UPDATE folders SET path = ?, path_hash = ?, updated_at = ? WHERE id = ?', [np, pathHash(np), now, f.id]);
      }
      await exec(c, 'UPDATE folders SET parent_id = ? WHERE id = ?', [parentId, src.id]);
    });
  }

  async setSubscribed(userId: number, path: string, subscribed: boolean): Promise<boolean> {
    const r = await exec(this.db, 'UPDATE folders SET subscribed = ? WHERE user_id = ? AND path_hash = ?', [subscribed ? 1 : 0, userId, pathHash(path)]);
    return r.affectedRows > 0;
  }

  async firstUnseenUid(folderId: number): Promise<number | null> {
    const r = await one<{ u: number | null }>(this.db, 'SELECT MIN(uid) AS u FROM mail_items WHERE folder_id = ? AND (flags & 1) = 0', [folderId]);
    return r?.u ?? null;
  }

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  async quota(userId: number): Promise<{ used: number; limit: number | null }> {
    const r = await one<{ used_bytes: number; q: number | null }>(
      this.db,
      `SELECT u.used_bytes, COALESCE(u.quota_bytes, d.default_quota_bytes) AS q
         FROM users u LEFT JOIN domains d ON d.id = u.domain_id WHERE u.id = ?`,
      [userId],
    );
    return { used: Number(r?.used_bytes ?? 0), limit: r?.q == null ? null : Number(r.q) };
  }

  async assertQuota(userId: number, extra: number): Promise<void> {
    const q = await this.quota(userId);
    if (q.limit !== null && q.used + extra > q.limit) throw new StoreError('OVERQUOTA', 'Mailbox quota exceeded');
  }

  // -------------------------------------------------------------------------
  // Items
  // -------------------------------------------------------------------------

  /** Appends inside the caller's transaction. Caller must emit folderChanged after commit. */
  async appendInTx(c: PoolConnection, a: AppendInput): Promise<AppendResult> {
    const f = await one<{ uidvalidity: number; uidnext: number; highest_modseq: number }>(
      c,
      'SELECT uidvalidity, uidnext, highest_modseq FROM folders WHERE id = ? AND user_id = ? FOR UPDATE',
      [a.folderId, a.userId],
    );
    if (!f) throw new StoreError('NONEXISTENT', 'No such folder');
    const uid = f.uidnext;
    const modseq = Number(f.highest_modseq) + 1;
    const flags = a.flags ?? 0;
    const size = a.message.size;
    const now = new Date();
    await exec(
      c,
      `UPDATE folders SET uidnext = ?, highest_modseq = ?, message_count = message_count + 1,
         unseen_count = unseen_count + ?, total_bytes = total_bytes + ?, updated_at = ? WHERE id = ?`,
      [uid + 1, modseq, flags & SEEN_BIT ? 0 : 1, size, now, a.folderId],
    );
    const pop3Uidl = `${f.uidvalidity}.${uid}`;
    const r = await exec(
      c,
      `INSERT INTO mail_items (user_id, folder_id, uid, modseq, message_id, pop3_uidl, flags, internal_date, size, origin, external_account_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [a.userId, a.folderId, uid, modseq, a.message.id, pop3Uidl, flags, a.internalDate ?? now, size, a.origin, a.externalAccountId ?? null, now],
    );
    if (a.keywords?.length) {
      await exec(c, 'INSERT IGNORE INTO mail_item_keywords (item_id, keyword) VALUES ?', [a.keywords.map((k) => [r.insertId, k])]);
    }
    await exec(c, 'UPDATE messages SET refcount = refcount + 1 WHERE id = ?', [a.message.id]);
    await exec(c, 'UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?', [size, a.userId]);
    return { itemId: r.insertId, uid, uidvalidity: f.uidvalidity, modseq, pop3Uidl };
  }

  async append(a: AppendInput): Promise<AppendResult> {
    const res = await tx(this.db, (c) => this.appendInTx(c, a));
    this.events.folderChanged(a.folderId);
    return res;
  }

  async listUids(folderId: number): Promise<number[]> {
    const r = await rows<{ uid: number }>(this.db, 'SELECT uid FROM mail_items WHERE folder_id = ? ORDER BY uid', [folderId]);
    return r.map((x) => x.uid);
  }

  private async selectByUids<T extends { uid: number; id: number }>(sqlHead: string, folderId: number, uids: number[], q: Queryable): Promise<T[]> {
    if (!uids.length) return [];
    const sorted = [...uids].sort((a, b) => a - b);
    let result: T[];
    if (sorted.length > 200) {
      const want = new Set(sorted);
      const all = await rows<T>(q, `${sqlHead} WHERE i.folder_id = ? AND i.uid BETWEEN ? AND ? ORDER BY i.uid`, [folderId, sorted[0], sorted[sorted.length - 1]]);
      result = all.filter((r) => want.has(r.uid));
    } else {
      result = await rows<T>(q, `${sqlHead} WHERE i.folder_id = ? AND i.uid IN (?) ORDER BY i.uid`, [folderId, sorted]);
    }
    return result;
  }

  private async attachKeywords<T extends { id: number; keywords?: string[] }>(items: T[], q: Queryable = this.db): Promise<T[]> {
    for (const it of items) it.keywords = [];
    if (!items.length) return items;
    const byId = new Map(items.map((i) => [i.id, i]));
    for (const ids of chunks(items.map((i) => i.id))) {
      const kws = await rows<{ item_id: number; keyword: string }>(q, 'SELECT item_id, keyword FROM mail_item_keywords WHERE item_id IN (?)', [ids]);
      for (const k of kws) byId.get(k.item_id)?.keywords!.push(k.keyword);
    }
    return items;
  }

  async itemsMeta(folderId: number, uids: number[], q: Queryable = this.db): Promise<ItemMeta[]> {
    const items = await this.selectByUids<ItemMeta>(
      'SELECT i.id, i.uid, i.modseq, i.flags, i.internal_date, i.size, i.message_id, i.pop3_uidl FROM mail_items i',
      folderId,
      uids,
      q,
    );
    return this.attachKeywords(items, q);
  }

  async itemsFull(folderId: number, uids: number[]): Promise<ItemFull[]> {
    const raw = await this.selectByUids<ItemFull & { envelope_json: unknown; bodystructure_json: unknown }>(
      `SELECT i.id, i.uid, i.modseq, i.flags, i.internal_date, i.size, i.message_id, i.pop3_uidl,
              m.storage_path, m.codec, m.envelope_json, m.bodystructure_json, m.header_raw
         FROM mail_items i JOIN messages m ON m.id = i.message_id`,
      folderId,
      uids,
      this.db,
    );
    for (const r of raw) {
      r.envelope = json<Envelope>(r.envelope_json);
      r.tree = json<MimeEntity>(r.bodystructure_json);
    }
    return this.attachKeywords(raw);
  }

  /**
   * Changes flags/keywords. One MODSEQ is assigned to the whole operation.
   * keywords === null leaves keywords untouched (except mode 'set', which replaces them).
   * Items whose MODSEQ is above `unchangedSince` are not touched and returned in `failed`.
   */
  async storeFlags(
    folderId: number,
    uids: number[],
    mode: 'set' | 'add' | 'remove',
    bits: number,
    keywords: string[] | null,
    unchangedSince?: number,
  ): Promise<{ modseq: number; changed: number[]; failed: number[] }> {
    const res = await tx(this.db, async (c) => {
      const f = await one<{ highest_modseq: number }>(c, 'SELECT highest_modseq FROM folders WHERE id = ? FOR UPDATE', [folderId]);
      if (!f) throw new StoreError('NONEXISTENT', 'No such folder');
      const modseq = Number(f.highest_modseq) + 1;
      let target = [...uids];
      let failed: number[] = [];
      if (unchangedSince !== undefined && target.length) {
        const cur = await this.itemsMeta(folderId, target, c);
        failed = cur.filter((i) => Number(i.modseq) > unchangedSince).map((i) => i.uid);
        const failedSet = new Set(failed);
        target = target.filter((u) => !failedSet.has(u));
      }
      if (!target.length) return { modseq: Number(f.highest_modseq), changed: [] as number[], failed };

      for (const part of chunks(target)) {
        if (mode === 'add' && bits) {
          await exec(c, 'UPDATE mail_items SET flags = flags | ?, modseq = ? WHERE folder_id = ? AND uid IN (?) AND (flags & ?) <> ?', [bits, modseq, folderId, part, bits, bits]);
        } else if (mode === 'remove' && bits) {
          await exec(c, 'UPDATE mail_items SET flags = flags & ~?, modseq = ? WHERE folder_id = ? AND uid IN (?) AND (flags & ?) <> 0', [bits, modseq, folderId, part, bits]);
        } else if (mode === 'set') {
          await exec(c, 'UPDATE mail_items SET flags = ?, modseq = ? WHERE folder_id = ? AND uid IN (?) AND flags <> ?', [bits, modseq, folderId, part, bits]);
        }
        const kwTouch = mode === 'set' || (keywords !== null && keywords.length > 0);
        if (kwTouch) {
          const ids = (await rows<{ id: number }>(c, 'SELECT id FROM mail_items WHERE folder_id = ? AND uid IN (?)', [folderId, part])).map((r) => r.id);
          if (ids.length) {
            if (mode === 'set') await exec(c, 'DELETE FROM mail_item_keywords WHERE item_id IN (?)', [ids]);
            if (mode === 'remove' && keywords?.length) await exec(c, 'DELETE FROM mail_item_keywords WHERE item_id IN (?) AND keyword IN (?)', [ids, keywords]);
            if ((mode === 'add' || mode === 'set') && keywords?.length) {
              await exec(c, 'INSERT IGNORE INTO mail_item_keywords (item_id, keyword) VALUES ?', [ids.flatMap((id) => keywords.map((k) => [id, k]))]);
            }
            await exec(c, 'UPDATE mail_items SET modseq = ? WHERE id IN (?)', [modseq, ids]);
          }
        }
      }
      const changed = (await rows<{ uid: number }>(c, 'SELECT uid FROM mail_items WHERE folder_id = ? AND modseq = ?', [folderId, modseq])).map((r) => r.uid);
      if (changed.length) {
        await exec(
          c,
          `UPDATE folders SET highest_modseq = ?, updated_at = ?,
             unseen_count = (SELECT COUNT(*) FROM mail_items WHERE folder_id = ? AND (flags & 1) = 0) WHERE id = ?`,
          [modseq, new Date(), folderId, folderId],
        );
      }
      return { modseq: changed.length ? modseq : Number(f.highest_modseq), changed, failed };
    });
    if (res.changed.length) this.events.folderChanged(folderId);
    return res;
  }

  /** Removes \Deleted items (optionally limited to `onlyUids`). Returns expunged UIDs. */
  async expunge(folderId: number, onlyUids?: number[]): Promise<number[]> {
    const out = await tx(this.db, async (c) => {
      const f = await one<{ highest_modseq: number; user_id: number }>(c, 'SELECT highest_modseq, user_id FROM folders WHERE id = ? FOR UPDATE', [folderId]);
      if (!f) throw new StoreError('NONEXISTENT', 'No such folder');
      let victims = await rows<{ id: number; uid: number; message_id: number; size: number }>(
        c,
        'SELECT id, uid, message_id, size FROM mail_items WHERE folder_id = ? AND (flags & 8) <> 0 ORDER BY uid',
        [folderId],
      );
      if (onlyUids) {
        const set = new Set(onlyUids);
        victims = victims.filter((v) => set.has(v.uid));
      }
      if (!victims.length) return [];
      await this.removeItemsInTx(c, folderId, f.user_id, Number(f.highest_modseq) + 1, victims);
      return victims.map((v) => v.uid);
    });
    if (out.length) this.events.folderChanged(folderId);
    return out;
  }

  private async removeItemsInTx(
    c: PoolConnection,
    folderId: number,
    userId: number,
    modseq: number,
    victims: { id: number; uid: number; message_id: number; size: number }[],
  ): Promise<void> {
    const now = new Date();
    let bytes = 0;
    const perMsg = new Map<number, number>();
    for (const v of victims) {
      bytes += Number(v.size);
      perMsg.set(v.message_id, (perMsg.get(v.message_id) ?? 0) + 1);
    }
    for (const part of chunks(victims)) {
      await exec(c, 'DELETE FROM mail_items WHERE id IN (?)', [part.map((v) => v.id)]);
      await exec(c, 'INSERT INTO folder_expunges (folder_id, uid, modseq, at) VALUES ?', [part.map((v) => [folderId, v.uid, modseq, now])]);
    }
    for (const [mid, n] of perMsg) await exec(c, 'UPDATE messages SET refcount = refcount - ? WHERE id = ?', [n, mid]);
    await exec(
      c,
      `UPDATE folders SET highest_modseq = ?, message_count = message_count - ?, total_bytes = total_bytes - ?, updated_at = ?,
         unseen_count = (SELECT COUNT(*) FROM mail_items WHERE folder_id = ? AND (flags & 1) = 0) WHERE id = ?`,
      [modseq, victims.length, bytes, now, folderId, folderId],
    );
    await exec(c, 'UPDATE users SET used_bytes = GREATEST(0, CAST(used_bytes AS SIGNED) - ?) WHERE id = ?', [bytes, userId]);
  }

  /** Copies items; returns [srcUid, dstUid] pairs. Copies get new UIDs and new POP3 UIDLs. */
  async copy(srcId: number, uids: number[], dstId: number): Promise<{ uidvalidity: number; map: [number, number][] }> {
    const res = await tx(this.db, async (c) => {
      const [first, second] = srcId < dstId ? [srcId, dstId] : [dstId, srcId];
      await one(c, 'SELECT id FROM folders WHERE id = ? FOR UPDATE', [first]);
      if (second !== first) await one(c, 'SELECT id FROM folders WHERE id = ? FOR UPDATE', [second]);
      const dst = await this.getFolderById(dstId, c);
      if (!dst) throw new StoreError('NONEXISTENT', 'No such folder');
      const items = await this.itemsMeta(srcId, uids, c);
      if (!items.length) return { uidvalidity: dst.uidvalidity, map: [] as [number, number][] };
      const bytes = items.reduce((s, i) => s + Number(i.size), 0);
      const q = await this.quota(dst.user_id);
      if (q.limit !== null && q.used + bytes > q.limit) throw new StoreError('OVERQUOTA', 'Mailbox quota exceeded');

      const modseq = Number(dst.highest_modseq) + 1;
      let uid = dst.uidnext;
      const now = new Date();
      const map: [number, number][] = [];
      let unseen = 0;
      for (const it of items) {
        const r = await exec(
          c,
          `INSERT INTO mail_items (user_id, folder_id, uid, modseq, message_id, pop3_uidl, flags, internal_date, size, origin, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,'internal',?)`,
          [dst.user_id, dstId, uid, modseq, it.message_id, `${dst.uidvalidity}.${uid}`, it.flags, it.internal_date, it.size, now],
        );
        if (it.keywords.length) await exec(c, 'INSERT INTO mail_item_keywords (item_id, keyword) VALUES ?', [it.keywords.map((k) => [r.insertId, k])]);
        await exec(c, 'UPDATE messages SET refcount = refcount + 1 WHERE id = ?', [it.message_id]);
        if (!(it.flags & SEEN_BIT)) unseen++;
        map.push([it.uid, uid]);
        uid++;
      }
      await exec(
        c,
        `UPDATE folders SET uidnext = ?, highest_modseq = ?, message_count = message_count + ?, unseen_count = unseen_count + ?,
           total_bytes = total_bytes + ?, updated_at = ? WHERE id = ?`,
        [uid, modseq, items.length, unseen, bytes, now, dstId],
      );
      await exec(c, 'UPDATE users SET used_bytes = used_bytes + ? WHERE id = ?', [bytes, dst.user_id]);
      return { uidvalidity: dst.uidvalidity, map };
    });
    if (res.map.length) this.events.folderChanged(dstId);
    return res;
  }

  /**
   * Moves items in place: same item row (so the POP3 UIDL survives), new UID
   * in the destination, an expunge record in the source.
   */
  async move(srcId: number, uids: number[], dstId: number): Promise<{ uidvalidity: number; map: [number, number][] }> {
    if (srcId === dstId) throw new StoreError('CANNOT', 'Source and destination are the same');
    const res = await tx(this.db, async (c) => {
      const [first, second] = srcId < dstId ? [srcId, dstId] : [dstId, srcId];
      await one(c, 'SELECT id FROM folders WHERE id = ? FOR UPDATE', [first]);
      await one(c, 'SELECT id FROM folders WHERE id = ? FOR UPDATE', [second]);
      const src = await this.getFolderById(srcId, c);
      const dst = await this.getFolderById(dstId, c);
      if (!src || !dst) throw new StoreError('NONEXISTENT', 'No such folder');
      if (src.user_id !== dst.user_id) throw new StoreError('CANNOT', 'Cross-user move');
      const items = await this.itemsMeta(srcId, uids, c);
      if (!items.length) return { uidvalidity: dst.uidvalidity, map: [] as [number, number][] };

      const srcModseq = Number(src.highest_modseq) + 1;
      const dstModseq = Number(dst.highest_modseq) + 1;
      let uid = dst.uidnext;
      const now = new Date();
      const map: [number, number][] = [];
      let bytes = 0;
      let unseen = 0;
      for (const it of items) {
        await exec(c, 'UPDATE mail_items SET folder_id = ?, uid = ?, modseq = ? WHERE id = ?', [dstId, uid, dstModseq, it.id]);
        bytes += Number(it.size);
        if (!(it.flags & SEEN_BIT)) unseen++;
        map.push([it.uid, uid]);
        uid++;
      }
      await exec(c, 'INSERT INTO folder_expunges (folder_id, uid, modseq, at) VALUES ?', [items.map((i) => [srcId, i.uid, srcModseq, now])]);
      await exec(
        c,
        `UPDATE folders SET highest_modseq = ?, message_count = message_count - ?, unseen_count = unseen_count - ?,
           total_bytes = total_bytes - ?, updated_at = ? WHERE id = ?`,
        [srcModseq, items.length, unseen, bytes, now, srcId],
      );
      await exec(
        c,
        `UPDATE folders SET uidnext = ?, highest_modseq = ?, message_count = message_count + ?, unseen_count = unseen_count + ?,
           total_bytes = total_bytes + ?, updated_at = ? WHERE id = ?`,
        [uid, dstModseq, items.length, unseen, bytes, now, dstId],
      );
      return { uidvalidity: dst.uidvalidity, map };
    });
    if (res.map.length) {
      this.events.folderChanged(srcId);
      this.events.folderChanged(dstId);
    }
    return res;
  }

  /** Everything that changed after the given MODSEQs; used by IMAP sessions to emit untagged updates. */
  async changesSince(folderId: number, flagModseq: number, expungeModseq: number, maxUid: number): Promise<Changes | null> {
    const f = await one<{ highest_modseq: number }>(this.db, 'SELECT highest_modseq FROM folders WHERE id = ?', [folderId]);
    if (!f) return null;
    const highest = Number(f.highest_modseq);
    const newUids = (await rows<{ uid: number }>(this.db, 'SELECT uid FROM mail_items WHERE folder_id = ? AND uid > ? ORDER BY uid', [folderId, maxUid])).map((r) => r.uid);
    const expunged =
      highest > expungeModseq
        ? await rows<{ uid: number; modseq: number }>(this.db, 'SELECT uid, modseq FROM folder_expunges WHERE folder_id = ? AND modseq > ? AND modseq <= ? ORDER BY uid', [folderId, expungeModseq, highest])
        : [];
    let changed: ItemMeta[] = [];
    if (highest > flagModseq && maxUid > 0) {
      changed = await rows<ItemMeta>(
        this.db,
        'SELECT id, uid, modseq, flags, internal_date, size, message_id, pop3_uidl FROM mail_items WHERE folder_id = ? AND modseq > ? AND modseq <= ? AND uid <= ? ORDER BY uid',
        [folderId, flagModseq, highest, maxUid],
      );
      await this.attachKeywords(changed);
    }
    return { highestModseq: highest, newUids, expunged: expunged.map((e) => ({ uid: e.uid, modseq: Number(e.modseq) })), changed };
  }
}
