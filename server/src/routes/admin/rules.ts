// Admin: global rules, any user's rules/forwarding/out-of-office, journaling, mail policy.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { JournalInput, MAIL_POLICY_DEFAULTS, db as dbm, type CoreContext } from '@vpm/core';
import { audit, requireAdmin } from '../../guards.js';
import { badRequest, notFound, parsePatch } from '../../http.js';
import {
  createRule,
  deleteRule,
  getAutoReply,
  getForwarding,
  listRules,
  mailPolicy,
  reorderRules,
  setAutoReply,
  setForwarding,
  setRuleEnabled,
  testRule,
  updateRule,
  type RuleScope,
} from '../../rules-service.js';

const { exec, json, one, rows } = dbm;
const Id = z.coerce.number().int().positive();

export function rulesRoutes(ctx: CoreContext) {
  const read = requireAdmin(ctx, 'read');
  const write = requireAdmin(ctx, 'write');
  const superOnly = requireAdmin(ctx, 'super');

  async function scopeOf(q: { userId?: string | number }): Promise<RuleScope> {
    if (q.userId === undefined || q.userId === '') return { scope: 'global', userId: null };
    const userId = Id.parse(q.userId);
    const u = await one<{ has_mailbox: number }>(ctx.db, 'SELECT has_mailbox FROM users WHERE id = ?', [userId]);
    if (!u?.has_mailbox) throw notFound('User not found');
    return { scope: 'user', userId };
  }

  return async (app: FastifyInstance) => {
    // ------------------------------------------------------------ rules
    app.get<{ Querystring: { userId?: string } }>('/rules', { preHandler: read }, async (req) => listRules(ctx, await scopeOf(req.query)));

    app.post<{ Querystring: { userId?: string } }>('/rules', { preHandler: write }, async (req) => {
      const s = await scopeOf(req.query);
      const id = await createRule(ctx, s, req.body, true, req.auth!.user.id);
      await audit(ctx, req, 'rule.create', 'rule', id, { scope: s.scope, userId: s.userId, rule: req.body as Record<string, unknown> });
      return { id };
    });

    app.put<{ Params: { id: string }; Querystring: { userId?: string } }>('/rules/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      await updateRule(ctx, await scopeOf(req.query), id, req.body, true);
      await audit(ctx, req, 'rule.update', 'rule', id, { rule: req.body as Record<string, unknown> });
      return { ok: true };
    });

    app.post<{ Params: { id: string }; Querystring: { userId?: string } }>('/rules/:id/enabled', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
      await setRuleEnabled(ctx, await scopeOf(req.query), id, enabled);
      await audit(ctx, req, enabled ? 'rule.enable' : 'rule.disable', 'rule', id);
      return { ok: true };
    });

    app.delete<{ Params: { id: string }; Querystring: { userId?: string } }>('/rules/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      await deleteRule(ctx, await scopeOf(req.query), id);
      await audit(ctx, req, 'rule.delete', 'rule', id);
      return { ok: true };
    });

    app.put<{ Querystring: { userId?: string } }>('/rules-order', { preHandler: write }, async (req) => {
      const { ids } = z.object({ ids: z.array(Id).max(500) }).parse(req.body);
      const s = await scopeOf(req.query);
      await reorderRules(ctx, s, ids);
      await audit(ctx, req, 'rule.reorder', 'rule', null, { scope: s.scope, userId: s.userId, ids });
      return { ok: true };
    });

    app.post('/rules/test', { preHandler: read }, async (req) => testRule(ctx, req.body));

    // ------------------------------------------------------------ per-user forwarding & out of office
    /** Every user's forwarding in one list (Admin → Easy rules). */
    app.get('/forwardings', { preHandler: read }, async () =>
      (
        await rows<{ user_id: number; login: string; display_name: string; target_address: string; keep_local_copy: number; is_enabled: number }>(
          ctx.db,
          'SELECT f.user_id, u.login, u.display_name, f.target_address, f.keep_local_copy, f.is_enabled FROM forwardings f JOIN users u ON u.id = f.user_id ORDER BY u.login, f.id',
        )
      ).map((f) => ({ userId: f.user_id, login: f.login, name: f.display_name, address: f.target_address, keepLocalCopy: Boolean(f.keep_local_copy), isEnabled: Boolean(f.is_enabled) })),
    );
    app.get<{ Params: { id: string } }>('/users/:id/forwarding', { preHandler: read }, async (req) => getForwarding(ctx, Id.parse(req.params.id)));
    app.put<{ Params: { id: string } }>('/users/:id/forwarding', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      await setForwarding(ctx, id, req.body, true, req.auth!.user.id);
      await audit(ctx, req, 'user.forwarding_set', 'user', id, req.body as Record<string, unknown>);
      return { ok: true };
    });
    app.get<{ Params: { id: string } }>('/users/:id/autoreply', { preHandler: read }, async (req) => getAutoReply(ctx, Id.parse(req.params.id)));
    app.put<{ Params: { id: string } }>('/users/:id/autoreply', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      await setAutoReply(ctx, id, req.body);
      await audit(ctx, req, 'user.autoreply_set', 'user', id, { isEnabled: (req.body as { isEnabled?: boolean })?.isEnabled });
      return { ok: true };
    });

    // ------------------------------------------------------------ journaling
    const shapeJ = (r: Record<string, unknown>) => ({
      id: r.id,
      name: r.name,
      direction: r.direction,
      scope: r.scope,
      scopeId: r.scope_id,
      includeInternal: Boolean(r.include_internal),
      matchMode: r.match_mode,
      conditions: json(r.conditions) ?? [],
      targetAddress: r.target_address,
      isEnabled: Boolean(r.is_enabled),
      hitCount: Number(r.hit_count),
      lastHitAt: r.last_hit_at,
    });
    const checkScope = async (b: { scope?: string; scopeId?: number | null }) => {
      if (!b.scope || b.scope === 'all') return;
      if (!b.scopeId) throw badRequest('Choose the domain, group or user this journal rule applies to');
      const table = b.scope === 'domain' ? 'domains' : b.scope === 'group' ? 'user_groups' : 'users';
      if (!(await one(ctx.db, `SELECT id FROM ${table} WHERE id = ?`, [b.scopeId]))) throw badRequest(`Unknown ${b.scope}`);
    };

    app.get('/journal-rules', { preHandler: read }, async () => (await rows(ctx.db, 'SELECT * FROM journal_rules ORDER BY id')).map(shapeJ));

    app.post('/journal-rules', { preHandler: write }, async (req) => {
      const b = JournalInput.parse(req.body);
      await checkScope(b);
      const r = await exec(
        ctx.db,
        `INSERT INTO journal_rules (name, direction, scope, scope_id, include_internal, match_mode, conditions, target_address, is_enabled, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
        [b.name, b.direction, b.scope, b.scope === 'all' ? null : (b.scopeId ?? null), b.includeInternal ? 1 : 0, b.matchMode, JSON.stringify(b.conditions), b.targetAddress, b.isEnabled ? 1 : 0, new Date()],
      );
      await audit(ctx, req, 'journal.create', 'journal_rule', r.insertId, b);
      return { id: r.insertId };
    });

    app.patch<{ Params: { id: string } }>('/journal-rules/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(JournalInput, req.body);
      if (!(await one(ctx.db, 'SELECT id FROM journal_rules WHERE id = ?', [id]))) throw notFound('Journal rule not found');
      await checkScope(b);
      const map: Record<string, string> = { name: 'name', direction: 'direction', scope: 'scope', scopeId: 'scope_id', includeInternal: 'include_internal', matchMode: 'match_mode', targetAddress: 'target_address', isEnabled: 'is_enabled' };
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, col] of Object.entries(map)) {
        const v = (b as Record<string, unknown>)[k];
        if (v === undefined) continue;
        sets.push(`${col} = ?`);
        vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      if (b.conditions) {
        sets.push('conditions = ?');
        vals.push(JSON.stringify(b.conditions));
      }
      if (sets.length) await exec(ctx.db, `UPDATE journal_rules SET ${sets.join(', ')} WHERE id = ?`, [...vals, id]);
      await audit(ctx, req, 'journal.update', 'journal_rule', id, b);
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/journal-rules/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const r = await exec(ctx.db, 'DELETE FROM journal_rules WHERE id = ?', [id]);
      if (!r.affectedRows) throw notFound('Journal rule not found');
      await audit(ctx, req, 'journal.delete', 'journal_rule', id);
      return { ok: true };
    });

    // ------------------------------------------------------------ mail policy
    const Policy = z.object({
      allowUserExternalForwarding: z.boolean(),
      rewriteFromOnExternalForward: z.boolean(),
      timezone: z.string().refine((tz) => {
        try {
          new Intl.DateTimeFormat('en', { timeZone: tz });
          return true;
        } catch {
          return false;
        }
      }, 'Unknown time zone'),
    });
    app.get('/mail-policy', { preHandler: read }, async () => mailPolicy(ctx));
    app.put('/mail-policy', { preHandler: superOnly }, async (req) => {
      const b = parsePatch(Policy, req.body);
      const next = { ...MAIL_POLICY_DEFAULTS, ...(await mailPolicy(ctx)), ...b };
      await ctx.settings.set('mail', 'policy', next, req.auth!.user.id);
      await audit(ctx, req, 'mail.policy_update', 'settings', 'mail.policy', b);
      return next;
    });
  };
}
