// Shared "show this message" rendering for webmail and the archive viewer.
import { simpleParser, type AddressObject } from 'mailparser';
import { sanitizeEmailHtml, textToHtml } from './html.js';

export interface RenderedMessage {
  subject: string;
  from: { name: string; address: string }[];
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  bcc: { name: string; address: string }[];
  date: Date | null;
  messageId: string | null;
  html: string;
  remoteImages: boolean;
  attachments: { index: number; filename: string; contentType: string; size: number }[];
}

function addrList(a: AddressObject | AddressObject[] | undefined): { name: string; address: string }[] {
  if (!a) return [];
  return (Array.isArray(a) ? a : [a]).flatMap((x) => x.value.flatMap((v) => (v.group ? v.group : [v])).map((v) => ({ name: v.name ?? '', address: (v.address ?? '').toLowerCase() })));
}

export async function renderMessage(raw: Buffer, showImages: boolean): Promise<RenderedMessage> {
  const p = await simpleParser(raw, { skipTextToHtml: true, skipImageLinks: true });
  const inline = p.attachments.map((a) => ({ cid: a.cid, contentType: a.contentType, content: a.content }));
  const body = typeof p.html === 'string' && p.html ? sanitizeEmailHtml(p.html, inline, showImages) : { html: textToHtml(p.text ?? ''), remoteImages: false };
  const used = new Set<string>();
  if (typeof p.html === 'string') for (const m of p.html.matchAll(/cid:([^"'\s)>]+)/gi)) used.add(m[1]!.toLowerCase());
  return {
    subject: p.subject ?? '',
    from: addrList(p.from),
    to: addrList(p.to),
    cc: addrList(p.cc),
    bcc: addrList(p.bcc),
    date: p.date ?? null,
    messageId: p.messageId ?? null,
    html: body.html,
    remoteImages: body.remoteImages,
    attachments: p.attachments
      .map((a, index) => ({ index, filename: a.filename ?? `attachment-${index + 1}`, contentType: a.contentType, size: a.size, inline: Boolean(a.cid && used.has(a.cid.toLowerCase())) }))
      .filter((a) => !a.inline)
      .map(({ inline, ...a }) => (void inline, a)),
  };
}

export async function attachmentOf(raw: Buffer, index: number): Promise<{ filename: string; contentType: string; content: Buffer } | null> {
  const p = await simpleParser(raw, { skipTextToHtml: true, skipImageLinks: true });
  const a = p.attachments[index];
  return a ? { filename: a.filename ?? 'attachment', contentType: a.contentType || 'application/octet-stream', content: a.content } : null;
}

export function contentDisposition(filename: string): string {
  const ascii = filename.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`;
}
