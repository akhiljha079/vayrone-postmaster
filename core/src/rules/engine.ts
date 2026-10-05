// Rule evaluation. Pure: it decides what should happen to a message for one
// recipient; the mail flow performs the plan afterwards.
import libmime from 'libmime';
import addressparser from 'nodemailer/lib/addressparser/index.js';
import type { MimeEntity, ParsedMessage } from '../mime/mime.js';
import { extractBodyText } from '../imap/search.js';
import type { Action, Condition } from './model.js';

export type Direction = 'in' | 'out' | 'internal';

export interface StoredRule {
  id: number;
  scope: 'global' | 'user';
  name: string;
  stage: 'inbound' | 'outbound' | 'both';
  match_mode: 'all' | 'any';
  conditions: Condition[];
  actions: Action[];
  stop_processing: number;
}

/** Message facts used by conditions; body text is decoded only if a rule asks for it. */
export class RuleMessage {
  private bodyCache: string | null = null;
  private headerMap: Map<string, string[]> | null = null;

  constructor(
    readonly parsed: ParsedMessage,
    readonly raw: Buffer,
    readonly direction: Direction,
    readonly envelopeFrom: string,
    readonly now: Date = new Date(),
  ) {}

  headers(): Map<string, string[]> {
    if (!this.headerMap) {
      const m = new Map<string, string[]>();
      for (const h of this.parsed.headers) {
        let v = h.value;
        try {
          v = libmime.decodeWords(v);
        } catch {
          /* keep raw */
        }
        m.set(h.key, [...(m.get(h.key) ?? []), v]);
      }
      this.headerMap = m;
    }
    return this.headerMap;
  }

  header(name: string): string[] {
    return this.headers().get(name.toLowerCase()) ?? [];
  }

  /** "Name <addr>" strings plus bare addresses for an address header. */
  addresses(name: 'from' | 'to' | 'cc'): { display: string[]; emails: string[] } {
    const display: string[] = [];
    const emails: string[] = [];
    for (const v of this.header(name)) {
      for (const a of addressparser(v)) {
        const list = a.group ?? [a];
        for (const x of list) {
          if (!x.address) continue;
          emails.push(x.address.toLowerCase());
          display.push(x.name ? `${x.name} <${x.address}>` : x.address);
        }
      }
    }
    if (name === 'from' && this.envelopeFrom && !emails.includes(this.envelopeFrom.toLowerCase())) emails.push(this.envelopeFrom.toLowerCase());
    return { display, emails };
  }

  body(): string {
    if (this.bodyCache === null) this.bodyCache = extractBodyText(this.raw, this.parsed.tree).slice(0, 200_000);
    return this.bodyCache;
  }

  attachmentExts(): string[] {
    const out: string[] = [];
    const visit = (e: MimeEntity) => {
      if (e.parts) return e.parts.forEach(visit);
      const name = e.disp?.[1].find(([k]) => k === 'filename')?.[1] ?? e.params.find(([k]) => k === 'name')?.[1];
      if (name) {
        const dot = name.lastIndexOf('.');
        if (dot > 0) out.push(name.slice(dot + 1).toLowerCase());
      }
    };
    visit(this.parsed.tree);
    return out;
  }
}

function textMatch(op: string, hay: string[], value: string): boolean {
  const v = value.toLowerCase();
  const list = hay.map((h) => h.toLowerCase());
  switch (op) {
    case 'exists':
      return list.length > 0;
    case 'contains':
      return list.some((h) => h.includes(v));
    case 'not_contains':
      return !list.some((h) => h.includes(v));
    case 'equals':
      return list.some((h) => h === v);
    case 'not_equals':
      return !list.some((h) => h === v);
    case 'starts_with':
      return list.some((h) => h.startsWith(v));
    case 'ends_with':
      return list.some((h) => h.endsWith(v));
    case 'domain_is':
      return list.some((h) => h.endsWith(`@${v.replace(/^@/, '')}`));
    case 'regex': {
      const re = new RegExp(value, 'i');
      return hay.some((h) => re.test(h.slice(0, 10_000)));
    }
    default:
      return false;
  }
}

/** Minutes since midnight and weekday in the given IANA time zone. */
function localClock(d: Date, tz: string): { minutes: number; day: number } {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '0';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { minutes: (Number(get('hour')) % 24) * 60 + Number(get('minute')), day };
}

export function evaluateCondition(c: Condition, m: RuleMessage, tz: string): boolean {
  switch (c.field) {
    case 'from':
    case 'to':
    case 'cc': {
      const a = m.addresses(c.field);
      return textMatch(c.op, c.op === 'domain_is' || c.op === 'equals' || c.op === 'not_equals' ? a.emails : [...a.display, ...a.emails], c.value);
    }
    case 'to_or_cc': {
      const to = m.addresses('to');
      const cc = m.addresses('cc');
      const emails = [...to.emails, ...cc.emails];
      return textMatch(c.op, c.op === 'domain_is' || c.op === 'equals' || c.op === 'not_equals' ? emails : [...to.display, ...cc.display, ...emails], c.value);
    }
    case 'subject':
      return textMatch(c.op, [m.parsed.subject ?? ''], c.value);
    case 'body':
      return textMatch(c.op, [m.body()], c.value);
    case 'header':
      return textMatch(c.op, m.header(c.header!), c.value);
    case 'size':
      return c.op === 'gt' ? m.raw.length > c.value : m.raw.length < c.value;
    case 'has_attachment':
      return m.parsed.hasAttachments === c.value;
    case 'attachment_ext': {
      const want = c.value
        .split(/[\s,;]+/)
        .map((x) => x.replace(/^\./, '').toLowerCase())
        .filter(Boolean);
      return m.attachmentExts().some((e) => want.includes(e));
    }
    case 'direction':
      return m.direction === c.value;
    case 'time': {
      const { minutes, day } = localClock(m.now, tz);
      if (c.days?.length && !c.days.includes(day)) return false;
      const [a, b] = c.value.split('-').map((t) => {
        const [h, mm] = t.split(':').map(Number);
        return h! * 60 + mm!;
      }) as [number, number];
      return a <= b ? minutes >= a && minutes < b : minutes >= a || minutes < b;
    }
  }
}

export function ruleMatches(r: { match_mode: 'all' | 'any'; conditions: Condition[] }, m: RuleMessage, tz: string): boolean {
  if (!r.conditions.length) return true;
  return r.match_mode === 'any' ? r.conditions.some((c) => evaluateCondition(c, m, tz)) : r.conditions.every((c) => evaluateCondition(c, m, tz));
}

/** What should happen to one recipient's copy. */
export interface DeliveryPlan {
  /** Primary folder path; null = the default (INBOX or the account's target folder). */
  folder: string | null;
  copies: string[];
  flags: number;
  discard: boolean;
  reject: string | null;
  forwards: string[];
  redirects: string[];
  autoReplies: { subject: string; body: string; ruleId: number }[];
  addHeaders: [string, string][];
  matched: number[];
}

export function emptyPlan(): DeliveryPlan {
  return { folder: null, copies: [], flags: 0, discard: false, reject: null, forwards: [], redirects: [], autoReplies: [], addHeaders: [], matched: [] };
}

/**
 * Applies rules in order (global first, then the user's). A rule with
 * "stop processing", a stop action, reject or discard ends evaluation.
 */
export function planDelivery(rules: StoredRule[], m: RuleMessage, tz: string, stage: 'inbound' | 'outbound'): DeliveryPlan {
  const plan = emptyPlan();
  for (const r of rules) {
    if (r.stage !== 'both' && r.stage !== stage) continue;
    let matched: boolean;
    try {
      matched = ruleMatches(r, m, tz);
    } catch {
      matched = false; // a broken rule never blocks delivery
    }
    if (!matched) continue;
    plan.matched.push(r.id);
    let stop = Boolean(r.stop_processing);
    for (const a of r.actions) {
      switch (a.type) {
        case 'move':
          plan.folder = a.folder;
          break;
        case 'copy':
          if (!plan.copies.includes(a.folder)) plan.copies.push(a.folder);
          break;
        case 'forward':
          a.to.forEach((t) => !plan.forwards.includes(t) && plan.forwards.push(t));
          break;
        case 'redirect':
          a.to.forEach((t) => !plan.redirects.includes(t) && plan.redirects.push(t));
          break;
        case 'auto_reply':
          plan.autoReplies.push({ subject: a.subject, body: a.body, ruleId: r.id });
          break;
        case 'reject':
          plan.reject = a.message || 'Message rejected by a mail rule';
          stop = true;
          break;
        case 'discard':
          plan.discard = true;
          stop = true;
          break;
        case 'flag':
          plan.flags |= 4;
          break;
        case 'mark_read':
          plan.flags |= 1;
          break;
        case 'add_header':
          plan.addHeaders.push([a.name, a.value]);
          break;
        case 'stop':
          stop = true;
          break;
      }
    }
    if (stop) break;
  }
  return plan;
}
