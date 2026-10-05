// Licence page: status, online activation, heartbeat, offline request/import,
// machine transfer. These routes stay usable when the licence is read-only —
// renewing is the way out of that state.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db as dbm, licensedUserCount, type CoreContext } from '@vpm/core';
import { LicenseActionError, type LicenseManager } from '@vpm/license-client';
import { audit, requireAdmin } from '../../guards.js';
import { HttpError } from '../../http.js';

const { rows } = dbm;

function actionError(e: unknown): never {
  if (e instanceof LicenseActionError) {
    throw new HttpError(e.code === 'NETWORK' || e.code === 'BAD_RESPONSE' ? 502 : 400, e.code === 'NETWORK' ? 'LICENSE_SERVER_UNREACHABLE' : e.code, e.message);
  }
  throw e;
}

export function licenseRoutes(ctx: CoreContext, manager: LicenseManager | null) {
  const read = requireAdmin(ctx, 'read', { auditorAllowed: true });
  const admin = requireAdmin(ctx, 'write', { allowReadonly: true });
  const owner = requireAdmin(ctx, 'super', { allowReadonly: true });

  const need = (): LicenseManager => {
    if (!manager) throw new HttpError(409, 'LICENSE_UNMANAGED', 'Licensing is not active in this process');
    return manager;
  };

  return async (app: FastifyInstance) => {
    app.get('/license', { preHandler: read }, async () => {
      if (!manager) {
        return { managed: false, mode: ctx.license.mode(), usage: { activeUsers: await licensedUserCount(ctx.db), externalAccounts: 0 }, maxUsers: ctx.license.maxUsers() };
      }
      return { managed: true, ...(await manager.info()) };
    });

    app.get('/license/events', { preHandler: read }, async () =>
      rows(ctx.db, 'SELECT id, at, event, detail FROM license_events ORDER BY id DESC LIMIT 100'),
    );

    app.post('/license/activate', { preHandler: owner, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
      const { key } = z.object({ key: z.string().trim().min(10).max(60) }).parse(req.body);
      const m = need();
      try {
        await m.activateOnline(key);
      } catch (e) {
        await audit(ctx, req, 'license.activate_failed', 'license', null, { error: (e as Error).message });
        actionError(e);
      }
      const info = await m.info();
      await audit(ctx, req, 'license.activate', 'license', info.license?.licenseId ?? null, { plan: info.license?.plan.code, maxUsers: info.license?.maxUsers });
      return info;
    });

    app.post('/license/check', { preHandler: admin, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
      const m = need();
      const r = await m.heartbeat();
      await audit(ctx, req, 'license.check', 'license', null, { ok: r.ok, ...(r.error ? { error: r.error } : {}) });
      if (r.skipped) throw new HttpError(400, 'NOT_ONLINE', 'Only online-activated licences check in with the License Server. Use offline re-validation instead.');
      if (!r.ok) throw new HttpError(502, 'LICENSE_CHECK_FAILED', r.error ?? 'The licence check failed');
      return m.info();
    });

    app.post('/license/offline-request', { preHandler: owner }, async (req) => {
      const { key } = z.object({ key: z.string().trim().max(60).nullish() }).parse(req.body ?? {});
      try {
        const r = await need().offlineRequest(key || null);
        await audit(ctx, req, 'license.offline_request', 'license', null, {});
        return r;
      } catch (e) {
        actionError(e);
      }
    });

    app.post('/license/import', { preHandler: owner }, async (req) => {
      const { text } = z.object({ text: z.string().min(50).max(200_000) }).parse(req.body);
      const m = need();
      try {
        await m.importFile(text);
      } catch (e) {
        await audit(ctx, req, 'license.import_failed', 'license', null, { error: (e as Error).message });
        actionError(e);
      }
      const info = await m.info();
      await audit(ctx, req, 'license.import', 'license', info.license?.licenseId ?? null, { plan: info.license?.plan.code, maxUsers: info.license?.maxUsers, expiresAt: info.license?.expiresAt });
      return info;
    });

    app.post('/license/deactivate', { preHandler: owner }, async (req) => {
      z.object({ confirm: z.literal('TRANSFER') }).parse(req.body);
      const m = need();
      try {
        await m.deactivate();
      } catch (e) {
        actionError(e);
      }
      await audit(ctx, req, 'license.deactivate', 'license', null, {});
      return m.info();
    });
  };
}
