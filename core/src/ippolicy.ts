import ipaddr from 'ipaddr.js';
import type { Db } from './db.js';
import { rows } from './db.js';

export type IpScope = 'web' | 'admin' | 'imap' | 'pop3' | 'smtp';

interface Rule {
  range: [ipaddr.IPv4 | ipaddr.IPv6, number];
  scopes: Set<string>;
}

const TTL_MS = 30_000;

/** Parses "10.0.0.0/8", "192.168.1.5" or "fd00::/8". Throws on invalid input. */
export function parseCidr(cidr: string): [ipaddr.IPv4 | ipaddr.IPv6, number] {
  const s = cidr.trim();
  if (s.includes('/')) return ipaddr.parseCIDR(s);
  const a = ipaddr.parse(s);
  return [a, a.kind() === 'ipv4' ? 32 : 128];
}

/**
 * LAN IP allowlist. If no rule applies to a scope, everything is allowed for
 * that scope. Loopback is always allowed so the server console can never be
 * locked out.
 */
export class IpPolicy {
  private rules: Rule[] | null = null;
  private loadedAt = 0;

  constructor(private readonly db: Db) {}

  invalidate(): void {
    this.rules = null;
  }

  private async load(): Promise<Rule[]> {
    if (this.rules && Date.now() - this.loadedAt < TTL_MS) return this.rules;
    const r = await rows<{ cidr: string; applies_to: string }>(this.db, 'SELECT cidr, applies_to FROM ip_allowlist');
    const out: Rule[] = [];
    for (const x of r) {
      try {
        out.push({ range: parseCidr(x.cidr), scopes: new Set(String(x.applies_to).split(',')) });
      } catch {
        /* invalid rows are ignored; the API validates on write */
      }
    }
    this.rules = out;
    this.loadedAt = Date.now();
    return out;
  }

  async allowed(ip: string, scope: IpScope): Promise<boolean> {
    const rules = (await this.load()).filter((r) => r.scopes.has(scope));
    if (!rules.length) return true;
    let addr: ipaddr.IPv4 | ipaddr.IPv6;
    try {
      addr = ipaddr.process(ip); // maps ::ffff:a.b.c.d to IPv4
    } catch {
      return false;
    }
    if (addr.range() === 'loopback') return true;
    return rules.some((r) => addr.kind() === r.range[0].kind() && addr.match(r.range as [ipaddr.IPv4, number]));
  }
}
