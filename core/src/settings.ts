import type { Db } from './db.js';
import { exec, json, rows } from './db.js';

export interface SecuritySettings {
  /** Consecutive failed logins before the account is locked. */
  lockoutThreshold: number;
  lockoutMinutes: number;
  /** Web session expires after this much inactivity. */
  sessionIdleMinutes: number;
  /** Web session hard lifetime. */
  sessionMaxHours: number;
  /** Site admin's switch for the hidden Vayrone Support role (also needs the licence feature). */
  supportAccessEnabled: boolean;
  /** Require TOTP for super_admin/admin accounts. */
  requireTotpForAdmins: boolean;
}

export const SECURITY_DEFAULTS: SecuritySettings = {
  lockoutThreshold: 10,
  lockoutMinutes: 15,
  sessionIdleMinutes: 120,
  sessionMaxHours: 24,
  supportAccessEnabled: false,
  requireTotpForAdmins: false,
};

const TTL_MS = 30_000;

/** Typed access to the `settings` table with a short in-process cache. */
export class Settings {
  private cache = new Map<string, { at: number; value: unknown }>();

  constructor(private readonly db: Db) {}

  async get<T>(namespace: string, name: string, fallback: T): Promise<T> {
    const key = `${namespace}.${name}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value as T;
    const r = await rows<{ value: unknown }>(this.db, 'SELECT value FROM settings WHERE namespace = ? AND name = ?', [namespace, name]);
    const value = r.length ? json<T>(r[0]!.value) : fallback;
    this.cache.set(key, { at: Date.now(), value });
    return value;
  }

  async set(namespace: string, name: string, value: unknown, userId: number | null = null): Promise<void> {
    await exec(
      this.db,
      `INSERT INTO settings (namespace, name, value, updated_at, updated_by) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at), updated_by = VALUES(updated_by)`,
      [namespace, name, JSON.stringify(value), new Date(), userId],
    );
    this.cache.delete(`${namespace}.${name}`);
  }

  async security(): Promise<SecuritySettings> {
    return { ...SECURITY_DEFAULTS, ...(await this.get<Partial<SecuritySettings>>('security', 'policy', {})) };
  }

  invalidate(): void {
    this.cache.clear();
  }
}
