// SMTP relay accounts, relay routes and the outbound queue viewer.
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { createTransport, db as dbm, relayTargetFromRow, type CoreContext } from '@vpm/core';
import { audit, requireAdmin } from '../../guards.js';
import { HttpError, badRequest, conflict, notFound, page, parsePatch } from '../../http.js';

const { exec, one, rows, tx } = dbm;
const Id = z.coerce.number().int().positive();
const Email = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address');

const RelayBody = z.object({
  name: z.string().trim().min(1).max(100),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: z.enum(['none', 'starttls', 'tls']).default('starttls'),
  authUser: z.string().trim().max(254).nullable().optional(),
  /** Write-only. Omit or send null to keep the stored password; "" clears it. */
  password: z.string().max(500).nullable().optional(),
  envelopeFrom: z.enum(['relay_account', 'original_sender']).default('relay_account'),
  setSenderHeader: z.boolean().default(true),
  maxMsgsPerMin: z.number().int().min(1).max(100000).nullable().optional(),
  maxConnections: z.number().int().min(1).max(20).default(2),
  tlsVerify: z.boolean().default(true),
  isDefault: z.boolean().default(false),
  isEnabled: z.boolean().default(true),
});

const RELAY_COLS = `id, name, host, port, security, auth_user AS authUser, (auth_secret IS NOT NULL) AS passwordSet,
  envelope_from AS envelopeFrom, set_sender_header AS setSenderHeader, max_msgs_per_min AS maxMsgsPerMin,
  max_connections AS maxConnections, tls_verify AS tlsVerify, is_default AS isDefault, is_enabled AS isEnabled,
  last_test_at AS lastTestAt, last_test_result AS lastTestResult, updated_at AS updatedAt`;

const TERMINAL = new Set(['sent', 'failed', 'partial']);

export function relayRoutes(ctx: CoreContext) {
  const read = requireAdmin(ctx, 'read');
  const write = requireAdmin(ctx, 'write');

  return async (app: FastifyInstance) => {
    // ------------------------------------------------------------ relays
    app.get('/relays', { preHandler: read }, async () => rows(ctx.db, `SELECT ${RELAY_COLS} FROM relay_accounts ORDER BY is_default DESC, name`));

    app.post('/relays', { preHandler: write }, async (req) => {
      const b = RelayBody.parse(req.body);
      const now = new Date();
      const id = await tx(ctx.db, async (c) => {
        if (b.isDefault) await exec(c, 'UPDATE relay_accounts SET is_default = 0');
        const r = await exec(
          c,
          `INSERT INTO relay_accounts (name, host, port, security, auth_user, auth_secret, envelope_from, set_sender_header, max_msgs_per_min,
             max_connections, tls_verify, is_default, is_enabled, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            b.name,
            b.host,
            b.port,
            b.security,
            b.authUser || null,
            b.password ? ctx.secrets.seal(b.password) : null,
            b.envelopeFrom,
            b.setSenderHeader ? 1 : 0,
            b.maxMsgsPerMin ?? null,
            b.maxConnections,
            b.tlsVerify ? 1 : 0,
            b.isDefault ? 1 : 0,
            b.isEnabled ? 1 : 0,
            now,
            now,
          ],
        );
        return r.insertId;
      });
      await audit(ctx, req, 'relay.create', 'relay', id, { ...b, password: b.password ? 'set' : undefined });
      return { id };
    });

    app.patch<{ Params: { id: string } }>('/relays/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(RelayBody, req.body);
      const map: Record<string, string> = {
        name: 'name',
        host: 'host',
        port: 'port',
        security: 'security',
        authUser: 'auth_user',
        envelopeFrom: 'envelope_from',
        setSenderHeader: 'set_sender_header',
        maxMsgsPerMin: 'max_msgs_per_min',
        maxConnections: 'max_connections',
        tlsVerify: 'tls_verify',
        isDefault: 'is_default',
        isEnabled: 'is_enabled',
      };
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, col] of Object.entries(map)) {
        const v = (b as Record<string, unknown>)[k];
        if (v === undefined) continue;
        sets.push(`${col} = ?`);
        vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      if (b.password !== undefined && b.password !== null) {
        sets.push('auth_secret = ?');
        vals.push(b.password === '' ? null : ctx.secrets.seal(b.password));
      }
      await tx(ctx.db, async (c) => {
        if (!(await one(c, 'SELECT id FROM relay_accounts WHERE id = ?', [id]))) throw notFound('Relay not found');
        if (b.isDefault) await exec(c, 'UPDATE relay_accounts SET is_default = 0 WHERE id <> ?', [id]);
        if (sets.length) await exec(c, `UPDATE relay_accounts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, new Date(), id]);
      });
      await audit(ctx, req, 'relay.update', 'relay', id, { ...b, password: b.password ? 'changed' : undefined });
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/relays/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const busy = await one<{ n: number }>(ctx.db, "SELECT COUNT(*) n FROM outbound_queue WHERE relay_account_id = ? AND status = 'sending'", [id]);
      if (Number(busy?.n)) throw conflict('This relay is sending right now; try again in a minute');
      const r = await exec(ctx.db, 'DELETE FROM relay_accounts WHERE id = ?', [id]);
      if (!r.affectedRows) throw notFound('Relay not found');
      await audit(ctx, req, 'relay.delete', 'relay', id);
      return { ok: true };
    });

    /** Connects and authenticates; optionally sends a real test message (detects From-address policies). */
    app.post<{ Params: { id: string } }>('/relays/:id/test', { preHandler: write, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = z.object({ to: Email.optional(), from: Email.optional() }).parse(req.body ?? {});
      const row = await one(ctx.db, 'SELECT * FROM relay_accounts WHERE id = ?', [id]);
      if (!row) throw notFound('Relay not found');
      const t = relayTargetFromRow(row as Parameters<typeof relayTargetFromRow>[0]);
      const transport = createTransport(t, ctx.secrets, { hostname: ctx.config.hostname });
      let result: { ok: boolean; message: string };
      try {
        await transport.verify();
        if (b.to) {
          const from = b.from ?? t.authUser;
          if (!from) throw badRequest('A from address is needed for a test send');
          const envFrom = t.envelopeFrom === 'relay_account' && t.authUser ? t.authUser : from;
          const info = await transport.sendMail({
            envelope: { from: envFrom, to: [b.to] },
            from,
            to: b.to,
            subject: 'Vayrone PostMaster relay test',
            text: `This is a test message from Vayrone PostMaster (${ctx.config.hostname}) through relay "${t.name}".\r\n`,
          });
          result = { ok: true, message: `Test message accepted: ${info.response}` };
        } else {
          result = { ok: true, message: 'Connected and authenticated successfully' };
        }
      } catch (err) {
        const e = err as Error & { response?: string; command?: string };
        if (err instanceof HttpError) throw err;
        const hint =
          e.command === 'MAIL FROM'
            ? ' The provider refuses this sender address; use the relay account itself as From, or a per-user route via the employee’s own account.'
            : '';
        result = { ok: false, message: `${e.response ?? e.message}${hint}` };
      } finally {
        transport.close();
      }
      await exec(ctx.db, 'UPDATE relay_accounts SET last_test_at = ?, last_test_result = ? WHERE id = ?', [new Date(), result.message.slice(0, 500), id]);
      await audit(ctx, req, 'relay.test', 'relay', id, { to: b.to, ok: result.ok });
      return result;
    });

    // ------------------------------------------------------------ routes
    app.get('/relay-routes', { preHandler: read }, async () =>
      rows(
        ctx.db,
        `SELECT r.id, r.scope, r.domain_id AS domainId, d.name AS domain, r.user_id AS userId, u.login,
                r.relay_account_id AS relayAccountId, ra.name AS relayName, r.via_external_account_id AS viaExternalAccountId, r.is_enabled AS isEnabled
           FROM relay_routes r LEFT JOIN domains d ON d.id = r.domain_id LEFT JOIN users u ON u.id = r.user_id
           LEFT JOIN relay_accounts ra ON ra.id = r.relay_account_id ORDER BY r.scope, d.name, u.login`,
      ),
    );

    const RouteBody = z
      .object({
        scope: z.enum(['domain', 'user']),
        domainId: Id.optional(),
        userId: Id.optional(),
        relayAccountId: Id.nullable().optional(),
        viaExternalAccountId: Id.nullable().optional(),
        isEnabled: z.boolean().default(true),
      })
      .refine((r) => (r.scope === 'domain' ? r.domainId : r.userId), 'domainId or userId is required for the scope')
      .refine((r) => Boolean(r.relayAccountId) !== Boolean(r.viaExternalAccountId), 'Choose exactly one: a relay account or the user’s own external account');

    app.put('/relay-routes', { preHandler: write }, async (req) => {
      const b = RouteBody.parse(req.body);
      const key = b.scope === 'domain' ? ['domain_id', b.domainId] : ['user_id', b.userId];
      await exec(ctx.db, `DELETE FROM relay_routes WHERE scope = ? AND ${key[0]} = ?`, [b.scope, key[1]]);
      const r = await exec(
        ctx.db,
        'INSERT INTO relay_routes (scope, domain_id, user_id, relay_account_id, via_external_account_id, is_enabled, created_at) VALUES (?,?,?,?,?,?,?)',
        [b.scope, b.domainId ?? null, b.userId ?? null, b.relayAccountId ?? null, b.viaExternalAccountId ?? null, b.isEnabled ? 1 : 0, new Date()],
      );
      await audit(ctx, req, 'relay_route.set', 'relay_route', r.insertId, b);
      return { id: r.insertId };
    });

    app.delete<{ Params: { id: string } }>('/relay-routes/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const r = await exec(ctx.db, 'DELETE FROM relay_routes WHERE id = ?', [id]);
      if (!r.affectedRows) throw notFound('Route not found');
      await audit(ctx, req, 'relay_route.delete', 'relay_route', id);
      return { ok: true };
    });

    // ------------------------------------------------------------- queue
    app.get<{ Querystring: Record<string, string> }>('/queue', { preHandler: read }, async (req) => {
      const { limit, offset, page: p } = page(req.query);
      const where: string[] = [];
      const vals: unknown[] = [];
      if (req.query.status) {
        where.push('q.status IN (?)');
        vals.push(req.query.status.split(','));
      }
      if (req.query.q) {
        where.push('(q.envelope_from LIKE ? OR m.hdr_subject LIKE ? OR EXISTS (SELECT 1 FROM outbound_recipients r WHERE r.queue_id = q.id AND r.rcpt LIKE ?))');
        vals.push(`%${req.query.q}%`, `%${req.query.q}%`, `%${req.query.q}%`);
      }
      const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
      const items = await rows(
        ctx.db,
        `SELECT q.id, q.status, q.source, q.envelope_from AS envelopeFrom, u.login AS sender, m.hdr_subject AS subject, m.size_raw AS size,
                q.attempts, q.next_attempt_at AS nextAttemptAt, q.expires_at AS expiresAt, q.last_error AS lastError, q.hold_reason AS holdReason,
                ra.name AS relay, q.created_at AS createdAt, q.completed_at AS completedAt,
                (SELECT COUNT(*) FROM outbound_recipients r WHERE r.queue_id = q.id) AS recipients,
                (SELECT GROUP_CONCAT(r.rcpt ORDER BY r.id SEPARATOR ', ') FROM outbound_recipients r WHERE r.queue_id = q.id) AS recipientList
           FROM outbound_queue q JOIN messages m ON m.id = q.message_id LEFT JOIN users u ON u.id = q.sender_user_id
           LEFT JOIN relay_accounts ra ON ra.id = q.relay_account_id ${w}
          ORDER BY q.id DESC LIMIT ? OFFSET ?`,
        [...vals, limit, offset],
      );
      const total = await one<{ n: number }>(ctx.db, `SELECT COUNT(*) n FROM outbound_queue q JOIN messages m ON m.id = q.message_id ${w}`, vals);
      const counts = await rows<{ status: string; n: number }>(ctx.db, 'SELECT status, COUNT(*) n FROM outbound_queue GROUP BY status');
      return { items, total: Number(total?.n ?? 0), page: p, counts: Object.fromEntries(counts.map((c) => [c.status, Number(c.n)])) };
    });

    app.get<{ Params: { id: string } }>('/queue/:id', { preHandler: read }, async (req) => {
      const id = Id.parse(req.params.id);
      const q = await one(ctx.db, 'SELECT * FROM outbound_queue WHERE id = ?', [id]);
      if (!q) throw notFound('Queue entry not found');
      const recipients = await rows(
        ctx.db,
        'SELECT rcpt, status, attempts, smtp_code AS smtpCode, smtp_response AS smtpResponse, updated_at AS updatedAt FROM outbound_recipients WHERE queue_id = ? ORDER BY id',
        [id],
      );
      const log = await rows(ctx.db, "SELECT at, event, rcpt, detail FROM mail_log WHERE ref_type = 'queue' AND ref_id = ? ORDER BY id", [id]);
      return { ...q, recipients, log };
    });

    async function act(id: number, action: 'retry' | 'hold' | 'release' | 'delete', reason?: string): Promise<void> {
      await tx(ctx.db, async (c) => {
        const q = await one<{ status: string; message_id: number }>(c, 'SELECT status, message_id FROM outbound_queue WHERE id = ? FOR UPDATE', [id]);
        if (!q) throw notFound(`Queue entry ${id} not found`);
        if (q.status === 'sending') throw conflict(`Message ${id} is being sent right now`);
        const now = new Date();
        if (action === 'delete') {
          if (!TERMINAL.has(q.status)) await exec(c, 'UPDATE messages SET refcount = refcount - 1 WHERE id = ? AND refcount > 0', [q.message_id]);
          await exec(c, 'DELETE FROM outbound_queue WHERE id = ?', [id]);
        } else if (action === 'hold') {
          if (!['queued', 'deferred'].includes(q.status)) throw conflict(`Only waiting messages can be held (message ${id} is ${q.status})`);
          await exec(c, "UPDATE outbound_queue SET status = 'held', hold_reason = ?, updated_at = ? WHERE id = ?", [reason ?? 'Held by administrator', now, id]);
        } else if (action === 'release') {
          if (q.status !== 'held') throw conflict(`Message ${id} is not held`);
          await exec(c, "UPDATE outbound_queue SET status = 'queued', hold_reason = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?", [now, now, id]);
        } else {
          if (q.status === 'sent') throw conflict(`Message ${id} was already delivered`);
          if (TERMINAL.has(q.status)) {
            // Re-open a finished entry: failed recipients become pending again, the message reference is re-taken.
            await exec(c, "UPDATE outbound_recipients SET status = 'pending' WHERE queue_id = ? AND status = 'failed'", [id]);
            await exec(c, 'UPDATE messages SET refcount = refcount + 1 WHERE id = ?', [q.message_id]);
            await exec(c, 'UPDATE outbound_queue SET expires_at = ?, completed_at = NULL WHERE id = ?', [new Date(now.getTime() + 3 * 86400_000), id]);
          }
          await exec(c, "UPDATE outbound_queue SET status = 'queued', hold_reason = NULL, next_attempt_at = ?, locked_by = NULL, locked_until = NULL, updated_at = ? WHERE id = ?", [
            now,
            now,
            id,
          ]);
        }
      });
    }

    for (const action of ['retry', 'hold', 'release'] as const) {
      app.post<{ Params: { id: string } }>(`/queue/:id/${action}`, { preHandler: write }, async (req) => {
        const id = Id.parse(req.params.id);
        const reason = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {}).reason;
        await act(id, action, reason);
        await audit(ctx, req, `queue.${action}`, 'queue', id);
        return { ok: true };
      });
    }

    app.delete<{ Params: { id: string } }>('/queue/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      await act(id, 'delete');
      await audit(ctx, req, 'queue.delete', 'queue', id);
      return { ok: true };
    });

    app.post('/queue/bulk', { preHandler: write }, async (req) => {
      const b = z.object({ ids: z.array(Id).min(1).max(1000), action: z.enum(['retry', 'hold', 'release', 'delete']) }).parse(req.body);
      const errors: { id: number; message: string }[] = [];
      for (const id of b.ids) {
        try {
          await act(id, b.action);
        } catch (e) {
          errors.push({ id, message: (e as Error).message });
        }
      }
      await audit(ctx, req, `queue.bulk_${b.action}`, 'queue', null, { ids: b.ids, failed: errors.length });
      return { done: b.ids.length - errors.length, errors };
    });
  };
}
