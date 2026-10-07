// Exports messages as MBOX (mboxrd) or a ZIP of .eml files, streamed.
import type { Writable } from 'node:stream';
import { ZipArchive } from 'archiver';
import type { Db } from '../db.js';
import { rows } from '../db.js';
import type { BlobStore } from '../store/blobstore.js';

export const EXPORT_LIMIT = 10_000;

function asctime(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const mons = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const p = (n: number) => String(n).padStart(2, '0');
  return `${days[d.getUTCDay()]} ${mons[d.getUTCMonth()]} ${String(d.getUTCDate()).padStart(2, ' ')} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} ${d.getUTCFullYear()}`;
}

/** mboxrd: LF line endings, every line matching ^>*From  gets one more '>'. */
export function toMboxEntry(raw: Buffer, envelopeFrom: string, date: Date): Buffer {
  const body = raw.toString('latin1').replace(/\r\n/g, '\n').replace(/^(>*From )/gm, '>$1');
  const sep = `From ${envelopeFrom || 'MAILER-DAEMON'} ${asctime(date)}\n`;
  return Buffer.from(sep + body + (body.endsWith('\n') ? '' : '\n') + '\n', 'latin1');
}

function safeName(s: string): string {
  return (s || 'no subject').replace(/[\\/:*?"<>|\x00-\x1f]+/g, '_').slice(0, 80).trim() || 'message';
}

/** Streams the given messages (by messages.id, in order) to `out`. */
export async function exportMessages(
  db: Db,
  blobs: BlobStore,
  messageIds: number[],
  format: 'mbox' | 'eml_zip',
  out: Writable,
): Promise<number> {
  const ids = messageIds.slice(0, EXPORT_LIMIT);
  let zip: ZipArchive | null = null;
  if (format === 'eml_zip') {
    zip = new ZipArchive({ zlib: { level: 6 } });
    zip.pipe(out);
  }
  let n = 0;
  for (let i = 0; i < ids.length; i += 200) {
    const batch = await rows<{ id: number; storage_path: string; codec: number; hdr_subject: string | null; hdr_date: Date | null; created_at: Date; hdr_from: string | null }>(
      db,
      'SELECT id, storage_path, codec, hdr_subject, hdr_date, created_at, hdr_from FROM messages WHERE id IN (?)',
      [ids.slice(i, i + 200)],
    );
    const byId = new Map(batch.map((b) => [b.id, b]));
    for (const id of ids.slice(i, i + 200)) {
      const m = byId.get(id);
      if (!m) continue;
      const raw = await blobs.get(m.storage_path, m.codec);
      n++;
      if (zip) {
        zip.append(raw, { name: `${String(n).padStart(5, '0')} - ${safeName(m.hdr_subject ?? '')}.eml`, date: m.hdr_date ?? m.created_at });
      } else {
        const sender = /<([^>]+)>/.exec(m.hdr_from ?? '')?.[1] ?? m.hdr_from ?? '';
        if (!out.write(toMboxEntry(raw, sender.replace(/\s/g, ''), new Date(m.hdr_date ?? m.created_at)))) await new Promise((r) => out.once('drain', r));
      }
    }
  }
  if (zip) await zip.finalize();
  else out.end();
  return n;
}

/** Upper bound for a mailbox-structured export (streamed, so memory stays flat). */
export const ARCHIVE_TREE_LIMIT = 100_000;

export interface ArchiveTreeEntry {
  messageId: number;
  /** Mailbox address: the top-level folder. */
  address: string;
  role: 'received' | 'sent';
  /** archive_items.id, keeps file names unique. */
  archiveId: number;
}

function stamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}

/**
 * ZIP laid out like the archive's mailbox view:
 *   <address>/Received/<date> - <subject> [<id>].eml
 *   <address>/Sent/<date> - <subject> [<id>].eml
 * A message between two colleagues appears in both mailboxes.
 */
export async function exportArchiveTree(db: Db, blobs: BlobStore, entries: ArchiveTreeEntry[], out: Writable): Promise<number> {
  const list = entries.slice(0, ARCHIVE_TREE_LIMIT);
  const zip = new ZipArchive({ zlib: { level: 6 } });
  zip.pipe(out);
  let n = 0;
  for (let i = 0; i < list.length; i += 200) {
    const chunk = list.slice(i, i + 200);
    const batch = await rows<{ id: number; storage_path: string; codec: number; hdr_subject: string | null; hdr_date: Date | null; created_at: Date }>(
      db,
      'SELECT id, storage_path, codec, hdr_subject, hdr_date, created_at FROM messages WHERE id IN (?)',
      [[...new Set(chunk.map((e) => e.messageId))]],
    );
    const byId = new Map(batch.map((b) => [b.id, b]));
    for (const e of chunk) {
      const m = byId.get(e.messageId);
      if (!m) continue;
      const date = new Date(m.hdr_date ?? m.created_at);
      const dir = `${safeName(e.address.toLowerCase())}/${e.role === 'sent' ? 'Sent' : 'Received'}`;
      zip.append(await blobs.get(m.storage_path, m.codec), { name: `${dir}/${stamp(date)} - ${safeName(m.hdr_subject ?? '')} [${e.archiveId}].eml`, date });
      n++;
    }
  }
  await zip.finalize();
  return n;
}
