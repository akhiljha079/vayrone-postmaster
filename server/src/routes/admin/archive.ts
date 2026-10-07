// Compliance archive (read-only for everyone; retention removes items), retention policies.
// Every search, view and export is written to the audit log.
import { PassThrough } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { ARCHIVE_DEFAULTS, ARCHIVE_TREE_LIMIT, EXPORT_LIMIT, db as dbm, exportArchiveTree, exportMessages, fulltextQuery, type ArchivePolicy, type ArchiveTreeEntry, type CoreContext } from '@vpm/core';
import { audit, requireAdmin } from '../../guards.js';
import { badRequest, notFound, page, parsePatch } from '../../http.js';
import { attachmentOf, contentDisposition, renderMessage } from '../../webmail/render.js';

const { exec, json, one, rows } = dbm;
const Id = z.coerce.number().int().positive();

const Criteria = z.object({
  q: z.string().max(500).optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  direction: z.enum(['in', 'out', 'internal']).optional(),
  userId: z.coerce.number().int().positive().optional(),
  /** With userId: only that mailbox's received or sent mail. */
  role: z.enum(['received', 'sent']).optional(),
  sender: z.string().max(254).optional(),
  recipient: z.string().max(254).optional(),
  legalHold: z.coerce.boolean().optional(),
});
type Criteria = z.infer<typeof Criteria>;

function where(c: Criteria): { sql: string; vals: unknown[] } {
  const w: string[] = [];
  const v: unknown[] = [];
  if (c.from) (w.push('a.archived_at >= ?'), v.push(c.from));
  if (c.to) (w.push('a.archived_at < ?'), v.push(new Date(c.to.getTime() + 86400_000)));
  if (c.direction) (w.push('a.direction = ?'), v.push(c.direction));
  if (c.userId && c.role) (w.push('EXISTS (SELECT 1 FROM archive_item_users u WHERE u.archive_id = a.id AND u.user_id = ? AND u.role = ?)'), v.push(c.userId, c.role));
  else if (c.userId) (w.push('EXISTS (SELECT 1 FROM archive_item_users u WHERE u.archive_id = a.id AND u.user_id = ?)'), v.push(c.userId));
  if (c.sender) (w.push('(a.envelope_from LIKE ? OR m.hdr_from LIKE ?)'), v.push(`%${c.sender}%`, `%${c.sender}%`));
  if (c.recipient) (w.push('CAST(a.envelope_rcpts AS CHAR) LIKE ?'), v.push(`%${c.recipient.toLowerCase()}%`));
  if (c.legalHold) w.push('a.legal_hold = 1');
  if (c.q) {
    const ft = fulltextQuery(c.q);
    if (ft) (w.push('a.message_id IN (SELECT message_id FROM message_search WHERE MATCH(subject, addresses, attachment_names, body_text) AGAINST (? IN BOOLEAN MODE))'), v.push(ft));
    else (w.push('a.subject LIKE ?'), v.push(`%${c.q}%`));
  }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', vals: v };
}

export function archiveRoutes(ctx: CoreContext) {
  const read = requireAdmin(ctx, 'read', { auditorAllowed: true });
  const write = requireAdmin(ctx, 'write');
  const superOnly = requireAdmin(ctx, 'super');

  async function item(id: number) {
    const a = await one<{ id: number; message_id: number; storage_path: string; codec: number; legal_hold: number; direction: string; envelope_from: string; envelope_rcpts: unknown; archived_at: Date; retention_until: Date | null }>(
      ctx.db,
      'SELECT a.*, m.storage_path, m.codec FROM archive_items a JOIN messages m ON m.id = a.message_id WHERE a.id = ?',
      [id],
    );
    if (!a) throw notFound('Archived message not found');
    return a;
  }

  const logAccess = (req: FastifyRequest, action: string, target: number | null, details?: Record<string, unknown>) => audit(ctx, req, action, 'archive', target, details);

  /** ZIP of whole mailboxes from the archive, one folder per address with Received and Sent. */
  async function exportByMailbox(req: FastifyRequest, reply: FastifyReply, userIds?: number[]) {
    const entries = (
      await rows<{ messageId: number; address: string | null; login: string | null; userId: number; role: 'received' | 'sent'; archiveId: number }>(
        ctx.db,
        `SELECT a.message_id AS messageId, x.address, u.login, x.user_id AS userId, x.role, a.id AS archiveId
           FROM archive_item_users x
           JOIN archive_items a ON a.id = x.archive_id
           LEFT JOIN users u ON u.id = x.user_id
          ${userIds?.length ? 'WHERE x.user_id IN (?)' : ''}
          ORDER BY x.user_id, x.role, a.id
          LIMIT ?`,
        userIds?.length ? [userIds, ARCHIVE_TREE_LIMIT] : [ARCHIVE_TREE_LIMIT],
      )
    ).map<ArchiveTreeEntry>((e) => ({ messageId: e.messageId, address: e.address ?? e.login ?? `deleted-user-${e.userId}`, role: e.role, archiveId: e.archiveId }));
    if (!entries.length) throw badRequest('Nothing to export');
    const mailboxes = [...new Set(entries.map((e) => e.address))];
    const rec = await exec(ctx.db, "INSERT INTO archive_exports (requested_by, criteria, format, status, item_count, created_at, finished_at) VALUES (?,?,'eml_zip','done',?,?,?)", [
      req.auth!.user.id,
      JSON.stringify({ layout: 'mailboxes', userIds: userIds ?? 'all' }),
      entries.length,
      new Date(),
      new Date(),
    ]);
    await logAccess(req, 'archive.export', rec.insertId, { layout: 'mailboxes', mailboxes: mailboxes.slice(0, 50), count: entries.length });
    const stream = new PassThrough();
    void exportArchiveTree(ctx.db, ctx.blobs, entries, stream).catch((err) => stream.destroy(err as Error));
    const name = mailboxes.length === 1 ? `archive-${mailboxes[0]}-${new Date().toISOString().slice(0, 10)}.zip` : `archive-mailboxes-${new Date().toISOString().slice(0, 10)}.zip`;
    return reply.type('application/zip').header('content-disposition', contentDisposition(name)).send(stream);
  }

  return async (app: FastifyInstance) => {
    // ------------------------------------------------------------ policy
    app.get('/archive/policy', { preHandler: read }, async () => ({
      ...ARCHIVE_DEFAULTS,
      ...(await ctx.settings.get<Partial<ArchivePolicy>>('archive', 'policy', {})),
      licensed: ctx.license.feature('archive'),
    }));
    app.put('/archive/policy', { preHandler: superOnly }, async (req) => {
      const b = parsePatch(z.object({ enabled: z.boolean(), retentionDays: z.number().int().min(1).max(36500).nullable(), includeInternal: z.boolean() }), req.body);
      const next = { ...ARCHIVE_DEFAULTS, ...(await ctx.settings.get<Partial<ArchivePolicy>>('archive', 'policy', {})), ...b };
      await ctx.settings.set('archive', 'policy', next, req.auth!.user.id);
      await audit(ctx, req, 'archive.policy_update', 'settings', 'archive.policy', b);
      return next;
    });

    // ------------------------------------------------------------ mailboxes (one folder per address)
    /** Every address with archived mail: received and sent counts. Includes deleted accounts. */
    app.get<{ Querystring: { q?: string } }>('/archive/mailboxes', { preHandler: read }, async (req) => {
      const q = z.string().max(254).optional().parse(req.query.q)?.trim();
      const list = await rows<{ userId: number; address: string | null; name: string | null; exists: number; received: number; sent: number; last: Date | null }>(
        ctx.db,
        `SELECT x.user_id AS userId, COALESCE(MAX(x.address), MAX(u.login)) AS address, MAX(u.display_name) AS name, COUNT(u.id) > 0 AS \`exists\`,
                SUM(x.role = 'received') AS received, SUM(x.role = 'sent') AS sent, MAX(a.archived_at) AS last
           FROM archive_item_users x
           JOIN archive_items a ON a.id = x.archive_id
           LEFT JOIN users u ON u.id = x.user_id
          GROUP BY x.user_id
          ORDER BY address`,
      );
      const items = list
        .map((m) => ({ userId: m.userId, address: m.address ?? `deleted-user-${m.userId}`, name: m.name, deleted: !Number(m.exists), received: Number(m.received), sent: Number(m.sent), last: m.last }))
        .filter((m) => !q || m.address.toLowerCase().includes(q.toLowerCase()) || (m.name ?? '').toLowerCase().includes(q.toLowerCase()));
      await logAccess(req, 'archive.mailboxes', null, q ? { q } : undefined);
      return { items };
    });

    // ------------------------------------------------------------ search
    app.get<{ Querystring: Record<string, string> }>('/archive/search', { preHandler: read }, async (req) => {
      const c = Criteria.parse(req.query);
      const { limit, offset, page: p } = page(req.query);
      const w = where(c);
      const items = await rows(
        ctx.db,
        `SELECT a.id, a.direction, a.envelope_from AS envelopeFrom, a.envelope_rcpts AS envelopeRcpts, a.subject, a.hdr_date AS date, a.size,
                a.archived_at AS archivedAt, a.retention_until AS retentionUntil, a.legal_hold AS legalHold, m.hdr_from AS fromHeader, m.has_attachments AS hasAttachments
           FROM archive_items a JOIN messages m ON m.id = a.message_id ${w.sql} ORDER BY a.id DESC LIMIT ? OFFSET ?`,
        [...w.vals, limit, offset],
      );
      const total = await one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM archive_items a JOIN messages m ON m.id = a.message_id ${w.sql}`, w.vals);
      await logAccess(req, 'archive.search', null, c as Record<string, unknown>);
      return { items: items.map((i) => ({ ...i, envelopeRcpts: json<string[]>(i.envelopeRcpts) ?? [] })), total: Number(total?.n ?? 0), page: p };
    });

    app.get<{ Params: { id: string }; Querystring: { images?: string } }>('/archive/items/:id', { preHandler: read }, async (req) => {
      const a = await item(Id.parse(req.params.id));
      const r = await renderMessage(await ctx.store.loadRaw(a), req.query.images === '1');
      const users = await rows<{ login: string; role: string }>(
        ctx.db,
        'SELECT COALESCE(x.address, u.login) AS login, x.role FROM archive_item_users x LEFT JOIN users u ON u.id = x.user_id WHERE x.archive_id = ? ORDER BY x.role, login',
        [a.id],
      );
      await logAccess(req, 'archive.view', a.id);
      return {
        ...r,
        id: a.id,
        direction: a.direction,
        envelopeFrom: a.envelope_from,
        envelopeRcpts: json<string[]>(a.envelope_rcpts) ?? [],
        archivedAt: a.archived_at,
        retentionUntil: a.retention_until,
        legalHold: Boolean(a.legal_hold),
        users: [...new Set(users.map((u) => u.login))],
        mailboxes: users.map((u) => ({ address: u.login, role: u.role })),
      };
    });

    app.get<{ Params: { id: string } }>('/archive/items/:id/raw', { preHandler: read }, async (req, reply) => {
      const a = await item(Id.parse(req.params.id));
      await logAccess(req, 'archive.download', a.id);
      return reply.type('message/rfc822').header('content-disposition', contentDisposition(`archive-${a.id}.eml`)).send(await ctx.store.loadRaw(a));
    });

    app.get<{ Params: { id: string; index: string } }>('/archive/items/:id/attachments/:index', { preHandler: read }, async (req, reply) => {
      const a = await item(Id.parse(req.params.id));
      const att = await attachmentOf(await ctx.store.loadRaw(a), Number(req.params.index));
      if (!att) throw notFound('Attachment not found');
      await logAccess(req, 'archive.download_attachment', a.id, { index: Number(req.params.index) });
      return reply.type(att.contentType).header('content-disposition', contentDisposition(att.filename)).header('x-content-type-options', 'nosniff').header('content-security-policy', "default-src 'none'; sandbox").send(att.content);
    });

    /** Streams matching messages as MBOX or ZIP (max 10,000). Logged with its criteria. */
    app.post('/archive/export', { preHandler: read, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const b = z
        .object({
          format: z.enum(['mbox', 'eml_zip']),
          ids: z.array(Id).max(EXPORT_LIMIT).optional(),
          criteria: Criteria.optional(),
          /** 'mailboxes': ZIP with <address>/Received and <address>/Sent folders. */
          layout: z.enum(['flat', 'mailboxes']).default('flat'),
          /** layout 'mailboxes': these mailboxes (all when omitted). */
          userIds: z.array(Id).max(10_000).optional(),
        })
        .parse(req.body);
      if (b.layout === 'mailboxes') return exportByMailbox(req, reply, b.userIds);
      let ids: number[];
      if (b.ids?.length) {
        ids = (await rows<{ message_id: number }>(ctx.db, 'SELECT message_id FROM archive_items WHERE id IN (?) ORDER BY id', [b.ids])).map((r) => r.message_id);
      } else {
        const w = where(b.criteria ?? {});
        ids = (await rows<{ message_id: number }>(ctx.db, `SELECT a.message_id FROM archive_items a JOIN messages m ON m.id = a.message_id ${w.sql} ORDER BY a.id LIMIT ?`, [...w.vals, EXPORT_LIMIT])).map((r) => r.message_id);
      }
      if (!ids.length) throw badRequest('Nothing to export');
      const rec = await exec(ctx.db, "INSERT INTO archive_exports (requested_by, criteria, format, status, item_count, created_at, finished_at) VALUES (?,?,?,'done',?,?,?)", [
        req.auth!.user.id,
        JSON.stringify(b.ids?.length ? { ids: b.ids } : (b.criteria ?? {})),
        b.format,
        ids.length,
        new Date(),
        new Date(),
      ]);
      await logAccess(req, 'archive.export', rec.insertId, { format: b.format, count: ids.length, criteria: b.criteria ?? { ids: b.ids?.length } });
      const stream = new PassThrough();
      void exportMessages(ctx.db, ctx.blobs, ids, b.format, stream).catch((err) => stream.destroy(err as Error));
      const name = `archive-export-${new Date().toISOString().slice(0, 10)}.${b.format === 'mbox' ? 'mbox' : 'zip'}`;
      return reply.type(b.format === 'mbox' ? 'application/mbox' : 'application/zip').header('content-disposition', contentDisposition(name)).send(stream);
    });

    /** Copies an archived message back into a mailbox ("Restored from archive" folder). */
    app.post<{ Params: { id: string } }>('/archive/items/:id/restore', { preHandler: write }, async (req) => {
      const a = await item(Id.parse(req.params.id));
      const { userId } = z.object({ userId: Id }).parse(req.body);
      const u = await one<{ has_mailbox: number }>(ctx.db, 'SELECT has_mailbox FROM users WHERE id = ?', [userId]);
      if (!u?.has_mailbox) throw badRequest('Choose a user with a mailbox');
      const path = 'Restored from archive';
      const f = (await ctx.store.getFolder(userId, path)) ?? (await ctx.store.createFolder(userId, path));
      const m = await one<{ size_raw: number }>(ctx.db, 'SELECT size_raw FROM messages WHERE id = ?', [a.message_id]);
      const r = await ctx.store.append({ userId, folderId: f.id, message: { id: a.message_id, size: Number(m!.size_raw) } as Parameters<typeof ctx.store.append>[0]['message'], origin: 'restore' });
      await logAccess(req, 'archive.restore', a.id, { userId, uid: r.uid });
      return { ok: true, folder: path };
    });

    app.post<{ Params: { id: string } }>('/archive/items/:id/legal-hold', { preHandler: superOnly }, async (req) => {
      const a = await item(Id.parse(req.params.id));
      const { hold } = z.object({ hold: z.boolean() }).parse(req.body);
      await exec(ctx.db, 'UPDATE archive_items SET legal_hold = ? WHERE id = ?', [hold ? 1 : 0, a.id]);
      await logAccess(req, hold ? 'archive.legal_hold_on' : 'archive.legal_hold_off', a.id);
      return { ok: true };
    });

    app.get('/archive/stats', { preHandler: read }, async () => {
      const s = await one<{ n: number; bytes: number; held: number; oldest: Date | null }>(
        ctx.db,
        'SELECT COUNT(*) n, COALESCE(SUM(size),0) bytes, COALESCE(SUM(legal_hold),0) held, MIN(archived_at) oldest FROM archive_items',
      );
      const pending = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM messages m LEFT JOIN message_search s ON s.message_id = m.id WHERE s.message_id IS NULL AND m.refcount > 0');
      return { items: Number(s?.n ?? 0), bytes: Number(s?.bytes ?? 0), legalHold: Number(s?.held ?? 0), oldest: s?.oldest ?? null, notYetIndexed: Number(pending?.n ?? 0) };
    });

    // ------------------------------------------------------------ retention policies
    const Policy = z.object({
      name: z.string().trim().min(1).max(200),
      target: z.enum(['archive', 'mailbox_folder']),
      scope: z.enum(['all', 'domain', 'group', 'user']).default('all'),
      scopeId: z.number().int().positive().nullable().optional(),
      specialUse: z.enum(['inbox', 'sent', 'drafts', 'trash', 'junk', 'archive']).nullable().optional(),
      keepDays: z.number().int().min(1).max(36500),
      isEnabled: z.boolean().default(true),
    });
    app.get('/retention-policies', { preHandler: read }, async () =>
      rows(ctx.db, 'SELECT id, name, target, scope, scope_id AS scopeId, special_use AS specialUse, keep_days AS keepDays, is_enabled AS isEnabled FROM retention_policies ORDER BY target, id'),
    );
    app.post('/retention-policies', { preHandler: superOnly }, async (req) => {
      const b = Policy.parse(req.body);
      if (b.target === 'mailbox_folder' && !b.specialUse) throw badRequest('Choose which folder (e.g. Trash) the policy cleans up');
      if (b.scope !== 'all' && !b.scopeId) throw badRequest('Choose the domain, group or user');
      const r = await exec(ctx.db, 'INSERT INTO retention_policies (name, target, scope, scope_id, special_use, keep_days, is_enabled, created_at) VALUES (?,?,?,?,?,?,?,?)', [
        b.name,
        b.target,
        b.scope,
        b.scope === 'all' ? null : b.scopeId,
        b.target === 'mailbox_folder' ? b.specialUse : null,
        b.keepDays,
        b.isEnabled ? 1 : 0,
        new Date(),
      ]);
      await audit(ctx, req, 'retention.create', 'retention_policy', r.insertId, b);
      return { id: r.insertId };
    });
    app.patch<{ Params: { id: string } }>('/retention-policies/:id', { preHandler: superOnly }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(Policy.pick({ name: true, keepDays: true, isEnabled: true }), req.body);
      const map: Record<string, string> = { name: 'name', keepDays: 'keep_days', isEnabled: 'is_enabled' };
      const sets = Object.keys(b).map((k) => `${map[k]} = ?`);
      if (sets.length) await exec(ctx.db, `UPDATE retention_policies SET ${sets.join(', ')} WHERE id = ?`, [...Object.values(b).map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)), id]);
      await audit(ctx, req, 'retention.update', 'retention_policy', id, b);
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/retention-policies/:id', { preHandler: superOnly }, async (req) => {
      const id = Id.parse(req.params.id);
      await exec(ctx.db, 'DELETE FROM retention_policies WHERE id = ?', [id]);
      await audit(ctx, req, 'retention.delete', 'retention_policy', id);
      return { ok: true };
    });
  };
}
