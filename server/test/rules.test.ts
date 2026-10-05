import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db as dbm, type CoreContext } from '@vpm/core';
import type { FastifyInstance } from 'fastify';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const { one } = dbm;
const PW = 'Passw0rd#1';

describe.skipIf(!dbConfig())('rules, forwarding, out-of-office and journaling APIs', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let admin: Client;
  let user: Client;
  let userId: number;
  let otherId: number;
  const domain = uniqueDomain();

  const rule = (o: Record<string, unknown> = {}) => ({
    name: 'Invoices',
    conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }],
    actions: [{ type: 'move', folder: 'Invoices' }],
    ...o,
  });

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    await ctx.directory.createDomain(domain);
    await ctx.directory.createUser({ email: `boss@${domain}`, password: PW, role: 'super_admin' });
    userId = await ctx.directory.createUser({ email: `meera@${domain}`, password: PW });
    otherId = await ctx.directory.createUser({ email: `vikram@${domain}`, password: PW });
    admin = new Client(app);
    await admin.login(`boss@${domain}`, PW);
    user = new Client(app);
    await user.login(`meera@${domain}`, PW);
  });
  afterAll(() => close());

  it('admin manages global rules with validation and drag-and-drop ordering', async () => {
    const a = (await admin.post('/api/admin/rules', rule())).json().id;
    const b = (await admin.post('/api/admin/rules', rule({ name: 'Tag outgoing', stage: 'outbound', actions: [{ type: 'add_header', name: 'X-Tag', value: '1' }] }))).json().id;
    expect((await admin.post('/api/admin/rules', rule({ stage: 'outbound' }))).json().message).toMatch(/not available for outgoing/);
    expect((await admin.post('/api/admin/rules', rule({ conditions: [{ field: 'subject', op: 'regex', value: '(a+)+' }] }))).statusCode).toBe(400);
    const list = (await admin.get('/api/admin/rules')).json() as { id: number; position: number }[];
    expect(list.map((r) => r.id)).toEqual([a, b]);
    expect((await admin.put('/api/admin/rules-order', { ids: [b] })).statusCode).toBe(400); // must list all
    await admin.put('/api/admin/rules-order', { ids: [b, a] });
    expect(((await admin.get('/api/admin/rules')).json() as { id: number }[]).map((r) => r.id)).toEqual([b, a]);
    await admin.put(`/api/admin/rules/${a}`, rule({ name: 'Invoices v2' }));
    await admin.post(`/api/admin/rules/${a}/enabled`, { enabled: false });
    const after = ((await admin.get('/api/admin/rules')).json() as { id: number; name: string; isEnabled: boolean }[]).find((r) => r.id === a)!;
    expect(after).toMatchObject({ name: 'Invoices v2', isEnabled: false });
    expect(await one(ctx.db, "SELECT id FROM audit_log WHERE action = 'rule.reorder'")).toBeTruthy();
  });

  it('users manage only their own inbound rules', async () => {
    const mine = (await user.post('/api/mail/rules', rule())).json().id;
    expect((await user.post('/api/mail/rules', rule({ stage: 'outbound', actions: [{ type: 'discard' }] }))).json().message).toMatch(/incoming mail only/);
    const theirs = (await admin.post(`/api/admin/rules?userId=${otherId}`, rule())).json().id;
    expect((await user.del(`/api/mail/rules/${theirs}`)).statusCode).toBe(404);
    expect((await user.put(`/api/mail/rules/${theirs}`, rule())).statusCode).toBe(404);
    expect(((await user.get('/api/mail/rules')).json() as { id: number }[]).map((r) => r.id)).toEqual([mine]);
    expect(((await admin.get(`/api/admin/rules?userId=${userId}`)).json() as { id: number }[]).map((r) => r.id)).toEqual([mine]);
    expect((await user.get('/api/admin/rules')).statusCode).toBe(403);
  });

  it('external forwarding by employees follows the company policy; admins may always set it', async () => {
    const ext = { targets: [{ address: 'me@gmail.test', keepLocalCopy: true }] };
    const r = await user.put('/api/mail/forwarding', ext);
    expect(r.statusCode).toBe(403);
    expect(r.json().error).toBe('EXTERNAL_FORWARD_DISABLED');
    expect((await user.post('/api/mail/rules', rule({ actions: [{ type: 'forward', to: ['me@gmail.test'] }] }))).statusCode).toBe(403);
    expect((await user.put('/api/mail/forwarding', { targets: [{ address: `vikram@${domain}` }] })).statusCode).toBe(200); // internal is fine
    expect((await user.put('/api/mail/forwarding', { targets: [{ address: `meera@${domain}` }] })).statusCode).toBe(400); // self
    expect((await admin.put(`/api/admin/users/${userId}/forwarding`, ext)).statusCode).toBe(200);

    expect((await user.get('/api/mail/policy')).json()).toEqual({ allowExternalForwarding: false });
    await admin.put('/api/admin/mail-policy', { allowUserExternalForwarding: true });
    ctx.settings.invalidate();
    expect((await user.put('/api/mail/forwarding', ext)).statusCode).toBe(200);
    expect((await user.get('/api/mail/forwarding')).json()).toEqual([{ address: 'me@gmail.test', keepLocalCopy: true, isEnabled: true }]);
    const policy = (await admin.get('/api/admin/mail-policy')).json();
    expect(policy).toMatchObject({ allowUserExternalForwarding: true, rewriteFromOnExternalForward: true, timezone: 'Asia/Kolkata' });
    expect((await admin.put('/api/admin/mail-policy', { timezone: 'Mars/Olympus' })).statusCode).toBe(400);
    await admin.put('/api/admin/mail-policy', { allowUserExternalForwarding: false });
    expect(await one(ctx.db, "SELECT id FROM audit_log WHERE action = 'user.forwarding_set' AND actor_login = ?", [`meera@${domain}`])).toBeTruthy();
  });

  it('out of office settings', async () => {
    expect((await user.get('/api/mail/autoreply')).json()).toMatchObject({ isEnabled: false });
    expect((await user.put('/api/mail/autoreply', { isEnabled: true, subject: 'Away', bodyText: 'Back soon', startsAt: '2026-10-10', endsAt: '2026-10-01' })).statusCode).toBe(400);
    expect((await user.put('/api/mail/autoreply', { isEnabled: true, subject: 'Away: {subject}', bodyText: 'Back on Monday', internalOnly: true })).statusCode).toBe(200);
    expect((await admin.get(`/api/admin/users/${userId}/autoreply`)).json()).toMatchObject({ isEnabled: true, subject: 'Away: {subject}', internalOnly: true, oncePerDays: 4 });
  });

  it('rule tester explains which conditions match', async () => {
    const r = await admin.post('/api/admin/rules/test', {
      rule: rule({ matchMode: 'all', conditions: [{ field: 'subject', op: 'contains', value: 'invoice' }, { field: 'from', op: 'domain_is', value: 'vendor.test' }] }),
      sample: { from: 'Accounts <billing@vendor.test>', subject: 'Invoice 12' },
    });
    expect(r.json()).toMatchObject({ matched: true, plan: { folder: 'Invoices' } });
    expect(r.json().conditions.map((c: { matched: boolean }) => c.matched)).toEqual([true, true]);
    const miss = await admin.post('/api/admin/rules/test', { rule: rule(), sample: { subject: 'Lunch' } });
    expect(miss.json().matched).toBe(false);
  });

  it('journal rules: scope validation and partial updates', async () => {
    expect((await admin.post('/api/admin/journal-rules', { name: 'x', scope: 'group', targetAddress: 'vault@archive.test' })).statusCode).toBe(400);
    const g = await ctx.db.query('INSERT INTO user_groups (name, created_at) VALUES (?, ?)', [`Legal ${domain}`, new Date()]);
    const groupId = (g[0] as { insertId: number }).insertId;
    const j = await admin.post('/api/admin/journal-rules', {
      name: 'Legal team',
      direction: 'both',
      scope: 'group',
      scopeId: groupId,
      targetAddress: 'vault@archive.test',
      conditions: [{ field: 'has_attachment', op: 'is', value: true }],
    });
    expect(j.statusCode).toBe(200);
    await admin.patch(`/api/admin/journal-rules/${j.json().id}`, { isEnabled: false });
    const list = (await admin.get('/api/admin/journal-rules')).json() as Record<string, unknown>[];
    expect(list.find((x) => x.id === j.json().id)).toMatchObject({ isEnabled: false, scope: 'group', direction: 'both', conditions: [{ field: 'has_attachment' }] });
    expect((await user.get('/api/admin/journal-rules')).statusCode).toBe(403);
  });
});
