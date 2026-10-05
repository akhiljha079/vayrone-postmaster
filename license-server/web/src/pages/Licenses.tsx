import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { day, daysLeft, get, inr, post, when } from '../api';
import { useMe } from '../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, useAction, useResource } from '../ui';

export interface Plan {
  id: number;
  code: string;
  name: string;
  features: string[];
  maxExternalAccounts: number | null;
  minUsers: number;
  slabs: { upTo: number | null; pricePerUser: number }[];
  termMonths: number;
  amcPct: number;
  isActive: boolean;
}

interface LicenseRow {
  id: number;
  licenseId: string;
  status: 'active' | 'suspended' | 'revoked';
  maxUsers: number;
  usedUsers: number | null;
  expiresAt: string | null;
  amcExpiresAt: string | null;
  company: string;
  city: string | null;
  plan: string;
  reseller: string | null;
  activations: number;
  lastSeenAt: string | null;
}

export const STATUS_COLOR = { active: 'green', suspended: 'amber', revoked: 'red' } as const;

export function ExpiryBadge({ d }: { d: string | null }) {
  const n = daysLeft(d);
  if (n === null) return <Badge color="slate">perpetual</Badge>;
  if (n < -15) return <Badge color="red">expired</Badge>;
  if (n < 0) return <Badge color="red">grace</Badge>;
  if (n <= 30) return <Badge color="amber">{n} days</Badge>;
  return null;
}

export function LicensesPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get('q') ?? '');
  const [creating, setCreating] = useState(false);
  const qs = params.toString();
  const list = useResource(() => get<{ items: LicenseRow[]; total: number }>(`/api/licenses?${qs}`), [qs]);
  const plans = useResource(() => get<Plan[]>('/api/plans'));
  const set = (k: string, v: string) => {
    const p = new URLSearchParams(params);
    if (v) p.set(k, v);
    else p.delete(k);
    setParams(p);
  };
  return (
    <>
      <PageHeader title="Licences" description={list.data ? `${list.data.total} licences` : undefined} actions={<Button onClick={() => setCreating(true)}>New licence</Button>} />
      <div className="mb-3 flex flex-wrap gap-2">
        <form
          onSubmit={(e) => {
            e.preventDefault();
            set('q', q);
          }}
        >
          <Input className="w-72" placeholder="Search licence, key, company, email, phone" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
        <Select className="w-40" value={params.get('status') ?? ''} onChange={(e) => set('status', e.target.value)}>
          <option value="">All statuses</option>
          <option value="active">Active</option>
          <option value="suspended">Suspended</option>
          <option value="revoked">Revoked</option>
        </Select>
        <Select className="w-40" value={params.get('planId') ?? ''} onChange={(e) => set('planId', e.target.value)}>
          <option value="">All plans</option>
          {plans.data?.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select className="w-48" value={params.get('expiring') ?? ''} onChange={(e) => set('expiring', e.target.value)}>
          <option value="">Any expiry</option>
          <option value="30">Expiring in 30 days</option>
          <option value="60">Expiring in 60 days</option>
          <option value="90">Expiring in 90 days</option>
        </Select>
      </div>
      <ErrorBanner error={list.error} />
      {!list.data ? (
        <Spinner />
      ) : (
        <Card>
          <Table head={['Licence', 'Client', 'Plan', 'Users', 'Expires', 'Server', 'Partner', 'Status']}>
            {list.data.items.map((l) => (
              <tr key={l.id}>
                <Td>
                  <Link to={`/licenses/${l.id}`} className="font-mono text-brand-700 hover:underline">
                    {l.licenseId}
                  </Link>
                </Td>
                <Td>
                  {l.company}
                  {l.city && <div className="text-xs text-slate-500">{l.city}</div>}
                </Td>
                <Td>{l.plan}</Td>
                <Td className="tabular">
                  {l.usedUsers ?? '–'} / {l.maxUsers}
                </Td>
                <Td>
                  {day(l.expiresAt)} <ExpiryBadge d={l.expiresAt} />
                </Td>
                <Td className="text-xs">{l.activations ? `seen ${when(l.lastSeenAt)}` : <span className="text-slate-400">not activated</span>}</Td>
                <Td>{l.reseller ?? '—'}</Td>
                <Td>
                  <Badge color={STATUS_COLOR[l.status]}>{l.status}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {creating && plans.data && <NewLicenseModal plans={plans.data.filter((p) => p.isActive)} onClose={() => setCreating(false)} />}
    </>
  );
}

interface ClientOption {
  id: number;
  company: string;
  city: string | null;
}

function NewLicenseModal({ plans, onClose, clientId }: { plans: Plan[]; onClose: () => void; clientId?: number }) {
  const me = useMe();
  const nav = useNavigate();
  const partner = me.user.role === 'reseller';
  const clients = useResource(() => get<{ items: ClientOption[] }>('/api/clients?pageSize=500'));
  const [f, setF] = useState({ clientId: clientId ? String(clientId) : '', planId: plans[0] ? String(plans[0].id) : '', maxUsers: '25', amount: '', invoiceRef: '', maxActivations: '1' });
  const plan = plans.find((p) => String(p.id) === f.planId);
  const quote = useResource(
    () => (plan ? get<{ unitPrice: number; net: number; gst: number; total: number; amcPerYear: number; discountPct: number }>(`/api/plans/${plan.id}/quote?users=${Number(f.maxUsers) || 1}`) : Promise.resolve(null)),
    [f.planId, f.maxUsers],
  );
  const [created, setCreated] = useState<{ id: number; licenseId: string; licenseKey: string } | null>(null);
  const save = useAction(async () => {
    const r = await post<{ id: number; licenseId: string; licenseKey: string }>('/api/licenses', {
      clientId: Number(f.clientId),
      planId: Number(f.planId),
      maxUsers: Number(f.maxUsers),
      ...(f.amount ? { amount: Number(f.amount) } : {}),
      ...(f.invoiceRef ? { invoiceRef: f.invoiceRef } : {}),
      ...(!partner && f.maxActivations !== '1' ? { maxActivations: Number(f.maxActivations) } : {}),
    });
    setCreated(r);
  });
  if (created) {
    return (
      <Modal
        open
        title="Licence created"
        onClose={() => nav(`/licenses/${created.id}`)}
        footer={<Button onClick={() => nav(`/licenses/${created.id}`)}>Open licence</Button>}
      >
        <p className="mb-2 text-sm text-slate-600">Send this key to the client. They enter it on the Licence page of their PostMaster server.</p>
        <div className="rounded-md bg-slate-50 p-3 text-center font-mono text-lg tracking-wide ring-1 ring-slate-200">{created.licenseKey}</div>
        <div className="mt-2 text-center">
          <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(created.licenseKey)}>
            Copy key
          </Button>
        </div>
      </Modal>
    );
  }
  return (
    <Modal
      open
      title="New licence"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.busy} disabled={!f.clientId || !f.planId} onClick={() => void save.run()}>
            Generate key
          </Button>
        </>
      }
    >
      <ErrorBanner error={save.error} />
      <Field label="Client" hint={<Link to="/clients" className="underline">Add a client first</Link>}>
        <Select value={f.clientId} onChange={(e) => setF({ ...f, clientId: e.target.value })}>
          <option value="">Choose…</option>
          {clients.data?.items.map((c) => (
            <option key={c.id} value={c.id}>
              {c.company}
              {c.city ? `, ${c.city}` : ''}
            </option>
          ))}
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Plan">
          <Select value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}>
            {plans.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} ({p.termMonths ? `${p.termMonths} months` : 'perpetual'})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Users" hint={plan ? `minimum ${plan.minUsers}` : undefined}>
          <Input type="number" min={1} value={f.maxUsers} onChange={(e) => setF({ ...f, maxUsers: e.target.value })} />
        </Field>
      </div>
      {quote.data && (
        <div className="mb-3 rounded-md bg-slate-50 px-3 py-2 text-sm text-slate-700 ring-1 ring-slate-200">
          List price {inr(quote.data.unitPrice)}/user{plan?.termMonths ? '/year' : ''}
          {quote.data.discountPct ? `, partner discount ${quote.data.discountPct}%` : ''} → {inr(quote.data.net)} + GST {inr(quote.data.gst)} = <b>{inr(quote.data.total)}</b>
          {quote.data.amcPerYear > 0 && <div>AMC from year 2: {inr(quote.data.amcPerYear)}/year + GST</div>}
        </div>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Amount invoiced (₹, before GST)">
          <Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Invoice no.">
          <Input value={f.invoiceRef} onChange={(e) => setF({ ...f, invoiceRef: e.target.value })} />
        </Field>
      </div>
      {!partner && (
        <Field label="Servers allowed" hint="Normally 1. More for a DR / standby server.">
          <Input type="number" min={1} max={20} value={f.maxActivations} onChange={(e) => setF({ ...f, maxActivations: e.target.value })} />
        </Field>
      )}
    </Modal>
  );
}

export { NewLicenseModal };
