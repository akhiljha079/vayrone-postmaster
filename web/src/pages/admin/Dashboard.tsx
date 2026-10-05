import { Link } from 'react-router-dom';
import { formatBytes, formatDate, get, post } from '../../api';
import { Badge, Button, Card, ErrorBanner, PageHeader, Spinner, Table, Td, useResource } from '../../components/ui';

interface Dash {
  users: { total: number; enabled: number; licensed: number; maxLicensed: number | null };
  domains: number;
  queue: Record<string, number>;
  alerts: { id: number; severity: 'info' | 'warning' | 'critical'; code: string; message: string; lastAt: string; occurrences: number }[];
  storage: { bytes: number; messages: number };
  recentLogins: { at: string; login: string; protocol: string; ip: string; success: number; reason: string | null }[];
}

function Stat({ label, value, sub, to }: { label: string; value: string | number; sub?: string; to?: string }) {
  const body = (
    <div className="rounded-lg bg-white p-4 shadow-sm ring-1 ring-slate-200 transition hover:ring-brand-300">
      <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-xs text-slate-500">{sub}</div>}
    </div>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function Dashboard() {
  const d = useResource(() => get<Dash>('/api/admin/dashboard'));
  if (d.loading && !d.data) return <Spinner />;
  const x = d.data;
  const waiting = (x?.queue.queued ?? 0) + (x?.queue.deferred ?? 0) + (x?.queue.sending ?? 0);
  return (
    <div>
      <PageHeader title="Dashboard" actions={<Button variant="secondary" onClick={d.reload}>Refresh</Button>} />
      <ErrorBanner error={d.error} />
      {x && (
        <>
          <div className="mb-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Stat label="Licensed mailboxes" value={x.users.maxLicensed ? `${x.users.licensed} / ${x.users.maxLicensed}` : x.users.licensed} sub={`${x.users.total} accounts in total`} to="/admin/users" />
            <Stat label="Outgoing queue" value={waiting} sub={`${x.queue.deferred ?? 0} retrying · ${x.queue.held ?? 0} held · ${x.queue.failed ?? 0} failed`} to="/admin/queue" />
            <Stat label="Mail storage" value={formatBytes(x.storage.bytes)} sub={`${x.storage.messages.toLocaleString('en-IN')} stored messages`} />
            <Stat label="Domains" value={x.domains} to="/admin/domains" />
          </div>
          <div className="grid gap-5 lg:grid-cols-2">
            <Card title="Open alerts">
              {x.alerts.length === 0 ? (
                <p className="text-sm text-slate-500">No open alerts. Everything looks fine.</p>
              ) : (
                <ul className="space-y-3">
                  {x.alerts.map((a) => (
                    <li key={a.id} className="flex items-start gap-3">
                      <Badge color={a.severity === 'critical' ? 'red' : a.severity === 'warning' ? 'amber' : 'blue'}>{a.severity}</Badge>
                      <div className="min-w-0 flex-1 text-sm">
                        <div className="text-slate-800">{a.message}</div>
                        <div className="text-xs text-slate-500">
                          {formatDate(a.lastAt)}
                          {a.occurrences > 1 && ` · ${a.occurrences} times`}
                        </div>
                      </div>
                      <Button variant="ghost" onClick={() => void post(`/api/admin/alerts/${a.id}/ack`).then(d.reload)}>
                        Dismiss
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
            <Card title="Recent sign-ins">
              <Table head={['Time', 'Login', 'Via', 'Result']}>
                {x.recentLogins.map((l, i) => (
                  <tr key={i}>
                    <Td className="whitespace-nowrap">{formatDate(l.at)}</Td>
                    <Td>
                      <div className="truncate">{l.login}</div>
                      <div className="text-xs text-slate-500">{l.ip}</div>
                    </Td>
                    <Td className="uppercase">{l.protocol}</Td>
                    <Td>{l.success ? <Badge color="green">OK</Badge> : <Badge color="red">{l.reason ?? 'failed'}</Badge>}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </div>
        </>
      )}
    </div>
  );
}
