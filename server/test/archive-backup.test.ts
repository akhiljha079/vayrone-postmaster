import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db as dbm, indexPending, type CoreContext } from '@vpm/core';
import type { FastifyInstance } from 'fastify';
import { Client, dbConfig, makeServer, uniqueDomain } from './helpers.js';
import { JobRunner } from '../../worker/src/jobs.js';
import { jobHandlers } from '../../worker/src/scheduler.js';

const { exec, one } = dbm;
const PW = 'Passw0rd#1';

describe.skipIf(!dbConfig())('archive and backup admin APIs', () => {
  let ctx: CoreContext;
  let app: FastifyInstance;
  let close: () => Promise<void>;
  let boss: Client;
  let auditor: Client;
  let deputy: Client;
  let alice: number;
  const domain = uniqueDomain();
  const nas = mkdtempSync(join(tmpdir(), 'vpm-api-nas-'));

  const deliver = async (userId: number, subject: string, body: string) => {
    const message = await ctx.store.ingest(Buffer.from(`From: Vendor <sales@vendor.test>\r\nTo: alice@${domain}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random()}@vendor.test>\r\n\r\n${body}\r\n`));
    await ctx.mailflow.inbound({ message, recipients: [{ userId }], origin: 'fetch', direction: 'in', envelopeFrom: 'sales@vendor.test' });
  };

  beforeAll(async () => {
    ({ ctx, app, close } = await makeServer());
    await ctx.directory.createDomain(domain);
    await ctx.directory.createUser({ email: `boss@${domain}`, password: PW, role: 'super_admin' });
    await ctx.directory.createUser({ email: `deputy@${domain}`, password: PW, role: 'admin' });
    alice = await ctx.directory.createUser({ email: `alice@${domain}`, password: PW });
    await ctx.directory.createStaffUser({ login: `auditor-${domain}`, password: PW, displayName: 'Auditor', role: 'auditor' });
    await deliver(alice, 'Quotation for steel pipes', 'Unit price 4500 per tonne, delivery Agra warehouse');
    await deliver(alice, 'Lunch', 'See you at noon');
    while ((await indexPending(ctx.db, ctx.blobs, 200)) > 0);
    boss = new Client(app);
    await boss.login(`boss@${domain}`, PW);
    auditor = new Client(app);
    await auditor.login(`auditor-${domain}`, PW);
    deputy = new Client(app);
    await deputy.login(`deputy@${domain}`, PW);
  });
  afterAll(() => close());

  it('auditors search the archive by full text and filters; every access is audited', async () => {
    const r = (await auditor.get(`/api/admin/archive/search?q=tonne%20warehouse&userId=${alice}&direction=in`)).json();
    expect(r.items.map((i: { subject: string }) => i.subject)).toEqual(['Quotation for steel pipes']);
    expect(r.items[0].envelopeRcpts).toEqual([`alice@${domain}`]);
    const view = (await auditor.get(`/api/admin/archive/items/${r.items[0].id}`)).json();
    expect(view).toMatchObject({ subject: 'Quotation for steel pipes', direction: 'in', users: [`alice@${domain}`], legalHold: false });
    expect(view.html).toContain('Unit price 4500');
    const logged = await one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM audit_log WHERE actor_login = ? AND action IN ('archive.search','archive.view')", [`auditor-${domain}`]);
    expect(Number(logged!.n)).toBeGreaterThanOrEqual(2);
    expect((await auditor.post(`/api/admin/archive/items/${r.items[0].id}/restore`, { userId: alice })).statusCode).toBe(403); // read-only
    expect((await deputy.post(`/api/admin/archive/items/${r.items[0].id}/legal-hold`, { hold: true })).statusCode).toBe(403); // super only
  });

  it('exports MBOX and ZIP, and records the export', async () => {
    const mbox = await auditor.post('/api/admin/archive/export', { format: 'mbox', criteria: { userId: alice } });
    expect(mbox.headers['content-type']).toContain('application/mbox');
    expect(mbox.body).toMatch(/^From sales@vendor\.test /);
    expect(mbox.body.match(/^From /gm)).toHaveLength(2);
    expect(mbox.body).not.toContain('\r\n');
    const zip = await auditor.post('/api/admin/archive/export', { format: 'eml_zip', criteria: { q: 'quotation' } });
    expect(zip.rawPayload.subarray(0, 2).toString()).toBe('PK');
    expect(zip.rawPayload.toString('latin1')).toContain('Quotation for steel pipes.eml');
    const ex = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM archive_exports');
    expect(Number(ex!.n)).toBeGreaterThanOrEqual(2);
  });

  it('mailbox view: one folder per address with Received and Sent; ZIP keeps that structure', async () => {
    // Alice also sent something (archived as sent by her).
    const sent = await ctx.store.ingest(Buffer.from(`From: alice@${domain}\r\nTo: buyer@outside.test\r\nSubject: Purchase order 12\r\nMessage-ID: <po12@${domain}>\r\n\r\nPO attached\r\n`));
    await ctx.mailflow.archiver!.archive({ messageId: sent.id, size: sent.size, subject: 'Purchase order 12', date: new Date(), direction: 'out', envelopeFrom: `alice@${domain}`, envelopeTo: ['buyer@outside.test'], recipientUserIds: [], senderUserIds: [alice] });
    const list = (await auditor.get(`/api/admin/archive/mailboxes?q=alice@${domain}`)).json();
    expect(list.items).toEqual([expect.objectContaining({ userId: alice, address: `alice@${domain}`, deleted: false, received: 2, sent: 1 })]);
    const inSent = (await auditor.get(`/api/admin/archive/search?userId=${alice}&role=sent`)).json();
    expect(inSent.items.map((i: { subject: string }) => i.subject)).toEqual(['Purchase order 12']);
    const inReceived = (await auditor.get(`/api/admin/archive/search?userId=${alice}&role=received`)).json();
    expect(inReceived.total).toBe(2);

    const zip = await auditor.post('/api/admin/archive/export', { format: 'eml_zip', layout: 'mailboxes', userIds: [alice] });
    expect(zip.headers['content-disposition']).toContain(`archive-alice@${domain}-`);
    const names = zip.rawPayload.toString('latin1');
    expect(names).toMatch(new RegExp(`alice@${domain.replace(/\./g, '\\.')}/Received/\\d{4}-\\d\\d-\\d\\d \\d{4} - Quotation for steel pipes \\[\\d+\\]\\.eml`));
    expect(names).toContain(`alice@${domain}/Sent/`);
    expect(names).toContain('Purchase order 12');
  });

  it('admins restore archived mail into a mailbox; super admins set legal hold', async () => {
    const id = (await boss.get('/api/admin/archive/search?q=lunch')).json().items[0].id;
    expect((await deputy.post(`/api/admin/archive/items/${id}/restore`, { userId: alice })).json()).toEqual({ ok: true, folder: 'Restored from archive' });
    expect((await ctx.store.getFolder(alice, 'Restored from archive'))!.message_count).toBe(1);
    await boss.post(`/api/admin/archive/items/${id}/legal-hold`, { hold: true });
    expect((await boss.get(`/api/admin/archive/search?legalHold=1`)).json().items.map((i: { id: number }) => i.id)).toEqual([id]);
  });

  it('webmail searches message bodies and across all folders', async () => {
    const a = new Client(app);
    await a.login(`alice@${domain}`, PW);
    const inbox = (await ctx.store.getSpecialFolder(alice, 'inbox'))!;
    expect((await a.get(`/api/mail/folders/${inbox.id}/messages?q=warehouse`)).json().items.map((m: { subject: string }) => m.subject)).toEqual(['Quotation for steel pipes']);
    const all = (await a.get('/api/mail/search?q=noon')).json().items;
    expect(all.map((m: { folderPath: string }) => m.folderPath).sort()).toEqual(['INBOX', 'Restored from archive']);
  });

  it('retention policies are validated and super-admin only', async () => {
    expect((await deputy.post('/api/admin/retention-policies', { name: 'x', target: 'archive', keepDays: 30 })).statusCode).toBe(403);
    expect((await boss.post('/api/admin/retention-policies', { name: 'Trash', target: 'mailbox_folder', keepDays: 30 })).statusCode).toBe(400);
    const r = await boss.post('/api/admin/retention-policies', { name: 'Trash 30 days', target: 'mailbox_folder', specialUse: 'trash', keepDays: 30 });
    expect(r.statusCode).toBe(200);
    await boss.patch(`/api/admin/retention-policies/${r.json().id}`, { keepDays: 45 });
    expect((await boss.get('/api/admin/retention-policies')).json().find((p: { id: number }) => p.id === r.json().id)).toMatchObject({ keepDays: 45, specialUse: 'trash' });
  });

  it('backup targets, schedules, "back up now", contents and restore — end to end through the worker', async () => {
    expect((await deputy.post('/api/admin/backup/targets', { name: 'NAS', kind: 'smb', path: nas })).statusCode).toBe(403);
    const t = (await boss.post('/api/admin/backup/targets', { name: 'Office NAS', kind: 'smb', path: nas })).json().id;
    expect((await boss.post(`/api/admin/backup/targets/${t}/check`)).json()).toMatchObject({ ok: true });
    expect((await boss.post('/api/admin/backup/schedules', { name: 'x', targetId: t, kind: 'full', cron: 'every night' })).statusCode).toBe(400);
    const s = await boss.post('/api/admin/backup/schedules', { name: 'Nightly', targetId: t, kind: 'incremental', cron: '0 1 * * *', keepFull: 3 });
    expect((await boss.get('/api/admin/backup/schedules')).json().find((x: { id: number }) => x.id === s.json().id).nextRun).toBeTruthy();

    const runner = new JobRunner(ctx, jobHandlers(ctx));
    const { jobId } = (await deputy.post('/api/admin/backup/run', { targetId: t, kind: 'full' })).json();
    await runner.tick();
    expect((await boss.get(`/api/admin/jobs/${jobId}`)).json().status).toBe('done');
    const run = (await boss.get(`/api/admin/backup/runs?targetId=${t}`)).json()[0];
    expect(run).toMatchObject({ status: 'verified', kind: 'full', progress: 100 });

    const contents = (await boss.get(`/api/admin/backup/runs/${run.id}/contents`)).json();
    const a = contents.users.find((u: { login: string }) => u.login === `alice@${domain}`);
    expect(a).toMatchObject({ existsNow: true });
    expect(a.folders.find((f: { path: string }) => f.path === 'INBOX').messages).toBe(2);

    // Alice empties her inbox by mistake; the admin restores it.
    const inbox = (await ctx.store.getSpecialFolder(alice, 'inbox'))!;
    await ctx.store.storeFlags(inbox.id, await ctx.store.listUids(inbox.id), 'add', 8, null);
    await ctx.store.expunge(inbox.id);
    const req = (await deputy.post('/api/admin/backup/restore', { backupRunId: run.id, sourceUserId: alice, folderPath: 'INBOX' })).json();
    await runner.tick();
    const restores = (await boss.get('/api/admin/backup/restores')).json();
    expect(restores.find((r: { id: number }) => r.id === req.restoreRunId)).toMatchObject({ status: 'ok', itemsRestored: 2, scope: 'folder' });
    expect((await ctx.store.getFolderById(inbox.id))!.message_count).toBe(2);
    expect(await one(ctx.db, "SELECT id FROM audit_log WHERE action = 'backup.restore_request'")).toBeTruthy();
    await exec(ctx.db, 'UPDATE backup_schedules SET is_enabled = 0');
    await runner.stop();
  });
});
