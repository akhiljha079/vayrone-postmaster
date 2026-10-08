// Product REST API (called by PostMaster installs) and the public offline
// activation portal. No session; activation tokens authenticate heartbeats.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LsContext } from '../context.js';

export function productRoutes(ctx: LsContext) {
  return async (app: FastifyInstance) => {
    const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 hour' } } });
    app.post('/activate', limit(30), async (req) => ctx.licensing.activate(req.body, req.ip));
    app.post('/heartbeat', limit(120), async (req) => ctx.licensing.heartbeat(req.body, req.ip));
    app.post('/health', limit(60), async (req) => ctx.licensing.reportHealth(req.body, req.ip));
    app.post('/deactivate', limit(30), async (req) => ctx.licensing.deactivate(req.body, req.ip));
    // Customer self-service: upload the request file from an offline server, get the licence file.
    app.post('/offline', limit(20), async (req) => {
      const { request } = z.object({ request: z.string().min(50).max(100_000) }).parse(req.body);
      const r = await ctx.licensing.processOffline(request, { userId: null, resellerId: null, ip: req.ip });
      return { license: r.license, fileName: r.fileName, licenseId: r.licenseId, client: r.client };
    });
  };
}
