import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { day, get, patch, post } from '../api';
import { useMe } from '../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea, useAction, useResource } from '../ui';
import { ExpiryBadge, NewLicenseModal, STATUS_COLOR, type Plan } from './Licenses';

interface Client {
  id: number;
  company: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  city: string | null;
  state: string | null;
  gstin: string | null;
  address: string | null;
  notes: string | null;
  resellerId: number | null;
  resellerName: string | null;
  activeLicenses?: number;
}

export function ClientsPage() {
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState(false);
  const list = useResource(() => get<{ items: Client[]; total: number }>(`/api/clients?q=${encodeURIComponent(search)}`), [search]);
  return (
    <>
      <PageHeader title="Clients" description={list.data ? `${list.data.total} companies` : undefined} actions={<Button onClick={() => setEditing(true)}>New client</Button>} />
      <form
        className="mb-3"
        onSubmit={(e) => {
          e.preventDefault();
          setSearch(q);
        }}
      >
        <Input className="w-80" placeholder="Search company, email, phone, city" value={q} onChange={(e) => setQ(e.target.value)} />
      </form>
      <ErrorBanner error={list.error} />
      {!list.data ? (
        <Spinner />
      ) : (
        <Card>
          <Table head={['Company', 'Contact', 'City', 'Partner', 'Active licences']}>
            {list.data.items.map((c) => (
              <tr key={c.id}>
                <Td>
                  <Link to={`/clients/${c.id}`} className="text-brand-700 hover:underline">
                    {c.company}
                  </Link>
                </Td>
                <Td>
                  {c.contactName}
                  <div className="text-xs text-slate-500">{c.email ?? c.phone}</div>
                </Td>
                <Td>{c.city}</Td>
                <Td>{c.resellerName ?? '—'}</Td>
                <Td>{c.activeLicenses}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {editing && (
        <ClientModal
          onClose={() => setEditing(false)}
          onDone={() => {
            setEditing(false);
            list.reload();
          }}
        />
      )}
    </>
  );
}

export function ClientDetailPage() {
  const { id } = useParams();
  const c = useResource(() => get<Client & { licenses: { id: number; licenseId: string; plan: string; maxUsers: number; status: 'active' | 'suspended' | 'revoked'; expiresAt: string | null; amcExpiresAt: string | null }[] }>(`/api/clients/${id}`), [id]);
  const plans = useResource(() => get<Plan[]>('/api/plans'));
  const [modal, setModal] = useState<null | 'edit' | 'license'>(null);
  if (c.error) return <ErrorBanner error={c.error} />;
  if (!c.data) return <Spinner />;
  const x = c.data;
  return (
    <>
      <PageHeader
        title={x.company}
        description={[x.city, x.state].filter(Boolean).join(', ')}
        actions={
          <>
            <Button variant="secondary" onClick={() => setModal('edit')}>
              Edit
            </Button>
            <Button onClick={() => setModal('license')}>New licence</Button>
          </>
        }
      />
      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Contact">
          <dl className="space-y-1 text-sm">
            {(
              [
                ['Contact', x.contactName],
                ['Email', x.email],
                ['Phone', x.phone],
                ['WhatsApp', x.whatsapp],
                ['GSTIN', x.gstin],
                ['Address', x.address],
                ['Partner', x.resellerName],
                ['Notes', x.notes],
              ] as const
            ).map(([k, v]) => (
              <div key={k} className="flex justify-between gap-3">
                <dt className="text-slate-500">{k}</dt>
                <dd className="text-right">{v ?? '—'}</dd>
              </div>
            ))}
          </dl>
        </Card>
        <Card title="Licences" className="lg:col-span-2">
          <Table head={['Licence', 'Plan', 'Users', 'Expires', 'AMC', 'Status']}>
            {x.licenses.map((l) => (
              <tr key={l.id}>
                <Td>
                  <Link to={`/licenses/${l.id}`} className="font-mono text-brand-700 hover:underline">
                    {l.licenseId}
                  </Link>
                </Td>
                <Td>{l.plan}</Td>
                <Td>{l.maxUsers}</Td>
                <Td>
                  {l.expiresAt ? day(l.expiresAt) : 'Perpetual'} <ExpiryBadge d={l.expiresAt} />
                </Td>
                <Td>{day(l.amcExpiresAt)}</Td>
                <Td>
                  <Badge color={STATUS_COLOR[l.status]}>{l.status}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      </div>
      {modal === 'edit' && (
        <ClientModal
          client={x}
          onClose={() => setModal(null)}
          onDone={() => {
            setModal(null);
            c.reload();
          }}
        />
      )}
      {modal === 'license' && plans.data && <NewLicenseModal plans={plans.data.filter((p) => p.isActive)} clientId={x.id} onClose={() => setModal(null)} />}
    </>
  );
}

function ClientModal({ client, onClose, onDone }: { client?: Client; onClose: () => void; onDone: () => void }) {
  const me = useMe();
  const vayrone = me.user.role !== 'reseller';
  const partners = useResource(() => (vayrone ? get<{ id: number; name: string }[]>('/api/resellers') : Promise.resolve([])));
  const [f, setF] = useState({
    company: client?.company ?? '',
    contactName: client?.contactName ?? '',
    email: client?.email ?? '',
    phone: client?.phone ?? '',
    whatsapp: client?.whatsapp ?? '',
    city: client?.city ?? '',
    state: client?.state ?? '',
    gstin: client?.gstin ?? '',
    address: client?.address ?? '',
    notes: client?.notes ?? '',
    resellerId: client?.resellerId ? String(client.resellerId) : '',
  });
  const input = (k: keyof typeof f, label: string, props: Record<string, unknown> = {}) => (
    <Field label={label}>
      <Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...props} />
    </Field>
  );
  const save = useAction(async () => {
    const body = { ...f, resellerId: vayrone ? (f.resellerId ? Number(f.resellerId) : null) : undefined };
    if (client) await patch(`/api/clients/${client.id}`, body);
    else await post('/api/clients', body);
    onDone();
  });
  return (
    <Modal
      open
      wide
      title={client ? 'Edit client' : 'New client'}
      onClose={onClose}
      footer={
        <Button busy={save.busy} disabled={f.company.trim().length < 2} onClick={() => void save.run()}>
          Save
        </Button>
      }
    >
      <ErrorBanner error={save.error} />
      <div className="grid gap-x-3 sm:grid-cols-2">
        {input('company', 'Company')}
        {input('contactName', 'Contact person')}
        {input('email', 'Email (renewal reminders)', { type: 'email' })}
        {input('phone', 'Phone')}
        {input('whatsapp', 'WhatsApp number (reminders)')}
        {input('gstin', 'GSTIN')}
        {input('city', 'City')}
        {input('state', 'State')}
      </div>
      {input('address', 'Address')}
      {vayrone && (
        <Field label="Partner">
          <Select value={f.resellerId} onChange={(e) => setF({ ...f, resellerId: e.target.value })}>
            <option value="">Direct (Vayrone)</option>
            {partners.data?.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Notes">
        <Textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </Field>
    </Modal>
  );
}
