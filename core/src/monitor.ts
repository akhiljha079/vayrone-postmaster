// Monitoring: a health snapshot (Admin → Health, /metrics), threshold checks
// that raise and resolve admin alerts (worker, every 5 minutes), and alert
// e-mails to the configured addresses.
import { statfs } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { cpus, freemem, loadavg, totalmem, uptime as osUptime } from 'node:os';
import { join } from 'node:path';
import type { CoreContext } from './context.js';
import { exec, one, rows } from './db.js';
import { raiseAlert, resolveAlert, type AlertSeverity } from './alerts.js';
import { APP_VERSION } from './migrate.js';
import { readRuntimeOverrides } from './config.js';
import { splitAddress } from './directory.js';

export interface MonitorSettings {
  /** Who gets alert e-mails (local mailboxes or external addresses). */
  emails: string[];
  minSeverity: 'warning' | 'critical';
  diskWarnPct: number;
  diskCriticalPct: number;
  queueWarnMinutes: number;
  fetchFailHours: number;
  certWarnDays: number;
}

export const MONITOR_DEFAULTS: MonitorSettings = { emails: [], minSeverity: 'critical', diskWarnPct: 10, diskCriticalPct: 5, queueWarnMinutes: 30, fetchFailHours: 2, certWarnDays: 30 };

export async function monitorSettings(ctx: CoreContext): Promise<MonitorSettings> {
  return { ...MONITOR_DEFAULTS, ...(await ctx.settings.get<Partial<MonitorSettings>>('monitor', 'config', {})) };
}

export interface Health {
  version: string;
  hostname: string;
  checkedAt: string;
  process: { uptimeSec: number; rssBytes: number; heapUsedBytes: number; node: string };
  system: { uptimeSec: number; load1: number; cpus: number; memFreeBytes: number; memTotalBytes: number };
  db: { ok: boolean; latencyMs: number | null; sizeBytes: number | null; error: string | null };
  disk: { path: string; freeBytes: number; totalBytes: number; freePct: number } | null;
  store: { messages: number; bytes: number };
  users: { active: number; mailboxes: number };
  queue: { queued: number; deferred: number; held: number; oldestMinutes: number | null; failed24h: number; sent24h: number };
  fetch: { accounts: number; failing: number; authFailed: number; lastSuccessMinutes: number | null };
  backup: { lastOkAt: string | null; ageHours: number | null; schedules: number };
  tls: { validTo: string; daysLeft: number; selfSigned: boolean } | null;
  license: { mode: string };
  alerts: { critical: number; warning: number; info: number };
}

function certFile(ctx: CoreContext): string | null {
  const o = readRuntimeOverrides(ctx.config.dataPath);
  const f = o.tls?.certFile ?? ctx.config.tls.certFile ?? join(ctx.config.dataPath, 'certs', 'selfsigned.crt');
  return existsSync(f) ? f : null;
}

export async function collectHealth(ctx: CoreContext): Promise<Health> {
  const now = Date.now();
  const t0 = Date.now();
  let dbOk = true;
  let dbError: string | null = null;
  let latency: number | null = null;
  let size: number | null = null;
  try {
    await one(ctx.db, 'SELECT 1');
    latency = Date.now() - t0;
    size = Number((await one<{ s: number }>(ctx.db, 'SELECT COALESCE(SUM(data_length + index_length), 0) s FROM information_schema.TABLES WHERE table_schema = DATABASE()'))?.s ?? 0);
  } catch (e) {
    dbOk = false;
    dbError = (e as Error).message;
  }
  const fs = await statfs(ctx.config.dataPath).catch(() => null);
  const n = async (sql: string, p: unknown[] = []) => (dbOk ? Number((await one<{ n: number | null }>(ctx.db, sql, p).catch(() => undefined))?.n ?? 0) : 0);
  const day = new Date(now - 86_400_000);
  const queue = dbOk ? await rows<{ status: string; n: number }>(ctx.db, "SELECT status, COUNT(*) n FROM outbound_queue WHERE status IN ('queued','deferred','held') GROUP BY status") : [];
  const oldest = dbOk ? await one<{ t: Date | null }>(ctx.db, "SELECT MIN(created_at) t FROM outbound_queue WHERE status IN ('queued','deferred','sending')") : undefined;
  const lastFetch = dbOk ? await one<{ t: Date | null }>(ctx.db, 'SELECT MAX(last_success_at) t FROM external_accounts WHERE is_enabled = 1') : undefined;
  const lastBackup = dbOk ? await one<{ t: Date | null }>(ctx.db, "SELECT MAX(finished_at) t FROM backup_runs WHERE status IN ('ok','verified') AND kind <> 'pre_update'") : undefined;
  const alerts = dbOk ? await rows<{ severity: string; n: number }>(ctx.db, 'SELECT severity, COUNT(*) n FROM admin_alerts WHERE resolved_at IS NULL GROUP BY severity') : [];
  let tls: Health['tls'] = null;
  const cf = certFile(ctx);
  if (cf) {
    try {
      const x = new X509Certificate(readFileSync(cf));
      tls = { validTo: new Date(x.validTo).toISOString(), daysLeft: Math.floor((new Date(x.validTo).getTime() - now) / 86_400_000), selfSigned: x.subject === x.issuer };
    } catch {
      tls = null;
    }
  }
  const mem = process.memoryUsage();
  const minutes = (d: Date | null | undefined) => (d ? Math.round((now - new Date(d).getTime()) / 60_000) : null);
  return {
    version: APP_VERSION,
    hostname: ctx.config.hostname,
    checkedAt: new Date(now).toISOString(),
    process: { uptimeSec: Math.round(process.uptime()), rssBytes: mem.rss, heapUsedBytes: mem.heapUsed, node: process.version },
    system: { uptimeSec: Math.round(osUptime()), load1: loadavg()[0] ?? 0, cpus: cpus().length, memFreeBytes: freemem(), memTotalBytes: totalmem() },
    db: { ok: dbOk, latencyMs: latency, sizeBytes: size, error: dbError },
    disk: fs ? { path: ctx.config.dataPath, freeBytes: Number(fs.bavail) * Number(fs.bsize), totalBytes: Number(fs.blocks) * Number(fs.bsize), freePct: Math.round((Number(fs.bavail) / Math.max(1, Number(fs.blocks))) * 1000) / 10 } : null,
    store: { messages: await n('SELECT COUNT(*) n FROM messages'), bytes: await n('SELECT COALESCE(SUM(size_stored), 0) n FROM messages') },
    users: { active: await n("SELECT COUNT(*) n FROM users WHERE is_enabled = 1 AND role <> 'vayrone_support'"), mailboxes: await n('SELECT COUNT(*) n FROM users WHERE is_enabled = 1 AND has_mailbox = 1') },
    queue: {
      queued: Number(queue.find((q) => q.status === 'queued')?.n ?? 0),
      deferred: Number(queue.find((q) => q.status === 'deferred')?.n ?? 0),
      held: Number(queue.find((q) => q.status === 'held')?.n ?? 0),
      oldestMinutes: minutes(oldest?.t),
      failed24h: await n("SELECT COUNT(*) n FROM outbound_queue WHERE status = 'failed' AND updated_at > ?", [day]),
      sent24h: await n("SELECT COUNT(*) n FROM outbound_queue WHERE status = 'sent' AND updated_at > ?", [day]),
    },
    fetch: {
      accounts: await n('SELECT COUNT(*) n FROM external_accounts WHERE is_enabled = 1'),
      failing: await n("SELECT COUNT(*) n FROM external_accounts WHERE is_enabled = 1 AND status IN ('error','backoff','auth_failed','quota_full')"),
      authFailed: await n("SELECT COUNT(*) n FROM external_accounts WHERE is_enabled = 1 AND status = 'auth_failed'"),
      lastSuccessMinutes: minutes(lastFetch?.t),
    },
    backup: { lastOkAt: lastBackup?.t ? new Date(lastBackup.t).toISOString() : null, ageHours: lastBackup?.t ? Math.round((now - new Date(lastBackup.t).getTime()) / 3600_000) : null, schedules: await n('SELECT COUNT(*) n FROM backup_schedules WHERE is_enabled = 1') },
    tls,
    license: { mode: ctx.license.mode() },
    alerts: { critical: Number(alerts.find((a) => a.severity === 'critical')?.n ?? 0), warning: Number(alerts.find((a) => a.severity === 'warning')?.n ?? 0), info: Number(alerts.find((a) => a.severity === 'info')?.n ?? 0) },
  };
}

async function setAlert(ctx: CoreContext, key: string, on: boolean, a: { severity: AlertSeverity; code: string; message: string }): Promise<void> {
  if (on) await raiseAlert(ctx.db, { ...a, dedupeKey: key });
  else await resolveAlert(ctx.db, key);
}

/** Threshold checks; returns the health snapshot they were based on. */
export async function runMonitorChecks(ctx: CoreContext): Promise<Health> {
  const s = await monitorSettings(ctx);
  const h = await collectHealth(ctx);
  if (!h.db.ok) return h; // nothing can be recorded; the services log the database error
  const gb = (b: number) => `${(b / 1073741824).toFixed(1)} GB`;
  if (h.disk) {
    const critical = h.disk.freePct < s.diskCriticalPct || h.disk.freeBytes < 2 * 1073741824;
    const warning = !critical && h.disk.freePct < s.diskWarnPct;
    await setAlert(ctx, 'disk.low', critical || warning, {
      severity: critical ? 'critical' : 'warning',
      code: 'disk.low',
      message: `Only ${gb(h.disk.freeBytes)} (${h.disk.freePct}%) free on the mail data disk (${h.disk.path}). Free space or move old mail to the archive.`,
    });
  }
  const qm = h.queue.oldestMinutes ?? 0;
  await setAlert(ctx, 'queue.stuck', qm > s.queueWarnMinutes, {
    severity: qm > 240 ? 'critical' : 'warning',
    code: 'queue.stuck',
    message: `Outgoing mail has been waiting for ${qm} minutes (${h.queue.queued + h.queue.deferred} messages). Check the relay account and the internet connection.`,
  });
  const failing = await rows<{ label: string | null; username: string; last_success_at: Date | null; status: string }>(
    ctx.db,
    `SELECT label, username, last_success_at, status FROM external_accounts
      WHERE is_enabled = 1 AND status IN ('error','backoff','auth_failed','quota_full') AND (last_success_at IS NULL OR last_success_at < ?)`,
    [new Date(Date.now() - s.fetchFailHours * 3600_000)],
  );
  await setAlert(ctx, 'fetch.failing', failing.length > 0, {
    severity: failing.some((f) => f.status === 'auth_failed') ? 'critical' : 'warning',
    code: 'fetch.failing',
    message: `${failing.length} external mailbox${failing.length === 1 ? ' has' : 'es have'} not been fetched for over ${s.fetchFailHours} h: ${failing
      .slice(0, 5)
      .map((f) => `${f.label ?? f.username} (${f.status.replace('_', ' ')})`)
      .join(', ')}${failing.length > 5 ? ', …' : ''}.`,
  });
  if (h.tls) {
    await setAlert(ctx, 'tls.expiring', h.tls.daysLeft < s.certWarnDays, {
      severity: h.tls.daysLeft < 7 ? 'critical' : 'warning',
      code: 'tls.expiring',
      message: h.tls.daysLeft < 0 ? `The TLS certificate expired on ${h.tls.validTo.slice(0, 10)}. Mail clients will refuse to connect.` : `The TLS certificate expires on ${h.tls.validTo.slice(0, 10)} (${h.tls.daysLeft} days).`,
    });
  }
  return h;
}

/** E-mails open alerts that were not e-mailed yet (or re-occurred a day later). */
export async function notifyAlerts(ctx: CoreContext): Promise<number> {
  const s = await monitorSettings(ctx);
  if (!s.emails.length) return 0;
  const sev = s.minSeverity === 'critical' ? ['critical'] : ['critical', 'warning'];
  const open = await rows<{ id: number; severity: string; message: string; first_at: Date; occurrences: number }>(
    ctx.db,
    `SELECT id, severity, message, first_at, occurrences FROM admin_alerts
      WHERE resolved_at IS NULL AND acknowledged_at IS NULL AND severity IN (?) AND (notified_at IS NULL OR notified_at < ?)
      ORDER BY FIELD(severity, 'critical', 'warning'), id`,
    [sev, new Date(Date.now() - 86_400_000)],
  );
  if (!open.length) return 0;
  const from = `postmaster@${ctx.config.hostname}`;
  const lines = open.map((a) => `[${a.severity.toUpperCase()}] ${a.message}`);
  const text = [
    `Vayrone PostMaster on ${ctx.config.hostname} needs attention:`,
    '',
    ...lines,
    '',
    `Open the admin panel (Dashboard → Alerts) to see details and acknowledge them.`,
    `You receive this because your address is listed under Admin → Health → Alert e-mails.`,
  ].join('\r\n');
  const date = new Date().toUTCString();
  const subject = `[PostMaster ${ctx.config.hostname}] ${open.length} alert${open.length === 1 ? '' : 's'}: ${open[0]!.message.slice(0, 80)}`;
  const raw = Buffer.from(
    [`From: Vayrone PostMaster <${from}>`, `To: ${s.emails.join(', ')}`, `Subject: ${subject.replace(/[\r\n]/g, ' ')}`, `Date: ${date}`, `Message-ID: <alert-${Date.now()}@${ctx.config.hostname}>`, 'Auto-Submitted: auto-generated', 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit', '', text, ''].join('\r\n'),
  );
  const message = await ctx.store.ingest(raw);
  const local: number[] = [];
  const external: string[] = [];
  for (const e of s.emails) {
    const r = await ctx.directory.resolve(e);
    if (r.kind === 'local' && r.userIds.length) local.push(...r.userIds);
    else if (splitAddress(e)) external.push(e);
  }
  if (local.length) await ctx.delivery.deliver({ message, targets: [...new Set(local)].map((userId) => ({ userId })), origin: 'internal', envelopeFrom: '', dedup: false, ignoreQuota: true });
  if (external.length) await ctx.delivery.enqueueOutbound({ message, envelopeFrom: from, recipients: external, senderUserId: null, source: 'system' });
  await exec(ctx.db, 'UPDATE admin_alerts SET notified_at = ? WHERE id IN (?)', [new Date(), open.map((a) => a.id)]);
  return open.length;
}

/** Prometheus text exposition. */
export function metricsText(h: Health): string {
  const out: string[] = [];
  const g = (name: string, help: string, v: number | null | undefined, labels = '') => {
    if (v === null || v === undefined || Number.isNaN(v)) return;
    out.push(`# HELP vpm_${name} ${help}`, `# TYPE vpm_${name} gauge`, `vpm_${name}${labels} ${v}`);
  };
  g('info', 'Build information', 1, `{version="${h.version}",hostname="${h.hostname}"}`);
  g('db_up', 'Database reachable', h.db.ok ? 1 : 0);
  g('db_latency_ms', 'Database round trip', h.db.latencyMs);
  g('db_size_bytes', 'Database size', h.db.sizeBytes);
  g('disk_free_bytes', 'Free bytes on the data disk', h.disk?.freeBytes);
  g('disk_total_bytes', 'Size of the data disk', h.disk?.totalBytes);
  g('store_messages', 'Stored messages', h.store.messages);
  g('store_bytes', 'Stored message bytes', h.store.bytes);
  g('users_active', 'Enabled users', h.users.active);
  g('queue_queued', 'Outgoing messages queued', h.queue.queued);
  g('queue_deferred', 'Outgoing messages deferred', h.queue.deferred);
  g('queue_held', 'Outgoing messages held', h.queue.held);
  g('queue_oldest_minutes', 'Age of the oldest waiting outgoing message', h.queue.oldestMinutes ?? 0);
  g('queue_failed_24h', 'Outgoing messages failed in 24 h', h.queue.failed24h);
  g('queue_sent_24h', 'Outgoing messages sent in 24 h', h.queue.sent24h);
  g('fetch_accounts', 'Enabled external mailboxes', h.fetch.accounts);
  g('fetch_failing', 'External mailboxes in error', h.fetch.failing);
  g('backup_age_hours', 'Hours since the last good backup', h.backup.ageHours);
  g('tls_days_left', 'Days until the TLS certificate expires', h.tls?.daysLeft);
  g('alerts_open', 'Open admin alerts', h.alerts.critical, '{severity="critical"}');
  out.push(`vpm_alerts_open{severity="warning"} ${h.alerts.warning}`);
  g('process_rss_bytes', 'Resident memory of this process', h.process.rssBytes);
  g('license_active', 'Licence allows normal operation', h.license.mode === 'active' ? 1 : 0);
  return `${out.join('\n')}\n`;
}

/**
 * Short health report a client server sends to the Vayrone License Server (hourly, and with the
 * daily licence check-in), so Vayrone sees every client's server on one screen. Plain-language
 * issues, worst first; no mail content, addresses or names.
 */
export interface HealthReport {
  at: string;
  status: 'ok' | 'warning' | 'problem';
  issues: { level: 'problem' | 'warning'; text: string }[];
  version: string;
  uptimeHours: number;
  diskFreePct: number | null;
  diskFreeGb: number | null;
  dbOk: boolean;
  mailboxes: number;
  queue: { waiting: number; oldestMinutes: number | null; failed24h: number; sent24h: number };
  fetch: { accounts: number; failing: number; authFailed: number };
  backup: { lastOkAt: string | null; ageHours: number | null; scheduled: boolean };
  certDaysLeft: number | null;
  alerts: { critical: number; warning: number };
  licenseMode: string;
}

export function healthReport(h: Health, s: MonitorSettings = MONITOR_DEFAULTS): HealthReport {
  const issues: HealthReport['issues'] = [];
  const problem = (text: string) => issues.push({ level: 'problem', text });
  const warning = (text: string) => issues.push({ level: 'warning', text });
  const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

  if (!h.db.ok) problem('Database not reachable');
  if (h.disk) {
    if (h.disk.freePct < s.diskCriticalPct) problem(`Disk almost full: ${h.disk.freePct}% free`);
    else if (h.disk.freePct < s.diskWarnPct) warning(`Disk getting full: ${h.disk.freePct}% free`);
  }
  if (h.fetch.authFailed) problem(`${plural(h.fetch.authFailed, 'external mailbox', 'external mailboxes')}: wrong provider password`);
  if (h.fetch.failing - h.fetch.authFailed > 0) warning(`${plural(h.fetch.failing - h.fetch.authFailed, 'external mailbox', 'external mailboxes')} failing to fetch`);
  const waiting = h.queue.queued + h.queue.deferred;
  if (h.queue.oldestMinutes != null && h.queue.oldestMinutes > s.queueWarnMinutes) warning(`${plural(waiting, 'outgoing mail')} waiting, oldest ${Math.round(h.queue.oldestMinutes)} min`);
  if (h.queue.held) warning(`${plural(h.queue.held, 'outgoing mail')} on hold`);
  if (!h.backup.schedules) warning('No backup schedule');
  else if (h.backup.ageHours == null) problem('No successful backup yet');
  else if (h.backup.ageHours > 36) problem(`Last good backup ${Math.round(h.backup.ageHours / 24)} day(s) ago`);
  if (h.tls) {
    if (h.tls.daysLeft < 0) problem('Server certificate expired');
    else if (h.tls.daysLeft < s.certWarnDays) warning(`Server certificate expires in ${h.tls.daysLeft} days`);
  }
  if (h.license.mode === 'readonly') problem('Licence expired: admin panel is read-only');
  else if (h.license.mode === 'grace') warning('Licence in grace period');
  if (h.alerts.critical) problem(`${plural(h.alerts.critical, 'critical alert')} open`);
  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'problem' ? -1 : 1));

  return {
    at: h.checkedAt,
    status: issues.some((i) => i.level === 'problem') ? 'problem' : issues.length ? 'warning' : 'ok',
    issues: issues.slice(0, 20),
    version: h.version,
    uptimeHours: Math.round(h.system.uptimeSec / 360) / 10,
    diskFreePct: h.disk?.freePct ?? null,
    diskFreeGb: h.disk ? Math.round(h.disk.freeBytes / 1024 ** 3) : null,
    dbOk: h.db.ok,
    mailboxes: h.users.mailboxes,
    queue: { waiting, oldestMinutes: h.queue.oldestMinutes, failed24h: h.queue.failed24h, sent24h: h.queue.sent24h },
    fetch: { accounts: h.fetch.accounts, failing: h.fetch.failing, authFailed: h.fetch.authFailed },
    backup: { lastOkAt: h.backup.lastOkAt, ageHours: h.backup.ageHours, scheduled: h.backup.schedules > 0 },
    certDaysLeft: h.tls?.daysLeft ?? null,
    alerts: { critical: h.alerts.critical, warning: h.alerts.warning },
    licenseMode: h.license.mode,
  };
}
