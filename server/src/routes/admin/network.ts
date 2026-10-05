// Admin → Network & TLS: ports, listen address, server name, certificate
// (renewal or replacement). Same rules as the setup wizard's network step;
// changes take effect after an automatic restart of the services.
import type { FastifyInstance } from 'fastify';
import { requestRestart, type CoreContext } from '@vpm/core';
import { audit, requireAdmin } from '../../guards.js';
import { applyNetwork, NetworkBody, networkState } from '../../network.js';

export function networkRoutes(ctx: CoreContext) {
  const read = requireAdmin(ctx, 'read');
  const owner = requireAdmin(ctx, 'super');
  return async (app: FastifyInstance) => {
    app.get('/network', { preHandler: read }, async () => networkState(ctx));

    app.put('/network', { preHandler: owner, bodyLimit: 1024 * 1024 }, async (req) => {
      const b = NetworkBody.parse(req.body);
      const { restartNeeded } = await applyNetwork(ctx, b);
      await audit(ctx, req, 'network.update', 'settings', 'network', { hostname: b.hostname, listenHost: b.listenHost, ports: b.ports, webPort: b.webPort, tls: b.tls.mode });
      const scheme = ctx.config.web.tls ? 'https' : 'http';
      const url = `${scheme}://${b.hostname}${(scheme === 'https' && b.webPort === 443) || (scheme === 'http' && b.webPort === 80) ? '' : `:${b.webPort}`}/admin/network`;
      if (restartNeeded) setTimeout(() => void requestRestart(ctx.db, 'network settings changed').catch(() => undefined), 1500).unref();
      return { ok: true, restart: restartNeeded, url };
    });
  };
}
