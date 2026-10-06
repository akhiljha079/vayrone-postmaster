import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { APP_VERSION, db as dbm, type CoreContext } from '@vpm/core';
import { Sessions } from './sessions.js';
import { isAdminRole, registerAuth } from './guards.js';
import { errorHandler, HttpError, notFound } from './http.js';
import { authRoutes } from './routes/auth.js';
import { directoryRoutes } from './routes/admin/directory.js';
import { relayRoutes } from './routes/admin/relay.js';
import { systemRoutes } from './routes/admin/system.js';
import { mailRoutes } from './routes/mail.js';
import { externalRoutes } from './routes/admin/external.js';
import { rulesRoutes } from './routes/admin/rules.js';
import { webmailRoutes } from './routes/webmail.js';
import { archiveRoutes } from './routes/admin/archive.js';
import { backupRoutes } from './routes/admin/backup.js';
import { licenseRoutes } from './routes/admin/license.js';
import { setupRoutes } from './routes/setup.js';
import { updateRoutes } from './routes/admin/updates.js';
import { healthRoutes, metricsRoute } from './routes/admin/health.js';
import { networkRoutes } from './routes/admin/network.js';
import { filterRoutes } from './routes/admin/filter.js';
import { attachRealtime } from './realtime.js';
import { LicenseManager } from '@vpm/license-client';

export const PRODUCT = { name: 'Vayrone PostMaster', vendor: 'Vayrone Infratech', tagline: 'Vayrone PostMaster by Vayrone Infratech' };

const LOGO_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };

export interface AppOptions {
  logger?: FastifyServerOptions['logger'];
  https?: { key: Buffer; cert: Buffer } | null;
  /** Licence manager for the licence page (defaults to ctx.license when it is one). */
  license?: LicenseManager | null;
}

export async function buildApp(ctx: CoreContext, opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: opts.logger ?? false,
    trustProxy: ctx.config.web.trustProxy,
    bodyLimit: 2 * 1024 * 1024,
    // Slow or stalled clients are cut off; uploads (update files, attachments) get 15 minutes.
    requestTimeout: 15 * 60_000,
    keepAliveTimeout: 65_000,
    connectionTimeout: 0,
    ...(opts.https ? { https: { key: opts.https.key, cert: opts.https.cert, minVersion: 'TLSv1.2' as const } } : {}),
  });
  const sessions = new Sessions(ctx.db, ctx.settings);

  app.setErrorHandler(errorHandler);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Email bodies render in a sandboxed srcdoc iframe that adds its own stricter CSP;
        // remote images load only after the user clicks "Show images".
        imgSrc: ["'self'", 'data:', 'https:', 'http:'],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
        upgradeInsecureRequests: null,
      },
    },
    hsts: Boolean(opts.https),
  });
  await app.register(rateLimit, { global: false });
  registerAuth(app, ctx, sessions);
  // API answers carry personal data: never cache them in browsers or proxies.
  app.addHook('onSend', async (req, reply, payload) => {
    if (req.url.startsWith('/api/') && !reply.getHeader('cache-control')) void reply.header('cache-control', 'no-store');
    return payload;
  });

  // ---------------------------------------------------------------- public
  app.get('/api/health', async () => ({ ok: true, version: APP_VERSION }));

  app.get('/api/public/branding', async () => {
    const c = await dbm.one<{ company_name: string; logo_path: string | null; updated_at: Date }>(ctx.db, 'SELECT company_name, logo_path, updated_at FROM company_profile WHERE id = 1');
    return {
      product: PRODUCT,
      version: APP_VERSION,
      company: c ? { name: c.company_name, logoUrl: c.logo_path ? `/api/public/logo?v=${new Date(c.updated_at).getTime()}` : null } : null,
    };
  });

  // The server's TLS certificate (public), so PCs can trust a self-signed certificate once (docs/mail-clients.md).
  app.get('/api/public/certificate', async (_req, reply) => {
    return reply
      .type('application/x-x509-ca-cert')
      .header('content-disposition', `attachment; filename="${ctx.config.hostname}.crt"`)
      .header('cache-control', 'no-cache')
      .send(ctx.tls.cert);
  });

  app.get('/api/public/logo', async (_req, reply) => {
    const c = await dbm.one<{ logo_path: string | null }>(ctx.db, 'SELECT logo_path FROM company_profile WHERE id = 1');
    if (!c?.logo_path) throw notFound('No logo');
    const file = resolve(ctx.config.dataPath, c.logo_path);
    if (!file.startsWith(resolve(ctx.config.dataPath)) || !existsSync(file)) throw notFound('No logo');
    const type = LOGO_TYPES[extname(file).toLowerCase()];
    if (!type) throw notFound('No logo');
    return reply.type(type).header('cache-control', 'no-cache').header('x-content-type-options', 'nosniff').send(await readFile(file));
  });

  // About page: product and licence summary for signed-in users (licence details for admins only).
  app.get('/api/about', async (req) => {
    if (!req.auth) throw new HttpError(401, 'UNAUTHENTICATED', 'Please sign in');
    const c = await dbm.one<{ company_name: string }>(ctx.db, 'SELECT company_name FROM company_profile WHERE id = 1');
    const admin = isAdminRole(req.auth.user.role) || req.auth.user.role === 'auditor';
    const ev = (ctx.license as { evaluation?: () => { status: string } }).evaluation?.();
    const l = admin && ctx.license instanceof LicenseManager ? (await ctx.license.info()).license : null;
    return {
      product: PRODUCT,
      version: APP_VERSION,
      company: c?.company_name ?? null,
      hostname: ctx.config.hostname,
      license: admin
        ? {
            status: ev?.status ?? ctx.license.mode(),
            licensedTo: l?.client.name ?? null,
            licenseId: l?.licenseId ?? null,
            plan: l?.plan.name ?? null,
            maxUsers: l?.maxUsers ?? ctx.license.maxUsers(),
            expiresAt: l?.expiresAt ?? null,
            amcExpiresAt: l?.amcExpiresAt ?? null,
          }
        : null,
      copyright: `© ${new Date().getFullYear()} Vayrone Infratech, Agra, India. All rights reserved.`,
    };
  });

  // ---------------------------------------------------------------- API
  await app.register(authRoutes(ctx, sessions), { prefix: '/api/auth' });
  await app.register(directoryRoutes(ctx, sessions), { prefix: '/api/admin' });
  await app.register(relayRoutes(ctx), { prefix: '/api/admin' });
  await app.register(systemRoutes(ctx, sessions), { prefix: '/api/admin' });
  await app.register(externalRoutes(ctx), { prefix: '/api/admin' });
  await app.register(rulesRoutes(ctx), { prefix: '/api/admin' });
  await app.register(archiveRoutes(ctx), { prefix: '/api/admin' });
  await app.register(backupRoutes(ctx), { prefix: '/api/admin' });
  const manager = opts.license ?? (ctx.license instanceof LicenseManager ? ctx.license : null);
  await app.register(licenseRoutes(ctx, manager), { prefix: '/api/admin' });
  await app.register(setupRoutes(ctx, manager), { prefix: '/api/setup' });
  await app.register(updateRoutes(ctx, manager), { prefix: '/api/admin' });
  await app.register(healthRoutes(ctx), { prefix: '/api/admin' });
  await app.register(networkRoutes(ctx), { prefix: '/api/admin' });
  await app.register(filterRoutes(ctx), { prefix: '/api/admin' });
  await app.register(metricsRoute(ctx));
  await app.register(mailRoutes(ctx), { prefix: '/api/mail' });
  await app.register(webmailRoutes(ctx), { prefix: '/api/mail' });
  attachRealtime(app, ctx, sessions);

  // ---------------------------------------------------------------- SPA
  const webRoot = ctx.config.webRoot ? resolve(ctx.config.webRoot) : null;
  if (webRoot && existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false, index: ['index.html'] });
    const indexHtml = await readFile(join(webRoot, 'index.html'));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) {
        // Static assets are served by @fastify/static; any other path is a client-side route.
        if (!/\.[a-z0-9]+$/i.test(req.url.split('?')[0]!)) return reply.type('text/html').header('cache-control', 'no-cache').send(indexHtml);
      }
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Not found' });
    });
  } else {
    app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'NOT_FOUND', message: 'Not found' }));
  }

  return app;
}
