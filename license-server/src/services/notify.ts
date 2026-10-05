// Outgoing notifications: email (SMTP) and WhatsApp (Meta WhatsApp Cloud API
// template messages, or a generic webhook for Indian BSPs such as Gupshup,
// Interakt or AiSensy). Credentials are sealed in the settings table.
import nodemailer, { type Transporter } from 'nodemailer';
import { exec, json, one, type Db } from '../db.js';
import type { Vault } from '../crypto.js';

export interface SmtpSettings {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  password: string | null; // sealed
  from: string;
}

export interface WhatsAppSettings {
  provider: 'off' | 'meta' | 'webhook';
  meta?: { phoneNumberId: string; token: string | null /* sealed */; language: string; templates: { expiry: string; amc: string } };
  webhook?: { url: string; authHeader: string | null /* sealed */ };
}

export interface NotifySettings {
  /** Vayrone sales inbox: daily digest of reminders and upcoming expiries. */
  salesEmail: string | null;
  /** Days before expiry when clients are reminded (negative = after expiry, during grace). */
  expiryDays: number[];
  amcDays: number[];
  supportPhone: string;
}

export const NOTIFY_DEFAULTS: NotifySettings = { salesEmail: null, expiryDays: [30, 15, 7, 3, 1, 0, -7, -14], amcDays: [30, 7, 0], supportPhone: '' };

export async function getSetting<T>(db: Db, name: string, fallback: T): Promise<T> {
  const r = await one<{ value: unknown }>(db, 'SELECT value FROM settings WHERE name = ?', [name]);
  return r ? { ...fallback, ...json<T>(r.value) } : fallback;
}

export async function putSetting(db: Db, name: string, value: unknown): Promise<void> {
  await exec(db, 'INSERT INTO settings (name, value, updated_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_at = VALUES(updated_at)', [name, JSON.stringify(value), new Date()]);
}

/** Indian mobile numbers without a country code get +91. */
export function normalizePhone(p: string | null | undefined): string | null {
  const d = (p ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10) return `91${d}`;
  if (d.length >= 11 && d.length <= 15) return d;
  return null;
}

export interface WhatsAppMessage {
  to: string;
  template: 'expiry' | 'amc';
  params: string[];
  text: string;
}

export class Notifier {
  constructor(
    private readonly db: Db,
    private readonly vault: Vault,
    private readonly overrides: { mailer?: Transporter; fetch?: typeof fetch } = {},
  ) {}

  private async mailer(): Promise<{ t: Transporter; from: string } | null> {
    const s = await getSetting<SmtpSettings | null>(this.db, 'smtp', null);
    if (this.overrides.mailer) return { t: this.overrides.mailer, from: s?.from ?? 'Vayrone Licensing <licensing@vayrone.com>' };
    if (!s?.host) return null;
    const t = nodemailer.createTransport({ host: s.host, port: s.port, secure: s.secure, ...(s.user ? { auth: { user: s.user, pass: s.password ? this.vault.open(s.password) : '' } } : {}) });
    return { t, from: s.from };
  }

  async emailConfigured(): Promise<boolean> {
    return (await this.mailer()) !== null;
  }

  async sendEmail(m: { to: string; cc?: string | null; subject: string; text: string }): Promise<void> {
    const mail = await this.mailer();
    if (!mail) throw new Error('Email is not configured (Settings → Email)');
    await mail.t.sendMail({ from: mail.from, to: m.to, ...(m.cc ? { cc: m.cc } : {}), subject: m.subject, text: m.text });
  }

  async whatsappConfigured(): Promise<boolean> {
    return (await getSetting<WhatsAppSettings>(this.db, 'whatsapp', { provider: 'off' })).provider !== 'off';
  }

  async sendWhatsApp(m: WhatsAppMessage): Promise<void> {
    const s = await getSetting<WhatsAppSettings>(this.db, 'whatsapp', { provider: 'off' });
    const f = this.overrides.fetch ?? fetch;
    let res: Response;
    if (s.provider === 'meta' && s.meta) {
      res = await f(`https://graph.facebook.com/v21.0/${encodeURIComponent(s.meta.phoneNumberId)}/messages`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${s.meta.token ? this.vault.open(s.meta.token) : ''}` },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to: m.to,
          type: 'template',
          template: { name: s.meta.templates[m.template], language: { code: s.meta.language }, components: [{ type: 'body', parameters: m.params.map((text) => ({ type: 'text', text })) }] },
        }),
        signal: AbortSignal.timeout(20_000),
      });
    } else if (s.provider === 'webhook' && s.webhook) {
      res = await f(s.webhook.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(s.webhook.authHeader ? { authorization: this.vault.open(s.webhook.authHeader) } : {}) },
        body: JSON.stringify({ to: m.to, template: m.template, params: m.params, text: m.text }),
        signal: AbortSignal.timeout(20_000),
      });
    } else throw new Error('WhatsApp is not configured');
    if (!res.ok) throw new Error(`WhatsApp provider returned HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
}
