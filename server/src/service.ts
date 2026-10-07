// Web role: HTTPS API + SPA + Socket.IO. In production it runs inside the
// `vpm core` process next to the mail listeners (app/src/vpm.ts).
import { createServer, type Server } from 'node:http';
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
  const redirect = config.web.tls ? await startHttpRedirect(ctx, port) : null;
  return {
    app,
    port,
    stop: async () => {
      redirect?.close();
      await app.close();
    },
  };
}

/**
 * Plain HTTP on port 80 only redirects to the HTTPS admin panel, so "localhost" or
 * "mail.company.local" typed into a browser works. If the port is taken (IIS, another
 * web server) PostMaster runs without it and logs where the panel is.
 */
async function startHttpRedirect(ctx: CoreContext, httpsPort: number): Promise<Server | null> {
  const httpPort = ctx.config.web.httpPort;
  if (!httpPort || httpPort === httpsPort) return null;
  const portPart = httpsPort === 443 ? '' : `:${httpsPort}`;
  const server = createServer((req, res) => {
    const host = (req.headers.host ?? ctx.config.hostname).replace(/:\d+$/, '').replace(/[^A-Za-z0-9.\-\[\]:]/g, '') || ctx.config.hostname;
    const path = (req.url ?? '/').startsWith('/') ? (req.url ?? '/') : '/';
    res.writeHead(301, { location: `https://${host}${portPart}${path}`, 'cache-control': 'no-store', 'content-type': 'text/plain' });
    res.end('The admin panel is on HTTPS.\n');
  });
  return new Promise((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => {
      ctx.log.warn({ port: httpPort, code: err.code }, `http port ${httpPort} not available (another web server?); open https://localhost${portPart}/ directly`);
      resolve(null);
    });
    server.listen(httpPort, ctx.config.listenHost, () => {
      ctx.log.info({ port: httpPort, to: httpsPort }, 'http redirect to the admin panel started');
      resolve(server);
    });
  });
}
