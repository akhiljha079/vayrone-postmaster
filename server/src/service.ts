// Web role: HTTPS API + SPA + Socket.IO. In production it runs inside the
// `vpm core` process next to the mail listeners (app/src/vpm.ts).
import type { FastifyInstance } from 'fastify';
import type { CoreContext } from '@vpm/core';
import type { LicenseManager } from '@vpm/license-client';
import { buildApp } from './app.js';

export interface RunningWeb {
  app: FastifyInstance;
  port: number;
  stop(): Promise<void>;
}

export async function startWeb(ctx: CoreContext, license: LicenseManager | null): Promise<RunningWeb> {
  const { config } = ctx;
  const app = await buildApp(ctx, {
    // Session cookies and tokens never reach the log files.
    logger: { level: config.logLevel, redact: { paths: ['req.headers.authorization', 'req.headers.cookie', 'req.headers["x-vpm-csrf"]', 'req.headers["x-vpm-setup"]', 'res.headers["set-cookie"]'], censor: '[redacted]' } },
    https: config.web.tls ? { key: ctx.tls.key, cert: ctx.tls.cert } : null,
    license,
  });
  await app.listen({ port: config.web.port, host: config.listenHost });
  const addr = app.server.address();
  const port = typeof addr === 'object' && addr ? addr.port : config.web.port;
  ctx.log.info({ port, tls: config.web.tls }, 'web role started');
  return { app, port, stop: () => app.close() };
}
