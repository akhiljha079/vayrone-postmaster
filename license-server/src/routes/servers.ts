// "Client servers": the health of every activated PostMaster server on one screen,
// from the hourly health reports and daily heartbeats.
import type { FastifyInstance } from 'fastify';
import type { LsContext } from '../context.js';
import { json, rows } from '../db.js';
import { requireStaff, scopeOf } from '../auth.js';
import type { HealthReport } from '../services/licensing.js';

export type ServerState = 'problem' | 'silent' | 'warning' | 'no_data' | 'ok' | 'offline';
const ORDER: ServerState[] = ['problem', 'silent', 'warning', 'no_data', 'ok', 'offline'];
const HOUR = 3600_000;

/** Health reports arrive hourly; heartbeats (older versions) daily. */
export function serverState(o: { mode: string; lastSeenAt: Date | null; healthAt: Date | null; health: HealthReport | null }, now = Date.now()): ServerState {
  if (o.mode === 'offline') return 'offline';
  if (o.health && o.healthAt) return now - new Date(o.healthAt).getTime() > 3 * HOUR ? 'silent' : o.health.status;
  if (!o.lastSeenAt || now - new Date(o.lastSeenAt).getTime() > 26 * HOUR) return 'silent';
  return 'no_data';
}

export function serverRoutes(ctx: LsContext) {
  const any = requireStaff();
  return async (app: FastifyInstance) => {
    app.get('/servers', { preHandler: any }, async (req) => {
      const scope = scopeOf(req);
      const list = await rows<{
        id: number;
        licenseRowId: number;
        licenseId: string;
        company: string;
        city: string | null;
        phone: string | null;
        plan: string;
        hostname: string | null;
        version: string | null;
        mode: string;
        activeUsers: number | null;
        maxUsers: number;
        lastSeenAt: Date | null;
        healthAt: Date | null;
        health: unknown;
        reseller: string | null;
      }>(
        ctx.db,
        `SELECT a.id, l.id licenseRowId, l.license_id licenseId, c.company, c.city, c.phone, p.name plan, a.hostname, a.product_version version, a.mode,
                a.active_users activeUsers, l.max_users maxUsers, a.last_seen_at lastSeenAt, a.health_at healthAt, a.health, r.name reseller
           FROM activations a JOIN licenses l ON l.id = a.license_id JOIN clients c ON c.id = l.client_id JOIN plans p ON p.id = l.plan_id
           LEFT JOIN resellers r ON r.id = l.reseller_id
          WHERE a.status = 'active' AND l.status <> 'revoked'${scope ? ' AND l.reseller_id = ?' : ''}`,
        scope ? [scope] : [],
      );
      const now = Date.now();
      const items = list
        .map((r) => {
          const health = json<HealthReport>(r.health);
          return { ...r, health, state: serverState({ mode: r.mode, lastSeenAt: r.lastSeenAt, healthAt: r.healthAt, health }, now) };
        })
        .sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.company.localeCompare(b.company));
      const summary = Object.fromEntries(ORDER.map((s) => [s, items.filter((i) => i.state === s).length]));
      return { items, summary, checkedAt: new Date(now).toISOString() };
    });
  };
}
