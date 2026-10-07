import type { ReactNode } from 'react';
import { Badge } from './ui';

/**
 * Everything the signed licence says, as the client sees it in PostMaster itself
 * (Admin → Licence and the setup wizard). The licence file carries all of it, so
 * clients never need a Vayrone portal or login to see their licence details.
 */
export interface LicenseDetailsData {
  licenseId: string;
  keyHint: string;
  client: { name: string; contact?: string | null; email?: string | null; phone?: string | null; city?: string | null; gstin?: string | null };
  reseller: { name: string } | null;
  plan: { code: string; name: string };
  maxUsers: number;
  maxExternalAccounts: number | null;
  features: string[];
  issuedAt: string;
  expiresAt: string | null;
  amcExpiresAt: string | null;
  checkBy: string;
  activationMode: 'online' | 'offline';
  amcActive: boolean;
}

export const FEATURE_LABEL: Record<string, string> = {
  archive: 'Mail archive',
  backup_cloud: 'Cloud backup',
  antivirus: 'Antivirus',
  support_access: 'Vayrone Support access',
  journaling: 'Journaling',
  external_fetch: 'External mailboxes',
};

const day = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const daysFrom = (d: string) => Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-2 text-sm last:border-0">
      <span className="shrink-0 text-slate-500">{label}</span>
      <span className="min-w-0 break-words text-right font-medium text-slate-900">{children}</span>
    </div>
  );
}

export function LicenseDetails({ l }: { l: LicenseDetailsData }) {
  const c = l.client;
  return (
    <div>
      <Row label="Licensed to">
        {c.name}
        {c.city ? `, ${c.city}` : ''}
      </Row>
      {c.contact && <Row label="Contact person">{c.contact}</Row>}
      {c.email && <Row label="E-mail">{c.email}</Row>}
      {c.phone && <Row label="Phone">{c.phone}</Row>}
      {c.gstin && (
        <Row label="GSTIN">
          <span className="font-mono">{c.gstin}</span>
        </Row>
      )}
      <Row label="Plan">{l.plan.name}</Row>
      <Row label="Licensed users">{l.maxUsers}</Row>
      {l.maxExternalAccounts != null && <Row label="External mailboxes">up to {l.maxExternalAccounts}</Row>}
      <Row label="Licence number">
        <span className="font-mono">{l.licenseId}</span> <span className="text-xs text-slate-500">(key …{l.keyHint})</span>
      </Row>
      <Row label="Issued">{day(l.issuedAt)}</Row>
      <Row label="Valid until">
        {l.expiresAt ? (
          <>
            {day(l.expiresAt)}
            {daysFrom(l.expiresAt) >= 0 && <span className="ml-1 text-xs text-slate-500">({daysFrom(l.expiresAt)} days)</span>}
          </>
        ) : (
          'Perpetual (no expiry)'
        )}
      </Row>
      <Row label="AMC (updates and support)">
        {day(l.amcExpiresAt)} <Badge color={l.amcActive ? 'green' : 'red'}>{l.amcActive ? 'Active' : 'Expired'}</Badge>
      </Row>
      <Row label="Validation">
        {l.activationMode === 'online' ? 'Online, automatic' : 'Offline, by licence file'}, next due by {day(l.checkBy)}
      </Row>
      {l.reseller && <Row label="Partner">{l.reseller.name}</Row>}
      <Row label="Included">
        <span className="flex flex-wrap justify-end gap-1">
          {l.features.length ? (
            l.features.map((f) => (
              <Badge key={f} color="blue">
                {FEATURE_LABEL[f] ?? f}
              </Badge>
            ))
          ) : (
            <span className="text-slate-500">Core mail server</span>
          )}
        </span>
      </Row>
    </div>
  );
}

/** One line for confirmations: "Agra Steel Traders — Business, 50 users, valid until 6 Oct 2027". */
export function licenseSummary(l: LicenseDetailsData): string {
  return `${l.client.name} — ${l.plan.name}, ${l.maxUsers} users, ${l.expiresAt ? `valid until ${day(l.expiresAt)}` : 'perpetual'}`;
}
