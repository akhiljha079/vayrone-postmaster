import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import type { LsContext } from './context.js';
import { registerAuth } from './auth.js';
import { errorHandler } from './http.js';
import { productRoutes } from './routes/product.js';
import { authRoutes } from './routes/auth.js';
import { clientRoutes } from './routes/clients.js';
import { catalogRoutes } from './routes/catalog.js';
import { licenseRoutes } from './routes/licenses.js';
import { reportRoutes } from './routes/reports.js';
import { settingsRoutes } from './routes/settings.js';

export async function buildApp(ctx: LsContext, opts: { logger?: FastifyServerOptions['logger'] } = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts.logger ?? false, trustProxy: ctx.config.trustProxy, bodyLimit: 512 * 1024 });
  app.setErrorHandler(errorHandler);
  await app.register(cookie);
  await app.register(helmet, {
    contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'data:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], frameAncestors: ["'none'"] } },
  });
  await app.register(rateLimit, { global: false });
  registerAuth(app, ctx.db);

  app.get('/api/health', async () => ({ ok: true }));
  await app.register(productRoutes(ctx), { prefix: '/api/v1' });
  await app.register(authRoutes(ctx), { prefix: '/api/auth' });
  for (const r of [clientRoutes, catalogRoutes, licenseRoutes, reportRoutes, settingsRoutes]) await app.register(r(ctx), { prefix: '/api' });

  const webRoot = ctx.config.webRoot ? resolve(ctx.config.webRoot) : null;
  if (webRoot && existsSync(join(webRoot, 'index.html'))) {
    await app.register(fastifyStatic, { root: webRoot, wildcard: false });
    const index = await readFile(join(webRoot, 'index.html'));
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !/\.[a-z0-9]+$/i.test(req.url.split('?')[0]!)) return reply.type('text/html').header('cache-control', 'no-cache').send(index);
      return reply.status(404).send({ error: 'NOT_FOUND', message: 'Not found' });
    });
  } else app.setNotFoundHandler((_req, reply) => reply.status(404).send({ error: 'NOT_FOUND', message: 'Not found' }));
  return app;
}
