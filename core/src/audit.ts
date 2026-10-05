// Append-only, hash-chained admin audit log.
// row_hash = SHA-256(prev_hash || canonical(row)); a verifier recomputes the
// chain and reports the first row that was altered or removed.
import { createHash } from 'node:crypto';
import type { Db } from './db.js';
import { exec, json, one, rows } from './db.js';

export interface AuditEntry {
  actorUserId?: number | null;
  actorLogin?: string | null;
  actorRole?: string | null;
  isSupport?: boolean;
  ip?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | number | null;
  details?: Record<string, unknown> | null;
}

const ZERO = Buffer.alloc(32);
const SECRET_KEY = /pass(word)?|secret|token|totp|key/i;

/** Removes anything that looks like a credential before it reaches the log. */
export function redact(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(x);
    return out;
  }
  return v;
}

/** JSON with recursively sorted keys — stable across MySQL/MariaDB JSON re-serialisation. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as object)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

interface Row {
  id: number;
  at: Date;
  actor_user_id: number | null;
  actor_login: string | null;
  actor_role: string | null;
  is_support: number;
  ip: string | null;
  action: string;
  target_type: string | null;
  target_id: string | null;
  details: unknown;
  prev_hash: Buffer;
  row_hash: Buffer;
}

function rowHash(prev: Buffer, r: Omit<Row, 'id' | 'prev_hash' | 'row_hash'>): Buffer {
  const body = canonical([
    new Date(r.at).toISOString(),
    r.actor_user_id,
    r.actor_login,
    r.actor_role,
    Number(r.is_support),
    r.ip,
    r.action,
    r.target_type,
    r.target_id,
    r.details === null || r.details === undefined ? null : json(r.details),
  ]);
  return createHash('sha256').update(prev).update(body).digest();
}

export class AuditLog {
  constructor(private readonly db: Db) {}

  async log(e: AuditEntry): Promise<void> {
    const c = await this.db.getConnection();
    try {
      // Serialise writers so the chain is linear (works on MySQL and MariaDB).
      await c.query("SELECT GET_LOCK('vpm_audit_chain', 10)");
      const last = await one<{ row_hash: Buffer }>(c, 'SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1');
      const prev = last?.row_hash ?? ZERO;
      const at = new Date();
      // JSON round-trip so the hashed form equals the stored form (drops undefined, stringifies Dates).
      const details = e.details ? (JSON.parse(JSON.stringify(redact(e.details))) as Record<string, unknown>) : null;
      const r = {
        at,
        actor_user_id: e.actorUserId ?? null,
        actor_login: e.actorLogin ?? null,
        actor_role: e.actorRole ?? null,
        is_support: e.isSupport ? 1 : 0,
        ip: e.ip ?? null,
        action: e.action,
        target_type: e.targetType ?? null,
        target_id: e.targetId === undefined || e.targetId === null ? null : String(e.targetId),
        details,
      };
      await exec(
        c,
        `INSERT INTO audit_log (at, actor_user_id, actor_login, actor_role, is_support, ip, action, target_type, target_id, details, prev_hash, row_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [r.at, r.actor_user_id, r.actor_login, r.actor_role, r.is_support, r.ip, r.action, r.target_type, r.target_id, details ? JSON.stringify(details) : null, prev, rowHash(prev, r)],
      );
    } finally {
      await c.query("SELECT RELEASE_LOCK('vpm_audit_chain')").catch(() => {});
      c.release();
    }
  }

  /** Recomputes the chain. Returns the id of the first inconsistent row, if any. */
  async verify(): Promise<{ ok: boolean; count: number; brokenAt?: number }> {
    let prev = ZERO;
    let count = 0;
    let lastId = 0;
    for (;;) {
      const batch = await rows<Row>(this.db, 'SELECT * FROM audit_log WHERE id > ? ORDER BY id LIMIT 1000', [lastId]);
      if (!batch.length) return { ok: true, count };
      for (const r of batch) {
        if (!Buffer.from(r.prev_hash).equals(prev) || !rowHash(prev, r).equals(Buffer.from(r.row_hash))) {
          return { ok: false, count, brokenAt: r.id };
        }
        prev = Buffer.from(r.row_hash);
        lastId = r.id;
        count++;
      }
    }
  }
}
