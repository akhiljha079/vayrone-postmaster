// Optional Redis / Valkey adapter (config "redis": { "url": "redis://127.0.0.1:6379" }).
// For very large sites: replaces the loopback IPC for folder-change events
// (IMAP IDLE and browser push) and wakes the job runner immediately when a job
// is queued, instead of waiting for its poll. Recommended server: Valkey
// (BSD-3); Redis 7.4+ is RSAL/SSPL-licensed. Without it, nothing changes.
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import type { Logger } from 'pino';
import type { MailEvents } from './events.js';
import { onJobEnqueued } from './jobs.js';

const EVENTS = 'vpm:events';
const JOBS = 'vpm:jobs';

export interface RedisBus {
  /** Called with the queue name when another process queued a job. */
  onJob(fn: (queue: string) => void): void;
  close(): Promise<void>;
}

export async function attachRedisBus(events: MailEvents, url: string, log: Pick<Logger, 'warn' | 'info'>): Promise<RedisBus> {
  const node = randomBytes(6).toString('hex');
  const opts = { lazyConnect: true, maxRetriesPerRequest: 2, enableOfflineQueue: false, retryStrategy: (n: number) => Math.min(n * 500, 10_000) };
  const pub = new Redis(url, opts);
  const sub = new Redis(url, opts);
  for (const c of [pub, sub]) c.on('error', (err: Error) => log.warn({ err: err.message }, 'redis connection problem'));
  await Promise.all([pub.connect(), sub.connect()]);
  await sub.subscribe(EVENTS, JOBS);
  const jobListeners: ((q: string) => void)[] = [];
  sub.on('message', (channel: string, payload: string) => {
    try {
      const m = JSON.parse(payload) as { n: string; f?: number[]; q?: string };
      if (m.n === node) return; // our own
      if (channel === EVENTS) for (const id of m.f ?? []) if (Number.isInteger(id)) events.emitLocal(id);
      if (channel === JOBS) for (const fn of jobListeners) fn(m.q ?? '');
    } catch {
      /* ignore foreign messages */
    }
  });

  // Folder changes: local emit as before, plus one batched publish per 50 ms.
  const pending = new Set<number>();
  let timer: NodeJS.Timeout | null = null;
  const original = events.folderChanged.bind(events);
  events.folderChanged = (id: number) => {
    original(id);
    pending.add(id);
    timer ??= setTimeout(() => {
      timer = null;
      const f = [...pending];
      pending.clear();
      pub.publish(EVENTS, JSON.stringify({ n: node, f })).catch(() => undefined);
    }, 50);
  };
  const offJobs = onJobEnqueued((queue) => void pub.publish(JOBS, JSON.stringify({ n: node, q: queue })).catch(() => undefined));
  log.info({ url: url.replace(/\/\/[^@]*@/, '//***@') }, 'redis bus connected');
  return {
    onJob: (fn) => void jobListeners.push(fn),
    async close() {
      events.folderChanged = original;
      offJobs();
      if (timer) clearTimeout(timer);
      sub.disconnect();
      await pub.quit().catch(() => pub.disconnect());
    },
  };
}
