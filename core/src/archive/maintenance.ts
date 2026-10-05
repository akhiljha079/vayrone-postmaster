// Retention and garbage collection (run nightly by the worker).
import type { Db } from '../db.js';
import { exec, one, rows, tx } from '../db.js';
import type { BlobStore } from '../store/blobstore.js';
import type { MailStore } from '../store/mailstore.js';

/** Deletes archive items past their retention date (never those on legal hold). */
export async function purgeArchive(db: Db, batch = 1000): Promise<number> {
  let total = 0;
  for (;;) {
    const due = await rows<{ id: number; message_id: number }>(
      db,
      'SELECT id, message_id FROM archive_items WHERE legal_hold = 0 AND retention_until IS NOT NULL AND retention_until < ? LIMIT ?',
      [new Date(), batch],
    );
    if (!due.length) return total;
    await tx(db, async (c) => {
      await exec(c, 'DELETE FROM archive_items WHERE id IN (?)', [due.map((d) => d.id)]);
      const per = new Map<number, number>();
      for (const d of due) per.set(d.message_id, (per.get(d.message_id) ?? 0) + 1);
      for (const [mid, n] of per) await exec(c, 'UPDATE messages SET refcount = GREATEST(0, CAST(refcount AS SIGNED) - ?) WHERE id = ?', [n, mid]);
    });
    total += due.length;
  }
}

/**
 * Mailbox retention: removes messages older than N days from folders of a given
 * kind (e.g. Trash after 30 days, Junk after 15) for the policy's scope.
 */
export async function purgeMailboxFolders(db: Db, store: MailStore): Promise<number> {
  const pols = await rows<{ scope: string; scope_id: number | null; special_use: string | null; keep_days: number }>(
    db,
    "SELECT scope, scope_id, special_use, keep_days FROM retention_policies WHERE target = 'mailbox_folder' AND is_enabled = 1 AND special_use IS NOT NULL",
  );
  let total = 0;
  for (const p of pols) {
    const scopeSql =
      p.scope === 'all'
        ? ''
        : p.scope === 'user'
          ? 'AND f.user_id = ?'
          : p.scope === 'domain'
            ? 'AND f.user_id IN (SELECT id FROM users WHERE domain_id = ?)'
            : 'AND f.user_id IN (SELECT user_id FROM user_group_members WHERE group_id = ?)';
    const folders = await rows<{ id: number }>(db, `SELECT f.id FROM folders f WHERE f.special_use = ? ${scopeSql}`, p.scope === 'all' ? [p.special_use] : [p.special_use, p.scope_id]);
    const cutoff = new Date(Date.now() - p.keep_days * 86400_000);
    for (const f of folders) {
      for (;;) {
        const old = (await rows<{ uid: number }>(db, 'SELECT uid FROM mail_items WHERE folder_id = ? AND internal_date < ? LIMIT 2000', [f.id, cutoff])).map((r) => r.uid);
        if (!old.length) break;
        await store.storeFlags(f.id, old, 'add', 8, null);
        total += (await store.expunge(f.id, old)).length;
      }
    }
  }
  return total;
}

/**
 * Removes stored messages nothing refers to any more (refcount 0, older than a
 * grace period so in-flight deliveries are safe). Refcounts are re-checked
 * against the real references before anything is deleted.
 */
export async function collectGarbage(db: Db, blobs: BlobStore, graceHours = 24, batch = 500): Promise<{ removed: number; repaired: number }> {
  const cutoff = new Date(Date.now() - graceHours * 3600_000);
  const cand = await rows<{ id: number; storage_path: string }>(db, 'SELECT id, storage_path FROM messages WHERE refcount <= 0 AND created_at < ? LIMIT ?', [cutoff, batch]);
  let removed = 0;
  let repaired = 0;
  for (const m of cand) {
    const gone = await tx(db, async (c) => {
      const row = await one<{ refcount: number }>(c, 'SELECT refcount FROM messages WHERE id = ? FOR UPDATE', [m.id]);
      if (!row || row.refcount > 0) return false;
      const refs = await one<{ n: number }>(
        c,
        `SELECT (SELECT COUNT(*) FROM mail_items WHERE message_id = ?) + (SELECT COUNT(*) FROM archive_items WHERE message_id = ?)
              + (SELECT COUNT(*) FROM outbound_queue WHERE message_id = ? AND status NOT IN ('sent','failed','partial')) AS n`,
        [m.id, m.id, m.id],
      );
      const real = Number(refs?.n ?? 0);
      if (real > 0) {
        await exec(c, 'UPDATE messages SET refcount = ? WHERE id = ?', [real, m.id]);
        repaired++;
        return false;
      }
      // Finished queue entries keep only a historical pointer; detach them first.
      const q = await one(c, 'SELECT id FROM outbound_queue WHERE message_id = ? LIMIT 1', [m.id]);
      if (q) return false;
      await exec(c, 'DELETE FROM messages WHERE id = ?', [m.id]);
      return true;
    });
    if (gone) {
      await blobs.remove(m.storage_path);
      removed++;
    }
  }
  return { removed, repaired };
}

/** Old finished queue entries and dedup ledger rows are housekeeping only. */
export async function pruneHousekeeping(db: Db, opts: { queueDays: number; dedupDays: number; loginDays: number }): Promise<void> {
  const d = (n: number) => new Date(Date.now() - n * 86400_000);
  await exec(db, "DELETE FROM outbound_queue WHERE status IN ('sent','failed','partial') AND completed_at < ?", [d(opts.queueDays)]);
  await exec(db, 'DELETE FROM dedup_ledger WHERE last_seen_at < ?', [d(opts.dedupDays)]);
  await exec(db, 'DELETE FROM login_attempts WHERE at < ?', [d(opts.loginDays)]);
  await exec(db, 'DELETE FROM sessions WHERE expires_at < ? OR revoked_at < ?', [d(1), d(7)]);
  await exec(db, 'DELETE FROM fetch_runs WHERE started_at < ?', [d(30)]);
}
