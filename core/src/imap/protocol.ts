// IMAP wire-format primitives: command tokenizer, response encoder,
// sequence sets and modified UTF-7 mailbox names (RFC 3501 §5.1.3).

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

export type Token =
  | { t: 'atom'; v: string }
  | { t: 'string'; v: Buffer }
  | { t: 'list'; v: Token[] };

export interface Command {
  tag: string;
  name: string; // upper-case; "UID FETCH" style for UID commands
  args: Token[];
}

export class ImapParseError extends Error {
  constructor(
    message: string,
    public readonly tag?: string,
  ) {
    super(message);
  }
}

const SP = 0x20;
const CR = 0x0d;
const LF = 0x0a;

class Tokenizer {
  i = 0;
  constructor(private readonly b: Buffer) {}

  atEnd(): boolean {
    return this.i >= this.b.length || this.b[this.i] === CR || this.b[this.i] === LF;
  }

  skipSpaces(): void {
    while (this.b[this.i] === SP) this.i++;
  }

  word(): string {
    const start = this.i;
    while (this.i < this.b.length && this.b[this.i] !== SP && this.b[this.i] !== CR && this.b[this.i] !== LF) this.i++;
    return this.b.toString('utf8', start, this.i);
  }

  items(inList: boolean): Token[] {
    const out: Token[] = [];
    for (;;) {
      this.skipSpaces();
      if (this.atEnd()) {
        if (inList) throw new ImapParseError('Unterminated list');
        return out;
      }
      const c = this.b[this.i];
      if (c === 0x29 /* ) */) {
        if (!inList) throw new ImapParseError('Unexpected )');
        this.i++;
        return out;
      }
      if (c === 0x28 /* ( */) {
        this.i++;
        out.push({ t: 'list', v: this.items(true) });
      } else if (c === 0x22 /* " */) {
        out.push({ t: 'string', v: this.quoted() });
      } else if (c === 0x7b /* { */) {
        out.push({ t: 'string', v: this.literal() });
      } else {
        out.push({ t: 'atom', v: this.atom() });
      }
    }
  }

  quoted(): Buffer {
    this.i++; // opening quote
    const bytes: number[] = [];
    for (;;) {
      if (this.i >= this.b.length || this.b[this.i] === CR || this.b[this.i] === LF) throw new ImapParseError('Unterminated quoted string');
      const c = this.b[this.i++]!;
      if (c === 0x22) break;
      if (c === 0x5c /* \ */) {
        bytes.push(this.b[this.i++]!);
        continue;
      }
      bytes.push(c);
    }
    return Buffer.from(bytes);
  }

  literal(): Buffer {
    const close = this.b.indexOf(0x7d, this.i);
    if (close === -1) throw new ImapParseError('Bad literal');
    const spec = this.b.toString('latin1', this.i + 1, close).replace('+', '');
    const n = Number(spec);
    if (!Number.isInteger(n) || n < 0) throw new ImapParseError('Bad literal length');
    this.i = close + 1;
    if (this.b[this.i] === CR) this.i++;
    if (this.b[this.i] !== LF) throw new ImapParseError('Literal must be followed by CRLF');
    this.i++;
    if (this.i + n > this.b.length) throw new ImapParseError('Literal truncated');
    const v = this.b.subarray(this.i, this.i + n);
    this.i += n;
    return Buffer.from(v);
  }

  /** Atoms may contain a [section] (with spaces/parens inside) and a <partial>. */
  atom(): string {
    const start = this.i;
    while (this.i < this.b.length) {
      const c = this.b[this.i];
      if (c === SP || c === CR || c === LF || c === 0x28 || c === 0x29 || c === 0x22 || c === 0x7b) break;
      if (c === 0x5b /* [ */) {
        const close = this.b.indexOf(0x5d /* ] */, this.i);
        if (close === -1) throw new ImapParseError('Unterminated [');
        this.i = close + 1;
        continue;
      }
      this.i++;
    }
    if (this.i === start) throw new ImapParseError('Unexpected character');
    return this.b.toString('utf8', start, this.i);
  }
}

export function parseCommand(buf: Buffer): Command {
  const tk = new Tokenizer(buf);
  const tag = tk.word();
  if (!tag || /[\s(){%*"\\\]]/.test(tag)) throw new ImapParseError('Invalid tag');
  if (buf[tk.i] !== SP) throw new ImapParseError('Missing command', tag);
  tk.i++;
  let name = tk.word().toUpperCase();
  if (!name) throw new ImapParseError('Missing command', tag);
  if (name === 'UID') {
    if (buf[tk.i] !== SP) throw new ImapParseError('Missing UID subcommand', tag);
    tk.i++;
    name = 'UID ' + tk.word().toUpperCase();
  }
  try {
    const args = tk.items(false);
    return { tag, name, args };
  } catch (e) {
    throw new ImapParseError((e as Error).message, tag);
  }
}

export function tokenString(t: Token | undefined): string | null {
  if (!t) return null;
  if (t.t === 'atom') return t.v;
  if (t.t === 'string') return t.v.toString('utf8');
  return null;
}

// ---------------------------------------------------------------------------
// Response encoding
// ---------------------------------------------------------------------------

export type IVal =
  | null
  | number
  | bigint
  | string
  | Buffer
  | IVal[]
  | { atom: string }
  | { literal: Buffer }
  /** "(" items joined WITHOUT spaces ")" — address lists */
  | { tight: IVal[] }
  /** items joined without spaces and without parens — multipart children */
  | { seq: IVal[] };

const QUOTE_SAFE = /^[\x20-\x7e]*$/;

export function encodeValue(v: IVal, out: Buffer[]): void {
  if (v === null) {
    out.push(Buffer.from('NIL'));
  } else if (typeof v === 'number' || typeof v === 'bigint') {
    out.push(Buffer.from(String(v)));
  } else if (typeof v === 'string') {
    if (v.length < 1024 && QUOTE_SAFE.test(v)) {
      out.push(Buffer.from('"' + v.replace(/[\\"]/g, (m) => '\\' + m) + '"'));
    } else {
      const b = Buffer.from(v, 'utf8');
      out.push(Buffer.from(`{${b.length}}\r\n`), b);
    }
  } else if (Buffer.isBuffer(v)) {
    out.push(Buffer.from(`{${v.length}}\r\n`), v);
  } else if (Array.isArray(v)) {
    out.push(Buffer.from('('));
    v.forEach((x, i) => {
      if (i) out.push(Buffer.from(' '));
      encodeValue(x, out);
    });
    out.push(Buffer.from(')'));
  } else if ('atom' in v) {
    out.push(Buffer.from(v.atom));
  } else if ('literal' in v) {
    out.push(Buffer.from(`{${v.literal.length}}\r\n`), v.literal);
  } else if ('tight' in v) {
    out.push(Buffer.from('('));
    for (const x of v.tight) encodeValue(x, out);
    out.push(Buffer.from(')'));
  } else {
    for (const x of v.seq) encodeValue(x, out);
  }
}

export function encode(v: IVal): Buffer {
  const out: Buffer[] = [];
  encodeValue(v, out);
  return Buffer.concat(out);
}

/** Encodes items separated by spaces, without surrounding parens. */
export function encodeItems(items: IVal[]): Buffer {
  const out: Buffer[] = [];
  items.forEach((x, i) => {
    if (i) out.push(Buffer.from(' '));
    encodeValue(x, out);
  });
  return Buffer.concat(out);
}

/** Mailbox name as astring (atom when safe, otherwise quoted/literal). */
export function mailboxName(name: string): IVal {
  const enc = encodeMailboxName(name);
  return /^[A-Za-z0-9_.\-/&+,]+$/.test(enc) && enc.toUpperCase() !== 'NIL' ? { atom: enc } : enc;
}

// ---------------------------------------------------------------------------
// Sequence sets
// ---------------------------------------------------------------------------

export type SeqRange = [number, number]; // inclusive; Infinity = '*'

export function parseSeqSet(s: string): SeqRange[] {
  if (!/^(\d+|\*)(:(\d+|\*))?(,(\d+|\*)(:(\d+|\*))?)*$/.test(s)) throw new ImapParseError('Invalid sequence set');
  return s.split(',').map((part) => {
    const [a, b] = part.split(':') as [string, string | undefined];
    const x = a === '*' ? Infinity : Number(a);
    const y = b === undefined ? x : b === '*' ? Infinity : Number(b);
    if (x === 0 || y === 0) throw new ImapParseError('Invalid sequence number 0');
    return [Math.min(x, y), Math.max(x, y)];
  });
}

/** Resolves '*' to `max` and tests membership. */
export function inSeqSet(ranges: SeqRange[], n: number, max: number): boolean {
  for (const [a0, b0] of ranges) {
    const a = a0 === Infinity ? max : a0;
    const b = b0 === Infinity ? max : b0;
    if (n >= Math.min(a, b) && n <= Math.max(a, b)) return true;
  }
  return false;
}

/** Compresses sorted numbers into "1:3,5,7:9". */
export function compressSet(nums: number[]): string {
  const s = [...nums].sort((a, b) => a - b);
  const out: string[] = [];
  for (let i = 0; i < s.length; ) {
    let j = i;
    while (j + 1 < s.length && s[j + 1] === s[j]! + 1) j++;
    out.push(i === j ? String(s[i]) : `${s[i]}:${s[j]}`);
    i = j + 1;
  }
  return out.join(',');
}

// ---------------------------------------------------------------------------
// Modified UTF-7 (RFC 3501 §5.1.3)
// ---------------------------------------------------------------------------

export function encodeMailboxName(s: string): string {
  let out = '';
  let buf: number[] = [];
  const flush = () => {
    if (!buf.length) return;
    const bytes = Buffer.alloc(buf.length * 2);
    buf.forEach((c, i) => bytes.writeUInt16BE(c, i * 2));
    out += '&' + bytes.toString('base64').replace(/=+$/, '').replace(/\//g, ',') + '-';
    buf = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0x20 && c <= 0x7e) {
      flush();
      out += c === 0x26 ? '&-' : s[i];
    } else {
      buf.push(c);
    }
  }
  flush();
  return out;
}

export function decodeMailboxName(s: string): string {
  return s.replace(/&([^-]*)-/g, (_, b64: string) => {
    if (b64 === '') return '&';
    const bytes = Buffer.from(b64.replace(/,/g, '/'), 'base64');
    let r = '';
    for (let i = 0; i + 1 < bytes.length; i += 2) r += String.fromCharCode(bytes.readUInt16BE(i));
    return r;
  });
}

// ---------------------------------------------------------------------------
// Flags
// ---------------------------------------------------------------------------

export const FLAG_BITS: [string, number][] = [
  ['\\Seen', 1],
  ['\\Answered', 2],
  ['\\Flagged', 4],
  ['\\Deleted', 8],
  ['\\Draft', 16],
  ['$Forwarded', 32],
  ['$Junk', 64],
  ['$NotJunk', 128],
];
export const SEEN = 1;
export const DELETED = 8;

export function flagsToList(bits: number, keywords: string[] = []): IVal[] {
  const out: IVal[] = [];
  for (const [name, bit] of FLAG_BITS) if (bits & bit) out.push({ atom: name });
  for (const k of keywords) out.push({ atom: k });
  return out;
}

/** Splits client flag names into system bits and custom keywords. \Recent is ignored. */
export function parseFlags(names: string[]): { bits: number; keywords: string[] } {
  let bits = 0;
  const keywords: string[] = [];
  for (const n of names) {
    const sys = FLAG_BITS.find(([f]) => f.toLowerCase() === n.toLowerCase());
    if (sys) bits |= sys[1];
    else if (n.toLowerCase() === '\\recent') continue;
    else if (n.startsWith('\\')) throw new ImapParseError(`Unknown system flag ${n}`);
    else if (/^[^\s(){%*"\\\]]+$/.test(n) && n.length <= 100) keywords.push(n);
    else throw new ImapParseError(`Invalid keyword ${n}`);
  }
  return { bits, keywords };
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** IMAP date-time: "05-Oct-2026 06:46:21 +0000" */
export function formatInternalDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getUTCDate())}-${MONTHS[d.getUTCMonth()]}-${d.getUTCFullYear()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} +0000`;
}

export function parseInternalDate(s: string): Date | null {
  const m = s.trim().match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$/);
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase());
  if (mon < 0) return null;
  const utc = Date.UTC(+m[3]!, mon, +m[1]!, +m[4]!, +m[5]!, +m[6]!);
  const off = (+m[8]! * 60 + +m[9]!) * 60000 * (m[7] === '+' ? 1 : -1);
  return new Date(utc - off);
}

/** SEARCH date: "1-Feb-1994" → UTC midnight. */
export function parseSearchDate(s: string): Date | null {
  const m = s.match(/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/);
  if (!m) return null;
  const mon = MONTHS.findIndex((x) => x.toLowerCase() === m[2]!.toLowerCase());
  if (mon < 0) return null;
  return new Date(Date.UTC(+m[3]!, mon, +m[1]!));
}
