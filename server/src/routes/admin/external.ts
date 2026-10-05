// External POP3/IMAP accounts mapped to local mailboxes (admin only — employees
// never see or know the provider password).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db as dbm, resolveAlert, testExternalAccount, type CoreContext } from '@vpm/core';
import { audit, requireAdmin } from '../../guards.js';
import { badRequest, forbidden, notFound, parsePatch } from '../../http.js';

const { exec, one, rows } = dbm;
const Id = z.coerce.number().int().positive();
const Security = z.enum(['none', 'starttls', 'tls']);

/**
 * Suggested settings for common providers. Technicians should still confirm
 * with the provider; `{domain}` is replaced with the mailbox domain.
 */
export const PROVIDER_PRESETS = [
  { key: 'hostinger', name: 'Hostinger', imap: ['imap.hostinger.com', 993, 'tls'], pop3: ['pop.hostinger.com', 995, 'tls'], smtp: ['smtp.hostinger.com', 465, 'tls'] },
  { key: 'titan', name: 'Titan Email', imap: ['imap.titan.email', 993, 'tls'], pop3: ['pop.titan.email', 995, 'tls'], smtp: ['smtp.titan.email', 465, 'tls'] },
  { key: 'godaddy', name: 'GoDaddy Workspace', imap: ['imap.secureserver.net', 993, 'tls'], pop3: ['pop.secureserver.net', 995, 'tls'], smtp: ['smtpout.secureserver.net', 465, 'tls'] },
  { key: 'zoho_in', name: 'Zoho Mail (India data centre)', imap: ['imappro.zoho.in', 993, 'tls'], pop3: ['poppro.zoho.in', 995, 'tls'], smtp: ['smtppro.zoho.in', 465, 'tls'], note: 'Enable IMAP/POP access in Zoho Mail settings first.' },
  { key: 'zoho', name: 'Zoho Mail (global)', imap: ['imappro.zoho.com', 993, 'tls'], pop3: ['poppro.zoho.com', 995, 'tls'], smtp: ['smtppro.zoho.com', 465, 'tls'], note: 'Enable IMAP/POP access in Zoho Mail settings first.' },
  { key: 'cpanel', name: 'cPanel hosting', imap: ['mail.{domain}', 993, 'tls'], pop3: ['mail.{domain}', 995, 'tls'], smtp: ['mail.{domain}', 465, 'tls'], note: 'If the certificate does not match mail.{domain}, use the server host name shown in cPanel.' },
  { key: 'google', name: 'Google Workspace / Gmail', imap: ['imap.gmail.com', 993, 'tls'], pop3: ['pop.gmail.com', 995, 'tls'], smtp: ['smtp.gmail.com', 465, 'tls'], note: 'Requires an app password (2-step verification must be on).' },
  { key: 'custom', name: 'Other / custom', imap: ['', 993, 'tls'], pop3: ['', 995, 'tls'], smtp: ['', 465, 'tls'] },
] as const;

const Body = z.object({
  userId: Id,
  label: z.string().trim().max(100).nullable().optional(),
  providerPreset: z.string().max(40).nullable().optional(),
  protocol: z.enum(['pop3', 'imap']),
  host: z.string().trim().min(1).max(253),
  port: z.number().int().min(1).max(65535),
  security: Security.default('tls'),
  tlsVerify: z.boolean().default(true),
  username: z.string().trim().min(1).max(254),
  password: z.string().min(1).max(500).optional(),
  remoteFolders: z.array(z.string().trim().min(1).max(255)).max(20).nullable().optional(),
  targetFolder: z.string().trim().max(1000).nullable().optional(),
  intervalSec: z.number().int().min(10).max(3600).default(30),
  useIdle: z.boolean().default(true),
  leavePolicy: z.enum(['delete', 'keep', 'keep_days']).default('keep_days'),
  keepDays: z.number().int().min(1).max(3650).default(14),
  canSendAs: z.boolean().default(false),
  smtpHost: z.string().trim().max(253).nullable().optional(),
  smtpPort: z.number().int().min(1).max(65535).nullable().optional(),
  smtpSecurity: Security.nullable().optional(),
  isEnabled: z.boolean().default(true),
});

const COLS: Record<string, string> = {
  label: 'label',
  providerPreset: 'provider_preset',
  protocol: 'protocol',
  host: 'host',
  port: 'port',
  security: 'security',
  tlsVerify: 'tls_verify',
  username: 'username',
  intervalSec: 'interval_sec',
  useIdle: 'use_idle',
  leavePolicy: 'leave_policy',
  keepDays: 'keep_days',
  canSendAs: 'can_send_as',
  smtpHost: 'smtp_host',
  smtpPort: 'smtp_port',
  smtpSecurity: 'smtp_security',
  isEnabled: 'is_enabled',
};
/** Changing any of these means the account must be retried from scratch. */
const CONNECTION_FIELDS = ['host', 'port', 'security', 'tlsVerify', 'username', 'password', 'protocol', 'isEnabled'];

const LIST_SQL = `SELECT e.id, e.user_id AS userId, u.login AS userLogin, u.display_name AS userName, e.label, e.provider_preset AS providerPreset,
    e.protocol, e.host, e.port, e.security, e.tls_verify AS tlsVerify, e.username, (e.secret IS NOT NULL) AS passwordSet,
    e.remote_folders AS remoteFolders, f.path AS targetFolder, e.interval_sec AS intervalSec, e.use_idle AS useIdle,
    e.leave_policy AS leavePolicy, e.keep_days AS keepDays, e.can_send_as AS canSendAs, e.smtp_host AS smtpHost, e.smtp_port AS smtpPort,
    e.smtp_security AS smtpSecurity, e.is_enabled AS isEnabled, e.status, e.last_error AS lastError, e.last_success_at AS lastSuccessAt,
    e.last_attempt_at AS lastAttemptAt, e.next_run_at AS nextRunAt, e.consecutive_fails AS consecutiveFails, e.fetched_total AS fetchedTotal,
    e.remote_count AS remoteCount, e.remote_bytes AS remoteBytes, e.idle_active AS idleActive
  FROM external_accounts e JOIN users u ON u.id = e.user_id LEFT JOIN folders f ON f.id = e.target_folder_id`;

export function externalRoutes(ctx: CoreContext) {
  const read = requireAdmin(ctx, 'read');
  const write = requireAdmin(ctx, 'write');

  async function folderId(userId: number, path: string | null | undefined): Promise<number | null> {
    if (!path || path.toUpperCase() === 'INBOX') return null;
    const f = await ctx.store.getFolder(userId, path);
    if (!f) throw badRequest(`Folder "${path}" does not exist in this mailbox`);
    return f.id;
  }

  const shape = (r: Record<string, unknown>) => ({ ...r, remoteFolders: dbm.json<string[] | null>(r.remoteFolders) ?? null, targetFolder: r.targetFolder ?? 'INBOX' });

  return async (app: FastifyInstance) => {
    app.get('/external-accounts/presets', { preHandler: read }, async () => PROVIDER_PRESETS);

    app.get<{ Querystring: { userId?: string } }>('/external-accounts', { preHandler: read }, async (req) => {
      const uid = req.query.userId ? Number(req.query.userId) : null;
      const list = await rows(ctx.db, `${LIST_SQL} ${uid ? 'WHERE e.user_id = ?' : ''} ORDER BY u.login, e.id`, uid ? [uid] : []);
      const summary = await rows<{ status: string; n: number }>(ctx.db, 'SELECT status, COUNT(*) n FROM external_accounts WHERE is_enabled = 1 GROUP BY status');
      return { items: list.map(shape), summary: Object.fromEntries(summary.map((s) => [s.status, Number(s.n)])), max: ctx.license.maxExternalAccounts() };
    });

    app.get<{ Params: { id: string } }>('/external-accounts/:id', { preHandler: read }, async (req) => {
      const id = Id.parse(req.params.id);
      const acc = await one(ctx.db, `${LIST_SQL} WHERE e.id = ?`, [id]);
      if (!acc) throw notFound('Account not found');
      const runs = await rows(
        ctx.db,
        `SELECT started_at AS startedAt, finished_at AS finishedAt, trigger_kind AS triggerKind, fetched, duplicates, deleted_remote AS deletedRemote,
                bytes, result, error FROM fetch_runs WHERE account_id = ? ORDER BY id DESC LIMIT 30`,
        [id],
      );
      return { ...shape(acc), runs };
    });

    app.post('/external-accounts', { preHandler: write }, async (req) => {
      const b = Body.parse(req.body);
      if (!b.password) throw badRequest('The provider password is required');
      const user = await one<{ has_mailbox: number }>(ctx.db, 'SELECT has_mailbox FROM users WHERE id = ?', [b.userId]);
      if (!user?.has_mailbox) throw badRequest('Choose a user with a mailbox');
      const max = ctx.license.maxExternalAccounts();
      if (max !== null) {
        const used = await one<{ n: number }>(ctx.db, 'SELECT COUNT(*) n FROM external_accounts WHERE is_enabled = 1');
        if (b.isEnabled && Number(used?.n) >= max) throw forbidden(`Licence allows ${max} external accounts`, 'LICENSE_LIMIT');
      }
      const now = new Date();
      const r = await exec(
        ctx.db,
        `INSERT INTO external_accounts (user_id, label, provider_preset, protocol, host, port, security, tls_verify, username, secret, remote_folders,
           target_folder_id, interval_sec, use_idle, leave_policy, keep_days, can_send_as, smtp_host, smtp_port, smtp_security, is_enabled, status,
           next_run_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          b.userId,
          b.label ?? null,
          b.providerPreset ?? null,
          b.protocol,
          b.host,
          b.port,
          b.security,
          b.tlsVerify ? 1 : 0,
          b.username,
          ctx.secrets.seal(b.password),
          b.remoteFolders?.length ? JSON.stringify(b.remoteFolders) : null,
          await folderId(b.userId, b.targetFolder),
          b.intervalSec,
          b.useIdle ? 1 : 0,
          b.leavePolicy,
          b.keepDays,
          b.canSendAs ? 1 : 0,
          b.smtpHost || null,
          b.smtpPort ?? null,
          b.smtpSecurity ?? null,
          b.isEnabled ? 1 : 0,
          b.isEnabled ? 'idle' : 'disabled',
          b.isEnabled ? now : null,
          now,
          now,
        ],
      );
      await audit(ctx, req, 'external.create', 'external_account', r.insertId, { ...b, password: 'set' });
      return { id: r.insertId };
    });

    app.patch<{ Params: { id: string } }>('/external-accounts/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(Body, req.body);
      const cur = await one<{ user_id: number; is_enabled: number }>(ctx.db, 'SELECT user_id, is_enabled FROM external_accounts WHERE id = ?', [id]);
      if (!cur) throw notFound('Account not found');
      if (b.userId && b.userId !== cur.user_id) throw badRequest('An account cannot be moved to another user; create a new one');
      const sets: string[] = [];
      const vals: unknown[] = [];
      for (const [k, col] of Object.entries(COLS)) {
        const v = (b as Record<string, unknown>)[k];
        if (v === undefined) continue;
        sets.push(`${col} = ?`);
        vals.push(typeof v === 'boolean' ? (v ? 1 : 0) : v);
      }
      if (b.password) {
        sets.push('secret = ?');
        vals.push(ctx.secrets.seal(b.password));
      }
      if (b.remoteFolders !== undefined) {
        sets.push('remote_folders = ?');
        vals.push(b.remoteFolders?.length ? JSON.stringify(b.remoteFolders) : null);
      }
      if (b.targetFolder !== undefined) {
        sets.push('target_folder_id = ?');
        vals.push(await folderId(cur.user_id, b.targetFolder));
      }
      const reconnect = CONNECTION_FIELDS.some((k) => (b as Record<string, unknown>)[k] !== undefined);
      const enabled = b.isEnabled ?? Boolean(cur.is_enabled);
      if (!enabled) sets.push("status = 'disabled'", 'next_run_at = NULL', 'idle_active = 0');
      else if (reconnect) sets.push("status = 'idle'", 'next_run_at = ?', 'consecutive_fails = 0', 'last_error = NULL');
      if (enabled && reconnect) vals.push(new Date());
      if (sets.length) await exec(ctx.db, `UPDATE external_accounts SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`, [...vals, new Date(), id]);
      if (reconnect) for (const k of ['auth', 'fail']) await resolveAlert(ctx.db, `ext.${k}.${id}`);
      await audit(ctx, req, 'external.update', 'external_account', id, { ...b, password: b.password ? 'changed' : undefined });
      return { ok: true };
    });

    app.delete<{ Params: { id: string } }>('/external-accounts/:id', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const r = await exec(ctx.db, 'DELETE FROM external_accounts WHERE id = ?', [id]);
      if (!r.affectedRows) throw notFound('Account not found');
      await audit(ctx, req, 'external.delete', 'external_account', id);
      return { ok: true };
    });

    /** Asks the worker to fetch now (it picks the account up within about a second). */
    app.post<{ Params: { id: string } }>('/external-accounts/:id/fetch-now', { preHandler: write }, async (req) => {
      const id = Id.parse(req.params.id);
      const r = await exec(
        ctx.db,
        `UPDATE external_accounts SET next_run_at = ?, status = IF(status IN ('auth_failed','backoff','quota_full','error'), 'idle', status), consecutive_fails = 0
          WHERE id = ? AND is_enabled = 1 AND status NOT IN ('fetching','connecting')`,
        [new Date(), id],
      );
      if (!r.affectedRows) {
        const a = await one<{ is_enabled: number; status: string }>(ctx.db, 'SELECT is_enabled, status FROM external_accounts WHERE id = ?', [id]);
        if (!a) throw notFound('Account not found');
        if (!a.is_enabled) throw badRequest('The account is disabled');
        return { ok: true, message: 'A fetch is already running' };
      }
      await audit(ctx, req, 'external.fetch_now', 'external_account', id);
      return { ok: true, message: 'Fetch requested' };
    });

    /** Tests either a saved account (stored password) or unsaved settings from the form. */
    const TestFields = Body.pick({ protocol: true, host: true, port: true, security: true, tlsVerify: true, username: true, password: true });
    app.post<{ Params: { id: string } }>('/external-accounts/:id/test', { preHandler: write, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
      const id = Id.parse(req.params.id);
      const b = parsePatch(TestFields, req.body);
      const acc = await one<{ protocol: 'pop3' | 'imap'; host: string; port: number; security: 'none' | 'starttls' | 'tls'; tls_verify: number; username: string; secret: Buffer }>(
        ctx.db,
        'SELECT protocol, host, port, security, tls_verify, username, secret FROM external_accounts WHERE id = ?',
        [id],
      );
      if (!acc) throw notFound('Account not found');
      const merged = {
        protocol: b.protocol ?? acc.protocol,
        host: b.host ?? acc.host,
        port: b.port ?? acc.port,
        security: b.security ?? acc.security,
        tls_verify: b.tlsVerify === undefined ? acc.tls_verify : b.tlsVerify ? 1 : 0,
        username: b.username ?? acc.username,
      };
      return testExternalAccount(merged, b.password ?? ctx.secrets.open(Buffer.from(acc.secret)));
    });

    app.post('/external-accounts/test', { preHandler: write, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
      const b = TestFields.required({ protocol: true, host: true, port: true, username: true, password: true }).parse(req.body);
      return testExternalAccount({ protocol: b.protocol, host: b.host, port: b.port, security: b.security ?? 'tls', tls_verify: b.tlsVerify === false ? 0 : 1, username: b.username }, b.password);
    });
  };
}
