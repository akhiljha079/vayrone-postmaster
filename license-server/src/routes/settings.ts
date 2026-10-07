// Owner settings: email, WhatsApp, reminder schedule, staff/partner logins,
// and the public signing key (for embedding in the product).
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { LsContext } from '../context.js';
import { exec, one, rows } from '../db.js';
import { hashPassword } from '../crypto.js';
import { newApiKey, requireStaff } from '../auth.js';
import { badRequest, notFound, parsePatch } from '../http.js';
import { logEvent } from '../services/licensing.js';
import { getSetting, NOTIFY_DEFAULTS, putSetting, type NotifySettings, type SmtpSettings, type WhatsAppSettings } from '../services/notify.js';
import { runReminders } from '../services/reminders.js';

const Smtp = z.object({
  host: z.string().trim().max(253),
  port: z.number().int().min(1).max(65535),
  secure: z.boolean(),
  user: z.string().trim().max(254).nullish(),
  /** Write-only: omitted or null keeps the stored password. */
  password: z.string().max(500).nullish(),
  from: z.string().trim().min(3).max(254),
});

const WhatsApp = z.object({
  provider: z.enum(['off', 'meta', 'webhook']),
  meta: z.object({ phoneNumberId: z.string().trim().max(50), token: z.string().max(2000).nullish(), language: z.string().trim().max(10), templates: z.object({ expiry: z.string().trim().max(100), amc: z.string().trim().max(100) }) }).nullish(),
  webhook: z.object({ url: z.url().max(500), authHeader: z.string().max(2000).nullish() }).nullish(),
});

const Notifications = z.object({
  salesEmail: z.email().nullish().or(z.literal('')).transform((v) => v || null),
  expiryDays: z.array(z.number().int().min(-15).max(120)).max(12),
  amcDays: z.array(z.number().int().min(-30).max(120)).max(12),
  supportPhone: z.string().trim().max(30),
});

const StaffBody = z.object({
  email: z.email().max(254).transform((v) => v.toLowerCase()),
  name: z.string().trim().min(2).max(200),
  role: z.enum(['owner', 'staff', 'reseller']),
  resellerId: z.number().int().positive().nullish(),
  password: z.string().min(10).max(200),
  isEnabled: z.boolean().default(true),
});

export function settingsRoutes(ctx: LsContext) {
  const owner = requireStaff('owner');
  const actor = (req: { staff: { id: number } | null; ip: string }) => ({ userId: req.staff!.id, resellerId: null, ip: req.ip });

  return async (app: FastifyInstance) => {
    app.get('/settings', { preHandler: owner }, async () => {
      const smtp = await getSetting<SmtpSettings | null>(ctx.db, 'smtp', null);
      const wa = await getSetting<WhatsAppSettings>(ctx.db, 'whatsapp', { provider: 'off' });
      return {
        smtp: smtp ? { ...smtp, password: null, passwordSet: Boolean(smtp.password) } : null,
        whatsapp: {
          ...wa,
          meta: wa.meta ? { ...wa.meta, token: null, tokenSet: Boolean(wa.meta.token) } : null,
          webhook: wa.webhook ? { ...wa.webhook, authHeader: null, authHeaderSet: Boolean(wa.webhook.authHeader) } : null,
        },
        notifications: await getSetting<NotifySettings>(ctx.db, 'notifications', NOTIFY_DEFAULTS),
        signing: { kid: ctx.signer.kid, publicKey: ctx.signer.publicKeyPem() },
      };
    });

    app.put('/settings/smtp', { preHandler: owner }, async (req) => {
      const b = Smtp.parse(req.body);
      const cur = await getSetting<SmtpSettings | null>(ctx.db, 'smtp', null);
      await putSetting(ctx.db, 'smtp', { ...b, user: b.user || null, password: b.password ? ctx.vault.seal(b.password) : (cur?.password ?? null) });
      await logEvent(ctx.db, { kind: 'settings_smtp', actor: actor(req), detail: { host: b.host } });
      return { ok: true };
    });

    app.put('/settings/whatsapp', { preHandler: owner }, async (req) => {
      const b = WhatsApp.parse(req.body);
      const cur = await getSetting<WhatsAppSettings>(ctx.db, 'whatsapp', { provider: 'off' });
      if (b.provider === 'meta' && !b.meta) throw badRequest('Enter the WhatsApp Cloud API details');
      if (b.provider === 'webhook' && !b.webhook) throw badRequest('Enter the webhook URL');
      const v: WhatsAppSettings = { provider: b.provider };
      if (b.meta) v.meta = { ...b.meta, token: b.meta.token ? ctx.vault.seal(b.meta.token) : (cur.meta?.token ?? null) };
      if (b.webhook) v.webhook = { ...b.webhook, authHeader: b.webhook.authHeader ? ctx.vault.seal(b.webhook.authHeader) : (cur.webhook?.authHeader ?? null) };
      await putSetting(ctx.db, 'whatsapp', v);
      await logEvent(ctx.db, { kind: 'settings_whatsapp', actor: actor(req), detail: { provider: b.provider } });
      return { ok: true };
    });

    app.put('/settings/notifications', { preHandler: owner }, async (req) => {
      const b = Notifications.parse(req.body);
      await putSetting(ctx.db, 'notifications', { ...b, expiryDays: [...new Set(b.expiryDays)].sort((x, y) => y - x), amcDays: [...new Set(b.amcDays)].sort((x, y) => y - x) });
      return { ok: true };
    });

    app.post('/settings/test-email', { preHandler: owner }, async (req) => {
      const { to } = z.object({ to: z.email() }).parse(req.body);
      try {
        await ctx.notifier.sendEmail({ to, subject: 'Vayrone License Server test', text: 'Email from the Vayrone License Server works.' });
      } catch (e) {
        throw badRequest(`Sending failed: ${(e as Error).message}`, 'SEND_FAILED');
      }
      return { ok: true };
    });

    app.post('/settings/test-whatsapp', { preHandler: owner }, async (req) => {
      const { to } = z.object({ to: z.string().min(10).max(20) }).parse(req.body);
      try {
        await ctx.notifier.sendWhatsApp({ to: to.replace(/\D/g, '').replace(/^(\d{10})$/, '91$1'), template: 'expiry', params: ['Test', 'LIC-TEST', 'today', '0', 'Vayrone'], text: 'Test message from the Vayrone License Server' });
      } catch (e) {
        throw badRequest(`Sending failed: ${(e as Error).message}`, 'SEND_FAILED');
      }
      return { ok: true };
    });

    app.post('/settings/run-reminders', { preHandler: owner }, async () => runReminders(ctx.db, ctx.notifier, { tz: ctx.config.timezone }));

    app.get('/reminders', { preHandler: requireStaff('owner', 'staff') }, async () =>
      rows(
        ctx.db,
        `SELECT m.id, m.kind, m.due_date dueDate, m.days_before daysBefore, m.channel, m.recipient, m.status, m.error, m.sent_at sentAt, l.license_id licenseId, c.company
           FROM reminders m JOIN licenses l ON l.id = m.license_id JOIN clients c ON c.id = l.client_id ORDER BY m.id DESC LIMIT 200`,
      ),
    );

    // ------------------------------------------------------------ staff and partner logins
    app.get('/staff', { preHandler: owner }, async () =>
      rows(
        ctx.db,
        'SELECT u.id, u.email, u.name, u.role, u.reseller_id resellerId, r.name resellerName, u.is_enabled isEnabled, u.last_login_at lastLoginAt FROM staff_users u LEFT JOIN resellers r ON r.id = u.reseller_id ORDER BY u.role, u.name',
      ),
    );

    app.post('/staff', { preHandler: owner }, async (req) => {
      const b = StaffBody.parse(req.body);
      if (b.role === 'reseller' && !b.resellerId) throw badRequest('Choose the partner this login belongs to');
      const r = await exec(ctx.db, 'INSERT INTO staff_users (email, name, password_hash, role, reseller_id, is_enabled, created_at) VALUES (?,?,?,?,?,?,?)', [
        b.email,
        b.name,
        await hashPassword(b.password),
        b.role,
        b.role === 'reseller' ? b.resellerId : null,
        b.isEnabled,
        new Date(),
      ]);
      await logEvent(ctx.db, { kind: 'staff_create', actor: actor(req), detail: { email: b.email, role: b.role } });
      return { id: r.insertId };
    });

    app.patch<{ Params: { id: string } }>('/staff/:id', { preHandler: owner }, async (req) => {
      const b = parsePatch(StaffBody.omit({ email: true, role: true, resellerId: true }), req.body);
      const u = await one<{ id: number }>(ctx.db, 'SELECT id FROM staff_users WHERE id = ?', [req.params.id]);
      if (!u) throw notFound('Login not found');
      if (Number(req.params.id) === req.staff!.id && b.isEnabled === false) throw badRequest('You cannot disable your own login');
      const set: Record<string, unknown> = {};
      if (b.name) set.name = b.name;
      if (b.isEnabled !== undefined) set.is_enabled = b.isEnabled;
      if (b.password) set.password_hash = await hashPassword(b.password);
      if (Object.keys(set).length) await exec(ctx.db, 'UPDATE staff_users SET ? WHERE id = ?', [set, u.id]);
      if (b.password || b.isEnabled === false) await exec(ctx.db, 'DELETE FROM sessions WHERE user_id = ?', [u.id]);
      await logEvent(ctx.db, { kind: 'staff_update', actor: actor(req), detail: { userId: u.id, fields: Object.keys(b).filter((k) => k !== 'password').concat(b.password ? ['password'] : []) } });
      return { ok: true };
    });

    // ------------------------------------------------------------ API keys (website admin panel, other systems)
    app.get('/api-keys', { preHandler: owner }, async () =>
      rows(
        ctx.db,
        `SELECT k.id, k.name, k.prefix, k.created_at createdAt, k.last_used_at lastUsedAt, k.last_used_ip lastUsedIp, k.revoked_at revokedAt, u.name createdBy
           FROM api_keys k JOIN staff_users u ON u.id = k.created_by ORDER BY k.revoked_at IS NOT NULL, k.id DESC`,
      ),
    );

    /** The key is returned once; only its hash is stored. */
    app.post('/api-keys', { preHandler: owner }, async (req) => {
      const { name } = z.object({ name: z.string().trim().min(2).max(100) }).parse(req.body);
      const k = newApiKey();
      const r = await exec(ctx.db, 'INSERT INTO api_keys (name, prefix, key_hash, created_by, created_at) VALUES (?,?,?,?,?)', [name, k.prefix, k.hash, req.staff!.id, new Date()]);
      await logEvent(ctx.db, { kind: 'api_key_create', actor: actor(req), detail: { id: r.insertId, name, prefix: k.prefix } });
      return { id: r.insertId, name, prefix: k.prefix, key: k.key };
    });

    app.delete<{ Params: { id: string } }>('/api-keys/:id', { preHandler: owner }, async (req) => {
      const k = await one<{ id: number; name: string }>(ctx.db, 'SELECT id, name FROM api_keys WHERE id = ? AND revoked_at IS NULL', [req.params.id]);
      if (!k) throw notFound('API key not found');
      await exec(ctx.db, 'UPDATE api_keys SET revoked_at = ? WHERE id = ?', [new Date(), k.id]);
      await logEvent(ctx.db, { kind: 'api_key_revoke', actor: actor(req), detail: { id: k.id, name: k.name } });
      return { ok: true };
    });
  };
}
