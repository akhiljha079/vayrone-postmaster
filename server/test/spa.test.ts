import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import type { FastifyInstance } from 'fastify';
import { buildConfig, createContext, type CoreContext } from '@vpm/core';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { buildApp } from '../src/app.js';
import { dbConfig } from './helpers.js';

const WEB_DIST = resolve(import.meta.dirname, '..', '..', 'web', 'dist');

describe.skipIf(!dbConfig() || !existsSync(join(WEB_DIST, 'index.html')))('serving the web SPA', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;

  beforeAll(async () => {
    const config = buildConfig({ db: dbConfig()!, dataPath: mkdtempSync(join(tmpdir(), 'vpm-spa-')), installId: 'spa', webRoot: WEB_DIST, web: { tls: false } });
    ctx = await createContext(config, { log: pino({ level: 'silent' }) });
    app = await buildApp(ctx);
  });
  afterAll(async () => {
    await app.close();
    await ctx.db.end();
  });

  it('serves index.html for client routes, assets as files, and 404 JSON for unknown API paths', async () => {
    for (const path of ['/', '/login', '/admin/users', '/mail']) {
      const r = await app.inject({ url: path });
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/html');
      expect(r.body).toContain('<div id="root">');
    }
    const asset = readdirSync(join(WEB_DIST, 'assets')).find((f) => f.endsWith('.js'))!;
    const a = await app.inject({ url: `/assets/${asset}` });
    expect(a.statusCode).toBe(200);
    expect(a.headers['content-type']).toContain('javascript');
    expect((await app.inject({ url: '/assets/missing.js' })).statusCode).toBe(404);
    const api = await app.inject({ url: '/api/nope' });
    expect(api.statusCode).toBe(404);
    expect(api.json().error).toBe('NOT_FOUND');
    expect(readdirSync(join(WEB_DIST, 'assets')).some((f) => f.endsWith('.map'))).toBe(false); // no source maps shipped
  });

  it('sends security headers', async () => {
    const r = await app.inject({ url: '/' });
    expect(r.headers['content-security-policy']).toContain("default-src 'self'");
    expect(r.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(r.headers['x-content-type-options']).toBe('nosniff');
  });
});
