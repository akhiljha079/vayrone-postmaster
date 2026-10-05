import { useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import { day, get, inr, patch, post, when } from '../api';
import { useMe } from '../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea, useAction, useResource } from '../ui';
import { ExpiryBadge, STATUS_COLOR, type Plan } from './Licenses';

interface Detail {
  id: number;
  licenseId: string;
  licenseKey: string;
  status: 'active' | 'suspended' | 'revoked';
  statusReason: string | null;
  maxUsers: number;
  maxExternalAccounts: number | null;
  features: string[];
  startsAt: string;
  expiresAt: string | null;
  amcExpiresAt: string | null;
  maxActivations: number;
  heartbeatHours: number;
  onlineCheckDays: number;
  offlineCheckDays: number;
  notes: string | null;
  client: { id: number; company: string; contactName: string | null; email: string | null; phone: string | null; city: string | null; gstin: string | null };
  plan: { id: number; code: string; name: string; termMonths: number };
  reseller: { id: number; name: string } | null;
  activations: {
    id: number;
    activationId: string;
    machineId: string;
    mode: 'online' | 'offline';
    status: 'active' | 'released';
    activatedAt: string;
    lastSeenAt: string;
    lastIp: string | null;
    version: string | null;
    hostname: string | null;
    site: { company: string; gstin: string | null; contact: string | null; phone: string | null } | null;
    activeUsers: number | null;
    externalAccounts: number | null;
    releasedAt: string | null;
    releaseReason: string | null;
  }[];
  renewals: { id: number; kind: string; periodFrom: string | null; periodTo: string | null; users: number | null; amount: number; invoiceRef: string | null; notes: string | null; createdAt: string }[];
  events: { id: number; at: string; kind: string; ip: string | null; detail: Record<string, unknown> | null; actor: string | null }[];
  usage: { day: string; activeUsers: number; externalAccounts: number; version: string | null }[];
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-1.5 text-sm last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="text-right text-slate-900">{children}</span>
    </div>
  );
}

export function LicenseDetailPage() {
  const { id } = useParams();
  const me = useMe();
  const vayrone = me.user.role !== 'reseller';
  const d = useResource(() => get<Detail>(`/api/licenses/${id}`), [id]);
  const [modal, setModal] = useState<null | 'renew' | 'amc' | 'edit' | 'status' | { release: number }>(null);
  if (d.error) return <ErrorBanner error={d.error} />;
  if (!d.data) return <Spinner />;
  const l = d.data;
  const done = () => {
    setModal(null);
    d.reload();
  };
  return (
    <>
      <PageHeader
        title={l.licenseId}
        description={
          <>
            <Link to={`/clients/${l.client.id}`} className="text-brand-700 hover:underline">
              {l.client.company}
            </Link>{' '}
            · {l.plan.name} · {l.maxUsers} users <Badge color={STATUS_COLOR[l.status]}>{l.status}</Badge>
          </>
        }
        actions={
          <>
            {l.plan.termMonths > 0 && <Button onClick={() => setModal('renew')}>Renew</Button>}
            <Button variant="secondary" onClick={() => setModal('amc')}>
              Renew AMC
            </Button>
            <Button variant="secondary" onClick={() => setModal('edit')}>
              Change
            </Button>
            {vayrone && (
              <Button variant="ghost" onClick={() => setModal('status')}>
                Suspend / revoke
              </Button>
            )}
          </>
        }
      />
      {l.statusReason && <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900 ring-1 ring-amber-200">Reason shown to the client: {l.statusReason}</div>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Licence">
          <Row label="Key">
            <span className="font-mono">{l.licenseKey}</span>{' '}
            <button className="text-xs text-brand-700 underline" onClick={() => void navigator.clipboard.writeText(l.licenseKey)}>
              copy
            </button>
          </Row>
          <Row label="Starts">{day(l.startsAt)}</Row>
          <Row label="Expires">
            {l.expiresAt ? day(l.expiresAt) : 'Perpetual'} <ExpiryBadge d={l.expiresAt} />
          </Row>
          <Row label="AMC until">
            {day(l.amcExpiresAt)} <ExpiryBadge d={l.amcExpiresAt} />
          </Row>
          <Row label="External mailboxes">{l.maxExternalAccounts ?? 'unlimited'}</Row>
          <Row label="Features">{l.features.join(', ') || '—'}</Row>
          <Row label="Servers allowed">{l.maxActivations}</Row>
          <Row label="Validation">
            online every {l.heartbeatHours} h, grace after {l.onlineCheckDays} days offline; offline files valid {l.offlineCheckDays} days
          </Row>
          {l.reseller && <Row label="Partner">{l.reseller.name}</Row>}
          {l.notes && <Row label="Notes">{l.notes}</Row>}
        </Card>
        <Card title="Client">
          <Row label="Company">{l.client.company}</Row>
          <Row label="Contact">{l.client.contactName ?? '—'}</Row>
          <Row label="Email">{l.client.email ?? '—'}</Row>
          <Row label="Phone">{l.client.phone ?? '—'}</Row>
          <Row label="City">{l.client.city ?? '—'}</Row>
          <Row label="GSTIN">{l.client.gstin ?? '—'}</Row>
        </Card>
      </div>

      <Card title="Servers (activations)" className="mt-4">
        <Table head={['Server', 'Machine ID', 'Mode', 'Users', 'Version', 'Last seen', 'Status', '']}>
          {l.activations.map((a) => (
            <tr key={a.id}>
              <Td>
                {a.hostname ?? '—'}
                <div className="text-xs text-slate-500">{a.lastIp}</div>
                {a.site && (
                  <div className="text-xs text-slate-500" title="Entered in the server's setup wizard">
                    {a.site.company}
                    {a.site.gstin ? ` · ${a.site.gstin}` : ''}
                  </div>
                )}
              </Td>
              <Td className="font-mono text-xs">{a.machineId}</Td>
              <Td>{a.mode}</Td>
              <Td>{a.activeUsers ?? '—'}</Td>
              <Td>{a.version ?? '—'}</Td>
              <Td className="text-xs">{when(a.lastSeenAt)}</Td>
              <Td>
                {a.status === 'active' ? (
                  <Badge color="green">active</Badge>
                ) : (
                  <span className="text-xs text-slate-500">
                    released {day(a.releasedAt)}
                    <br />
                    {a.releaseReason}
                  </span>
                )}
              </Td>
              <Td>
                {a.status === 'active' && (
                  <Button variant="ghost" onClick={() => setModal({ release: a.id })}>
                    Transfer
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
        {l.activations.length === 0 && <p className="py-3 text-sm text-slate-500">Not activated yet.</p>}
      </Card>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card title="Sales and renewals">
          <Table head={['Date', 'Type', 'Period', 'Users', 'Amount', 'Invoice']}>
            {l.renewals.map((r) => (
              <tr key={r.id}>
                <Td>{day(r.createdAt)}</Td>
                <Td>{r.kind}</Td>
                <Td className="text-xs">{r.periodTo ? `${day(r.periodFrom)} – ${day(r.periodTo)}` : '—'}</Td>
                <Td>{r.users ?? '—'}</Td>
                <Td>{inr(r.amount)}</Td>
                <Td>{r.invoiceRef ?? '—'}</Td>
              </tr>
            ))}
          </Table>
        </Card>
        <Card title="Usage (from the server)">
          <Table head={['Day', 'Users', 'External', 'Version']}>
            {l.usage.slice(0, 15).map((u) => (
              <tr key={u.day}>
                <Td>{day(u.day)}</Td>
                <Td>
                  {u.activeUsers} / {l.maxUsers}
                </Td>
                <Td>{u.externalAccounts}</Td>
                <Td>{u.version}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>

      <Card title="Activity log" className="mt-4">
        <Table head={['When', 'Event', 'By', 'IP', 'Details']}>
          {l.events.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-xs">{when(e.at)}</Td>
              <Td>{e.kind.replace(/_/g, ' ')}</Td>
              <Td>{e.actor ?? (e.kind.match(/activate|heartbeat|clone|hardware|deactivate|offline/) ? 'server' : '—')}</Td>
              <Td className="text-xs">{e.ip}</Td>
              <Td className="max-w-md truncate text-xs text-slate-500">{e.detail ? JSON.stringify(e.detail) : ''}</Td>
            </tr>
          ))}
        </Table>
      </Card>

      {(modal === 'renew' || modal === 'amc') && <RenewModal kind={modal === 'renew' ? 'renewal' : 'amc'} id={l.id} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'edit' && <EditModal l={l} vayrone={vayrone} onClose={() => setModal(null)} onDone={done} />}
      {modal === 'status' && <StatusModal l={l} onClose={() => setModal(null)} onDone={done} />}
      {modal && typeof modal === 'object' && <ReleaseModal activationId={modal.release} onClose={() => setModal(null)} onDone={done} />}
    </>
  );
}

function RenewModal({ kind, id, onClose, onDone }: { kind: 'renewal' | 'amc'; id: number; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({ months: '12', amount: '', invoiceRef: '', notes: '' });
  const save = useAction(async () => {
    await post(`/api/licenses/${id}/renew`, { kind, months: Number(f.months), amount: Number(f.amount) || 0, invoiceRef: f.invoiceRef || null, notes: f.notes || null });
    onDone();
  });
  return (
    <Modal
      open
      title={kind === 'renewal' ? 'Renew licence' : 'Renew AMC'}
      onClose={onClose}
      footer={
        <Button busy={save.busy} onClick={() => void save.run()}>
          Renew
        </Button>
      }
    >
      <ErrorBanner error={save.error} />
      <p className="mb-3 text-sm text-slate-600">Extends from the current end date (or from today if it has passed). Online servers pick it up within a day; offline servers need a new licence file.</p>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Months">
          <Input type="number" min={1} value={f.months} onChange={(e) => setF({ ...f, months: e.target.value })} />
        </Field>
        <Field label="Amount (₹)">
          <Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Invoice no.">
          <Input value={f.invoiceRef} onChange={(e) => setF({ ...f, invoiceRef: e.target.value })} />
        </Field>
      </div>
      <Field label="Notes">
        <Input value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

function EditModal({ l, vayrone, onClose, onDone }: { l: Detail; vayrone: boolean; onClose: () => void; onDone: () => void }) {
  const plans = useResource(() => get<Plan[]>('/api/plans'));
  const features = useResource(() => get<string[]>('/api/features'));
  const [f, setF] = useState({
    planId: String(l.plan.id),
    maxUsers: String(l.maxUsers),
    maxExternalAccounts: l.maxExternalAccounts === null ? '' : String(l.maxExternalAccounts),
    features: l.features,
    maxActivations: String(l.maxActivations),
    offlineCheckDays: String(l.offlineCheckDays),
    notes: l.notes ?? '',
    amount: '',
    invoiceRef: '',
  });
  const save = useAction(async () => {
    const body: Record<string, unknown> = { maxUsers: Number(f.maxUsers), notes: f.notes || null };
    if (vayrone) {
      Object.assign(body, {
        planId: Number(f.planId),
        maxExternalAccounts: f.maxExternalAccounts === '' ? null : Number(f.maxExternalAccounts),
        features: f.features,
        maxActivations: Number(f.maxActivations),
        offlineCheckDays: Number(f.offlineCheckDays),
      });
    }
    if (f.amount) body.amount = Number(f.amount);
    if (f.invoiceRef) body.invoiceRef = f.invoiceRef;
    await patch(`/api/licenses/${l.id}`, body);
    onDone();
  });
  return (
    <Modal
      open
      wide
      title="Change licence"
      onClose={onClose}
      footer={
        <Button busy={save.busy} onClick={() => void save.run()}>
          Save
        </Button>
      }
    >
      <ErrorBanner error={save.error} />
      <p className="mb-3 text-sm text-slate-600">Online servers receive the change at their next daily check (or “Check now” on their Licence page). Offline servers need a new licence file.</p>
      <div className="grid grid-cols-2 gap-3">
        {vayrone && (
          <Field label="Plan">
            <Select value={f.planId} onChange={(e) => setF({ ...f, planId: e.target.value })}>
              {plans.data?.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Users">
          <Input type="number" min={1} value={f.maxUsers} onChange={(e) => setF({ ...f, maxUsers: e.target.value })} />
        </Field>
        {vayrone && (
          <>
            <Field label="External mailboxes" hint="empty = unlimited">
              <Input type="number" min={0} value={f.maxExternalAccounts} onChange={(e) => setF({ ...f, maxExternalAccounts: e.target.value })} />
            </Field>
            <Field label="Servers allowed">
              <Input type="number" min={1} value={f.maxActivations} onChange={(e) => setF({ ...f, maxActivations: e.target.value })} />
            </Field>
            <Field label="Offline file validity (days)">
              <Input type="number" min={7} value={f.offlineCheckDays} onChange={(e) => setF({ ...f, offlineCheckDays: e.target.value })} />
            </Field>
          </>
        )}
      </div>
      {vayrone && (
        <Field label="Features">
          <div className="flex flex-wrap gap-3">
            {features.data?.map((x) => (
              <label key={x} className="flex items-center gap-1.5 text-sm">
                <input type="checkbox" checked={f.features.includes(x)} onChange={(e) => setF({ ...f, features: e.target.checked ? [...f.features, x] : f.features.filter((y) => y !== x) })} />
                {x}
              </label>
            ))}
          </div>
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Upgrade amount (₹, optional)">
          <Input type="number" value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} />
        </Field>
        <Field label="Invoice no.">
          <Input value={f.invoiceRef} onChange={(e) => setF({ ...f, invoiceRef: e.target.value })} />
        </Field>
      </div>
      <Field label="Notes">
        <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}

function StatusModal({ l, onClose, onDone }: { l: Detail; onClose: () => void; onDone: () => void }) {
  const [status, setStatus] = useState<Detail['status']>(l.status === 'active' ? 'suspended' : 'active');
  const [reason, setReason] = useState('');
  const save = useAction(async () => {
    await post(`/api/licenses/${l.id}/status`, { status, reason: reason || null });
    onDone();
  });
  return (
    <Modal
      open
      title="Licence status"
      onClose={onClose}
      footer={
        <Button variant={status === 'active' ? 'primary' : 'danger'} busy={save.busy} onClick={() => void save.run()}>
          Save
        </Button>
      }
    >
      <ErrorBanner error={save.error} />
      <Field label="Status">
        <Select value={status} onChange={(e) => setStatus(e.target.value as Detail['status'])}>
          <option value="active">Active</option>
          <option value="suspended">Suspended (e.g. payment pending)</option>
          <option value="revoked">Revoked (permanent)</option>
        </Select>
      </Field>
      {status !== 'active' && (
        <Field label="Reason (the client sees this)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Payment pending — please call 0562-…" />
        </Field>
      )}
      <p className="text-sm text-slate-600">Online servers get a 15-day grace period from their next check-in, then their admin panel becomes read-only. Mail keeps flowing.</p>
    </Modal>
  );
}

function ReleaseModal({ activationId, onClose, onDone }: { activationId: number; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const save = useAction(async () => {
    await post(`/api/activations/${activationId}/release`, { reason });
    onDone();
  });
  return (
    <Modal
      open
      title="Transfer to another server"
      onClose={onClose}
      footer={
        <Button variant="danger" busy={save.busy} disabled={reason.trim().length < 3} onClick={() => void save.run()}>
          Release this server
        </Button>
      }
    >
      <ErrorBanner error={save.error} />
      <p className="mb-3 text-sm text-slate-600">The key can then be activated on the new server. The old server learns this at its next check-in and has 15 days before its admin panel turns read-only.</p>
      <Field label="Reason">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Old server replaced (motherboard failure)" />
      </Field>
    </Modal>
  );
}
