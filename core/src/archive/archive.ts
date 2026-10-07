// Compliance archive: one archive item per message that entered or left the
// organisation (not per recipient), kept until its retention date unless on
// legal hold. Archive items hold a reference on the stored message, so the
// mail survives even when users delete it from their mailboxes.
import type { Db } from '../db.js';
import { exec, one, rows } from '../db.js';
import type { Settings } from '../settings.js';
import type { LicenseGate } from '../license-gate.js';

export interface ArchivePolicy {
  enabled: boolean;
  /** Default retention in days; null = keep forever. */
  retentionDays: number | null;
  /** Also archive mail between colleagues. */
  includeInternal: boolean;
}

export const ARCHIVE_DEFAULTS: ArchivePolicy = { enabled: true, retentionDays: 2555 /* 7 years */, includeInternal: true };

export interface ArchiveInput {
  messageId: number;
  size: number;
  subject: string | null;
  date: Date | null;
  direction: 'in' | 'out' | 'internal';
  envelopeFrom: string;
  envelopeTo: string[];
  /** Local users the message was delivered to (their "Received" archive folder). */
  recipientUserIds: number[];
  /** Local users who sent it (their "Sent" archive folder). */
  senderUserIds: number[];
}

export class Archiver {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly license: LicenseGate,
  ) {}

  async policy(): Promise<ArchivePolicy> {
    return { ...ARCHIVE_DEFAULTS, ...(await this.settings.get<Partial<ArchivePolicy>>('archive', 'policy', {})) };
  }

  async active(): Promise<boolean> {
    return this.license.feature('archive') && (await this.policy()).enabled;
  }

  /** Longest retention among matching archive policies (all/domain/group/user), else the default. */
  private async retentionDays(userIds: number[], fallback: number | null): Promise<number | null> {
    const pol = await rows<{ scope: string; scope_id: number | null; keep_days: number }>(
      this.db,
      "SELECT scope, scope_id, keep_days FROM retention_policies WHERE target = 'archive' AND is_enabled = 1",
    );
    if (!pol.length) return fallback;
    let best: number | null = null;
    for (const p of pol) {
      let hit = p.scope === 'all';
      if (!hit && userIds.length) {
        if (p.scope === 'user') hit = userIds.includes(p.scope_id!);
        else if (p.scope === 'domain') hit = Boolean(await one(this.db, 'SELECT id FROM users WHERE id IN (?) AND domain_id = ? LIMIT 1', [userIds, p.scope_id]));
        else if (p.scope === 'group') hit = Boolean(await one(this.db, 'SELECT user_id FROM user_group_members WHERE group_id = ? AND user_id IN (?) LIMIT 1', [p.scope_id, userIds]));
      }
      if (hit) best = Math.max(best ?? 0, p.keep_days);
    }
    return best ?? fallback;
  }

  async archive(a: ArchiveInput): Promise<number | null> {
    if (!(await this.active())) return null;
    const policy = await this.policy();
    if (a.direction === 'internal' && !policy.includeInternal) return null;
    const userIds = [...new Set([...a.recipientUserIds, ...a.senderUserIds])];
    const days = await this.retentionDays(userIds, policy.retentionDays);
    const now = new Date();
    const r = await exec(
      this.db,
      `INSERT INTO archive_items (message_id, direction, envelope_from, envelope_rcpts, subject, hdr_date, size, archived_at, retention_until)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        a.messageId,
        a.direction,
        a.envelopeFrom.slice(0, 254),
        JSON.stringify(a.envelopeTo.slice(0, 1000)),
        a.subject?.slice(0, 998) ?? null,
        a.date,
        a.size,
        now,
        days === null ? null : new Date(now.getTime() + days * 86400_000),
      ],
    );
    await exec(this.db, 'UPDATE messages SET refcount = refcount + 1 WHERE id = ?', [a.messageId]);
    if (userIds.length) {
      // The address at archive time names the mailbox folder, even after the account is renamed or deleted.
      const logins = new Map((await rows<{ id: number; login: string }>(this.db, 'SELECT id, login FROM users WHERE id IN (?)', [userIds])).map((u) => [u.id, u.login]));
      const links = [
        ...[...new Set(a.recipientUserIds)].map((u) => [r.insertId, u, 'received', logins.get(u) ?? null]),
        ...[...new Set(a.senderUserIds)].map((u) => [r.insertId, u, 'sent', logins.get(u) ?? null]),
      ];
      await exec(this.db, 'INSERT IGNORE INTO archive_item_users (archive_id, user_id, role, address) VALUES ?', [links]);
    }
    return r.insertId;
  }
}
