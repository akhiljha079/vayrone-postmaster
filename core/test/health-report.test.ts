import { describe, expect, it } from 'vitest';
import { healthReport, MONITOR_DEFAULTS, type Health } from '../src/monitor.js';

const base = (): Health => ({
  version: '0.6.6',
  hostname: 'mail.test.local',
  checkedAt: '2026-10-08T10:00:00.000Z',
  process: { uptimeSec: 100, rssBytes: 1, heapUsedBytes: 1, node: 'v24' },
  system: { uptimeSec: 36_000, load1: 0.1, cpus: 4, memFreeBytes: 1, memTotalBytes: 2 },
  db: { ok: true, latencyMs: 1, sizeBytes: 1, error: null },
  disk: { path: '/data', freeBytes: 400 * 1024 ** 3, totalBytes: 1000 * 1024 ** 3, freePct: 40 },
  store: { messages: 10, bytes: 10 },
  users: { active: 25, mailboxes: 24 },
  queue: { queued: 0, deferred: 0, held: 0, oldestMinutes: null, failed24h: 0, sent24h: 100 },
  fetch: { accounts: 24, failing: 0, authFailed: 0, lastSuccessMinutes: 1 },
  backup: { lastOkAt: '2026-10-08T02:00:00.000Z', ageHours: 8, schedules: 1 },
  tls: { validTo: '2027-10-01T00:00:00.000Z', daysLeft: 358, selfSigned: true },
  license: { mode: 'active' },
  alerts: { critical: 0, warning: 0, info: 0 },
});

describe('health report sent to Vayrone', () => {
  it('healthy server: OK, no issues, figures only', () => {
    const r = healthReport(base());
    expect(r).toMatchObject({ status: 'ok', issues: [], mailboxes: 24, diskFreePct: 40, diskFreeGb: 400, uptimeHours: 10, backup: { scheduled: true, ageHours: 8 } });
  });

  it('problems first, in plain words; warnings alone give "warning"', () => {
    const h = base();
    h.disk!.freePct = 4;
    h.fetch = { ...h.fetch, failing: 3, authFailed: 1 };
    h.backup = { lastOkAt: null, ageHours: null, schedules: 1 };
    h.queue = { ...h.queue, queued: 5, oldestMinutes: 90 };
    h.license.mode = 'grace';
    const r = healthReport(h, MONITOR_DEFAULTS);
    expect(r.status).toBe('problem');
    expect(r.issues).toEqual([
      { level: 'problem', text: 'Disk almost full: 4% free' },
      { level: 'problem', text: '1 external mailbox: wrong provider password' },
      { level: 'problem', text: 'No successful backup yet' },
      { level: 'warning', text: '2 external mailboxes failing to fetch' },
      { level: 'warning', text: '5 outgoing mails waiting, oldest 90 min' },
      { level: 'warning', text: 'Licence in grace period' },
    ]);
    const w = base();
    w.backup.schedules = 0;
    expect(healthReport(w)).toMatchObject({ status: 'warning', issues: [{ level: 'warning', text: 'No backup schedule' }] });
  });
});
