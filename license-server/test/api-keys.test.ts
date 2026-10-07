// API keys and the website integration client (integrations/nextjs/lib/vayrone-license.ts).
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { LsContext } from '../src/context.js';
import { one } from '../src/db.js';
import { createVlsClient, VlsError } from '../integrations/nextjs/lib/vayrone-license.js';
import { addStaff, Client, lsdb, makeLs } from './helpers.js';

describe.skipIf(!lsdb() || !inject('db'))('API keys for the website admin panel', () => {
  let ctx: LsContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let owner: Client;
  let base: string;
  let planId: number;

  beforeAll(async () => {
    ({ ctx, app, close } = await makeLs());
    await addStaff(ctx, 'boss@vayrone.com', 'owner');
    owner = new Client(app);
    expect((await owner.login('boss@vayrone.com')).statusCode).toBe(200);
    planId = (
      await owner.post('/api/plans', { code: `web${Date.now() % 100000}`, name: 'Business (web)', features: ['archive', 'antivirus'], maxExternalAccounts: null, minUsers: 5, slabs: [{ upTo: null, pricePerUser: 1000 }], termMonths: 12, amcPct: 0 })
    ).json().id;
    await app.listen({ host: '127.0.0.1', port: 0 });
    base = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;
  });
  afterAll(() => close());

  it('owner creates a key (shown once, stored hashed); the website issues a licence for N users with it', async () => {
    const created = (await owner.post('/api/api-keys', { name: 'Website admin panel' })).json();
    expect(created.key).toMatch(/^vls_[A-Za-z0-9_-]{43}$/);
    const stored = await one<{ key_hash: string; prefix: string }>(ctx.db, 'SELECT key_hash, prefix FROM api_keys WHERE id = ?', [created.id]);
    expect(stored!.key_hash).not.toContain(created.key);
    expect(created.key.startsWith(stored!.prefix)).toBe(true);
    const listed = (await owner.get('/api/api-keys')).json();
    expect(JSON.stringify(listed)).not.toContain(created.key);

    const vls = createVlsClient({ baseUrl: base, apiKey: created.key });
    const plans = await vls.plans();
    expect(plans.find((p) => p.id === planId)).toMatchObject({ name: 'Business (web)', minUsers: 5 });
    const company = `Mathura Cement Works ${Date.now()}`;
    const { id: clientId } = await vls.createClient({ company, email: 'it@mathuracement.test', city: 'Mathura', gstin: '09ABCDE1234F1Z5' });
    const lic = await vls.createLicense({ clientId, planId, maxUsers: 50, amount: 50000, invoiceRef: 'VI/26-27/101' });
    expect(lic.licenseKey).toMatch(/^VPM-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]$/);
    // More users later (upgrade), renewal, and the full picture.
    await vls.updateLicense(lic.id, { maxUsers: 75, amount: 25000, invoiceRef: 'VI/26-27/140' });
    await vls.renewLicense(lic.id, { kind: 'renewal', months: 12, amount: 75000 });
    const d = await vls.getLicense(lic.id);
    expect(d).toMatchObject({ licenseKey: lic.licenseKey, maxUsers: 75, status: 'active', client: { company }, plan: { name: 'Business (web)' } });
    expect(d.renewals.map((r) => r.kind).sort()).toEqual(['new', 'renewal', 'upgrade']);
    expect((await vls.listLicenses({ q: company })).items.map((l) => l.licenseId)).toEqual([lic.licenseId]);
    // History shows the key as the actor.
    const ev = (await owner.get(`/api/licenses/${lic.id}`)).json().events;
    expect(ev.length).toBeGreaterThan(0);
    expect(Number((await one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM api_keys WHERE id = ? AND last_used_at IS NOT NULL", [created.id]))!.n)).toBe(1);
  });

  it('a key cannot do owner things, cannot sign in or change passwords, and stops working when revoked', async () => {
    const { id, key } = (await owner.post('/api/api-keys', { name: 'Temp' })).json();
    const vls = createVlsClient({ baseUrl: base, apiKey: key });
    const raw = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    expect((await raw('GET', '/api/settings')).status).toBe(403);
    expect((await raw('POST', '/api/api-keys', { name: 'escalate' })).status).toBe(403);
    expect((await raw('POST', '/api/plans', { code: 'x', name: 'x' })).status).toBe(403);
    expect((await raw('POST', '/api/auth/password', { current: 'x', password: 'Hacked#Passw0rd1' })).status).toBe(401);
    expect((await raw('GET', '/api/auth/me')).status).toBe(401);

    expect((await owner.del(`/api/api-keys/${id}`)).statusCode).toBe(200);
    await expect(vls.plans()).rejects.toMatchObject({ status: 401 });
    await expect(createVlsClient({ baseUrl: base, apiKey: 'vls_' + 'x'.repeat(43) }).plans()).rejects.toBeInstanceOf(VlsError);
    expect(() => createVlsClient({ baseUrl: base, apiKey: 'not-a-key' })).toThrow(/malformed/);
  });
});
