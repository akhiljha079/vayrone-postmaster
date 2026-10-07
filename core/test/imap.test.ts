import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { one } from '../src/db.js';
import { dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from './helpers.js';
import { complexMessage, simpleMessage } from './fixtures.js';

const PASS = 'Secret#123';

describe.skipIf(!dbConfig())('IMAP server (imapflow client)', () => {
  let core: TestCore;
  const domain = uniqueDomain();
  const user = `anil@${domain}`;
  const colleague = `sunita@${domain}`;
  let client: ImapFlow;

  const newClient = () =>
    new ImapFlow({
      host: '127.0.0.1',
      port: core.ports.imap!,
      secure: false,
      auth: { user, pass: PASS },
      logger: false,
      tls: { rejectUnauthorized: false },
    });

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(domain);
    await makeUser(core.ctx, user, PASS);
    await makeUser(core.ctx, colleague, PASS);
    client = newClient();
    await client.connect();
  });
  afterAll(async () => {
    await client.logout().catch(() => {});
    await core.stop();
  });

  it('upgrades with STARTTLS, logs in and lists special-use folders', async () => {
    expect(client.secureConnection).toBe(true);
    const list = await client.list();
    const byPath = Object.fromEntries(list.map((m) => [m.path, m.specialUse ?? null]));
    expect(byPath).toMatchObject({ INBOX: '\\Inbox', Sent: '\\Sent', Drafts: '\\Drafts', Trash: '\\Trash', Junk: '\\Junk', Archive: '\\Archive' });
  });

  it('folders made in webmail (also nested) appear in Outlook-style clients, subscribed, with the mail rules put there', async () => {
    const userId = (await one<{ id: number }>(core.ctx.db, 'SELECT id FROM users WHERE login = ?', [user]))!.id;
    // What POST /api/mail/folders does.
    await core.ctx.store.createFolder(userId, 'Clients/Sharma Steel');
    // Mail that a rule files into it.
    const message = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'Order from Sharma' })));
    const f = (await core.ctx.store.getFolder(userId, 'Clients/Sharma Steel'))!;
    await core.ctx.store.append({ userId, folderId: f.id, message, origin: 'fetch' });

    const outlook = newClient();
    await outlook.connect();
    try {
      const all = (await outlook.list()).map((m) => m.path);
      expect(all).toEqual(expect.arrayContaining(['Clients', 'Clients/Sharma Steel']));
      // Outlook and Thunderbird show subscribed folders (LSUB / LIST (SUBSCRIBED)).
      const subscribed = (await outlook.list({ statusQuery: { messages: true } })).filter((m) => m.subscribed).map((m) => m.path);
      expect(subscribed).toContain('Clients/Sharma Steel');
      const lock = await outlook.getMailboxLock('Clients/Sharma Steel');
      try {
        const subjects: string[] = [];
        for await (const msg of outlook.fetch('1:*', { envelope: true })) subjects.push(msg.envelope?.subject ?? '');
        expect(subjects).toEqual(['Order from Sharma']);
      } finally {
        lock.release();
      }
    } finally {
      await outlook.logout().catch(() => {});
    }
  });

  it('rejects a wrong password', async () => {
    const bad = new ImapFlow({ host: '127.0.0.1', port: core.ports.imap!, secure: false, auth: { user, pass: 'nope' }, logger: false, tls: { rejectUnauthorized: false } });
    await expect(bad.connect()).rejects.toThrow();
  });

  it('APPENDs and FETCHes byte-exact source, envelope and structure', async () => {
    const raw = complexMessage();
    const res = await client.append('INBOX', raw, ['\\Seen']);
    expect(res).toBeTruthy();
    const ar = res as { uid: number; uidValidity: bigint };
    const lock = await client.getMailboxLock('INBOX');
    try {
      const msg = await client.fetchOne(String(ar.uid), { source: true, envelope: true, bodyStructure: true, flags: true, size: true }, { uid: true });
      expect(msg).toBeTruthy();
      const m = msg as Exclude<typeof msg, false | undefined>;
      expect(m.source!.toString()).toBe(raw);
      expect(m.size).toBe(Buffer.byteLength(raw));
      expect(m.envelope!.subject).toBe('Re: Café plans');
      expect(m.envelope!.from![0]!.address).toBe('asa@example.com');
      expect(m.flags!.has('\\Seen')).toBe(true);
      expect(m.bodyStructure!.childNodes!.map((n) => n.type)).toEqual(['multipart/alternative', 'application/pdf', 'message/rfc822']);

      const part = await client.download(String(ar.uid), '1.1', { uid: true });
      const chunks: Buffer[] = [];
      for await (const c of part.content!) chunks.push(c as Buffer);
      expect(Buffer.concat(chunks).toString()).toBe('Café at nine? searchable-token');
    } finally {
      lock.release();
    }
  });

  it('BODY.PEEK does not set \\Seen', async () => {
    const r = (await client.append('INBOX', simpleMessage({ subject: 'peek test' }))) as { uid: number };
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.fetchOne(String(r.uid), { source: true, headers: true }, { uid: true }); // BODY.PEEK[]
      const m = (await client.fetchOne(String(r.uid), { flags: true }, { uid: true })) as { flags: Set<string> };
      expect(m.flags.has('\\Seen')).toBe(false);
    } finally {
      lock.release();
    }
  });

  it('SEARCHes flags, headers (decoded) and QP-decoded body text', async () => {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const unseen = await client.search({ seen: false }, { uid: true });
      const all = await client.search({ all: true }, { uid: true });
      expect(Array.isArray(all) && all.length).toBeGreaterThanOrEqual(2);
      expect(unseen).not.toEqual(all);
      expect(await client.search({ subject: 'café' }, { uid: true })).toHaveLength(1);
      expect(await client.search({ body: 'searchable-token' }, { uid: true })).toHaveLength(1);
      expect(await client.search({ from: 'asa@example.com' }, { uid: true })).toHaveLength(1);
      expect(await client.search({ larger: 100000 }, { uid: true })).toHaveLength(0);
    } finally {
      lock.release();
    }
  });

  it('stores flags/keywords and MOVEs with COPYUID', async () => {
    const r = (await client.append('INBOX', simpleMessage({ subject: 'to archive' }))) as { uid: number };
    const lock = await client.getMailboxLock('INBOX');
    try {
      await client.messageFlagsAdd(String(r.uid), ['\\Flagged', '$Label1'], { uid: true });
      const m = (await client.fetchOne(String(r.uid), { flags: true }, { uid: true })) as { flags: Set<string> };
      expect([...m.flags].sort()).toEqual(['$Label1', '\\Flagged']);
      const before = (client.mailbox as { exists: number }).exists;
      const mv = await client.messageMove(String(r.uid), 'Archive', { uid: true });
      expect(mv).toBeTruthy();
      expect((mv as { uidMap: Map<number, number> }).uidMap.get(r.uid)).toBeGreaterThan(0);
      await client.noop();
      expect((client.mailbox as { exists: number }).exists).toBe(before - 1);
    } finally {
      lock.release();
    }
    const st = await client.status('Archive', { messages: true, unseen: true });
    expect(st && st.messages).toBe(1);
  });

  it('creates, renames and deletes folders including non-ASCII names', async () => {
    await client.mailboxCreate('Clients/कानपुर');
    let list = await client.list();
    expect(list.map((m) => m.path)).toContain('Clients/कानपुर');
    await client.mailboxRename('Clients/कानपुर', 'Clients/Agra');
    list = await client.list();
    expect(list.map((m) => m.path)).toContain('Clients/Agra');
    await client.mailboxDelete('Clients/Agra');
    list = await client.list();
    expect(list.map((m) => m.path)).not.toContain('Clients/Agra');
  });

  it('pushes new mail to an IDLE client within seconds of SMTP submission', async () => {
    const idler = newClient();
    await idler.connect();
    await idler.mailboxOpen('INBOX');
    const start = (idler.mailbox as { exists: number }).exists;
    const got = new Promise<number>((resolve) => idler.on('exists', (d: { count: number }) => resolve(d.count)));
    void idler.idle();
    await new Promise((r) => setTimeout(r, 200));

    const t0 = Date.now();
    const smtp = nodemailer.createTransport({
      host: '127.0.0.1',
      port: core.ports.submission!,
      secure: false,
      auth: { user: colleague, pass: PASS },
      tls: { rejectUnauthorized: false },
    });
    await smtp.sendMail({ from: colleague, to: user, subject: 'IDLE push', text: 'ping' });
    const count = await Promise.race([got, new Promise<number>((_, rej) => setTimeout(() => rej(new Error('no IDLE push')), 5000))]);
    expect(count).toBe(start + 1);
    expect(Date.now() - t0).toBeLessThan(3000);
    await idler.logout();
  });

  it('sees changes made by another connection (flags + expunge) on NOOP', async () => {
    const other = newClient();
    await other.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const uids = (await client.search({ all: true }, { uid: true })) as number[];
      const target = uids[uids.length - 1]!;
      await other.mailboxOpen('INBOX');
      const flagEvent = new Promise((r) => client.once('flags', r));
      await other.messageFlagsAdd(String(target), ['\\Answered'], { uid: true });
      await client.noop();
      await flagEvent;
      const expEvent = new Promise((r) => client.once('expunge', r));
      await other.messageDelete(String(target), { uid: true });
      await client.noop();
      await expEvent;
      expect(await client.search({ uid: String(target) }, { uid: true })).toEqual([]);
    } finally {
      lock.release();
      await other.logout();
    }
  });
});
