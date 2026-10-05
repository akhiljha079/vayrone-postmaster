import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SMTPServer, type SMTPServerAddress } from 'smtp-server';
import type { AddressInfo } from 'node:net';
import nodemailer from 'nodemailer';
import { db as dbm } from '@vpm/core';
import { dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from '../../core/test/helpers.js';
import { OutboundSender } from '../src/sender.js';

const { exec, one, rows } = dbm;
const PASS = 'Relay#Test1';

interface Received {
  from: string;
  to: string[];
  raw: string;
}

/** A fake "provider" SMTP server (Hostinger/cPanel stand-in) with scriptable failures. */
class FakeProvider {
  received: Received[] = [];
  rcptCodes = new Map<string, number>(); // address → SMTP code to reject with
  mailFromCode: number | null = null;
  tempFailData = false;
  port = 0;
  private server: SMTPServer;

  constructor(
    private readonly user: string,
    private readonly pass: string,
  ) {
    const err = (code: number, msg: string) => Object.assign(new Error(msg), { responseCode: code });
    this.server = new SMTPServer({
      authOptional: false,
      allowInsecureAuth: true,
      closeTimeout: 200,
      disabledCommands: ['STARTTLS'],
      logger: false,
      onAuth: (a, _s, cb) => (a.username === this.user && a.password === this.pass ? cb(null, { user: a.username }) : cb(err(535, '5.7.8 Bad credentials'))),
      onMailFrom: (_a: SMTPServerAddress, _s, cb) => (this.mailFromCode ? cb(err(this.mailFromCode, '5.7.1 Sender address rejected: not owned by user')) : cb()),
      onRcptTo: (a: SMTPServerAddress, _s, cb) => {
        const code = this.rcptCodes.get(a.address.toLowerCase());
        if (code) return cb(err(code, code >= 500 ? '5.1.1 User unknown' : '4.2.0 Try again later'));
        cb();
      },
      onData: (stream, s, cb) => {
        const chunks: Buffer[] = [];
        stream.on('data', (c: Buffer) => chunks.push(c));
        stream.on('end', () => {
          if (this.tempFailData) return cb(err(451, '4.3.0 Temporary local problem'));
          this.received.push({
            from: (s.envelope.mailFrom as SMTPServerAddress).address,
            to: s.envelope.rcptTo.map((r) => r.address),
            raw: Buffer.concat(chunks).toString(),
          });
          cb();
        });
      },
    });
  }

  listen(): Promise<number> {
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r((this.port = (this.server.server.address() as AddressInfo).port))));
  }

  close(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }
}

describe.skipIf(!dbConfig())('outbound relay sender', () => {
  let core: TestCore;
  let sender: OutboundSender;
  let provider: FakeProvider;
  let relayId: number;
  const domain = uniqueDomain();
  const alice = `alice@${domain}`;
  let aliceId: number;

  const addRelay = async (name: string, port: number, user: string, pass: string, extra: Record<string, unknown> = {}) => {
    const now = new Date();
    const r = await exec(
      core.ctx.db,
      `INSERT INTO relay_accounts (name, host, port, security, auth_user, auth_secret, tls_verify, is_default, created_at, updated_at, envelope_from, set_sender_header)
       VALUES (?, '127.0.0.1', ?, 'none', ?, ?, 0, ?, ?, ?, ?, ?)`,
      [name, port, user, core.ctx.secrets.seal(pass), extra.isDefault ? 1 : 0, now, now, extra.envelopeFrom ?? 'relay_account', extra.setSender ?? 1],
    );
    return r.insertId;
  };

  const enqueue = async (to: string[], subject = 'Hello') => {
    const raw = `From: Alice <${alice}>\r\nTo: ${to.join(', ')}\r\nSubject: ${subject}\r\nMessage-ID: <${Math.random()}@x>\r\n\r\nBody\r\n`;
    const message = await core.ctx.store.ingest(Buffer.from(raw));
    return core.ctx.delivery.enqueueOutbound({ message, envelopeFrom: alice, recipients: to, senderUserId: aliceId, source: 'submission' });
  };

  const queueRow = (id: number) => one<{ status: string; attempts: number; next_attempt_at: Date; relay_account_id: number | null; message_id: number; last_error: string | null }>(core.ctx.db, 'SELECT * FROM outbound_queue WHERE id = ?', [id]);
  const aliceInbox = async () => {
    const inbox = (await core.ctx.store.getSpecialFolder(aliceId, 'inbox'))!;
    const uids = await core.ctx.store.listUids(inbox.id);
    const items = await core.ctx.store.itemsFull(inbox.id, uids);
    return Promise.all(items.map(async (i) => (await core.ctx.store.loadRaw(i)).toString()));
  };

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(domain);
    aliceId = await makeUser(core.ctx, alice, PASS);
    sender = new OutboundSender(core.ctx);
  });
  afterEach(async () => {
    await exec(core.ctx.db, "UPDATE outbound_queue SET status = 'sent' WHERE status IN ('queued','deferred','sending')");
    await provider?.close();
  });
  afterAll(async () => {
    await sender.stop();
    await core.stop();
  });

  it('waits (never drops) when no relay is configured, and raises an alert', async () => {
    const id = await enqueue(['x@external.test']);
    await sender.tick();
    const q = await queueRow(id);
    expect(q).toMatchObject({ status: 'deferred', attempts: 1, last_error: 'No SMTP relay configured' });
    const alert = await one<{ code: string }>(core.ctx.db, "SELECT code FROM admin_alerts WHERE dedupe_key = 'relay.missing' AND resolved_at IS NULL");
    expect(alert?.code).toBe('relay.missing');
  });

  it('relays end-to-end from LAN submission; From stays the employee, envelope uses the relay account', async () => {
    provider = new FakeProvider('mailserver@client.test', 'provider-pw');
    relayId = await addRelay('Main relay', await provider.listen(), 'mailserver@client.test', 'provider-pw', { isDefault: true });

    const smtp = nodemailer.createTransport({ host: '127.0.0.1', port: core.ports.submission!, secure: false, auth: { user: alice, pass: PASS }, tls: { rejectUnauthorized: false } });
    await smtp.sendMail({ from: `Alice <${alice}>`, to: 'customer@external.test', subject: 'Invoice', text: 'Please find attached' });
    const q0 = await one<{ id: number }>(core.ctx.db, 'SELECT id FROM outbound_queue ORDER BY id DESC LIMIT 1');
    await sender.tick();

    expect(provider.received).toHaveLength(1);
    const got = provider.received[0]!;
    expect(got.from).toBe('mailserver@client.test');
    expect(got.to).toEqual(['customer@external.test']);
    expect(got.raw).toContain(`From: Alice <${alice}>`);
    expect(got.raw).toMatch(/^Sender: <mailserver@client\.test>\r\n/);
    const q = await queueRow(q0!.id);
    expect(q).toMatchObject({ status: 'sent', relay_account_id: relayId });
    const m = await one<{ refcount: number }>(core.ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [q!.message_id]);
    expect(m!.refcount).toBe(1); // queue reference released; the compliance archive keeps one
    const log = await rows<{ event: string }>(core.ctx.db, "SELECT event FROM mail_log WHERE ref_type = 'queue' AND ref_id = ?", [q0!.id]);
    expect(log.map((l) => l.event)).toContain('relayed');
  });

  it('partial failure: delivers the good recipient and bounces the bad one to the sender', async () => {
    provider = new FakeProvider('mailserver@client.test', 'provider-pw');
    await exec(core.ctx.db, 'UPDATE relay_accounts SET port = ?, updated_at = ? WHERE id = ?', [await provider.listen(), new Date(), relayId]);
    provider.rcptCodes.set('nobody@external.test', 550);
    const before = (await aliceInbox()).length;
    const id = await enqueue(['ok@external.test', 'nobody@external.test'], 'Partial');
    await sender.tick();
    expect((await queueRow(id))!.status).toBe('partial');
    expect(provider.received[0]!.to).toEqual(['ok@external.test']);
    const inbox = await aliceInbox();
    expect(inbox).toHaveLength(before + 1);
    const dsn = inbox[inbox.length - 1]!;
    expect(dsn).toContain('Subject: Undelivered Mail Returned to Sender');
    expect(dsn).toContain('Final-Recipient: rfc822; nobody@external.test');
    expect(dsn).toContain('Status: 5.1.1');
    expect(dsn).toContain('Subject: Partial'); // original headers attached
  });

  it('temporary failure is deferred and retried later', async () => {
    provider = new FakeProvider('mailserver@client.test', 'provider-pw');
    await exec(core.ctx.db, 'UPDATE relay_accounts SET port = ?, updated_at = ? WHERE id = ?', [await provider.listen(), new Date(), relayId]);
    provider.tempFailData = true;
    const id = await enqueue(['later@external.test']);
    await sender.tick();
    let q = await queueRow(id);
    expect(q!.status).toBe('deferred');
    expect(new Date(q!.next_attempt_at).getTime() - Date.now()).toBeGreaterThan(50_000); // ~1 minute
    provider.tempFailData = false;
    await exec(core.ctx.db, 'UPDATE outbound_queue SET next_attempt_at = ? WHERE id = ?', [new Date(Date.now() - 1000), id]);
    await sender.tick();
    q = await queueRow(id);
    expect(q).toMatchObject({ status: 'sent', attempts: 2 });
  });

  it('gives up after expiry and tells the sender', async () => {
    provider = new FakeProvider('mailserver@client.test', 'provider-pw');
    await exec(core.ctx.db, 'UPDATE relay_accounts SET port = ?, updated_at = ? WHERE id = ?', [await provider.listen(), new Date(), relayId]);
    provider.rcptCodes.set('slow@external.test', 451);
    const id = await enqueue(['slow@external.test'], 'Expiring');
    await exec(core.ctx.db, 'UPDATE outbound_queue SET expires_at = ? WHERE id = ?', [new Date(Date.now() - 1000), id]);
    await sender.tick();
    expect((await queueRow(id))!.status).toBe('failed');
    const inbox = await aliceInbox();
    expect(inbox[inbox.length - 1]).toContain('within the retry period');
  });

  it('auth failure keeps mail queued and raises a critical alert', async () => {
    provider = new FakeProvider('mailserver@client.test', 'changed-password');
    await exec(core.ctx.db, 'UPDATE relay_accounts SET port = ?, updated_at = ? WHERE id = ?', [await provider.listen(), new Date(), relayId]);
    const id = await enqueue(['x@external.test']);
    await sender.tick();
    expect((await queueRow(id))!.status).toBe('deferred');
    const a = await one<{ severity: string; message: string }>(core.ctx.db, "SELECT severity, message FROM admin_alerts WHERE code = 'relay.auth' AND resolved_at IS NULL");
    expect(a?.severity).toBe('critical');
    expect(a?.message).toContain('Main relay');
  });

  it('per-user route overrides the default relay; refused sender bounces and alerts', async () => {
    provider = new FakeProvider('mailserver@client.test', 'provider-pw');
    await exec(core.ctx.db, 'UPDATE relay_accounts SET port = ?, updated_at = ? WHERE id = ?', [await provider.listen(), new Date(), relayId]);
    const strict = new FakeProvider('alice-own@provider.test', 'own-pw');
    const strictId = await addRelay('Strict provider', await strict.listen(), 'alice-own@provider.test', 'own-pw', { envelopeFrom: 'original_sender', setSender: 0 });
    await exec(core.ctx.db, "INSERT INTO relay_routes (scope, user_id, relay_account_id, created_at) VALUES ('user', ?, ?, ?)", [aliceId, strictId, new Date()]);
    try {
      const id1 = await enqueue(['client@external.test'], 'Via own account');
      await sender.tick();
      expect(strict.received).toHaveLength(1);
      expect(strict.received[0]!.from).toBe(alice);
      expect(provider.received).toHaveLength(0);
      expect((await queueRow(id1))!.relay_account_id).toBe(strictId);

      strict.mailFromCode = 553;
      const id2 = await enqueue(['client@external.test'], 'Refused sender');
      await sender.tick();
      expect((await queueRow(id2))!.status).toBe('failed');
      const a = await one(core.ctx.db, "SELECT id FROM admin_alerts WHERE code = 'relay.sender_refused'");
      expect(a).toBeTruthy();
    } finally {
      await exec(core.ctx.db, 'DELETE FROM relay_routes WHERE user_id = ?', [aliceId]);
      await strict.close();
    }
  });
});
