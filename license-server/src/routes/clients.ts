import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LsContext } from '../context.js';
import { exec, one, rows } from '../db.js';
import { requireStaff, scopeOf } from '../auth.js';
import { notFound, page, parsePatch } from '../http.js';
import { logEvent } from '../services/licensing.js';

const opt = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
export const ClientBody = z.object({
  company: z.string().trim().min(2).max(200),
  contactName: opt(200),
  email: z.email().max(254).nullish().or(z.literal('')).transform((v) => v || null),
  phone: opt(30),
  whatsapp: opt(30),
  city: opt(100),
  state: opt(100),
  gstin: z.string().trim().toUpperCase().regex(/^[0-9]{2}[A-Z0-9]{13}$/, 'GSTIN must be 15 characters').nullish().or(z.literal('')).transform((v) => v || null),
  address: opt(500),
  notes: opt(5000),
  resellerId: z.number().int().positive().nullish(),
});

const COLS: Record<string, string> = { company: 'company', contactName: 'contact_name', email: 'email', phone: 'phone', whatsapp: 'whatsapp', city: 'city', state: 'state', gstin: 'gstin', address: 'address', notes: 'notes', resellerId: 'reseller_id' };

export const clientSelect = `SELECT c.id, c.company, c.contact_name contactName, c.email, c.phone, c.whatsapp, c.city, c.state, c.gstin, c.address, c.notes,
  c.reseller_id resellerId, r.name resellerName, c.created_at createdAt FROM clients c LEFT JOIN resellers r ON r.id = c.reseller_id`;

export function clientRoutes(ctx: LsContext) {
  const any = requireStaff();
  return async (app: FastifyInstance) => {
    app.get<{ Querystring: { q?: string; page?: string } }>('/clients', { preHandler: any }, async (req) => {
      const scope = scopeOf(req);
      const { limit, offset } = page(req.query);
      const where: string[] = [];
      const p: unknown[] = [];
      if (scope) (where.push('c.reseller_id = ?'), p.push(scope));
      if (req.query.q) {
        where.push('(c.company LIKE ? OR c.email LIKE ? OR c.phone LIKE ? OR c.city LIKE ?)');
        const like = `%${req.query.q}%`;
        p.push(like, like, like, like);
      }
      const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const items = await rows(
        ctx.db,
        `${clientSelect.replace('FROM clients c', ', (SELECT COUNT(*) FROM licenses l WHERE l.client_id = c.id AND l.status = \'active\') activeLicenses FROM clients c')}${w} ORDER BY c.company LIMIT ? OFFSET ?`,
        [...p, limit, offset],
      );
      const total = (await one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM clients c${w}`, p))!.n;
      return { items, total: Number(total) };
    });

    app.get<{ Params: { id: string } }>('/clients/:id', { preHandler: any }, async (req) => {
      const scope = scopeOf(req);
      const c = await one(ctx.db, `${clientSelect} WHERE c.id = ?${scope ? ' AND c.reseller_id = ?' : ''}`, scope ? [req.params.id, scope] : [req.params.id]);
      if (!c) throw notFound('Client not found');
      const licenses = await rows(
        ctx.db,
        `SELECT l.id, l.license_id licenseId, p.name plan, l.max_users maxUsers, l.status, l.expires_at expiresAt, l.amc_expires_at amcExpiresAt
           FROM licenses l JOIN plans p ON p.id = l.plan_id WHERE l.client_id = ? ORDER BY l.id DESC`,
        [req.params.id],
      );
      return { ...c, licenses };
    });

    app.post('/clients', { preHandler: any }, async (req) => {
      const b = ClientBody.parse(req.body);
      const scope = scopeOf(req);
      const now = new Date();
      const values = { ...Object.fromEntries(Object.entries(b).map(([k, v]) => [COLS[k], v ?? null])), reseller_id: scope ?? b.resellerId ?? null, created_at: now, updated_at: now };
      const r = await exec(ctx.db, 'INSERT INTO clients SET ?', [values]);
      await logEvent(ctx.db, { kind: 'client_create', actor: { userId: req.staff!.id, resellerId: scope, ip: req.ip }, detail: { clientId: r.insertId, company: b.company } });
      return { id: r.insertId };
    });

    app.patch<{ Params: { id: string } }>('/clients/:id', { preHandler: any }, async (req) => {
      const scope = scopeOf(req);
      const b = parsePatch(ClientBody, req.body);
      if (scope) delete b.resellerId;
      const c = await one(ctx.db, `SELECT id FROM clients WHERE id = ?${scope ? ' AND reseller_id = ?' : ''}`, scope ? [req.params.id, scope] : [req.params.id]);
      if (!c) throw notFound('Client not found');
      const set = Object.fromEntries(Object.entries(b).map(([k, v]) => [COLS[k], v ?? null]));
      await exec(ctx.db, 'UPDATE clients SET ? WHERE id = ?', [{ ...set, updated_at: new Date() }, req.params.id]);
      await logEvent(ctx.db, { kind: 'client_update', actor: { userId: req.staff!.id, resellerId: scope, ip: req.ip }, detail: { clientId: Number(req.params.id), fields: Object.keys(b) } });
      return { ok: true };
    });
  };
}
