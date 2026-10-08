import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { get, when } from '../api';
import { Badge, Card, Empty, ErrorBanner, Input, PageHeader, Spinner, Table, Td, useResource } from '../ui';

// Every activated PostMaster server on one screen, from their hourly health reports.

type State = 'problem' | 'silent' | 'warning' | 'no_data' | 'ok' | 'offline';

interface Health {
  at: string;
  status: 'ok' | 'warning' | 'problem';
  issues: { level: 'problem' | 'warning'; text: string }[];
  version: string;
  uptimeHours: number;
  diskFreePct: number | null;
  diskFreeGb: number | null;
  dbOk: boolean;
  mailboxes: number;
  queue: { waiting: number; oldestMinutes: number | null; failed24h: number; sent24h: number };
  fetch: { accounts: number; failing: number; authFailed: number };
  backup: { lastOkAt: string | null; ageHours: number | null; scheduled: boolean };
  certDaysLeft: number | null;
  alerts: { critical: number; warning: number };
  licenseMode: string;
}
interface ServerRow {
  id: number;
  licenseRowId: number;
  licenseId: string;
  company: string;
  city: string | null;
  phone: string | null;
  plan: string;
  hostname: string | null;
  version: string | null;
  mode: string;
  activeUsers: number | null;
  maxUsers: number;
  lastSeenAt: string | null;
  healthAt: string | null;
  health: Health | null;
  reseller: string | null;
  state: State;
}

export const STATE: Record<State, { label: string; color: 'red' | 'amber' | 'green' | 'slate' | 'blue'; help: string }> = {
  problem: { label: 'Problem', color: 'red', help: 'Needs attention now' },
  silent: { label: 'Not reporting', color: 'red', help: 'No report for over 3 hours: server off, no internet, or PostMaster stopped' },
  warning: { label: 'Warning', color: 'amber', help: 'Working, but something should be looked at' },
  no_data: { label: 'No health data', color: 'slate', help: 'Checks in for its licence, but runs a version without health reports: update to 0.6.6 or later' },
  ok: { label: 'OK', color: 'green', help: 'All checks passed' },
  offline: { label: 'Offline licence', color: 'blue', help: 'Licensed by file, without internet: no reports' },
};

const ago = (iso: string | null) => {
  if (!iso) return 'never';
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 48 * 60) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

export function ServersPage() {
  const [tick, setTick] = useState(0);
  const data = useResource(() => get<{ items: ServerRow[]; summary: Record<State, number> }>('/api/servers'), [tick]);
  const [q, setQ] = useState('');
  const [only, setOnly] = useState<State | 'attention' | ''>('');
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, []);
  const items = (data.data?.items ?? []).filter(
    (s) =>
      (!only || (only === 'attention' ? ['problem', 'silent', 'warning'].includes(s.state) : s.state === only)) &&
      `${s.company} ${s.city ?? ''} ${s.hostname ?? ''} ${s.licenseId}`.toLowerCase().includes(q.toLowerCase()),
  );
  const sum = data.data?.summary;
  const attention = sum ? sum.problem + sum.silent + sum.warning : 0;

  return (
    <>
      <PageHeader title="Client servers" description="Health of every activated PostMaster server, from their hourly reports. Problems are listed first; the page refreshes every minute." />
      <ErrorBanner error={data.error} />
      {sum && (
        <div className="mb-4 flex flex-wrap gap-2">
          <button onClick={() => setOnly('')} className={`rounded-md px-3 py-1.5 text-sm ring-1 ${only === '' ? 'bg-slate-900 text-white ring-slate-900' : 'bg-white text-slate-700 ring-slate-200 hover:bg-slate-50'}`}>
            All {data.data!.items.length}
          </button>
          <button
            onClick={() => setOnly('attention')}
            className={`rounded-md px-3 py-1.5 text-sm ring-1 ${only === 'attention' ? 'bg-red-600 text-white ring-red-600' : 'bg-white text-red-700 ring-red-200 hover:bg-red-50'}`}
          >
            Need attention {attention}
          </button>
          {(Object.keys(STATE) as State[]).map((s) =>
            sum[s] ? (
              <button key={s} onClick={() => setOnly(s)} title={STATE[s].help} className={`rounded-md px-1 py-1 ring-1 ${only === s ? 'ring-slate-900' : 'ring-transparent'}`}>
                <Badge color={STATE[s].color}>
                  {STATE[s].label} {sum[s]}
                </Badge>
              </button>
            ) : null,
          )}
          <div className="ml-auto w-full sm:w-64">
            <Input placeholder="Find client or server" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find client or server" />
          </div>
        </div>
      )}
      <Card>
        {!data.data ? (
          <Spinner />
        ) : !items.length ? (
          <Empty>{data.data.items.length ? 'No server matches.' : 'No activated servers yet.'}</Empty>
        ) : (
          <Table head={['Client', 'Server', 'Status', 'What needs attention', 'Backup', 'Disk', 'Last report']}>
            {items.map((s) => {
              const h = s.health;
              return (
                <tr key={s.id} className="align-top">
                  <Td>
                    <Link to={`/licenses/${s.licenseRowId}`} className="font-medium text-brand-700 hover:underline">
                      {s.company}
                    </Link>
                    <div className="text-xs text-slate-500">
                      {[s.city, s.plan, s.reseller ? `via ${s.reseller}` : null].filter(Boolean).join(' · ')}
                    </div>
                    {s.phone && <div className="text-xs text-slate-500">{s.phone}</div>}
                  </Td>
                  <Td>
                    <div className="text-sm">{s.hostname ?? '—'}</div>
                    <div className="text-xs text-slate-500">
                      v{s.version ?? '?'} · {s.activeUsers ?? '–'}/{s.maxUsers} users
                    </div>
                  </Td>
                  <Td>
                    <span title={STATE[s.state].help}>
                      <Badge color={STATE[s.state].color}>{STATE[s.state].label}</Badge>
                    </span>
                  </Td>
                  <Td className="max-w-sm">
                    {s.state === 'silent' ? (
                      <span className="text-sm text-red-700">No report since {s.healthAt ? when(s.healthAt) : s.lastSeenAt ? when(s.lastSeenAt) : 'activation'}</span>
                    ) : h?.issues.length ? (
                      <ul className="space-y-0.5 text-sm">
                        {h.issues.map((i, n) => (
                          <li key={n} className={i.level === 'problem' ? 'text-red-700' : 'text-amber-800'}>
                            {i.text}
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="text-sm text-slate-400">{s.state === 'ok' ? 'Nothing' : '—'}</span>
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-xs">{h ? (h.backup.lastOkAt ? ago(h.backup.lastOkAt) : h.backup.scheduled ? 'never' : 'not set up') : '—'}</Td>
                  <Td className="whitespace-nowrap text-xs tabular-nums">{h?.diskFreePct != null ? `${h.diskFreePct}% free${h.diskFreeGb != null ? ` (${h.diskFreeGb} GB)` : ''}` : '—'}</Td>
                  <Td className="whitespace-nowrap text-xs">{ago(s.healthAt ?? s.lastSeenAt)}</Td>
                </tr>
              );
            })}
          </Table>
        )}
      </Card>
    </>
  );
}
