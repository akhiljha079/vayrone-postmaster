import type { Db } from './db.js';
import { exec, one, rows, tx } from './db.js';
import { hashPassword, verifyPassword } from './password.js';
import type { MailStore } from './store/mailstore.js';
import type { Settings } from './settings.js';
import { SECURITY_DEFAULTS } from './settings.js';
import type { IpPolicy } from './ippolicy.js';
import type { LicenseGate } from './license-gate.js';
import { UNLIMITED_LICENSE, assertSeatAvailable } from './license-gate.js';

export type Protocol = 'web' | 'imap' | 'pop3' | 'smtp';
export type Role = 'super_admin' | 'admin' | 'user' | 'auditor' | 'vayrone_support';

export interface AuthUser {
  id: number;
  login: string;
  displayName: string;
  role: Role;
}

export type Resolution =
  | { kind: 'local'; userIds: number[]; external: string[]; listId?: number }
  | { kind: 'external' }
  | { kind: 'unknown-local'; action: 'reject' | 'relay' | 'catchall'; catchallUserId: number | null };

export interface DirectoryOptions {
  settings?: Settings;
  ipPolicy?: IpPolicy;
  license?: LicenseGate;
}

export type AuthFailure = 'unknown_user' | 'locked' | 'bad_password' | 'protocol_disabled' | 'ip_denied' | 'support_disabled';

export function splitAddress(addr: string): { local: string; domain: string } | null {
  const a = addr.trim().toLowerCase();
  const at = a.lastIndexOf('@');
  if (at <= 0 || at === a.length - 1) return null;
  return { local: a.slice(0, at), domain: a.slice(at + 1) };
}

export class Directory {
  constructor(
    private readonly db: Db,
    private readonly store: MailStore,
    private readonly opts: DirectoryOptions = {},
  ) {}

  get license(): LicenseGate {
    return this.opts.license ?? UNLIMITED_LICENSE;
  }

  async createDomain(name: string): Promise<number> {
    const now = new Date();
    const r = await exec(this.db, 'INSERT INTO domains (name, created_at, updated_at) VALUES (?,?,?)', [name.trim().toLowerCase(), now, now]);
    return r.insertId;
  }

  async getDomainId(name: string): Promise<number | null> {
    const d = await one<{ id: number }>(this.db, 'SELECT id FROM domains WHERE name = ?', [name.toLowerCase()]);
    return d?.id ?? null;
  }

  /** Creates a mailbox user: user row, primary address, default folders. */
  async createUser(input: { email: string; password: string; displayName?: string; role?: Role; quotaBytes?: number | null; enabled?: boolean }): Promise<number> {
    const parts = splitAddress(input.email);
    if (!parts) throw new Error('Invalid email address');
    const domainId = await this.getDomainId(parts.domain);
    if (!domainId) throw new Error(`Domain ${parts.domain} is not configured`);
    const hash = await hashPassword(input.password);
    const login = `${parts.local}@${parts.domain}`;
    const enabled = input.enabled !== false;
    const userId = await tx(this.db, async (c) => {
      if (enabled && input.role !== 'vayrone_support') await assertSeatAvailable(c, this.license);
      const now = new Date();
      const r = await exec(
        c,
        `INSERT INTO users (login, display_name, role, domain_id, has_mailbox, is_enabled, password_hash, password_changed_at,
           quota_bytes, next_uidvalidity, created_at, updated_at)
         VALUES (?,?,?,?,1,?,?,?,?,UNIX_TIMESTAMP(),?,?)`,
        [login, input.displayName ?? parts.local, input.role ?? 'user', domainId, enabled ? 1 : 0, hash, now, input.quotaBytes ?? null, now, now],
      );
      await exec(
        c,
        "INSERT INTO addresses (domain_id, local_part, kind, user_id, is_primary, created_at) VALUES (?,?,'mailbox',?,1,?)",
        [domainId, parts.local, r.insertId, now],
      );
      return r.insertId;
    });
    await this.store.createDefaultFolders(userId);
    return userId;
  }

  /** Staff account without a mailbox (e.g. a dedicated admin, auditor or Vayrone Support login). */
  async createStaffUser(input: { login: string; password: string; displayName: string; role: Role }): Promise<number> {
    const now = new Date();
    const r = await exec(
      this.db,
      `INSERT INTO users (login, display_name, role, domain_id, has_mailbox, password_hash, password_changed_at,
         allow_imap, allow_pop3, allow_smtp, allow_webmail, next_uidvalidity, created_at, updated_at)
       VALUES (?,?,?,NULL,0,?,?,0,0,0,0,UNIX_TIMESTAMP(),?,?)`,
      [input.login.trim().toLowerCase(), input.displayName, input.role, await hashPassword(input.password), now, now, now],
    );
    return r.insertId;
  }

  async setPassword(userId: number, password: string): Promise<void> {
    await exec(this.db, 'UPDATE users SET password_hash = ?, password_changed_at = ?, updated_at = ? WHERE id = ?', [
      await hashPassword(password),
      new Date(),
      new Date(),
      userId,
    ]);
  }

  async findUserIdByLogin(login: string): Promise<number | null> {
    const u = await one<{ id: number }>(this.db, 'SELECT id FROM users WHERE login = ?', [login.trim().toLowerCase()]);
    return u?.id ?? null;
  }

  /** Verifies LAN credentials for a protocol (see authenticateDetailed). */
  async authenticate(loginRaw: string, password: string, protocol: Protocol, ip: string): Promise<AuthUser | null> {
    return (await this.authenticateDetailed(loginRaw, password, protocol, ip)).user;
  }

  /**
   * Verifies LAN credentials for a protocol: IP allowlist, lockout,
   * per-protocol permission, support-role gate. Every attempt is recorded in
   * login_attempts.
   */
  async authenticateDetailed(
    loginRaw: string,
    password: string,
    protocol: Protocol,
    ip: string,
  ): Promise<{ user: AuthUser | null; failure: AuthFailure | null; hasTotp: boolean }> {
    const login = loginRaw.trim().toLowerCase();
    const u = await one<{
      id: number;
      login: string;
      display_name: string;
      role: Role;
      password_hash: string;
      is_enabled: number;
      has_mailbox: number;
      allow_imap: number;
      allow_pop3: number;
      allow_smtp: number;
      allow_webmail: number;
      locked_until: Date | null;
      totp_enabled: number;
    }>(this.db, 'SELECT * FROM users WHERE login = ?', [login]);

    const sec = this.opts.settings ? await this.opts.settings.security() : SECURITY_DEFAULTS;
    const fail = async (reason: AuthFailure) => {
      await record(false, reason);
      return { user: null, failure: reason, hasTotp: false };
    };
    const record = (success: boolean, reason: string | null) =>
      exec(this.db, 'INSERT INTO login_attempts (at, login, user_id, protocol, ip, success, reason) VALUES (?,?,?,?,?,?,?)', [
        new Date(),
        login.slice(0, 254),
        u?.id ?? null,
        protocol,
        ip.slice(0, 45),
        success ? 1 : 0,
        reason,
      ]).catch(() => {});

    if (this.opts.ipPolicy && !(await this.opts.ipPolicy.allowed(ip, protocol))) return fail('ip_denied');
    if (!u) return fail('unknown_user');
    if (u.locked_until && u.locked_until > new Date()) return fail('locked');
    const allowed =
      u.is_enabled &&
      (protocol === 'web' ? u.allow_webmail || u.role !== 'user' : u.has_mailbox && (protocol === 'imap' ? u.allow_imap : protocol === 'pop3' ? u.allow_pop3 : u.allow_smtp));
    const ok = await verifyPassword(password, u.password_hash);
    if (!ok) {
      await exec(
        this.db,
        `UPDATE users SET failed_logins = failed_logins + 1,
           locked_until = IF(failed_logins + 1 >= ?, ? , locked_until) WHERE id = ?`,
        [sec.lockoutThreshold, new Date(Date.now() + sec.lockoutMinutes * 60_000), u.id],
      );
      return fail('bad_password');
    }
    if (!allowed) return fail('protocol_disabled');
    if (u.role === 'vayrone_support' && !(sec.supportAccessEnabled && this.license.feature('support_access'))) return fail('support_disabled');
    await exec(this.db, 'UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ?, last_login_ip = ? WHERE id = ?', [
      new Date(),
      ip.slice(0, 45),
      u.id,
    ]);
    await record(true, null);
    return { user: { id: u.id, login: u.login, displayName: u.display_name, role: u.role }, failure: null, hasTotp: Boolean(u.totp_enabled) };
  }

  /** Applies a distribution list's sender policy. */
  async listAllowsSender(listId: number, sender: string): Promise<boolean> {
    const l = await one<{ sender_policy: 'anyone' | 'domain' | 'members' | 'listed'; allowed_senders: unknown }>(
      this.db,
      'SELECT sender_policy, allowed_senders FROM distribution_lists WHERE id = ?',
      [listId],
    );
    if (!l) return false;
    const from = sender.trim().toLowerCase();
    if (l.sender_policy === 'anyone') return true;
    if (l.sender_policy === 'listed') {
      const allowed = (typeof l.allowed_senders === 'string' ? JSON.parse(l.allowed_senders) : l.allowed_senders) as string[] | null;
      return (allowed ?? []).map((x) => x.toLowerCase()).includes(from);
    }
    if (l.sender_policy === 'domain') {
      const d = splitAddress(from)?.domain;
      return Boolean(d && (await one(this.db, 'SELECT id FROM domains WHERE name = ? AND is_enabled = 1', [d])));
    }
    // members: sender is a member mailbox address or a listed external member
    const m = await one(
      this.db,
      `SELECT 1 FROM list_members lm
         LEFT JOIN addresses a ON a.user_id = lm.user_id AND a.kind = 'mailbox'
         LEFT JOIN domains d ON d.id = a.domain_id
        WHERE lm.list_id = ? AND (LOWER(lm.external_address) = ? OR CONCAT(a.local_part, '@', d.name) = ?) LIMIT 1`,
      [listId, from, from],
    );
    return Boolean(m);
  }

  /** Addresses a user may use as envelope sender / From. */
  async userAddresses(userId: number): Promise<string[]> {
    const r = await rows<{ a: string }>(
      this.db,
      `SELECT CONCAT(a.local_part, '@', d.name) AS a FROM addresses a JOIN domains d ON d.id = a.domain_id
        WHERE a.user_id = ? AND a.is_enabled = 1
       UNION
       SELECT CONCAT(a.local_part, '@', d.name) FROM alias_targets t
         JOIN addresses a ON a.id = t.address_id JOIN domains d ON d.id = a.domain_id
        WHERE t.target_user_id = ? AND a.is_enabled = 1`,
      [userId, userId],
    );
    return r.map((x) => x.a.toLowerCase());
  }

  async resolve(address: string, depth = 0): Promise<Resolution> {
    const parts = splitAddress(address);
    if (!parts) return { kind: 'external' };
    const d = await one<{ id: number; is_enabled: number; unknown_recipient_action: 'reject' | 'relay' | 'catchall'; catchall_user_id: number | null }>(
      this.db,
      'SELECT id, is_enabled, unknown_recipient_action, catchall_user_id FROM domains WHERE name = ?',
      [parts.domain],
    );
    if (!d || !d.is_enabled) return { kind: 'external' };
    const a = await one<{ id: number; kind: 'mailbox' | 'alias' | 'list'; user_id: number | null; list_id: number | null; is_enabled: number; ue: number | null }>(
      this.db,
      `SELECT a.id, a.kind, a.user_id, a.list_id, a.is_enabled, u.is_enabled AS ue
         FROM addresses a LEFT JOIN users u ON u.id = a.user_id WHERE a.domain_id = ? AND a.local_part = ?`,
      [d.id, parts.local],
    );
    if (!a || !a.is_enabled || (a.kind === 'mailbox' && !a.ue)) {
      return { kind: 'unknown-local', action: d.unknown_recipient_action, catchallUserId: d.catchall_user_id };
    }
    if (a.kind === 'mailbox') return { kind: 'local', userIds: [a.user_id!], external: [] };

    const userIds = new Set<number>();
    const external = new Set<string>();
    if (a.kind === 'alias') {
      const t = await rows<{ target_user_id: number | null; target_external: string | null }>(this.db, 'SELECT target_user_id, target_external FROM alias_targets WHERE address_id = ?', [a.id]);
      for (const x of t) {
        if (x.target_user_id) userIds.add(x.target_user_id);
        if (x.target_external) {
          // An alias may point at another local address; resolve one level deeper.
          const sub = depth < 5 ? await this.resolve(x.target_external, depth + 1) : { kind: 'external' as const };
          if (sub.kind === 'local') {
            sub.userIds.forEach((u) => userIds.add(u));
            sub.external.forEach((e) => external.add(e));
          } else {
            external.add(x.target_external.toLowerCase());
          }
        }
      }
    } else {
      const l = await one<{ expand_external: number }>(this.db, 'SELECT expand_external FROM distribution_lists WHERE id = ?', [a.list_id]);
      const m = await rows<{ user_id: number | null; external_address: string | null }>(this.db, 'SELECT user_id, external_address FROM list_members WHERE list_id = ?', [a.list_id]);
      for (const x of m) {
        if (x.user_id) userIds.add(x.user_id);
        if (x.external_address && l?.expand_external) external.add(x.external_address.toLowerCase());
      }
      return { kind: 'local', userIds: [...userIds], external: [...external], listId: a.list_id! };
    }
    return { kind: 'local', userIds: [...userIds], external: [...external] };
  }
}
