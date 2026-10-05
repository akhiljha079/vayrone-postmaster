import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LsContext } from '../context.js';
import { exec, one } from '../db.js';
import { hashPassword, verifyPassword } from '../crypto.js';
import { CSRF, SID, createSession, requireStaff } from '../auth.js';
import { badRequest, HttpError } from '../http.js';
import { logEvent } from '../services/licensing.js';

const LOCK_AFTER = 5;
const LOCK_MS = 15 * 60_000;

export function authRoutes(ctx: LsContext) {
  const secure = !ctx.config.insecureCookies;
  return async (app: FastifyInstance) => {
    app.post('/login', { config: { rateLimit: { max: 20, timeWindow: '15 minutes' } } }, async (req, reply) => {
      const b = z.object({ email: z.string().trim().toLowerCase().max(254), password: z.string().max(200) }).parse(req.body);
      const u = await one<{ id: number; password_hash: string; is_enabled: number; failed_logins: number; locked_until: Date | null; role: string; reseller_id: number | null }>(
        ctx.db,
        'SELECT * FROM staff_users WHERE email = ?',
        [b.email],
      );
      const fail = () => new HttpError(401, 'BAD_LOGIN', 'Wrong email or password');
      if (!u || !u.is_enabled) {
        await hashPassword(b.password); // same timing as a real check
        throw fail();
      }
      if (u.locked_until && new Date(u.locked_until) > new Date()) throw new HttpError(429, 'LOCKED', 'Too many failed attempts; try again in 15 minutes');
      if (!(await verifyPassword(b.password, u.password_hash))) {
        const n = u.failed_logins + 1;
        await exec(ctx.db, 'UPDATE staff_users SET failed_logins = ?, locked_until = ? WHERE id = ?', [n >= LOCK_AFTER ? 0 : n, n >= LOCK_AFTER ? new Date(Date.now() + LOCK_MS) : null, u.id]);
        await logEvent(ctx.db, { kind: 'login_failed', actor: { userId: u.id, resellerId: null, ip: req.ip } });
        throw fail();
      }
      if (u.role === 'reseller') {
        const r = await one<{ is_enabled: number }>(ctx.db, 'SELECT is_enabled FROM resellers WHERE id = ?', [u.reseller_id]);
        if (!r?.is_enabled) throw new HttpError(403, 'RESELLER_DISABLED', 'This partner account is disabled');
      }
      await exec(ctx.db, 'UPDATE staff_users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [new Date(), u.id]);
      const csrf = await createSession(ctx.db, reply, u.id, req.ip, secure);
      await logEvent(ctx.db, { kind: 'login', actor: { userId: u.id, resellerId: u.reseller_id, ip: req.ip } });
      return { ok: true, csrf };
    });

    app.post('/logout', async (req, reply) => {
      if (req.staff) await exec(ctx.db, 'DELETE FROM sessions WHERE id = ?', [req.staff.sessionId]);
      void reply.clearCookie(SID, { path: '/' });
      void reply.clearCookie(CSRF, { path: '/' });
      return { ok: true };
    });

    app.get('/me', { preHandler: requireStaff() }, async (req) => {
      const s = req.staff!;
      const reseller = s.resellerId ? await one(ctx.db, 'SELECT id, name, quota_licenses quotaLicenses, quota_users quotaUsers, discount_pct discountPct FROM resellers WHERE id = ?', [s.resellerId]) : null;
      return { user: { id: s.id, email: s.email, name: s.name, role: s.role }, reseller };
    });

    app.post('/password', { preHandler: requireStaff() }, async (req) => {
      const b = z.object({ current: z.string(), password: z.string().min(10).max(200) }).parse(req.body);
      const u = (await one<{ password_hash: string }>(ctx.db, 'SELECT password_hash FROM staff_users WHERE id = ?', [req.staff!.id]))!;
      if (!(await verifyPassword(b.current, u.password_hash))) throw badRequest('The current password is wrong');
      await exec(ctx.db, 'UPDATE staff_users SET password_hash = ? WHERE id = ?', [await hashPassword(b.password), req.staff!.id]);
      await exec(ctx.db, 'DELETE FROM sessions WHERE user_id = ? AND id <> ?', [req.staff!.id, req.staff!.sessionId]);
      return { ok: true };
    });
  };
}
