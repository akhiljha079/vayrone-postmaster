// Licence enforcement interface. Phase 8 provides the real implementation
// (signed licence file, grace period, read-only mode). Until then the
// unlimited gate is used, but every enforcement point already calls it.
import type { Queryable } from './db.js';
import { one } from './db.js';

export type LicenseMode = 'active' | 'grace' | 'readonly' | 'unlicensed';

export interface LicenseGate {
  /** Maximum active mailbox users, or null for unlimited. */
  maxUsers(): number | null;
  maxExternalAccounts(): number | null;
  feature(name: 'archive' | 'backup_cloud' | 'antivirus' | 'support_access' | string): boolean;
  /** readonly → admin panel read-only and new web logins blocked; mail flow never stops. */
  mode(): LicenseMode;
}

export const UNLIMITED_LICENSE: LicenseGate = {
  maxUsers: () => null,
  maxExternalAccounts: () => null,
  feature: () => true,
  mode: () => 'active',
};

export class LicenseLimitError extends Error {
  constructor(message: string) {
    super(message);
  }
}

/** Users that consume a licence seat. */
export async function licensedUserCount(q: Queryable, excludeUserId?: number): Promise<number> {
  const r = await one<{ n: number }>(
    q,
    `SELECT COUNT(*) AS n FROM users WHERE is_enabled = 1 AND has_mailbox = 1 AND role <> 'vayrone_support'${excludeUserId ? ' AND id <> ?' : ''}`,
    excludeUserId ? [excludeUserId] : [],
  );
  return Number(r?.n ?? 0);
}

/** Throws when activating one more mailbox user would exceed the licence. */
export async function assertSeatAvailable(q: Queryable, gate: LicenseGate, excludeUserId?: number): Promise<void> {
  const max = gate.maxUsers();
  if (max === null) return;
  const used = await licensedUserCount(q, excludeUserId);
  if (used + 1 > max) throw new LicenseLimitError(`Licence allows ${max} active users; ${used} are in use. Disable a user or upgrade the licence.`);
}
