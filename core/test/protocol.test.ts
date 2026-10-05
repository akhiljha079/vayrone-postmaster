import { describe, expect, it } from 'vitest';
import {
  compressSet,
  decodeMailboxName,
  encode,
  encodeMailboxName,
  formatInternalDate,
  inSeqSet,
  parseCommand,
  parseFlags,
  parseInternalDate,
  parseSeqSet,
} from '../src/imap/protocol.js';
import { parseFetchRequest } from '../src/imap/fetch.js';
import { parseSearch } from '../src/imap/search.js';

const cmd = (s: string) => parseCommand(Buffer.from(s + '\r\n'));

describe('IMAP command parser', () => {
  it('parses tag, UID commands, lists and quoted strings', () => {
    const c = cmd('a1 UID FETCH 1:* (UID FLAGS BODY.PEEK[HEADER.FIELDS (From "To" Subject)]<0.2048>)');
    expect(c.tag).toBe('a1');
    expect(c.name).toBe('UID FETCH');
    expect(c.args[0]).toEqual({ t: 'atom', v: '1:*' });
    const list = c.args[1] as { t: 'list'; v: { v: string }[] };
    expect(list.v.map((x) => x.v)).toEqual(['UID', 'FLAGS', 'BODY.PEEK[HEADER.FIELDS (From "To" Subject)]<0.2048>']);
  });

  it('handles literals and LITERAL+', () => {
    const b = Buffer.concat([Buffer.from('a2 LOGIN {5}\r\n'), Buffer.from('al"ce'), Buffer.from(' {3+}\r\npw!\r\n')]);
    const c = parseCommand(b);
    expect(c.args.map((x) => (x.v as Buffer).toString())).toEqual(['al"ce', 'pw!']);
  });

  it('unescapes quoted strings', () => {
    const c = cmd('a3 LOGIN "us\\"er" "p\\\\w"');
    expect(c.args.map((x) => (x.v as Buffer).toString())).toEqual(['us"er', 'p\\w']);
  });

  it('rejects garbage with the tag preserved', () => {
    expect(() => cmd('a4 FETCH (unterminated')).toThrowError(/Unterminated/);
  });
});

describe('FETCH request parsing', () => {
  it('expands macros and sections', () => {
    const c = cmd('x FETCH 1 (FLAGS BODY[] BODY[1.2.MIME] BODY.PEEK[TEXT]<10.20>) (CHANGEDSINCE 42)');
    const r = parseFetchRequest(c.args.slice(1));
    expect(r.changedSince).toBe(42);
    expect(r.attrs.map((a) => a.label)).toEqual(['FLAGS', 'BODY[]', 'BODY[1.2.MIME]', 'BODY[TEXT]<10>']);
    expect(r.attrs[3]!.partial).toEqual({ start: 10, length: 20 });
    expect(parseFetchRequest(cmd('x FETCH 1 ALL').args.slice(1)).attrs.map((a) => a.kind)).toEqual(['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE']);
  });
});

describe('SEARCH parsing', () => {
  it('parses nested OR / NOT / lists', () => {
    const { node, charset } = parseSearch(cmd('x SEARCH CHARSET UTF-8 OR (FROM "alice" SEEN) NOT DELETED 1:5 SINCE 1-Oct-2026').args);
    expect(charset).toBe('UTF-8');
    expect(node.op).toBe('and');
  });
});

describe('sequence sets', () => {
  it('parses and matches with *', () => {
    const r = parseSeqSet('1:3,7,10:*');
    expect(inSeqSet(r, 2, 20)).toBe(true);
    expect(inSeqSet(r, 5, 20)).toBe(false);
    expect(inSeqSet(r, 15, 20)).toBe(true);
    // "100:*" when max is 50 still matches 50 (RFC 3501 §6.4.8)
    expect(inSeqSet(parseSeqSet('100:*'), 50, 50)).toBe(true);
    expect(() => parseSeqSet('0:3')).toThrow();
    expect(compressSet([5, 1, 2, 3, 9, 10])).toBe('1:3,5,9:10');
  });
});

describe('modified UTF-7 mailbox names', () => {
  it('round-trips non-ASCII and &', () => {
    for (const s of ['Sent', 'Entwürfe', 'Tom & Jerry', 'हिन्दी', '日本語/子']) {
      expect(decodeMailboxName(encodeMailboxName(s))).toBe(s);
    }
    expect(encodeMailboxName('Tom & Jerry')).toBe('Tom &- Jerry');
    expect(encodeMailboxName('Entwürfe')).toBe('Entw&APw-rfe');
  });
});

describe('encoding helpers', () => {
  it('chooses quoted vs literal strings', () => {
    expect(encode(['a"b', null, 7]).toString()).toBe('("a\\"b" NIL 7)');
    expect(encode('Café').toString()).toBe('{5}\r\nCafé');
  });

  it('formats and parses INTERNALDATE', () => {
    const d = parseInternalDate('05-Oct-2026 16:30:00 +0530')!;
    expect(d.toISOString()).toBe('2026-10-05T11:00:00.000Z');
    expect(formatInternalDate(d)).toBe('05-Oct-2026 11:00:00 +0000');
  });

  it('maps flags to bits and keywords', () => {
    expect(parseFlags(['\\Seen', '\\Flagged', '$Label1', '\\Recent'])).toEqual({ bits: 5, keywords: ['$Label1'] });
    expect(() => parseFlags(['\\Bogus'])).toThrow();
  });
});
