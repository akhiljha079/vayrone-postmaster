import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import nodemailer from 'nodemailer';
import { exec, one, rows } from '../src/db.js';
import { headerValue } from '../src/mime/headers.js';
import { dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from './helpers.js';

const PW = 'Flow#Test1';

describe.skipIf(!dbConfig())('mail flow: rules, forwarding, auto-reply, journaling, loops', () => {
  let core: TestCore;
  const domain = uniqueDomain();
  let n = 0;

  const raw = (o: { subject?: string; from?: string; to?: string; cc?: string; extra?: string; body?: string } = {}) =>
    [
      `From: ${o.from ?? 'Client <client@outside.test>'}`,
      `To: ${o.to ?? `someone@${domain}`}`,
      ...(o.cc ? [`Cc: ${o.cc}`] : []),
      `Subject: ${o.subject ?? `Hello ${++n}`}`,
      `Message-ID: <${randomBytes(6).toString('hex')}@outside.test>`,
      'Date: Mon, 05 Oct 2026 10:00:00 +0000',
      ...(o.extra ? [o.extra] : []),
      '',
      o.body ?? 'Body',
      '',
    ].join('\r\n');

  async function user(local: string): Promise<{ id: number; email: string }> {
    const email = `${local}-${++n}@${domain}`;
    return { id: await makeUser(core.ctx, email, PW), email };
  }

  async function receive(userIds: number[], r: string, envelopeFrom = 'client@outside.test', direction: 'in' | 'internal' = 'in', senderUserId: number | null = null) {
    const message = await core.ctx.store.ingest(Buffer.from(r));
    return core.ctx.mailflow.inbound({ message, recipients: userIds.map((userId) => ({ userId })), origin: 'fetch', direction, envelopeFrom, senderUserId });
  }

  const folderCount = async (userId: number, path: string) => (await core.ctx.store.getFolder(userId, path))?.message_count ?? null;
  const lastRaw = async (userId: number, path = 'INBOX') => {
    const f = (await core.ctx.store.getFolder(userId, path))!;
    const uids = await core.ctx.store.listUids(f.id);
    const [it] = await core.ctx.store.itemsFull(f.id, uids.slice(-1));
    return { raw: (await core.ctx.store.loadRaw(it!)).toString(), flags: it!.flags };
  };
  const queue = (source: string) =>
    rows<{ id: number; envelope_from: string; rcpts: string; message_id: number }>(
      core.ctx.db,
      `SELECT q.id, q.envelope_from, q.message_id, GROUP_CONCAT(r.rcpt) rcpts FROM outbound_queue q JOIN outbound_recipients r ON r.queue_id = q.id
        WHERE q.source = ? GROUP BY q.id ORDER BY q.id`,
      [source],
    );
  const queuedRaw = async (messageId: number) => {
    const m = await one<{ storage_path: string; codec: number }>(core.ctx.db, 'SELECT storage_path, codec FROM messages WHERE id = ?', [messageId]);
    return (await core.ctx.store.loadRaw(m!)).toString();
  };
  async function addRule(scope: 'global' | 'user', userId: number | null, position: number, conditions: unknown[], actions: unknown[], extra: Record<string, unknown> = {}) {
    const r = await exec(
      core.ctx.db,
      `INSERT INTO mail_rules (scope, user_id, name, position, stage, match_mode, conditions, actions, stop_processing, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [scope, userId, `rule ${position}`, position, extra.stage ?? 'inbound', 'all', JSON.stringify(conditions), JSON.stringify(actions), extra.stop ? 1 : 0, new Date(), new Date()],
    );
    core.ctx.mailflow.invalidateRules();
    return r.insertId;
  }

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(domain);
  });
  beforeEach(async () => {
    await exec(core.ctx.db, "DELETE FROM mail_rules WHERE scope = 'global'");
    await exec(core.ctx.db, 'DELETE FROM journal_rules');
    core.ctx.mailflow.invalidateRules();
  });
  afterAll(() => core.stop());

  it('global rules run before user rules: move, mark read, flag, copy, add header', async () => {
    const u = await user('acct');
    await addRule('global', null, 1, [{ field: 'subject', op: 'contains', value: 'invoice' }], [{ type: 'move', folder: 'Accounts/Invoices' }, { type: 'add_header', name: 'X-Category', value: 'finance' }]);
    await addRule('user', u.id, 1, [{ field: 'from', op: 'domain_is', value: 'outside.test' }], [{ type: 'flag' }, { type: 'mark_read' }, { type: 'copy', folder: 'Clients' }]);
    const [o] = await receive([u.id], raw({ subject: 'Invoice #77' }));
    expect(o!.status).toBe('delivered');
    expect(await folderCount(u.id, 'Accounts/Invoices')).toBe(1); // auto-created
    expect(await folderCount(u.id, 'Clients')).toBe(1);
    expect(await folderCount(u.id, 'INBOX')).toBe(0);
    const { raw: stored, flags } = await lastRaw(u.id, 'Accounts/Invoices');
    expect(stored).toMatch(/^X-Category: finance\r\n/);
    expect(flags & 5).toBe(5); // \Seen + \Flagged
    const hits = await one<{ hit_count: number }>(core.ctx.db, "SELECT hit_count FROM mail_rules WHERE scope = 'global' LIMIT 1");
    await new Promise((r) => setTimeout(r, 50));
    expect(Number((await one<{ hit_count: number }>(core.ctx.db, "SELECT hit_count FROM mail_rules WHERE scope = 'global' LIMIT 1"))!.hit_count)).toBeGreaterThanOrEqual(Number(hits?.hit_count ?? 0));
  });

  it('discard stores nothing; a re-download of discarded mail is recognised as duplicate', async () => {
    const u = await user('disc');
    await addRule('user', u.id, 1, [{ field: 'subject', op: 'contains', value: 'lottery' }], [{ type: 'discard' }]);
    const r = raw({ subject: 'You won the lottery' });
    expect((await receive([u.id], r))[0]!.status).toBe('discarded');
    expect((await receive([u.id], r))[0]!.status).toBe('duplicate');
    expect(await folderCount(u.id, 'INBOX')).toBe(0);
  });

  it('forwarding with a local copy: DMARC-safe From rewrite, loop marker, never forwarded twice', async () => {
    const u = await user('fwd');
    await exec(core.ctx.db, 'INSERT INTO forwardings (user_id, target_address, keep_local_copy, created_at) VALUES (?,?,1,?)', [u.id, 'ravi.personal@gmail.test', new Date()]);
    const before = (await queue('forward')).length;
    const r = raw({ subject: 'Quote request', from: 'Big Client <buyer@bigclient.test>' });
    await receive([u.id], r);
    await receive([u.id], r); // provider re-download
    const q = (await queue('forward')).slice(before);
    expect(q).toHaveLength(1);
    expect(q[0]!.rcpts).toBe('ravi.personal@gmail.test');
    expect(q[0]!.envelope_from).toBe(u.email);
    const fwd = await queuedRaw(q[0]!.message_id);
    expect(headerValue(Buffer.from(fwd), 'From')).toMatch(/^"Big Client via .*" <fwd-\d+@/);
    expect(headerValue(Buffer.from(fwd), 'Reply-To')).toBe('Big Client <buyer@bigclient.test>');
    expect(headerValue(Buffer.from(fwd), 'X-VPM-Loop')).toBe('testinstall');
    expect(await folderCount(u.id, 'INBOX')).toBe(1);
  });

  it('redirect (no local copy) and redirect to a colleague with no duplicates', async () => {
    const leaver = await user('leaver');
    const manager = await user('manager');
    await exec(core.ctx.db, 'INSERT INTO forwardings (user_id, target_address, keep_local_copy, created_at) VALUES (?,?,0,?)', [leaver.id, manager.email, new Date()]);
    // The manager is also on Cc, so the redirected copy must be suppressed as a duplicate.
    await receive([leaver.id, manager.id], raw({ to: leaver.email, cc: manager.email }));
    expect(await folderCount(leaver.id, 'INBOX')).toBe(0);
    expect(await folderCount(manager.id, 'INBOX')).toBe(1);
    await receive([leaver.id], raw({ to: leaver.email }));
    expect(await folderCount(manager.id, 'INBOX')).toBe(2);
  });

  it('forward loops between two mailboxes terminate', async () => {
    const a = await user('loopa');
    const b = await user('loopb');
    await exec(core.ctx.db, 'INSERT INTO forwardings (user_id, target_address, keep_local_copy, created_at) VALUES (?,?,1,?), (?,?,1,?)', [a.id, b.email, new Date(), b.id, a.email, new Date()]);
    await receive([a.id], raw({ to: a.email, subject: 'ping-pong' }));
    expect(await folderCount(a.id, 'INBOX')).toBe(1);
    expect(await folderCount(b.id, 'INBOX')).toBe(1);
    // Mail that already carries our loop marker is delivered but never forwarded.
    const c = await user('loopc');
    await exec(core.ctx.db, 'INSERT INTO forwardings (user_id, target_address, keep_local_copy, created_at) VALUES (?,?,1,?)', [c.id, 'out@elsewhere.test', new Date()]);
    const before = (await queue('forward')).length;
    await receive([c.id], raw({ extra: 'X-VPM-Loop: testinstall' }));
    expect(await folderCount(c.id, 'INBOX')).toBe(1);
    expect((await queue('forward')).length).toBe(before);
    expect(await one(core.ctx.db, "SELECT id FROM mail_log WHERE event = 'loop_blocked' AND user_id = ?", [c.id])).toBeTruthy();
  });

  it('out of office: replies once per sender, honours RFC 3834 suppressions', async () => {
    const u = await user('ooo');
    await exec(core.ctx.db, 'INSERT INTO autoreplies (user_id, is_enabled, subject, body_text, once_per_days, updated_at) VALUES (?,1,?,?,4,?)', [u.id, 'Out of office: {subject}', 'Back on Monday.', new Date()]);
    const before = (await queue('autoreply')).length;
    await receive([u.id], raw({ to: u.email, subject: 'Meeting?' }), 'client@outside.test');
    await receive([u.id], raw({ to: u.email, subject: 'Meeting again?' }), 'client@outside.test'); // same sender: suppressed
    await receive([u.id], raw({ to: u.email, extra: 'List-Id: <news.outside.test>' }), 'news@outside.test');
    await receive([u.id], raw({ to: u.email, extra: 'Auto-Submitted: auto-generated' }), 'robot@outside.test');
    await receive([u.id], raw({ to: `someone-else@${domain}` }), 'bcc-sender@outside.test'); // we were only Bcc'd
    await receive([u.id], raw({ to: u.email }), 'noreply@outside.test');
    const q = (await queue('autoreply')).slice(before);
    expect(q.map((x) => x.rcpts)).toEqual(['client@outside.test']);
    const reply = Buffer.from(await queuedRaw(q[0]!.message_id));
    expect(headerValue(reply, 'Subject')).toBe('Out of office: Meeting?');
    expect(headerValue(reply, 'Auto-Submitted')).toBe('auto-replied');
    expect(headerValue(reply, 'In-Reply-To')).toMatch(/@outside\.test>$/);
    expect(headerValue(reply, 'X-VPM-Loop')).toBe('testinstall');
  });

  it('journaling: selected inbound mail of a group goes to a local compliance mailbox', async () => {
    const member = await user('sales');
    const other = await user('hr');
    const archive = await user('compliance');
    const g = await exec(core.ctx.db, 'INSERT INTO user_groups (name, created_at) VALUES (?,?)', [`Sales ${domain}`, new Date()]);
    await exec(core.ctx.db, 'INSERT INTO user_group_members (group_id, user_id) VALUES (?,?)', [g.insertId, member.id]);
    await exec(
      core.ctx.db,
      `INSERT INTO journal_rules (name, direction, scope, scope_id, include_internal, conditions, target_address, created_at) VALUES ('sales in','in','group',?,1,?,?,?)`,
      [g.insertId, JSON.stringify([{ field: 'subject', op: 'contains', value: 'order' }]), archive.email, new Date()],
    );
    await receive([member.id], raw({ subject: 'New order 991' }));
    await receive([member.id], raw({ subject: 'Lunch?' })); // condition not met
    await receive([other.id], raw({ subject: 'Order for HR' })); // not in the group
    expect(await folderCount(archive.id, 'INBOX')).toBe(1);
    const j = Buffer.from((await lastRaw(archive.id)).raw);
    expect(headerValue(j, 'X-VPM-Journal')).toBe('in');
    expect(headerValue(j, 'X-VPM-Journal-Envelope-To')).toBe(member.email);
    expect(headerValue(j, 'Subject')).toBe('New order 991');
  });

  it('LAN submission: outbound rules reject (550) or tag mail; outbound journaling to an outside archive', async () => {
    const sender = await user('sender');
    const colleague = await user('colleague');
    await addRule('global', null, 1, [{ field: 'attachment_ext', op: 'in', value: 'exe' }], [{ type: 'reject', message: 'Executable attachments are not allowed' }], { stage: 'outbound' });
    await addRule('global', null, 2, [], [{ type: 'add_header', name: 'X-Company-Disclaimer', value: 'sent-from-lan' }], { stage: 'outbound' });
    await exec(core.ctx.db, "INSERT INTO journal_rules (name, direction, scope, include_internal, target_address, created_at) VALUES ('all out','out','all',0,'archive@vault.test',?)", [new Date()]);
    const t = nodemailer.createTransport({ host: '127.0.0.1', port: core.ports.submission!, secure: false, auth: { user: sender.email, pass: PW }, tls: { rejectUnauthorized: false } });

    await expect(t.sendMail({ from: sender.email, to: 'buyer@outside.test', subject: 'tool', text: 'x', attachments: [{ filename: 'setup.exe', content: 'MZ' }] })).rejects.toThrow(/550.*Executable/);

    const jBefore = (await queue('journal')).length;
    await t.sendMail({ from: sender.email, to: ['buyer@outside.test', colleague.email], subject: 'Proposal', text: 'see attached' });
    const sub = (await queue('submission')).pop()!;
    expect(sub.rcpts).toBe('buyer@outside.test');
    expect(await queuedRaw(sub.message_id)).toMatch(/^X-Company-Disclaimer: sent-from-lan\r\n/);
    expect(await folderCount(colleague.id, 'INBOX')).toBe(1); // local copy unaffected by outbound rules
    const j = (await queue('journal')).slice(jBefore);
    expect(j.map((x) => x.rcpts)).toEqual(['archive@vault.test']);
    expect(j[0]!.envelope_from).toBe('');
    expect(headerValue(Buffer.from(await queuedRaw(j[0]!.message_id)), 'X-VPM-Journal-Envelope-To')).toBe(`buyer@outside.test, ${colleague.email}`);

    // Internal-only mail is not journaled when include_internal is off.
    await t.sendMail({ from: sender.email, to: colleague.email, subject: 'internal', text: 'x' });
    expect((await queue('journal')).length).toBe(jBefore + 1);
  });

  it('an inbound reject rule on internal mail tells the sender', async () => {
    const boss = await user('boss');
    const intern = await user('intern');
    await addRule('user', boss.id, 1, [{ field: 'from', op: 'equals', value: intern.email }], [{ type: 'reject', message: 'Please go through your team lead' }]);
    const [o] = await receive([boss.id], raw({ from: intern.email, to: boss.email }), intern.email, 'internal', intern.id);
    expect(o!.status).toBe('rejected');
    expect(await folderCount(boss.id, 'INBOX')).toBe(0);
    const notice = (await lastRaw(intern.id)).raw;
    expect(notice).toContain('Undelivered Mail Returned to Sender');
    expect(notice).toContain('Please go through your team lead');
  });
});
