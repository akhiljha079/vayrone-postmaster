// Licences: key generation, entitlements, renewals/AMC, suspension,
// activations and machine transfers, offline request processing.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { decodeRequest, generateLicenseKey, LicenseFormatError, normalizeLicenseKey, type Components } from '@vpm/license-client/format';
import { matchFingerprint } from '@vpm/license-client/fingerprint';
import type { LsContext } from '../context.js';
import { exec, json, one, rows, tx, type Q } from '../db.js';
import { requireStaff, scopeOf } from '../auth.js';
import { badRequest, forbidden, notFound, page, parsePatch } from '../http.js';
import { logEvent, type Actor, type LicenseRow } from '../services/licensing.js';
import { resellerUsage } from './catalog.js';

const DAY = 86_400_000;

const CreateBody = z.object({
  clientId: z.number().int().positive(),
  planId: z.number().int().positive(),
  maxUsers: z.number().int().min(1).max(100000),
  maxExternalAccounts: z.number().int().min(0).nullish(),
  features: z.array(z.string().regex(/^[a-z0-9_]{2,40}$/)).max(30).nullish(),
  startsAt: z.coerce.date().nullish(),
  termMonths: z.number().int().min(0).max(120).nullish(),
  amcMonths: z.number().int().min(0).max(120).nullish(),
  maxActivations: z.number().int().min(1).max(20).nullish(),
  heartbeatHours: z.number().int().min(1).max(168).nullish(),
  onlineCheckDays: z.number().int().min(3).max(365).nullish(),
  offlineCheckDays: z.number().int().min(7).max(730).nullish(),
  notes: z.string().max(5000).nullish(),
  amount: z.number().min(0).nullish(),
  invoiceRef: z.string().trim().max(100).nullish(),
});

const PatchBody = z.object({
  planId: z.number().int().positive(),
  maxUsers: z.number().int().min(1).max(100000),
  maxExternalAccounts: z.number().int().min(0).nullable(),
  features: z.array(z.string().regex(/^[a-z0-9_]{2,40}$/)).max(30),
  maxActivations: z.number().int().min(1).max(20),
  heartbeatHours: z.number().int().min(1).max(168),
  onlineCheckDays: z.number().int().min(3).max(365),
  offlineCheckDays: z.number().int().min(7).max(730),
  notes: z.string().max(5000).nullable(),
  /** Recorded as an "upgrade" sale when given. */
  amount: z.number().min(0),
  invoiceRef: z.string().trim().max(100),
});
const PATCH_COLS: Record<string, string> = {
  planId: 'plan_id',
  maxUsers: 'max_users',
  maxExternalAccounts: 'max_external_accounts',
  maxActivations: 'max_activations',
  heartbeatHours: 'heartbeat_hours',
  onlineCheckDays: 'online_check_days',
  offlineCheckDays: 'offline_check_days',
  notes: 'notes',
};
/** Fields a partner may change on their own licences. */
const RESELLER_PATCH = new Set(['maxUsers', 'notes', 'amount', 'invoiceRef']);

const RenewBody = z.object({
  kind: z.enum(['renewal', 'amc']),
  months: z.number().int().min(1).max(120),
  amount: z.number().min(0).default(0),
  invoiceRef: z.string().trim().max(100).nullish(),
  notes: z.string().trim().max(500).nullish(),
});

const addMonths = (d: Date, m: number) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x;
};

async function nextLicenseId(c: Q, prefix: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  await exec(c, 'INSERT INTO id_counters (name, value) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)', [`lic${year}`]);
  const r = await one<{ id: number }>(c, 'SELECT LAST_INSERT_ID() id');
  return `${prefix}-${year}-${String(r!.id).padStart(6, '0')}`;
}

const actorOf = (req: FastifyRequest): Actor => ({ userId: req.staff!.id, resellerId: scopeOf(req), ip: req.ip });

async function quotaCheck(q: Q, resellerId: number, addUsers: number, addLicenses: number, excludeLicenseId?: number): Promise<void> {
  const r = await one<{ quota_licenses: number | null; quota_users: number | null }>(q, 'SELECT quota_licenses, quota_users FROM resellers WHERE id = ?', [resellerId]);
  const used = await resellerUsage(q as LsContext['db'], resellerId, excludeLicenseId);
  if (r?.quota_licenses != null && used.licenses + addLicenses > r.quota_licenses) throw forbidden(`Your partner quota allows ${r.quota_licenses} licences (${used.licenses} in use). Contact Vayrone to raise it.`, 'QUOTA');
  if (r?.quota_users != null && used.users + addUsers > r.quota_users) throw forbidden(`Your partner quota allows ${r.quota_users} users in total (${used.users} in use). Contact Vayrone to raise it.`, 'QUOTA');
}

export const licenseListSql = `SELECT l.id, l.license_id licenseId, l.license_key licenseKey, l.status, l.max_users maxUsers, l.expires_at expiresAt, l.amc_expires_at amcExpiresAt,
    l.created_at createdAt, c.id clientId, c.company, c.city, p.name plan, p.code planCode, r.name reseller, l.reseller_id resellerId,
    (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id AND a.status = 'active') activations,
    (SELECT MAX(a.last_seen_at) FROM activations a WHERE a.license_id = l.id AND a.status = 'active') lastSeenAt,
    (SELECT a.active_users FROM activations a WHERE a.license_id = l.id AND a.status = 'active' ORDER BY a.last_seen_at DESC LIMIT 1) usedUsers
  FROM licenses l JOIN clients c ON c.id = l.client_id JOIN plans p ON p.id = l.plan_id LEFT JOIN resellers r ON r.id = l.reseller_id`;

export function licenseRoutes(ctx: LsContext) {
  const any = requireStaff();
  const vayrone = requireStaff('owner', 'staff');

  async function load(req: FastifyRequest, id: string | number, lock = false, q: Q = ctx.db): Promise<LicenseRow> {
    const scope = scopeOf(req);
    const l = await one<LicenseRow>(q, `SELECT * FROM licenses WHERE id = ?${scope ? ' AND reseller_id = ?' : ''}${lock ? ' FOR UPDATE' : ''}`, scope ? [id, scope] : [id]);
    if (!l) throw notFound('Licence not found');
    return l;
  }

  return async (app: FastifyInstance) => {
    app.get<{ Querystring: Record<string, string | undefined> }>('/licenses', { preHandler: any }, async (req) => {
      const q = req.query;
      const scope = scopeOf(req);
      const where: string[] = [];
      const p: unknown[] = [];
      if (scope) (where.push('l.reseller_id = ?'), p.push(scope));
      if (q.status) (where.push('l.status = ?'), p.push(q.status));
      if (q.planId) (where.push('l.plan_id = ?'), p.push(Number(q.planId)));
      if (q.resellerId && !scope) (where.push(q.resellerId === 'direct' ? 'l.reseller_id IS NULL' : 'l.reseller_id = ?'), q.resellerId !== 'direct' && p.push(Number(q.resellerId)));
      if (q.clientId) (where.push('l.client_id = ?'), p.push(Number(q.clientId)));
      if (q.expiring) (where.push("l.status = 'active' AND l.expires_at BETWEEN ? AND ?"), p.push(new Date(), new Date(Date.now() + Number(q.expiring) * DAY)));
      if (q.amcDue) (where.push("l.status = 'active' AND l.amc_expires_at BETWEEN ? AND ?"), p.push(new Date(Date.now() - 365 * DAY), new Date(Date.now() + Number(q.amcDue) * DAY)));
      if (q.q) {
        const key = normalizeLicenseKey(q.q);
        where.push('(l.license_id LIKE ? OR c.company LIKE ? OR l.license_key = ? OR c.email LIKE ? OR c.phone LIKE ?)');
        p.push(`%${q.q}%`, `%${q.q}%`, key ?? q.q, `%${q.q}%`, `%${q.q}%`);
      }
      const w = where.length ? ` WHERE ${where.join(' AND ')}` : '';
      const { limit, offset } = page(q);
      const items = await rows(ctx.db, `${licenseListSql}${w} ORDER BY l.id DESC LIMIT ? OFFSET ?`, [...p, limit, offset]);
      const total = (await one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM licenses l JOIN clients c ON c.id = l.client_id${w}`, p))!.n;
      return { items, total: Number(total) };
    });

    app.get<{ Params: { id: string } }>('/licenses/:id', { preHandler: any }, async (req) => {
      const l = await load(req, req.params.id);
      const [client, plan, reseller, activations, renewals, events, usage] = await Promise.all([
        one(ctx.db, 'SELECT id, company, contact_name contactName, email, phone, whatsapp, city, gstin FROM clients WHERE id = ?', [l.client_id]),
        one(ctx.db, 'SELECT id, code, name, term_months termMonths FROM plans WHERE id = ?', [l.plan_id]),
        l.reseller_id ? one(ctx.db, 'SELECT id, name, phone, email FROM resellers WHERE id = ?', [l.reseller_id]) : null,
        rows(
          ctx.db,
          `SELECT id, activation_id activationId, machine_id machineId, mode, status, activated_at activatedAt, last_seen_at lastSeenAt, last_ip lastIp,
             product_version version, hostname, site, active_users activeUsers, external_accounts externalAccounts, released_at releasedAt, release_reason releaseReason
             FROM activations WHERE license_id = ? ORDER BY status, id DESC`,
          [l.id],
        ),
        rows(ctx.db, 'SELECT id, kind, period_from periodFrom, period_to periodTo, users, amount, currency, invoice_ref invoiceRef, notes, created_at createdAt FROM renewals WHERE license_id = ? ORDER BY id DESC', [l.id]),
        rows(ctx.db, 'SELECT e.id, e.at, e.kind, e.ip, e.detail, u.name actor FROM events e LEFT JOIN staff_users u ON u.id = e.actor_user_id WHERE e.license_id = ? ORDER BY e.id DESC LIMIT 200', [l.id]),
        rows(ctx.db, 'SELECT day, active_users activeUsers, external_accounts externalAccounts, product_version version FROM usage_daily WHERE license_id = ? ORDER BY day DESC LIMIT 90', [l.id]),
      ]);
      return {
        id: l.id,
        licenseId: l.license_id,
        licenseKey: l.license_key,
        status: l.status,
        statusReason: l.status_reason,
        maxUsers: l.max_users,
        maxExternalAccounts: l.max_external_accounts,
        features: json<string[]>(l.features),
        startsAt: l.starts_at,
        expiresAt: l.expires_at,
        amcExpiresAt: l.amc_expires_at,
        maxActivations: l.max_activations,
        heartbeatHours: l.heartbeat_hours,
        onlineCheckDays: l.online_check_days,
        offlineCheckDays: l.offline_check_days,
        notes: (l as LicenseRow & { notes: string | null }).notes,
        client,
        plan,
        reseller,
        activations,
        renewals,
        events,
        usage,
      };
    });

    app.post('/licenses', { preHandler: any }, async (req) => {
      const b = CreateBody.parse(req.body);
      const scope = scopeOf(req);
      const actor = actorOf(req);
      return tx(ctx.db, async (c) => {
        const client = await one<{ id: number; reseller_id: number | null }>(c, 'SELECT id, reseller_id FROM clients WHERE id = ?', [b.clientId]);
        if (!client || (scope && client.reseller_id !== scope)) throw badRequest('Choose one of your clients');
        const plan = await one<{ id: number; is_active: number; features: unknown; max_external_accounts: number | null; term_months: number; min_users: number }>(c, 'SELECT * FROM plans WHERE id = ?', [b.planId]);
        if (!plan || (!plan.is_active && scope)) throw badRequest('Choose an active plan');
        if (b.maxUsers < plan.min_users) throw badRequest(`This plan starts at ${plan.min_users} users`);
        const resellerId = scope ?? client.reseller_id;
        if (scope) {
          if (b.maxActivations || b.features || b.heartbeatHours || b.onlineCheckDays || b.offlineCheckDays || b.maxExternalAccounts !== undefined) throw forbidden('Partners use the plan defaults; ask Vayrone for custom terms');
          await c.query('SELECT id FROM resellers WHERE id = ? FOR UPDATE', [scope]);
          await quotaCheck(c, scope, b.maxUsers, 1);
        }
        const starts = b.startsAt ?? new Date();
        const term = b.termMonths ?? plan.term_months;
        const expires = term === 0 ? null : addMonths(starts, term);
        const amc = addMonths(starts, b.amcMonths ?? (term === 0 ? 12 : term));
        const key = generateLicenseKey();
        const licenseId = await nextLicenseId(c, ctx.config.licenseIdPrefix);
        const now = new Date();
        const r = await exec(c, 'INSERT INTO licenses SET ?', [
          {
            license_id: licenseId,
            license_key: key,
            client_id: client.id,
            reseller_id: resellerId,
            plan_id: plan.id,
            max_users: b.maxUsers,
            max_external_accounts: b.maxExternalAccounts !== undefined ? b.maxExternalAccounts : plan.max_external_accounts,
            features: JSON.stringify(b.features ?? json<string[]>(plan.features)),
            status: 'active',
            starts_at: starts,
            expires_at: expires,
            amc_expires_at: amc,
            max_activations: b.maxActivations ?? 1,
            heartbeat_hours: b.heartbeatHours ?? 24,
            online_check_days: b.onlineCheckDays ?? 30,
            offline_check_days: b.offlineCheckDays ?? 90,
            notes: b.notes ?? null,
            created_by: actor.userId,
            created_at: now,
            updated_at: now,
          },
        ]);
        await exec(c, 'INSERT INTO renewals (license_id, kind, period_from, period_to, users, amount, invoice_ref, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)', [
          r.insertId,
          'new',
          starts,
          expires ?? amc,
          b.maxUsers,
          b.amount ?? 0,
          b.invoiceRef ?? null,
          actor.userId,
          now,
        ]);
        await logEvent(c, { kind: 'license_create', licenseId: r.insertId, actor, detail: { licenseId, planId: plan.id, maxUsers: b.maxUsers, expiresAt: expires } });
        return { id: r.insertId, licenseId, licenseKey: key };
      });
    });

    app.patch<{ Params: { id: string } }>('/licenses/:id', { preHandler: any }, async (req) => {
      const b = parsePatch(PatchBody, req.body);
      const scope = scopeOf(req);
      if (scope && Object.keys(b).some((k) => !RESELLER_PATCH.has(k))) throw forbidden('Partners can change the user count and notes; ask Vayrone for other changes');
      const actor = actorOf(req);
      await tx(ctx.db, async (c) => {
        const l = await load(req, req.params.id, true, c);
        if (scope && b.maxUsers !== undefined) {
          await c.query('SELECT id FROM resellers WHERE id = ? FOR UPDATE', [scope]);
          await quotaCheck(c, scope, b.maxUsers, 1, l.id);
        }
        const set: Record<string, unknown> = Object.fromEntries(Object.entries(b).filter(([k]) => PATCH_COLS[k]).map(([k, v]) => [PATCH_COLS[k], v]));
        if (b.features) set.features = JSON.stringify(b.features);
        await exec(c, 'UPDATE licenses SET ? WHERE id = ?', [{ ...set, updated_at: new Date() }, l.id]);
        if (b.amount !== undefined || b.invoiceRef) {
          await exec(c, "INSERT INTO renewals (license_id, kind, users, amount, invoice_ref, created_by, created_at) VALUES (?, 'upgrade', ?, ?, ?, ?, ?)", [
            l.id,
            b.maxUsers ?? l.max_users,
            b.amount ?? 0,
            b.invoiceRef ?? null,
            actor.userId,
            new Date(),
          ]);
        }
        await logEvent(c, { kind: 'license_update', licenseId: l.id, actor, detail: { ...b, from: { maxUsers: l.max_users, planId: l.plan_id } } });
      });
      return { ok: true };
    });

    app.post<{ Params: { id: string } }>('/licenses/:id/renew', { preHandler: any }, async (req) => {
      const b = RenewBody.parse(req.body);
      const actor = actorOf(req);
      return tx(ctx.db, async (c) => {
        const l = await load(req, req.params.id, true, c);
        if (l.status === 'revoked') throw badRequest('A revoked licence cannot be renewed');
        const now = new Date();
        const col = b.kind === 'renewal' ? 'expires_at' : 'amc_expires_at';
        const cur = b.kind === 'renewal' ? l.expires_at : l.amc_expires_at;
        if (b.kind === 'renewal' && !cur) throw badRequest('This licence is perpetual; renew the AMC instead');
        // Renewing early extends from the current end date; late renewals start today.
        const from = cur && new Date(cur) > now ? new Date(cur) : now;
        const to = addMonths(from, b.months);
        const set: Record<string, Date> = { [col]: to };
        const plan = (await one<{ term_months: number }>(c, 'SELECT term_months FROM plans WHERE id = ?', [l.plan_id]))!;
        // Subscriptions include AMC for the same period.
        if (b.kind === 'renewal' && plan.term_months > 0 && (!l.amc_expires_at || new Date(l.amc_expires_at) < to)) set.amc_expires_at = to;
        await exec(c, 'UPDATE licenses SET ? WHERE id = ?', [{ ...set, updated_at: now }, l.id]);
        await exec(c, 'INSERT INTO renewals (license_id, kind, period_from, period_to, users, amount, invoice_ref, notes, created_by, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)', [
          l.id,
          b.kind,
          from,
          to,
          l.max_users,
          b.amount,
          b.invoiceRef ?? null,
          b.notes ?? null,
          actor.userId,
          now,
        ]);
        await logEvent(c, { kind: b.kind === 'renewal' ? 'renew' : 'amc_renew', licenseId: l.id, actor, detail: { from, to, months: b.months, amount: b.amount } });
        return { ok: true, [b.kind === 'renewal' ? 'expiresAt' : 'amcExpiresAt']: to };
      });
    });

    app.post<{ Params: { id: string } }>('/licenses/:id/status', { preHandler: vayrone }, async (req) => {
      const b = z.object({ status: z.enum(['active', 'suspended', 'revoked']), reason: z.string().trim().max(500).nullish() }).parse(req.body);
      const l = await load(req, req.params.id);
      if (l.status === 'revoked' && b.status !== 'revoked' && req.staff!.role !== 'owner') throw forbidden('Only the owner can restore a revoked licence');
      if (b.status !== 'active' && !b.reason) throw badRequest('Give a reason; the client sees it on the licence page');
      await exec(ctx.db, 'UPDATE licenses SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?', [b.status, b.status === 'active' ? null : b.reason, new Date(), l.id]);
      await logEvent(ctx.db, { kind: `status_${b.status}`, licenseId: l.id, actor: actorOf(req), detail: { from: l.status, reason: b.reason ?? null } });
      return { ok: true };
    });

    // Machine transfer: release the activation; the slot is free for the new server.
    app.post<{ Params: { id: string } }>('/activations/:id/release', { preHandler: any }, async (req) => {
      const { reason } = z.object({ reason: z.string().trim().min(3).max(200) }).parse(req.body);
      const a = await one<{ id: number; license_id: number }>(ctx.db, "SELECT id, license_id FROM activations WHERE id = ? AND status = 'active'", [req.params.id]);
      if (!a) throw notFound('Activation not found');
      await load(req, a.license_id); // scope check
      await ctx.licensing.release(a.id, actorOf(req), reason);
      return { ok: true };
    });

    // ------------------------------------------------------------ offline files
    app.post('/offline/inspect', { preHandler: any }, async (req) => {
      const { request } = z.object({ request: z.string().min(50).max(100_000) }).parse(req.body);
      let r;
      try {
        r = decodeRequest(request);
      } catch (e) {
        throw badRequest(e instanceof LicenseFormatError ? e.message : 'The request file is damaged');
      }
      const scope = scopeOf(req);
      const key = r.key ? normalizeLicenseKey(r.key) : null;
      const l = await one<LicenseRow & { company: string }>(
        ctx.db,
        `SELECT l.*, c.company FROM licenses l JOIN clients c ON c.id = l.client_id WHERE ${key ? 'l.license_key = ?' : 'l.license_id = ?'}${scope ? ' AND l.reseller_id = ?' : ''}`,
        scope ? [key ?? r.licenseId, scope] : [key ?? r.licenseId],
      );
      const acts = l ? await rows<{ id: number; activation_id: string; machine_id: string; hostname: string | null; components: unknown }>(ctx.db, "SELECT * FROM activations WHERE license_id = ? AND status = 'active'", [l.id]) : [];
      const same = acts.find((a) => matchFingerprint(json<Components>(a.components), r.machine.components).ok);
      return {
        request: { kind: r.key ? 'activation' : 'revalidation', machineId: r.machine.id, hostname: r.product.hostname, version: r.product.version, activeUsers: r.usage.activeUsers, createdAt: r.createdAt },
        license: l ? { id: l.id, licenseId: l.license_id, company: l.company, status: l.status, maxUsers: l.max_users, expiresAt: l.expires_at, maxActivations: l.max_activations } : null,
        activeOn: acts.map((a) => ({ id: a.id, machineId: a.machine_id, hostname: a.hostname })),
        sameMachine: Boolean(same),
        overLimit: l ? r.usage.activeUsers > l.max_users : false,
      };
    });

    app.post('/offline/issue', { preHandler: any }, async (req) => {
      const { request } = z.object({ request: z.string().min(50).max(100_000) }).parse(req.body);
      return ctx.licensing.processOffline(request, actorOf(req), { resellerId: scopeOf(req) });
    });
  };
}
