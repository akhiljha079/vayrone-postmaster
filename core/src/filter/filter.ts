// Mail filtering: attachment blocking, antivirus (ClamAV), spam scoring.
// Called by MailFlow for every message once, before rules:
//   incoming (fetched)  → attachments, virus, spam
//   internal (LAN→LAN)  → attachments, virus
//   outgoing (LAN→out)  → attachments, virus (rejected at submission time)
// A filter outage never loses mail: if ClamAV or Rspamd cannot be reached,
// the message is delivered (or held, if so configured) and an alert is raised.
import type { Logger } from 'pino';
import type { Db } from '../db.js';
import { one, rows } from '../db.js';
import type { Settings } from '../settings.js';
import type { LicenseGate } from '../license-gate.js';
import type { StoredMessage } from '../store/mailstore.js';
import { raiseAlert, resolveAlert } from '../alerts.js';
import { headerValue } from '../mime/headers.js';
import { blockedAttachments, DEFAULT_BLOCKED_EXTENSIONS, listAttachments } from './attachments.js';
import { clamScan } from './clamav.js';
import { builtinScore, rspamdScore, type SpamResult } from './spam.js';

export type FilterDirection = 'in' | 'internal' | 'out';

export interface FilterSettings {
  spam: { engine: 'off' | 'builtin' | 'rspamd'; rspamdUrl: string; junkScore: number; quarantineScore: number | null };
  antivirus: { engine: 'off' | 'clamav'; host: string; port: number; socket: string | null; onError: 'deliver' | 'quarantine' };
  attachments: { enabled: boolean; blocked: string[]; scanZip: boolean; directions: FilterDirection[] };
  quarantineDays: number;
  notifyRecipients: boolean;
}

export const FILTER_DEFAULTS: FilterSettings = {
  spam: { engine: 'builtin', rspamdUrl: 'http://127.0.0.1:11333', junkScore: 6, quarantineScore: null },
  antivirus: { engine: 'off', host: '127.0.0.1', port: 3310, socket: null, onError: 'deliver' },
  attachments: { enabled: true, blocked: DEFAULT_BLOCKED_EXTENSIONS, scanZip: true, directions: ['in', 'internal', 'out'] },
  quarantineDays: 30,
  notifyRecipients: true,
};

export type Verdict =
  | { action: 'deliver'; spam: SpamResult | null }
  | { action: 'junk'; spam: SpamResult }
  | { action: 'quarantine' | 'reject'; kind: 'virus' | 'attachment' | 'spam'; reason: string; spam?: SpamResult | null };

const addressOf = (v: string | null | undefined) => (v ? (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase() : '');

export class MailFilter {
  constructor(
    private readonly db: Db,
    private readonly settings: Settings,
    private readonly license: LicenseGate,
    private readonly log: Pick<Logger, 'warn' | 'error'>,
  ) {}

  async config(): Promise<FilterSettings> {
    const s = await this.settings.get<Partial<FilterSettings>>('filter', 'config', {});
    return {
      ...FILTER_DEFAULTS,
      ...s,
      spam: { ...FILTER_DEFAULTS.spam, ...s.spam },
      antivirus: { ...FILTER_DEFAULTS.antivirus, ...s.antivirus },
      attachments: { ...FILTER_DEFAULTS.attachments, ...s.attachments },
    };
  }

  /** Sender list decision for a user (user entries win over server-wide ones; block wins over allow). */
  async senderDecision(userId: number | null, from: string): Promise<'allow' | 'block' | null> {
    const addr = from.toLowerCase();
    if (!addr) return null;
    const domain = addr.includes('@') ? `@${addr.split('@')[1]}` : null;
    const list = await rows<{ user_id: number | null; kind: 'allow' | 'block' }>(
      this.db,
      `SELECT user_id, kind FROM sender_lists WHERE pattern IN (?) AND (user_id IS NULL${userId ? ' OR user_id = ?' : ''})`,
      userId ? [[addr, domain ?? addr], userId] : [[addr, domain ?? addr]],
    );
    const pick = (l: typeof list) => (l.some((x) => x.kind === 'block') ? 'block' : l.some((x) => x.kind === 'allow') ? 'allow' : null);
    return pick(list.filter((x) => x.user_id !== null)) ?? pick(list.filter((x) => x.user_id === null));
  }

  async check(m: StoredMessage, o: { direction: FilterDirection; envelopeFrom: string }): Promise<Verdict> {
    const c = await this.config();

    // 1. Blocked attachment types.
    if (c.attachments.enabled && c.attachments.directions.includes(o.direction)) {
      const bad = blockedAttachments(listAttachments(m.raw, m.parsed.tree, { scanZip: c.attachments.scanZip }), c.attachments.blocked);
      if (bad.length) {
        return { action: o.direction === 'out' ? 'reject' : 'quarantine', kind: 'attachment', reason: `Blocked attachment type: ${bad.map((b) => b.display).slice(0, 5).join(', ')}` };
      }
    }

    // 2. Viruses (licence feature "antivirus").
    if (c.antivirus.engine === 'clamav' && this.license.feature('antivirus')) {
      try {
        const r = await clamScan(m.raw, { host: c.antivirus.host, port: c.antivirus.port, ...(c.antivirus.socket ? { socket: c.antivirus.socket } : {}) });
        await resolveAlert(this.db, 'filter.av_unavailable');
        if (!r.clean) return { action: o.direction === 'out' ? 'reject' : 'quarantine', kind: 'virus', reason: `Virus found: ${r.signature}` };
      } catch (e) {
        this.log.warn({ err: (e as Error).message }, 'antivirus scan failed');
        await raiseAlert(this.db, { severity: 'critical', code: 'filter.av_unavailable', message: `Virus scanning is not working: ${(e as Error).message}. Messages are ${c.antivirus.onError === 'deliver' ? 'delivered unscanned' : 'held in quarantine'}.`, dedupeKey: 'filter.av_unavailable' });
        if (c.antivirus.onError === 'quarantine' && o.direction !== 'out') return { action: 'quarantine', kind: 'virus', reason: 'Not scanned: the virus scanner was unavailable' };
      }
    }

    // 3. Spam (incoming only).
    if (o.direction !== 'in' || c.spam.engine === 'off') return { action: 'deliver', spam: null };
    const from = addressOf(headerValue(m.raw, 'from')) || o.envelopeFrom.toLowerCase();
    const global = await this.senderDecision(null, from);
    if (global === 'allow') return { action: 'deliver', spam: null };
    let spam: SpamResult;
    try {
      spam = c.spam.engine === 'rspamd' ? await rspamdScore(m.raw, c.spam.rspamdUrl, { from: o.envelopeFrom }) : builtinScore(m.raw, m.parsed);
      if (c.spam.engine === 'rspamd') await resolveAlert(this.db, 'filter.rspamd_unavailable');
    } catch (e) {
      await raiseAlert(this.db, { severity: 'warning', code: 'filter.rspamd_unavailable', message: `Rspamd is not reachable (${(e as Error).message}); using the built-in spam rules.`, dedupeKey: 'filter.rspamd_unavailable' });
      spam = builtinScore(m.raw, m.parsed);
    }
    if (global === 'block') spam = { ...spam, score: Math.max(spam.score, c.spam.junkScore), rules: [...spam.rules, 'SENDER_BLOCKED_SERVER'] };
    if (c.spam.quarantineScore !== null && spam.score >= c.spam.quarantineScore) return { action: 'quarantine', kind: 'spam', reason: `Spam score ${spam.score} (${spam.rules.slice(0, 4).join(' ')})`, spam };
    return spam.score >= c.spam.junkScore ? { action: 'junk', spam } : { action: 'deliver', spam };
  }

  /** Headers added to incoming mail filed as Junk (clean mail is stored unchanged). */
  static spamHeaders(spam: SpamResult | null, junk: boolean): [string, string][] {
    if (!junk) return [];
    if (!spam) return [['X-VPM-Spam', 'Yes (sender blocked)']];
    return [
      ['X-VPM-Spam', junk ? 'Yes' : 'No'],
      ['X-VPM-Spam-Score', `${spam.score} (${spam.engine}) ${spam.rules.slice(0, 10).join(' ')}`.slice(0, 900)],
    ];
  }

  /** Webmail "Junk" / "Not junk": remember the sender for this user. */
  async learnSender(userId: number, from: string, kind: 'allow' | 'block'): Promise<void> {
    const addr = addressOf(from);
    if (!addr || !addr.includes('@')) return;
    const existing = await one<{ id: number }>(this.db, 'SELECT id FROM sender_lists WHERE user_id = ? AND pattern = ?', [userId, addr]);
    if (existing) await this.db.query('UPDATE sender_lists SET kind = ? WHERE id = ?', [kind, existing.id]);
    else await this.db.query("INSERT INTO sender_lists (user_id, pattern, kind, source, created_at) VALUES (?, ?, ?, 'webmail', ?)", [userId, addr, kind, new Date()]);
  }
}
