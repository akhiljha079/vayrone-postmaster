// Connection limits for the mail protocols (one limiter per process, shared by
// SMTP, IMAP and POP3): a total cap and a per-address cap, so one misbehaving
// client or a scan cannot exhaust the server. Offices behind one NAT address
// can raise the per-address limit in the config file (limits.maxPerIp).
export interface ConnectionLimits {
  maxConnections: number;
  maxPerIp: number;
}

export const DEFAULT_LIMITS: ConnectionLimits = { maxConnections: 5000, maxPerIp: 300 };

export class ConnectionLimiter {
  private total = 0;
  private readonly perIp = new Map<string, number>();

  constructor(private readonly limits: ConnectionLimits = DEFAULT_LIMITS) {}

  /** Returns a release function, or null when the connection must be refused. */
  acquire(ip: string | undefined): (() => void) | null {
    const key = (ip ?? 'unknown').replace(/^::ffff:/, '');
    const n = this.perIp.get(key) ?? 0;
    if (this.total >= this.limits.maxConnections || n >= this.limits.maxPerIp) return null;
    this.total++;
    this.perIp.set(key, n + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.total--;
      const m = (this.perIp.get(key) ?? 1) - 1;
      if (m <= 0) this.perIp.delete(key);
      else this.perIp.set(key, m);
    };
  }

  get size(): number {
    return this.total;
  }
}
