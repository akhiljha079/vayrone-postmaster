import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { generateSecret, generateURI, verify as verifyTotp } from 'otplib';
import QRCode from 'qrcode';
import { db as dbm, hashPassword, verifyPassword, type CoreContext } from '@vpm/core';
import type { Sessions } from '../sessions.js';
import { CSRF_COOKIE, SID_COOKIE, audit, cookieOpts, isAdminRole, issueCsrf, licenseBanner, requireUser } from '../guards.js';
import { HttpError, badRequest, forbidden, notFound } from '../http.js';

const { exec, one, rows } = dbm;

const ISSUER = 'Vayrone PostMaster';
const MFA_MAX_FAILURES = 5;

export const PasswordSchema = z
  .string()
  .min(8, 'At least 8 characters')
  .max(200)
  .refine((p) => /[A-Za-z]/.test(p) && /[0-9]/.test(p), 'Use letters and numbers');

const LoginBody = z.object({ login: z.string().trim().min(1).max(254), password: z.string().min(1).max(200) });
const CodeBody = z.object({ code: z.string().trim().min(6).max(20) });

const FAILURE_MESSAGES: Record<string, string> = {
  locked: 'Account temporarily locked after too many failed attempts. Try again later or ask your administrator.',
  ip_denied: 'Sign-in is not allowed from this network address.',
  protocol_disabled: 'Web access is disabled for this account.',
  support_disabled: 'Vayrone Support access is not enabled on this server.',
};

function recoveryHash(code: string): string {
  return createHash('sha256').update(code.replace(/[^0-9a-f]/gi, '').toLowerCase()).digest('hex');
}

export async function checkTotp(ctx: CoreContext, userId: number, code: string): Promise<boolean> {
  const u = await one<{ totp_secret: Buffer | null }>(ctx.db, 'SELECT totp_secret FROM users WHERE id = ?', [userId]);
  if (!u?.totp_secret) return false;
  const secret = ctx.secrets.open(Buffer.from(u.totp_secret));
  const digits = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    const r = await verifyTotp({ secret, token: digits, epochTolerance: 30 });
    if (r.valid) return true;
  }
  // Single-use recovery code
  const h = recoveryHash(code);
  const res = await exec(ctx.db, 'UPDATE user_recovery_codes SET used_at = ? WHERE user_id = ? AND code_hash = ? AND used_at IS NULL', [new Date(), userId, h]);
  return res.affectedRows === 1;
}

export function authRoutes(ctx: CoreContext, sessions: Sessions) {
  const secure = ctx.config.web.tls;
  return async (app: FastifyInstance) => {
    app.post('/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const body = LoginBody.parse(req.body);
      const r = await ctx.directory.authenticateDetailed(body.login, body.password, 'web', req.ip);
      if (!r.user) {
        throw new HttpError(401, 'INVALID_LOGIN', FAILURE_MESSAGES[r.failure ?? ''] ?? 'Incorrect email or password.');
      }
      const user = r.user;
      if (ctx.license.mode() === 'readonly' && !isAdminRole(user.role)) {
        throw forbidden('The server licence has expired. Webmail sign-in is paused until the administrator renews it. Mail delivery continues.', 'LICENSE_READONLY');
      }
      const u = await one<{ has_mailbox: number }>(ctx.db, 'SELECT has_mailbox FROM users WHERE id = ?', [user.id]);
      const staff = isAdminRole(user.role) || user.role === 'auditor';
      if (!u?.has_mailbox && !staff) throw forbidden('This account has no mailbox');
      // Mailbox users start in Mail Mode; staff accounts without a mailbox start in the Admin Panel.
      const mode = u?.has_mailbox ? 'mail' : 'admin';
      const s = await sessions.create(user.id, req.ip, req.headers['user-agent'], !r.hasTotp, mode);
      void reply.setCookie(SID_COOKIE, s.token, cookieOpts(secure, true));
      const csrf = issueCsrf(reply, secure);
      await ctx.audit.log({
        actorUserId: user.id,
        actorLogin: user.login,
        actorRole: user.role,
        isSupport: user.role === 'vayrone_support',
        ip: req.ip,
        action: 'auth.login',
        targetType: 'user',
        targetId: user.id,
        details: { mfaPending: r.hasTotp },
      });
      return { mfaRequired: r.hasTotp, mode, csrf };
    });

    app.post('/mfa', { preHandler: requireUser({ allowMfaPending: true }), config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const a = req.auth!;
      if (a.session.mfa_passed) return { ok: true };
      const { code } = CodeBody.parse(req.body);
      if (await checkTotp(ctx, a.user.id, code)) {
        await sessions.setMfaPassed(a.session.id);
        return { ok: true };
      }
      await exec(ctx.db, "INSERT INTO login_attempts (at, login, user_id, protocol, ip, success, reason) VALUES (?,?,?,'web',?,0,'mfa_failed')", [
        new Date(),
        a.user.login,
        a.user.id,
        req.ip,
      ]);
      const recent = await one<{ n: number }>(
        ctx.db,
        "SELECT COUNT(*) n FROM login_attempts WHERE user_id = ? AND reason = 'mfa_failed' AND at > ?",
        [a.user.id, new Date(Date.now() - 15 * 60_000)],
      );
      if (Number(recent?.n) >= MFA_MAX_FAILURES) {
        await sessions.revoke(a.session.id, null);
        throw new HttpError(401, 'MFA_LOCKED', 'Too many wrong codes. Sign in again.');
      }
      throw new HttpError(401, 'MFA_INVALID', 'That code is not valid. Check your authenticator app and try again.');
    });

    app.post('/logout', async (req, reply) => {
      if (req.auth) await sessions.revoke(req.auth.session.id, req.auth.user.id);
      void reply.clearCookie(SID_COOKIE, { path: '/' });
      void reply.clearCookie(CSRF_COOKIE, { path: '/' });
      return { ok: true };
    });

    app.get('/me', { preHandler: requireUser({ allowMfaPending: true }) }, async (req, reply) => {
      const a = req.auth!;
      const sec = await ctx.settings.security();
      // Make sure the browser holds a CSRF token for this session (e.g. after a server restart).
      const csrf = req.cookies[CSRF_COOKIE] ?? issueCsrf(reply, secure);
      return {
        user: {
          id: a.user.id,
          login: a.user.login,
          displayName: a.user.display_name,
          role: a.user.role,
          hasMailbox: Boolean(a.user.has_mailbox),
          totpEnabled: Boolean(a.user.totp_enabled),
        },
        mode: a.session.ui_mode,
        mfaPassed: Boolean(a.session.mfa_passed),
        canUseAdmin: isAdminRole(a.user.role) || a.user.role === 'auditor',
        canUseMail: Boolean(a.user.has_mailbox),
        totpEnrollmentRequired: sec.requireTotpForAdmins && isAdminRole(a.user.role) && !a.user.totp_enabled,
        license: licenseBanner(ctx, a.user.role),
        csrf,
      };
    });

    app.post('/mode', { preHandler: requireUser() }, async (req) => {
      const { mode } = z.object({ mode: z.enum(['mail', 'admin']) }).parse(req.body);
      const a = req.auth!;
      if (mode === 'admin' && !(isAdminRole(a.user.role) || a.user.role === 'auditor')) throw forbidden('Admin panel is not available for your account');
      if (mode === 'mail' && !a.user.has_mailbox) throw forbidden('This account has no mailbox');
      await sessions.setMode(a.session.id, mode);
      return { mode };
    });

    app.get('/sessions', { preHandler: requireUser() }, async (req) => {
      const list = await sessions.listActive(req.auth!.user.id);
      const current = req.auth!.session.id.slice(0, 16);
      return list.map((s) => ({ ...s, current: s.handle === current }));
    });

    app.delete<{ Params: { handle: string } }>('/sessions/:handle', { preHandler: requireUser() }, async (req) => {
      const s = await sessions.findByHandle(req.params.handle);
      if (!s || s.user_id !== req.auth!.user.id) throw notFound('Session not found');
      await sessions.revoke(s.id, req.auth!.user.id);
      await audit(ctx, req, 'session.revoke', 'session', req.params.handle);
      return { ok: true };
    });

    app.post('/password', { preHandler: requireUser() }, async (req) => {
      const body = z.object({ current: z.string().min(1), next: PasswordSchema }).parse(req.body);
      const a = req.auth!;
      const u = await one<{ password_hash: string }>(ctx.db, 'SELECT password_hash FROM users WHERE id = ?', [a.user.id]);
      if (!u || !(await verifyPassword(body.current, u.password_hash))) throw badRequest('Current password is incorrect', 'BAD_PASSWORD');
      await exec(ctx.db, 'UPDATE users SET password_hash = ?, password_changed_at = ?, must_change_password = 0, updated_at = ? WHERE id = ?', [
        await hashPassword(body.next),
        new Date(),
        new Date(),
        a.user.id,
      ]);
      const revoked = await sessions.revokeAllForUser(a.user.id, a.user.id, a.session.id);
      await audit(ctx, req, 'user.password_change', 'user', a.user.id, { otherSessionsRevoked: revoked });
      return { ok: true, otherSessionsRevoked: revoked };
    });

    // --- TOTP enrolment ----------------------------------------------------

    app.post('/totp/setup', { preHandler: requireUser() }, async (req) => {
      const a = req.auth!;
      if (a.user.totp_enabled) throw badRequest('Two-factor authentication is already enabled');
      const secret = generateSecret();
      await exec(ctx.db, 'UPDATE users SET totp_secret = ? WHERE id = ?', [ctx.secrets.seal(secret), a.user.id]);
      const uri = generateURI({ issuer: ISSUER, label: a.user.login, secret });
      return { secret, uri, qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }) };
    });

    app.post('/totp/enable', { preHandler: requireUser() }, async (req) => {
      const a = req.auth!;
      const { code } = CodeBody.parse(req.body);
      if (a.user.totp_enabled) throw badRequest('Already enabled');
      const u = await one<{ totp_secret: Buffer | null }>(ctx.db, 'SELECT totp_secret FROM users WHERE id = ?', [a.user.id]);
      if (!u?.totp_secret) throw badRequest('Start setup first');
      const ok = await verifyTotp({ secret: ctx.secrets.open(Buffer.from(u.totp_secret)), token: code, epochTolerance: 30 });
      if (!ok.valid) throw badRequest('That code is not valid', 'MFA_INVALID');
      const codes = Array.from({ length: 10 }, () => {
        const h = randomBytes(4).toString('hex');
        return `${h.slice(0, 4)}-${h.slice(4)}`;
      });
      await exec(ctx.db, 'DELETE FROM user_recovery_codes WHERE user_id = ?', [a.user.id]);
      await exec(ctx.db, 'INSERT INTO user_recovery_codes (user_id, code_hash) VALUES ?', [codes.map((c) => [a.user.id, recoveryHash(c)])]);
      await exec(ctx.db, 'UPDATE users SET totp_enabled = 1 WHERE id = ?', [a.user.id]);
      await audit(ctx, req, 'user.totp_enable', 'user', a.user.id);
      return { ok: true, recoveryCodes: codes };
    });

    app.post('/totp/disable', { preHandler: requireUser() }, async (req) => {
      const a = req.auth!;
      const { password } = z.object({ password: z.string().min(1) }).parse(req.body);
      const u = await one<{ password_hash: string }>(ctx.db, 'SELECT password_hash FROM users WHERE id = ?', [a.user.id]);
      if (!u || !(await verifyPassword(password, u.password_hash))) throw badRequest('Password is incorrect', 'BAD_PASSWORD');
      const sec = await ctx.settings.security();
      if (sec.requireTotpForAdmins && isAdminRole(a.user.role)) throw forbidden('Two-factor authentication is mandatory for admin accounts');
      await exec(ctx.db, 'UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?', [a.user.id]);
      await exec(ctx.db, 'DELETE FROM user_recovery_codes WHERE user_id = ?', [a.user.id]);
      await audit(ctx, req, 'user.totp_disable', 'user', a.user.id);
      return { ok: true };
    });

    void rows;
  };
}
