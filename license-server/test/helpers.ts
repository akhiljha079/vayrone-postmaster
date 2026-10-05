import { randomBytes } from 'node:crypto';
import { inject } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { generateSigningKey } from '@vpm/license-client/format';
import { buildLsConfig } from '../src/config.js';
import { createPool, exec } from '../src/db.js';
import { hashPassword, Vault } from '../src/crypto.js';
import { Signer } from '../src/signer.js';
import { Licensing } from '../src/services/licensing.js';
import { Notifier } from '../src/services/notify.js';
import { buildApp } from '../src/app.js';
import type { LsContext } from '../src/context.js';

export const lsdb = () => inject('lsdb');
export const KID = 'vy-test-1';

export interface SentMail {
  to: string;
  cc?: string;
  subject: string;
  text: string;
}

export async function makeLs(): Promise<{ ctx: LsContext; app: FastifyInstance; publicKey: string; mails: SentMail[]; whatsapp: { url: string; body: unknown }[]; close(): Promise<void> }> {
  const key = generateSigningKey();
  const config = buildLsConfig({ db: { ...lsdb()!, connectionLimit: 10 }, signingKeyFile: '-', signingKeyId: KID, secretKeyFile: '-', insecureCookies: true, migrationsPath: 'db' });
  const db = createPool(config.db);
  const signer = Signer.fromPem(key.privateKey, KID);
  const vault = new Vault(randomBytes(32));
  const mails: SentMail[] = [];
  const whatsapp: { url: string; body: unknown }[] = [];
  const mailer = { sendMail: async (m: SentMail) => void mails.push(m) } as never;
  const fetchStub = (async (url: string, init: RequestInit) => {
    whatsapp.push({ url: String(url), body: JSON.parse(String(init.body)) });
    return new Response('{"messages":[{"id":"wamid.1"}]}', { status: 200 });
  }) as typeof fetch;
  const notifier = new Notifier(db, vault, { mailer, fetch: fetchStub });
  const ctx: LsContext = { config, db, signer, vault, notifier, licensing: new Licensing(db, signer) };
  const app = await buildApp(ctx);
  return {
    ctx,
    app,
    publicKey: key.publicKey,
    mails,
    whatsapp,
    async close() {
      await app.close();
      await db.end();
    },
  };
}

export async function addStaff(ctx: LsContext, email: string, role: 'owner' | 'staff' | 'reseller', resellerId: number | null = null, password = 'Owner#Passw0rd'): Promise<number> {
  const r = await exec(ctx.db, 'INSERT INTO staff_users (email, name, password_hash, role, reseller_id, created_at) VALUES (?,?,?,?,?,?)', [email, email.split('@')[0], await hashPassword(password), role, resellerId, new Date()]);
  return r.insertId;
}

let nextIp = 1;

/** Cookie-keeping admin client over fastify.inject(). */
export class Client {
  cookies = new Map<string, string>();
  ip = `203.0.113.${nextIp++}`;
  constructor(private readonly app: FastifyInstance) {}

  async req(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', url: string, body?: unknown, opts: { csrf?: boolean } = {}): Promise<LightMyRequestResponse> {
    const headers: Record<string, string> = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (opts.csrf !== false && this.cookies.has('vls_csrf')) headers['x-vls-csrf'] = this.cookies.get('vls_csrf')!;
    const res = await this.app.inject({ method, url, headers, remoteAddress: this.ip, ...(body !== undefined ? { payload: body as object } : {}) });
    for (const c of res.cookies as { name: string; value: string; expires?: Date }[]) {
      if (!c.value || (c.expires && c.expires.getTime() < Date.now())) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    return res;
  }
  get = (u: string) => this.req('GET', u);
  post = (u: string, b: unknown = {}) => this.req('POST', u, b);
  put = (u: string, b: unknown) => this.req('PUT', u, b);
  patch = (u: string, b: unknown) => this.req('PATCH', u, b);
  async login(email: string, password = 'Owner#Passw0rd'): Promise<LightMyRequestResponse> {
    this.cookies.clear();
    return this.post('/api/auth/login', { email, password });
  }
}

/** fetch() for the product's LicenseManager, routed into the License Server app. */
export function productFetch(app: FastifyInstance, ip = '198.51.100.7'): typeof fetch {
  return (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const res = await app.inject({ method: 'POST', url: u.pathname, headers: { 'content-type': 'application/json' }, payload: String(init?.body ?? '{}'), remoteAddress: ip });
    return new Response(res.body, { status: res.statusCode, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}
