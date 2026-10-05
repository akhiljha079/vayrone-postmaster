// SEARCH (RFC 3501 §6.4.4) + MODSEQ (RFC 7162). Criteria are evaluated in
// memory over item metadata; header and body data are loaded only when a
// criterion needs them. Phase 7 adds the FULLTEXT index for large mailboxes.
import iconv from 'iconv-lite';
import libmime from 'libmime';
import type { MimeEntity } from '../mime/mime.js';
import { parseHeaderBlock } from '../mime/mime.js';
import type { ItemFull, ItemMeta } from '../store/mailstore.js';
import type { SeqRange, Token } from './protocol.js';
import { FLAG_BITS, ImapParseError, inSeqSet, parseSearchDate, parseSeqSet, tokenString } from './protocol.js';

export type SearchNode =
  | { op: 'all' }
  | { op: 'flag'; bit: number; set: boolean }
  | { op: 'keyword'; kw: string; set: boolean }
  | { op: 'new' }
  | { op: 'old' }
  | { op: 'recent' }
  | { op: 'seq'; ranges: SeqRange[] }
  | { op: 'uid'; ranges: SeqRange[] }
  | { op: 'header'; field: string; value: string }
  | { op: 'body'; value: string }
  | { op: 'text'; value: string }
  | { op: 'date'; which: 'internal' | 'sent'; cmp: 'before' | 'on' | 'since'; date: Date }
  | { op: 'size'; cmp: 'larger' | 'smaller'; n: number }
  | { op: 'modseq'; n: number }
  | { op: 'not'; a: SearchNode }
  | { op: 'or'; a: SearchNode; b: SearchNode }
  | { op: 'and'; list: SearchNode[] };

const FLAG_KEYS: Record<string, [number, boolean]> = {};
for (const [name, bit] of FLAG_BITS) {
  if (!name.startsWith('\\')) continue;
  const n = name.slice(1).toUpperCase();
  FLAG_KEYS[n] = [bit, true];
  FLAG_KEYS['UN' + n] = [bit, false];
}

class Cursor {
  i = 0;
  constructor(readonly toks: Token[]) {}
  more(): boolean {
    return this.i < this.toks.length;
  }
  next(): Token {
    const t = this.toks[this.i++];
    if (!t) throw new ImapParseError('Incomplete SEARCH');
    return t;
  }
  str(): string {
    const v = tokenString(this.next());
    if (v === null) throw new ImapParseError('String expected');
    return v;
  }
  num(): number {
    const v = this.str();
    if (!/^\d+$/.test(v)) throw new ImapParseError('Number expected');
    return Number(v);
  }
  date(): Date {
    const d = parseSearchDate(this.str());
    if (!d) throw new ImapParseError('Invalid date');
    return d;
  }
}

function parseKey(c: Cursor): SearchNode {
  const t = c.next();
  if (t.t === 'list') {
    const inner = new Cursor(t.v);
    const list: SearchNode[] = [];
    while (inner.more()) list.push(parseKey(inner));
    if (!list.length) throw new ImapParseError('Empty search list');
    return list.length === 1 ? list[0]! : { op: 'and', list };
  }
  if (t.t !== 'atom') throw new ImapParseError('Search key expected');
  const k = t.v.toUpperCase();
  if (/^[\d*]/.test(k)) return { op: 'seq', ranges: parseSeqSet(t.v) };
  const fk = FLAG_KEYS[k];
  if (fk) return { op: 'flag', bit: fk[0], set: fk[1] };
  switch (k) {
    case 'ALL':
      return { op: 'all' };
    case 'NEW':
      return { op: 'new' };
    case 'OLD':
      return { op: 'old' };
    case 'RECENT':
      return { op: 'recent' };
    case 'KEYWORD':
    case 'UNKEYWORD': {
      const kw = c.str();
      const sys = FLAG_BITS.find(([n]) => n.toLowerCase() === kw.toLowerCase());
      if (sys) return { op: 'flag', bit: sys[1], set: k === 'KEYWORD' };
      return { op: 'keyword', kw, set: k === 'KEYWORD' };
    }
    case 'FROM':
    case 'TO':
    case 'CC':
    case 'BCC':
    case 'SUBJECT':
      return { op: 'header', field: k.toLowerCase(), value: c.str() };
    case 'HEADER': {
      const field = c.str().toLowerCase();
      return { op: 'header', field, value: c.str() };
    }
    case 'BODY':
      return { op: 'body', value: c.str() };
    case 'TEXT':
      return { op: 'text', value: c.str() };
    case 'BEFORE':
    case 'ON':
    case 'SINCE':
      return { op: 'date', which: 'internal', cmp: k.toLowerCase() as 'before' | 'on' | 'since', date: c.date() };
    case 'SENTBEFORE':
    case 'SENTON':
    case 'SENTSINCE':
      return { op: 'date', which: 'sent', cmp: k.slice(4).toLowerCase() as 'before' | 'on' | 'since', date: c.date() };
    case 'LARGER':
      return { op: 'size', cmp: 'larger', n: c.num() };
    case 'SMALLER':
      return { op: 'size', cmp: 'smaller', n: c.num() };
    case 'UID':
      return { op: 'uid', ranges: parseSeqSet(c.str()) };
    case 'MODSEQ': {
      // MODSEQ [<entry-name> <entry-type>] <mod-sequence-valzer>
      let v = c.str();
      if (!/^\d+$/.test(v)) {
        c.str();
        v = c.str();
      }
      if (!/^\d+$/.test(v)) throw new ImapParseError('Invalid MODSEQ');
      return { op: 'modseq', n: Number(v) };
    }
    case 'NOT':
      return { op: 'not', a: parseKey(c) };
    case 'OR': {
      const a = parseKey(c);
      return { op: 'or', a, b: parseKey(c) };
    }
    default:
      throw new ImapParseError(`Unknown search key ${t.v}`);
  }
}

export function parseSearch(tokens: Token[]): { node: SearchNode; charset: string | null } {
  const c = new Cursor(tokens);
  let charset: string | null = null;
  if (tokens[0]?.t === 'atom' && tokens[0].v.toUpperCase() === 'CHARSET') {
    c.next();
    charset = c.str().toUpperCase();
  }
  const list: SearchNode[] = [];
  while (c.more()) list.push(parseKey(c));
  if (!list.length) throw new ImapParseError('Empty SEARCH');
  return { node: list.length === 1 ? list[0]! : { op: 'and', list }, charset };
}

export function walk(n: SearchNode, fn: (n: SearchNode) => void): void {
  fn(n);
  if (n.op === 'not') walk(n.a, fn);
  else if (n.op === 'or') {
    walk(n.a, fn);
    walk(n.b, fn);
  } else if (n.op === 'and') n.list.forEach((x) => walk(x, fn));
}

export function searchNeeds(n: SearchNode): { headers: boolean; body: boolean; modseq: boolean } {
  const r = { headers: false, body: false, modseq: false };
  walk(n, (x) => {
    if (x.op === 'header' || (x.op === 'date' && x.which === 'sent')) r.headers = true;
    if (x.op === 'body' || x.op === 'text') r.body = true;
    if (x.op === 'modseq') r.modseq = true;
  });
  return r;
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface SearchItem {
  seq: number;
  item: ItemMeta | ItemFull;
  maxSeq: number;
  maxUid: number;
  headers?: Map<string, string[]>; // decoded, lower-case keys
  sentDate?: Date | null;
  bodyText?: string; // lower-case
  headerText?: string; // lower-case
}

function dayOf(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export function evaluate(n: SearchNode, s: SearchItem): boolean {
  const it = s.item;
  switch (n.op) {
    case 'all':
      return true;
    case 'flag':
      return Boolean(it.flags & n.bit) === n.set;
    case 'keyword':
      return it.keywords.some((k) => k.toLowerCase() === n.kw.toLowerCase()) === n.set;
    case 'new':
      return false; // \Recent is not tracked; NEW = RECENT UNSEEN
    case 'recent':
      return false;
    case 'old':
      return true;
    case 'seq':
      return inSeqSet(n.ranges, s.seq, s.maxSeq);
    case 'uid':
      return inSeqSet(n.ranges, it.uid, s.maxUid);
    case 'size':
      return n.cmp === 'larger' ? Number(it.size) > n.n : Number(it.size) < n.n;
    case 'modseq':
      return Number(it.modseq) >= n.n;
    case 'date': {
      const d = n.which === 'internal' ? new Date(it.internal_date) : s.sentDate;
      if (!d) return false;
      const a = dayOf(d);
      const b = n.date.getTime();
      return n.cmp === 'before' ? a < b : n.cmp === 'on' ? a === b : a >= b;
    }
    case 'header': {
      const vals = s.headers?.get(n.field) ?? [];
      if (n.value === '') return vals.length > 0;
      const needle = n.value.toLowerCase();
      return vals.some((v) => v.toLowerCase().includes(needle));
    }
    case 'body':
      return (s.bodyText ?? '').includes(n.value.toLowerCase());
    case 'text':
      return (s.headerText ?? '').includes(n.value.toLowerCase()) || (s.bodyText ?? '').includes(n.value.toLowerCase());
    case 'not':
      return !evaluate(n.a, s);
    case 'or':
      return evaluate(n.a, s) || evaluate(n.b, s);
    case 'and':
      return n.list.every((x) => evaluate(x, s));
  }
}

// ---------------------------------------------------------------------------
// Data extraction helpers
// ---------------------------------------------------------------------------

export function decodedHeaders(headerRaw: Buffer): Map<string, string[]> {
  const { fields } = parseHeaderBlock(headerRaw, 0, headerRaw.length);
  const m = new Map<string, string[]>();
  for (const f of fields) {
    let v = f.value;
    try {
      v = libmime.decodeWords(v);
    } catch {
      /* keep raw */
    }
    const arr = m.get(f.key) ?? [];
    arr.push(v);
    m.set(f.key, arr);
  }
  return m;
}

function decodeQp(s: string): Buffer {
  const bytes: number[] = [];
  const t = s.replace(/=\r?\n/g, '');
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) {
      bytes.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(t.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

/** Decodes one text/* leaf (transfer encoding + charset). */
export function decodeTextPart(raw: Buffer, e: MimeEntity): string {
  let bytes = raw.subarray(e.bs, e.be);
  if (e.enc === 'base64') bytes = Buffer.from(bytes.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  else if (e.enc === 'quoted-printable') bytes = decodeQp(bytes.toString('latin1'));
  const cs = e.params.find((p) => p[0] === 'charset')?.[1] ?? 'utf-8';
  return iconv.encodingExists(cs) ? iconv.decode(bytes, cs) : bytes.toString('utf8');
}

function htmlToPlain(html: string): string {
  return html
    .replace(/<(style|script|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

/** Decoded text of all text/* leaf parts (transfer encoding + charset), lower-cased. */
export function extractBodyText(raw: Buffer, tree: MimeEntity): string {
  const out: string[] = [];
  const visit = (e: MimeEntity) => {
    if (e.parts) return e.parts.forEach(visit);
    if (e.msg) return visit(e.msg);
    if (e.type !== 'text') return;
    const text = decodeTextPart(raw, e);
    out.push(e.subtype === 'html' ? htmlToPlain(text) : text);
  };
  visit(tree);
  return out.join('\n').toLowerCase();
}

/** A one-line preview: the first plain-text body (or HTML converted to text), whitespace collapsed. */
export function previewText(raw: Buffer, tree: MimeEntity, max = 200): string | null {
  let plain: MimeEntity | null = null;
  let html: MimeEntity | null = null;
  const visit = (e: MimeEntity) => {
    if (plain) return;
    if (e.parts) return e.parts.forEach(visit);
    if (e.type !== 'text' || e.disp?.[0] === 'attachment') return;
    if (e.subtype === 'plain') plain = e;
    else if (e.subtype === 'html' && !html) html = e;
  };
  visit(tree);
  const part: MimeEntity | null = plain ?? html;
  if (!part) return null;
  try {
    let t = decodeTextPart(raw, part);
    if (part === html) t = htmlToPlain(t);
    t = t.replace(/^>.*$/gm, ' ').replace(/\s+/g, ' ').trim();
    return t ? t.slice(0, max) : null;
  } catch {
    return null;
  }
}
