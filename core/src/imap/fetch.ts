// FETCH attribute parsing and response building (RFC 3501 §6.4.5, RFC 7162 MODSEQ).
import type { Envelope, ImapAddress, MimeEntity, Params } from '../mime/mime.js';
import { resolvePart } from '../mime/mime.js';
import type { ItemFull, ItemMeta } from '../store/mailstore.js';
import type { IVal, Token } from './protocol.js';
import { ImapParseError, flagsToList, formatInternalDate } from './protocol.js';

export type SectionSpec = '' | 'HEADER' | 'HEADER.FIELDS' | 'HEADER.FIELDS.NOT' | 'TEXT' | 'MIME';

export interface Section {
  path: number[];
  spec: SectionSpec;
  fields?: string[]; // lower-case
}

export interface FetchAttr {
  kind: 'UID' | 'FLAGS' | 'INTERNALDATE' | 'RFC822.SIZE' | 'ENVELOPE' | 'BODYSTRUCTURE' | 'BODY' | 'MODSEQ' | 'RFC822' | 'RFC822.HEADER' | 'RFC822.TEXT' | 'SECTION';
  section?: Section;
  peek?: boolean;
  partial?: { start: number; length: number | undefined };
  /** Label used in the response, e.g. BODY[HEADER.FIELDS (FROM)]<0> */
  label: string;
}

export interface FetchRequest {
  attrs: FetchAttr[];
  changedSince?: number;
}

const SIMPLE = new Set(['UID', 'FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODYSTRUCTURE', 'BODY', 'MODSEQ', 'RFC822', 'RFC822.HEADER', 'RFC822.TEXT']);

export function parseSection(text: string): Section {
  let rest = text.trim();
  let path: number[] = [];
  const pm = rest.match(/^(\d+(?:\.\d+)*)(?:\.|$)/);
  if (pm) {
    path = pm[1]!.split('.').map(Number);
    if (path.some((n) => n < 1)) throw new ImapParseError('Invalid section part');
    rest = rest.slice(pm[0].length);
  }
  if (!rest) return { path, spec: '' };
  const sm = rest.match(/^(HEADER\.FIELDS\.NOT|HEADER\.FIELDS|HEADER|TEXT|MIME)\s*(.*)$/i);
  if (!sm) throw new ImapParseError(`Invalid section ${text}`);
  const spec = sm[1]!.toUpperCase() as SectionSpec;
  if (spec === 'MIME' && !path.length) throw new ImapParseError('MIME requires a part number');
  if (spec === 'HEADER.FIELDS' || spec === 'HEADER.FIELDS.NOT') {
    const lm = sm[2]!.match(/^\((.*)\)$/s);
    if (!lm) throw new ImapParseError('Header list expected');
    const fields = lm[1]!
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((f) => f.replace(/^"(.*)"$/, '$1').toLowerCase());
    if (!fields.length) throw new ImapParseError('Empty header list');
    return { path, spec, fields };
  }
  return { path, spec };
}

function parseAttr(raw: string): FetchAttr {
  const up = raw.toUpperCase();
  if (SIMPLE.has(up)) return { kind: up as FetchAttr['kind'], label: up };
  const m = raw.match(/^(BODY|BODY\.PEEK)\[([^\]]*)\](?:<(\d+)(?:\.(\d+))?>)?$/i);
  if (!m) throw new ImapParseError(`Unknown FETCH attribute ${raw}`);
  const section = parseSection(m[2]!);
  const peek = m[1]!.toUpperCase() === 'BODY.PEEK';
  const partial = m[3] !== undefined ? { start: Number(m[3]), length: m[4] !== undefined ? Number(m[4]) : undefined } : undefined;
  const secText = m[2]!.trim().replace(/\s+/g, ' ');
  return { kind: 'SECTION', section, peek, partial, label: `BODY[${secText}]${partial ? `<${partial.start}>` : ''}` };
}

export function parseFetchRequest(args: Token[]): FetchRequest {
  const spec = args[0];
  if (!spec) throw new ImapParseError('Missing FETCH items');
  const attrs: FetchAttr[] = [];
  if (spec.t === 'atom') {
    const up = spec.v.toUpperCase();
    if (up === 'ALL') ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE'].forEach((a) => attrs.push(parseAttr(a)));
    else if (up === 'FAST') ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE'].forEach((a) => attrs.push(parseAttr(a)));
    else if (up === 'FULL') ['FLAGS', 'INTERNALDATE', 'RFC822.SIZE', 'ENVELOPE', 'BODY'].forEach((a) => attrs.push(parseAttr(a)));
    else attrs.push(parseAttr(spec.v));
  } else if (spec.t === 'list') {
    for (const t of spec.v) {
      if (t.t !== 'atom') throw new ImapParseError('Invalid FETCH item');
      attrs.push(parseAttr(t.v));
    }
  } else {
    throw new ImapParseError('Invalid FETCH items');
  }
  const req: FetchRequest = { attrs };
  const mods = args[1];
  if (mods) {
    if (mods.t !== 'list') throw new ImapParseError('Invalid FETCH modifiers');
    for (let i = 0; i < mods.v.length; i++) {
      const t = mods.v[i]!;
      if (t.t === 'atom' && t.v.toUpperCase() === 'CHANGEDSINCE') {
        const n = mods.v[++i];
        if (!n || n.t !== 'atom' || !/^\d+$/.test(n.v)) throw new ImapParseError('Invalid CHANGEDSINCE');
        req.changedSince = Number(n.v);
      } else if (t.t === 'atom' && t.v.toUpperCase() === 'VANISHED') {
        throw new ImapParseError('VANISHED requires QRESYNC');
      } else {
        throw new ImapParseError('Unknown FETCH modifier');
      }
    }
  }
  return req;
}

/** True when any attribute needs data beyond the item row (envelope, structure, bytes). */
export function needsMessageData(attrs: FetchAttr[]): boolean {
  return attrs.some((a) => ['ENVELOPE', 'BODYSTRUCTURE', 'BODY', 'RFC822', 'RFC822.HEADER', 'RFC822.TEXT', 'SECTION'].includes(a.kind));
}

/** True when an attribute needs bytes beyond the cached root header. */
function needsRawBody(a: FetchAttr): boolean {
  if (a.kind === 'RFC822' || a.kind === 'RFC822.TEXT') return true;
  if (a.kind !== 'SECTION') return false;
  const s = a.section!;
  return !(s.path.length === 0 && (s.spec === 'HEADER' || s.spec === 'HEADER.FIELDS' || s.spec === 'HEADER.FIELDS.NOT'));
}

/** Non-PEEK body fetches set \Seen. */
export function setsSeen(attrs: FetchAttr[]): boolean {
  return attrs.some((a) => (a.kind === 'SECTION' && !a.peek) || a.kind === 'RFC822' || a.kind === 'RFC822.TEXT');
}

// ---------------------------------------------------------------------------
// ENVELOPE / BODYSTRUCTURE
// ---------------------------------------------------------------------------

function addrList(list: ImapAddress[] | null): IVal {
  if (!list || !list.length) return null;
  return { tight: list.map((a) => [a[0], a[1], a[2], a[3]] as IVal) };
}

export function envelopeValue(e: Envelope): IVal {
  return [e.date, e.subject, addrList(e.from), addrList(e.sender), addrList(e.replyTo), addrList(e.to), addrList(e.cc), addrList(e.bcc), e.inReplyTo, e.messageId];
}

function paramList(p: Params): IVal {
  return p.length ? p.flatMap(([k, v]) => [k, v]) : null;
}

const EMPTY_ENVELOPE: Envelope = { date: null, subject: null, from: null, sender: null, replyTo: null, to: null, cc: null, bcc: null, inReplyTo: null, messageId: null };

export function bodyStructureValue(e: MimeEntity, extended: boolean): IVal {
  if (e.parts) {
    const items: IVal[] = [{ seq: e.parts.map((p) => bodyStructureValue(p, extended)) }, e.subtype];
    if (extended) items.push(paramList(e.params), e.disp ? [e.disp[0], paramList(e.disp[1])] : null, e.lang, e.loc);
    return items;
  }
  const items: IVal[] = [e.type, e.subtype, paramList(e.params), e.id, e.desc, e.enc.toUpperCase(), e.be - e.bs];
  if (e.type === 'text') items.push(e.lines);
  if (e.type === 'message' && e.subtype === 'rfc822') {
    if (e.msg && e.env) items.push(envelopeValue(e.env), bodyStructureValue(e.msg, extended), e.lines);
    else items.push(envelopeValue(EMPTY_ENVELOPE), ['text', 'plain', null, null, null, '7BIT', 0, 0], e.lines);
  }
  if (extended) items.push(e.md5, e.disp ? [e.disp[0], paramList(e.disp[1])] : null, e.lang, e.loc);
  return items;
}

// ---------------------------------------------------------------------------
// Section bytes
// ---------------------------------------------------------------------------

function filterHeaders(raw: Buffer, start: number, end: number, fields: string[], not: boolean): Buffer {
  const want = new Set(fields);
  const out: Buffer[] = [];
  let pos = start;
  let include = false;
  while (pos < end) {
    let nl = raw.indexOf(0x0a, pos);
    if (nl === -1 || nl >= end) nl = end - 1;
    const line = raw.subarray(pos, nl + 1);
    const isBlank = line.length <= 2 && (line[0] === 0x0d || line[0] === 0x0a);
    if (isBlank) break;
    if (line[0] === 0x20 || line[0] === 0x09) {
      if (include) out.push(line);
    } else {
      const colon = line.indexOf(0x3a);
      const name = colon > 0 ? line.toString('latin1', 0, colon).trim().toLowerCase() : '';
      include = name !== '' && want.has(name) !== not;
      if (include) out.push(line);
    }
    pos = nl + 1;
  }
  out.push(Buffer.from('\r\n'));
  return Buffer.concat(out);
}

export function sectionBytes(raw: Buffer, tree: MimeEntity, s: Section): Buffer {
  const headerish = (ent: MimeEntity): Buffer => {
    if (s.spec === 'HEADER') return raw.subarray(ent.hs, ent.bs);
    if (s.spec === 'TEXT') return raw.subarray(ent.bs, ent.be);
    return filterHeaders(raw, ent.hs, ent.bs, s.fields!, s.spec === 'HEADER.FIELDS.NOT');
  };
  if (!s.path.length) {
    if (s.spec === '') return raw;
    return headerish(tree);
  }
  const part = resolvePart(tree, s.path);
  if (!part) return Buffer.alloc(0);
  if (s.spec === '') return raw.subarray(part.bs, part.be);
  if (s.spec === 'MIME') return raw.subarray(part.hs, part.bs);
  // HEADER / TEXT / HEADER.FIELDS on a part apply to an encapsulated message.
  return part.msg ? headerish(part.msg) : Buffer.alloc(0);
}

function applyPartial(b: Buffer, p: FetchAttr['partial']): Buffer {
  if (!p) return b;
  if (p.start >= b.length) return Buffer.alloc(0);
  return b.subarray(p.start, p.length === undefined ? undefined : p.start + p.length);
}

// ---------------------------------------------------------------------------
// Response
// ---------------------------------------------------------------------------

export interface FetchContext {
  includeModseq: boolean;
  loadRaw: (item: ItemFull) => Promise<Buffer>;
}

/** Builds the parenthesised FETCH data for one message. */
export async function buildFetchItems(item: ItemMeta | ItemFull, attrs: FetchAttr[], ctx: FetchContext): Promise<IVal[]> {
  const out: IVal[] = [];
  const full = item as ItemFull;
  let raw: Buffer | undefined;
  const getRaw = async (a: FetchAttr): Promise<Buffer> => {
    if (raw) return raw;
    if (!needsRawBody(a) && full.header_raw) return full.header_raw;
    raw = await ctx.loadRaw(full);
    return raw;
  };
  let hasModseq = false;
  for (const a of attrs) {
    switch (a.kind) {
      case 'UID':
        out.push({ atom: 'UID' }, item.uid);
        break;
      case 'FLAGS':
        out.push({ atom: 'FLAGS' }, flagsToList(item.flags, item.keywords));
        break;
      case 'INTERNALDATE':
        out.push({ atom: 'INTERNALDATE' }, formatInternalDate(new Date(item.internal_date)));
        break;
      case 'RFC822.SIZE':
        out.push({ atom: 'RFC822.SIZE' }, Number(item.size));
        break;
      case 'MODSEQ':
        hasModseq = true;
        out.push({ atom: 'MODSEQ' }, [Number(item.modseq)]);
        break;
      case 'ENVELOPE':
        out.push({ atom: 'ENVELOPE' }, envelopeValue(full.envelope));
        break;
      case 'BODYSTRUCTURE':
        out.push({ atom: 'BODYSTRUCTURE' }, bodyStructureValue(full.tree, true));
        break;
      case 'BODY':
        out.push({ atom: 'BODY' }, bodyStructureValue(full.tree, false));
        break;
      case 'RFC822':
        out.push({ atom: 'RFC822' }, { literal: await getRaw(a) });
        break;
      case 'RFC822.HEADER': {
        const r = await getRaw(a);
        out.push({ atom: 'RFC822.HEADER' }, { literal: r.subarray(0, full.tree.bs) });
        break;
      }
      case 'RFC822.TEXT': {
        const r = await getRaw(a);
        out.push({ atom: 'RFC822.TEXT' }, { literal: r.subarray(full.tree.bs) });
        break;
      }
      case 'SECTION': {
        const r = await getRaw(a);
        const bytes = sectionBytes(r, full.tree, a.section!);
        out.push({ atom: a.label }, { literal: applyPartial(bytes, a.partial) });
        break;
      }
    }
  }
  if (ctx.includeModseq && !hasModseq) out.push({ atom: 'MODSEQ' }, [Number(item.modseq)]);
  return out;
}
