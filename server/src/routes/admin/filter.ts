// Spam, antivirus and attachment filtering; quarantine; sender allow/block lists.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { clamScan, closeQuarantine, db as dbm, FILTER_DEFAULTS, listAttachments, quarantineRecipients, type CoreContext, type FilterSettings, type QuarantineRow } from '@vpm/core';
import { audit, requireAdmin } from '../../guards.js';
import { badRequest, forbidden, notFound, page } from '../../http.js';

const { one, rows, tx } = dbm;
const Id = z.coerce.number().int().positive();
const Dir = z.enum(['in', 'internal', 'out']);
/** EICAR test string: harmless, but every virus scanner reports it. */
const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

const FilterBody = z.object({
  spam: z.object({
    engine: z.enum(['off', 'builtin', 'rspamd']),
    rspamdUrl: z.url().max(300),
    junkScore: z.number().min(1).max(100),
    quarantineScore: z.number().min(1).max(200).nullable(),
  }),
  antivirus: z.object({
    engine: z.enum(['off', 'clamav']),
    host: z.string().trim().max(253),
    port: z.number().int().min(1).max(65535),
    socket: z.string().trim().max(300).nullable(),
    onError: z.enum(['deliver', 'quarantine']),
  }),
  attachments: z.object({
    enabled: z.boolean(),
    blocked: z.array(z.string().trim().toLowerCase().regex(/^\.?[a-z0-9]{1,15}$/, 'Extensions like exe or .js')).max(200),
    scanZip: z.boolean(),
    directions: z.array(Dir).max(3),
  }),
  quarantineDays: z.number().int().min(1).max(365),
  notifyRecipients: z.boolean(),
});

export function filterRoutes(ctx: CoreContext) {
  const read = requireAdmin(ctx, 'read');
  const write = requireAdmin(ctx, 'write');
  const owner = requireAdmin(ctx, 'super');

  return async (app: FastifyInstance) => {
    app.get('/filter', { preHandler: read }, async () => ({ ...(await ctx.mailflow.filter!.config()), defaults: FILTER_DEFAULTS, antivirusLicensed: ctx.license.feature('antivirus') }));

    app.put('/filter', { preHandler: owner }, async (req) => {
      const b = FilterBody.parse(req.body);
      if (b.antivirus.engine === 'clamav' && !ctx.license.feature('antivirus')) throw forbidden('Virus scanning is not included in this licence', 'LICENSE_FEATURE');
      const v: FilterSettings = { ...b, attachments: { ...b.attachments, blocked: [...new Set(b.attachments.blocked.map((x) => x.replace(/^\./, '')))] } };
      if (b.spam.quarantineScore !== null && b.spam.quarantineScore <= b.spam.junkScore) throw badRequest('The quarantine score must be higher than the Junk score');
      await ctx.settings.set('filter', 'config', v, req.auth!.user.id);
      await audit(ctx, req, 'filter.update', 'settings', 'filter', { spam: b.spam.engine, antivirus: b.antivirus.engine, attachments: b.attachments.enabled });
      return v;
    });

    /** Sends the EICAR test file and a clean file to ClamAV. */
    app.post('/filter/test-antivirus', { preHandler: write, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => {
      const c = (await ctx.mailflow.filter!.config()).antivirus;
      const opts = { host: c.host, port: c.port, ...(c.socket ? { socket: c.socket } : {}), timeoutMs: 15_000 };
      try {
        const bad = await clamScan(Buffer.from(EICAR), opts);
        const good = await clamScan(Buffer.from('Hello from Vayrone PostMaster'), opts);
        const ok = !bad.clean && good.clean;
        return { ok, message: ok ? `ClamAV is working (test file detected as ${'signature' in bad ? bad.signature : '?'})` : 'ClamAV answered but did not detect the test file' };
      } catch (e) {
        return { ok: false, message: (e as Error).message };
      }
    });

    // ------------------------------------------------------------ quarantine
    app.get<{ Querystring: { kind?: string; state?: string; page?: string; q?: string } }>('/quarantine', { preHandler: read }, async (req) => {
      const { limit, offset } = page(req.query);
      const where: string[] = [];
      const p: unknown[] = [];
      const state = req.query.state ?? 'held';
      if (state === 'held') where.push('q.released_at IS NULL AND q.deleted_at IS NULL');
      else if (state === 'released') where.push('q.released_at IS NOT NULL');
      else if (state === 'deleted') where.push('q.deleted_at IS NOT NULL');
      if (req.query.kind) (where.push('q.kind = ?'), p.push(req.query.kind));
      if (req.query.q) (where.push('(q.envelope_from LIKE ? OR q.subject LIKE ?)'), p.push(`%${req.query.q}%`, `%${req.query.q}%`));
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const items = await rows<QuarantineRow>(ctx.db, `SELECT q.* FROM quarantine q ${w} ORDER BY q.id DESC LIMIT ? OFFSET ?`, [...p, limit, offset]);
      const ids = [...new Set(items.flatMap((i) => quarantineRecipients(i).map((r) => r.userId)))];
      const logins = new Map((ids.length ? await rows<{ id: number; login: string }>(ctx.db, 'SELECT id, login FROM users WHERE id IN (?)', [ids]) : []).map((u) => [u.id, u.login]));
      const total = Number((await one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM quarantine q ${w}`, p))!.n);
      return {
        total,
        items: items.map((i) => ({
          id: i.id,
          kind: i.kind,
          direction: i.direction,
          reason: i.reason,
          from: i.envelope_from,
          subject: i.subject,
          size: i.size,
          recipients: quarantineRecipients(i).map((r) => logins.get(r.userId) ?? `#${r.userId}`),
          createdAt: i.created_at,
          releasedAt: i.released_at,
          deletedAt: i.deleted_at,
        })),
      };
    });

    app.get<{ Params: { id: string } }>('/quarantine/:id', { preHandler: read }, async (req) => {
      const row = await one<QuarantineRow>(ctx.db, 'SELECT * FROM quarantine WHERE id = ?', [Id.parse(req.params.id)]);
      if (!row) throw notFound('Not found');
      const m = await ctx.store.getMessage(row.message_id);
      // Headers and attachment names only: held content is never rendered.
      return {
        id: row.id,
        kind: row.kind,
        reason: row.reason,
        headers: m ? m.parsed.headerRaw.toString('utf8').slice(0, 20_000) : null,
        attachments: m ? listAttachments(m.raw, m.parsed.tree).map((a) => ({ name: a.display, size: a.size })) : [],
      };
    });

    app.post<{ Params: { id: string } }>('/quarantine/:id/release', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const row = await one<QuarantineRow>(ctx.db, 'SELECT * FROM quarantine WHERE id = ? AND released_at IS NULL AND deleted_at IS NULL', [id]);
      if (!row) throw notFound('This message is no longer held');
      // Releasing a virus is a super admin decision.
      if (row.kind === 'virus' && req.auth!.user.role !== 'super_admin') throw forbidden('Only a super admin can release a message with a virus');
      const recipients = quarantineRecipients(row);
      const outcomes = await ctx.mailflow.releaseHeld(row, recipients);
      await tx(ctx.db, (c) => closeQuarantine(c, id, 'released', req.auth!.user.id));
      await audit(ctx, req, 'quarantine.release', 'quarantine', id, { kind: row.kind, reason: row.reason, from: row.envelope_from });
      return { ok: true, delivered: outcomes.filter((o) => o.status === 'delivered').length };
    });

    app.post<{ Params: { id: string } }>('/quarantine/:id/delete', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const row = await tx(ctx.db, (c) => closeQuarantine(c, id, 'deleted', req.auth!.user.id));
      if (!row) throw notFound('This message is no longer held');
      await audit(ctx, req, 'quarantine.delete', 'quarantine', id, { kind: row.kind });
      return { ok: true };
    });

    // ------------------------------------------------------------ sender lists (server-wide)
    app.get('/sender-lists', { preHandler: read }, async () =>
      rows(ctx.db, "SELECT s.id, s.pattern, s.kind, s.source, s.created_at AS createdAt FROM sender_lists s WHERE s.user_id IS NULL ORDER BY s.kind, s.pattern"),
    );
    app.post('/sender-lists', { preHandler: write }, async (req) => {
      const b = z
        .object({ pattern: z.string().trim().toLowerCase().max(254).regex(/^([^\s@]+@[^\s@]+\.[^\s@]+|@[^\s@]+\.[^\s@]+)$/, 'An address (name@domain.com) or a domain (@domain.com)'), kind: z.enum(['allow', 'block']) })
        .parse(req.body);
      await ctx.db.query("INSERT INTO sender_lists (user_id, pattern, kind, source, created_at) VALUES (NULL, ?, ?, 'admin', ?) ON DUPLICATE KEY UPDATE kind = VALUES(kind)", [b.pattern, b.kind, new Date()]);
      await audit(ctx, req, 'filter.sender_list', 'sender_list', b.pattern, b);
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/sender-lists/:id', { preHandler: write }, async (req) => {
      await ctx.db.query('DELETE FROM sender_lists WHERE id = ? AND user_id IS NULL', [Id.parse(req.params.id)]);
      return { ok: true };
    });
  };
}
