// Small header edits on raw messages (forwarding, journaling, loop markers).
import libmime from 'libmime';
import addressparser from 'nodemailer/lib/addressparser/index.js';

/** Byte offset where the header block ends (start of the blank line), or the message length. */
function headerEnd(raw: Buffer): number {
  const i = raw.indexOf('\r\n\r\n');
  return i === -1 ? raw.length : i + 2;
}

export function prependHeaders(raw: Buffer, headers: [string, string][]): Buffer {
  if (!headers.length) return raw;
  return Buffer.concat([Buffer.from(headers.map(([k, v]) => `${k}: ${v.replace(/[\r\n]+/g, ' ')}\r\n`).join(''), 'utf8'), raw]);
}

/** Removes every occurrence (including folded continuation lines) of the named headers. */
export function removeHeaders(raw: Buffer, names: string[]): Buffer {
  const want = new Set(names.map((n) => n.toLowerCase()));
  const end = headerEnd(raw);
  const head = raw.toString('latin1', 0, end);
  const lines = head.split('\r\n');
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    if (/^[ \t]/.test(line) && line !== '') {
      if (!skipping) out.push(line);
      continue;
    }
    const name = line.slice(0, Math.max(0, line.indexOf(':'))).trim().toLowerCase();
    skipping = want.has(name);
    if (!skipping) out.push(line);
  }
  return Buffer.concat([Buffer.from(out.join('\r\n'), 'latin1'), raw.subarray(end)]);
}

/** Raw (undecoded) value of the first occurrence of a header, unfolded. */
export function headerValue(raw: Buffer, name: string): string | null {
  const head = raw.toString('latin1', 0, headerEnd(raw)).replace(/\r\n[ \t]+/g, ' ');
  const m = new RegExp(`^${name.replace(/[-]/g, '\\-')}:[ \\t]*(.*)$`, 'im').exec(head);
  return m ? m[1]!.trim() : null;
}

export function loopCount(raw: Buffer, installId: string): number {
  const head = raw.toString('latin1', 0, headerEnd(raw));
  const re = /^X-VPM-Loop:[ \t]*([^\r\n]*)/gim;
  let n = 0;
  for (let m = re.exec(head); m; m = re.exec(head)) if (m[1]!.trim() === installId) n++;
  return n;
}

export function receivedCount(raw: Buffer): number {
  const head = raw.toString('latin1', 0, headerEnd(raw));
  return (head.match(/^Received:/gim) ?? []).length;
}

/**
 * DMARC-safe forwarding: From becomes "Original Name via Forwarder <forwarder>",
 * Reply-To keeps pointing at the original sender, the (now invalid) DKIM
 * signature is dropped.
 */
export function rewriteFromForForward(raw: Buffer, forwarderAddress: string, forwarderName: string): Buffer {
  const original = headerValue(raw, 'From') ?? '';
  const parsed = addressparser(original)[0];
  let origName = parsed?.name || parsed?.address || 'Sender';
  try {
    origName = libmime.decodeWords(origName);
  } catch {
    /* keep */
  }
  const display = `${origName} via ${forwarderName}`.replace(/["\\]/g, '');
  const encoded = /^[\x20-\x7e]*$/.test(display) ? `"${display}"` : libmime.encodeWords(display, 'Q', 52);
  const hadReplyTo = headerValue(raw, 'Reply-To') !== null;
  let out = removeHeaders(raw, ['From', 'DKIM-Signature', 'Sender', 'Return-Path']);
  const add: [string, string][] = [
    ['From', `${encoded} <${forwarderAddress}>`],
    ['X-Original-From', original],
  ];
  if (!hadReplyTo && original) add.push(['Reply-To', original]);
  out = prependHeaders(out, add);
  return out;
}
