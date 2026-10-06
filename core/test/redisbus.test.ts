import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { MailEvents } from '../src/events.js';
import { attachRedisBus, type RedisBus } from '../src/redisbus.js';
import { enqueueJob } from '../src/jobs.js';
import { createPool } from '../src/db.js';
import { dbConfig } from './helpers.js';

// A locally built Valkey (.cache/tools/valkey-*/src/valkey-server) or VPM_TEST_REDIS_URL.
const tools = resolve(import.meta.dirname, '..', '..', '.cache', 'tools');
const bin = existsSync(tools) ? readdirSync(tools).map((d) => join(tools, d, 'src', 'valkey-server')).find((p) => existsSync(p)) : undefined;
const external = process.env.VPM_TEST_REDIS_URL;
const log = { warn: () => {}, info: () => {} };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(!bin && !external)('Redis / Valkey bus', () => {
  let proc: ChildProcess | null = null;
  let url = external ?? '';
  const a = new MailEvents();
  const b = new MailEvents();
  let busA: RedisBus;
  let busB: RedisBus;

  beforeAll(async () => {
    if (!external) {
      const port = 20000 + Math.floor(Math.random() * 20000);
      proc = spawn(bin!, ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
      url = `redis://127.0.0.1:${port}`;
      await wait(400);
    }
    busA = await attachRedisBus(a, url, log);
    busB = await attachRedisBus(b, url, log);
  });
  afterAll(async () => {
    await busA?.close();
    await busB?.close();
    proc?.kill();
  });

  it('a folder change in one process reaches the others once, not back to itself', async () => {
    const seenA: number[] = [];
    const seenB: number[] = [];
    a.onAnyFolder((id) => seenA.push(id));
    b.onAnyFolder((id) => seenB.push(id));
    a.folderChanged(7);
    a.folderChanged(7);
    a.folderChanged(9);
    await wait(250);
    expect(seenA).toEqual([7, 7, 9]); // local listeners as before
    expect(seenB.sort()).toEqual([7, 9]); // batched and de-duplicated over the bus
  });

  it.skipIf(!dbConfig())('queuing a job wakes the other processes at once', async () => {
    const woke: string[] = [];
    busB.onJob((q) => woke.push(q));
    const db = createPool({ ...dbConfig()!, connectionLimit: 1 });
    await enqueueJob(db, { queue: 'backup', type: 'noop', payload: {}, dedupeKey: `bus-${Date.now()}` });
    await db.end();
    await wait(250);
    expect(woke).toContain('backup');
  });
});
