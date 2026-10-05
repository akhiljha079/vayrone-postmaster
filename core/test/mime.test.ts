import { describe, expect, it } from 'vitest';
import { parseMessage, resolvePart, parseStructured } from '../src/mime/mime.js';
import { normalizeCrlf } from '../src/store/blobstore.js';
import { bodyStructureValue, envelopeValue, parseSection, sectionBytes } from '../src/imap/fetch.js';
import { encode } from '../src/imap/protocol.js';
import { complexMessage, simpleMessage } from './fixtures.js';

const raw = (s: string) => Buffer.from(s, 'utf8');

describe('MIME indexer', () => {
  it('parses a single-part message', () => {
    const m = parseMessage(raw(simpleMessage({ subject: 'Hi there' })));
    expect(m.tree.type).toBe('text');
    expect(m.tree.subtype).toBe('plain');
    expect(m.subject).toBe('Hi there');
    expect(m.envelope.from).toEqual([['Alice', null, 'alice', 'example.com']]);
    expect(m.tree.lines).toBe(3);
  });

  it('indexes nested multiparts and message/rfc822 with exact offsets', () => {
    const buf = raw(complexMessage());
    const m = parseMessage(buf);
    const t = m.tree;
    expect(t.type).toBe('multipart');
    expect(t.subtype).toBe('mixed');
    expect(t.parts).toHaveLength(3);
    const [alt, pdf, fwd] = t.parts!;
    expect(alt!.subtype).toBe('alternative');
    expect(alt!.parts!.map((p) => p.subtype)).toEqual(['plain', 'html']);
    expect(buf.toString('utf8', alt!.parts![0]!.bs, alt!.parts![0]!.be)).toBe('Caf=C3=A9 at nine? searchable-token');
    expect(pdf!.disp).toEqual(['attachment', [['filename', 'plan.pdf']]]);
    expect(buf.toString('utf8', pdf!.bs, pdf!.be)).toBe('JVBERi0xLjQKJcfsj6IK');
    expect(fwd!.type).toBe('message');
    expect(fwd!.env!.subject).toBe('Inner forwarded');
    expect(buf.toString('utf8', fwd!.msg!.bs, fwd!.msg!.be)).toBe('Forwarded body line 1\r\nForwarded body line 2');
    expect(m.hasAttachments).toBe(true);
    expect(m.subject).toBe('Re: Café plans');
  });

  it('resolves IMAP part numbers', () => {
    const m = parseMessage(raw(complexMessage()));
    expect(resolvePart(m.tree, [1, 2])!.subtype).toBe('html');
    expect(resolvePart(m.tree, [2])!.subtype).toBe('pdf');
    expect(resolvePart(m.tree, [3, 1])!.subtype).toBe('plain'); // body of the forwarded message
    expect(resolvePart(m.tree, [9])).toBeNull();
    const single = parseMessage(raw(simpleMessage()));
    expect(resolvePart(single.tree, [1])).toBe(single.tree);
  });

  it('returns section bytes for HEADER.FIELDS, MIME, TEXT and nested HEADER', () => {
    const buf = raw(complexMessage());
    const m = parseMessage(buf);
    const fields = sectionBytes(buf, m.tree, parseSection('HEADER.FIELDS (subject CC)')).toString();
    expect(fields).toBe('Cc: carol@example.org\r\nSubject: =?UTF-8?Q?Re=3A_Caf=C3=A9_plans?=\r\n\r\n');
    expect(sectionBytes(buf, m.tree, parseSection('2.MIME')).toString()).toContain('Content-Type: application/pdf');
    expect(sectionBytes(buf, m.tree, parseSection('3.HEADER')).toString()).toContain('Subject: Inner forwarded');
    expect(sectionBytes(buf, m.tree, parseSection('3.TEXT')).toString()).toBe('Forwarded body line 1\r\nForwarded body line 2');
    const notFields = sectionBytes(buf, m.tree, parseSection('HEADER.FIELDS.NOT (Subject To Cc From Date Message-ID)')).toString();
    expect(notFields).toBe('MIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="outer"\r\n\r\n');
  });

  it('builds a BODYSTRUCTURE with no space between multipart children', () => {
    const m = parseMessage(raw(complexMessage()));
    const bs = encode(bodyStructureValue(m.tree, true)).toString();
    expect(bs.startsWith('((("text" "plain" ("charset" "utf-8") NIL NIL "QUOTED-PRINTABLE"')).toBe(true);
    expect(bs).toMatch(/\)\("text" "html"/); // children concatenated
    expect(bs).toContain('"alternative"');
    expect(bs).toContain('("attachment" ("filename" "plan.pdf"))');
    expect(bs).toContain('"message" "rfc822"');
  });

  it('encodes ENVELOPE with group syntax and literal for 8-bit names', () => {
    const m = parseMessage(raw(complexMessage()));
    const env = encode(envelopeValue(m.envelope)).toString();
    expect(env).toContain('(("Bob B." NIL "bob" "example.com")(NIL NIL "team" NIL)(NIL NIL "x" "example.com")(NIL NIL "y" "example.com")(NIL NIL NIL NIL))');
    expect(env).toContain('"=?UTF-8?Q?Re=3A_Caf=C3=A9_plans?="');
  });

  it('content hash ignores trace headers but not content', () => {
    const base = simpleMessage({ messageId: '<same@x>' });
    const a = parseMessage(raw(base));
    const b = parseMessage(raw(`Received: from mx1 by mx2; Mon, 5 Oct 2026\r\nDelivered-To: bob@example.com\r\nX-Spam-Score: 1.2\r\n${base}`));
    const c = parseMessage(raw(base.replace('This is a test.', 'This is a TEST.')));
    expect(a.contentHash.equals(b.contentHash)).toBe(true);
    expect(a.contentHash.equals(c.contentHash)).toBe(false);
  });

  it('normalises bare LF to CRLF without touching CRLF', () => {
    expect(normalizeCrlf(Buffer.from('a\nb\r\nc\n')).toString()).toBe('a\r\nb\r\nc\r\n');
    const ok = Buffer.from('a\r\nb\r\n');
    expect(normalizeCrlf(ok)).toBe(ok);
  });

  it('parses structured header parameters', () => {
    expect(parseStructured('multipart/mixed; boundary="a;b"; charset=UTF-8')).toEqual({
      value: 'multipart/mixed',
      params: [
        ['boundary', 'a;b'],
        ['charset', 'UTF-8'],
      ],
    });
  });

  it('treats a multipart without delimiters as text', () => {
    const m = parseMessage(raw('Content-Type: multipart/mixed; boundary=zzz\r\n\r\nno parts here\r\n'));
    expect(m.tree.type).toBe('text');
    expect(m.tree.parts).toBeUndefined();
  });
});
