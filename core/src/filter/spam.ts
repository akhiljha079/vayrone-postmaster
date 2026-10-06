// Spam scoring.
//   builtin: lightweight rules, good enough for mail already filtered by the
//            provider; also reads the provider's own spam verdict headers
//   rspamd:  an Rspamd server (Linux; recommended for heavy spam)
import type { ParsedMessage } from '../mime/mime.js';
import { headerValue } from '../mime/headers.js';

export interface SpamResult {
  score: number;
  /** Rules that fired, with their points, for the X-VPM-Spam header and the logs. */
  rules: string[];
  engine: 'builtin' | 'rspamd';
  /** Rspamd's own suggestion. */
  action?: string;
}

const PHRASES = [
  'you have won',
  'you won',
  'lottery',
  'lucky draw',
  'claim your prize',
  'claim your reward',
  'free gift',
  'act now',
  'limited time offer',
  'urgent response needed',
  'verify your account',
  'your account has been suspended',
  'password expires today',
  'click here',
  'viagra',
  'casino',
  'bitcoin investment',
  'crypto investment',
  'double your money',
  'work from home',
  'earn money from home',
  'loan approved',
  'pre-approved loan',
  'kbc lottery',
  'congratulations dear',
  'inheritance fund',
  'western union',
  'wire transfer fee',
  '100% free',
  'risk free',
  'no credit check',
];

const domainOf = (addr: string | null | undefined) => (addr ?? '').toLowerCase().replace(/.*@/, '').replace(/[>\s].*$/, '');
const addrOf = (v: string | null) => (v ? (/<([^>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase() : '');

/** Visible text of the message (first text part, plain or HTML) for phrase checks. */
function bodyText(raw: Buffer, p: ParsedMessage): { text: string; html: boolean; links: number; mismatched: number } {
  const body = raw.subarray(p.tree.bs, Math.min(p.tree.be, p.tree.bs + 200_000)).toString('latin1');
  const html = /<html|<body|<a\s/i.test(body);
  const links = (body.match(/<a\s[^>]*href=/gi) ?? []).length;
  let mismatched = 0;
  for (const m of body.matchAll(/<a\s[^>]*href=["']?https?:\/\/([^/"'\s>]+)[^>]*>\s*(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})/gi)) {
    const target = m[1]!.toLowerCase();
    const shown = m[2]!.toLowerCase();
    if (!target.endsWith(shown) && !shown.endsWith(target)) mismatched++;
  }
  const text = body
    .replace(/=\r?\n/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase();
  return { text, html, links, mismatched };
}

export function builtinScore(raw: Buffer, p: ParsedMessage): SpamResult {
  const rules: string[] = [];
  let score = 0;
  const add = (pts: number, name: string) => {
    score += pts;
    rules.push(`${name}(${pts})`);
  };
  const h = (n: string) => headerValue(raw, n);

  // The provider already judged this message.
  if (/^\s*yes/i.test(h('x-spam-flag') ?? '')) add(5, 'PROVIDER_SPAM_FLAG');
  else if (/^\s*yes/i.test(h('x-spam-status') ?? '')) add(5, 'PROVIDER_SPAM_STATUS');
  const level = (h('x-spam-level') ?? '').replace(/[^*]/g, '').length;
  if (level >= 5) add(Math.min(4, level * 0.4), 'PROVIDER_SPAM_LEVEL');
  const scl = Number(/SCL:(-?\d+)/i.exec(h('x-forefront-antispam-report') ?? '')?.[1] ?? h('x-ms-exchange-organization-scl') ?? NaN);
  if (scl >= 5) add(5, 'MS_SCL_HIGH');
  const auth = (h('authentication-results') ?? '').toLowerCase();
  if (/\bspf=(fail|softfail)/.test(auth)) add(1.5, 'SPF_FAIL');
  if (/\bdkim=fail/.test(auth)) add(1, 'DKIM_FAIL');
  if (/\bdmarc=fail/.test(auth)) add(3, 'DMARC_FAIL');

  // Headers.
  const subject = p.subject ?? '';
  const letters = subject.replace(/[^A-Za-z]/g, '');
  if (letters.length >= 10 && letters === letters.toUpperCase()) add(1.5, 'SUBJECT_ALL_CAPS');
  if (/!{3,}|\${2,}/.test(subject)) add(1, 'SUBJECT_EXCLAIM');
  if (!p.messageId) add(1, 'MISSING_MESSAGE_ID');
  if (!p.date) add(1, 'MISSING_DATE');
  const from = addrOf(h('from'));
  const fromName = (h('from') ?? '').replace(/<[^>]*>/, '');
  const nameAddr = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i.exec(fromName)?.[0]?.toLowerCase();
  if (nameAddr && domainOf(nameAddr) !== domainOf(from)) add(2, 'FROM_NAME_SPOOFS_ADDRESS');
  const replyTo = addrOf(h('reply-to'));
  if (replyTo && from && domainOf(replyTo) !== domainOf(from) && /(gmail|yahoo|outlook|hotmail|proton)\./.test(domainOf(replyTo)) && !/(gmail|yahoo|outlook|hotmail|proton)\./.test(domainOf(from))) {
    add(1.5, 'REPLYTO_FREEMAIL');
  }

  // Content.
  const b = bodyText(raw, p);
  const lowerSubject = subject.toLowerCase();
  let phraseHits = 0;
  for (const ph of PHRASES) {
    if (lowerSubject.includes(ph)) {
      add(2, `SUBJECT_PHRASE:${ph.replace(/\s+/g, '_')}`);
      phraseHits++;
    } else if (b.text.includes(ph) && phraseHits < 3) {
      add(1, `BODY_PHRASE:${ph.replace(/\s+/g, '_')}`);
      phraseHits++;
    }
  }
  if (b.mismatched) add(Math.min(3, b.mismatched * 1.5), 'LINK_TEXT_MISMATCH');
  if (b.html && b.links > 15 && b.text.length < 2000) add(1, 'MANY_LINKS_LITTLE_TEXT');
  return { score: Math.round(score * 10) / 10, rules, engine: 'builtin' };
}

/** Asks an Rspamd server (normal worker, /checkv2). */
export async function rspamdScore(raw: Buffer, url: string, meta: { from: string; rcpt?: string | null }, timeoutMs = 20_000): Promise<SpamResult> {
  const res = await fetch(`${url.replace(/\/+$/, '')}/checkv2`, {
    method: 'POST',
    headers: { From: meta.from || '<>', ...(meta.rcpt ? { Rcpt: meta.rcpt } : {}), Pass: 'all' },
    body: raw,
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`Rspamd answered HTTP ${res.status}`);
  const j = (await res.json()) as { score?: number; action?: string; symbols?: Record<string, { score?: number }> };
  const rules = Object.entries(j.symbols ?? {})
    .filter(([, s]) => (s.score ?? 0) !== 0)
    .sort((a, b) => (b[1].score ?? 0) - (a[1].score ?? 0))
    .slice(0, 12)
    .map(([k, s]) => `${k}(${s.score})`);
  return { score: Math.round((j.score ?? 0) * 10) / 10, rules, engine: 'rspamd', ...(j.action ? { action: j.action } : {}) };
}
