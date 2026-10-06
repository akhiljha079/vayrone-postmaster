// Quarantine: messages held by the filter (virus, blocked attachment, spam
// above the quarantine score). Nothing is lost: an admin can release a held
// message to its recipients, or delete it; old entries expire after
// `quarantineDays` (maintenance job).
import type { Db, Queryable } from '../db.js';
import { exec, json, one, rows, tx } from '../db.js';
import type { StoredMessage } from '../store/mailstore.js';

export interface QuarantineInput {
  message: StoredMessage;
  direction: 'in' | 'internal' | 'out';
  kind: 'virus' | 'attachment' | 'spam';
  reason: string;
  envelopeFrom: string;
  recipients: { userId: number; folderId?: number | null }[];
  origin: string;
  externalAccountId?: number | null;
}

export interface QuarantineRow {
  id: number;
  message_id: number;
  direction: 'in' | 'internal' | 'out';
  kind: 'virus' | 'attachment' | 'spam';
  reason: string;
  envelope_from: string;
  recipients: unknown;
  subject: string | null;
  size: number;
  origin: string;
  external_account_id: number | null;
  created_at: Date;
  released_at: Date | null;
  deleted_at: Date | null;
}

export async function quarantineMessage(db: Db, q: QuarantineInput): Promise<number> {
  return tx(db, async (c) => {
    const r = await exec(
      c,
      `INSERT INTO quarantine (message_id, direction, kind, reason, envelope_from, recipients, subject, size, origin, external_account_id, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      [
        q.message.id,
        q.direction,
        q.kind,
        q.reason.slice(0, 500),
        q.envelopeFrom.slice(0, 254),
        JSON.stringify(q.recipients),
        q.message.parsed.subject?.slice(0, 255) ?? null,
        q.message.size,
        q.origin,
        q.externalAccountId ?? null,
        new Date(),
      ],
    );
    await exec(c, 'UPDATE messages SET refcount = refcount + 1 WHERE id = ?', [q.message.id]);
    return r.insertId;
  });
}

export function quarantineRecipients(r: QuarantineRow): { userId: number; folderId?: number | null }[] {
  return json<{ userId: number; folderId?: number | null }[]>(r.recipients) ?? [];
}

/** Marks a held message released (the caller delivers it) or deleted, and drops the quarantine's reference. */
export async function closeQuarantine(q: Queryable, id: number, how: 'released' | 'deleted', userId: number | null): Promise<QuarantineRow | null> {
  const row = await one<QuarantineRow>(q, 'SELECT * FROM quarantine WHERE id = ? AND released_at IS NULL AND deleted_at IS NULL', [id]);
  if (!row) return null;
  if (how === 'released') await exec(q, 'UPDATE quarantine SET released_at = ?, released_by = ? WHERE id = ?', [new Date(), userId, id]);
  else await exec(q, 'UPDATE quarantine SET deleted_at = ?, released_by = ? WHERE id = ?', [new Date(), userId, id]);
  await exec(q, 'UPDATE messages SET refcount = GREATEST(refcount - 1, 0) WHERE id = ?', [row.message_id]);
  return row;
}

/** Deletes held messages older than `days` (garbage collection then removes unused message files). */
export async function purgeQuarantine(db: Db, days: number): Promise<number> {
  const old = await rows<{ id: number }>(db, 'SELECT id FROM quarantine WHERE released_at IS NULL AND deleted_at IS NULL AND created_at < ?', [new Date(Date.now() - days * 86_400_000)]);
  for (const r of old) await closeQuarantine(db, r.id, 'deleted', null);
  return old.length;
}
