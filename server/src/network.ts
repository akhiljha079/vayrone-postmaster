// Network and TLS settings, shared by the setup wizard and Admin → Network & TLS.
// Written to <data>/runtime.json; the services apply them after a restart.
import { existsSync, readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { describeCert, generateSelfSigned, installCertificate, readRuntimeOverrides, writeRuntimeOverrides, type CoreContext, type RuntimeOverrides } from '@vpm/core';
import { badRequest } from './http.js';

const Port = z.number().int().min(0).max(65535);

export const NetworkBody = z.object({
  hostname: z.string().trim().toLowerCase().min(1).max(253).regex(/^[a-z0-9.-]+$/, 'Use letters, digits, dots and dashes'),
  listenHost: z.string().trim().max(45),
  ports: z.object({ submission: Port, smtps: Port, imap: Port, imaps: Port, pop3: Port, pop3s: Port }),
  webPort: z.number().int().min(1).max(65535),
  tls: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('keep') }),
    z.object({ mode: z.literal('selfsigned') }),
    z.object({ mode: z.literal('upload'), cert: z.string().min(100).max(200_000), key: z.string().min(100).max(50_000) }),
  ]),
});
export type NetworkInput = z.infer<typeof NetworkBody>;

export function lanAddresses(): string[] {
  return Object.values(networkInterfaces())
    .flat()
    .filter((i): i is NonNullable<typeof i> => Boolean(i && !i.internal && i.family === 'IPv4'))
    .map((i) => i.address);
}

/** Current (saved) network settings and certificate. */
export function networkState(ctx: CoreContext) {
  const o = readRuntimeOverrides(ctx.config.dataPath);
  const certFile = o.tls?.certFile ?? ctx.config.tls.certFile ?? join(ctx.config.dataPath, 'certs', 'selfsigned.crt');
  return {
    hostname: o.hostname ?? ctx.config.hostname,
    listenHost: o.listenHost ?? ctx.config.listenHost,
    ports: { ...ctx.config.ports, ...o.ports },
    webPort: o.web?.port ?? ctx.config.web.port,
    addresses: lanAddresses(),
    tls: existsSync(certFile) ? { ...describeCert(readFileSync(certFile)), custom: Boolean(o.tls?.certFile ?? ctx.config.tls.certFile) } : null,
  };
}

/** Validates and saves; returns whether the running services must restart to apply it. */
export async function applyNetwork(ctx: CoreContext, b: NetworkInput): Promise<{ restartNeeded: boolean }> {
  if (!['0.0.0.0', '::'].includes(b.listenHost) && !isIP(b.listenHost)) throw badRequest('Listen address must be 0.0.0.0 (all addresses) or an IP address');
  if (!['0.0.0.0', '::', '127.0.0.1'].includes(b.listenHost) && !lanAddresses().includes(b.listenHost)) throw badRequest(`${b.listenHost} is not an address of this server`);
  const used = [...Object.values(b.ports), b.webPort, ctx.config.ipc.port].filter((p) => p > 0);
  const dup = used.find((p, i) => used.indexOf(p) !== i);
  if (dup) throw badRequest(`Port ${dup} is used twice`);
  let tls: RuntimeOverrides['tls'] | undefined;
  if (b.tls.mode === 'upload') {
    try {
      const r = await installCertificate(ctx.config.dataPath, b.tls.cert, b.tls.key);
      tls = { certFile: r.certFile, keyFile: r.keyFile };
    } catch (e) {
      throw badRequest((e as Error).message);
    }
  } else if (b.tls.mode === 'selfsigned') {
    await generateSelfSigned(ctx.config.dataPath, b.hostname, lanAddresses());
    tls = {};
  }
  writeRuntimeOverrides(ctx.config.dataPath, { hostname: b.hostname, listenHost: b.listenHost, ports: b.ports, web: { port: b.webPort }, ...(tls !== undefined ? { tls } : {}) });
  // Compared with what this process runs with: anything different needs a restart.
  const restartNeeded =
    b.tls.mode !== 'keep' ||
    b.hostname !== ctx.config.hostname ||
    b.listenHost !== ctx.config.listenHost ||
    b.webPort !== ctx.config.web.port ||
    (Object.keys(b.ports) as (keyof typeof b.ports)[]).some((k) => b.ports[k] !== ctx.config.ports[k]);
  return { restartNeeded };
}
