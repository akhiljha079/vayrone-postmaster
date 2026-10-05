// Dashboard and usage reports. Partners see their own licences only.
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { LsContext } from '../context.js';
import { rows, one } from '../db.js';
import { requireStaff, scopeOf } from '../auth.js';
import { licenseListSql } from './licenses.js';

const DAY = 86_400_000;

function csv(v: unknown): string {
  const s = v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v);
  return /[",\n]/.test(s) || /^[=+\-@]/.test(s) ? `"${s.replace(/^([=+\-@])/, "'$1").replace(/"/g, '""')}"` : s;
}

export function reportRoutes(ctx: LsContext) {
  const any = requireStaff();
  return async (app: FastifyInstance) => {
    app.get('/reports/summary', { preHandler: any }, async (req) => {
      const scope = scopeOf(req);
      const w = scope ? ' AND l.reseller_id = ?' : '';
      const p = scope ? [scope] : [];
      const now = new Date();
      const in30 = new Date(now.getTime() + 30 * DAY);
      const [byStatus, seats, expiring, amcDue, stale, nearLimit, clones, byPlan, revenue, byReseller, versions] = await Promise.all([
        rows<{ status: string; n: number }>(ctx.db, `SELECT l.status, COUNT(*) n FROM licenses l WHERE 1=1${w} GROUP BY l.status`, p),
        one<{ sold: number; used: number; installs: number }>(
          ctx.db,
          `SELECT COALESCE(SUM(l.max_users),0) sold,
             COALESCE(SUM((SELECT a.active_users FROM activations a WHERE a.license_id = l.id AND a.status = 'active' ORDER BY a.last_seen_at DESC LIMIT 1)),0) used,
             (SELECT COUNT(*) FROM activations a JOIN licenses l2 ON l2.id = a.license_id WHERE a.status = 'active' AND a.last_seen_at > ?${scope ? ' AND l2.reseller_id = ?' : ''}) installs
           FROM licenses l WHERE l.status = 'active'${w}`,
          [new Date(now.getTime() - 3 * DAY), ...p, ...p],
        ),
        rows(ctx.db, `${licenseListSql} WHERE l.status = 'active' AND l.expires_at BETWEEN ? AND ?${w} ORDER BY l.expires_at LIMIT 100`, [new Date(now.getTime() - 15 * DAY), new Date(now.getTime() + 60 * DAY), ...p]),
        rows(ctx.db, `${licenseListSql} WHERE l.status = 'active' AND l.amc_expires_at BETWEEN ? AND ?${w} ORDER BY l.amc_expires_at LIMIT 100`, [new Date(now.getTime() - 30 * DAY), in30, ...p]),
        rows(
          ctx.db,
          `SELECT l.id, l.license_id licenseId, c.company, a.hostname, a.last_seen_at lastSeenAt FROM activations a JOIN licenses l ON l.id = a.license_id JOIN clients c ON c.id = l.client_id
            WHERE a.status = 'active' AND a.mode = 'online' AND l.status = 'active' AND a.last_seen_at < ?${w} ORDER BY a.last_seen_at LIMIT 100`,
          [new Date(now.getTime() - 7 * DAY), ...p],
        ),
        rows(
          ctx.db,
          `SELECT l.id, l.license_id licenseId, c.company, l.max_users maxUsers, a.active_users activeUsers FROM activations a JOIN licenses l ON l.id = a.license_id JOIN clients c ON c.id = l.client_id
            WHERE a.status = 'active' AND l.status = 'active' AND a.active_users >= l.max_users * 0.9${w} ORDER BY a.active_users / l.max_users DESC LIMIT 100`,
          p,
        ),
        rows(
          ctx.db,
          `SELECT e.at, e.detail, l.id, l.license_id licenseId, c.company FROM events e JOIN licenses l ON l.id = e.license_id JOIN clients c ON c.id = l.client_id
            WHERE e.kind = 'clone_suspected' AND e.at > ?${w} ORDER BY e.id DESC LIMIT 50`,
          [new Date(now.getTime() - 30 * DAY), ...p],
        ),
        rows(ctx.db, `SELECT p.name plan, COUNT(*) licenses, SUM(l.max_users) users FROM licenses l JOIN plans p ON p.id = l.plan_id WHERE l.status = 'active'${w} GROUP BY p.name ORDER BY users DESC`, p),
        scope
          ? Promise.resolve([])
          : rows(ctx.db, "SELECT DATE_FORMAT(created_at, '%Y-%m') month, kind, SUM(amount) amount, COUNT(*) n FROM renewals WHERE created_at > ? GROUP BY month, kind ORDER BY month", [new Date(now.getTime() - 366 * DAY)]),
        scope
          ? Promise.resolve([])
          : rows(ctx.db, "SELECT COALESCE(r.name, 'Direct (Vayrone)') reseller, COUNT(*) licenses, SUM(l.max_users) users FROM licenses l LEFT JOIN resellers r ON r.id = l.reseller_id WHERE l.status = 'active' GROUP BY reseller ORDER BY users DESC"),
        rows(ctx.db, `SELECT a.product_version version, COUNT(*) n FROM activations a JOIN licenses l ON l.id = a.license_id WHERE a.status = 'active'${w} GROUP BY a.product_version ORDER BY n DESC`, p),
      ]);
      return {
        licenses: Object.fromEntries(byStatus.map((s) => [s.status, Number(s.n)])),
        seats: { sold: Number(seats?.sold ?? 0), used: Number(seats?.used ?? 0), installsSeen3d: Number(seats?.installs ?? 0) },
        expiring,
        amcDue,
        stale,
        nearLimit,
        clones,
        byPlan,
        revenue,
        byReseller,
        versions,
      };
    });

    app.get('/reports/licenses.csv', { preHandler: any }, async (req, reply: FastifyReply) => {
      const scope = scopeOf(req);
      const list = await rows<Record<string, unknown>>(ctx.db, `${licenseListSql}${scope ? ' WHERE l.reseller_id = ?' : ''} ORDER BY l.id`, scope ? [scope] : []);
      const cols = ['licenseId', 'company', 'city', 'plan', 'maxUsers', 'usedUsers', 'status', 'expiresAt', 'amcExpiresAt', 'reseller', 'activations', 'lastSeenAt', 'createdAt'];
      const body = [cols.join(','), ...list.map((r) => cols.map((c) => csv(r[c])).join(','))].join('\r\n');
      return reply
        .type('text/csv; charset=utf-8')
        .header('content-disposition', `attachment; filename="licences-${new Date().toISOString().slice(0, 10)}.csv"`)
        .send(`﻿${body}\r\n`);
    });

    app.get<{ Querystring: { kind?: string; page?: string } }>('/events', { preHandler: requireStaff('owner', 'staff') }, async (req) => {
      const p = Math.max(1, Number(req.query.page) || 1);
      return rows(
        ctx.db,
        `SELECT e.id, e.at, e.kind, e.ip, e.detail, u.name actor, l.license_id licenseId FROM events e LEFT JOIN staff_users u ON u.id = e.actor_user_id LEFT JOIN licenses l ON l.id = e.license_id
          ${req.query.kind ? 'WHERE e.kind = ?' : ''} ORDER BY e.id DESC LIMIT 100 OFFSET ?`,
        req.query.kind ? [req.query.kind, (p - 1) * 100] : [(p - 1) * 100],
      );
    });
  };
}
