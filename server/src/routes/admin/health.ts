// Health page, alert e-mail settings, and the Prometheus /metrics endpoint
// (bearer token; generate it in Admin → Health).
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { collectHealth, metricsText, monitorSettings, runMonitorChecks, notifyAlerts, type CoreContext } from '@vpm/core';
import { audit, requireAdmin } from '../../guards.js';
import { HttpError } from '../../http.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');

export function healthRoutes(ctx: CoreContext) {
  const read = requireAdmin(ctx, 'read');
  const owner = requireAdmin(ctx, 'super');
  return async (app: FastifyInstance) => {
    app.get('/health', { preHandler: read }, async () => {
      const [health, settings, token] = await Promise.all([collectHealth(ctx), monitorSettings(ctx), ctx.settings.get<{ hash: string; createdAt: string } | null>('monitor', 'metricsToken', null)]);
      return { health, settings, metrics: { enabled: Boolean(token), createdAt: token?.createdAt ?? null } };
    });

    app.post('/health/check', { preHandler: read, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async () => runMonitorChecks(ctx));

    app.put('/health/settings', { preHandler: owner }, async (req) => {
      const b = z
        .object({
          emails: z.array(z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address')).max(10),
          minSeverity: z.enum(['warning', 'critical']),
          diskWarnPct: z.number().min(1).max(50),
          diskCriticalPct: z.number().min(1).max(50),
          queueWarnMinutes: z.number().int().min(5).max(1440),
          fetchFailHours: z.number().min(0.25).max(72),
          certWarnDays: z.number().int().min(1).max(120),
        })
        .partial()
        .parse(req.body);
      const next = { ...(await monitorSettings(ctx)), ...b };
      await ctx.settings.set('monitor', 'config', next, req.auth!.user.id);
      await audit(ctx, req, 'monitor.settings', 'settings', 'monitor', b);
      return next;
    });

    app.post('/health/test-email', { preHandler: owner, config: { rateLimit: { max: 3, timeWindow: '10 minutes' } } }, async (req) => {
      const s = await monitorSettings(ctx);
      if (!s.emails.length) throw new HttpError(400, 'NO_RECIPIENTS', 'Add at least one alert e-mail address first');
      await ctx.db.query(
        `INSERT INTO admin_alerts (severity, code, message, dedupe_key, first_at, last_at) VALUES ('critical', 'monitor.test', ?, 'monitor.test', ?, ?)
         ON DUPLICATE KEY UPDATE resolved_at = NULL, acknowledged_at = NULL, notified_at = NULL, last_at = VALUES(last_at)`,
        [`Test alert from ${req.auth!.user.login}. Alert e-mails work.`, new Date(), new Date()],
      );
      const sent = await notifyAlerts(ctx);
      await ctx.db.query("UPDATE admin_alerts SET resolved_at = ? WHERE dedupe_key = 'monitor.test'", [new Date()]);
      return { ok: true, alerts: sent, recipients: s.emails };
    });

    app.post('/health/metrics-token', { preHandler: owner }, async (req) => {
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      if (!enabled) {
        await ctx.settings.set('monitor', 'metricsToken', null, req.auth!.user.id);
        await audit(ctx, req, 'monitor.metrics_disable', 'settings', 'monitor');
        return { enabled: false };
      }
      const token = `vpm_${randomBytes(24).toString('base64url')}`;
      await ctx.settings.set('monitor', 'metricsToken', { hash: sha(token), createdAt: new Date().toISOString() }, req.auth!.user.id);
      await audit(ctx, req, 'monitor.metrics_token', 'settings', 'monitor');
      return { enabled: true, token }; // shown once
    });
  };
}

/** GET /metrics — Prometheus scrape endpoint, enabled once a token exists. */
export function metricsRoute(ctx: CoreContext) {
  return async (app: FastifyInstance) => {
    app.get('/metrics', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req, reply) => {
      const t = await ctx.settings.get<{ hash: string } | null>('monitor', 'metricsToken', null);
      const m = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '');
      const want = t ? Buffer.from(t.hash, 'hex') : null;
      const got = m ? Buffer.from(sha(m[1]!), 'hex') : null;
      if (!want || !got || !timingSafeEqual(want, got)) return reply.status(401).header('www-authenticate', 'Bearer').send({ error: 'UNAUTHENTICATED', message: 'Metrics token required' });
      return reply.type('text/plain; version=0.0.4').send(metricsText(await collectHealth(ctx)));
    });
  };
}
