import { useState } from 'react';
import { Link } from 'react-router-dom';
import { get, patch, post } from '../api';
import { useMe } from '../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Spinner, Table, Td, Toggle, useAction, useResource } from '../ui';

interface Partner {
  id: number;
  name: string;
  contactName: string | null;
  email: string | null;
  phone: string | null;
  city: string | null;
  gstin: string | null;
  discountPct: number;
  quotaLicenses: number | null;
  quotaUsers: number | null;
  isEnabled: boolean;
  used: { licenses: number; users: number };
}

export function PartnersPage() {
  const me = useMe();
  const owner = me.user.role === 'owner';
  const list = useResource(() => get<Partner[]>('/api/resellers'));
  const [editing, setEditing] = useState<Partner | 'new' | null>(null);
  if (!list.data) return list.error ? <ErrorBanner error={list.error} /> : <Spinner />;
  return (
    <>
      <PageHeader
        title="Partners"
        description="Resellers sell PostMaster under their own logins, within quotas. Create their logins under Settings → Logins."
        actions={owner && <Button onClick={() => setEditing('new')}>New partner</Button>}
      />
      <Card>
        <Table head={['Partner', 'Contact', 'Discount', 'Licences', 'Users', '']}>
          {list.data.map((p) => (
            <tr key={p.id}>
              <Td>
                {p.name} {!p.isEnabled && <Badge color="red">disabled</Badge>}
                <div className="text-xs text-slate-500">{p.city}</div>
              </Td>
              <Td>
                {p.contactName}
                <div className="text-xs text-slate-500">{p.email ?? p.phone}</div>
              </Td>
              <Td>{p.discountPct}%</Td>
              <Td>
                <Link className="text-brand-700 hover:underline" to={`/licenses?resellerId=${p.id}`}>
                  {p.used.licenses}
                </Link>{' '}
                / {p.quotaLicenses ?? '∞'}
              </Td>
              <Td>
                {p.used.users} / {p.quotaUsers ?? '∞'}
              </Td>
              <Td>
                {owner && (
                  <Button variant="ghost" onClick={() => setEditing(p)}>
                    Edit
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      </Card>
      {editing && (
        <PartnerModal
          partner={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </>
  );
}

function PartnerModal({ partner, onClose, onDone }: { partner: Partner | null; onClose: () => void; onDone: () => void }) {
  const [f, setF] = useState({
    name: partner?.name ?? '',
    contactName: partner?.contactName ?? '',
    email: partner?.email ?? '',
    phone: partner?.phone ?? '',
    city: partner?.city ?? '',
    gstin: partner?.gstin ?? '',
    discountPct: String(partner?.discountPct ?? 20),
    quotaLicenses: partner?.quotaLicenses == null ? '' : String(partner.quotaLicenses),
    quotaUsers: partner?.quotaUsers == null ? '' : String(partner.quotaUsers),
    isEnabled: partner?.isEnabled ?? true,
  });
  const save = useAction(async () => {
    const body = {
      ...f,
      discountPct: Number(f.discountPct),
      quotaLicenses: f.quotaLicenses === '' ? null : Number(f.quotaLicenses),
      quotaUsers: f.quotaUsers === '' ? null : Number(f.quotaUsers),
    };
    if (partner) await patch(`/api/resellers/${partner.id}`, body);
    else await post('/api/resellers', body);
    onDone();
  });
  const text = (k: 'name' | 'contactName' | 'email' | 'phone' | 'city' | 'gstin' | 'discountPct' | 'quotaLicenses' | 'quotaUsers', label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
    </Field>
  );
  return (
    <Modal
      open
      wide
      title={partner ? `Edit ${partner.name}` : 'New partner'}
      onClose={onClose}
      footer={
        <Button busy={save.busy} onClick={() => void save.run()}>
          Save
        </Button>
      }
    >
      <ErrorBanner error={save.error} />
      <div className="grid gap-x-3 sm:grid-cols-2">
        {text('name', 'Company')}
        {text('contactName', 'Contact person')}
        {text('email', 'Email (copied on client reminders)')}
        {text('phone', 'Phone (shown to clients)')}
        {text('city', 'City')}
        {text('gstin', 'GSTIN')}
        {text('discountPct', 'Discount % on list price')}
        <div />
        {text('quotaLicenses', 'Licence quota', 'empty = unlimited')}
        {text('quotaUsers', 'User quota (all their licences)', 'empty = unlimited')}
      </div>
      <Toggle checked={f.isEnabled} onChange={(v) => setF({ ...f, isEnabled: v })} label="Partner can sign in and create licences" />
    </Modal>
  );
}
