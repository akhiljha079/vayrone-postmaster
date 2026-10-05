import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { db as dbm, enqueueJob } from '@vpm/core';
import { dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from '../../core/test/helpers.js';
import { JobRunner } from '../src/jobs.js';
import { Scheduler, jobHandlers } from '../src/scheduler.js';

const { exec, one, rows } = dbm;

describe.skipIf(!dbConfig())('job runner, scheduled backups, restores and maintenance', () => {
  let core: TestCore;
  let runner: JobRunner;
  let userId: number;
  const folder = mkdtempSync(join(tmpdir(), 'vpm-nas-'));
  let targetId: number;
  let scheduleId: number;
  const domain = uniqueDomain();

  const runAll = async () => {
    for (let i = 0; i < 5; i++) await runner.tick();
  };
  const job = (id: number) => one<{ status: string; attempts: number; last_error: string | null; result: unknown }>(core.ctx.db, 'SELECT * FROM jobs WHERE id = ?', [id]);
  const deliver = async (subject: string) => {
    const message = await core.ctx.store.ingest(Buffer.from(`From: a@b.test\r\nTo: x@${domain}\r\nSubject: ${subject}\r\nMessage-ID: <${subject.replace(/\W/g, '')}${Date.now()}@b>\r\n\r\nbody\r\n`));
    await core.ctx.mailflow.inbound({ message, recipients: [{ userId }], origin: 'fetch', direction: 'in', envelopeFrom: 'a@b.test' });
  };

  beforeAll(async () => {
    core = await startCore();
    runner = new JobRunner(core.ctx, jobHandlers(core.ctx));
    await core.ctx.directory.createDomain(domain);
    userId = await makeUser(core.ctx, `jobs@${domain}`);
    await deliver('first');
    targetId = (await exec(core.ctx.db, "INSERT INTO backup_targets (name, kind, config, created_at) VALUES (?, 'smb', ?, ?)", [`NAS ${domain}`, JSON.stringify({ path: folder }), new Date()])).insertId;
    scheduleId = (await exec(core.ctx.db, "INSERT INTO backup_schedules (name, target_id, kind, cron, keep_full, created_at) VALUES ('nightly', ?, 'full', '0 1 * * *', 1, ?)", [targetId, new Date()])).insertId;
  });
  afterAll(async () => {
    await runner.stop();
    await core.stop();
  });

  it('runs a scheduled backup and verifies it; the same slot is never enqueued twice', async () => {
    const id = (await enqueueJob(core.ctx.db, { queue: 'backup', type: 'backup_scheduled', payload: { scheduleId }, dedupeKey: `backup:${scheduleId}:slot-1` }))!;
    expect(await enqueueJob(core.ctx.db, { queue: 'backup', type: 'backup_scheduled', payload: { scheduleId }, dedupeKey: `backup:${scheduleId}:slot-1` })).toBeNull();
    await runAll();
    expect((await job(id))!.status).toBe('done');
    const run = await one<{ status: string; dir_name: string; kind: string; progress: number }>(core.ctx.db, 'SELECT * FROM backup_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1', [scheduleId]);
    expect(run).toMatchObject({ status: 'verified', kind: 'full', progress: 100 });
    expect(existsSync(join(folder, run!.dir_name, 'manifest.json'))).toBe(true);
  });

  it('incremental runs build on the last good backup; rotation keeps only the newest full chain', async () => {
    await exec(core.ctx.db, "UPDATE backup_schedules SET kind = 'incremental' WHERE id = ?", [scheduleId]);
    await deliver('second');
    await enqueueJob(core.ctx.db, { queue: 'backup', type: 'backup_scheduled', payload: { scheduleId } });
    await runAll();
    const inc = await one<{ kind: string; base_run_id: number | null; status: string }>(core.ctx.db, 'SELECT * FROM backup_runs WHERE schedule_id = ? ORDER BY id DESC LIMIT 1', [scheduleId]);
    expect(inc).toMatchObject({ kind: 'incremental', status: 'verified' });
    expect(inc!.base_run_id).not.toBeNull();

    await exec(core.ctx.db, "UPDATE backup_schedules SET kind = 'full' WHERE id = ?", [scheduleId]);
    await enqueueJob(core.ctx.db, { queue: 'backup', type: 'backup_scheduled', payload: { scheduleId } });
    await runAll();
    const all = await rows<{ kind: string; status: string; dir_name: string }>(core.ctx.db, 'SELECT kind, status, dir_name FROM backup_runs WHERE schedule_id = ? ORDER BY id', [scheduleId]);
    expect(all.map((r) => `${r.kind}:${r.status}`)).toEqual(['full:expired', 'incremental:expired', 'full:verified']);
    expect(readdirSync(folder).filter((d) => d.startsWith('vpm-'))).toEqual([all[2]!.dir_name]);
  });

  it('a missing backup drive fails the run, raises a critical alert and retries later', async () => {
    const t2 = (await exec(core.ctx.db, "INSERT INTO backup_targets (name, kind, config, created_at) VALUES (?, 'usb', ?, ?)", [`USB ${domain}`, JSON.stringify({ path: '/nonexistent/usb-drive' }), new Date()])).insertId;
    const s2 = (await exec(core.ctx.db, "INSERT INTO backup_schedules (name, target_id, kind, cron, keep_full, created_at) VALUES ('usb', ?, 'full', '0 2 * * *', 2, ?)", [t2, new Date()])).insertId;
    const id = (await enqueueJob(core.ctx.db, { queue: 'backup', type: 'backup_scheduled', payload: { scheduleId: s2 }, maxAttempts: 2 }))!;
    await runner.tick();
    const j = (await job(id))!;
    expect(j.status).toBe('pending'); // will retry
    expect(j.last_error).toMatch(/does not exist|EACCES|ENOENT|permission/i);
    const run = await one<{ status: string }>(core.ctx.db, 'SELECT status FROM backup_runs WHERE target_id = ? ORDER BY id DESC LIMIT 1', [t2]);
    expect(run!.status).toBe('failed');
    expect((await one<{ severity: string }>(core.ctx.db, 'SELECT severity FROM admin_alerts WHERE dedupe_key = ?', [`backup.failed.${t2}`]))!.severity).toBe('critical');
    await exec(core.ctx.db, 'UPDATE backup_schedules SET is_enabled = 0 WHERE id = ?', [s2]);
    await exec(core.ctx.db, "UPDATE jobs SET status = 'cancelled' WHERE id = ?", [id]);
  });

  it('restore jobs bring back deleted mail and record the result', async () => {
    const inbox = (await core.ctx.store.getSpecialFolder(userId, 'inbox'))!;
    const uids = await core.ctx.store.listUids(inbox.id);
    await core.ctx.store.storeFlags(inbox.id, uids, 'add', 8, null);
    await core.ctx.store.expunge(inbox.id);
    const backupRun = await one<{ id: number }>(core.ctx.db, "SELECT id FROM backup_runs WHERE schedule_id = ? AND status = 'verified' ORDER BY id DESC LIMIT 1", [scheduleId]);
    const rr = await exec(
      core.ctx.db,
      "INSERT INTO restore_runs (backup_run_id, scope, criteria, mode, requested_by) VALUES (?, 'folder', ?, 'original', ?)",
      [backupRun!.id, JSON.stringify({ sourceUserId: userId, folderPath: 'INBOX' }), userId],
    );
    const id = (await enqueueJob(core.ctx.db, { queue: 'default', type: 'restore', payload: { restoreRunId: rr.insertId } }))!;
    await runAll();
    expect((await job(id))!.status).toBe('done');
    const r = await one<{ status: string; items_restored: number }>(core.ctx.db, 'SELECT * FROM restore_runs WHERE id = ?', [rr.insertId]);
    expect(r).toMatchObject({ status: 'ok', items_restored: 2 });
    expect((await core.ctx.store.getFolderById(inbox.id))!.message_count).toBe(2);
  });

  it('a failing restore is not retried and reports why', async () => {
    // A run that rotation already removed from the NAS.
    const expired = await one<{ id: number }>(core.ctx.db, "SELECT id FROM backup_runs WHERE status = 'expired' LIMIT 1");
    const rr = await exec(core.ctx.db, "INSERT INTO restore_runs (backup_run_id, scope, criteria, mode, requested_by) VALUES (?, 'user', ?, 'original', ?)", [expired!.id, JSON.stringify({ sourceUserId: userId }), userId]);
    const id = (await enqueueJob(core.ctx.db, { type: 'restore', payload: { restoreRunId: rr.insertId } }))!;
    await runAll();
    expect((await job(id))!.status).toBe('failed');
    expect((await one<{ status: string; error: string }>(core.ctx.db, 'SELECT * FROM restore_runs WHERE id = ?', [rr.insertId]))).toMatchObject({ status: 'failed', error: expect.stringMatching(/no longer exist/) });
  });

  it('maintenance jobs and stale-lock recovery', async () => {
    const id = (await enqueueJob(core.ctx.db, { queue: 'maintenance', type: 'maintenance', payload: { task: 'retention' } }))!;
    await runAll();
    expect((await job(id))!.status).toBe('done');
    // A job whose worker died mid-run is picked up again once its lock expires.
    const stale = (await enqueueJob(core.ctx.db, { queue: 'maintenance', type: 'maintenance', payload: { task: 'housekeeping' } }))!;
    await exec(core.ctx.db, "UPDATE jobs SET status = 'running', locked_by = 'dead-worker', locked_until = ? WHERE id = ?", [new Date(Date.now() - 1000), stale]);
    await runAll();
    expect((await job(stale))!.status).toBe('done');
  });

  it('the scheduler mirrors backup schedules and maintenance tasks as cron jobs', async () => {
    const s = new Scheduler(core.ctx);
    await s.reconcile();
    const next = s.nextRuns();
    expect(next[`backup:${scheduleId}`]).toBeInstanceOf(Date);
    expect(Object.keys(next)).toEqual(expect.arrayContaining(['maint:retention', 'maint:gc', 'maint:verify_backups']));
    await exec(core.ctx.db, 'UPDATE backup_schedules SET is_enabled = 0 WHERE id = ?', [scheduleId]);
    await s.reconcile();
    expect(s.nextRuns()[`backup:${scheduleId}`]).toBeUndefined();
    s.stop();
  });
});
