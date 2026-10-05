// Plans (with per-user price slabs) and reseller accounts.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { FEATURES } from '@vpm/license-client/format';
import type { LsContext } from '../context.js';
import { exec, json, one, rows } from '../db.js';
import { requireStaff, scopeOf } from '../auth.js';
import { badRequest, notFound, parsePatch } from '../http.js';
import { logEvent } from '../services/licensing.js';
import { quote, validateSlabs, type Slab } from '../services/pricing.js';

const PlanBody = z.object({
  code: z.string().trim().toLowerCase().regex(/^[a-z0-9_-]{2,40}$/),
  name: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).nullish(),
  features: z.array(z.string().regex(/^[a-z0-9_]{2,40}$/)).max(30),
  maxExternalAccounts: z.number().int().min(0).nullable(),
  minUsers: z.number().int().min(1).max(100000).default(1),
  slabs: z.array(z.object({ upTo: z.number().int().positive().nullable(), pricePerUser: z.number().min(0).max(1e7) })).min(1).max(20),
  termMonths: z.number().int().min(0).max(120),
  amcPct: z.number().min(0).max(100),
  isActive: z.boolean().default(true),
});
const PLAN_COLS: Record<string, string> = { code: 'code', name: 'name', description: 'description', maxExternalAccounts: 'max_external_accounts', minUsers: 'min_users', termMonths: 'term_months', amcPct: 'amc_pct', isActive: 'is_active' };

const ResellerBody = z.object({
  name: z.string().trim().min(2).max(200),
  contactName: z.string().trim().max(200).nullish(),
  email: z.email().nullish().or(z.literal('')).transform((v) => v || null),
  phone: z.string().trim().max(30).nullish(),
  city: z.string().trim().max(100).nullish(),
  gstin: z.string().trim().toUpperCase().max(15).nullish(),
  discountPct: z.number().min(0).max(90),
  quotaLicenses: z.number().int().min(0).nullable(),
  quotaUsers: z.number().int().min(0).nullable(),
  isEnabled: z.boolean().default(true),
  notes: z.string().max(5000).nullish(),
});
const RES_COLS: Record<string, string> = { name: 'name', contactName: 'contact_name', email: 'email', phone: 'phone', city: 'city', gstin: 'gstin', discountPct: 'discount_pct', quotaLicenses: 'quota_licenses', quotaUsers: 'quota_users', isEnabled: 'is_enabled', notes: 'notes' };

function planOut(p: Record<string, unknown>) {
  return {
    id: p.id,
    code: p.code,
    name: p.name,
    description: p.description,
    features: json<string[]>(p.features),
    maxExternalAccounts: p.max_external_accounts,
    minUsers: p.min_users,
    slabs: json<Slab[]>(p.slabs),
    termMonths: p.term_months,
    amcPct: Number(p.amc_pct),
    isActive: Boolean(p.is_active),
  };
}

export async function resellerUsage(q: LsContext['db'], resellerId: number, excludeLicenseId?: number): Promise<{ licenses: number; users: number }> {
  const r = await one<{ n: number; u: number | null }>(
    q,
    `SELECT COUNT(*) n, SUM(max_users) u FROM licenses WHERE reseller_id = ? AND status <> 'revoked'${excludeLicenseId ? ' AND id <> ?' : ''}`,
    excludeLicenseId ? [resellerId, excludeLicenseId] : [resellerId],
  );
  return { licenses: Number(r?.n ?? 0), users: Number(r?.u ?? 0) };
}

export function catalogRoutes(ctx: LsContext) {
  const any = requireStaff();
  const owner = requireStaff('owner');
  const vayrone = requireStaff('owner', 'staff');
  const actor = (req: { staff: { id: number } | null; ip: string }) => ({ userId: req.staff!.id, resellerId: null, ip: req.ip });

  return async (app: FastifyInstance) => {
    app.get('/features', { preHandler: any }, async () => FEATURES);

    app.get('/plans', { preHandler: any }, async (req) => {
      const list = (await rows<Record<string, unknown>>(ctx.db, 'SELECT * FROM plans ORDER BY is_active DESC, name')).map(planOut);
      return scopeOf(req) ? list.filter((p) => p.isActive) : list;
    });

    app.post('/plans', { preHandler: owner }, async (req) => {
      const b = PlanBody.parse(req.body);
      const err = validateSlabs(b.slabs);
      if (err) throw badRequest(err);
      const now = new Date();
      const values = { ...Object.fromEntries(Object.entries(PLAN_COLS).map(([k, c]) => [c, (b as Record<string, unknown>)[k] ?? null])), features: JSON.stringify(b.features), slabs: JSON.stringify(b.slabs), created_at: now, updated_at: now };
      const r = await exec(ctx.db, 'INSERT INTO plans SET ?', [values]);
      await logEvent(ctx.db, { kind: 'plan_create', actor: actor(req), detail: { code: b.code } });
      return { id: r.insertId };
    });

    app.patch<{ Params: { id: string } }>('/plans/:id', { preHandler: owner }, async (req) => {
      const b = parsePatch(PlanBody, req.body);
      if (b.slabs) {
        const err = validateSlabs(b.slabs);
        if (err) throw badRequest(err);
      }
      const set: Record<string, unknown> = Object.fromEntries(Object.entries(b).filter(([k]) => PLAN_COLS[k]).map(([k, v]) => [PLAN_COLS[k], v]));
      if (b.features) set.features = JSON.stringify(b.features);
      if (b.slabs) set.slabs = JSON.stringify(b.slabs);
      const r = await exec(ctx.db, 'UPDATE plans SET ? WHERE id = ?', [{ ...set, updated_at: new Date() }, req.params.id]);
      if (!r.affectedRows) throw notFound('Plan not found');
      await logEvent(ctx.db, { kind: 'plan_update', actor: actor(req), detail: { planId: Number(req.params.id), fields: Object.keys(b) } });
      return { ok: true };
    });

    app.get<{ Params: { id: string }; Querystring: { users?: string; years?: string; resellerId?: string } }>('/plans/:id/quote', { preHandler: any }, async (req) => {
      const p = await one<Record<string, unknown>>(ctx.db, 'SELECT * FROM plans WHERE id = ?', [req.params.id]);
      if (!p) throw notFound('Plan not found');
      const resellerId = scopeOf(req) ?? (req.query.resellerId ? Number(req.query.resellerId) : null);
      const disc = resellerId ? Number((await one<{ d: number }>(ctx.db, 'SELECT discount_pct d FROM resellers WHERE id = ?', [resellerId]))?.d ?? 0) : 0;
      const users = Math.max(1, Math.min(100000, Number(req.query.users) || 1));
      const years = Math.max(1, Math.min(10, Number(req.query.years) || 1));
      return quote({ slabs: json<Slab[]>(p.slabs), amc_pct: Number(p.amc_pct), term_months: Number(p.term_months), min_users: Number(p.min_users) }, users, years, disc);
    });

    app.get('/resellers', { preHandler: vayrone }, async () => {
      const list = await rows<Record<string, unknown>>(ctx.db, 'SELECT * FROM resellers ORDER BY name');
      return Promise.all(
        list.map(async (r) => ({
          id: r.id,
          name: r.name,
          contactName: r.contact_name,
          email: r.email,
          phone: r.phone,
          city: r.city,
          gstin: r.gstin,
          discountPct: Number(r.discount_pct),
          quotaLicenses: r.quota_licenses,
          quotaUsers: r.quota_users,
          isEnabled: Boolean(r.is_enabled),
          notes: r.notes,
          used: await resellerUsage(ctx.db, Number(r.id)),
        })),
      );
    });

    app.post('/resellers', { preHandler: owner }, async (req) => {
      const b = ResellerBody.parse(req.body);
      const now = new Date();
      const r = await exec(ctx.db, 'INSERT INTO resellers SET ?', [{ ...Object.fromEntries(Object.entries(RES_COLS).map(([k, c]) => [c, (b as Record<string, unknown>)[k] ?? null])), created_at: now, updated_at: now }]);
      await logEvent(ctx.db, { kind: 'reseller_create', actor: actor(req), detail: { resellerId: r.insertId, name: b.name } });
      return { id: r.insertId };
    });

    app.patch<{ Params: { id: string } }>('/resellers/:id', { preHandler: owner }, async (req) => {
      const b = parsePatch(ResellerBody, req.body);
      const set = Object.fromEntries(Object.entries(b).filter(([k]) => RES_COLS[k]).map(([k, v]) => [RES_COLS[k], v ?? null]));
      const r = await exec(ctx.db, 'UPDATE resellers SET ? WHERE id = ?', [{ ...set, updated_at: new Date() }, req.params.id]);
      if (!r.affectedRows) throw notFound('Partner not found');
      await logEvent(ctx.db, { kind: 'reseller_update', actor: actor(req), detail: { resellerId: Number(req.params.id), fields: Object.keys(b) } });
      return { ok: true };
    });
  };
}
