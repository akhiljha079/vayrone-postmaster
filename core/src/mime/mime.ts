// MIME structure indexer. Parses a raw RFC 5322 message once into a tree of
// byte offsets plus the fields IMAP needs for ENVELOPE / BODYSTRUCTURE, so
// FETCH never re-parses and section fetches are plain buffer slices.
import { createHash } from 'node:crypto';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import libmime from 'libmime';

export interface HeaderField {
  key: string; // lower-case
  value: string; // unfolded, raw (encoded-words not decoded)
}

/** [name, adl, mailbox, host] — IMAP address structure. */
export type ImapAddress = [string | null, string | null, string | null, string | null];

export interface Envelope {
  date: string | null;
  subject: string | null;
  from: ImapAddress[] | null;
  sender: ImapAddress[] | null;
  replyTo: ImapAddress[] | null;
  to: ImapAddress[] | null;
  cc: ImapAddress[] | null;
  bcc: ImapAddress[] | null;
  inReplyTo: string | null;
  messageId: string | null;
}

export type Params = [string, string][];

export interface MimeEntity {
  /** header start, body start, body end (exclusive) — byte offsets into the raw message */
  hs: number;
  bs: number;
  be: number;
  type: string;
  subtype: string;
  params: Params;
  disp: [string, Params] | null;
  id: string | null;
  desc: string | null;
  enc: string;
  md5: string | null;
  lang: string[] | null;
  loc: string | null;
  lines: number;
  parts?: MimeEntity[];
  /** message/rfc822: the encapsulated message and its envelope */
  msg?: MimeEntity;
  env?: Envelope;
}

export interface ParsedMessage {
  tree: MimeEntity;
  envelope: Envelope;
  headers: HeaderField[];
  headerRaw: Buffer;
  messageId: string | null;
  subject: string | null; // decoded
  from: string | null; // decoded display form
  date: Date | null;
  hasAttachments: boolean;
  contentHash: Buffer;
}

const MAX_DEPTH = 40;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeHeaderBytes(b: Buffer): string {
  try {
    return utf8.decode(b);
  } catch {
    return b.toString('latin1');
  }
}

/** Parses a header block starting at `start`. Returns fields and the body start offset. */
export function parseHeaderBlock(buf: Buffer, start: number, end: number): { fields: HeaderField[]; bodyStart: number } {
  const fields: HeaderField[] = [];
  let pos = start;
  let current: { key: string; chunks: string[] } | null = null;
  const flush = () => {
    if (current) fields.push({ key: current.key, value: current.chunks.join('').trim() });
    current = null;
  };
  while (pos < end) {
    let nl = buf.indexOf(0x0a, pos);
    if (nl === -1 || nl >= end) nl = end;
    let lineEnd = nl;
    if (lineEnd > pos && buf[lineEnd - 1] === 0x0d) lineEnd--;
    const next = nl < end ? nl + 1 : end;
    if (lineEnd === pos) {
      // empty line: end of headers
      flush();
      return { fields, bodyStart: next };
    }
    const first = buf[pos];
    if ((first === 0x20 || first === 0x09) && current) {
      (current as { chunks: string[] }).chunks.push(decodeHeaderBytes(buf.subarray(pos, lineEnd)));
    } else {
      flush();
      const line = decodeHeaderBytes(buf.subarray(pos, lineEnd));
      const colon = line.indexOf(':');
      if (colon > 0) current = { key: line.slice(0, colon).trim().toLowerCase(), chunks: [line.slice(colon + 1)] };
    }
    pos = next;
  }
  flush();
  return { fields, bodyStart: end };
}

function getHeader(fields: HeaderField[], key: string): string | null {
  const f = fields.find((h) => h.key === key);
  return f ? f.value : null;
}

/** Parses `value; a=b; c="d"` into the main value and parameter list. */
export function parseStructured(input: string): { value: string; params: Params } {
  const s = input.replace(/\([^()]*\)/g, ''); // drop simple comments
  const params: Params = [];
  let i = s.indexOf(';');
  const value = (i === -1 ? s : s.slice(0, i)).trim();
  while (i !== -1 && i < s.length) {
    i++;
    while (s[i] === ' ' || s[i] === '\t') i++;
    const eq = s.indexOf('=', i);
    if (eq === -1) break;
    const name = s.slice(i, eq).trim().toLowerCase();
    let j = eq + 1;
    while (s[j] === ' ' || s[j] === '\t') j++;
    let val = '';
    if (s[j] === '"') {
      j++;
      while (j < s.length && s[j] !== '"') {
        if (s[j] === '\\' && j + 1 < s.length) j++;
        val += s[j];
        j++;
      }
      j++; // closing quote
      const semi = s.indexOf(';', j);
      i = semi;
    } else {
      const semi = s.indexOf(';', j);
      val = (semi === -1 ? s.slice(j) : s.slice(j, semi)).trim();
      i = semi;
    }
    if (name) params.push([name, val]);
  }
  return { value, params };
}

function countLines(buf: Buffer, start: number, end: number): number {
  if (end <= start) return 0;
  let n = 0;
  for (let i = buf.indexOf(0x0a, start); i !== -1 && i < end; i = buf.indexOf(0x0a, i + 1)) n++;
  if (buf[end - 1] !== 0x0a) n++;
  return n;
}

function toImapAddresses(value: string | null): ImapAddress[] | null {
  if (!value) return null;
  const out: ImapAddress[] = [];
  const conv = (a: { name?: string; address?: string }): ImapAddress => {
    const addr = a.address ?? '';
    const at = addr.lastIndexOf('@');
    const mailbox = at === -1 ? addr : addr.slice(0, at);
    const host = at === -1 ? '' : addr.slice(at + 1);
    return [a.name ? a.name : null, null, mailbox, host];
  };
  for (const a of addressparser(value) as { name?: string; address?: string; group?: { name?: string; address?: string }[] }[]) {
    if (a.group) {
      out.push([null, null, a.name ?? '', null]);
      for (const g of a.group) out.push(conv(g));
      out.push([null, null, null, null]);
    } else if (a.address || a.name) {
      out.push(conv(a));
    }
  }
  return out.length ? out : null;
}

export function buildEnvelope(fields: HeaderField[]): Envelope {
  const from = toImapAddresses(getHeader(fields, 'from'));
  return {
    date: getHeader(fields, 'date'),
    subject: getHeader(fields, 'subject'),
    from,
    sender: toImapAddresses(getHeader(fields, 'sender')) ?? from,
    replyTo: toImapAddresses(getHeader(fields, 'reply-to')) ?? from,
    to: toImapAddresses(getHeader(fields, 'to')),
    cc: toImapAddresses(getHeader(fields, 'cc')),
    bcc: toImapAddresses(getHeader(fields, 'bcc')),
    inReplyTo: getHeader(fields, 'in-reply-to'),
    messageId: getHeader(fields, 'message-id'),
  };
}

function parseEntity(
  buf: Buffer,
  start: number,
  end: number,
  defaultType: [string, string],
  depth: number,
): { entity: MimeEntity; fields: HeaderField[] } {
  const { fields, bodyStart } = parseHeaderBlock(buf, start, end);
  const ctRaw = getHeader(fields, 'content-type');
  let type = defaultType[0];
  let subtype = defaultType[1];
  let params: Params = ctRaw ? [] : defaultType[0] === 'text' ? [['charset', 'us-ascii']] : [];
  if (ctRaw) {
    const ct = parseStructured(ctRaw);
    const slash = ct.value.indexOf('/');
    if (slash > 0) {
      type = ct.value.slice(0, slash).trim().toLowerCase();
      subtype = ct.value.slice(slash + 1).trim().toLowerCase();
      params = ct.params;
    }
  }
  const dispRaw = getHeader(fields, 'content-disposition');
  let disp: [string, Params] | null = null;
  if (dispRaw) {
    const d = parseStructured(dispRaw);
    if (d.value) disp = [d.value.toLowerCase(), d.params];
  }
  const lang = getHeader(fields, 'content-language');
  const entity: MimeEntity = {
    hs: start,
    bs: bodyStart,
    be: end,
    type,
    subtype,
    params,
    disp,
    id: getHeader(fields, 'content-id'),
    desc: getHeader(fields, 'content-description'),
    enc: (getHeader(fields, 'content-transfer-encoding') ?? '7bit').toLowerCase().trim() || '7bit',
    md5: getHeader(fields, 'content-md5'),
    lang: lang ? lang.split(',').map((x) => x.trim()).filter(Boolean) : null,
    loc: getHeader(fields, 'content-location'),
    lines: 0,
  };

  const boundary = params.find((p) => p[0] === 'boundary')?.[1];
  if (type === 'multipart' && boundary && depth < MAX_DEPTH) {
    const parts = splitMultipart(buf, bodyStart, end, boundary);
    if (parts.length) {
      const childDefault: [string, string] = subtype === 'digest' ? ['message', 'rfc822'] : ['text', 'plain'];
      entity.parts = parts.map(([s, e]) => parseEntity(buf, s, e, childDefault, depth + 1).entity);
      return { entity, fields };
    }
    // Malformed multipart without delimiters: treat as text.
    entity.type = 'text';
    entity.subtype = 'plain';
    entity.params = [['charset', 'us-ascii']];
  }

  entity.lines = countLines(buf, bodyStart, end);
  if (
    type === 'message' &&
    (subtype === 'rfc822' || subtype === 'global') &&
    !['base64', 'quoted-printable'].includes(entity.enc) &&
    depth < MAX_DEPTH
  ) {
    const inner = parseEntity(buf, bodyStart, end, ['text', 'plain'], depth + 1);
    entity.msg = inner.entity;
    entity.env = buildEnvelope(inner.fields);
  }
  return { entity, fields };
}

function splitMultipart(buf: Buffer, start: number, end: number, boundary: string): [number, number][] {
  const delim = Buffer.from('--' + boundary, 'latin1');
  const bounds: { lineStart: number; after: number; closing: boolean }[] = [];
  let from = start;
  for (;;) {
    const i = buf.indexOf(delim, from);
    if (i === -1 || i >= end) break;
    if (i === start || buf[i - 1] === 0x0a) {
      let j = i + delim.length;
      let closing = false;
      if (buf[j] === 0x2d && buf[j + 1] === 0x2d) {
        closing = true;
        j += 2;
      }
      while (j < end && (buf[j] === 0x20 || buf[j] === 0x09)) j++;
      if (j >= end || buf[j] === 0x0d || buf[j] === 0x0a) {
        let after = j;
        if (buf[after] === 0x0d) after++;
        if (buf[after] === 0x0a) after++;
        bounds.push({ lineStart: i, after: Math.min(after, end), closing });
        if (closing) break;
        from = after;
        continue;
      }
    }
    from = i + 1;
  }
  const parts: [number, number][] = [];
  for (let k = 0; k < bounds.length; k++) {
    const b = bounds[k]!;
    if (b.closing) break;
    const nextB = bounds[k + 1];
    const s = b.after;
    let e = nextB ? nextB.lineStart : end;
    if (nextB) {
      if (e - 2 >= s && buf[e - 2] === 0x0d && buf[e - 1] === 0x0a) e -= 2;
      else if (e - 1 >= s && buf[e - 1] === 0x0a) e -= 1;
    }
    parts.push([s, Math.max(s, e)]);
  }
  return parts;
}

function hasAttachment(e: MimeEntity): boolean {
  if (e.parts) return e.parts.some(hasAttachment);
  if (e.disp?.[0] === 'attachment') return true;
  if (e.disp?.[1].some(([k]) => k.startsWith('filename'))) return true;
  return e.params.some(([k]) => k.startsWith('name'));
}

// Headers that differ between copies of the same message (added in transit or
// by the provider's POP/IMAP server) and must not affect duplicate detection.
const TRACE_HEADERS = new Set([
  'received',
  'return-path',
  'delivered-to',
  'dkim-signature',
  'authentication-results',
  'received-spf',
  'status',
  'content-length',
  'lines',
]);

/**
 * Hash of normalised content for duplicate detection: trace headers dropped,
 * header names lower-cased, whitespace collapsed, body line endings and
 * trailing whitespace normalised.
 */
export function computeContentHash(raw: Buffer, headers: HeaderField[], bodyStart: number): Buffer {
  const h = createHash('sha256');
  for (const f of headers) {
    if (TRACE_HEADERS.has(f.key) || f.key.startsWith('x-') || f.key.startsWith('arc-')) continue;
    h.update(f.key).update(':').update(f.value.replace(/\s+/g, ' ').trim()).update('\n');
  }
  h.update('\n');
  const body = raw.subarray(bodyStart).toString('latin1').replace(/[ \t]+\r?\n/g, '\n').replace(/\r\n/g, '\n').replace(/\s+$/, '');
  h.update(body, 'latin1');
  return h.digest();
}

function decodeWords(s: string | null): string | null {
  if (s === null) return null;
  try {
    return libmime.decodeWords(s);
  } catch {
    return s;
  }
}

export function parseMessage(raw: Buffer): ParsedMessage {
  const { entity, fields } = parseEntity(raw, 0, raw.length, ['text', 'plain'], 0);
  const envelope = buildEnvelope(fields);
  const dateRaw = getHeader(fields, 'date');
  const parsedDate = dateRaw ? new Date(dateRaw) : null;
  const fromList = envelope.from?.[0];
  let from: string | null = null;
  if (fromList) {
    const addr = fromList[2] && fromList[3] ? `${fromList[2]}@${fromList[3]}` : fromList[2] ?? '';
    const name = decodeWords(fromList[0]);
    from = name ? `${name} <${addr}>` : addr;
  }
  const mid = getHeader(fields, 'message-id');
  return {
    tree: entity,
    envelope,
    headers: fields,
    headerRaw: raw.subarray(0, entity.bs),
    messageId: mid ? mid.trim() : null,
    subject: decodeWords(getHeader(fields, 'subject')),
    from,
    date: parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate : null,
    hasAttachments: hasAttachment(entity),
    contentHash: computeContentHash(raw, fields, entity.bs),
  };
}

/** Normalised Message-ID ("<a@b>" lower-cased host part kept as-is) hash, or null. */
export function messageIdHash(messageId: string | null): Buffer | null {
  if (!messageId) return null;
  const m = messageId.match(/<[^>]+>/);
  const norm = (m ? m[0] : messageId).trim();
  if (!norm) return null;
  return createHash('sha256').update(norm).digest();
}

/**
 * Resolves an IMAP section part path (e.g. [2, 1]) to an entity.
 * Part 1 of a non-multipart message is the message body itself; a
 * message/rfc822 part is descended into transparently.
 */
export function resolvePart(root: MimeEntity, path: number[]): MimeEntity | null {
  let cur: MimeEntity = root;
  for (const n of path) {
    if (cur.msg) cur = cur.msg;
    if (cur.parts) {
      const next = cur.parts[n - 1];
      if (!next) return null;
      cur = next;
    } else if (n !== 1) {
      return null;
    }
  }
  return cur;
}
