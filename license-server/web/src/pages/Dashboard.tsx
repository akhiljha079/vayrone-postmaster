import { Link } from 'react-router-dom';
import { day, daysLeft, get, inr, when } from '../api';
import { useMe } from '../auth';
import { Badge, Card, ErrorBanner, PageHeader, Spinner, Table, Td, useResource } from '../ui';

interface Row {
  id: number;
  licenseId: string;
  company: string;
  plan?: string;
  maxUsers?: number;
  usedUsers?: number | null;
  expiresAt?: string | null;
  amcExpiresAt?: string | null;
  reseller?: string | null;
}

interface Summary {
  licenses: Record<string, number>;
  seats: { sold: number; used: number; installsSeen3d: number };
  expiring: Row[];
  amcDue: Row[];
  stale: (Row & { hostname: string | null; lastSeenAt: string })[];
  nearLimit: (Row & { activeUsers: number })[];
  clones: (Row & { at: string; detail: { hostname?: string; machineId?: string } })[];
  byPlan: { plan: string; licenses: number; users: number }[];
  revenue: { month: string; kind: string; amount: number; n: number }[];
  byReseller: { reseller: string; licenses: number; users: number }[];
  versions: { version: string | null; n: number }[];
}


function Stat({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="rounded-lg bg-white p-4 ring-1 ring-slate-200">
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1 text-2xl font-semibold text-slate-900">{value}</div>
      {sub && <div className="text-xs text-slate-500">{sub}</div>}
    </div>
  );
}

const lic = (r: Row) => (
  <Link className="font-mono text-brand-700 hover:underline" to={`/licenses/${r.id}`}>
    {r.licenseId}
  </Link>
);

export function DashboardPage() {
  const me = useMe();
  const s = useResource(() => get<Summary>('/api/reports/summary'));
  if (s.error) return <ErrorBanner error={s.error} />;
  if (!s.data) return <Spinner />;
  const d = s.data;
  const months = [...new Set(d.revenue.map((r) => r.month))];
  return (
    <>
      <PageHeader
        title="Dashboard"
        actions={
          <a className="rounded-md bg-white px-3 py-1.5 text-sm ring-1 ring-slate-300 hover:bg-slate-50" href="/api/reports/licenses.csv">
            Export licences (CSV)
          </a>
        }
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Active licences" value={d.licenses.active ?? 0} sub={`${d.licenses.suspended ?? 0} suspended, ${d.licenses.revoked ?? 0} revoked`} />
        <Stat label="Users sold" value={d.seats.sold.toLocaleString('en-IN')} sub={`${d.seats.used.toLocaleString('en-IN')} in use`} />
        <Stat label="Servers online (3 days)" value={d.seats.installsSeen3d} />
        <Stat label="Expiring in 60 days" value={d.expiring.filter((r) => (daysLeft(r.expiresAt) ?? -1) >= 0).length} sub={`${d.amcDue.length} AMC due in 30 days`} />
      </div>

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <Card title="Renewals due (expired in the last 15 days or expiring in 60)">
          <Table head={['Licence', 'Client', 'Plan', 'Expires', '']}>
            {d.expiring.map((r) => {
              const n = daysLeft(r.expiresAt)!;
              return (
                <tr key={r.id}>
                  <Td>{lic(r)}</Td>
                  <Td>{r.company}</Td>
                  <Td>
                    {r.plan}, {r.maxUsers} users
                  </Td>
                  <Td>{day(r.expiresAt)}</Td>
                  <Td>{n < 0 ? <Badge color="red">grace</Badge> : <Badge color={n <= 7 ? 'amber' : 'slate'}>{n} days</Badge>}</Td>
                </tr>
              );
            })}
          </Table>
        </Card>
        <Card title="AMC due in 30 days">
          <Table head={['Licence', 'Client', 'AMC until']}>
            {d.amcDue.map((r) => (
              <tr key={r.id}>
                <Td>{lic(r)}</Td>
                <Td>{r.company}</Td>
                <Td>{day(r.amcExpiresAt)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Upgrade candidates (90%+ of licensed users)">
          <Table head={['Licence', 'Client', 'Users']}>
            {d.nearLimit.map((r) => (
              <tr key={r.id}>
                <Td>{lic(r)}</Td>
                <Td>{r.company}</Td>
                <Td>
                  {r.activeUsers} / {r.maxUsers}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Online servers not seen for 7+ days">
          <Table head={['Licence', 'Client', 'Server', 'Last seen']}>
            {d.stale.map((r) => (
              <tr key={`${r.id}-${r.lastSeenAt}`}>
                <Td>{lic(r)}</Td>
                <Td>{r.company}</Td>
                <Td>{r.hostname}</Td>
                <Td>{when(r.lastSeenAt)}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        {d.clones.length > 0 && (
          <Card title="Possible copies (a licence checked in from different hardware)">
            <Table head={['When', 'Licence', 'Client', 'Server']}>
              {d.clones.map((r, i) => (
                <tr key={i}>
                  <Td>{when(r.at)}</Td>
                  <Td>{lic(r)}</Td>
                  <Td>{r.company}</Td>
                  <Td>{r.detail.hostname}</Td>
                </tr>
              ))}
            </Table>
          </Card>
        )}
        <Card title="Licences by plan">
          <Table head={['Plan', 'Licences', 'Users']}>
            {d.byPlan.map((r) => (
              <tr key={r.plan}>
                <Td>{r.plan}</Td>
                <Td>{r.licenses}</Td>
                <Td>{Number(r.users).toLocaleString('en-IN')}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        {me.user.role !== 'reseller' && (
          <>
            <Card title="Sales, last 12 months">
              <Table head={['Month', 'New', 'Renewals', 'AMC', 'Upgrades']}>
                {months.map((m) => {
                  const of = (k: string) => d.revenue.find((r) => r.month === m && r.kind === k)?.amount;
                  return (
                    <tr key={m}>
                      <Td>{m}</Td>
                      <Td>{inr(of('new'))}</Td>
                      <Td>{inr(of('renewal'))}</Td>
                      <Td>{inr(of('amc'))}</Td>
                      <Td>{inr(of('upgrade'))}</Td>
                    </tr>
                  );
                })}
              </Table>
            </Card>
            <Card title="By partner">
              <Table head={['Partner', 'Licences', 'Users']}>
                {d.byReseller.map((r) => (
                  <tr key={r.reseller}>
                    <Td>{r.reseller}</Td>
                    <Td>{r.licenses}</Td>
                    <Td>{Number(r.users).toLocaleString('en-IN')}</Td>
                  </tr>
                ))}
              </Table>
            </Card>
          </>
        )}
        <Card title="Product versions in use">
          <Table head={['Version', 'Servers']}>
            {d.versions.map((r) => (
              <tr key={r.version ?? '-'}>
                <Td>{r.version ?? 'unknown'}</Td>
                <Td>{r.n}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
    </>
  );
}
