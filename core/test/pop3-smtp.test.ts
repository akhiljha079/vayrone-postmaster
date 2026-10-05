import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import nodemailer from 'nodemailer';
import { exec, one, rows } from '../src/db.js';
import { RawClient, dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from './helpers.js';
import { simpleMessage } from './fixtures.js';

const PASS = 'Pop#Smtp1';

describe.skipIf(!dbConfig())('POP3 server', () => {
  let core: TestCore;
  const domain = uniqueDomain();
  const email = `pop@${domain}`;
  let userId: number;

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(domain);
    userId = await makeUser(core.ctx, email, PASS);
    for (let i = 1; i <= 3; i++) {
      const message = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: `pop ${i}` })));
      await core.ctx.delivery.deliver({ message, targets: [{ userId }], origin: 'fetch', envelopeFrom: 'x@y' });
    }
  });
  afterAll(() => core.stop());

  const login = async () => {
    const c = await RawClient.connect(core.ports.pop3!);
    expect(await c.readUntil(/\r\n/)).toMatch(/^\+OK/);
    expect(await c.pop(`USER ${email}`)).toMatch(/^\+OK/);
    expect(await c.pop(`PASS ${PASS}`)).toMatch(/^\+OK Logged in, 3 messages/);
    return c;
  };

  it('advertises capabilities including UIDL, TOP, STLS, SASL', async () => {
    const c = await RawClient.connect(core.ports.pop3!);
    await c.readUntil(/\r\n/);
    const capa = await c.pop('CAPA', true);
    for (const k of ['TOP', 'UIDL', 'STLS', 'SASL PLAIN LOGIN']) expect(capa).toContain(k);
    expect(await c.pop('PASS x')).toMatch(/^-ERR/);
    c.end();
  });

  it('STAT / LIST / UIDL / RETR with dot-stuffing / TOP', async () => {
    const c = await login();
    const stat = await c.pop('STAT');
    const [, n, total] = /^\+OK (\d+) (\d+)/.exec(stat)!;
    expect(Number(n)).toBe(3);
    const list = await c.pop('LIST', true);
    const sizes = [...list.matchAll(/^(\d+) (\d+)$/gm)].map((m) => Number(m[2]));
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(Number(total));

    const retr = await c.pop('RETR 1', true);
    expect(retr).toContain('\r\n..dot line\r\n'); // stuffed
    expect(retr.endsWith('\r\n.\r\n')).toBe(true);
    const body = retr.slice(retr.indexOf('\r\n') + 2, -3).replace(/\r\n\.\./g, '\r\n.');
    expect(Buffer.byteLength(body, 'latin1')).toBe(sizes[0]);

    const top = await c.pop('TOP 1 0', true);
    expect(top).toContain('Subject: pop 1');
    expect(top).not.toContain('Hello Bob');
    expect(await c.pop('RETR 9')).toMatch(/^-ERR/);
    await c.pop('QUIT');
  });

  it('UIDLs are identical across sessions; DELE+QUIT expunges; RSET restores', async () => {
    const c1 = await login();
    const u1 = await c1.pop('UIDL', true);
    expect(await c1.pop('DELE 2')).toMatch(/^\+OK/);
    expect(await c1.pop('RSET')).toMatch(/^\+OK/);
    await c1.pop('QUIT');

    const c2 = await login();
    const u2 = await c2.pop('UIDL', true);
    expect(u2).toBe(u1);
    const second = /^2 (\S+)$/m.exec(u2)![1];
    await c2.pop('DELE 2');
    await c2.pop('QUIT');

    const c3 = await RawClient.connect(core.ports.pop3!);
    await c3.readUntil(/\r\n/);
    const auth = Buffer.from(`\0${email}\0${PASS}`).toString('base64');
    expect(await c3.pop(`AUTH PLAIN ${auth}`)).toMatch(/^\+OK Logged in, 2 messages/);
    const u3 = await c3.pop('UIDL', true);
    expect(u3).not.toContain(second);
    const remaining = u1.split('\r\n').filter((l) => /^\d+ /.test(l)).map((l) => l.split(' ')[1]).filter((x) => x !== second);
    expect(u3.split('\r\n').filter((l) => /^\d+ /.test(l)).map((l) => l.split(' ')[1])).toEqual(remaining);
    await c3.pop('QUIT');
    const inbox = (await core.ctx.store.getSpecialFolder(userId, 'inbox'))!;
    expect((await core.ctx.store.getFolderById(inbox.id))!.message_count).toBe(2);
  });
});

describe.skipIf(!dbConfig())('SMTP submission', () => {
  let core: TestCore;
  const domain = uniqueDomain();
  const alice = `alice@${domain}`;
  const bob = `bob@${domain}`;
  let bobId: number;

  const transport = (user: string, pass: string) =>
    nodemailer.createTransport({ host: '127.0.0.1', port: core.ports.submission!, secure: false, auth: { user, pass }, tls: { rejectUnauthorized: false } });

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(domain);
    await makeUser(core.ctx, alice, PASS);
    bobId = await makeUser(core.ctx, bob, PASS);
  });
  afterAll(() => core.stop());

  it('requires authentication', async () => {
    const t = nodemailer.createTransport({ host: '127.0.0.1', port: core.ports.submission!, secure: false, tls: { rejectUnauthorized: false } });
    await expect(t.sendMail({ from: alice, to: bob, text: 'x' })).rejects.toThrow(/530|Authentication/i);
    await expect(transport(alice, 'wrong').sendMail({ from: alice, to: bob, text: 'x' })).rejects.toThrow(/535/);
  });

  it('refuses sending as another address', async () => {
    await expect(transport(alice, PASS).sendMail({ from: bob, to: bob, text: 'x' })).rejects.toThrow(/553/);
  });

  it('delivers internally over STARTTLS and queues external recipients through the relay queue', async () => {
    const info = await transport(alice, PASS).sendMail({
      from: `Alice <${alice}>`,
      to: [bob, 'client@external-example.com'],
      cc: bob, // same mailbox twice: delivered once
      subject: 'Quarterly numbers',
      text: 'See attached',
    });
    expect(info.accepted).toHaveLength(2); // nodemailer de-duplicates the envelope
    const inbox = (await core.ctx.store.getSpecialFolder(bobId, 'inbox'))!;
    const items = await rows<{ message_id: number }>(core.ctx.db, 'SELECT message_id FROM mail_items WHERE folder_id = ?', [inbox.id]);
    expect(items).toHaveLength(1);
    const [full] = await core.ctx.store.itemsFull(inbox.id, [1]);
    const raw = (await core.ctx.store.loadRaw(full!)).toString();
    expect(raw).toMatch(/^Received: from [^\r\n]+\r\n\tby mail\.test\.local \(Vayrone PostMaster\) with ESMTPSA id [0-9A-F]+\r\n\tfor </);
    expect(raw).toContain(`From: Alice <${alice}>`);

    const q = await one<{ id: number; envelope_from: string; status: string; message_id: number }>(core.ctx.db, 'SELECT * FROM outbound_queue ORDER BY id DESC LIMIT 1');
    expect(q).toMatchObject({ envelope_from: alice, status: 'queued', message_id: items[0]!.message_id });
    const rc = await rows<{ rcpt: string }>(core.ctx.db, 'SELECT rcpt FROM outbound_recipients WHERE queue_id = ?', [q!.id]);
    expect(rc.map((r) => r.rcpt)).toEqual(['client@external-example.com']);
    const m = await one<{ refcount: number }>(core.ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [q!.message_id]);
    expect(m!.refcount).toBe(3); // bob's copy + queue entry + compliance archive
  });

  it('applies the domain unknown-recipient policy', async () => {
    await exec(core.ctx.db, "UPDATE domains SET unknown_recipient_action = 'reject' WHERE name = ?", [domain]);
    await expect(transport(alice, PASS).sendMail({ from: alice, to: `ghost@${domain}`, text: 'x' })).rejects.toThrow(/550/);
    await exec(core.ctx.db, "UPDATE domains SET unknown_recipient_action = 'relay' WHERE name = ?", [domain]);
    const info = await transport(alice, PASS).sendMail({ from: alice, to: `ghost@${domain}`, text: 'x' });
    expect(info.accepted).toEqual([`ghost@${domain}`]);
  });
});
