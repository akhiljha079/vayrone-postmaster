// Domains, users, aliases, groups and distribution lists.
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { assertSeatAvailable, db as dbm, hashPassword, licensedUserCount, splitAddress, type CoreContext, type Role } from '@vpm/core';
import type { Sessions } from '../../sessions.js';
import { audit, requireAdmin } from '../../guards.js';
import { badRequest, conflict, forbidden, notFound, page, parsePatch } from '../../http.js';
import { PasswordSchema } from '../auth.js';

const { exec, one, rows, tx } = dbm;

const Email = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address');
const DomainName = z.string().trim().toLowerCase().max(253).regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Invalid domain name');
const Id = z.coerce.number().int().positive();
const Roles = ['super_admin', 'admin', 'user', 'auditor', 'vayrone_support'] as const;
const Target = z.union([z.object({ userId: Id }), z.object({ external: Email })]);

/** Roles the acting user may assign or modify. */
function assignable(actor: Role): Role[] {
  if (actor === 'super_admin') return [...Roles];
  if (actor === 'vayrone_support') return ['admin', 'user', 'auditor'];
  return ['user', 'auditor', 'admin'];
}

async function domainIdFor(ctx: CoreContext, address: string): Promise<{ domainId: number; local: string }> {
  const p = splitAddress(address);
  if (!p) throw badRequest('Invalid address');
  const d = await one<{ id: number }>(ctx.db, 'SELECT id FROM domains WHERE name = ?', [p.domain]);
  if (!d) throw badRequest(`Domain ${p.domain} is not configured on this server`, 'UNKNOWN_DOMAIN');
  return { domainId: d.id, local: p.local };
}

async function addressTaken(ctx: CoreContext, domainId: number, local: string): Promise<boolean> {
  return Boolean(await one(ctx.db, 'SELECT id FROM addresses WHERE domain_id = ? AND local_part = ?', [domainId, local]));
}

async function writeTargets(ctx: CoreContext, addressId: number, targets: z.infer<typeof Target>[]): Promise<void> {
  await exec(ctx.db, 'DELETE FROM alias_targets WHERE address_id = ?', [addressId]);
  if (targets.length) {
    await exec(ctx.db, 'INSERT INTO alias_targets (address_id, target_user_id, target_external) VALUES ?', [
      targets.map((t) => ('userId' in t ? [addressId, t.userId, null] : [addressId, null, t.external])),
    ]);
  }
}

async function writeMembers(ctx: CoreContext, listId: number, members: z.infer<typeof Target>[]): Promise<void> {
  await exec(ctx.db, 'DELETE FROM list_members WHERE list_id = ?', [listId]);
  if (members.length) {
    await exec(ctx.db, 'INSERT INTO list_members (list_id, user_id, external_address) VALUES ?', [
      members.map((t) => ('userId' in t ? [listId, t.userId, null] : [listId, null, t.external])),
    ]);
  }
}

export function directoryRoutes(ctx: CoreContext, sessions: Sessions) {
  const read = requireAdmin(ctx, 'read');
  const write = requireAdmin(ctx, 'write');

  return async (app: FastifyInstance) => {
    // ---------------------------------------------------------------- domains
    const DomainBody = z.object({
      name: DomainName,
      isEnabled: z.boolean().default(true),
      unknownRecipientAction: z.enum(['reject', 'catchall', 'relay']).default('relay'),
      catchallUserId: Id.nullable().optional(),
      smartHostRelayId: Id.nullable().optional(),
      defaultQuotaBytes: z.number().int().min(0).default(5 * 1024 ** 3),
    });

    app.get('/domains', { preHandler: read }, async () =>
      rows(
        ctx.db,
        `SELECT d.id, d.name, d.is_enabled AS isEnabled, d.unknown_recipient_action AS unknownRecipientAction,
                d.catchall_user_id AS catchallUserId, d.smart_host_relay_id AS smartHostRelayId, d.default_quota_bytes AS defaultQuotaBytes,
                (SELECT COUNT(*) FROM users u WHERE u.domain_id = d.id) AS userCount,
                (SELECT COUNT(*) FROM addresses a WHERE a.domain_id = d.id AND a.kind <> 'mailbox') AS aliasCount, d.created_at AS createdAt
           FROM domains d ORDER BY d.name`,
      ),
    );

    app.post('/domains', { preHandler: write }, async (req) => {
      const b = DomainBody.parse(req.body);
      const now = new Date();
      const r = await exec(
        ctx.db,
        `INSERT INTO domains (name, is_enabled, unknown_recipient_action, catchall_user_id, smart_host_relay_id, default_quota_bytes, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [b.name, b.isEnabled ? 1 : 0, b.unknownRecipientAction, b.catchallUserId ?? null, b.smartHostRelayId ?? null, b.defaultQuotaBytes, now, now],
      );
      await audit(ctx, req, 'domain.create', 'domain', r.insertId, { name: b.name });
      return { id: r.insertId };
    });

    app.patch<{ Params: { id: string } }>('/domains/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(DomainBody.omit({ name: true }), req.body);
      const map: Record<string, string> = {
        isEnabled: 'is_enabled',
        unknownRecipientAction: 'unknown_recipient_action',
        catchallUserId: 'catchall_user_id',
        smartHostRelayId: 'smart_host_relay_id',
        defaultQuotaBytes: 'default_quota_bytes',
      };
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, v] of Object.entries(b)) {
        if (v === undefined) continue;
        sets.push(`${map[k]} = ?`);
        vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      if (b.unknownRecipientAction === 'catchall' && !b.catchallUserId) {
        const d = await one<{ catchall_user_id: number | null }>(ctx.db, 'SELECT catchall_user_id FROM domains WHERE id = ?', [id]);
        if (!d?.catchall_user_id) throw badRequest('Choose a catch-all mailbox first');
      }
      if (!sets.length) return { ok: true };
      const r = await exec(ctx.db, `UPDATE domains SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, new Date(), id]);
      if (!r.affectedRows) throw notFound('Domain not found');
      await audit(ctx, req, 'domain.update', 'domain', id, b);
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/domains/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const used = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM users WHERE domain_id = ?', [id]);
      if (Number(used?.n)) throw conflict('Remove or move the users of this domain first', 'DOMAIN_IN_USE');
      const d = await one<{ name: string }>(ctx.db, 'SELECT name FROM domains WHERE id = ?', [id]);
      if (!d) throw notFound('Domain not found');
      await exec(ctx.db, 'DELETE FROM domains WHERE id = ?', [id]);
      await audit(ctx, req, 'domain.delete', 'domain', id, { name: d.name });
      return { ok: true };
    });

    // ------------------------------------------------------------------ users
    const UserCreate = z.object({
      email: Email.optional(),
      login: z.string().trim().toLowerCase().min(3).max(254).optional(),
      displayName: z.string().trim().min(1).max(200),
      password: PasswordSchema,
      role: z.enum(Roles).default('user'),
      hasMailbox: z.boolean().default(true),
      quotaBytes: z.number().int().min(0).nullable().optional(),
      isEnabled: z.boolean().default(true),
      allowImap: z.boolean().default(true),
      allowPop3: z.boolean().default(true),
      allowSmtp: z.boolean().default(true),
      allowWebmail: z.boolean().default(true),
      mustChangePassword: z.boolean().default(false),
    });
    const UserPatch = UserCreate.omit({ email: true, login: true, hasMailbox: true, password: true }).extend({
      password: PasswordSchema.optional(),
      unlock: z.boolean().optional(),
      resetTotp: z.boolean().optional(),
    });

    const canSeeSupport = (req: FastifyRequest) => ['super_admin', 'vayrone_support'].includes(req.auth!.user.role);

    app.get<{ Querystring: Record<string, string> }>('/users', { preHandler: read }, async (req) => {
      const { limit, offset, page: p } = page(req.query);
      const where: string[] = [];
      const vals: unknown[] = [];
      if (req.query.q) {
        where.push('(u.login LIKE ? OR u.display_name LIKE ?)');
        vals.push(`%${req.query.q}%`, `%${req.query.q}%`);
      }
      if (req.query.domainId) {
        where.push('u.domain_id = ?');
        vals.push(Number(req.query.domainId));
      }
      if (req.query.role) {
        where.push('u.role = ?');
        vals.push(req.query.role);
      }
      if (!canSeeSupport(req)) where.push("u.role <> 'vayrone_support'");
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const items = await rows(
        ctx.db,
        `SELECT u.id, u.login, u.display_name AS displayName, u.role, u.domain_id AS domainId, d.name AS domain,
                u.has_mailbox AS hasMailbox, u.is_enabled AS isEnabled, u.allow_imap AS allowImap, u.allow_pop3 AS allowPop3,
                u.allow_smtp AS allowSmtp, u.allow_webmail AS allowWebmail, u.quota_bytes AS quotaBytes,
                COALESCE(u.quota_bytes, d.default_quota_bytes) AS effectiveQuotaBytes, u.used_bytes AS usedBytes,
                u.totp_enabled AS totpEnabled, u.failed_logins AS failedLogins, u.locked_until AS lockedUntil,
                u.last_login_at AS lastLoginAt, u.last_login_ip AS lastLoginIp, u.created_at AS createdAt
           FROM users u LEFT JOIN domains d ON d.id = u.domain_id ${w}
          ORDER BY u.login LIMIT ? OFFSET ?`,
        [...vals, limit, offset],
      );
      const total = await one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM users u ${w}`, vals);
      const max = ctx.license.maxUsers();
      return { items, total: Number(total?.n ?? 0), page: p, licensed: { used: await licensedUserCount(ctx.db), max } };
    });

    app.get<{ Params: { id: string } }>('/users/:id', { preHandler: read }, async (req) => {
      const id = Id.parse(req.params.id);
      const u = await one(
        ctx.db,
        `SELECT u.id, u.login, u.display_name AS displayName, u.role, u.domain_id AS domainId, u.has_mailbox AS hasMailbox,
                u.is_enabled AS isEnabled, u.allow_imap AS allowImap, u.allow_pop3 AS allowPop3, u.allow_smtp AS allowSmtp,
                u.allow_webmail AS allowWebmail, u.quota_bytes AS quotaBytes, u.used_bytes AS usedBytes, u.totp_enabled AS totpEnabled,
                u.must_change_password AS mustChangePassword, u.locked_until AS lockedUntil, u.last_login_at AS lastLoginAt
           FROM users u WHERE u.id = ?`,
        [id],
      );
      if (!u || (u.role === 'vayrone_support' && !canSeeSupport(req))) throw notFound('User not found');
      const addresses = await rows(
        ctx.db,
        `SELECT a.id, CONCAT(a.local_part, '@', d.name) AS address, a.kind, a.is_primary AS isPrimary FROM addresses a
           JOIN domains d ON d.id = a.domain_id WHERE a.user_id = ?
         UNION ALL
         SELECT a.id, CONCAT(a.local_part, '@', d.name), 'alias', 0 FROM alias_targets t JOIN addresses a ON a.id = t.address_id
           JOIN domains d ON d.id = a.domain_id WHERE t.target_user_id = ?`,
        [id, id],
      );
      const groups = await rows(ctx.db, 'SELECT g.id, g.name FROM user_group_members m JOIN user_groups g ON g.id = m.group_id WHERE m.user_id = ?', [id]);
      const folders = await rows(ctx.db, 'SELECT path, message_count AS messages, total_bytes AS bytes FROM folders WHERE user_id = ? ORDER BY path', [id]);
      return { ...u, addresses, groups, folders };
    });

    app.post('/users', { preHandler: write }, async (req) => {
      const b = UserCreate.parse(req.body);
      const actor = req.auth!.user.role;
      if (!assignable(actor).includes(b.role)) throw forbidden(`You cannot create ${b.role} accounts`);
      let id: number;
      if (b.hasMailbox) {
        if (!b.email) throw badRequest('Email address is required for a mailbox user');
        const { domainId, local } = await domainIdFor(ctx, b.email);
        if (await addressTaken(ctx, domainId, local)) throw conflict('This address is already in use', 'ADDRESS_TAKEN');
        id = await ctx.directory.createUser({
          email: b.email,
          password: b.password,
          displayName: b.displayName,
          role: b.role,
          quotaBytes: b.quotaBytes ?? null,
          enabled: b.isEnabled,
        });
      } else {
        const login = b.login ?? b.email;
        if (!login) throw badRequest('Login is required');
        if (b.role === 'user') throw badRequest('A normal user needs a mailbox');
        id = await ctx.directory.createStaffUser({ login, password: b.password, displayName: b.displayName, role: b.role });
      }
      await exec(
        ctx.db,
        `UPDATE users SET is_enabled = ?, allow_imap = ?, allow_pop3 = ?, allow_smtp = ?, allow_webmail = ?, must_change_password = ? WHERE id = ?`,
        [b.isEnabled ? 1 : 0, b.allowImap ? 1 : 0, b.allowPop3 ? 1 : 0, b.allowSmtp ? 1 : 0, b.allowWebmail ? 1 : 0, b.mustChangePassword ? 1 : 0, id],
      );
      await audit(ctx, req, 'user.create', 'user', id, { login: b.email ?? b.login, role: b.role, hasMailbox: b.hasMailbox });
      return { id };
    });

    app.patch<{ Params: { id: string } }>('/users/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(UserPatch, req.body);
      const actor = req.auth!;
      const target = await one<{ role: Role; is_enabled: number; has_mailbox: number }>(ctx.db, 'SELECT role, is_enabled, has_mailbox FROM users WHERE id = ?', [id]);
      if (!target) throw notFound('User not found');
      const allowed = assignable(actor.user.role);
      if (!allowed.includes(target.role)) throw forbidden(`You cannot modify ${target.role} accounts`);
      if (b.role && !allowed.includes(b.role)) throw forbidden(`You cannot assign the ${b.role} role`);
      if (id === actor.user.id && (b.isEnabled === false || (b.role && b.role !== target.role))) throw badRequest('You cannot disable yourself or change your own role');
      if (target.role === 'super_admin' && ((b.role && b.role !== 'super_admin') || b.isEnabled === false)) {
        const others = await one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM users WHERE role = 'super_admin' AND is_enabled = 1 AND id <> ?", [id]);
        if (!Number(others?.n)) throw badRequest('At least one enabled super admin must remain');
      }
      if (b.isEnabled === true && !target.is_enabled && target.has_mailbox && (b.role ?? target.role) !== 'vayrone_support') {
        await assertSeatAvailable(ctx.db, ctx.license, id);
      }
      const map: Record<string, string> = {
        displayName: 'display_name',
        role: 'role',
        quotaBytes: 'quota_bytes',
        isEnabled: 'is_enabled',
        allowImap: 'allow_imap',
        allowPop3: 'allow_pop3',
        allowSmtp: 'allow_smtp',
        allowWebmail: 'allow_webmail',
        mustChangePassword: 'must_change_password',
      };
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, col] of Object.entries(map)) {
        const v = (b as Record<string, unknown>)[k];
        if (v === undefined) continue;
        sets.push(`${col} = ?`);
        vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      if (b.password) {
        sets.push('password_hash = ?', 'password_changed_at = ?');
        vals.push(await hashPassword(b.password), new Date());
      }
      if (b.unlock) sets.push('failed_logins = 0', 'locked_until = NULL');
      if (b.resetTotp) sets.push('totp_enabled = 0', 'totp_secret = NULL');
      if (sets.length) await exec(ctx.db, `UPDATE users SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, new Date(), id]);
      if (b.resetTotp) await exec(ctx.db, 'DELETE FROM user_recovery_codes WHERE user_id = ?', [id]);
      if (b.password || b.isEnabled === false || b.resetTotp) await sessions.revokeAllForUser(id, actor.user.id);
      await audit(ctx, req, 'user.update', 'user', id, { ...b, password: b.password ? 'changed' : undefined });
      return { ok: true };
    });

    app.post<{ Params: { id: string } }>('/users/:id/logout', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const n = await sessions.revokeAllForUser(id, req.auth!.user.id);
      await audit(ctx, req, 'user.logout_all', 'user', id, { sessions: n });
      return { revoked: n };
    });

    app.delete<{ Params: { id: string } }>('/users/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      if (id === req.auth!.user.id) throw badRequest('You cannot delete your own account');
      const target = await one<{ role: Role; login: string }>(ctx.db, 'SELECT role, login FROM users WHERE id = ?', [id]);
      if (!target) throw notFound('User not found');
      if (!assignable(req.auth!.user.role).includes(target.role)) throw forbidden(`You cannot delete ${target.role} accounts`);
      if (target.role === 'super_admin') {
        const others = await one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM users WHERE role = 'super_admin' AND is_enabled = 1 AND id <> ?", [id]);
        if (!Number(others?.n)) throw badRequest('At least one enabled super admin must remain');
      }
      await tx(ctx.db, async (c) => {
        // Release message references held by this mailbox before the cascade removes the items.
        await exec(
          c,
          `UPDATE messages m JOIN (SELECT message_id, COUNT(*) AS n FROM mail_items WHERE user_id = ? GROUP BY message_id) x
             ON m.id = x.message_id SET m.refcount = m.refcount - x.n`,
          [id],
        );
        await exec(c, 'DELETE FROM users WHERE id = ?', [id]);
      });
      await audit(ctx, req, 'user.delete', 'user', id, { login: target.login });
      return { ok: true };
    });

    // ---------------------------------------------------------------- aliases
    const AliasBody = z.object({ address: Email, targets: z.array(Target).min(1).max(500), isEnabled: z.boolean().default(true) });

    app.get('/aliases', { preHandler: read }, async () => {
      const list = await rows<{ id: number; address: string; isEnabled: number }>(
        ctx.db,
        `SELECT a.id, CONCAT(a.local_part, '@', d.name) AS address, a.is_enabled AS isEnabled FROM addresses a
           JOIN domains d ON d.id = a.domain_id WHERE a.kind = 'alias' ORDER BY address`,
      );
      const targets = await rows<{ address_id: number; userId: number | null; login: string | null; external: string | null }>(
        ctx.db,
        `SELECT t.address_id, t.target_user_id AS userId, u.login, t.target_external AS external FROM alias_targets t
           LEFT JOIN users u ON u.id = t.target_user_id`,
      );
      return list.map((a) => ({ ...a, targets: targets.filter((t) => t.address_id === a.id).map(({ address_id, ...t }) => (void address_id, t)) }));
    });

    app.post('/aliases', { preHandler: write }, async (req) => {
      const b = AliasBody.parse(req.body);
      const { domainId, local } = await domainIdFor(ctx, b.address);
      if (await addressTaken(ctx, domainId, local)) throw conflict('This address is already in use', 'ADDRESS_TAKEN');
      const r = await exec(ctx.db, "INSERT INTO addresses (domain_id, local_part, kind, is_enabled, created_at) VALUES (?,?,'alias',?,?)", [
        domainId,
        local,
        b.isEnabled ? 1 : 0,
        new Date(),
      ]);
      await writeTargets(ctx, r.insertId, b.targets);
      await audit(ctx, req, 'alias.create', 'alias', r.insertId, b);
      return { id: r.insertId };
    });

    app.patch<{ Params: { id: string } }>('/aliases/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(AliasBody.omit({ address: true }), req.body);
      const a = await one(ctx.db, "SELECT id FROM addresses WHERE id = ? AND kind = 'alias'", [id]);
      if (!a) throw notFound('Alias not found');
      if (b.isEnabled !== undefined) await exec(ctx.db, 'UPDATE addresses SET is_enabled = ? WHERE id = ?', [b.isEnabled ? 1 : 0, id]);
      if (b.targets) await writeTargets(ctx, id, b.targets);
      await audit(ctx, req, 'alias.update', 'alias', id, b);
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/aliases/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const r = await exec(ctx.db, "DELETE FROM addresses WHERE id = ? AND kind = 'alias'", [id]);
      if (!r.affectedRows) throw notFound('Alias not found');
      await audit(ctx, req, 'alias.delete', 'alias', id);
      return { ok: true };
    });

    // ----------------------------------------------------------------- groups
    const GroupBody = z.object({ name: z.string().trim().min(1).max(100), description: z.string().max(500).nullable().optional(), memberIds: z.array(Id).max(5000).default([]) });

    app.get('/groups', { preHandler: read }, async () => {
      const g = await rows<{ id: number; name: string; description: string | null }>(ctx.db, 'SELECT id, name, description FROM user_groups ORDER BY name');
      const m = await rows<{ group_id: number; user_id: number; login: string }>(
        ctx.db,
        'SELECT m.group_id, m.user_id, u.login FROM user_group_members m JOIN users u ON u.id = m.user_id',
      );
      return g.map((x) => ({ ...x, members: m.filter((y) => y.group_id === x.id).map((y) => ({ userId: y.user_id, login: y.login })) }));
    });

    const setMembers = async (groupId: number, ids: number[]) => {
      await exec(ctx.db, 'DELETE FROM user_group_members WHERE group_id = ?', [groupId]);
      if (ids.length) await exec(ctx.db, 'INSERT IGNORE INTO user_group_members (group_id, user_id) VALUES ?', [ids.map((u) => [groupId, u])]);
    };

    app.post('/groups', { preHandler: write }, async (req) => {
      const b = GroupBody.parse(req.body);
      const r = await exec(ctx.db, 'INSERT INTO user_groups (name, description, created_at) VALUES (?,?,?)', [b.name, b.description ?? null, new Date()]);
      await setMembers(r.insertId, b.memberIds);
      await audit(ctx, req, 'group.create', 'group', r.insertId, { name: b.name, members: b.memberIds.length });
      return { id: r.insertId };
    });

    app.patch<{ Params: { id: string } }>('/groups/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(GroupBody, req.body);
      if (!(await one(ctx.db, 'SELECT id FROM user_groups WHERE id = ?', [id]))) throw notFound('Group not found');
      if (b.name !== undefined || b.description !== undefined) {
        await exec(ctx.db, 'UPDATE user_groups SET name = COALESCE(?, name), description = ? WHERE id = ?', [b.name ?? null, b.description ?? null, id]);
      }
      if (b.memberIds) await setMembers(id, b.memberIds);
      await audit(ctx, req, 'group.update', 'group', id, { name: b.name, members: b.memberIds?.length });
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/groups/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const r = await exec(ctx.db, 'DELETE FROM user_groups WHERE id = ?', [id]);
      if (!r.affectedRows) throw notFound('Group not found');
      await audit(ctx, req, 'group.delete', 'group', id);
      return { ok: true };
    });

    // ------------------------------------------------------ distribution lists
    const ListBody = z.object({
      address: Email,
      name: z.string().trim().min(1).max(200),
      senderPolicy: z.enum(['anyone', 'domain', 'members', 'listed']).default('domain'),
      allowedSenders: z.array(Email).max(500).default([]),
      expandExternal: z.boolean().default(true),
      members: z.array(Target).max(5000).default([]),
      isEnabled: z.boolean().default(true),
    });

    app.get('/lists', { preHandler: read }, async () => {
      const lists = await rows<{ id: number; listId: number; address: string; name: string; senderPolicy: string; allowedSenders: unknown; expandExternal: number; isEnabled: number }>(
        ctx.db,
        `SELECT a.id, l.id AS listId, CONCAT(a.local_part, '@', d.name) AS address, l.name, l.sender_policy AS senderPolicy,
                l.allowed_senders AS allowedSenders, l.expand_external AS expandExternal, a.is_enabled AS isEnabled
           FROM distribution_lists l JOIN addresses a ON a.list_id = l.id AND a.kind = 'list' JOIN domains d ON d.id = a.domain_id ORDER BY address`,
      );
      const members = await rows<{ list_id: number; userId: number | null; login: string | null; external: string | null }>(
        ctx.db,
        'SELECT m.list_id, m.user_id AS userId, u.login, m.external_address AS external FROM list_members m LEFT JOIN users u ON u.id = m.user_id',
      );
      return lists.map((l) => ({
        ...l,
        allowedSenders: dbm.json<string[] | null>(l.allowedSenders) ?? [],
        members: members.filter((m) => m.list_id === l.listId).map(({ list_id, ...m }) => (void list_id, m)),
      }));
    });

    app.post('/lists', { preHandler: write }, async (req) => {
      const b = ListBody.parse(req.body);
      const { domainId, local } = await domainIdFor(ctx, b.address);
      if (await addressTaken(ctx, domainId, local)) throw conflict('This address is already in use', 'ADDRESS_TAKEN');
      const now = new Date();
      const l = await exec(ctx.db, 'INSERT INTO distribution_lists (name, sender_policy, allowed_senders, expand_external, created_at, updated_at) VALUES (?,?,?,?,?,?)', [
        b.name,
        b.senderPolicy,
        JSON.stringify(b.allowedSenders),
        b.expandExternal ? 1 : 0,
        now,
        now,
      ]);
      const a = await exec(ctx.db, "INSERT INTO addresses (domain_id, local_part, kind, list_id, is_enabled, created_at) VALUES (?,?,'list',?,?,?)", [
        domainId,
        local,
        l.insertId,
        b.isEnabled ? 1 : 0,
        now,
      ]);
      await writeMembers(ctx, l.insertId, b.members);
      await audit(ctx, req, 'list.create', 'list', a.insertId, { address: b.address, members: b.members.length });
      return { id: a.insertId };
    });

    app.patch<{ Params: { id: string } }>('/lists/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(ListBody.omit({ address: true }), req.body);
      const a = await one<{ list_id: number }>(ctx.db, "SELECT list_id FROM addresses WHERE id = ? AND kind = 'list'", [id]);
      if (!a) throw notFound('List not found');
      await exec(
        ctx.db,
        `UPDATE distribution_lists SET name = COALESCE(?, name), sender_policy = COALESCE(?, sender_policy),
           allowed_senders = COALESCE(?, allowed_senders), expand_external = COALESCE(?, expand_external), updated_at = ? WHERE id = ?`,
        [b.name ?? null, b.senderPolicy ?? null, b.allowedSenders ? JSON.stringify(b.allowedSenders) : null, b.expandExternal === undefined ? null : b.expandExternal ? 1 : 0, new Date(), a.list_id],
      );
      if (b.isEnabled !== undefined) await exec(ctx.db, 'UPDATE addresses SET is_enabled = ? WHERE id = ?', [b.isEnabled ? 1 : 0, id]);
      if (b.members) await writeMembers(ctx, a.list_id, b.members);
      await audit(ctx, req, 'list.update', 'list', id, { ...b, members: b.members?.length });
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/lists/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const a = await one<{ list_id: number }>(ctx.db, "SELECT list_id FROM addresses WHERE id = ? AND kind = 'list'", [id]);
      if (!a) throw notFound('List not found');
      await exec(ctx.db, 'DELETE FROM distribution_lists WHERE id = ?', [a.list_id]); // address row cascades
      await audit(ctx, req, 'list.delete', 'list', id);
      return { ok: true };
    });
  };
}
