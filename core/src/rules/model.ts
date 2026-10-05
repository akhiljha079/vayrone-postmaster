// Rule model shared by the delivery pipeline and the admin/webmail APIs.
import { z } from 'zod';

export const TEXT_FIELDS = ['from', 'to', 'cc', 'to_or_cc', 'subject', 'body', 'header'] as const;
export const TEXT_OPS = ['contains', 'not_contains', 'equals', 'not_equals', 'starts_with', 'ends_with', 'regex', 'domain_is', 'exists'] as const;

const Email = z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address');
const FolderPath = z.string().trim().min(1).max(500);

/** Rejects patterns with nested quantifiers — the usual catastrophic-backtracking shape. */
function safeRegex(src: string): boolean {
  if (src.length > 200) return false;
  if (/\([^)]*[+*][^)]*\)[+*{]/.test(src)) return false;
  try {
    new RegExp(src, 'i');
    return true;
  } catch {
    return false;
  }
}

const TextCondition = z
  .object({
    field: z.enum(TEXT_FIELDS),
    op: z.enum(TEXT_OPS),
    value: z.string().max(500).default(''),
    /** Header name, for field = header. */
    header: z.string().trim().max(100).regex(/^[A-Za-z0-9-]*$/).optional(),
  })
  .refine((c) => c.field !== 'header' || Boolean(c.header), 'Header name is required')
  .refine((c) => c.op !== 'regex' || safeRegex(c.value), 'Invalid or unsafe regular expression')
  .refine((c) => c.op === 'exists' || c.value !== '', 'A value is required');

export const Condition = z.union([
  TextCondition,
  z.object({ field: z.literal('size'), op: z.enum(['gt', 'lt']), value: z.number().int().min(0) }),
  z.object({ field: z.literal('has_attachment'), op: z.literal('is'), value: z.boolean() }),
  z.object({ field: z.literal('attachment_ext'), op: z.literal('in'), value: z.string().trim().min(1).max(500) }),
  z.object({ field: z.literal('direction'), op: z.literal('is'), value: z.enum(['in', 'out', 'internal']) }),
  z.object({
    field: z.literal('time'),
    op: z.literal('between'),
    /** "HH:MM-HH:MM" in the server time zone; may wrap past midnight (18:00-09:00). */
    value: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/, 'Use HH:MM-HH:MM'),
    /** 0 = Sunday … 6 = Saturday. Empty/omitted = every day. */
    days: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  }),
]);
export type Condition = z.infer<typeof Condition>;

export const Action = z.discriminatedUnion('type', [
  z.object({ type: z.literal('move'), folder: FolderPath }),
  z.object({ type: z.literal('copy'), folder: FolderPath }),
  z.object({ type: z.literal('forward'), to: z.array(Email).min(1).max(10) }),
  z.object({ type: z.literal('redirect'), to: z.array(Email).min(1).max(10) }),
  z.object({ type: z.literal('auto_reply'), subject: z.string().trim().min(1).max(300), body: z.string().min(1).max(20000) }),
  z.object({ type: z.literal('reject'), message: z.string().trim().max(300).optional() }),
  z.object({ type: z.literal('discard') }),
  z.object({ type: z.literal('flag') }),
  z.object({ type: z.literal('mark_read') }),
  z.object({
    type: z.literal('add_header'),
    name: z
      .string()
      .trim()
      .regex(/^X-[A-Za-z0-9-]{1,60}$/, 'Header name must start with X-'),
    value: z.string().max(500).regex(/^[^\r\n]*$/, 'No line breaks'),
  }),
  z.object({ type: z.literal('stop') }),
]);
export type Action = z.infer<typeof Action>;

export const RuleInput = z.object({
  name: z.string().trim().min(1).max(200),
  isEnabled: z.boolean().default(true),
  stage: z.enum(['inbound', 'outbound', 'both']).default('inbound'),
  matchMode: z.enum(['all', 'any']).default('all'),
  conditions: z.array(Condition).max(20).default([]),
  actions: z.array(Action).min(1).max(10),
  stopProcessing: z.boolean().default(false),
});
export type RuleInput = z.infer<typeof RuleInput>;

/** Actions that make no sense on outgoing mail (there is no local mailbox to act on). */
export const INBOUND_ONLY_ACTIONS = new Set(['move', 'copy', 'flag', 'mark_read', 'auto_reply', 'redirect']);

export const JournalInput = z.object({
  name: z.string().trim().min(1).max(200),
  direction: z.enum(['in', 'out', 'both']).default('both'),
  scope: z.enum(['all', 'domain', 'group', 'user']).default('all'),
  scopeId: z.number().int().positive().nullable().optional(),
  includeInternal: z.boolean().default(true),
  matchMode: z.enum(['all', 'any']).default('all'),
  conditions: z.array(Condition).max(20).default([]),
  targetAddress: Email,
  isEnabled: z.boolean().default(true),
});
export type JournalInput = z.infer<typeof JournalInput>;

export const AutoReplyInput = z.object({
  isEnabled: z.boolean(),
  subject: z.string().trim().min(1).max(500),
  bodyText: z.string().min(1).max(20000),
  startsAt: z.coerce.date().nullable().optional(),
  endsAt: z.coerce.date().nullable().optional(),
  internalOnly: z.boolean().default(false),
  oncePerDays: z.number().int().min(1).max(30).default(4),
});
export type AutoReplyInput = z.infer<typeof AutoReplyInput>;

export interface MailPolicy {
  /** Users may forward/redirect to addresses outside the company's domains. */
  allowUserExternalForwarding: boolean;
  /** Rewrite From (DMARC-safe) when forwarding an outside sender's mail through the relay. */
  rewriteFromOnExternalForward: boolean;
  /** Time zone for time-of-day rule conditions. */
  timezone: string;
}

export const MAIL_POLICY_DEFAULTS: MailPolicy = {
  allowUserExternalForwarding: false,
  rewriteFromOnExternalForward: true,
  timezone: 'Asia/Kolkata',
};
