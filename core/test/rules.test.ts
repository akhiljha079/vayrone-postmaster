import { describe, expect, it } from 'vitest';
import { parseMessage } from '../src/mime/mime.js';
import { RuleMessage, evaluateCondition, planDelivery, type StoredRule } from '../src/rules/engine.js';
import { Condition, RuleInput } from '../src/rules/model.js';
import { headerValue, loopCount, prependHeaders, removeHeaders, rewriteFromForForward } from '../src/mime/headers.js';
import { complexMessage, simpleMessage } from './fixtures.js';

const TZ = 'Asia/Kolkata';
const msg = (raw: string, direction: 'in' | 'out' | 'internal' = 'in', env = '', now?: Date) => new RuleMessage(parseMessage(Buffer.from(raw)), Buffer.from(raw), direction, env, now);
const cond = (c: unknown) => Condition.parse(c);
const rule = (id: number, conditions: unknown[], actions: unknown[], extra: Partial<StoredRule> = {}): StoredRule => ({
  id,
  scope: 'global',
  name: `r${id}`,
  stage: 'inbound',
  match_mode: 'all',
  conditions: conditions.map(cond),
  actions: RuleInput.parse({ name: 'x', actions }).actions,
  stop_processing: 0,
  ...extra,
});

describe('rule conditions', () => {
  const m = msg(complexMessage(), 'in', 'bounce@sender.example');

  it('matches addresses by text, exact address and domain', () => {
    expect(evaluateCondition(cond({ field: 'from', op: 'contains', value: 'Åsa' }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'from', op: 'equals', value: 'asa@example.com' }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'from', op: 'domain_is', value: 'sender.example' }), m, TZ)).toBe(true); // envelope sender counts too
    expect(evaluateCondition(cond({ field: 'to', op: 'domain_is', value: 'example.com' }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'cc', op: 'equals', value: 'carol@example.org' }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'to_or_cc', op: 'equals', value: 'nobody@x.test' }), m, TZ)).toBe(false);
  });

  it('matches decoded subject, body text, headers, regex', () => {
    expect(evaluateCondition(cond({ field: 'subject', op: 'contains', value: 'café' }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'body', op: 'contains', value: 'searchable-token' }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'header', header: 'MIME-Version', op: 'exists' }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'header', header: 'X-Missing', op: 'exists' }), m, TZ)).toBe(false);
    expect(evaluateCondition(cond({ field: 'subject', op: 'regex', value: '^re:\\s+caf' }), m, TZ)).toBe(true);
  });

  it('matches size, attachments and direction', () => {
    expect(evaluateCondition(cond({ field: 'size', op: 'gt', value: 100 }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'has_attachment', op: 'is', value: true }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'attachment_ext', op: 'in', value: 'exe, .PDF' }), m, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'attachment_ext', op: 'in', value: 'exe,zip' }), m, TZ)).toBe(false);
    expect(evaluateCondition(cond({ field: 'direction', op: 'is', value: 'in' }), m, TZ)).toBe(true);
  });

  it('matches time windows in the configured time zone, including past midnight', () => {
    // 2026-10-05 is a Monday. 14:00 UTC = 19:30 IST.
    const evening = msg(simpleMessage(), 'in', '', new Date('2026-10-05T14:00:00Z'));
    expect(evaluateCondition(cond({ field: 'time', op: 'between', value: '18:00-09:00' }), evening, TZ)).toBe(true);
    expect(evaluateCondition(cond({ field: 'time', op: 'between', value: '09:00-18:00' }), evening, TZ)).toBe(false);
    expect(evaluateCondition(cond({ field: 'time', op: 'between', value: '18:00-09:00', days: [0, 6] }), evening, TZ)).toBe(false); // weekends only
  });

  it('rejects unsafe or invalid rules at validation time', () => {
    expect(() => cond({ field: 'subject', op: 'regex', value: '(a+)+$' })).toThrow();
    expect(() => cond({ field: 'subject', op: 'regex', value: '[' })).toThrow();
    expect(() => cond({ field: 'header', op: 'contains', value: 'x' })).toThrow(); // header name missing
    expect(() => RuleInput.parse({ name: 'x', actions: [] })).toThrow();
    expect(() => RuleInput.parse({ name: 'x', actions: [{ type: 'add_header', name: 'Subject', value: 'x' }] })).toThrow();
  });
});

describe('planning', () => {
  const m = msg(simpleMessage({ subject: 'Invoice 42 from vendor' }));

  it('applies rules in order, accumulating actions until stop', () => {
    const plan = planDelivery(
      [
        rule(1, [{ field: 'subject', op: 'contains', value: 'invoice' }], [{ type: 'move', folder: 'Accounts' }, { type: 'mark_read' }]),
        rule(2, [], [{ type: 'flag' }, { type: 'copy', folder: 'All' }], { stop_processing: 1 }),
        rule(3, [], [{ type: 'discard' }]),
      ],
      m,
      TZ,
      'inbound',
    );
    expect(plan).toMatchObject({ folder: 'Accounts', copies: ['All'], flags: 5, discard: false, matched: [1, 2] });
  });

  it('match any vs all, and stage filtering', () => {
    const any = rule(1, [{ field: 'subject', op: 'contains', value: 'nope' }, { field: 'subject', op: 'contains', value: 'invoice' }], [{ type: 'flag' }], { match_mode: 'any' });
    const all = { ...any, id: 2, match_mode: 'all' as const };
    expect(planDelivery([any], m, TZ, 'inbound').matched).toEqual([1]);
    expect(planDelivery([all], m, TZ, 'inbound').matched).toEqual([]);
    expect(planDelivery([{ ...any, stage: 'outbound' }], m, TZ, 'inbound').matched).toEqual([]);
  });

  it('reject and discard end processing', () => {
    const p = planDelivery([rule(1, [], [{ type: 'reject', message: 'No vendors' }]), rule(2, [], [{ type: 'flag' }])], m, TZ, 'inbound');
    expect(p).toMatchObject({ reject: 'No vendors', flags: 0, matched: [1] });
  });
});

describe('header edits', () => {
  const raw = Buffer.from(simpleMessage({ from: 'Client Name <client@gmail.test>' }).replace('MIME-Version', 'DKIM-Signature: v=1; a=rsa\r\n\tb=abc\r\nMIME-Version'));

  it('adds and counts loop markers', () => {
    const once = prependHeaders(raw, [['X-VPM-Loop', 'abc']]);
    expect(loopCount(once, 'abc')).toBe(1);
    expect(loopCount(prependHeaders(once, [['X-VPM-Loop', 'other']]), 'abc')).toBe(1);
    expect(loopCount(raw, 'abc')).toBe(0);
  });

  it('removes folded headers completely', () => {
    const out = removeHeaders(raw, ['DKIM-Signature']).toString();
    expect(out).not.toContain('DKIM-Signature');
    expect(out).not.toContain('b=abc');
    expect(out).toContain('MIME-Version: 1.0');
  });

  it('rewrites From for DMARC-safe forwarding and keeps Reply-To on the sender', () => {
    const out = rewriteFromForForward(raw, 'ravi@company.test', 'Ravi Kumar');
    expect(headerValue(out, 'From')).toBe('"Client Name via Ravi Kumar" <ravi@company.test>');
    expect(headerValue(out, 'Reply-To')).toBe('Client Name <client@gmail.test>');
    expect(headerValue(out, 'X-Original-From')).toBe('Client Name <client@gmail.test>');
    expect(out.toString()).not.toContain('DKIM-Signature');
    expect(parseMessage(out).headers.filter((h) => h.key === 'from')).toHaveLength(1);
  });
});
