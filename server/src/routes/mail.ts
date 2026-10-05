// Mail Mode data for the signed-in user. Phase 6 adds the full webmail API here.
import type { FastifyInstance } from 'fastify';
import { db as dbm, type CoreContext } from '@vpm/core';
import { z } from 'zod';
import { audit, requireUser } from '../guards.js';
import { forbidden } from '../http.js';
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
} from '../rules-service.js';

const { one, rows } = dbm;

export function mailRoutes(ctx: CoreContext) {
  const Id = z.coerce.number().int().positive();
  const mailbox = requireUser();
  const own = (req: { auth: { user: { id: number; has_mailbox: number } } | null }): RuleScope => {
    if (!req.auth!.user.has_mailbox) throw forbidden('This account has no mailbox');
    return { scope: 'user', userId: req.auth!.user.id };
  };

  return async (app: FastifyInstance) => {
    // ------------------------------------------------ personal rules, forwarding, out of office
    app.get('/policy', { preHandler: mailbox }, async () => ({ allowExternalForwarding: (await mailPolicy(ctx)).allowUserExternalForwarding }));
    app.get('/rules', { preHandler: mailbox }, async (req) => listRules(ctx, own(req)));
    app.post('/rules', { preHandler: mailbox }, async (req) => ({ id: await createRule(ctx, own(req), req.body, false, req.auth!.user.id) }));
    app.put<{ Params: { id: string } }>('/rules/:id', { preHandler: mailbox }, async (req) => {
      await updateRule(ctx, own(req), Id.parse(req.params.id), req.body, false);
      return { ok: true };
    });
    app.post<{ Params: { id: string } }>('/rules/:id/enabled', { preHandler: mailbox }, async (req) => {
      await setRuleEnabled(ctx, own(req), Id.parse(req.params.id), z.object({ enabled: z.boolean() }).parse(req.body).enabled);
      return { ok: true };
    });
    app.delete<{ Params: { id: string } }>('/rules/:id', { preHandler: mailbox }, async (req) => {
      await deleteRule(ctx, own(req), Id.parse(req.params.id));
      return { ok: true };
    });
    app.put('/rules-order', { preHandler: mailbox }, async (req) => {
      await reorderRules(ctx, own(req), z.object({ ids: z.array(Id).max(500) }).parse(req.body).ids);
      return { ok: true };
    });
    app.post('/rules/test', { preHandler: mailbox }, async (req) => {
      own(req);
      return testRule(ctx, req.body);
    });
    app.get('/forwarding', { preHandler: mailbox }, async (req) => getForwarding(ctx, own(req).userId!));
    app.put('/forwarding', { preHandler: mailbox }, async (req) => {
      const s = own(req);
      await setForwarding(ctx, s.userId!, req.body, false, req.auth!.user.id);
      await audit(ctx, req, 'user.forwarding_set', 'user', s.userId, req.body as Record<string, unknown>); // forwarding is a data-leak path: always audited
      return { ok: true };
    });
    app.get('/autoreply', { preHandler: mailbox }, async (req) => getAutoReply(ctx, own(req).userId!));
    app.put('/autoreply', { preHandler: mailbox }, async (req) => {
      await setAutoReply(ctx, own(req).userId!, req.body);
      return { ok: true };
    });

    app.get('/summary', { preHandler: requireUser() }, async (req) => {
      const a = req.auth!;
      if (!a.user.has_mailbox) throw forbidden('This account has no mailbox');
      const q = await ctx.store.quota(a.user.id);
      const addresses = await ctx.directory.userAddresses(a.user.id);
      const folders = await rows(
        ctx.db,
        'SELECT path, special_use AS specialUse, message_count AS messages, unseen_count AS unseen, total_bytes AS bytes FROM folders WHERE user_id = ? ORDER BY special_use IS NULL, path',
        [a.user.id],
      );
      const perms = await one<{ allow_imap: number; allow_pop3: number; allow_smtp: number }>(ctx.db, 'SELECT allow_imap, allow_pop3, allow_smtp FROM users WHERE id = ?', [a.user.id]);
      const p = ctx.config.ports;
      return {
        login: a.user.login,
        displayName: a.user.display_name,
        addresses,
        quota: q,
        folders,
        server: {
          host: ctx.config.hostname,
          imap: perms?.allow_imap ? { ssl: p.imaps || null, starttls: p.imap || null } : null,
          pop3: perms?.allow_pop3 ? { ssl: p.pop3s || null, starttls: p.pop3 || null } : null,
          smtp: perms?.allow_smtp ? { ssl: p.smtps || null, starttls: p.submission || null } : null,
        },
      };
    });
  };
}
