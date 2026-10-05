// Request authentication and role checks.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, preHandlerAsyncHookHandler } from 'fastify';
import type { CoreContext, Role } from '@vpm/core';
import type { Session, SessionUser, Sessions } from './sessions.js';
import { forbidden, HttpError } from './http.js';

export const SID_COOKIE = 'vpm_sid';
export const CSRF_COOKIE = 'vpm_csrf';
export const CSRF_HEADER = 'x-vpm-csrf';

export interface AuthInfo {
  session: Session;
  user: SessionUser;
  isSupport: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

export const ADMIN_ROLES: Role[] = ['super_admin', 'admin', 'vayrone_support'];
export type Level = 'read' | 'write' | 'super';

export function isAdminRole(r: Role): boolean {
  return ADMIN_ROLES.includes(r);
}

export function cookieOpts(secure: boolean, httpOnly: boolean) {
  return { path: '/', httpOnly, secure, sameSite: 'strict' as const };
}

export function issueCsrf(reply: FastifyReply, secure: boolean): string {
  const t = randomBytes(24).toString('base64url');
  void reply.setCookie(CSRF_COOKIE, t, cookieOpts(secure, false));
  return t;
}

function csrfOk(req: FastifyRequest): boolean {
  const c = req.cookies[CSRF_COOKIE];
  const h = req.headers[CSRF_HEADER];
  if (!c || typeof h !== 'string' || c.length !== h.length) return false;
  return timingSafeEqual(Buffer.from(c), Buffer.from(h));
}

export function registerAuth(app: FastifyInstance, ctx: CoreContext, sessions: Sessions): void {
  app.decorateRequest('auth', null);
  app.addHook('onRequest', async (req) => {
    req.auth = null;
    const token = req.cookies[SID_COOKIE];
    if (!token) return;
    const v = await sessions.validate(token);
    if (v) req.auth = { ...v, isSupport: v.user.role === 'vayrone_support' };
  });
  // Double-submit CSRF for every state-changing API call made with a session.
  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/api/') || ['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return;
    if (!req.cookies[SID_COOKIE] || req.url === '/api/auth/login') return;
    if (!csrfOk(req)) throw new HttpError(403, 'CSRF', 'Missing or invalid CSRF token; reload the page');
  });
  void ctx;
}

/** Requires a logged-in user. MFA must be complete unless allowPending. */
export function requireUser(opts: { allowMfaPending?: boolean } = {}): preHandlerAsyncHookHandler {
  return async (req) => {
    if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in');
    if (!opts.allowMfaPending && !req.auth.session.mfa_passed) throw new HttpError(401, 'MFA_REQUIRED', 'Two-factor code required');
  };
}

/**
 * Admin panel access.
 *   read  — admins, Vayrone Support, and auditors (auditor only where `auditorAllowed`)
 *   write — admins and Vayrone Support; blocked when the licence is read-only
 *           (except allowReadonly routes: the licence page itself)
 *   super — super_admin only
 */
export function requireAdmin(ctx: CoreContext, level: Level, opts: { auditorAllowed?: boolean; allowReadonly?: boolean } = {}): preHandlerAsyncHookHandler {
  const user = requireUser();
  return async function (this: FastifyInstance, req, reply) {
    await user.call(this, req, reply);
    const a = req.auth!;
    const role = a.user.role;
    const ok =
      level === 'super' ? role === 'super_admin' : level === 'write' ? isAdminRole(role) : isAdminRole(role) || (role === 'auditor' && opts.auditorAllowed === true);
    if (!ok) throw forbidden('Your role does not allow this action');
    if (!(await ctx.ipPolicy.allowed(req.ip, 'admin'))) throw forbidden('Admin access is not allowed from this IP address', 'IP_DENIED');
    const sec = await ctx.settings.security();
    if (sec.requireTotpForAdmins && isAdminRole(role) && !a.user.totp_enabled) {
      throw forbidden('Two-factor authentication must be enabled for admin accounts', 'TOTP_ENROLL_REQUIRED');
    }
    if (level !== 'read' && !opts.allowReadonly && ctx.license.mode() === 'readonly') {
      throw forbidden('The licence has expired; the admin panel is read-only until it is renewed', 'LICENSE_READONLY');
    }
  };
}

/** Writes an audit entry for the current request. */
export async function audit(
  ctx: CoreContext,
  req: FastifyRequest,
  action: string,
  targetType: string | null,
  targetId: string | number | null,
  details?: Record<string, unknown>,
): Promise<void> {
  const a = req.auth;
  await ctx.audit.log({
    actorUserId: a?.user.id ?? null,
    actorLogin: a?.user.login ?? null,
    actorRole: a?.user.role ?? null,
    isSupport: a?.isSupport ?? false,
    ip: req.ip,
    action,
    targetType,
    targetId,
    details: details ?? null,
  });
}

export interface LicenseBannerInfo {
  mode: ReturnType<CoreContext['license']['mode']>;
  /** Banner text for admins (null for mailbox users and when nothing needs attention). */
  message: string | null;
  level: 'info' | 'warning' | 'critical' | null;
}

/** Licence banner for the signed-in user. Mailbox users never see licensing details. */
export function licenseBanner(ctx: CoreContext, role: Role): LicenseBannerInfo {
  const mode = ctx.license.mode();
  const gate = ctx.license as CoreContext['license'] & { evaluation?: () => { reason: string; warning: string | null } };
  if (!isAdminRole(role) && role !== 'auditor') return { mode, message: null, level: null };
  const ev = gate.evaluation?.();
  if (mode === 'readonly') return { mode, level: 'critical', message: ev?.reason ?? 'The licence has expired. The admin panel is read-only until it is renewed. Mail keeps flowing.' };
  if (mode === 'grace') return { mode, level: 'warning', message: ev?.reason ?? 'The licence has expired and is in its grace period. Renew to avoid interruption.' };
  if (mode === 'unlicensed') return { mode, level: 'info', message: ev?.reason ?? 'This server is not licensed yet.' };
  return { mode, level: ev?.warning ? 'warning' : null, message: ev?.warning ?? null };
}
