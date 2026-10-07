import { describe, expect, it } from 'vitest';
import { get } from 'node:http';
import { createServer } from 'node:net';
import { makeServer, dbConfig } from './helpers.js';
import { startWeb } from '../src/service.js';

const freePort = () =>
  new Promise<number>((resolve) => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
  });

describe.skipIf(!dbConfig())('plain-HTTP redirect to the admin panel', () => {
  it('typing http://localhost (or the server name) lands on the HTTPS admin panel', async () => {
    const { ctx, close } = await makeServer();
    const [https, http] = [await freePort(), await freePort()];
    ctx.config.listenHost = '127.0.0.1';
    ctx.config.web = { ...ctx.config.web, tls: true, port: https, httpPort: http };
    const web = await startWeb(ctx, null);
    try {
      const res = await new Promise<{ status?: number; location?: string }>((resolve, reject) =>
        get({ host: '127.0.0.1', port: http, path: '/setup?token=abc', headers: { host: 'mail.agrasteel.local' } }, (r) => {
          r.resume();
          resolve({ status: r.statusCode, location: r.headers.location });
        }).on('error', reject),
      );
      expect(res).toEqual({ status: 301, location: `https://mail.agrasteel.local:${https}/setup?token=abc` });
    } finally {
      await web.stop();
      await close();
    }
  });
});
