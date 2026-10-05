// Webmail API (/api/mail): folders, message list, read view, flags/moves,
// attachments, compose/reply/forward, drafts, uploads, contacts.
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { simpleParser, type ParsedMail, type AddressObject } from 'mailparser';
import { z } from 'zod';
import { db as dbm, fulltextQuery, type CoreContext } from '@vpm/core';
import { requireUser } from '../guards.js';
import { HttpError, badRequest, forbidden, notFound } from '../http.js';
import { sanitizeEmailHtml, textToHtml } from '../webmail/html.js';
import { ComposeBody, buildMessage, readUploadMeta, resolveRecipients, uploadDir, type UploadMeta } from '../webmail/compose.js';

const { exec, json, one, rows } = dbm;
const Id = z.coerce.number().int().positive();

const SEEN = 1;
const ANSWERED = 2;
const FLAGGED = 4;
const DELETED = 8;
const DRAFT = 16;
const FORWARDED = 32;
const SPECIAL_ORDER = ['inbox', 'drafts', 'sent', 'archive', 'junk', 'trash'];
const UPLOAD_TTL_MS = 24 * 3600_000;

interface OwnedItem {
  id: number;
  user_id: number;
  folder_id: number;
  uid: number;
  flags: number;
  size: number;
  internal_date: Date;
  storage_path: string;
  codec: number;
  special_use: string | null;
}

function addrList(a: AddressObject | AddressObject[] | undefined): { name: string; address: string }[] {
  if (!a) return [];
  return (Array.isArray(a) ? a : [a]).flatMap((x) => x.value.flatMap((v) => (v.group ? v.group : [v])).map((v) => ({ name: v.name ?? '', address: (v.address ?? '').toLowerCase() })));
}

function contentDisposition(filename: string, inline = false): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}

export function webmailRoutes(ctx: CoreContext) {
  const auth = requireUser();
  const me = (req: FastifyRequest) => {
    const u = req.auth!.user;
    if (!u.has_mailbox) throw forbidden('This account has no mailbox');
    return u;
  };

  async function owned(userId: number, itemId: number): Promise<OwnedItem> {
    const it = await one<OwnedItem>(
      ctx.db,
      `SELECT i.id, i.user_id, i.folder_id, i.uid, i.flags, i.size, i.internal_date, m.storage_path, m.codec, f.special_use
         FROM mail_items i JOIN messages m ON m.id = i.message_id JOIN folders f ON f.id = i.folder_id WHERE i.id = ? AND i.user_id = ?`,
      [itemId, userId],
    );
    if (!it) throw notFound('Message not found');
    return it;
  }

  async function parsed(item: OwnedItem): Promise<ParsedMail> {
    return simpleParser(await ctx.store.loadRaw(item), { skipTextToHtml: true, skipImageLinks: true });
  }

  async function ownedFolder(userId: number, folderId: number) {
    const f = await ctx.store.getFolderById(folderId);
    if (!f || f.user_id !== userId) throw notFound('Folder not found');
    return f;
  }

  /** Applies a flag change or move to items, grouped by folder (one MODSEQ per folder). */
  async function groupByFolder(userId: number, ids: number[]): Promise<Map<number, number[]>> {
    const list = await rows<{ folder_id: number; uid: number }>(ctx.db, 'SELECT folder_id, uid FROM mail_items WHERE user_id = ? AND id IN (?)', [userId, ids]);
    const map = new Map<number, number[]>();
    for (const r of list) map.set(r.folder_id, [...(map.get(r.folder_id) ?? []), r.uid]);
    return map;
  }

  async function removeItems(userId: number, folderId: number, uids: number[]): Promise<void> {
    await ctx.store.storeFlags(folderId, uids, 'add', DELETED, null);
    await ctx.store.expunge(folderId, uids);
  }

  async function cleanupUploads(dir: string): Promise<void> {
    const now = Date.now();
    for (const f of await readdir(dir).catch(() => [] as string[])) {
      const p = join(dir, f);
      const st = await stat(p).catch(() => null);
      if (st && now - st.mtimeMs > UPLOAD_TTL_MS) await unlink(p).catch(() => {});
    }
  }

  return async (app: FastifyInstance) => {
    await app.register(multipart, { limits: { fileSize: ctx.config.maxMessageSize, files: 1, fields: 5 } });

    // -------------------------------------------------------------- folders
    app.get('/folders', { preHandler: auth }, async (req) => {
      const u = me(req);
      const list = await rows<{ id: number; path: string; special_use: string | null; message_count: number; unseen_count: number; total_bytes: number }>(
        ctx.db,
        'SELECT id, path, special_use, message_count, unseen_count, total_bytes FROM folders WHERE user_id = ?',
        [u.id],
      );
      const rank = (f: { special_use: string | null }) => (f.special_use ? SPECIAL_ORDER.indexOf(f.special_use) : 99);
      list.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
      const quota = await ctx.store.quota(u.id);
      return {
        folders: list.map((f) => ({ id: f.id, path: f.path, specialUse: f.special_use, messages: f.message_count, unseen: f.unseen_count, bytes: Number(f.total_bytes) })),
        quota,
      };
    });

    const FolderName = z.string().trim().min(1).max(200).regex(/^[^/\\]+(\/[^/\\]+)*$/, 'Invalid folder name');
    app.post('/folders', { preHandler: auth }, async (req) => {
      const u = me(req);
      const { path } = z.object({ path: FolderName }).parse(req.body);
      const f = await ctx.store.createFolder(u.id, path);
      return { id: f.id };
    });
    app.patch<{ Params: { id: string } }>('/folders/:id', { preHandler: auth }, async (req) => {
      const u = me(req);
      const f = await ownedFolder(u.id, Id.parse(req.params.id));
      if (f.special_use) throw badRequest('System folders cannot be renamed');
      const { path } = z.object({ path: FolderName }).parse(req.body);
      await ctx.store.renameFolder(u.id, f.path, path);
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/folders/:id', { preHandler: auth }, async (req) => {
      const u = me(req);
      const f = await ownedFolder(u.id, Id.parse(req.params.id));
      if (f.special_use) throw badRequest('System folders cannot be deleted');
      await ctx.store.deleteFolder(u.id, f.path);
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>('/folders/:id/empty', { preHandler: auth }, async (req) => {
      const u = me(req);
      const f = await ownedFolder(u.id, Id.parse(req.params.id));
      if (!['trash', 'junk'].includes(f.special_use ?? '')) throw badRequest('Only Trash and Junk can be emptied');
      const uids = await ctx.store.listUids(f.id);
      if (uids.length) await removeItems(u.id, f.id, uids);
      return { removed: uids.length };
    });

    // -------------------------------------------------------------- message list
    app.get<{ Params: { id: string }; Querystring: { before?: string; limit?: string; q?: string; unread?: string; flagged?: string } }>(
      '/folders/:id/messages',
      { preHandler: auth },
      async (req) => {
        const u = me(req);
        const f = await ownedFolder(u.id, Id.parse(req.params.id));
        const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
        const where = ['i.folder_id = ?'];
        const vals: unknown[] = [f.id];
        if (req.query.before) {
          where.push('i.uid < ?');
          vals.push(Number(req.query.before));
        }
        if (req.query.unread === '1') where.push('(i.flags & 1) = 0');
        if (req.query.flagged === '1') where.push('(i.flags & 4) <> 0');
        if (req.query.q) {
          const like = `%${req.query.q.trim()}%`;
          const ft = fulltextQuery(req.query.q);
          // Headers by substring (works for short words too) OR the full-text index for message bodies and attachment names.
          where.push(
            `(m.hdr_subject LIKE ? OR m.hdr_from LIKE ? OR CAST(m.envelope_json AS CHAR) LIKE ?${ft ? ' OR m.id IN (SELECT message_id FROM message_search WHERE MATCH(subject, addresses, attachment_names, body_text) AGAINST (? IN BOOLEAN MODE))' : ''})`,
          );
          vals.push(like, like, like, ...(ft ? [ft] : []));
        }
        const items = await rows<{
          id: number;
          uid: number;
          flags: number;
          internal_date: Date;
          size: number;
          hdr_subject: string | null;
          hdr_from: string | null;
          preview: string | null;
          has_attachments: number;
          envelope_json: unknown;
        }>(
          ctx.db,
          `SELECT i.id, i.uid, i.flags, i.internal_date, i.size, m.hdr_subject, m.hdr_from, m.preview, m.has_attachments, m.envelope_json
             FROM mail_items i JOIN messages m ON m.id = i.message_id
            WHERE ${where.join(' AND ')} AND (i.flags & 8) = 0 ORDER BY i.uid DESC LIMIT ?`,
          [...vals, limit + 1],
        );
        const more = items.length > limit;
        const page = items.slice(0, limit);
        return {
          folder: { id: f.id, path: f.path, specialUse: f.special_use, messages: f.message_count, unseen: f.unseen_count },
          items: page.map((m) => {
            const env = json<{ to: [string | null, string | null, string | null, string | null][] | null }>(m.envelope_json);
            return {
              id: m.id,
              uid: m.uid,
              subject: m.hdr_subject ?? '',
              from: m.hdr_from ?? '',
              to: (env?.to ?? []).slice(0, 3).map((a) => (a[2] && a[3] ? `${a[2]}@${a[3]}` : (a[0] ?? ''))),
              date: m.internal_date,
              size: Number(m.size),
              preview: m.preview ?? '',
              hasAttachments: Boolean(m.has_attachments),
              seen: Boolean(m.flags & SEEN),
              flagged: Boolean(m.flags & FLAGGED),
              answered: Boolean(m.flags & ANSWERED),
              forwarded: Boolean(m.flags & FORWARDED),
              draft: Boolean(m.flags & DRAFT),
            };
          }),
          nextBefore: more ? page[page.length - 1]!.uid : null,
        };
      },
    );

    /** Search every folder of the mailbox (newest first, max 200). */
    app.get<{ Querystring: { q?: string } }>('/search', { preHandler: auth }, async (req) => {
      const u = me(req);
      const q = (req.query.q ?? '').trim();
      if (!q) return { items: [] };
      const like = `%${q}%`;
      const ft = fulltextQuery(q);
      const items = await rows<{ id: number; uid: number; folder_id: number; path: string; special_use: string | null; flags: number; internal_date: Date; size: number; hdr_subject: string | null; hdr_from: string | null; preview: string | null; has_attachments: number }>(
        ctx.db,
        `SELECT i.id, i.uid, i.folder_id, f.path, f.special_use, i.flags, i.internal_date, i.size, m.hdr_subject, m.hdr_from, m.preview, m.has_attachments
           FROM mail_items i JOIN messages m ON m.id = i.message_id JOIN folders f ON f.id = i.folder_id
          WHERE i.user_id = ? AND (i.flags & 8) = 0
            AND (m.hdr_subject LIKE ? OR m.hdr_from LIKE ? OR CAST(m.envelope_json AS CHAR) LIKE ?${ft ? ' OR m.id IN (SELECT message_id FROM message_search WHERE MATCH(subject, addresses, attachment_names, body_text) AGAINST (? IN BOOLEAN MODE))' : ''})
          ORDER BY i.internal_date DESC LIMIT 200`,
        [u.id, like, like, like, ...(ft ? [ft] : [])],
      );
      return {
        items: items.map((m) => ({
          id: m.id,
          uid: m.uid,
          folderId: m.folder_id,
          folderPath: m.path,
          folderSpecialUse: m.special_use,
          subject: m.hdr_subject ?? '',
          from: m.hdr_from ?? '',
          to: [],
          date: m.internal_date,
          size: Number(m.size),
          preview: m.preview ?? '',
          hasAttachments: Boolean(m.has_attachments),
          seen: Boolean(m.flags & SEEN),
          flagged: Boolean(m.flags & FLAGGED),
          answered: Boolean(m.flags & ANSWERED),
          forwarded: Boolean(m.flags & FORWARDED),
          draft: Boolean(m.flags & DRAFT),
        })),
      };
    });

    // -------------------------------------------------------------- read
    app.get<{ Params: { id: string }; Querystring: { images?: string; markRead?: string } }>('/messages/:id', { preHandler: auth }, async (req) => {
      const u = me(req);
      const item = await owned(u.id, Id.parse(req.params.id));
      const p = await parsed(item);
      const showImages = req.query.images === '1';
      const inline = p.attachments.map((a) => ({ cid: a.cid, contentType: a.contentType, content: a.content }));
      const body = typeof p.html === 'string' && p.html ? sanitizeEmailHtml(p.html, inline, showImages) : { html: textToHtml(p.text ?? ''), remoteImages: false };
      if (req.query.markRead !== '0' && !(item.flags & SEEN)) {
        await ctx.store.storeFlags(item.folder_id, [item.uid], 'add', SEEN, null);
      }
      const usedCids = new Set<string>();
      if (typeof p.html === 'string') for (const m of p.html.matchAll(/cid:([^"'\s)>]+)/gi)) usedCids.add(m[1]!.toLowerCase());
      return {
        id: item.id,
        folderId: item.folder_id,
        folderSpecialUse: item.special_use,
        flags: { seen: true, flagged: Boolean(item.flags & FLAGGED), answered: Boolean(item.flags & ANSWERED), draft: Boolean(item.flags & DRAFT) },
        subject: p.subject ?? '',
        from: addrList(p.from),
        to: addrList(p.to),
        cc: addrList(p.cc),
        bcc: addrList(p.bcc),
        replyTo: addrList(p.replyTo),
        date: p.date ?? item.internal_date,
        messageId: p.messageId ?? null,
        inReplyTo: p.inReplyTo ?? null,
        references: Array.isArray(p.references) ? p.references.join(' ') : (p.references ?? null),
        html: body.html,
        remoteImages: body.remoteImages,
        text: p.text ?? '',
        attachments: p.attachments
          .map((a, index) => ({ index, filename: a.filename ?? `attachment-${index + 1}`, contentType: a.contentType, size: a.size, cid: a.cid ?? null, inline: Boolean(a.cid && usedCids.has(a.cid.toLowerCase())) }))
          .filter((a) => !a.inline),
        size: Number(item.size),
      };
    });

    app.get<{ Params: { id: string; index: string } }>('/messages/:id/attachments/:index', { preHandler: auth }, async (req, reply) => {
      const u = me(req);
      const item = await owned(u.id, Id.parse(req.params.id));
      const p = await parsed(item);
      const a = p.attachments[Number(req.params.index)];
      if (!a) throw notFound('Attachment not found');
      return reply
        .type(a.contentType || 'application/octet-stream')
        .header('content-disposition', contentDisposition(a.filename ?? 'attachment'))
        .header('x-content-type-options', 'nosniff')
        .header('content-security-policy', "default-src 'none'; sandbox")
        .send(a.content);
    });

    app.get<{ Params: { id: string } }>('/messages/:id/raw', { preHandler: auth }, async (req, reply) => {
      const u = me(req);
      const item = await owned(u.id, Id.parse(req.params.id));
      return reply
        .type('message/rfc822')
        .header('content-disposition', contentDisposition(`message-${item.id}.eml`))
        .send(await ctx.store.loadRaw(item));
    });

    // -------------------------------------------------------------- actions
    const ActionBody = z.object({
      ids: z.array(Id).min(1).max(1000),
      action: z.enum(['read', 'unread', 'flag', 'unflag', 'move', 'delete', 'junk', 'not_junk']),
      folderId: Id.optional(),
    });
    app.post('/messages/actions', { preHandler: auth }, async (req) => {
      const u = me(req);
      const b = ActionBody.parse(req.body);
      const groups = await groupByFolder(u.id, b.ids);
      const special = async (su: 'trash' | 'junk' | 'inbox') => (await ctx.store.getSpecialFolder(u.id, su))!;
      let target: number | null = null;
      if (b.action === 'move') target = (await ownedFolder(u.id, b.folderId ?? 0)).id;
      if (b.action === 'junk') target = (await special('junk')).id;
      if (b.action === 'not_junk') target = (await special('inbox')).id;
      const trash = await special('trash');
      for (const [folderId, uids] of groups) {
        switch (b.action) {
          case 'read':
          case 'unread':
            await ctx.store.storeFlags(folderId, uids, b.action === 'read' ? 'add' : 'remove', SEEN, null);
            break;
          case 'flag':
          case 'unflag':
            await ctx.store.storeFlags(folderId, uids, b.action === 'flag' ? 'add' : 'remove', FLAGGED, null);
            break;
          case 'delete':
            // Deleting from Trash (or Junk) removes for good; elsewhere it moves to Trash.
            if (folderId === trash.id || folderId === (await special('junk')).id) await removeItems(u.id, folderId, uids);
            else await ctx.store.move(folderId, uids, trash.id);
            break;
          default:
            if (target && target !== folderId) await ctx.store.move(folderId, uids, target);
        }
      }
      return { ok: true };
    });

    // -------------------------------------------------------------- uploads
    app.post('/uploads', { preHandler: auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const u = me(req);
      const file = await req.file();
      if (!file) throw badRequest('No file');
      const dir = uploadDir(ctx, u.id);
      await mkdir(dir, { recursive: true });
      void cleanupUploads(dir);
      const id = randomBytes(12).toString('hex');
      const path = join(dir, id);
      await pipeline(file.file, createWriteStream(path, { mode: 0o600 }));
      if (file.file.truncated) {
        await rm(path, { force: true });
        throw new HttpError(413, 'TOO_LARGE', 'The file is larger than the maximum message size');
      }
      const size = (await stat(path)).size;
      const meta: UploadMeta = { id, filename: (file.filename || 'attachment').slice(0, 200), contentType: file.mimetype || 'application/octet-stream', size, userId: u.id };
      await writeFile(join(dir, `${id}.json`), JSON.stringify(meta), { mode: 0o600 });
      return meta;
    });

    // -------------------------------------------------------------- compose
    async function carriedParts(userId: number, b: ComposeBody) {
      const out: { filename: string; contentType: string; content: Buffer }[] = [];
      const byItem = new Map<number, number[]>();
      for (const c of b.carried) byItem.set(c.itemId, [...(byItem.get(c.itemId) ?? []), c.index]);
      for (const [itemId, idx] of byItem) {
        const p = await parsed(await owned(userId, itemId));
        for (const i of idx) {
          const a = p.attachments[i];
          if (a) out.push({ filename: a.filename ?? `attachment-${i + 1}`, contentType: a.contentType, content: a.content });
        }
      }
      return out;
    }

    async function prepare(req: FastifyRequest) {
      const u = me(req);
      const b = ComposeBody.parse(req.body);
      const mine = await ctx.directory.userAddresses(u.id);
      if (!mine.includes(b.from)) throw forbidden(`You cannot send as ${b.from}`);
      const built = await buildMessage(ctx, { id: u.id, displayName: u.display_name }, b, await carriedParts(u.id, b));
      const total = built.raw.length;
      if (total > ctx.config.maxMessageSize) throw new HttpError(413, 'TOO_LARGE', 'The message with its attachments is too large');
      return { u, b, built };
    }

    async function dropDraft(userId: number, draftItemId: number | null | undefined): Promise<void> {
      if (!draftItemId) return;
      const d = await one<{ folder_id: number; uid: number; flags: number }>(ctx.db, 'SELECT folder_id, uid, flags FROM mail_items WHERE id = ? AND user_id = ?', [draftItemId, userId]);
      if (d && d.flags & DRAFT) await removeItems(userId, d.folder_id, [d.uid]);
    }

    app.post('/send', { preHandler: auth, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
      const { u, b, built } = await prepare(req);
      if (!built.recipients.length) throw badRequest('Add at least one recipient');
      const r = await resolveRecipients(ctx, built.recipients);
      if (r.rejected.length) throw badRequest(`No such mailbox here: ${r.rejected.join(', ')}`, 'UNKNOWN_RECIPIENT');
      const received = `Received: from webmail ([${req.ip}])\r\n\tby ${ctx.config.hostname} (Vayrone PostMaster) with HTTPS;\r\n\t${new Date().toUTCString().replace('GMT', '+0000')}\r\n`;
      const message = await ctx.store.ingest(Buffer.concat([Buffer.from(received), built.raw]));
      const res = await ctx.mailflow.submission({ message, envelopeFrom: b.from, senderUserId: u.id, localUserIds: r.local, external: r.external, clientIp: req.ip });
      if (res.rejected) throw new HttpError(422, 'REJECTED', res.rejected);

      // Sent copy (with Bcc, like Outlook), flags on the original, drop the draft.
      const sent = await ctx.store.getSpecialFolder(u.id, 'sent');
      if (sent) {
        const copy = await ctx.store.ingest(built.rawWithBcc);
        await ctx.store.append({ userId: u.id, folderId: sent.id, message: copy, flags: SEEN, origin: 'webmail' });
      }
      const mark = async (itemId: number | null | undefined, bit: number) => {
        if (!itemId) return;
        const it = await one<{ folder_id: number; uid: number }>(ctx.db, 'SELECT folder_id, uid FROM mail_items WHERE id = ? AND user_id = ?', [itemId, u.id]);
        if (it) await ctx.store.storeFlags(it.folder_id, [it.uid], 'add', bit, null);
      };
      await mark(b.replyToItemId, ANSWERED);
      await mark(b.forwardOfItemId, FORWARDED);
      await dropDraft(u.id, b.draftItemId);
      for (const id of b.uploads) await rm(join(uploadDir(ctx, u.id), id), { force: true }).then(() => rm(join(uploadDir(ctx, u.id), `${id}.json`), { force: true }));
      return { ok: true, messageId: built.messageId, queued: res.queueId !== null, delivered: res.outcomes.filter((o) => o.status === 'delivered').length };
    });

    app.post('/drafts', { preHandler: auth, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
      const { u, b, built } = await prepare(req);
      const drafts = await ctx.store.getSpecialFolder(u.id, 'drafts');
      if (!drafts) throw badRequest('No Drafts folder');
      const msg = await ctx.store.ingest(built.rawWithBcc);
      const r = await ctx.store.append({ userId: u.id, folderId: drafts.id, message: msg, flags: SEEN | DRAFT, origin: 'webmail' });
      await dropDraft(u.id, b.draftItemId);
      return { draftItemId: r.itemId };
    });

    // -------------------------------------------------------------- contacts
    app.get<{ Querystring: { q?: string } }>('/contacts', { preHandler: auth }, async (req) => {
      const u = me(req);
      const q = (req.query.q ?? '').trim().toLowerCase();
      if (q.length < 1) return [];
      const like = `%${q}%`;
      const directory = await rows<{ name: string; address: string }>(
        ctx.db,
        `SELECT COALESCE(us.display_name, l.name, '') AS name, CONCAT(a.local_part, '@', d.name) AS address
           FROM addresses a JOIN domains d ON d.id = a.domain_id
           LEFT JOIN users us ON us.id = a.user_id LEFT JOIN distribution_lists l ON l.id = a.list_id
          WHERE a.is_enabled = 1 AND (CONCAT(a.local_part, '@', d.name) LIKE ? OR us.display_name LIKE ? OR l.name LIKE ?)
          ORDER BY address LIMIT 8`,
        [like, like, like],
      );
      const recent = await rows<{ hdr_from: string }>(
        ctx.db,
        `SELECT DISTINCT m.hdr_from FROM mail_items i JOIN messages m ON m.id = i.message_id
          WHERE i.user_id = ? AND m.hdr_from LIKE ? ORDER BY i.id DESC LIMIT 8`,
        [u.id, like],
      );
      const seen = new Set(directory.map((d) => d.address.toLowerCase()));
      const fromRecent = recent
        .map((r) => {
          const m = /^(.*?)\s*<([^>]+)>$/.exec(r.hdr_from);
          return m ? { name: m[1]!.replace(/^"|"$/g, ''), address: m[2]!.toLowerCase() } : { name: '', address: r.hdr_from.toLowerCase() };
        })
        .filter((c) => c.address.includes('@') && !seen.has(c.address) && (seen.add(c.address), true));
      return [...directory, ...fromRecent].slice(0, 10);
    });

    app.get('/identities', { preHandler: auth }, async (req) => {
      const u = me(req);
      const addrs = await ctx.directory.userAddresses(u.id);
      const primary = u.login.toLowerCase();
      return { displayName: u.display_name, addresses: [primary, ...addrs.filter((a) => a !== primary)].filter((a) => addrs.includes(a)) };
    });

  };
}
