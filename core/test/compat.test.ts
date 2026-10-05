// Client-compatibility transcripts. These replay the command sequences that
// Outlook (2016/2019/365 desktop) and Thunderbird send during account setup,
// initial sync, reading, flagging, deleting and IDLE, and assert the
// response shapes those clients depend on. The "switch away and back" suite
// is the acceptance test for docs/ARCHITECTURE.md §7.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from '../src/migrate.js';
import { join, resolve } from 'node:path';
import { RawClient, dbConfig, makeUser, startCore, uniqueDomain, type TestCore } from './helpers.js';
import { complexMessage, simpleMessage } from './fixtures.js';

const PASS = 'Outlook#2026';

async function seed(core: TestCore, email: string, n: number): Promise<void> {
  const id = (await core.ctx.directory.findUserIdByLogin(email))!;
  for (let i = 0; i < n; i++) {
    const message = await core.ctx.store.ingest(Buffer.from(i === 0 ? complexMessage() : simpleMessage({ subject: `Seed ${i}` })));
    await core.ctx.delivery.deliver({ message, targets: [{ userId: id }], origin: 'fetch', envelopeFrom: 'x@y' });
  }
}

/** Extracts literal payloads that follow a given label in raw IMAP output. */
function literalsAfter(text: string, label: string): string[] {
  const out: string[] = [];
  let i = 0;
  for (;;) {
    const at = text.indexOf(label + ' {', i);
    if (at === -1) return out;
    const close = text.indexOf('}', at);
    const n = Number(text.slice(at + label.length + 2, close));
    const start = close + 3; // }\r\n
    out.push(text.slice(start, start + n));
    i = start + n;
  }
}

describe.skipIf(!dbConfig())('client compatibility transcripts', () => {
  let core: TestCore;
  const domain = uniqueDomain();
  const email = `outlook.user@${domain}`;

  beforeAll(async () => {
    core = await startCore();
    await core.ctx.directory.createDomain(domain);
    await makeUser(core.ctx, email, PASS);
    await seed(core, email, 3);
  });
  afterAll(() => core.stop());

  it('Outlook desktop: setup, header sync, body download, flag, delete, IDLE', async () => {
    const c = await RawClient.connect(core.ports.imap!);
    const greet = await c.readUntil(/\r\n/);
    expect(greet).toMatch(/^\* OK \[CAPABILITY [^\]]*IMAP4rev1[^\]]*\]/);

    expect((await c.imap('CAPABILITY')).text).toMatch(/\* CAPABILITY .*IDLE.*UIDPLUS.*MOVE/);
    const login = await c.imap(`LOGIN "${email}" "${PASS}"`);
    expect(login.status).toBe('OK');
    expect(login.text).toMatch(/OK \[CAPABILITY /);

    const list = await c.imap('LIST "" "*"');
    expect(list.text).toContain('* LIST (\\HasNoChildren) "/" INBOX');
    expect(list.text).toContain('* LIST (\\HasNoChildren \\Sent) "/" Sent');
    expect(list.text).toContain('\\Trash) "/" Trash');
    expect((await c.imap('LSUB "" "*"')).text).toContain('* LSUB');

    const sel = await c.imap('SELECT "INBOX"');
    expect(sel.text).toMatch(/\* 3 EXISTS/);
    expect(sel.text).toMatch(/\* OK \[UIDVALIDITY \d+\]/);
    expect(sel.text).toMatch(/\* OK \[UIDNEXT \d+\]/);
    expect(sel.text).toMatch(/\* FLAGS \(/);
    expect(sel.text).toMatch(/T\d+ OK \[READ-WRITE\]/);

    // Outlook's flag sync
    const flags = await c.imap('UID FETCH 1:* (UID FLAGS)');
    const uids = [...flags.text.matchAll(/FETCH \(UID (\d+) FLAGS \(/g)].map((m) => Number(m[1]));
    expect(uids).toHaveLength(3);

    // Outlook's header download
    const hdr = await c.imap(
      `UID FETCH ${uids.join(',')} (UID RFC822.SIZE FLAGS BODY.PEEK[HEADER.FIELDS (From To Cc Bcc Subject Date Message-ID Priority X-Priority References Newsgroups In-Reply-To Content-Type Reply-To)])`,
    );
    const headerBlocks = literalsAfter(hdr.text, 'BODY[HEADER.FIELDS (From To Cc Bcc Subject Date Message-ID Priority X-Priority References Newsgroups In-Reply-To Content-Type Reply-To)]');
    expect(headerBlocks).toHaveLength(3);
    for (const h of headerBlocks) {
      expect(h.endsWith('\r\n\r\n')).toBe(true);
      expect(h).toMatch(/^(From|To|Subject|Date|Message-ID|Content-Type|Cc):/m);
      expect(h).not.toMatch(/^MIME-Version:/m);
    }
    expect(hdr.text).not.toMatch(/\\Seen/); // PEEK must not mark read

    // Full body download: RFC822.SIZE must equal the literal length exactly
    const body = await c.imap(`UID FETCH ${uids[0]} (UID RFC822.SIZE BODY.PEEK[])`);
    const size = Number(/RFC822\.SIZE (\d+)/.exec(body.text)![1]);
    const [src] = literalsAfter(body.text, 'BODY[]');
    expect(Buffer.byteLength(src!, 'latin1')).toBe(size);

    // Mark read
    const st = await c.imap(`UID STORE ${uids[0]} +FLAGS (\\Seen)`);
    expect(st.text).toMatch(new RegExp(`\\* \\d+ FETCH \\(UID ${uids[0]} FLAGS \\(\\\\Seen\\)\\)`));

    // Delete = copy to Trash + \Deleted + expunge
    const cp = await c.imap(`UID COPY ${uids[2]} "Trash"`);
    expect(cp.text).toMatch(/OK \[COPYUID \d+ \d+ \d+\]/);
    await c.imap(`UID STORE ${uids[2]} +FLAGS.SILENT (\\Deleted)`);
    const ex = await c.imap('EXPUNGE');
    expect(ex.text).toMatch(/\* 3 EXPUNGE/);

    // IDLE and push
    c.write('I1 IDLE\r\n');
    await c.readUntil(/\+ idling\r\n/);
    const id = (await core.ctx.directory.findUserIdByLogin(email))!;
    const message = await core.ctx.store.ingest(Buffer.from(simpleMessage({ subject: 'during idle' })));
    await core.ctx.delivery.deliver({ message, targets: [{ userId: id }], origin: 'fetch', envelopeFrom: 'x@y' });
    expect(await c.readUntil(/\* 3 EXISTS\r\n/)).toBeTruthy();
    c.write('DONE\r\n');
    await c.readUntil(/I1 OK IDLE terminated\r\n/);

    const out = await c.imap('LOGOUT');
    expect(out.text).toContain('* BYE');
  });

  it('Thunderbird: AUTHENTICATE PLAIN (SASL-IR), CONDSTORE, partial body, MOVE', async () => {
    const c = await RawClient.connect(core.ports.imap!);
    await c.readUntil(/\r\n/);
    const ir = Buffer.from(`\0${email}\0${PASS}`).toString('base64');
    expect((await c.imap(`AUTHENTICATE PLAIN ${ir}`)).status).toBe('OK');
    expect((await c.imap('ID ("name" "Thunderbird" "version" "128.0")')).text).toContain('* ID ("name" "Vayrone PostMaster"');
    expect((await c.imap('ENABLE CONDSTORE')).text).toContain('* ENABLED CONDSTORE');
    const ns = await c.imap('NAMESPACE');
    expect(ns.text).toContain('* NAMESPACE (("" "/")) NIL NIL');

    const sel = await c.imap('SELECT "INBOX" (CONDSTORE)');
    const hms = Number(/HIGHESTMODSEQ (\d+)/.exec(sel.text)![1]);
    expect(hms).toBeGreaterThan(0);

    const f = await c.imap('UID FETCH 1:* (FLAGS)');
    expect(f.text).toMatch(/MODSEQ \(\d+\)/);
    const uids = [...f.text.matchAll(/UID (\d+)/g)].map((m) => Number(m[1]));

    // Partial download in chunks like Thunderbird's chunked fetch
    const p = await c.imap(`UID FETCH ${uids[0]} (UID RFC822.SIZE BODY.PEEK[]<0.64>)`);
    expect(p.text).toContain('BODY[]<0> {64}');

    // Non-PEEK section fetch sets \Seen and reports FLAGS
    const nonPeek = await c.imap(`UID FETCH ${uids[1]} (BODY[TEXT])`);
    expect(nonPeek.text).toMatch(/FLAGS \([^)]*\\Seen/);

    // CHANGEDSINCE returns only items modified after the given modseq
    const changed = await c.imap(`UID FETCH 1:* (FLAGS) (CHANGEDSINCE ${hms})`);
    expect([...changed.text.matchAll(/^\* \d+ FETCH /gm)]).toHaveLength(1);

    // Conditional store
    const cond = await c.imap(`UID STORE ${uids[1]} (UNCHANGEDSINCE 1) +FLAGS (\\Flagged)`);
    expect(cond.text).toMatch(/OK \[MODIFIED \d+\]/);

    // MOVE with untagged COPYUID then EXPUNGE
    const mv = await c.imap(`UID MOVE ${uids[0]} "Archive"`);
    expect(mv.text).toMatch(/\* OK \[COPYUID \d+ \d+ \d+\]/);
    expect(mv.text).toMatch(/\* 1 EXPUNGE/);

    // SEARCH with MODSEQ
    const s = await c.imap('UID SEARCH MODSEQ 1');
    expect(s.text).toMatch(/\* SEARCH [\d ]+ \(MODSEQ \d+\)/);

    // Mailbox name with modified UTF-7 (Entwürfe)
    expect((await c.imap('CREATE "Entw&APw-rfe"')).status).toBe('OK');
    expect((await c.imap('LIST "" "Entw*"')).text).toContain('Entw&APw-rfe');
    expect((await c.imap('STATUS "Entw&APw-rfe" (MESSAGES UIDNEXT UIDVALIDITY UNSEEN)')).text).toMatch(/\* STATUS Entw&APw-rfe \(MESSAGES 0 UIDNEXT 1 UIDVALIDITY \d+ UNSEEN 0\)/);

    // APPEND with sync literal (Sent copy)
    const raw = simpleMessage({ subject: 'sent copy' });
    c.write(`A9 APPEND "Sent" (\\Seen) {${Buffer.byteLength(raw)}}\r\n`);
    await c.readUntil(/\+ [^\r\n]*\r\n/);
    c.write(raw + '\r\n');
    expect(await c.readUntil(/A9 OK \[APPENDUID \d+ 1\] APPEND completed\r\n/)).toBeTruthy();

    expect((await c.imap('APPEND "NoSuchFolder" {3+}\r\nabc')).text).toMatch(/NO \[TRYCREATE\]/);
    await c.imap('LOGOUT');
  });

  it('rejects bad input without dropping the connection', async () => {
    const c = await RawClient.connect(core.ports.imap!);
    await c.readUntil(/\r\n/);
    expect((await c.imap('FETCH 1 FLAGS')).status).toBe('BAD'); // not selected
    expect((await c.imap('LOGIN nobody wrong')).text).toMatch(/NO \[AUTHENTICATIONFAILED\]/);
    expect((await c.imap('BOGUS')).status).toBe('BAD');
    await c.imap(`LOGIN "${email}" "${PASS}"`);
    await c.imap('SELECT INBOX');
    expect((await c.imap('FETCH 999 FLAGS')).status).toBe('BAD');
    expect((await c.imap('UID FETCH 999999 FLAGS')).status).toBe('OK'); // no match is not an error
    expect((await c.imap('NOOP')).status).toBe('OK');
    await c.imap('LOGOUT');
  });
});

describe.skipIf(!dbConfig())('switching clients away and back never re-downloads (§7)', () => {
  const domain = uniqueDomain();
  const email = `switch@${domain}`;

  interface Snapshot {
    uidvalidity: Record<string, number>;
    uids: Record<string, number[]>;
    uidl: string[];
  }

  async function snapshot(core: TestCore): Promise<Snapshot> {
    const c = await RawClient.connect(core.ports.imap!);
    await c.readUntil(/\r\n/);
    await c.imap(`LOGIN "${email}" "${PASS}"`);
    const snap: Snapshot = { uidvalidity: {}, uids: {}, uidl: [] };
    for (const box of ['INBOX', 'Archive']) {
      const s = await c.imap(`EXAMINE ${box}`);
      snap.uidvalidity[box] = Number(/UIDVALIDITY (\d+)/.exec(s.text)![1]);
      const r = await c.imap('UID SEARCH ALL');
      snap.uids[box] = (/\* SEARCH([\d ]*)/.exec(r.text)![1] ?? '').trim().split(/\s+/).filter(Boolean).map(Number);
    }
    await c.imap('LOGOUT');
    const p = await RawClient.connect(core.ports.pop3!);
    await p.readUntil(/\r\n/);
    await p.pop(`USER ${email}`);
    await p.pop(`PASS ${PASS}`);
    const u = await p.pop('UIDL', true);
    snap.uidl = u.split('\r\n').slice(1).filter((l) => /^\d+ /.test(l));
    await p.pop('QUIT');
    return snap;
  }

  it('keeps UIDVALIDITY, UIDs and POP3 UIDLs across disconnects, restarts and re-migration', async () => {
    let core = await startCore();
    await core.ctx.directory.createDomain(domain);
    await makeUser(core.ctx, email, PASS);
    await seed(core, email, 5);
    // Some history so UIDs are not simply 1..n
    const id = (await core.ctx.directory.findUserIdByLogin(email))!;
    const inbox = (await core.ctx.store.getSpecialFolder(id, 'inbox'))!;
    const archive = (await core.ctx.store.getSpecialFolder(id, 'archive'))!;
    await core.ctx.store.move(inbox.id, [2], archive.id);
    await core.ctx.store.storeFlags(inbox.id, [3], 'add', 8, null);
    await core.ctx.store.expunge(inbox.id);

    const before = await snapshot(core);
    expect(before.uids['INBOX']).toEqual([1, 4, 5]);
    expect(before.uidl).toHaveLength(3);

    // "Switch to another provider": client gone, service stopped and restarted.
    const dataPath = core.dataPath;
    await core.stop();
    await migrate(dbConfig()!, join(resolve(import.meta.dirname, '..', '..'), 'db')); // upgrade re-run is a no-op
    core = await startCore(dataPath);

    // Mail keeps arriving while the user is away.
    await seed(core, email, 1);

    // "Switch back": same identities; only the new message is new.
    const after = await snapshot(core);
    expect(after.uidvalidity).toEqual(before.uidvalidity);
    expect(after.uids['Archive']).toEqual(before.uids['Archive']);
    expect(after.uids['INBOX']!.slice(0, 3)).toEqual(before.uids['INBOX']);
    expect(after.uids['INBOX']).toHaveLength(4);
    expect(after.uids['INBOX']![3]).toBeGreaterThan(5);
    expect(after.uidl.slice(0, 3)).toEqual(before.uidl);
    expect(after.uidl).toHaveLength(4);
    await core.stop();
  });
});
