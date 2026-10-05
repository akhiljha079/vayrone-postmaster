import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pino } from 'pino';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { buildConfig, createContext, type ContextOptions, type CoreContext, type LicenseGate } from '@vpm/core';
import { dbConfig } from '../../core/test/helpers.js';
import { buildApp } from '../src/app.js';

export { dbConfig, uniqueDomain } from '../../core/test/helpers.js';

export async function makeServer(license?: LicenseGate | ContextOptions['licenseFactory']): Promise<{ ctx: CoreContext; app: FastifyInstance; close(): Promise<void> }> {
  const db = dbConfig()!;
  const config = buildConfig({
    db: { ...db, connectionLimit: 10 },
    dataPath: mkdtempSync(join(tmpdir(), 'vpm-web-')),
    hostname: 'mail.test.local',
    installId: 'webtest',
    web: { port: 0, tls: false },
  });
  const ctx = await createContext(config, { log: pino({ level: 'silent' }), ...(typeof license === 'function' ? { licenseFactory: license } : license ? { license } : {}) });
  const app = await buildApp(ctx);
  return {
    ctx,
    app,
    async close() {
      await app.close();
      await ctx.db.end();
    },
  };
}

/** Cookie-keeping API client over fastify.inject(). */
let nextHost = 1;

export class Client {
  cookies = new Map<string, string>();
  /** Each client is a different LAN machine (the login rate limit is per IP). */
  ip = `192.168.${100 + Math.floor(nextHost / 250)}.${(nextHost++ % 250) + 1}`;

  constructor(private readonly app: FastifyInstance) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, opts: { csrf?: boolean } = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (opts.csrf !== false && this.cookies.has('vpm_csrf')) headers['x-vpm-csrf'] = this.cookies.get('vpm_csrf')!;
    const res = await this.app.inject({ method, url, headers, remoteAddress: this.ip, ...(body !== undefined ? { payload: body as object } : {}) });
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }

  get = (url: string) => this.req('GET', url);
  post = (url: string, body: unknown = {}) => this.req('POST', url, body);
  put = (url: string, body: unknown) => this.req('PUT', url, body);
  patch = (url: string, body: unknown) => this.req('PATCH', url, body);
  del = (url: string) => this.req('DELETE', url);

  async login(login: string, password: string): Promise<LightMyRequestResponse> {
    this.cookies.clear();
    return this.post('/api/auth/login', { login, password });
  }
}
