// Web sessions: opaque random cookie token, only its SHA-256 is stored.
import { createHash, randomBytes } from 'node:crypto';
import { db as dbm, type Role, type Settings } from '@vpm/core';
import type { Db } from '@vpm/core';

const { exec, one, rows } = dbm;

export interface SessionUser {
  id: number;
  login: string;
  display_name: string;
  role: Role;
  has_mailbox: number;
  is_enabled: number;
  totp_enabled: number;
}

export interface Session {
  id: string; // token hash
  user_id: number;
  ui_mode: 'mail' | 'admin';
  mfa_passed: number;
  ip: string;
  user_agent: string | null;
  created_at: Date;
  last_seen_at: Date;
  expires_at: Date;
}

export const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');

export class Sessions {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
  ) {}

  async create(userId: number, ip: string, ua: string | undefined, mfaPassed: boolean, mode: 'mail' | 'admin'): Promise<{ token: string; id: string }> {
    const sec = await this.settings.security();
    const token = randomBytes(32).toString('base64url');
    const id = hashToken(token);
    const now = new Date();
    await exec(
      this.db,
      `INSERT INTO sessions (id, user_id, kind, ui_mode, mfa_passed, ip, user_agent, created_at, last_seen_at, expires_at)
       VALUES (?,?,'web',?,?,?,?,?,?,?)`,
      [id, userId, mode, mfaPassed ? 1 : 0, ip.slice(0, 45), ua?.slice(0, 500) ?? null, now, now, new Date(now.getTime() + sec.sessionMaxHours * 3600_000)],
    );
    return { token, id };
  }

  /** Returns the live session and its (enabled) user, refreshing last_seen_at at most once a minute. */
  async validate(token: string): Promise<{ session: Session; user: SessionUser } | null> {
    if (!token || token.length > 100) return null;
    const s = await one<Session>(this.db, "SELECT * FROM sessions WHERE id = ? AND kind = 'web' AND revoked_at IS NULL", [hashToken(token)]);
    if (!s) return null;
    const now = Date.now();
    const sec = await this.settings.security();
    if (new Date(s.expires_at).getTime() <= now || now - new Date(s.last_seen_at).getTime() > sec.sessionIdleMinutes * 60_000) return null;
    const user = await one<SessionUser>(
      this.db,
      'SELECT id, login, display_name, role, has_mailbox, is_enabled, totp_enabled FROM users WHERE id = ?',
      [s.user_id],
    );
    if (!user || !user.is_enabled) return null;
    if (now - new Date(s.last_seen_at).getTime() > 60_000) {
      await exec(this.db, 'UPDATE sessions SET last_seen_at = ? WHERE id = ?', [new Date(now), s.id]);
    }
    return { session: s, user };
  }

  async setMfaPassed(id: string): Promise<void> {
    await exec(this.db, 'UPDATE sessions SET mfa_passed = 1 WHERE id = ?', [id]);
  }

  async setMode(id: string, mode: 'mail' | 'admin'): Promise<void> {
    await exec(this.db, 'UPDATE sessions SET ui_mode = ? WHERE id = ?', [mode, id]);
  }

  async revoke(id: string, by: number | null): Promise<boolean> {
    const r = await exec(this.db, 'UPDATE sessions SET revoked_at = ?, revoked_by = ? WHERE id = ? AND revoked_at IS NULL', [new Date(), by, id]);
    return r.affectedRows > 0;
  }

  async revokeAllForUser(userId: number, by: number | null, exceptId?: string): Promise<number> {
    const r = await exec(
      this.db,
      `UPDATE sessions SET revoked_at = ?, revoked_by = ? WHERE user_id = ? AND revoked_at IS NULL${exceptId ? ' AND id <> ?' : ''}`,
      exceptId ? [new Date(), by, userId, exceptId] : [new Date(), by, userId],
    );
    return r.affectedRows;
  }

  /** Active sessions; `id` is shortened to a public handle (first 16 hex chars of the hash). */
  async listActive(userId?: number): Promise<Record<string, unknown>[]> {
    const r = await rows<Session & { login: string; display_name: string }>(
      this.db,
      `SELECT s.*, u.login, u.display_name FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.revoked_at IS NULL AND s.expires_at > ? ${userId ? 'AND s.user_id = ?' : ''} ORDER BY s.last_seen_at DESC LIMIT 500`,
      userId ? [new Date(), userId] : [new Date()],
    );
    return r.map((s) => ({
      handle: s.id.slice(0, 16),
      userId: s.user_id,
      login: s.login,
      displayName: s.display_name,
      kind: 'web',
      mode: s.ui_mode,
      ip: s.ip,
      userAgent: s.user_agent,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
    }));
  }

  async findByHandle(handle: string): Promise<{ id: string; user_id: number } | undefined> {
    if (!/^[0-9a-f]{16}$/.test(handle)) return undefined;
    return one<{ id: string; user_id: number }>(this.db, 'SELECT id, user_id FROM sessions WHERE id LIKE ? AND revoked_at IS NULL LIMIT 1', [`${handle}%`]);
  }
}
