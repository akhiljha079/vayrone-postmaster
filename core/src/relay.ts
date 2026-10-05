// Outbound relay targets. Resolution order (docs/ARCHITECTURE.md §5.3):
//   user route → domain route → domain smart host → default relay account.
// A route may point at the employee's own provider account instead of a relay
// account; that is the workaround for providers that refuse a From address
// different from the authenticated login.
import nodemailer, { type Transporter, type TransportOptions } from 'nodemailer';
import type { Queryable } from './db.js';
import { one } from './db.js';
import type { SecretBox } from './secrets.js';
import { splitAddress } from './directory.js';

export type Security = 'none' | 'starttls' | 'tls';

export interface RelayTarget {
  /** Stable cache key for pooled transports. */
  key: string;
  kind: 'relay' | 'external';
  id: number;
  name: string;
  host: string;
  port: number;
  security: Security;
  tlsVerify: boolean;
  authUser: string | null;
  secret: Buffer | null;
  envelopeFrom: 'relay_account' | 'original_sender';
  setSenderHeader: boolean;
  maxConnections: number;
  maxPerMinute: number | null;
}

interface RelayRow {
  id: number;
  name: string;
  host: string;
  port: number;
  security: Security;
  auth_user: string | null;
  auth_secret: Buffer | null;
  envelope_from: 'relay_account' | 'original_sender';
  set_sender_header: number;
  max_msgs_per_min: number | null;
  max_connections: number;
  tls_verify: number;
  is_enabled: number;
  updated_at: Date;
}

export function relayTargetFromRow(r: RelayRow): RelayTarget {
  return {
    key: `relay:${r.id}:${new Date(r.updated_at).getTime()}`,
    kind: 'relay',
    id: r.id,
    name: r.name,
    host: r.host,
    port: r.port,
    security: r.security,
    tlsVerify: Boolean(r.tls_verify),
    authUser: r.auth_user,
    secret: r.auth_secret,
    envelopeFrom: r.envelope_from,
    setSenderHeader: Boolean(r.set_sender_header),
    maxConnections: r.max_connections || 2,
    maxPerMinute: r.max_msgs_per_min,
  };
}

async function relayById(q: Queryable, id: number | null | undefined): Promise<RelayTarget | null> {
  if (!id) return null;
  const r = await one<RelayRow>(q, 'SELECT * FROM relay_accounts WHERE id = ? AND is_enabled = 1', [id]);
  return r ? relayTargetFromRow(r) : null;
}

async function externalById(q: Queryable, id: number | null | undefined): Promise<RelayTarget | null> {
  if (!id) return null;
  const r = await one<{
    id: number;
    label: string | null;
    username: string;
    secret: Buffer;
    smtp_host: string | null;
    smtp_port: number | null;
    smtp_security: Security | null;
    tls_verify: number;
    is_enabled: number;
    updated_at: Date;
  }>(q, 'SELECT * FROM external_accounts WHERE id = ? AND can_send_as = 1', [id]);
  if (!r || !r.smtp_host || !r.smtp_port) return null;
  return {
    key: `ext:${r.id}:${new Date(r.updated_at).getTime()}`,
    kind: 'external',
    id: r.id,
    name: r.label ?? r.username,
    host: r.smtp_host,
    port: r.smtp_port,
    security: r.smtp_security ?? 'starttls',
    tlsVerify: Boolean(r.tls_verify),
    authUser: r.username,
    secret: r.secret,
    // The employee's own account: the From address already matches the login.
    envelopeFrom: 'original_sender',
    setSenderHeader: false,
    maxConnections: 1,
    maxPerMinute: null,
  };
}

/** Resolves the relay for a queued message. Returns null when nothing is configured. */
export async function resolveRelay(q: Queryable, senderUserId: number | null, envelopeFrom: string): Promise<RelayTarget | null> {
  if (senderUserId) {
    const ur = await one<{ relay_account_id: number | null; via_external_account_id: number | null }>(
      q,
      "SELECT relay_account_id, via_external_account_id FROM relay_routes WHERE scope = 'user' AND user_id = ? AND is_enabled = 1",
      [senderUserId],
    );
    const t = ur ? ((await externalById(q, ur.via_external_account_id)) ?? (await relayById(q, ur.relay_account_id))) : null;
    if (t) return t;
  }
  const domain = splitAddress(envelopeFrom)?.domain;
  if (domain) {
    const d = await one<{ id: number; smart_host_relay_id: number | null }>(q, 'SELECT id, smart_host_relay_id FROM domains WHERE name = ?', [domain]);
    if (d) {
      const dr = await one<{ relay_account_id: number | null; via_external_account_id: number | null }>(
        q,
        "SELECT relay_account_id, via_external_account_id FROM relay_routes WHERE scope = 'domain' AND domain_id = ? AND is_enabled = 1",
        [d.id],
      );
      const t = (dr ? ((await externalById(q, dr.via_external_account_id)) ?? (await relayById(q, dr.relay_account_id))) : null) ?? (await relayById(q, d.smart_host_relay_id));
      if (t) return t;
    }
  }
  const def = await one<RelayRow>(q, 'SELECT * FROM relay_accounts WHERE is_default = 1 AND is_enabled = 1 ORDER BY id LIMIT 1');
  return def ? relayTargetFromRow(def) : null;
}

export function createTransport(t: RelayTarget, secrets: SecretBox, opts: { hostname: string; pool?: boolean }): Transporter {
  const pass = t.secret ? secrets.open(Buffer.from(t.secret)) : undefined;
  return nodemailer.createTransport({
    host: t.host,
    port: t.port,
    secure: t.security === 'tls',
    requireTLS: t.security === 'starttls',
    ignoreTLS: t.security === 'none',
    name: opts.hostname,
    ...(t.authUser ? { auth: { user: t.authUser, pass: pass ?? '' } } : {}),
    tls: { rejectUnauthorized: t.tlsVerify, servername: t.host },
    connectionTimeout: 30_000,
    greetingTimeout: 30_000,
    socketTimeout: 120_000,
    ...(opts.pool ? { pool: true, maxConnections: t.maxConnections, maxMessages: 100 } : {}),
  } as TransportOptions);
}
