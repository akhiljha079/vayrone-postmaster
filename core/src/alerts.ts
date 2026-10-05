import type { Queryable } from './db.js';
import { exec } from './db.js';

export type AlertSeverity = 'info' | 'warning' | 'critical';

/** Raises (or bumps) an admin alert. Alerts with the same dedupeKey are merged until resolved. */
export async function raiseAlert(q: Queryable, a: { severity: AlertSeverity; code: string; message: string; dedupeKey: string }): Promise<void> {
  const now = new Date();
  await exec(
    q,
    `INSERT INTO admin_alerts (severity, code, message, dedupe_key, first_at, last_at) VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE occurrences = occurrences + 1, last_at = VALUES(last_at), message = VALUES(message),
       severity = VALUES(severity), resolved_at = NULL`,
    [a.severity, a.code, a.message.slice(0, 1000), a.dedupeKey, now, now],
  );
}

export async function resolveAlert(q: Queryable, dedupeKey: string): Promise<void> {
  await exec(q, 'UPDATE admin_alerts SET resolved_at = ? WHERE dedupe_key = ? AND resolved_at IS NULL', [new Date(), dedupeKey]);
}
