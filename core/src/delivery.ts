// Local delivery pipeline (Phase 2 subset of docs/ARCHITECTURE.md §5.4):
// store once → per recipient: dedup check → append to folder → notify.
// Rules, forwarding, journaling and archiving hook in here in Phase 5/7.
import type { Db, PoolConnection } from './db.js';
import { exec, one, tx } from './db.js';
import type { ItemOrigin, MailStore, StoredMessage } from './store/mailstore.js';
import { StoreError } from './store/mailstore.js';
import { messageIdHash } from './mime/mime.js';

export interface DeliveryTarget {
  userId: number;
  /** Defaults to the user's INBOX. */
  folderId?: number;
  /** Initial flags (e.g. \Seen, \Flagged set by a rule). */
  flags?: number;
  /** A per-recipient variant of the message (e.g. with rule-added headers). */
  message?: StoredMessage;
}

export type DeliveryStatus = 'delivered' | 'duplicate' | 'overquota' | 'failed' | 'discarded' | 'rejected';

export interface DeliveryOutcome {
  userId: number;
  status: DeliveryStatus;
  uid?: number;
  folderId?: number;
  error?: string;
}

export interface DeliverOptions {
  message: StoredMessage;
  targets: DeliveryTarget[];
  origin: ItemOrigin;
  envelopeFrom: string;
  dedup?: boolean;
  /** Fetched mail is delivered even when over quota (it must never be dropped); an alert is raised instead. */
  ignoreQuota?: boolean;
  externalAccountId?: number | null;
  clientIp?: string | null;
}

export class Delivery {
  constructor(
    private readonly db: Db,
    private readonly store: MailStore,
    private readonly dedupWindowHours: number,
  ) {}

  async deliver(o: DeliverOptions): Promise<DeliveryOutcome[]> {
    const out: DeliveryOutcome[] = [];
    const seen = new Set<number>();
    for (const t of o.targets) {
      if (seen.has(t.userId)) continue; // fan-out to the same mailbox twice (alias + direct)
      seen.add(t.userId);
      out.push(await this.deliverOne(o, t));
    }
    return out;
  }

  private async deliverOne(o: DeliverOptions, t: DeliveryTarget): Promise<DeliveryOutcome> {
    const folderId = t.folderId ?? (await this.store.getSpecialFolder(t.userId, 'inbox'))?.id;
    if (!folderId) return { userId: t.userId, status: 'failed', error: 'INBOX missing' };
    const message = t.message ?? o.message;
    try {
      if (!o.ignoreQuota) await this.store.assertQuota(t.userId, message.size);
      const res = await tx(this.db, async (c) => {
        // Dedup keys come from the original message; rule-added X- headers do not change them.
        if (o.dedup !== false && (await this.isDuplicate(c, t.userId, o.message))) return null;
        return this.store.appendInTx(c, {
          userId: t.userId,
          folderId,
          message,
          flags: t.flags ?? 0,
          origin: o.origin,
          externalAccountId: o.externalAccountId ?? null,
        });
      });
      if (!res) {
        await this.log(o, t.userId, 'duplicate', 'suppressed by dedup ledger');
        return { userId: t.userId, status: 'duplicate', folderId };
      }
      this.store.events.folderChanged(folderId);
      await this.log(o, t.userId, 'delivered', null, res.itemId);
      return { userId: t.userId, status: 'delivered', uid: res.uid, folderId };
    } catch (err) {
      if (err instanceof StoreError && err.code === 'OVERQUOTA') {
        await this.log(o, t.userId, 'rejected', 'over quota');
        return { userId: t.userId, status: 'overquota', folderId };
      }
      await this.log(o, t.userId, 'failed', (err as Error).message.slice(0, 900));
      return { userId: t.userId, status: 'failed', folderId, error: (err as Error).message };
    }
  }

  /**
   * Records the message in the user's dedup ledger without storing it (mail
   * that a rule discards or redirects). Returns true when it was a duplicate,
   * so the caller skips side effects such as forwarding a second time.
   */
  async recordOnly(userId: number, message: StoredMessage): Promise<boolean> {
    return tx(this.db, (c) => this.isDuplicate(c, userId, message));
  }

  /**
   * Per-mailbox duplicate check. The content key (normalised content, which
   * includes the Message-ID header) decides; the Message-ID key is recorded
   * for diagnostics. INSERT IGNORE makes concurrent deliveries race-free.
   */
  private async isDuplicate(c: PoolConnection, userId: number, m: StoredMessage): Promise<boolean> {
    const now = new Date();
    const cutoff = new Date(now.getTime() - this.dedupWindowHours * 3600_000);
    const keys: ['message_id' | 'content', Buffer][] = [['content', m.parsed.contentHash]];
    const mid = messageIdHash(m.parsed.messageId);
    if (mid) keys.push(['message_id', mid]);
    let dup = false;
    for (const [kind, hash] of keys) {
      const ins = await exec(
        c,
        'INSERT IGNORE INTO dedup_ledger (user_id, key_kind, key_hash, first_seen_at, last_seen_at) VALUES (?,?,?,?,?)',
        [userId, kind, hash, now, now],
      );
      if (ins.affectedRows === 1) continue;
      const row = await one<{ last_seen_at: Date }>(c, 'SELECT last_seen_at FROM dedup_ledger WHERE user_id = ? AND key_kind = ? AND key_hash = ? FOR UPDATE', [userId, kind, hash]);
      await exec(c, 'UPDATE dedup_ledger SET last_seen_at = ?, hit_count = hit_count + 1 WHERE user_id = ? AND key_kind = ? AND key_hash = ?', [now, userId, kind, hash]);
      if (kind === 'content' && row && row.last_seen_at >= cutoff) dup = true;
    }
    return dup;
  }

  private async log(o: DeliverOptions, userId: number, event: string, detail: string | null, itemId?: number): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO mail_log (at, event, direction, hdr_message_id, envelope_from, user_id, subject, size, client_ip, ref_type, ref_id, detail)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        new Date(),
        event,
        o.origin === 'fetch' ? 'in' : 'internal',
        o.message.parsed.messageId?.slice(0, 255) ?? null,
        o.envelopeFrom.slice(0, 254),
        userId,
        o.message.parsed.subject?.slice(0, 255) ?? null,
        o.message.size,
        o.clientIp ?? null,
        itemId ? 'item' : null,
        itemId ?? null,
        detail,
      ],
    ).catch(() => {});
  }

  /** Queues a message for the relay worker (sender implemented in Phase 3). */
  async enqueueOutbound(o: { message: StoredMessage; envelopeFrom: string; recipients: string[]; senderUserId: number | null; source: 'submission' | 'webmail' | 'forward' | 'redirect' | 'autoreply' | 'journal' | 'rule' | 'system' }): Promise<number> {
    const now = new Date();
    const expires = new Date(now.getTime() + 3 * 86400_000);
    return tx(this.db, async (c) => {
      const r = await exec(
        c,
        `INSERT INTO outbound_queue (message_id, envelope_from, sender_user_id, source, status, next_attempt_at, expires_at, created_at, updated_at)
         VALUES (?,?,?,?,'queued',?,?,?,?)`,
        [o.message.id, o.envelopeFrom, o.senderUserId, o.source, now, expires, now, now],
      );
      await exec(c, 'INSERT INTO outbound_recipients (queue_id, rcpt, updated_at) VALUES ?', [o.recipients.map((rc) => [r.insertId, rc, now])]);
      await exec(c, 'UPDATE messages SET refcount = refcount + 1 WHERE id = ?', [o.message.id]);
      return r.insertId;
    });
  }
}
