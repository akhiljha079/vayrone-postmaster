// Dashboard, sessions, security policy, IP allowlist, audit log, alerts, login history, company profile.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db as dbm, licensedUserCount, parseCidr, type CoreContext } from '@vpm/core';
import type { Sessions } from '../../sessions.js';
import { audit, licenseBanner, requireAdmin } from '../../guards.js';
import { saveLogo } from '../../branding.js';
import { badRequest, notFound, page, parsePatch } from '../../http.js';

const { exec, one, rows } = dbm;
const Id = z.coerce.number().int().positive();

export function systemRoutes(ctx: CoreContext, sessions: Sessions) {
  const read = requireAdmin(ctx, 'read', { auditorAllowed: true });
  const adminRead = requireAdmin(ctx, 'read');
  const write = requireAdmin(ctx, 'write');
  const superOnly = requireAdmin(ctx, 'super');

  return async (app: FastifyInstance) => {
    app.get('/dashboard', { preHandler: read }, async (req) => {
      const [users, domains, queue, alerts, storage, recent] = await Promise.all([
        one<{ total: number; enabled: number }>(ctx.db, "SELECT COUNT(*) total, COALESCE(SUM(is_enabled), 0) enabled FROM users WHERE role <> 'vayrone_support'"),
        one<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM domains'),
        rows<{ status: string; n: number }>(ctx.db, 'SELECT status, COUNT(*) n FROM outbound_queue GROUP BY status'),
        rows(ctx.db, 'SELECT id, severity, code, message, last_at AS lastAt, occurrences FROM admin_alerts WHERE resolved_at IS NULL AND acknowledged_at IS NULL ORDER BY last_at DESC LIMIT 20'),
        one<{ used: number; files: number }>(ctx.db, 'SELECT COALESCE(SUM(size_stored),0) used, COUNT(*) files FROM messages'),
        rows(ctx.db, "SELECT at, login, protocol, ip, success, reason FROM login_attempts ORDER BY id DESC LIMIT 10"),
      ]);
      return {
        users: { total: Number(users?.total ?? 0), enabled: Number(users?.enabled ?? 0), licensed: await licensedUserCount(ctx.db), maxLicensed: ctx.license.maxUsers() },
        domains: Number(domains?.n ?? 0),
        queue: Object.fromEntries(queue.map((q) => [q.status, Number(q.n)])),
        alerts,
        storage: { bytes: Number(storage?.used ?? 0), messages: Number(storage?.files ?? 0) },
        recentLogins: recent,
        license: licenseBanner(ctx, req.auth!.user.role),
      };
    });

    // ------------------------------------------------------------ sessions
    app.get('/sessions', { preHandler: adminRead }, async () => sessions.listActive());

    app.delete<{ Params: { handle: string } }>('/sessions/:handle', { preHandler: write }, async (req) => {
      const s = await sessions.findByHandle(req.params.handle);
      if (!s) throw notFound('Session not found');
      await sessions.revoke(s.id, req.auth!.user.id);
      await audit(ctx, req, 'session.revoke', 'session', req.params.handle, { userId: s.user_id });
      return { ok: true };
    });

    // ------------------------------------------------------------ security policy
    const Policy = z.object({
      lockoutThreshold: z.number().int().min(3).max(100),
      lockoutMinutes: z.number().int().min(1).max(1440),
      sessionIdleMinutes: z.number().int().min(5).max(7 * 1440),
      sessionMaxHours: z.number().int().min(1).max(24 * 30),
      supportAccessEnabled: z.boolean(),
      requireTotpForAdmins: z.boolean(),
    });

    app.get('/security/policy', { preHandler: adminRead }, async () => ({ ...(await ctx.settings.security()), supportLicensed: ctx.license.feature('support_access') }));

    app.put('/security/policy', { preHandler: superOnly }, async (req) => {
      const b = parsePatch(Policy, req.body);
      const next = { ...(await ctx.settings.security()), ...b };
      if (next.requireTotpForAdmins && !req.auth!.user.totp_enabled) {
        throw badRequest('Enable two-factor authentication on your own account before making it mandatory for admins');
      }
      await ctx.settings.set('security', 'policy', next, req.auth!.user.id);
      await audit(ctx, req, 'security.policy_update', 'settings', 'security.policy', b);
      return next;
    });

    // ------------------------------------------------------------ IP allowlist
    const Scopes = z.array(z.enum(['web', 'admin', 'imap', 'pop3', 'smtp'])).min(1);

    app.get('/security/ip-allowlist', { preHandler: adminRead }, async (req) => ({
      rules: (await rows(ctx.db, 'SELECT id, cidr, applies_to AS appliesTo, description, created_at AS createdAt FROM ip_allowlist ORDER BY id')).map((r) => ({
        ...r,
        appliesTo: String(r.appliesTo).split(','),
      })),
      yourIp: req.ip,
    }));

    app.post('/security/ip-allowlist', { preHandler: superOnly }, async (req) => {
      const b = z.object({ cidr: z.string().trim().min(2).max(49), appliesTo: Scopes, description: z.string().max(200).optional(), force: z.boolean().optional() }).parse(req.body);
      try {
        parseCidr(b.cidr);
      } catch {
        throw badRequest('Enter an IP address or CIDR range such as 192.168.1.0/24');
      }
      const r = await exec(ctx.db, 'INSERT INTO ip_allowlist (cidr, applies_to, description, created_at) VALUES (?,?,?,?)', [
        b.cidr,
        b.appliesTo.join(','),
        b.description ?? null,
        new Date(),
      ]);
      ctx.ipPolicy.invalidate();
      // Refuse rules that would lock the acting admin out, unless forced.
      if (b.appliesTo.includes('admin') && !b.force && !(await ctx.ipPolicy.allowed(req.ip, 'admin'))) {
        await exec(ctx.db, 'DELETE FROM ip_allowlist WHERE id = ?', [r.insertId]);
        ctx.ipPolicy.invalidate();
        throw badRequest(`This rule would block your own address (${req.ip}) from the admin panel. Add your network first, or confirm with force.`, 'SELF_LOCKOUT');
      }
      await audit(ctx, req, 'security.ip_allow_add', 'ip_allowlist', r.insertId, b);
      return { id: r.insertId };
    });

    app.delete<{ Params: { id: string } }>('/security/ip-allowlist/:id', { preHandler: superOnly }, async (req) => {
      const id = Id.parse(req.params.id);
      const r = await exec(ctx.db, 'DELETE FROM ip_allowlist WHERE id = ?', [id]);
      if (!r.affectedRows) throw notFound('Rule not found');
      ctx.ipPolicy.invalidate();
      await audit(ctx, req, 'security.ip_allow_remove', 'ip_allowlist', id);
      return { ok: true };
    });

    // ------------------------------------------------------------ audit / logs
    app.get<{ Querystring: Record<string, string> }>('/audit', { preHandler: read }, async (req) => {
      const { limit, offset, page: p } = page(req.query);
      const where: string[] = [];
      const vals: unknown[] = [];
      if (req.query.action) {
        where.push('action LIKE ?');
        vals.push(`${req.query.action}%`);
      }
      if (req.query.actor) {
        where.push('actor_login LIKE ?');
        vals.push(`%${req.query.actor}%`);
      }
      if (req.query.support === '1') where.push('is_support = 1');
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const items = await rows(
        ctx.db,
        `SELECT id, at, actor_login AS actor, actor_role AS role, is_support AS isSupport, ip, action, target_type AS targetType,
                target_id AS targetId, details FROM audit_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...vals, limit, offset],
      );
      const total = await one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM audit_log ${w}`, vals);
      return { items: items.map((i) => ({ ...i, details: dbm.json(i.details) })), total: Number(total?.n ?? 0), page: p };
    });

    app.get('/audit/verify', { preHandler: read }, async () => ctx.audit.verify());

    app.get<{ Querystring: Record<string, string> }>('/login-attempts', { preHandler: read }, async (req) => {
      const { limit, offset } = page(req.query);
      const failed = req.query.failed === '1' ? 'WHERE success = 0' : '';
      return rows(ctx.db, `SELECT at, login, protocol, ip, success, reason FROM login_attempts ${failed} ORDER BY id DESC LIMIT ? OFFSET ?`, [limit, offset]);
    });

    app.get<{ Querystring: Record<string, string> }>('/mail-log', { preHandler: read }, async (req) => {
      const { limit, offset } = page(req.query);
      const vals: unknown[] = [];
      let w = '';
      if (req.query.q) {
        w = 'WHERE envelope_from LIKE ? OR rcpt LIKE ? OR subject LIKE ? OR hdr_message_id LIKE ?';
        vals.push(...Array(4).fill(`%${req.query.q}%`));
      }
      return rows(
        ctx.db,
        `SELECT at, event, direction, envelope_from AS envelopeFrom, rcpt, subject, size, client_ip AS clientIp, detail FROM mail_log ${w} ORDER BY id DESC LIMIT ? OFFSET ?`,
        [...vals, limit, offset],
      );
    });

    // ------------------------------------------------------------ alerts
    app.get('/alerts', { preHandler: read }, async () =>
      rows(
        ctx.db,
        `SELECT id, severity, code, message, first_at AS firstAt, last_at AS lastAt, occurrences, acknowledged_at AS acknowledgedAt, resolved_at AS resolvedAt
           FROM admin_alerts ORDER BY resolved_at IS NULL DESC, last_at DESC LIMIT 200`,
      ),
    );

    app.post<{ Params: { id: string } }>('/alerts/:id/ack', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      await exec(ctx.db, 'UPDATE admin_alerts SET acknowledged_by = ?, acknowledged_at = ? WHERE id = ?', [req.auth!.user.id, new Date(), id]);
      await audit(ctx, req, 'alert.ack', 'alert', id);
      return { ok: true };
    });

    // ------------------------------------------------------------ company profile (also set by the setup wizard)

    app.get('/company', { preHandler: adminRead }, async () => (await one(ctx.db, 'SELECT company_name AS companyName, address, gstin, contact_person AS contactPerson, phone, email, logo_path AS logoPath FROM company_profile WHERE id = 1')) ?? null);

    app.put('/company', { preHandler: superOnly }, async (req) => {
      const b = CompanySchema.parse(req.body);
      await upsertCompany(ctx, b);
      await audit(ctx, req, 'company.update', 'company', 1, b);
      return { ok: true };
    });

    app.put('/company/logo', { preHandler: superOnly, bodyLimit: 1024 * 1024 }, async (req) => {
      const { logo } = z.object({ logo: z.string().max(800_000).nullable() }).parse(req.body);
      if (!(await one(ctx.db, 'SELECT id FROM company_profile WHERE id = 1'))) throw badRequest('Save the company details first');
      const path = await saveLogo(ctx, logo);
      await audit(ctx, req, logo ? 'company.logo_set' : 'company.logo_remove', 'company', 1);
      return { ok: true, logoUrl: path ? '/api/public/logo' : null };
    });

  };
}

export const CompanySchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  address: z.string().max(2000).nullable().optional(),
  gstin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[0-9]{2}[A-Z0-9]{10}[0-9A-Z]{3}$/, 'GSTIN must be 15 characters')
    .nullable()
    .optional()
    .or(z.literal('')),
  contactPerson: z.string().max(120).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  email: z.string().max(254).nullable().optional(),
});

export async function upsertCompany(ctx: CoreContext, b: z.infer<typeof CompanySchema>): Promise<void> {
  await exec(
    ctx.db,
    `INSERT INTO company_profile (id, company_name, address, gstin, contact_person, phone, email, updated_at) VALUES (1,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE company_name = VALUES(company_name), address = VALUES(address), gstin = VALUES(gstin),
       contact_person = VALUES(contact_person), phone = VALUES(phone), email = VALUES(email), updated_at = VALUES(updated_at)`,
    [b.companyName, b.address ?? null, b.gstin || null, b.contactPerson ?? null, b.phone ?? null, b.email ?? null, new Date()],
  );
}
