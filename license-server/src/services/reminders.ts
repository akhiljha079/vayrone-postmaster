// Daily expiry / AMC reminders to clients (email + WhatsApp), with the
// reseller in copy, and a digest to the Vayrone sales inbox. Each reminder is
// sent once (unique per licence, date, offset and channel).
import { exec, one, rows, type Db } from '../db.js';
import { getSetting, NOTIFY_DEFAULTS, normalizePhone, type Notifier, type NotifySettings } from './notify.js';

const DAY = 86_400_000;

interface Due {
  id: number;
  license_id: string;
  due: Date;
  company: string;
  contact_name: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  reseller_name: string | null;
  reseller_email: string | null;
  reseller_phone: string | null;
  max_users: number;
  plan: string;
}

/** Calendar date in the given time zone (YYYY-MM-DD). */
export function localDate(d: Date, tz: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

const human = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' });

export function reminderText(kind: 'expiry' | 'amc', d: Due, days: number, dueDate: string, support: string): { subject: string; text: string; params: string[] } {
  const who = d.contact_name ? `Dear ${d.contact_name},` : 'Dear Customer,';
  const contact = d.reseller_name ? `${d.reseller_name}${d.reseller_phone ? ` (${d.reseller_phone})` : ''}` : `Vayrone Infratech${support ? ` (${support})` : ''}`;
  const date = human(dueDate);
  let line: string;
  let subject: string;
  if (kind === 'amc') {
    subject = days > 0 ? `AMC for Vayrone PostMaster expires on ${date}` : `AMC for Vayrone PostMaster expired`;
    line =
      days > 0
        ? `the Annual Maintenance Contract (updates and support) for Vayrone PostMaster licence ${d.license_id} (${d.company}) expires on ${date}, in ${days} day(s).`
        : `the Annual Maintenance Contract (updates and support) for Vayrone PostMaster licence ${d.license_id} (${d.company}) expired on ${date}. Mail service is not affected, but updates and support need an active AMC.`;
  } else if (days > 0) {
    subject = `Vayrone PostMaster licence expires on ${date}`;
    line = `the Vayrone PostMaster licence ${d.license_id} for ${d.company} (${d.plan}, ${d.max_users} users) expires on ${date}, in ${days} day(s). Please renew to avoid interruption.`;
  } else if (days === 0) {
    subject = 'Vayrone PostMaster licence expires today';
    line = `the Vayrone PostMaster licence ${d.license_id} for ${d.company} expires today. Your server will enter a 15-day grace period; mail keeps flowing.`;
  } else {
    const ro = human(new Date(new Date(`${dueDate}T00:00:00Z`).getTime() + 15 * DAY).toISOString().slice(0, 10));
    subject = 'Vayrone PostMaster licence expired — grace period running';
    line = `the Vayrone PostMaster licence ${d.license_id} for ${d.company} expired on ${date}. The server is in its grace period; on ${ro} the admin panel becomes read-only (mail keeps flowing). Please renew now.`;
  }
  const text = `${who}\n\nThis is a reminder that ${line}\n\nTo renew, contact ${contact}.\n\n— Vayrone Infratech, Agra\nThis is an automated message.`;
  return { subject, text, params: [d.contact_name ?? d.company, d.license_id, date, String(Math.max(days, 0)), contact] };
}

export interface ReminderRun {
  sent: number;
  failed: number;
  skipped: number;
}

export async function runReminders(db: Db, notifier: Notifier, opts: { now?: Date; tz: string }): Promise<ReminderRun> {
  const now = opts.now ?? new Date();
  const s = await getSetting<NotifySettings>(db, 'notifications', NOTIFY_DEFAULTS);
  const today = localDate(now, opts.tz);
  const emailOn = await notifier.emailConfigured();
  const waOn = await notifier.whatsappConfigured();
  const out: ReminderRun = { sent: 0, failed: 0, skipped: 0 };
  const digest: string[] = [];

  for (const kind of ['expiry', 'amc'] as const) {
    const offsets = kind === 'expiry' ? s.expiryDays : s.amcDays;
    if (!offsets.length) continue;
    const col = kind === 'expiry' ? 'l.expires_at' : 'l.amc_expires_at';
    const from = new Date(now.getTime() + (Math.min(...offsets) - 2) * DAY);
    const to = new Date(now.getTime() + (Math.max(...offsets) + 2) * DAY);
    const list = await rows<Due>(
      db,
      `SELECT l.id, l.license_id, ${col} AS due, c.company, c.contact_name, c.email, c.phone, c.whatsapp, r.name AS reseller_name, r.email AS reseller_email,
              r.phone AS reseller_phone, l.max_users, p.name AS plan
         FROM licenses l JOIN clients c ON c.id = l.client_id JOIN plans p ON p.id = l.plan_id LEFT JOIN resellers r ON r.id = l.reseller_id
        WHERE l.status = 'active' AND ${col} IS NOT NULL AND ${col} BETWEEN ? AND ?`,
      [from, to],
    );
    for (const d of list) {
      const dueDate = localDate(new Date(d.due), opts.tz);
      const days = Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY);
      if (!offsets.includes(days)) continue;
      const msg = reminderText(kind, d, days, dueDate, s.supportPhone);
      const channels: { channel: 'email' | 'whatsapp'; to: string | null; on: boolean }[] = [
        { channel: 'email', to: d.email, on: emailOn },
        { channel: 'whatsapp', to: normalizePhone(d.whatsapp ?? d.phone), on: waOn },
      ];
      for (const ch of channels) {
        const exists = await one(db, 'SELECT id FROM reminders WHERE license_id = ? AND kind = ? AND due_date = ? AND days_before = ? AND channel = ?', [d.id, kind, dueDate, days, ch.channel]);
        if (exists) continue;
        let status: 'sent' | 'failed' | 'skipped' = 'skipped';
        let error: string | null = null;
        if (!ch.on) error = `${ch.channel} not configured`;
        else if (!ch.to) error = `client has no ${ch.channel === 'email' ? 'email address' : 'mobile number'}`;
        else {
          try {
            if (ch.channel === 'email') await notifier.sendEmail({ to: ch.to, cc: d.reseller_email, subject: msg.subject, text: msg.text });
            else await notifier.sendWhatsApp({ to: ch.to, template: kind, params: msg.params, text: msg.text });
            status = 'sent';
          } catch (e) {
            status = 'failed';
            error = (e as Error).message.slice(0, 500);
          }
        }
        out[status]++;
        await exec(db, 'INSERT IGNORE INTO reminders (license_id, kind, due_date, days_before, channel, recipient, status, error, sent_at) VALUES (?,?,?,?,?,?,?,?,?)', [
          d.id,
          kind,
          dueDate,
          days,
          ch.channel,
          ch.to,
          status,
          error,
          now,
        ]);
        if (ch.channel === 'email') digest.push(`${d.license_id}  ${d.company.padEnd(30)} ${kind === 'amc' ? 'AMC' : 'licence'} ${days >= 0 ? `in ${days} day(s)` : `${-days} day(s) ago`} (${dueDate})  email:${status}`);
      }
    }
  }
  if (s.salesEmail && emailOn && digest.length) {
    await notifier.sendEmail({ to: s.salesEmail, subject: `Licence reminders ${today}: ${digest.length}`, text: `Reminders processed today:\n\n${digest.join('\n')}\n` }).catch(() => undefined);
  }
  return out;
}
