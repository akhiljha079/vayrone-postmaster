// Pure licence evaluation: given the verified licence, the machine and the
// clock, decide the enforcement mode. Every process (core, web, worker)
// evaluates independently, so they always agree without coordination.
//
// Mail flow is never part of enforcement: SMTP/IMAP/POP3, fetching, relaying,
// archiving and backups keep running in every mode. Enforcement only limits
// user seats and features, makes the admin panel read-only and blocks new
// webmail logins (see core/src/license-gate.ts and server/src/guards.ts).
import type { LicenseMode } from '@vpm/core';
import type { LicensePayload, RevocationPayload } from './format.js';
import { matchFingerprint, type Fingerprint, type MatchResult } from './fingerprint.js';

export const GRACE_DAYS = 15;
/** Evaluation period of a fresh, not yet activated install. */
export const EVALUATION_DAYS = 30;
export const EVALUATION_LIMITS = { maxUsers: 5, maxExternalAccounts: 5, features: ['archive', 'journaling', 'external_fetch'] };
/** Clock moved back further than this below the highest trusted time → tampered. */
export const CLOCK_TOLERANCE_MS = 2 * 3600_000;
export const EXPIRY_WARN_DAYS = 30;
export const CHECK_WARN_DAYS = 7;

const DAY = 86_400_000;

export type LicenseStatus = 'unlicensed' | 'active' | 'grace' | 'expired' | 'tampered' | 'fingerprint_mismatch';

export interface EvalInput {
  now: Date;
  license: LicensePayload | null;
  /** A stored licence failed signature verification. */
  licenseError: string | null;
  revocation: RevocationPayload | null;
  fingerprint: Fingerprint;
  /** Highest trusted time seen (sealed high-water mark, signed server times, audit log). */
  clockFloor: Date | null;
  /** When this install first saw a fingerprint mismatch for the current licence. */
  mismatchSince: Date | null;
  installedAt: Date;
  integrity: 'ok' | 'skipped' | 'failed';
}

export interface Evaluation {
  status: LicenseStatus;
  mode: LicenseMode;
  /** One-line explanation for banners and the licence page. */
  reason: string;
  /** Non-blocking notice (expiring soon, validation due). */
  warning: string | null;
  /** End of the grace period (grace) or when it ended (read-only). */
  graceEndsAt: Date | null;
  /** When the current state ends without action (subscription end or validation due). */
  deadline: Date | null;
  maxUsers: number | null;
  maxExternalAccounts: number | null;
  features: string[];
  match: MatchResult | null;
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);
const days = (ms: number) => Math.max(0, Math.ceil(ms / DAY));

function limitsOf(l: LicensePayload | null) {
  return l ? { maxUsers: l.maxUsers, maxExternalAccounts: l.maxExternalAccounts, features: [...l.features] } : { ...EVALUATION_LIMITS, features: [...EVALUATION_LIMITS.features] };
}

function graceOrReadonly(now: Date, since: Date, base: Omit<Evaluation, 'mode' | 'graceEndsAt' | 'status' | 'reason'>, why: string, expiredStatus: LicenseStatus = 'expired', graceStatus: LicenseStatus = 'grace'): Evaluation {
  const graceEndsAt = new Date(since.getTime() + GRACE_DAYS * DAY);
  if (now < graceEndsAt) {
    return { ...base, status: graceStatus, mode: 'grace', graceEndsAt, reason: `${why} Grace period: ${days(graceEndsAt.getTime() - now.getTime())} day(s) left (until ${fmt(graceEndsAt)}). Mail keeps flowing.` };
  }
  return { ...base, status: expiredStatus, mode: 'readonly', graceEndsAt, reason: `${why} The grace period ended on ${fmt(graceEndsAt)}; the admin panel is read-only. Mail keeps flowing.` };
}

export function evaluate(i: EvalInput): Evaluation {
  const { now, license: l } = i;
  const limits = limitsOf(i.licenseError ? null : l);
  const base = { warning: null, deadline: null, match: null, ...limits };

  if (i.integrity === 'failed') {
    return { ...base, status: 'tampered', mode: 'readonly', graceEndsAt: null, reason: 'Program files were modified. Reinstall Vayrone PostMaster or contact Vayrone support. Mail keeps flowing.' };
  }
  if (i.clockFloor && now.getTime() < i.clockFloor.getTime() - CLOCK_TOLERANCE_MS) {
    return {
      ...base,
      status: 'tampered',
      mode: 'readonly',
      graceEndsAt: null,
      reason: `The server clock is set to ${fmt(now)}, before ${fmt(i.clockFloor)} which this server has already seen. Correct the date and time (enable automatic time sync). Mail keeps flowing.`,
    };
  }
  if (i.licenseError) {
    return { ...base, status: 'tampered', mode: 'readonly', graceEndsAt: null, reason: `The stored licence is not valid (${i.licenseError}). Re-activate or import the licence file again. Mail keeps flowing.` };
  }

  if (!l) {
    const end = new Date(i.installedAt.getTime() + EVALUATION_DAYS * DAY);
    if (now < end) {
      return {
        ...base,
        status: 'unlicensed',
        mode: 'unlicensed',
        graceEndsAt: null,
        deadline: end,
        reason: `Evaluation: ${days(end.getTime() - now.getTime())} day(s) left, up to ${EVALUATION_LIMITS.maxUsers} users. Activate a licence to continue.`,
      };
    }
    return { ...base, status: 'unlicensed', mode: 'readonly', graceEndsAt: null, deadline: end, reason: `The evaluation period ended on ${fmt(end)}. Activate a licence; until then the admin panel is read-only. Mail keeps flowing.` };
  }

  const match = matchFingerprint(l.activation.components, i.fingerprint.components);
  const withMatch = { ...base, match };
  if (!match.ok) {
    return graceOrReadonly(
      now,
      i.mismatchSince ?? now,
      withMatch,
      `This licence was activated on different hardware (changed: ${match.changed.join(', ') || 'all'}). Re-activate or transfer the licence.`,
      'fingerprint_mismatch',
      'fingerprint_mismatch',
    );
  }

  const r = i.revocation;
  if (r && r.licenseId === l.licenseId && r.activationId === l.activation.id && r.issuedAt >= l.issuedAt) {
    const why = r.reason === 'transferred' ? 'This licence was transferred to another server.' : r.reason === 'suspended' ? 'This licence was suspended by Vayrone.' : 'This licence was revoked by Vayrone.';
    return graceOrReadonly(now, new Date(r.issuedAt), withMatch, `${why} ${r.message}`.trim());
  }

  const expires = l.expiresAt ? new Date(l.expiresAt) : null;
  const checkBy = new Date(l.checkBy);
  const deadline = expires && expires < checkBy ? expires : checkBy;
  if (now <= deadline) {
    let warning: string | null = null;
    if (expires && expires.getTime() - now.getTime() < EXPIRY_WARN_DAYS * DAY) warning = `The licence expires on ${fmt(expires)} (${days(expires.getTime() - now.getTime())} day(s)). Renew to avoid interruption.`;
    else if (checkBy.getTime() - now.getTime() < CHECK_WARN_DAYS * DAY)
      warning =
        l.activation.mode === 'offline'
          ? `Offline re-validation is due by ${fmt(checkBy)}. Generate a request file on the Licence page and import the response.`
          : `The server could not reach the Vayrone License Server recently. Validation is due by ${fmt(checkBy)}; check internet access.`;
    return { ...withMatch, status: 'active', mode: 'active', graceEndsAt: null, deadline, warning, reason: `Licensed to ${l.client.name} — ${l.plan.name}, ${l.maxUsers} users.` };
  }
  const why =
    deadline === expires
      ? `The licence expired on ${fmt(expires)}.`
      : l.activation.mode === 'offline'
        ? `Offline re-validation was due on ${fmt(checkBy)}.`
        : `The licence could not be validated with the Vayrone License Server since ${fmt(new Date(l.issuedAt))}.`;
  return { ...graceOrReadonly(now, deadline, withMatch, why), deadline };
}
