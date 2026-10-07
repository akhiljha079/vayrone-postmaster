// Admin → Easy rules: the exact payloads the page sends, checked against real mail flow.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { db as dbm, type CoreContext } from '@vpm/core';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';

const { exec, rows } = dbm;
const PW = 'Passw0rd#1';

describe.skipIf(!dbConfig())('easy rules', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let admin: Client;
  const d = uniqueDomain();
  let rahul: number;
  let priya: number;
  let manager: number;

  const subjectsIn = async (userId: number) =>
    (await rows<{ s: string }>(ctx.db, "SELECT m.hdr_subject s FROM mail_items i JOIN messages m ON m.id = i.message_id JOIN folders f ON f.id = i.folder_id WHERE i.user_id = ? AND f.special_use = 'inbox' ORDER BY i.id", [userId])).map((r) => r.s);
  const raw = (from: string, to: string, subject: string) => Buffer.from(`From: ${from}\r\nTo: ${to}\r\nSubject: ${subject}\r\nMessage-ID: <${randomBytes(6).toString('hex')}@t.test>\r\n\r\nHello\r\n`);
  const receive = async (userId: number, from: string, subject: string) => {
    const message = await ctx.store.ingest(raw(from, 'x@x', subject));
    await ctx.mailflow.inbound({ message, recipients: [{ userId }], origin: 'fetch', direction: 'in', envelopeFrom: from });
  };
  const send = async (userId: number, from: string, to: string, subject: string) => {
    const message = await ctx.store.ingest(raw(from, to, subject));
    const r = await ctx.mailflow.submission({ message, envelopeFrom: from, senderUserId: userId, localUserIds: [], external: [to] });
    expect(r.rejected).toBeNull();
  };

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    await ctx.directory.createDomain(d);
    await ctx.directory.createUser({ email: `boss@${d}`, password: PW, role: 'super_admin' });
    rahul = await ctx.directory.createUser({ email: `rahul@${d}`, password: PW });
    priya = await ctx.directory.createUser({ email: `priya@${d}`, password: PW });
    manager = await ctx.directory.createUser({ email: `manager@${d}`, password: PW });
    admin = new Client(app);
    await admin.login(`boss@${d}`, PW);
  });
  afterAll(async () => {
    await exec(ctx.db, 'DELETE FROM journal_rules WHERE target_address = ?', [`manager@${d}`]);
    await close();
  });

  it('"Copy all mail of a person": everything Rahul sends and receives reaches the manager', async () => {
    const r = await admin.post('/api/admin/journal-rules', { name: 'Copy all mail of a person: Rahul', direction: 'both', scope: 'user', scopeId: rahul, includeInternal: true, matchMode: 'all', conditions: [], targetAddress: `manager@${d}`, isEnabled: true });
    expect(r.statusCode).toBe(200);
    await receive(rahul, 'client@outside.test', 'Rahul in 1');
    await send(rahul, `rahul@${d}`, 'buyer@outside.test', 'Rahul out 1');
    await receive(priya, 'client@outside.test', 'Priya in 1'); // not Rahul: no copy
    expect(await subjectsIn(manager)).toEqual(['Rahul in 1', 'Rahul out 1']);
    await admin.del(`/api/admin/journal-rules/${r.json().id}`);
  });

  it('"Copy mail from a sender" (@company) and "to or from an address" (two rules)', async () => {
    await exec(ctx.db, 'DELETE FROM mail_items WHERE user_id = ?', [manager]);
    const a = await admin.post('/api/admin/journal-rules', { name: 'from bigclient', direction: 'in', scope: 'all', scopeId: null, includeInternal: true, matchMode: 'all', conditions: [{ field: 'from', op: 'domain_is', value: 'bigclient.test' }], targetAddress: `manager@${d}`, isEnabled: true });
    const out = await admin.post('/api/admin/journal-rules', { name: 'to sharma', direction: 'out', scope: 'all', scopeId: null, includeInternal: true, matchMode: 'all', conditions: [{ field: 'to_or_cc', op: 'contains', value: 'orders@sharma.test' }], targetAddress: `manager@${d}`, isEnabled: true });
    const inn = await admin.post('/api/admin/journal-rules', { name: 'from sharma', direction: 'in', scope: 'all', scopeId: null, includeInternal: true, matchMode: 'all', conditions: [{ field: 'from', op: 'contains', value: 'orders@sharma.test' }], targetAddress: `manager@${d}`, isEnabled: true });
    await receive(priya, 'ceo@bigclient.test', 'Big client order');
    await receive(priya, 'someone@other.test', 'Unrelated');
    await send(rahul, `rahul@${d}`, 'orders@sharma.test', 'Quote to Sharma');
    await receive(priya, 'orders@sharma.test', 'Reply from Sharma');
    expect(await subjectsIn(manager)).toEqual(['Big client order', 'Quote to Sharma', 'Reply from Sharma']);
    for (const r of [a, out, inn]) await admin.del(`/api/admin/journal-rules/${r.json().id}`);
  });

  it('"Forward a person\'s mail" shows up in the forwarding list used by the page', async () => {
    expect((await admin.put(`/api/admin/users/${priya}/forwarding`, { targets: [{ address: `rahul@${d}`, keepLocalCopy: true, isEnabled: true }] })).statusCode).toBe(200);
    const list = (await admin.get('/api/admin/forwardings')).json();
    expect(list).toEqual(expect.arrayContaining([{ userId: priya, login: `priya@${d}`, name: expect.any(String), address: `rahul@${d}`, keepLocalCopy: true, isEnabled: true }]));
    await admin.put(`/api/admin/users/${priya}/forwarding`, { targets: [] });
  });
});
