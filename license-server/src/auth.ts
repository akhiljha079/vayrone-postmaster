// Staff sessions for the License Server admin UI. Roles:
//   owner    — everything: plans, resellers, settings, staff accounts
//   staff    — Vayrone sales/support: clients, licences, activations, renewals, offline files, reports
//   reseller — partner login, scoped to their own clients and licences, within quota
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import { exec, one, type Db } from './db.js';
import { sha256 } from './crypto.js';
import { HttpError } from './http.js';

export const SID = 'vls_sid';
export const CSRF = 'vls_csrf';
export const CSRF_HEADER = 'x-vls-csrf';
const IDLE_MS = 2 * 3600_000;
const MAX_MS = 12 * 3600_000;

export type StaffRole = 'owner' | 'staff' | 'reseller';

export interface Staff {
  id: number;
  email: string;
  name: string;
  role: StaffRole;
  resellerId: number | null;
  sessionId: number;
}

declare module 'fastify' {
  interface FastifyRequest {
    staff: Staff | null;
  }
}

export function cookieOpts(secure: boolean, httpOnly: boolean) {
  return { path: '/', httpOnly, secure, sameSite: 'strict' as const };
}

export async function createSession(db: Db, reply: FastifyReply, userId: number, ip: string, secure: boolean): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const now = new Date();
  await exec(db, 'INSERT INTO sessions (token_hash, user_id, ip, created_at, last_seen_at, expires_at) VALUES (?,?,?,?,?,?)', [sha256(token), userId, ip, now, now, new Date(now.getTime() + MAX_MS)]);
  void reply.setCookie(SID, token, cookieOpts(secure, true));
  const csrf = randomBytes(24).toString('base64url');
  void reply.setCookie(CSRF, csrf, cookieOpts(secure, false));
  return csrf;
}

export function registerAuth(app: FastifyInstance, db: Db): void {
  app.decorateRequest('staff', null);
  app.addHook('onRequest', async (req) => {
    req.staff = null;
    const token = req.cookies[SID];
    if (!token) return;
    const s = await one<{ sid: number; last_seen_at: Date; expires_at: Date; id: number; email: string; name: string; role: StaffRole; reseller_id: number | null; is_enabled: number; r_enabled: number | null }>(
      db,
      `SELECT s.id sid, s.last_seen_at, s.expires_at, u.id, u.email, u.name, u.role, u.reseller_id, u.is_enabled, r.is_enabled r_enabled
         FROM sessions s JOIN staff_users u ON u.id = s.user_id LEFT JOIN resellers r ON r.id = u.reseller_id WHERE s.token_hash = ?`,
      [sha256(token)],
    );
    const now = Date.now();
    if (!s || !s.is_enabled || (s.role === 'reseller' && !s.r_enabled) || new Date(s.expires_at).getTime() < now || now - new Date(s.last_seen_at).getTime() > IDLE_MS) return;
    if (now - new Date(s.last_seen_at).getTime() > 60_000) await exec(db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', [new Date(), s.sid]);
    req.staff = { id: s.id, email: s.email, name: s.name, role: s.role, resellerId: s.reseller_id, sessionId: s.sid };
  });
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/v1/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!req.cookies[SID] || req.url === '/api/auth/login') return;
    const c = req.cookies[CSRF];
    const h = req.headers[CSRF_HEADER];
    if (!c || typeof h !== 'string' || c.length !== h.length || !timingSafeEqual(Buffer.from(c), Buffer.from(h))) throw new HttpError(403, 'CSRF', 'Missing or invalid CSRF token; reload the page');
  });
}

export function requireStaff(...roles: StaffRole[]): preHandlerAsyncHookHandler {
  return async (req: FastifyRequest) => {
    if (!req.staff) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in');
    if (roles.length && !roles.includes(req.staff.role)) throw new HttpError(403, 'FORBIDDEN', 'Your role does not allow this action');
  };
}

/** Reseller id the request is limited to (null = all data). */
export function scopeOf(req: FastifyRequest): number | null {
  return req.staff?.role === 'reseller' ? req.staff.resellerId : null;
}
