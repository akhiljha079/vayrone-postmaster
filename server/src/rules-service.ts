// Shared logic for mail rules, forwarding and out-of-office, used by the
// admin API (global rules, any user) and the webmail API (own settings only).
import { z } from 'zod';
import {
  AutoReplyInput,
  INBOUND_ONLY_ACTIONS,
  MAIL_POLICY_DEFAULTS,
  RuleInput,
  RuleMessage,
  db as dbm,
  evaluateCondition,
  parseMime,
  planDelivery,
  splitAddress,
  type CoreContext,
  type MailPolicy,
  type StoredRule,
} from '@vpm/core';
import { badRequest, forbidden, notFound } from './http.js';

const { exec, json, one, rows, tx } = dbm;

export type RuleScope = { scope: 'global'; userId: null } | { scope: 'user'; userId: number };

export async function mailPolicy(ctx: CoreContext): Promise<MailPolicy> {
  return { ...MAIL_POLICY_DEFAULTS, ...(await ctx.settings.get<Partial<MailPolicy>>('mail', 'policy', {})) };
}

async function isLocal(ctx: CoreContext, addr: string): Promise<boolean> {
  const d = splitAddress(addr)?.domain;
  return Boolean(d && (await one(ctx.db, 'SELECT id FROM domains WHERE name = ?', [d])));
}

/** Employees may forward outside the company only when the policy allows it. */
async function assertForwardTargets(ctx: CoreContext, targets: string[], byAdmin: boolean): Promise<void> {
  if (byAdmin || !targets.length) return;
  const policy = await mailPolicy(ctx);
  if (policy.allowUserExternalForwarding) return;
  for (const t of targets) {
    if (!(await isLocal(ctx, t))) throw forbidden(`Forwarding to outside addresses (${t}) is disabled by your administrator`, 'EXTERNAL_FORWARD_DISABLED');
  }
}

function validateRule(r: z.infer<typeof RuleInput>, s: RuleScope): void {
  if (s.scope === 'user' && r.stage !== 'inbound') throw badRequest('Personal rules apply to incoming mail only');
  if (r.stage !== 'inbound') {
    const bad = r.actions.find((a) => INBOUND_ONLY_ACTIONS.has(a.type));
    if (bad) throw badRequest(`The "${bad.type}" action is not available for outgoing mail`);
  }
}

function shape(r: Record<string, unknown>) {
  return {
    id: r.id,
    scope: r.scope,
    userId: r.user_id,
    name: r.name,
    position: r.position,
    isEnabled: Boolean(r.is_enabled),
    stage: r.stage,
    matchMode: r.match_mode,
    conditions: json(r.conditions) ?? [],
    actions: json(r.actions) ?? [],
    stopProcessing: Boolean(r.stop_processing),
    hitCount: Number(r.hit_count),
    lastHitAt: r.last_hit_at,
  };
}

const where = (s: RuleScope) => (s.scope === 'global' ? { sql: "scope = 'global'", vals: [] as unknown[] } : { sql: "scope = 'user' AND user_id = ?", vals: [s.userId] as unknown[] });

export async function listRules(ctx: CoreContext, s: RuleScope) {
  const w = where(s);
  return (await rows(ctx.db, `SELECT * FROM mail_rules WHERE ${w.sql} ORDER BY position, id`, w.vals)).map(shape);
}

export async function createRule(ctx: CoreContext, s: RuleScope, body: unknown, byAdmin: boolean, createdBy: number): Promise<number> {
  const r = RuleInput.parse(body);
  validateRule(r, s);
  await assertForwardTargets(ctx, r.actions.flatMap((a) => (a.type === 'forward' || a.type === 'redirect' ? a.to : [])), byAdmin);
  const w = where(s);
  const max = await one<{ m: number | null }>(ctx.db, `SELECT MAX(position) m FROM mail_rules WHERE ${w.sql}`, w.vals);
  const now = new Date();
  const res = await exec(
    ctx.db,
    `INSERT INTO mail_rules (scope, user_id, name, position, is_enabled, stage, match_mode, conditions, actions, stop_processing, created_by, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [s.scope, s.userId, r.name, (max?.m ?? 0) + 1, r.isEnabled ? 1 : 0, r.stage, r.matchMode, JSON.stringify(r.conditions), JSON.stringify(r.actions), r.stopProcessing ? 1 : 0, createdBy, now, now],
  );
  return res.insertId;
}

async function ruleInScope(ctx: CoreContext, id: number, s: RuleScope): Promise<Record<string, unknown>> {
  const w = where(s);
  const r = await one(ctx.db, `SELECT * FROM mail_rules WHERE id = ? AND ${w.sql}`, [id, ...w.vals]);
  if (!r) throw notFound('Rule not found');
  return r;
}

/** Full replacement of a rule's definition (the editor always sends the whole rule). */
export async function updateRule(ctx: CoreContext, s: RuleScope, id: number, body: unknown, byAdmin: boolean): Promise<void> {
  await ruleInScope(ctx, id, s);
  const r = RuleInput.parse(body);
  validateRule(r, s);
  await assertForwardTargets(ctx, r.actions.flatMap((a) => (a.type === 'forward' || a.type === 'redirect' ? a.to : [])), byAdmin);
  await exec(
    ctx.db,
    'UPDATE mail_rules SET name = ?, is_enabled = ?, stage = ?, match_mode = ?, conditions = ?, actions = ?, stop_processing = ?, updated_at = ? WHERE id = ?',
    [r.name, r.isEnabled ? 1 : 0, r.stage, r.matchMode, JSON.stringify(r.conditions), JSON.stringify(r.actions), r.stopProcessing ? 1 : 0, new Date(), id],
  );
}

export async function setRuleEnabled(ctx: CoreContext, s: RuleScope, id: number, enabled: boolean): Promise<void> {
  await ruleInScope(ctx, id, s);
  await exec(ctx.db, 'UPDATE mail_rules SET is_enabled = ?, updated_at = ? WHERE id = ?', [enabled ? 1 : 0, new Date(), id]);
}

export async function deleteRule(ctx: CoreContext, s: RuleScope, id: number): Promise<void> {
  await ruleInScope(ctx, id, s);
  await exec(ctx.db, 'DELETE FROM mail_rules WHERE id = ?', [id]);
}

/** Drag-and-drop ordering: ids in the new order; must list every rule of the scope. */
export async function reorderRules(ctx: CoreContext, s: RuleScope, ids: number[]): Promise<void> {
  const w = where(s);
  await tx(ctx.db, async (c) => {
    const current = (await rows<{ id: number }>(c, `SELECT id FROM mail_rules WHERE ${w.sql} FOR UPDATE`, w.vals)).map((r) => r.id);
    if (current.length !== ids.length || new Set(ids).size !== ids.length || !ids.every((i) => current.includes(i))) {
      throw badRequest('The new order must contain every rule exactly once');
    }
    for (let i = 0; i < ids.length; i++) await exec(c, 'UPDATE mail_rules SET position = ? WHERE id = ?', [i + 1, ids[i]]);
  });
}

/** Dry run: which conditions match a sample message and what the rule would do. */
export const RuleTestBody = z.object({
  rule: z.unknown(),
  sample: z.object({
    from: z.string().max(300).default('Client <client@example.com>'),
    to: z.string().max(1000).default('you@company.com'),
    cc: z.string().max(1000).optional(),
    subject: z.string().max(500).default(''),
    body: z.string().max(20000).default(''),
    headers: z.string().max(5000).optional(),
    direction: z.enum(['in', 'out', 'internal']).default('in'),
  }),
});

export async function testRule(ctx: CoreContext, input: unknown) {
  const b = RuleTestBody.parse(input);
  const r = RuleInput.parse(b.rule);
  const s = b.sample;
  const raw = Buffer.from(
    [
      `From: ${s.from}`,
      `To: ${s.to}`,
      ...(s.cc ? [`Cc: ${s.cc}`] : []),
      `Subject: ${s.subject}`,
      'Message-ID: <rule-test@vayrone.local>',
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      ...(s.headers ? s.headers.split(/\r?\n/).filter((l) => /^[A-Za-z0-9-]+:/.test(l)) : []),
      '',
      s.body,
      '',
    ].join('\r\n'),
    'utf8',
  );
  const policy = await mailPolicy(ctx);
  const m = new RuleMessage(parseMime(raw), raw, s.direction, '');
  const conditions = r.conditions.map((c) => ({ condition: c, matched: evaluateCondition(c, m, policy.timezone) }));
  const stored: StoredRule = { id: 0, scope: 'global', name: r.name, stage: 'both', match_mode: r.matchMode, conditions: r.conditions, actions: r.actions, stop_processing: r.stopProcessing ? 1 : 0 };
  const plan = planDelivery([stored], m, policy.timezone, s.direction === 'out' ? 'outbound' : 'inbound');
  return { matched: plan.matched.length > 0, conditions, plan };
}

/**
 * "Run now" (Outlook's Run Rules Now): applies one personal rule to mail already in a
 * folder. Only the organising actions run (move, copy, flag, mark as read); replies and
 * forwards are never sent for old mail.
 */
export async function runRuleOnFolder(ctx: CoreContext, s: RuleScope & { scope: 'user' }, id: number, folderId: number): Promise<{ checked: number; matched: number; moved: number }> {
  const r = await ruleInScope(ctx, id, s);
  const folder = await one<{ id: number }>(ctx.db, 'SELECT id FROM folders WHERE id = ? AND user_id = ?', [folderId, s.userId]);
  if (!folder) throw notFound('Folder not found');
  const rule: StoredRule = {
    id,
    scope: 'user',
    name: String(r.name),
    stage: 'inbound',
    match_mode: r.match_mode as StoredRule['match_mode'],
    conditions: json(r.conditions) ?? [],
    actions: (json<StoredRule['actions']>(r.actions) ?? []).filter((a) => ['move', 'copy', 'flag', 'mark_read', 'stop'].includes(a.type)),
    stop_processing: 0,
  };
  const tz = (await mailPolicy(ctx)).timezone;
  const items = await rows<{ uid: number; storage_path: string; codec: number }>(
    ctx.db,
    'SELECT i.uid, m.storage_path, m.codec FROM mail_items i JOIN messages m ON m.id = i.message_id WHERE i.folder_id = ? ORDER BY i.uid DESC LIMIT 5000',
    [folderId],
  );
  const moves = new Map<string, number[]>();
  const copies = new Map<string, number[]>();
  const flags = new Map<number, number[]>();
  let matched = 0;
  for (const it of items) {
    const raw = await ctx.store.loadRaw(it);
    const plan = planDelivery([rule], new RuleMessage(parseMime(raw), raw, 'in', ''), tz, 'inbound');
    if (!plan.matched.length) continue;
    matched++;
    if (plan.flags) flags.set(plan.flags, [...(flags.get(plan.flags) ?? []), it.uid]);
    for (const c of plan.copies) copies.set(c, [...(copies.get(c) ?? []), it.uid]);
    if (plan.folder) moves.set(plan.folder, [...(moves.get(plan.folder) ?? []), it.uid]);
  }
  const target = async (path: string) => (await ctx.store.getFolder(s.userId, path)) ?? (await ctx.store.createFolder(s.userId, path));
  for (const [f, uids] of flags) await ctx.store.storeFlags(folderId, uids, 'add', f, null);
  for (const [path, uids] of copies) {
    const dst = await target(path);
    if (dst.id !== folderId) await ctx.store.copy(folderId, uids, dst.id);
  }
  let moved = 0;
  for (const [path, uids] of moves) {
    const dst = await target(path);
    if (dst.id === folderId) continue;
    await ctx.store.move(folderId, uids, dst.id);
    moved += uids.length;
  }
  if (matched) await exec(ctx.db, 'UPDATE mail_rules SET hit_count = hit_count + ?, last_hit_at = ? WHERE id = ?', [matched, new Date(), id]);
  return { checked: items.length, matched, moved };
}

// ---------------------------------------------------------------- forwarding / out of office

export const ForwardingBody = z.object({
  targets: z
    .array(z.object({ address: z.string().trim().toLowerCase().regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, 'Invalid email address'), keepLocalCopy: z.boolean().default(true), isEnabled: z.boolean().default(true) }))
    .max(10),
});

export async function getForwarding(ctx: CoreContext, userId: number) {
  return (
    await rows<{ target_address: string; keep_local_copy: number; is_enabled: number }>(ctx.db, 'SELECT target_address, keep_local_copy, is_enabled FROM forwardings WHERE user_id = ? ORDER BY id', [userId])
  ).map((f) => ({ address: f.target_address, keepLocalCopy: Boolean(f.keep_local_copy), isEnabled: Boolean(f.is_enabled) }));
}

export async function setForwarding(ctx: CoreContext, userId: number, body: unknown, byAdmin: boolean, actor: number): Promise<void> {
  const b = ForwardingBody.parse(body);
  await assertForwardTargets(ctx, b.targets.filter((t) => t.isEnabled).map((t) => t.address), byAdmin);
  const own = await ctx.directory.userAddresses(userId);
  if (b.targets.some((t) => own.includes(t.address))) throw badRequest('A mailbox cannot forward to itself');
  await tx(ctx.db, async (c) => {
    await exec(c, 'DELETE FROM forwardings WHERE user_id = ?', [userId]);
    if (b.targets.length) {
      await exec(c, 'INSERT INTO forwardings (user_id, target_address, keep_local_copy, is_enabled, created_by, created_at) VALUES ?', [
        b.targets.map((t) => [userId, t.address, t.keepLocalCopy ? 1 : 0, t.isEnabled ? 1 : 0, actor, new Date()]),
      ]);
    }
  });
}

export async function getAutoReply(ctx: CoreContext, userId: number) {
  const a = await one<{ is_enabled: number; subject: string; body_text: string; starts_at: Date | null; ends_at: Date | null; internal_only: number; once_per_days: number }>(
    ctx.db,
    'SELECT * FROM autoreplies WHERE user_id = ?',
    [userId],
  );
  return a
    ? { isEnabled: Boolean(a.is_enabled), subject: a.subject, bodyText: a.body_text, startsAt: a.starts_at, endsAt: a.ends_at, internalOnly: Boolean(a.internal_only), oncePerDays: a.once_per_days }
    : { isEnabled: false, subject: 'Out of office', bodyText: '', startsAt: null, endsAt: null, internalOnly: false, oncePerDays: 4 };
}

export async function setAutoReply(ctx: CoreContext, userId: number, body: unknown): Promise<void> {
  const b = AutoReplyInput.parse(body);
  if (b.startsAt && b.endsAt && b.endsAt <= b.startsAt) throw badRequest('The end date must be after the start date');
  await exec(
    ctx.db,
    `INSERT INTO autoreplies (user_id, is_enabled, subject, body_text, starts_at, ends_at, internal_only, once_per_days, updated_at) VALUES (?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE is_enabled = VALUES(is_enabled), subject = VALUES(subject), body_text = VALUES(body_text), starts_at = VALUES(starts_at),
       ends_at = VALUES(ends_at), internal_only = VALUES(internal_only), once_per_days = VALUES(once_per_days), updated_at = VALUES(updated_at)`,
    [userId, b.isEnabled ? 1 : 0, b.subject, b.bodyText, b.startsAt ?? null, b.endsAt ?? null, b.internalOnly ? 1 : 0, b.oncePerDays, new Date()],
  );
  // A new out-of-office period starts fresh: senders answered last time get a reply again.
  if (b.isEnabled) await exec(ctx.db, 'DELETE FROM autoreply_log WHERE user_id = ?', [userId]);
}
