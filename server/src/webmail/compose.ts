// Building outgoing webmail messages and resolving their recipients.
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import { convert as htmlToText } from 'html-to-text';
import { z } from 'zod';
import type { CoreContext } from '@vpm/core';
import { badRequest } from '../http.js';

export const ComposeBody = z.object({
  from: z.string().trim().toLowerCase().max(254),
  to: z.array(z.string().trim().max(400)).max(500).default([]),
  cc: z.array(z.string().trim().max(400)).max(500).default([]),
  bcc: z.array(z.string().trim().max(400)).max(500).default([]),
  subject: z.string().max(998).default(''),
  html: z.string().max(5_000_000).default(''),
  uploads: z.array(z.string().regex(/^[a-f0-9]{24}$/)).max(50).default([]),
  /** Attachments carried over from an existing message (forward, or re-editing a draft). */
  carried: z.array(z.object({ itemId: z.number().int().positive(), index: z.number().int().min(0) })).max(50).default([]),
  /** The message being replied to / forwarded (sets \Answered / $Forwarded on it). */
  replyToItemId: z.number().int().positive().nullable().optional(),
  forwardOfItemId: z.number().int().positive().nullable().optional(),
  inReplyTo: z.string().max(998).nullable().optional(),
  references: z.string().max(4000).nullable().optional(),
  draftItemId: z.number().int().positive().nullable().optional(),
  priority: z.enum(['high', 'normal', 'low']).default('normal'),
});
export type ComposeBody = z.infer<typeof ComposeBody>;

export interface UploadMeta {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  userId: number;
}

export const uploadDir = (ctx: CoreContext, userId: number) => join(ctx.config.dataPath, 'tmp', 'uploads', String(userId));

export async function readUploadMeta(ctx: CoreContext, userId: number, id: string): Promise<UploadMeta> {
  try {
    const meta = JSON.parse(await readFile(join(uploadDir(ctx, userId), `${id}.json`), 'utf8')) as UploadMeta;
    if (meta.userId !== userId) throw new Error('owner');
    return meta;
  } catch {
    throw badRequest('An attachment upload has expired; please attach the file again');
  }
}

/** Parses "Name <a@b>", "a@b" and groups into bare lower-case addresses. */
export function parseAddressList(list: string[]): { address: string; name: string }[] {
  const out: { address: string; name: string }[] = [];
  for (const entry of list) {
    for (const a of addressparser(entry)) {
      for (const x of a.group ?? [a]) {
        if (!x.address) continue;
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x.address)) throw badRequest(`"${x.address}" is not a valid email address`);
        out.push({ address: x.address.toLowerCase(), name: x.name ?? '' });
      }
    }
  }
  return out;
}

export interface BuiltMessage {
  /** As sent (no Bcc header). */
  raw: Buffer;
  /** For the Sent / Drafts folder (keeps Bcc, like Outlook). */
  rawWithBcc: Buffer;
  recipients: string[];
  messageId: string;
}

export async function buildMessage(
  ctx: CoreContext,
  user: { id: number; displayName: string },
  b: ComposeBody,
  carried: { filename: string; contentType: string; content: Buffer; cid?: string }[],
): Promise<BuiltMessage> {
  const to = parseAddressList(b.to);
  const cc = parseAddressList(b.cc);
  const bcc = parseAddressList(b.bcc);
  const recipients = [...new Set([...to, ...cc, ...bcc].map((a) => a.address))];
  const attachments: Record<string, unknown>[] = carried.map((c) => ({ filename: c.filename, contentType: c.contentType, content: c.content, ...(c.cid ? { cid: c.cid } : {}) }));
  for (const id of b.uploads) {
    const meta = await readUploadMeta(ctx, user.id, id);
    attachments.push({ filename: meta.filename, contentType: meta.contentType, path: join(uploadDir(ctx, user.id), id) });
  }
  const messageId = `<${randomBytes(12).toString('hex')}@${ctx.config.hostname}>`;
  const html = b.html || '<p></p>';
  const opts = {
    from: { name: user.displayName, address: b.from },
    to: to.map((a) => ({ name: a.name, address: a.address })),
    cc: cc.map((a) => ({ name: a.name, address: a.address })),
    bcc: bcc.map((a) => ({ name: a.name, address: a.address })),
    subject: b.subject,
    html,
    text: htmlToText(html, { wordwrap: 78, selectors: [{ selector: 'img', format: 'skip' }] }),
    messageId,
    date: new Date(),
    priority: b.priority,
    ...(b.inReplyTo ? { inReplyTo: b.inReplyTo } : {}),
    ...(b.references ? { references: b.references } : {}),
    headers: { 'X-Mailer': 'Vayrone PostMaster Webmail' },
    attachments,
  };
  const build = async (keepBcc: boolean) => {
    const mail = new MailComposer(opts as ConstructorParameters<typeof MailComposer>[0]).compile();
    (mail as unknown as { keepBcc: boolean }).keepBcc = keepBcc;
    return mail.build();
  };
  const raw = await build(false);
  const rawWithBcc = bcc.length ? await build(true) : raw;
  return { raw, rawWithBcc, recipients, messageId };
}

/** Splits recipients into local mailboxes and external addresses, applying domain policies. */
export async function resolveRecipients(ctx: CoreContext, addrs: string[]): Promise<{ local: number[]; external: string[]; rejected: string[] }> {
  const local = new Set<number>();
  const external = new Set<string>();
  const rejected: string[] = [];
  for (const a of addrs) {
    const r = await ctx.directory.resolve(a);
    if (r.kind === 'local') {
      r.userIds.forEach((u) => local.add(u));
      r.external.forEach((e) => external.add(e));
    } else if (r.kind === 'unknown-local') {
      if (r.action === 'reject') rejected.push(a);
      else if (r.action === 'catchall' && r.catchallUserId) local.add(r.catchallUserId);
      else external.add(a);
    } else {
      external.add(a);
    }
  }
  return { local: [...local], external: [...external], rejected };
}
