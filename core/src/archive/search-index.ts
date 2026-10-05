// Full-text index (InnoDB FULLTEXT on message_search). Filled in the
// background by the worker so delivery never waits for text extraction.
import type { Db } from '../db.js';
import { exec, json, rows } from '../db.js';
import type { BlobStore } from '../store/blobstore.js';
import type { Envelope, MimeEntity } from '../mime/mime.js';
import { extractBodyText } from '../imap/search.js';
import libmime from 'libmime';

const MAX_BODY = 1024 * 1024;

function names(e: MimeEntity, out: string[] = []): string[] {
  if (e.parts) e.parts.forEach((p) => names(p, out));
  const n = e.disp?.[1].find(([k]) => k.startsWith('filename'))?.[1] ?? e.params.find(([k]) => k.startsWith('name'))?.[1];
  if (n) {
    try {
      out.push(libmime.decodeWords(n));
    } catch {
      out.push(n);
    }
  }
  return out;
}

function addresses(env: Envelope): string {
  const parts: string[] = [];
  for (const list of [env.from, env.to, env.cc, env.bcc, env.replyTo]) {
    for (const a of list ?? []) {
      if (a[0]) {
        try {
          parts.push(libmime.decodeWords(a[0]));
        } catch {
          parts.push(a[0]);
        }
      }
      if (a[2] && a[3]) parts.push(`${a[2]}@${a[3]}`);
    }
  }
  return parts.join(' ');
}

/** Indexes up to `limit` messages that have no search row yet. Returns how many were indexed. */
export async function indexPending(db: Db, blobs: BlobStore, limit = 200): Promise<number> {
  const pending = await rows<{ id: number; storage_path: string; codec: number; hdr_subject: string | null; envelope_json: unknown; bodystructure_json: unknown }>(
    db,
    `SELECT m.id, m.storage_path, m.codec, m.hdr_subject, m.envelope_json, m.bodystructure_json
       FROM messages m LEFT JOIN message_search s ON s.message_id = m.id
      WHERE s.message_id IS NULL AND m.refcount > 0 ORDER BY m.id DESC LIMIT ?`,
    [limit],
  );
  let n = 0;
  for (const m of pending) {
    let body = '';
    let attachmentNames = '';
    const tree = json<MimeEntity>(m.bodystructure_json);
    try {
      const raw = await blobs.get(m.storage_path, m.codec);
      body = extractBodyText(raw, tree).slice(0, MAX_BODY);
      attachmentNames = names(tree).join(' ');
    } catch {
      /* unreadable file: index headers only; the integrity check reports the file */
    }
    await exec(db, 'INSERT IGNORE INTO message_search (message_id, subject, addresses, attachment_names, body_text) VALUES (?,?,?,?,?)', [
      m.id,
      (m.hdr_subject ?? '').slice(0, 998),
      addresses(json<Envelope>(m.envelope_json)).slice(0, 60000),
      attachmentNames.slice(0, 60000),
      body,
    ]);
    n++;
  }
  return n;
}

/**
 * Turns user input into a safe BOOLEAN MODE query: every word is required and
 * prefix-matched; "quoted phrases" stay phrases. Returns null when nothing
 * searchable is left (InnoDB ignores words shorter than 3 characters).
 */
export function fulltextQuery(input: string): string | null {
  const terms: string[] = [];
  const re = /"([^"]+)"|(\S+)/g;
  for (let m = re.exec(input); m; m = re.exec(input)) {
    if (m[1]) {
      const phrase = m[1].replace(/["+\-<>()~*@]/g, ' ').trim();
      if (phrase.length >= 3) terms.push(`+"${phrase}"`);
    } else {
      // \p{M}: Devanagari vowel signs (matras) are combining marks and part of the word.
      for (const w of m[2]!.split(/[^\p{L}\p{M}\p{N}_]+/u)) if (w.length >= 3) terms.push(`+${w}*`);
    }
  }
  return terms.length ? terms.join(' ') : null;
}
