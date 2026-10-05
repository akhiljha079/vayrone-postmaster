// Mail flow (docs/ARCHITECTURE.md §5.4): every message entering a local
// mailbox or leaving through the relay passes through here.
//
//   inbound   — fetched mail ('in') and LAN-to-LAN mail ('internal'), per recipient:
//               rules → forwarding → atomic delivery with dedup → side effects
//   submission — LAN SMTP: outbound rules (may reject) → local recipients →
//               relay queue → journaling once
//
// Side effects (copies, forwards, redirects, auto-replies, journal copies) run
// only after the primary delivery succeeded and was not a duplicate, so a
// re-downloaded message never triggers them twice. Every generated message
// carries X-VPM-Loop with this install's id; mail that already carries it is
// delivered but never forwarded or answered again.
import { createHash } from 'node:crypto';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Logger } from 'pino';
import type { CoreConfig } from './config.js';
import type { Db } from './db.js';
import { exec, json, one, rows } from './db.js';
import type { Delivery, DeliveryOutcome } from './delivery.js';
import type { Directory } from './directory.js';
import { splitAddress } from './directory.js';
import type { Settings } from './settings.js';
import type { ItemOrigin, MailStore, StoredMessage } from './store/mailstore.js';
import { StoreError } from './store/mailstore.js';
import { buildDsn } from './dsn.js';
import { loopCount, prependHeaders, receivedCount, rewriteFromForForward } from './mime/headers.js';
import { RuleMessage, planDelivery, ruleMatches, type Direction, type StoredRule } from './rules/engine.js';
import { MAIL_POLICY_DEFAULTS, type Condition, type MailPolicy } from './rules/model.js';
import type { Archiver } from './archive/archive.js';

const MAX_RECEIVED_FOR_FORWARD = 30;
const RULE_CACHE_MS = 10_000;

export interface InboundRecipient {
  userId: number;
  /** Default folder (e.g. an external account's target folder); INBOX when omitted. */
  folderId?: number | null;
}

export interface InboundRequest {
  message: StoredMessage;
  recipients: InboundRecipient[];
  origin: ItemOrigin;
  direction: 'in' | 'internal';
  envelopeFrom: string;
  senderUserId?: number | null;
  externalAccountId?: number | null;
  clientIp?: string | null;
  ignoreQuota?: boolean;
  /** Journaling is done by the caller (submission handles it once for the whole message). */
  skipJournal?: boolean;
}

export interface SubmissionRequest {
  message: StoredMessage;
  envelopeFrom: string;
  senderUserId: number;
  localUserIds: number[];
  external: string[];
  clientIp?: string | null;
}

export interface SubmissionResult {
  rejected: string | null;
  outcomes: DeliveryOutcome[];
  queueId: number | null;
}

interface UserInfo {
  id: number;
  login: string;
  display_name: string;
  domain_id: number | null;
}

interface JournalRow {
  id: number;
  direction: 'in' | 'out' | 'both';
  scope: 'all' | 'domain' | 'group' | 'user';
  scope_id: number | null;
  include_internal: number;
  match_mode: 'all' | 'any';
  conditions: unknown;
  target_address: string;
}

export class MailFlow {
  private globalRules: { at: number; rules: StoredRule[] } | null = null;
  /** Compliance archive (set by the context; absent in minimal setups). */
  archiver: Archiver | null = null;

  constructor(
    private readonly db: Db,
    private readonly store: MailStore,
    private readonly delivery: Delivery,
    private readonly directory: Directory,
    private readonly settings: Settings,
    private readonly config: Pick<CoreConfig, 'installId' | 'hostname'>,
    private readonly log: Logger,
  ) {}

  invalidateRules(): void {
    this.globalRules = null;
  }

  async policy(): Promise<MailPolicy> {
    return { ...MAIL_POLICY_DEFAULTS, ...(await this.settings.get<Partial<MailPolicy>>('mail', 'policy', {})) };
  }

  // -------------------------------------------------------------------------
  // Rules
  // -------------------------------------------------------------------------

  private toRule(r: Record<string, unknown>): StoredRule {
    return {
      id: r.id as number,
      scope: r.scope as 'global' | 'user',
      name: r.name as string,
      stage: r.stage as StoredRule['stage'],
      match_mode: r.match_mode as 'all' | 'any',
      conditions: json<Condition[]>(r.conditions) ?? [],
      actions: json<StoredRule['actions']>(r.actions) ?? [],
      stop_processing: Number(r.stop_processing),
    };
  }

  private async rulesFor(userId: number | null): Promise<StoredRule[]> {
    if (!this.globalRules || Date.now() - this.globalRules.at > RULE_CACHE_MS) {
      const g = await rows(this.db, "SELECT * FROM mail_rules WHERE scope = 'global' AND is_enabled = 1 ORDER BY position, id");
      this.globalRules = { at: Date.now(), rules: g.map((r) => this.toRule(r)) };
    }
    if (!userId) return this.globalRules.rules;
    const u = await rows(this.db, "SELECT * FROM mail_rules WHERE scope = 'user' AND user_id = ? AND is_enabled = 1 ORDER BY position, id", [userId]);
    return [...this.globalRules.rules, ...u.map((r) => this.toRule(r))];
  }

  private async countHits(ids: number[]): Promise<void> {
    if (ids.length) await exec(this.db, 'UPDATE mail_rules SET hit_count = hit_count + 1, last_hit_at = ? WHERE id IN (?)', [new Date(), ids]).catch(() => {});
  }

  private async ensureFolder(userId: number, path: string): Promise<number> {
    const f = await this.store.getFolder(userId, path);
    if (f) return f.id;
    try {
      return (await this.store.createFolder(userId, path)).id;
    } catch (e) {
      if (e instanceof StoreError && e.code === 'ALREADYEXISTS') return (await this.store.getFolder(userId, path))!.id;
      throw e;
    }
  }

  private async user(id: number): Promise<UserInfo | undefined> {
    return one<UserInfo>(this.db, 'SELECT id, login, display_name, domain_id FROM users WHERE id = ?', [id]);
  }

  private async isLocalDomain(addr: string): Promise<boolean> {
    const d = splitAddress(addr)?.domain;
    return Boolean(d && (await one(this.db, 'SELECT id FROM domains WHERE name = ?', [d])));
  }

  private async mailLog(event: string, m: StoredMessage, userId: number | null, detail: string, direction: Direction = 'internal'): Promise<void> {
    await exec(
      this.db,
      'INSERT INTO mail_log (at, event, direction, hdr_message_id, user_id, subject, size, detail) VALUES (?,?,?,?,?,?,?,?)',
      [new Date(), event, direction, m.parsed.messageId?.slice(0, 255) ?? null, userId, m.parsed.subject?.slice(0, 255) ?? null, m.size, detail.slice(0, 1000)],
    ).catch(() => {});
  }

  // -------------------------------------------------------------------------
  // Sending generated mail (forwards, auto-replies, journal copies, notices)
  // -------------------------------------------------------------------------

  /** Delivers locally where possible, queues the rest for the relay. */
  async send(o: { raw: Buffer; envelopeFrom: string; to: string[]; senderUserId: number | null; source: 'forward' | 'redirect' | 'autoreply' | 'journal' | 'rule' }): Promise<void> {
    const message = await this.store.ingest(o.raw);
    const local = new Set<number>();
    const external: string[] = [];
    for (const rcpt of o.to) {
      const r = await this.directory.resolve(rcpt);
      if (r.kind === 'local') {
        r.userIds.forEach((u) => local.add(u));
        external.push(...r.external);
      } else if (r.kind === 'unknown-local' && r.action === 'catchall' && r.catchallUserId) local.add(r.catchallUserId);
      else if (r.kind === 'unknown-local' && r.action === 'reject') continue;
      else external.push(rcpt.toLowerCase());
    }
    if (local.size) {
      await this.delivery.deliver({
        message,
        targets: [...local].map((userId) => ({ userId })),
        origin: o.source === 'journal' ? 'journal' : 'rule',
        envelopeFrom: o.envelopeFrom,
      });
    }
    const ext = [...new Set(external)];
    if (ext.length) {
      await this.delivery.enqueueOutbound({ message, envelopeFrom: o.envelopeFrom, recipients: ext, senderUserId: o.senderUserId, source: o.source });
    }
  }

  private async forward(user: UserInfo, m: StoredMessage, targets: string[], kind: 'forward' | 'redirect'): Promise<void> {
    const policy = await this.policy();
    const base = prependHeaders(m.raw, [
      ['X-VPM-Loop', this.config.installId],
      ['X-Forwarded-For', `${user.login}`],
    ]);
    const internal: string[] = [];
    const external: string[] = [];
    for (const t of targets) ((await this.isLocalDomain(t)) ? internal : external).push(t);
    if (internal.length) await this.send({ raw: base, envelopeFrom: user.login, to: internal, senderUserId: user.id, source: kind });
    if (external.length) {
      const fromAddr = m.parsed.envelope.from?.[0];
      const fromEmail = fromAddr?.[2] && fromAddr[3] ? `${fromAddr[2]}@${fromAddr[3]}` : '';
      const rewrite = policy.rewriteFromOnExternalForward && !(fromEmail && (await this.isLocalDomain(fromEmail)));
      const raw = rewrite ? rewriteFromForForward(base, user.login, user.display_name) : base;
      await this.send({ raw, envelopeFrom: user.login, to: external, senderUserId: user.id, source: kind });
    }
    await this.mailLog(kind === 'forward' ? 'forwarded' : 'redirected', m, user.id, `to ${targets.join(', ')}`);
  }

  // -------------------------------------------------------------------------
  // Auto-reply (RFC 3834)
  // -------------------------------------------------------------------------

  /** Returns the address to answer, or null when RFC 3834 says not to respond. */
  private async autoReplyTarget(user: UserInfo, rm: RuleMessage, m: StoredMessage, internalOnly: boolean): Promise<string | null> {
    const h = (n: string) => rm.header(n).map((v) => v.toLowerCase());
    const auto = h('auto-submitted')[0];
    if (auto && auto !== 'no') return null;
    if (h('precedence').some((p) => ['bulk', 'list', 'junk'].includes(p.trim()))) return null;
    if (['list-id', 'list-unsubscribe', 'list-post'].some((n) => h(n).length)) return null;
    if (h('x-auto-response-suppress').some((v) => /all|oof|autoreply/.test(v))) return null;
    const target = (rm.envelopeFrom || rm.addresses('from').emails[0] || '').toLowerCase();
    if (!target || /^(mailer-daemon|postmaster|no-?reply|do-?not-?reply|bounce)/.test(target.split('@')[0] ?? '')) return null;
    const mine = await this.directory.userAddresses(user.id);
    if (mine.includes(target)) return null;
    // Only when we were addressed directly (not Bcc / list copies).
    const addressed = [...rm.addresses('to').emails, ...rm.addresses('cc').emails];
    if (!addressed.some((a) => mine.includes(a))) return null;
    if (internalOnly && !(await this.isLocalDomain(target))) return null;
    void m;
    return target;
  }

  private async autoReply(user: UserInfo, rm: RuleMessage, m: StoredMessage, cfg: { subject: string; body: string; oncePerDays: number; internalOnly: boolean; key: string }): Promise<void> {
    const target = await this.autoReplyTarget(user, rm, m, cfg.internalOnly);
    if (!target) return;
    const senderHash = createHash('sha256').update(`${cfg.key}:${target}`).digest();
    const prev = await one<{ sent_at: Date }>(this.db, 'SELECT sent_at FROM autoreply_log WHERE user_id = ? AND sender_hash = ?', [user.id, senderHash]);
    if (prev && Date.now() - new Date(prev.sent_at).getTime() < cfg.oncePerDays * 86400_000) return;
    await exec(this.db, 'INSERT INTO autoreply_log (user_id, sender_hash, sent_at) VALUES (?,?,?) ON DUPLICATE KEY UPDATE sent_at = VALUES(sent_at)', [user.id, senderHash, new Date()]);
    const subject = cfg.subject.replace(/\{subject\}/g, m.parsed.subject ?? '');
    const mid = m.parsed.messageId;
    const raw = await new MailComposer({
      from: { name: user.display_name, address: user.login },
      to: target,
      subject,
      text: cfg.body,
      ...(mid ? { inReplyTo: mid, references: mid } : {}),
      headers: { 'Auto-Submitted': 'auto-replied', 'X-Auto-Response-Suppress': 'All', 'X-VPM-Loop': this.config.installId },
    })
      .compile()
      .build();
    await this.send({ raw, envelopeFrom: user.login, to: [target], senderUserId: user.id, source: 'autoreply' });
    await this.mailLog('autoreply', m, user.id, `to ${target}`);
  }

  private async outOfOffice(user: UserInfo, rm: RuleMessage, m: StoredMessage): Promise<void> {
    const a = await one<{ is_enabled: number; subject: string; body_text: string; starts_at: Date | null; ends_at: Date | null; internal_only: number; once_per_days: number }>(
      this.db,
      'SELECT * FROM autoreplies WHERE user_id = ? AND is_enabled = 1',
      [user.id],
    );
    if (!a) return;
    const now = Date.now();
    if ((a.starts_at && now < new Date(a.starts_at).getTime()) || (a.ends_at && now > new Date(a.ends_at).getTime())) return;
    await this.autoReply(user, rm, m, { subject: a.subject, body: a.body_text, oncePerDays: a.once_per_days, internalOnly: Boolean(a.internal_only), key: 'ooo' });
  }

  // -------------------------------------------------------------------------
  // Journaling
  // -------------------------------------------------------------------------

  private async journal(o: { message: StoredMessage; direction: Direction; senderUserId: number | null; recipientUserIds: number[]; envelopeFrom: string; envelopeTo: string[] }): Promise<void> {
    const list = await rows<JournalRow>(this.db, 'SELECT * FROM journal_rules WHERE is_enabled = 1');
    if (!list.length) return;
    const sides: ('in' | 'out')[] = o.direction === 'in' ? ['in'] : o.direction === 'out' ? ['out'] : ['in', 'out'];
    const policy = await this.policy();
    const rm = new RuleMessage(o.message.parsed, o.message.raw, o.direction, o.envelopeFrom);
    const userCache = new Map<number, UserInfo | undefined>();
    const groupCache = new Map<number, Set<number>>();
    const inScope = async (r: JournalRow, uid: number | null): Promise<boolean> => {
      if (r.scope === 'all') return true;
      if (!uid) return false;
      if (r.scope === 'user') return uid === r.scope_id;
      if (r.scope === 'domain') {
        if (!userCache.has(uid)) userCache.set(uid, await this.user(uid));
        return userCache.get(uid)?.domain_id === r.scope_id;
      }
      if (!groupCache.has(r.scope_id!)) {
        const m = await rows<{ user_id: number }>(this.db, 'SELECT user_id FROM user_group_members WHERE group_id = ?', [r.scope_id]);
        groupCache.set(r.scope_id!, new Set(m.map((x) => x.user_id)));
      }
      return groupCache.get(r.scope_id!)!.has(uid);
    };

    const targets = new Map<string, number[]>();
    for (const r of list) {
      if (o.direction === 'internal' && !r.include_internal) continue;
      let hit = false;
      for (const side of sides) {
        if (r.direction !== 'both' && r.direction !== side) continue;
        const users = side === 'in' ? o.recipientUserIds : [o.senderUserId];
        for (const u of users) if (await inScope(r, u ?? null)) hit = true;
      }
      if (!hit) continue;
      const conditions = json<Condition[] | null>(r.conditions) ?? [];
      try {
        if (!ruleMatches({ match_mode: r.match_mode, conditions }, rm, policy.timezone)) continue;
      } catch {
        continue;
      }
      const t = r.target_address.toLowerCase();
      targets.set(t, [...(targets.get(t) ?? []), r.id]);
    }
    for (const [target, ruleIds] of targets) {
      const raw = prependHeaders(o.message.raw, [
        ['X-VPM-Loop', this.config.installId],
        ['X-VPM-Journal', o.direction],
        ['X-VPM-Journal-Envelope-From', o.envelopeFrom || '<>'],
        ['X-VPM-Journal-Envelope-To', o.envelopeTo.join(', ').slice(0, 900)],
      ]);
      await this.send({ raw, envelopeFrom: '', to: [target], senderUserId: null, source: 'journal' });
      await exec(this.db, 'UPDATE journal_rules SET hit_count = hit_count + 1, last_hit_at = ? WHERE id IN (?)', [new Date(), ruleIds]).catch(() => {});
    }
  }

  private async archive(m: StoredMessage, direction: Direction, envelopeFrom: string, envelopeTo: string[], userIds: number[]): Promise<void> {
    if (!this.archiver) return;
    try {
      await this.archiver.archive({ messageId: m.id, size: m.size, subject: m.parsed.subject, date: m.parsed.date, direction, envelopeFrom, envelopeTo, userIds });
    } catch (err) {
      this.log.error({ err }, 'archiving failed');
    }
  }

  // -------------------------------------------------------------------------
  // Inbound
  // -------------------------------------------------------------------------

  async inbound(r: InboundRequest): Promise<DeliveryOutcome[]> {
    const outcomes: DeliveryOutcome[] = [];
    const m = r.message;
    const loop = loopCount(m.raw, this.config.installId) > 0 || receivedCount(m.raw) > MAX_RECEIVED_FOR_FORWARD;
    const policy = await this.policy();
    const delivered: number[] = [];
    const seen = new Set<number>();

    for (const rcpt of r.recipients) {
      if (seen.has(rcpt.userId)) continue;
      seen.add(rcpt.userId);
      const user = await this.user(rcpt.userId);
      if (!user) continue;
      const rm = new RuleMessage(m.parsed, m.raw, r.direction, r.envelopeFrom);
      const plan = planDelivery(await this.rulesFor(user.id), rm, policy.timezone, 'inbound');
      void this.countHits(plan.matched);

      // Personal forwarding settings (admin- or user-configured).
      const fwd = await rows<{ target_address: string; keep_local_copy: number }>(this.db, 'SELECT target_address, keep_local_copy FROM forwardings WHERE user_id = ? AND is_enabled = 1', [user.id]);
      for (const f of fwd) (f.keep_local_copy ? plan.forwards : plan.redirects).push(f.target_address);

      if (plan.reject) {
        const dup = await this.delivery.recordOnly(user.id, m);
        outcomes.push({ userId: user.id, status: dup ? 'duplicate' : 'rejected' });
        if (!dup) {
          await this.mailLog('rejected', m, user.id, plan.reject, r.direction);
          if (r.direction === 'internal' && r.senderUserId) await this.notifyRejected(r.senderUserId, r.envelopeFrom, user.login, plan.reject, m);
        }
        continue;
      }
      if (plan.discard) {
        const dup = await this.delivery.recordOnly(user.id, m);
        outcomes.push({ userId: user.id, status: dup ? 'duplicate' : 'discarded' });
        if (!dup) await this.mailLog('discarded', m, user.id, `rule ${plan.matched.join(',')}`, r.direction);
        continue;
      }

      // A redirect means "no local copy" unless a move/copy rule explicitly files it.
      const keepLocal = plan.redirects.length === 0 || plan.folder !== null || plan.copies.length > 0;
      if (keepLocal) {
        const variant = plan.addHeaders.length ? await this.store.ingest(prependHeaders(m.raw, plan.addHeaders)) : undefined;
        const folderId = plan.folder ? await this.ensureFolder(user.id, plan.folder) : (rcpt.folderId ?? undefined);
        const [o] = await this.delivery.deliver({
          message: m,
          targets: [{ userId: user.id, ...(folderId ? { folderId } : {}), flags: plan.flags, ...(variant ? { message: variant } : {}) }],
          origin: r.origin,
          envelopeFrom: r.envelopeFrom,
          externalAccountId: r.externalAccountId ?? null,
          clientIp: r.clientIp ?? null,
          ignoreQuota: r.ignoreQuota ?? false,
        });
        outcomes.push(o!);
        if (o!.status !== 'delivered') continue; // duplicate / over quota / failed: no side effects
        for (const path of plan.copies) {
          const cf = await this.ensureFolder(user.id, path);
          if (cf !== o!.folderId) await this.delivery.deliver({ message: m, targets: [{ userId: user.id, folderId: cf, flags: plan.flags, ...(variant ? { message: variant } : {}) }], origin: 'rule', envelopeFrom: r.envelopeFrom, dedup: false, ignoreQuota: true });
        }
      } else {
        const dup = await this.delivery.recordOnly(user.id, m);
        outcomes.push({ userId: user.id, status: dup ? 'duplicate' : 'discarded' });
        if (dup) continue;
      }
      delivered.push(user.id);

      if (loop) {
        if (plan.forwards.length || plan.redirects.length || plan.autoReplies.length) await this.mailLog('loop_blocked', m, user.id, 'X-VPM-Loop present; forwarding and auto-replies skipped', r.direction);
        continue;
      }
      try {
        if (plan.forwards.length) await this.forward(user, m, plan.forwards, 'forward');
        if (plan.redirects.length) await this.forward(user, m, plan.redirects, 'redirect');
        for (const ar of plan.autoReplies) await this.autoReply(user, rm, m, { subject: ar.subject, body: ar.body, oncePerDays: 4, internalOnly: false, key: `rule${ar.ruleId}` });
        await this.outOfOffice(user, rm, m);
      } catch (err) {
        this.log.error({ err, userId: user.id }, 'post-delivery action failed');
      }
    }

    if (!r.skipJournal && delivered.length) {
      const logins = await rows<{ login: string }>(this.db, 'SELECT login FROM users WHERE id IN (?)', [delivered]);
      await this.archive(m, r.direction, r.envelopeFrom, logins.map((l) => l.login), [...delivered, ...(r.senderUserId ? [r.senderUserId] : [])]);
      await this.journal({
        message: m,
        direction: r.direction,
        senderUserId: r.senderUserId ?? null,
        recipientUserIds: delivered,
        envelopeFrom: r.envelopeFrom,
        envelopeTo: logins.map((l) => l.login),
      }).catch((err) => this.log.error({ err }, 'journaling failed'));
    }
    return outcomes;
  }

  private async notifyRejected(senderUserId: number, envelopeFrom: string, rcpt: string, reason: string, m: StoredMessage): Promise<void> {
    const dsn = buildDsn({ hostname: this.config.hostname, to: envelopeFrom, originalHeaders: m.parsed.headerRaw, failures: [{ rcpt, code: 550, response: `550 5.7.1 ${reason}` }], queueId: 0, arrival: new Date() });
    const notice = await this.store.ingest(dsn);
    await this.delivery.deliver({ message: notice, targets: [{ userId: senderUserId }], origin: 'internal', envelopeFrom: '', dedup: false, ignoreQuota: true });
  }

  // -------------------------------------------------------------------------
  // LAN submission
  // -------------------------------------------------------------------------

  async submission(r: SubmissionRequest): Promise<SubmissionResult> {
    const policy = await this.policy();
    let outMessage = r.message;
    const bcc: string[] = [];
    if (r.external.length) {
      const rm = new RuleMessage(r.message.parsed, r.message.raw, 'out', r.envelopeFrom);
      const rules = (await this.rulesFor(null)).filter((x) => x.stage !== 'inbound');
      const plan = planDelivery(rules, rm, policy.timezone, 'outbound');
      void this.countHits(plan.matched);
      if (plan.reject) {
        await this.mailLog('rejected', r.message, r.senderUserId, plan.reject, 'out');
        return { rejected: plan.reject, outcomes: [], queueId: null };
      }
      if (plan.discard) {
        await this.mailLog('discarded', r.message, r.senderUserId, `outbound rule ${plan.matched.join(',')}`, 'out');
        r = { ...r, external: [] };
      }
      if (plan.addHeaders.length) outMessage = await this.store.ingest(prependHeaders(r.message.raw, plan.addHeaders));
      bcc.push(...plan.forwards);
    }

    const outcomes = r.localUserIds.length
      ? await this.inbound({
          message: r.message,
          recipients: r.localUserIds.map((userId) => ({ userId })),
          origin: 'lan_smtp',
          direction: 'internal',
          envelopeFrom: r.envelopeFrom,
          senderUserId: r.senderUserId,
          clientIp: r.clientIp ?? null,
          skipJournal: true,
        })
      : [];

    let queueId: number | null = null;
    if (r.external.length) {
      queueId = await this.delivery.enqueueOutbound({ message: outMessage, envelopeFrom: r.envelopeFrom, recipients: r.external, senderUserId: r.senderUserId, source: 'submission' });
    }
    if (bcc.length) {
      const user = await this.user(r.senderUserId);
      if (user) await this.forward(user, outMessage, bcc, 'forward');
    }
    const delivered = outcomes.filter((o) => o.status === 'delivered').map((o) => o.userId);
    if (r.external.length || delivered.length) {
      const logins = delivered.length ? (await rows<{ login: string }>(this.db, 'SELECT login FROM users WHERE id IN (?)', [delivered])).map((l) => l.login) : [];
      await this.archive(r.message, r.external.length ? 'out' : 'internal', r.envelopeFrom, [...r.external, ...logins], [r.senderUserId, ...delivered]);
      await this.journal({
        message: r.message,
        direction: r.external.length ? 'out' : 'internal',
        senderUserId: r.senderUserId,
        recipientUserIds: delivered,
        envelopeFrom: r.envelopeFrom,
        envelopeTo: [...r.external, ...logins],
      }).catch((err) => this.log.error({ err }, 'journaling failed'));
    }
    return { rejected: null, outcomes, queueId };
  }
}
