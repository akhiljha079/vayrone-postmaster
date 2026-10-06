// Load test for the sizing target in the spec (§8): 500 users and 1000 external
// accounts. Runs only with VPM_LOAD=1 (scripts/loadtest.sh). Everything —
// "provider" IMAP server, fetcher, 500 Outlook-like IDLE clients, SMTP senders —
// shares ONE Node process and one test database here, so the numbers are a
// pessimistic lower bound for a real install (core and worker are separate
// processes; providers are remote).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { ConnectionLimiter, db as dbm, hashPassword } from '@vpm/core';
import { dbConfig, startCore, uniqueDomain, type TestCore } from '../../core/test/helpers.js';
import { Fetcher } from '../src/fetcher.js';

const { exec, one } = dbm;
const USERS = Number(process.env.VPM_LOAD_USERS ?? 500);
const ACCOUNTS = Number(process.env.VPM_LOAD_ACCOUNTS ?? 1000);
const MSGS = Number(process.env.VPM_LOAD_MSGS ?? 3);
const PW = 'Load#Test#2026';
const report: Record<string, unknown> = { users: USERS, externalAccounts: ACCOUNTS, messagesPerAccount: MSGS, node: process.version, cpus: (await import('node:os')).cpus().length, cpu: (await import('node:os')).cpus()[0]?.model };
const mb = () => Math.round(process.memoryUsage().rss / 1048576);
const now = () => performance.now();
const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor((a.length * p) / 100))]!;

describe.runIf(process.env.VPM_LOAD === '1' && dbConfig())('load: 500 users, 1000 external accounts', () => {
  let core: TestCore;
  const lan = uniqueDomain();
  const prov = `prov-${uniqueDomain()}`;
  const lanUsers: number[] = [];
  const provUsers: number[] = [];

  beforeAll(async () => {
    core = await startCore();
    core.ctx.connections = new ConnectionLimiter({ maxConnections: 20_000, maxPerIp: 20_000 }); // every client is 127.0.0.1 here
    await core.ctx.directory.createDomain(lan);
    await core.ctx.directory.createDomain(prov);
    const t0 = now();
    // One password hash reused: creating 1500 users would otherwise measure scrypt, not the server.
    const hash = await hashPassword(PW);
    const mk = async (email: string) => {
      const id = await core.ctx.directory.createUser({ email, password: PW });
      await exec(core.ctx.db, 'UPDATE users SET password_hash = ? WHERE id = ?', [hash, id]);
      return id;
    };
    for (let i = 0; i < USERS; i++) lanUsers.push(await mk(`user${i}@${lan}`));
    for (let i = 0; i < ACCOUNTS; i++) provUsers.push(await mk(`box${i}@${prov}`));
    // Provider mailboxes with MSGS messages each.
    for (let i = 0; i < ACCOUNTS; i++) {
      const f = (await core.ctx.store.getFolder(provUsers[i]!, 'INBOX'))!;
      for (let k = 0; k < MSGS; k++) {
        const message = await core.ctx.store.ingest(Buffer.from(`From: Customer <c${k}@outside.test>\r\nTo: box${i}@${prov}\r\nSubject: Order ${i}-${k}\r\nMessage-ID: <${randomBytes(8).toString('hex')}@outside.test>\r\nDate: ${new Date().toUTCString()}\r\n\r\n${'Order details line.\r\n'.repeat(40)}`));
        await core.ctx.store.append({ userId: provUsers[i]!, folderId: f.id, message, origin: 'internal' });
      }
    }
    // Two external accounts per LAN user (IMAP, STARTTLS, keep on server).
    const sealed = core.ctx.secrets.seal(PW);
    for (let i = 0; i < ACCOUNTS; i++) {
      await exec(
        core.ctx.db,
        `INSERT INTO external_accounts (user_id, protocol, host, port, security, tls_verify, username, secret, interval_sec, use_idle, leave_policy, keep_days, created_at, updated_at)
         VALUES (?, 'imap', '127.0.0.1', ?, 'starttls', 0, ?, ?, 600, 1, 'keep', 14, NOW(3), NOW(3))`,
        [lanUsers[i % USERS], core.ports.imap, `box${i}@${prov}`, sealed],
      );
    }
    report.setupSeconds = Math.round((now() - t0) / 100) / 10;
    report.rssAfterSetupMB = mb();
  }, 3_600_000);

  afterAll(async () => {
    writeFileSync(resolve(import.meta.dirname, '..', '..', 'docs', 'performance-results.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    await core?.stop();
  });

  it('initial fetch of every external mailbox', async () => {
    const f = new Fetcher(core.ctx, { idle: false, concurrency: 50, perHost: 50, timeoutMs: 60_000, tickMs: 200 });
    const t0 = now();
    f.start();
    const want = ACCOUNTS * MSGS;
    for (;;) {
      const n = Number((await one<{ n: number }>(core.ctx.db, "SELECT COUNT(*) n FROM mail_items WHERE user_id IN (?) AND origin = 'fetch'", [lanUsers]))!.n);
      if (n >= want) break;
      if (now() - t0 > 1_800_000) throw new Error(`only ${n} of ${want} fetched`);
      await new Promise((r) => setTimeout(r, 500));
    }
    await f.stop();
    const secs = (now() - t0) / 1000;
    report.initialFetch = { messages: want, seconds: Math.round(secs * 10) / 10, messagesPerSecond: Math.round(want / secs), accountsPerSecond: Math.round(ACCOUNTS / secs), rssMB: mb() };
    const failed = Number((await one<{ n: number }>(core.ctx.db, "SELECT COUNT(*) n FROM external_accounts WHERE status IN ('error','backoff','auth_failed')"))!.n);
    expect(failed).toBe(0);
  }, 3_600_000);

  it('IDLE on every external account: new provider mail reaches the local mailbox in seconds', async () => {
    const f = new Fetcher(core.ctx, { idle: true, concurrency: 50, perHost: 50, timeoutMs: 60_000, tickMs: 200 });
    f.start();
    const t0 = now();
    // Wait until a watcher is connected for every account.
    for (;;) {
      const watching = f.activeWatchers;
      if (watching >= ACCOUNTS) break;
      if (now() - t0 > 600_000) throw new Error(`only ${watching} IDLE watchers`);
      await new Promise((r) => setTimeout(r, 500));
    }
    report.idleWatchers = { accounts: ACCOUNTS, secondsToConnectAll: Math.round((now() - t0) / 100) / 10, rssMB: mb() };
    await new Promise((r) => setTimeout(r, 3000));
    const sample = Array.from({ length: 50 }, (_, i) => Math.floor((i * ACCOUNTS) / 50));
    const latencies: number[] = [];
    await Promise.all(
      sample.map(async (i) => {
        const subject = `Push ${i} ${randomBytes(3).toString('hex')}`;
        const folder = (await core.ctx.store.getFolder(provUsers[i]!, 'INBOX'))!;
        const message = await core.ctx.store.ingest(Buffer.from(`From: c@outside.test\r\nTo: box${i}@${prov}\r\nSubject: ${subject}\r\nMessage-ID: <${randomBytes(8).toString('hex')}@o.test>\r\n\r\nNew\r\n`));
        const t = now();
        await core.ctx.store.append({ userId: provUsers[i]!, folderId: folder.id, message, origin: 'internal' });
        for (;;) {
          const got = await one(core.ctx.db, "SELECT i.id FROM mail_items i JOIN messages m ON m.id = i.message_id WHERE i.user_id = ? AND m.hdr_subject = ? AND i.origin = 'fetch'", [lanUsers[i % USERS], subject]);
          if (got) break;
          if (now() - t > 120_000) throw new Error('push not received');
          await new Promise((r) => setTimeout(r, 100));
        }
        latencies.push(now() - t);
      }),
    );
    report.idlePushLatencyMs = { samples: latencies.length, p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), max: Math.round(Math.max(...latencies)) };
    await f.stop();
    expect(pct(latencies, 95)).toBeLessThan(30_000);
  }, 3_600_000);

  it('500 mail clients connected with IDLE; new mail pushed to them', async () => {
    const clients: ImapFlow[] = [];
    const t0 = now();
    for (let i = 0; i < USERS; i += 50) {
      await Promise.all(
        Array.from({ length: Math.min(50, USERS - i) }, async (_, k) => {
          const c = new ImapFlow({ host: '127.0.0.1', port: core.ports.imap!, secure: false, auth: { user: `user${i + k}@${lan}`, pass: PW }, logger: false, tls: { rejectUnauthorized: false }, disableAutoIdle: false });
          await c.connect();
          await c.mailboxOpen('INBOX');
          void c.idle().catch(() => undefined); // like Outlook: IDLE right after selecting INBOX
          clients.push(c);
        }),
      );
    }
    report.clients = { connected: clients.length, secondsToConnect: Math.round((now() - t0) / 100) / 10, rssMB: mb() };
    await new Promise((r) => setTimeout(r, 2000));
    const latencies: number[] = [];
    await Promise.all(
      clients.slice(0, 50).map(async (c, i) => {
        const got = new Promise<void>((ok) => c.once('exists', () => ok()));
        const t = now();
        const message = await core.ctx.store.ingest(Buffer.from(`From: colleague@${lan}\r\nTo: user${i}@${lan}\r\nSubject: Ping ${i}\r\nMessage-ID: <${randomBytes(8).toString('hex')}@${lan}>\r\n\r\nhi\r\n`));
        await core.ctx.delivery.deliver({ message, targets: [{ userId: lanUsers[i]! }], origin: 'internal', envelopeFrom: `colleague@${lan}` });
        await got;
        latencies.push(now() - t);
      }),
    );
    report.clientPushLatencyMs = { samples: latencies.length, p50: Math.round(pct(latencies, 50)), p95: Math.round(pct(latencies, 95)), max: Math.round(Math.max(...latencies)) };
    await Promise.all(clients.map((c) => c.logout().catch(() => undefined)));
    expect(pct(latencies, 95)).toBeLessThan(5000);
  }, 3_600_000);

  it('SMTP submission throughput (50 parallel senders)', async () => {
    const N = 2000;
    const transports = Array.from({ length: 50 }, (_, i) =>
      nodemailer.createTransport({ host: '127.0.0.1', port: core.ports.submission!, secure: false, auth: { user: `user${i % USERS}@${lan}`, pass: PW }, tls: { rejectUnauthorized: false }, pool: true, maxConnections: 1 }),
    );
    const t0 = now();
    let sent = 0;
    await Promise.all(
      transports.map(async (t, i) => {
        for (let k = i; k < N; k += 50) {
          await t.sendMail({ from: `user${i % USERS}@${lan}`, to: [`user${(k * 7) % USERS}@${lan}`, `partner${k}@outside.test`], subject: `Report ${k}`, text: 'Weekly report attached as text.\n'.repeat(50) });
          sent++;
        }
      }),
    );
    for (const t of transports) t.close();
    const secs = (now() - t0) / 1000;
    report.smtpSubmission = { messages: sent, seconds: Math.round(secs * 10) / 10, messagesPerSecond: Math.round(sent / secs), rssMB: mb() };
    expect(sent).toBe(N);
  }, 3_600_000);
});
