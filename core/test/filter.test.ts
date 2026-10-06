import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { ZipArchive } from 'archiver';
import { parseMessage } from '../src/mime/mime.js';
import { blockedAttachments, DEFAULT_BLOCKED_EXTENSIONS, listAttachments } from '../src/filter/attachments.js';
import { builtinScore } from '../src/filter/spam.js';
import { clamScan } from '../src/filter/clamav.js';
import { closeQuarantine, type QuarantineRow } from '../src/filter/quarantine.js';
import { exec, one, rows } from '../src/db.js';
import { dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from './helpers.js';

const EICAR = 'X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*';

function mail(o: { from?: string; to?: string; subject?: string; headers?: string[]; body?: string; attach?: { name: string; data: Buffer; rfc2231?: boolean }[] }): Buffer {
  const b = 'BOUNDARY42';
  const head = [`From: ${o.from ?? 'Sender <sender@vendor.test>'}`, `To: ${o.to ?? 'x@local.test'}`, `Subject: ${o.subject ?? 'Hello'}`, `Date: ${new Date().toUTCString()}`, `Message-ID: <${Math.random()}@vendor.test>`, ...(o.headers ?? []), 'MIME-Version: 1.0'];
  if (!o.attach?.length) return Buffer.from([...head, 'Content-Type: text/plain; charset=utf-8', '', o.body ?? 'Hi there.', ''].join('\r\n'));
  const parts = [`--${b}`, 'Content-Type: text/plain; charset=utf-8', '', o.body ?? 'See attached.', ''];
  for (const a of o.attach) {
    const disp = a.rfc2231 ? `attachment; filename*=UTF-8''${encodeURIComponent(a.name)}` : `attachment; filename="${a.name}"`;
    parts.push(`--${b}`, `Content-Type: application/octet-stream`, `Content-Disposition: ${disp}`, 'Content-Transfer-Encoding: base64', '', a.data.toString('base64').replace(/.{76}/g, '$&\r\n'), '');
  }
  parts.push(`--${b}--`, '');
  return Buffer.from([...head, `Content-Type: multipart/mixed; boundary="${b}"`, '', ...parts].join('\r\n'));
}

async function zipOf(files: Record<string, string>): Promise<Buffer> {
  const z = new ZipArchive({ zlib: { level: 1 } });
  const done = buffer(z.pipe(new PassThrough()));
  for (const [n, c] of Object.entries(files)) z.append(c, { name: n });
  await z.finalize();
  return done;
}

/** Minimal clamd speaking INSTREAM; reports EICAR. */
function fakeClamd(): Promise<{ server: net.Server; port: number }> {
  const server = net.createServer((s) => {
    let buf = Buffer.alloc(0);
    s.on('data', (d: Buffer) => {
      buf = Buffer.concat([buf, d]);
      if (buf.length >= 4 && buf.subarray(buf.length - 4).equals(Buffer.alloc(4))) {
        s.end(buf.includes(Buffer.from('EICAR-STANDARD-ANTIVIRUS-TEST-FILE')) ? 'stream: Win.Test.EICAR_HDB-1 FOUND\0' : 'stream: OK\0');
      }
    });
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, port: (server.address() as net.AddressInfo).port })));
}

describe('attachment detection', () => {
  it('finds names (also RFC 2231 and inside ZIP files) and matches dangerous types', async () => {
    const raw = mail({
      attach: [
        { name: 'quotation.pdf', data: Buffer.from('%PDF-1.4') },
        { name: 'चालान .exe', data: Buffer.from('MZ'), rfc2231: true },
        { name: 'docs.zip', data: await zipOf({ 'readme.txt': 'hi', 'tools/setup.scr': 'x' }) },
      ],
    });
    const list = listAttachments(raw, parseMessage(raw).tree);
    expect(list.map((a) => a.display)).toEqual(['quotation.pdf', 'चालान .exe', 'docs.zip', 'docs.zip → readme.txt', 'docs.zip → tools/setup.scr']);
    expect(blockedAttachments(list, DEFAULT_BLOCKED_EXTENSIONS).map((a) => a.display)).toEqual(['चालान .exe', 'docs.zip → tools/setup.scr']);
    expect(blockedAttachments(listAttachments(raw, parseMessage(raw).tree, { scanZip: false }), DEFAULT_BLOCKED_EXTENSIONS).map((a) => a.display)).toEqual(['चालान .exe']);
    expect(blockedAttachments([{ filename: 'invoice.pdf.exe. ', display: '', size: 0 }], ['exe'])).toHaveLength(1);
  });
});

describe('built-in spam rules', () => {
  it('scores obvious spam and the provider verdict high, normal mail low', () => {
    const ham = mail({ subject: 'Delivery schedule for Monday', body: 'Please confirm the truck timing.' });
    expect(builtinScore(ham, parseMessage(ham)).score).toBeLessThan(2);
    const flagged = mail({ headers: ['X-Spam-Flag: YES'] });
    expect(builtinScore(flagged, parseMessage(flagged))).toMatchObject({ score: expect.any(Number), rules: expect.arrayContaining(['PROVIDER_SPAM_FLAG(5)']) });
    const phish = mail({
      from: '"support@yourbank.com" <alerts@bad-domain.test>',
      subject: 'URGENT RESPONSE NEEDED!!! VERIFY YOUR ACCOUNT',
      headers: ['Authentication-Results: mx.test; spf=fail; dmarc=fail'],
      body: '<html><a href="http://evil.test/login">www.yourbank.com</a> Your account has been suspended, click here</html>',
    });
    const s = builtinScore(phish, parseMessage(phish));
    expect(s.score).toBeGreaterThanOrEqual(10);
    expect(s.rules.join(' ')).toMatch(/FROM_NAME_SPOOFS_ADDRESS.*|DMARC_FAIL/);
  });
});

describe('ClamAV client', () => {
  it('reports viruses, clean data and connection errors', async () => {
    const { server, port } = await fakeClamd();
    try {
      expect(await clamScan(Buffer.from(`file ${EICAR}`), { port })).toEqual({ clean: false, signature: 'Win.Test.EICAR_HDB-1' });
      expect(await clamScan(Buffer.alloc(200_000, 65), { port })).toEqual({ clean: true });
    } finally {
      server.close();
    }
    await expect(clamScan(Buffer.from('x'), { port: 1 })).rejects.toThrow(/not reachable/);
  });
});

describe.skipIf(!dbConfig())('filtering in the mail flow', () => {
  let core: TestCore;
  let alice: number;
  let clamd: { server: net.Server; port: number };
  const domain = uniqueDomain();
  const fetch = (raw: Buffer, userId = alice) => core.ctx.store.ingest(raw).then((message) => core.ctx.mailflow.inbound({ message, recipients: [{ userId }], origin: 'fetch', direction: 'in', envelopeFrom: 'sender@vendor.test' }));
  const folderCount = async (su: 'inbox' | 'junk') => (await core.ctx.store.getFolderById((await core.ctx.store.getSpecialFolder(alice, su))!.id))!.message_count;

  beforeAll(async () => {
    core = await startCore();
    clamd = await fakeClamd();
    await core.ctx.directory.createDomain(domain);
    alice = await makeUser(core.ctx, `alice@${domain}`);
    await core.ctx.settings.set('filter', 'config', { antivirus: { engine: 'clamav', host: '127.0.0.1', port: clamd.port, socket: null, onError: 'deliver' } }, null);
  });
  afterAll(async () => {
    clamd.server.close();
    await exec(core.ctx.db, "DELETE FROM settings WHERE namespace = 'filter'");
    await core.stop();
  });

  it('holds a blocked attachment once, tells the user, and releases it on request', async () => {
    const inbox0 = await folderCount('inbox');
    const raw = mail({ subject: 'Your invoice', attach: [{ name: 'invoice.exe', data: Buffer.from('MZ...') }] });
    expect(await fetch(raw)).toEqual([{ userId: alice, status: 'quarantined' }]);
    expect(await fetch(raw)).toEqual([{ userId: alice, status: 'duplicate' }]); // fetched again: not held twice
    const q = (await rows<QuarantineRow>(core.ctx.db, "SELECT * FROM quarantine WHERE kind = 'attachment' AND subject = 'Your invoice'"))!;
    expect(q).toHaveLength(1);
    expect(q[0]!.reason).toBe('Blocked attachment type: invoice.exe');
    expect(await folderCount('inbox')).toBe(inbox0 + 1); // only the notice
    const notice = await one<{ hdr_subject: string }>(core.ctx.db, 'SELECT m.hdr_subject FROM mail_items i JOIN messages m ON m.id = i.message_id WHERE i.user_id = ? ORDER BY i.id DESC LIMIT 1', [alice]);
    expect(notice!.hdr_subject).toBe('Message held for safety: Your invoice');

    const before = (await one<{ refcount: number }>(core.ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [q[0]!.message_id]))!.refcount;
    const out = await core.ctx.mailflow.releaseHeld(q[0]!, [{ userId: alice }]);
    await closeQuarantine(core.ctx.db, q[0]!.id, 'released', null);
    expect(out[0]).toMatchObject({ status: 'delivered' });
    expect(await folderCount('inbox')).toBe(inbox0 + 2);
    expect((await one<{ refcount: number }>(core.ctx.db, 'SELECT refcount FROM messages WHERE id = ?', [q[0]!.message_id]))!.refcount).toBe(before); // +1 delivered, −1 quarantine
  });

  it('viruses are held; if ClamAV is down mail is delivered and an alert raised', async () => {
    expect(await fetch(mail({ subject: 'Scan me', body: `test ${EICAR}` }))).toEqual([{ userId: alice, status: 'quarantined' }]);
    expect(await one(core.ctx.db, "SELECT id FROM quarantine WHERE kind = 'virus' AND reason = 'Virus found: Win.Test.EICAR_HDB-1'")).toBeTruthy();
    await core.ctx.settings.set('filter', 'config', { antivirus: { engine: 'clamav', host: '127.0.0.1', port: 1, socket: null, onError: 'deliver' } }, null);
    expect(await fetch(mail({ subject: 'Unscanned' }))).toMatchObject([{ status: 'delivered' }]);
    expect(await one(core.ctx.db, "SELECT id FROM admin_alerts WHERE dedupe_key = 'filter.av_unavailable' AND resolved_at IS NULL")).toBeTruthy();
    await core.ctx.settings.set('filter', 'config', { antivirus: { engine: 'clamav', host: '127.0.0.1', port: clamd.port, socket: null, onError: 'deliver' } }, null);
  });

  it('spam goes to Junk with a score header; the user can allow or block a sender', async () => {
    const junk0 = await folderCount('junk');
    const spam = () => mail({ from: 'Prize Team <win@lotto.test>', subject: 'YOU HAVE WON THE KBC LOTTERY!!!', headers: ['X-Spam-Flag: YES'], body: 'Claim your prize now' });
    expect(await fetch(spam())).toMatchObject([{ status: 'delivered' }]);
    expect(await folderCount('junk')).toBe(junk0 + 1);
    const hdr = await one<{ header_raw: Buffer }>(core.ctx.db, 'SELECT m.header_raw FROM mail_items i JOIN messages m ON m.id = i.message_id WHERE i.user_id = ? ORDER BY i.id DESC LIMIT 1', [alice]);
    expect(hdr!.header_raw.toString()).toMatch(/X-VPM-Spam: Yes\r\nX-VPM-Spam-Score: \d+(\.\d)? \(builtin\) PROVIDER_SPAM_FLAG/);

    await core.ctx.mailflow.filter!.learnSender(alice, 'Prize Team <win@lotto.test>', 'allow');
    const inbox0 = await folderCount('inbox');
    await fetch(spam());
    expect(await folderCount('inbox')).toBe(inbox0 + 1);
    await core.ctx.mailflow.filter!.learnSender(alice, 'boss@vendor.test', 'block');
    await fetch(mail({ from: 'Boss <boss@vendor.test>', subject: 'Normal looking mail' }));
    expect(await folderCount('junk')).toBe(junk0 + 2);
  });
});
