// First-run setup wizard API (/api/setup). Open until the wizard is completed;
// until then every call needs the setup token printed by the installer
// (header x-vpm-setup), unless it comes from the server itself. Afterwards
// everything except /status answers 410 and the normal admin panel applies.
//
//   1 licence   2 company   3 domains   4 super admin   5 relay
//   6 network   7 storage   8 summary → complete (restart if ports/TLS changed)
import { statfs } from 'node:fs/promises';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  APP_VERSION,
  ARCHIVE_DEFAULTS,
  checkTarget,
  createTransport,
  db as dbm,
  readRuntimeOverrides,
  relayTargetFromRow,
  removeSetupToken,
  requestRestart,
  setupTokenMatches,
  splitAddress,
  type ArchivePolicy,
  type BackupTargetRow,
  type CoreContext,
} from '@vpm/core';
import { LicenseActionError, type LicenseManager } from '@vpm/license-client';
import { HttpError, badRequest } from '../http.js';
import { saveLogo } from '../branding.js';
import { applyNetwork, NetworkBody, networkState } from '../network.js';
import { PasswordSchema } from './auth.js';
import { CompanySchema, upsertCompany } from './admin/system.js';

const { exec, json, one, rows, tx } = dbm;

export const SETUP_HEADER = 'x-vpm-setup';
export const STEPS = ['license', 'company', 'domains', 'admin', 'relay', 'network', 'storage'] as const;
type Step = (typeof STEPS)[number];

interface Progress {
  steps: Step[];
  adminUserId?: number;
  restartNeeded?: boolean;
}

const DomainName = z.string().trim().toLowerCase().max(253).regex(/^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, 'Invalid domain name');
const Email = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address');

const isLoopback = (ip: string) => ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';

export async function setupDone(ctx: CoreContext): Promise<boolean> {
  return Boolean((await one<{ completed_at: Date | null }>(ctx.db, 'SELECT completed_at FROM setup_state WHERE id = 1'))?.completed_at);
}

export function setupRoutes(ctx: CoreContext, license: LicenseManager | null) {
  const progress = async (): Promise<Progress> => {
    const r = await one<{ completed_steps: unknown }>(ctx.db, 'SELECT completed_steps FROM setup_state WHERE id = 1');
    const p = r ? json<Progress | Step[]>(r.completed_steps) : null;
    return Array.isArray(p) ? { steps: p } : (p ?? { steps: [] });
  };
  const save = async (p: Progress, step?: Step) => {
    if (step && !p.steps.includes(step)) p.steps.push(step);
    const cur = Math.min(STEPS.length + 1, STEPS.findIndex((s) => !p.steps.includes(s)) + 1 || STEPS.length + 1);
    await exec(
      ctx.db,
      `INSERT INTO setup_state (id, current_step, completed_steps) VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE current_step = VALUES(current_step), completed_steps = VALUES(completed_steps)`,
      [cur, JSON.stringify(p)],
    );
  };
  const mark = async (step: Step, patch: Partial<Progress> = {}) => save({ ...(await progress()), ...patch }, step);

  const guard = async (req: FastifyRequest) => {
    if (await setupDone(ctx)) throw new HttpError(410, 'SETUP_DONE', 'Setup is already complete. Sign in to the admin panel.');
    const token = req.headers[SETUP_HEADER];
    if (!isLoopback(req.ip) && !setupTokenMatches(ctx.config.dataPath, typeof token === 'string' ? token : undefined)) {
      throw new HttpError(401, 'SETUP_TOKEN', 'Enter the setup token shown by the installer (or run: vpm setup-token on the server).');
    }
  };
  const actionError = (e: unknown): never => {
    if (e instanceof LicenseActionError) throw new HttpError(e.code === 'NETWORK' ? 502 : 400, e.code === 'NETWORK' ? 'LICENSE_SERVER_UNREACHABLE' : e.code, e.message);
    throw e;
  };
  const audit = (req: FastifyRequest, action: string, details?: Record<string, unknown>) =>
    ctx.audit.log({ actorUserId: null, actorLogin: 'setup-wizard', actorRole: null, isSupport: false, ip: req.ip, action, targetType: 'setup', targetId: null, details: details ?? null });

  return async (app: FastifyInstance) => {
    app.get('/status', async (req) => {
      const done = await setupDone(ctx);
      return { required: !done, needsToken: !done && !isLoopback(req.ip), version: APP_VERSION, hostname: ctx.config.hostname };
    });

    app.post('/verify', { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } }, async (req) => {
      await guard(req);
      return { ok: true };
    });

    // Every value the wizard pre-fills.
    app.get('/state', { preHandler: guard }, async () => {
      const p = await progress();
      const company = await one(ctx.db, 'SELECT company_name AS companyName, address, gstin, contact_person AS contactPerson, phone, email, logo_path AS logoPath FROM company_profile WHERE id = 1');
      const relay = await one<Record<string, unknown>>(
        ctx.db,
        'SELECT id, host, port, security, auth_user AS authUser, (auth_secret IS NOT NULL) AS passwordSet, last_test_result AS lastTestResult FROM relay_accounts WHERE is_default = 1 LIMIT 1',
      );
      const admin = p.adminUserId ? await one(ctx.db, 'SELECT id, login, display_name AS displayName, has_mailbox AS hasMailbox FROM users WHERE id = ?', [p.adminUserId]) : null;
      const target = await one<BackupTargetRow>(ctx.db, "SELECT * FROM backup_targets WHERE name = 'Setup: nightly backup' LIMIT 1");
      const fs = await statfs(ctx.config.dataPath).catch(() => null);
      const policy = { ...ARCHIVE_DEFAULTS, ...(await ctx.settings.get<Partial<ArchivePolicy>>('archive', 'policy', {})) };
      const trash = await one<{ keep_days: number }>(ctx.db, "SELECT keep_days FROM retention_policies WHERE target = 'mailbox_folder' AND special_use = 'trash' AND scope = 'all' LIMIT 1");
      return {
        steps: p.steps,
        restartNeeded: Boolean(p.restartNeeded),
        license: license ? await license.info() : null,
        company: company ?? null,
        domains: (await rows<{ name: string }>(ctx.db, 'SELECT name FROM domains ORDER BY name')).map((d) => d.name),
        admin,
        relay: relay ?? null,
        network: networkState(ctx),
        storage: {
          dataPath: ctx.config.dataPath,
          freeBytes: fs ? Number(fs.bavail) * Number(fs.bsize) : null,
          totalBytes: fs ? Number(fs.blocks) * Number(fs.bsize) : null,
          backupPath: target ? (json<{ path?: string }>(target.config).path ?? null) : null,
          archiveEnabled: policy.enabled,
          archiveDays: policy.retentionDays,
          archiveLicensed: ctx.license.feature('archive'),
          trashDays: trash?.keep_days ?? null,
        },
      };
    });

    // ---------------------------------------------------------- 1. licence
    const needLicense = () => {
      if (!license) throw new HttpError(409, 'LICENSE_UNMANAGED', 'Licensing is not active in this process');
      return license;
    };
    app.post('/license/activate', { preHandler: guard, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
      const { key } = z.object({ key: z.string().trim().min(10).max(60) }).parse(req.body);
      try {
        await needLicense().activateOnline(key);
      } catch (e) {
        actionError(e);
      }
      await mark('license');
      await audit(req, 'setup.license_activate');
      return needLicense().info();
    });
    app.post('/license/offline-request', { preHandler: guard }, async (req) => {
      const { key } = z.object({ key: z.string().trim().max(60).nullish() }).parse(req.body ?? {});
      try {
        return await needLicense().offlineRequest(key || null);
      } catch (e) {
        return actionError(e);
      }
    });
    app.post('/license/import', { preHandler: guard }, async (req) => {
      const { text } = z.object({ text: z.string().min(50).max(200_000) }).parse(req.body);
      try {
        await needLicense().importFile(text);
      } catch (e) {
        actionError(e);
      }
      await mark('license');
      await audit(req, 'setup.license_import');
      return needLicense().info();
    });
    app.post('/license/evaluate', { preHandler: guard }, async (req) => {
      await mark('license');
      await audit(req, 'setup.license_evaluation');
      return { ok: true };
    });

    // ---------------------------------------------------------- 2. company
    app.put('/company', { preHandler: guard, bodyLimit: 1024 * 1024 }, async (req) => {
      const b = CompanySchema.extend({ logo: z.string().max(800_000).nullish() }).parse(req.body);
      const { logo, ...company } = b;
      await upsertCompany(ctx, company);
      if (logo !== undefined) await saveLogo(ctx, logo);
      await mark('company');
      await audit(req, 'setup.company', { companyName: company.companyName });
      return { ok: true };
    });

    // ---------------------------------------------------------- 3. domains
    app.put('/domains', { preHandler: guard }, async (req) => {
      const { domains } = z.object({ domains: z.array(DomainName).min(1).max(50) }).parse(req.body);
      const existing = new Set((await rows<{ name: string }>(ctx.db, 'SELECT name FROM domains')).map((d) => d.name));
      for (const d of new Set(domains)) if (!existing.has(d)) await ctx.directory.createDomain(d);
      await mark('domains');
      await audit(req, 'setup.domains', { domains });
      return { domains: (await rows<{ name: string }>(ctx.db, 'SELECT name FROM domains ORDER BY name')).map((d) => d.name) };
    });

    // ---------------------------------------------------------- 4. super admin
    app.put('/admin', { preHandler: guard }, async (req) => {
      const b = z
        .object({ login: z.string().trim().toLowerCase().min(3).max(254), displayName: z.string().trim().min(1).max(120), password: PasswordSchema, mailbox: z.boolean().default(false) })
        .parse(req.body);
      const p = await progress();
      const existing = p.adminUserId ? await one<{ id: number; login: string }>(ctx.db, 'SELECT id, login FROM users WHERE id = ?', [p.adminUserId]) : undefined;
      let id: number;
      if (existing && existing.login === b.login) {
        id = existing.id;
        await ctx.directory.setPassword(id, b.password);
        await exec(ctx.db, 'UPDATE users SET display_name = ? WHERE id = ?', [b.displayName, id]);
      } else {
        if (existing) {
          // A different login was chosen before setup finished: remove the first one (or disable it if it already has mail).
          await exec(ctx.db, 'DELETE FROM users WHERE id = ?', [existing.id]).catch(() => exec(ctx.db, "UPDATE users SET is_enabled = 0, role = 'user' WHERE id = ?", [existing.id]));
        }
        if (b.mailbox) {
          const parts = splitAddress(b.login);
          if (!parts) throw badRequest('A mailbox login must be an email address');
          if (!(await one(ctx.db, 'SELECT id FROM domains WHERE name = ?', [parts.domain]))) throw badRequest(`Add the domain ${parts.domain} first`);
          id = await ctx.directory.createUser({ email: b.login, password: b.password, displayName: b.displayName, role: 'super_admin' });
        } else {
          if (!/^[a-z0-9._@-]+$/.test(b.login)) throw badRequest('Use letters, digits, dot, dash or @ in the login');
          id = await ctx.directory.createStaffUser({ login: b.login, password: b.password, displayName: b.displayName, role: 'super_admin' });
        }
      }
      await mark('admin', { adminUserId: id });
      await audit(req, 'setup.admin', { login: b.login, mailbox: b.mailbox });
      return { id, login: b.login };
    });

    // ---------------------------------------------------------- 5. relay
    const RelayBody = z.object({
      host: z.string().trim().min(1).max(253),
      port: z.number().int().min(1).max(65535),
      security: z.enum(['none', 'starttls', 'tls']),
      authUser: z.string().trim().max(254).nullish(),
      password: z.string().max(500).nullish(),
      tlsVerify: z.boolean().default(true),
    });
    app.put('/relay', { preHandler: guard }, async (req) => {
      const b = RelayBody.parse(req.body);
      const now = new Date();
      await tx(ctx.db, async (c) => {
        const cur = await one<{ id: number }>(c, 'SELECT id FROM relay_accounts WHERE is_default = 1 LIMIT 1');
        if (cur) {
          await exec(c, 'UPDATE relay_accounts SET host = ?, port = ?, security = ?, auth_user = ?, tls_verify = ?, updated_at = ? WHERE id = ?', [
            b.host,
            b.port,
            b.security,
            b.authUser || null,
            b.tlsVerify ? 1 : 0,
            now,
            cur.id,
          ]);
          if (b.password) await exec(c, 'UPDATE relay_accounts SET auth_secret = ? WHERE id = ?', [ctx.secrets.seal(b.password), cur.id]);
        } else {
          await exec(
            c,
            `INSERT INTO relay_accounts (name, host, port, security, auth_user, auth_secret, envelope_from, set_sender_header, max_connections, tls_verify, is_default, is_enabled, created_at, updated_at)
             VALUES ('Main relay', ?, ?, ?, ?, ?, 'relay_account', 1, 2, ?, 1, 1, ?, ?)`,
            [b.host, b.port, b.security, b.authUser || null, b.password ? ctx.secrets.seal(b.password) : null, b.tlsVerify ? 1 : 0, now, now],
          );
        }
      });
      await mark('relay');
      await audit(req, 'setup.relay', { host: b.host, port: b.port, authUser: b.authUser ?? null, password: b.password ? 'set' : undefined });
      return { ok: true };
    });

    app.post('/relay/test', { preHandler: guard, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const { to } = z.object({ to: Email.optional() }).parse(req.body ?? {});
      const row = await one(ctx.db, 'SELECT * FROM relay_accounts WHERE is_default = 1 LIMIT 1');
      if (!row) throw badRequest('Save the relay account first');
      const t = relayTargetFromRow(row as Parameters<typeof relayTargetFromRow>[0]);
      const transport = createTransport(t, ctx.secrets, { hostname: ctx.config.hostname });
      let result: { ok: boolean; message: string };
      try {
        await transport.verify();
        if (to) {
          if (!t.authUser) throw badRequest('The relay needs a username (its email address) to send a test');
          const info = await transport.sendMail({
            envelope: { from: t.authUser, to: [to] },
            from: t.authUser,
            to,
            subject: 'Vayrone PostMaster relay test',
            text: `This test message was sent by the Vayrone PostMaster setup wizard on ${ctx.config.hostname}.\r\n`,
          });
          result = { ok: true, message: `Test message accepted by the provider: ${info.response}` };
        } else result = { ok: true, message: 'Connected and signed in successfully' };
      } catch (err) {
        if (err instanceof HttpError) throw err;
        const e = err as Error & { response?: string };
        result = { ok: false, message: e.response ?? e.message };
      } finally {
        transport.close();
      }
      await exec(ctx.db, 'UPDATE relay_accounts SET last_test_at = ?, last_test_result = ? WHERE id = ?', [new Date(), result.message.slice(0, 500), (row as { id: number }).id]);
      return result;
    });

    // ---------------------------------------------------------- 6. network
    app.put('/network', { preHandler: guard, bodyLimit: 1024 * 1024 }, async (req) => {
      const b = NetworkBody.parse(req.body);
      const { restartNeeded } = await applyNetwork(ctx, b);
      const p = await progress();
      await mark('network', { restartNeeded: Boolean(p.restartNeeded) || restartNeeded });
      await audit(req, 'setup.network', { hostname: b.hostname, listenHost: b.listenHost, ports: b.ports, webPort: b.webPort, tls: b.tls.mode });
      return { ok: true, restartNeeded: Boolean(p.restartNeeded) || restartNeeded };
    });

    // ---------------------------------------------------------- 7. storage, backup, retention
    app.put('/storage', { preHandler: guard }, async (req) => {
      const b = z
        .object({
          backupPath: z.string().trim().max(500).nullable(),
          backupTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).default('01:00'),
          keepFull: z.number().int().min(1).max(52).default(4),
          archiveEnabled: z.boolean(),
          archiveDays: z.number().int().min(1).max(36500).nullable(),
          trashDays: z.number().int().min(1).max(3650).nullable(),
        })
        .parse(req.body);
      // Backup: weekly full on Sunday, incremental on the other nights.
      const name = 'Setup: nightly backup';
      const t = await one<BackupTargetRow>(ctx.db, 'SELECT * FROM backup_targets WHERE name = ?', [name]);
      if (b.backupPath) {
        let targetId = t?.id;
        if (targetId) await exec(ctx.db, 'UPDATE backup_targets SET config = ?, is_enabled = 1 WHERE id = ?', [JSON.stringify({ path: b.backupPath }), targetId]);
        else
          targetId = (await exec(ctx.db, "INSERT INTO backup_targets (name, kind, config, encrypt_backups, is_enabled, created_at) VALUES (?, 'local', ?, 0, 1, ?)", [name, JSON.stringify({ path: b.backupPath }), new Date()]))
            .insertId;
        const check = await checkTarget((await one<BackupTargetRow>(ctx.db, 'SELECT * FROM backup_targets WHERE id = ?', [targetId]))!);
        if (!check.ok) throw badRequest(`Backup folder: ${check.message}`);
        const [hh, mm] = b.backupTime.split(':').map(Number);
        await exec(ctx.db, 'DELETE FROM backup_schedules WHERE target_id = ?', [targetId]);
        for (const [kind, dow, label] of [
          ['full', '0', 'Weekly full backup'],
          ['incremental', '1-6', 'Nightly incremental backup'],
        ] as const) {
          await exec(ctx.db, 'INSERT INTO backup_schedules (name, target_id, kind, cron, keep_full, is_enabled, created_at) VALUES (?,?,?,?,?,1,?)', [label, targetId, kind, `${mm} ${hh} * * ${dow}`, b.keepFull, new Date()]);
        }
      } else if (t) {
        await exec(ctx.db, 'UPDATE backup_targets SET is_enabled = 0 WHERE id = ?', [t.id]);
        await exec(ctx.db, 'UPDATE backup_schedules SET is_enabled = 0 WHERE target_id = ?', [t.id]);
      }
      const policy = { ...ARCHIVE_DEFAULTS, ...(await ctx.settings.get<Partial<ArchivePolicy>>('archive', 'policy', {})), enabled: b.archiveEnabled, retentionDays: b.archiveDays };
      await ctx.settings.set('archive', 'policy', policy, null);
      for (const special of ['trash', 'junk'] as const) {
        await exec(ctx.db, "DELETE FROM retention_policies WHERE target = 'mailbox_folder' AND special_use = ? AND scope = 'all' AND name LIKE 'Setup:%'", [special]);
        if (b.trashDays) {
          await exec(ctx.db, "INSERT INTO retention_policies (name, target, scope, scope_id, special_use, keep_days, is_enabled, created_at) VALUES (?, 'mailbox_folder', 'all', NULL, ?, ?, 1, ?)", [
            `Setup: empty ${special === 'trash' ? 'Trash' : 'Junk'}`,
            special,
            b.trashDays,
            new Date(),
          ]);
        }
      }
      await mark('storage');
      await audit(req, 'setup.storage', b);
      return { ok: true };
    });

    // ---------------------------------------------------------- 8. complete
    app.post('/complete', { preHandler: guard }, async (req) => {
      const p = await progress();
      const missing: string[] = [];
      if (!(await one(ctx.db, 'SELECT id FROM company_profile WHERE id = 1'))) missing.push('company details');
      if (!(await one(ctx.db, 'SELECT id FROM domains LIMIT 1'))) missing.push('a mail domain');
      if (!p.adminUserId || !(await one(ctx.db, "SELECT id FROM users WHERE id = ? AND role = 'super_admin'", [p.adminUserId]))) missing.push('the super admin account');
      if (missing.length) throw badRequest(`Still needed: ${missing.join(', ')}`);
      await exec(ctx.db, 'UPDATE setup_state SET completed_at = ?, current_step = ? WHERE id = 1', [new Date(), STEPS.length + 1]);
      removeSetupToken(ctx.config.dataPath);
      await audit(req, 'setup.complete', { steps: p.steps, restart: Boolean(p.restartNeeded) });
      const o = readRuntimeOverrides(ctx.config.dataPath);
      const port = o.web?.port ?? ctx.config.web.port;
      const host = o.hostname ?? ctx.config.hostname;
      const scheme = ctx.config.web.tls ? 'https' : 'http';
      const url = `${scheme}://${host}${(scheme === 'https' && port === 443) || (scheme === 'http' && port === 80) ? '' : `:${port}`}/login`;
      if (p.restartNeeded) {
        // Give the browser the answer first; the services then restart with the new ports / certificate.
        setTimeout(() => void requestRestart(ctx.db, 'setup wizard: network settings').catch(() => undefined), 1500).unref();
      }
      return { ok: true, restart: Boolean(p.restartNeeded), url };
    });
  };
}
