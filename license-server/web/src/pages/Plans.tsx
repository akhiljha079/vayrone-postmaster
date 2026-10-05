import { useState } from 'react';
import { get, inr, patch, post } from '../api';
import { useMe } from '../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Spinner, Table, Td, Toggle, useAction, useResource } from '../ui';
import type { Plan } from './Licenses';

export function PlansPage() {
  const me = useMe();
  const owner = me.user.role === 'owner';
  const plans = useResource(() => get<Plan[]>('/api/plans'));
  const [editing, setEditing] = useState<Plan | 'new' | null>(null);
  const [users, setUsers] = useState('25');
  const [years, setYears] = useState('1');
  const [planId, setPlanId] = useState<number | null>(null);
  const quote = useResource(
    () => (planId ? get<{ unitPrice: number; base: number; discountPct: number; discount: number; net: number; gst: number; total: number; amcPerYear: number; users: number; years: number }>(`/api/plans/${planId}/quote?users=${users}&years=${years}`) : Promise.resolve(null)),
    [planId, users, years],
  );
  if (!plans.data) return plans.error ? <ErrorBanner error={plans.error} /> : <Spinner />;
  return (
    <>
      <PageHeader title="Plans and pricing" description="Per-user slab prices. The whole order is priced at the slab its user count falls into." actions={owner && <Button onClick={() => setEditing('new')}>New plan</Button>} />
      <Card>
        <Table head={['Plan', 'Term', 'Price per user', 'Features', 'AMC', '']}>
          {plans.data.map((p) => (
            <tr key={p.id}>
              <Td>
                {p.name} {!p.isActive && <Badge>inactive</Badge>}
                <div className="font-mono text-xs text-slate-500">{p.code}</div>
              </Td>
              <Td>{p.termMonths ? `${p.termMonths} months` : 'Perpetual'}</Td>
              <Td className="text-xs">
                {p.slabs.map((s, i) => {
                  const from = i === 0 ? Math.max(1, p.minUsers) : (p.slabs[i - 1]!.upTo ?? 0) + 1;
                  return (
                    <div key={i}>
                      {from}–{s.upTo ?? '∞'} users: {inr(s.pricePerUser)}
                      {p.termMonths ? '/yr' : ''}
                    </div>
                  );
                })}
              </Td>
              <Td className="text-xs">{p.features.join(', ')}</Td>
              <Td>{p.termMonths ? 'included' : `${p.amcPct}% / year`}</Td>
              <Td>
                <Button variant="ghost" onClick={() => setPlanId(p.id)}>
                  Quote
                </Button>
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
      {planId && (
        <Card title={`Quote — ${plans.data.find((p) => p.id === planId)?.name}`} className="mt-4">
          <div className="flex flex-wrap gap-3">
            <Field label="Users">
              <Input type="number" min={1} value={users} onChange={(e) => setUsers(e.target.value)} />
            </Field>
            <Field label="Years">
              <Input type="number" min={1} max={10} value={years} onChange={(e) => setYears(e.target.value)} />
            </Field>
          </div>
          {quote.data && (
            <table className="text-sm">
              <tbody>
                <tr>
                  <td className="pr-6 text-slate-500">
                    {quote.data.users} users × {inr(quote.data.unitPrice)} × {quote.data.years} yr
                  </td>
                  <td className="text-right">{inr(quote.data.base)}</td>
                </tr>
                {quote.data.discount > 0 && (
                  <tr>
                    <td className="text-slate-500">Partner discount {quote.data.discountPct}%</td>
                    <td className="text-right">−{inr(quote.data.discount)}</td>
                  </tr>
                )}
                <tr>
                  <td className="text-slate-500">GST 18%</td>
                  <td className="text-right">{inr(quote.data.gst)}</td>
                </tr>
                <tr className="font-semibold">
                  <td>Total</td>
                  <td className="text-right">{inr(quote.data.total)}</td>
                </tr>
                {quote.data.amcPerYear > 0 && (
                  <tr>
                    <td className="text-slate-500">AMC from year 2</td>
                    <td className="text-right">{inr(quote.data.amcPerYear)} + GST / year</td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </Card>
      )}
      {editing && (
        <PlanModal
          plan={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onDone={() => {
            setEditing(null);
            plans.reload();
          }}
        />
      )}
    </>
  );
}

function PlanModal({ plan, onClose, onDone }: { plan: Plan | null; onClose: () => void; onDone: () => void }) {
  const features = useResource(() => get<string[]>('/api/features'));
  const [f, setF] = useState({
    code: plan?.code ?? '',
    name: plan?.name ?? '',
    features: plan?.features ?? ['archive', 'journaling', 'external_fetch', 'support_access'],
    maxExternalAccounts: plan?.maxExternalAccounts == null ? '' : String(plan.maxExternalAccounts),
    minUsers: String(plan?.minUsers ?? 1),
    termMonths: String(plan?.termMonths ?? 12),
    amcPct: String(plan?.amcPct ?? 20),
    isActive: plan?.isActive ?? true,
    slabs: (plan?.slabs ?? [
      { upTo: 25, pricePerUser: 1200 },
      { upTo: null, pricePerUser: 1000 },
    ]).map((s) => ({ upTo: s.upTo === null ? '' : String(s.upTo), price: String(s.pricePerUser) })),
  });
  const save = useAction(async () => {
    const body = {
      code: f.code,
      name: f.name,
      features: f.features,
      maxExternalAccounts: f.maxExternalAccounts === '' ? null : Number(f.maxExternalAccounts),
      minUsers: Number(f.minUsers),
      termMonths: Number(f.termMonths),
      amcPct: Number(f.amcPct),
      isActive: f.isActive,
      slabs: f.slabs.map((s) => ({ upTo: s.upTo === '' ? null : Number(s.upTo), pricePerUser: Number(s.price) })),
    };
    if (plan) await patch(`/api/plans/${plan.id}`, body);
    else await post('/api/plans', body);
    onDone();
  });
  return (
    <Modal
      open
      wide
      title={plan ? `Edit ${plan.name}` : 'New plan'}
      onClose={onClose}
      footer={
        <Button busy={save.busy} onClick={() => void save.run()}>
          Save
        </Button>
      }
    >
      <ErrorBanner error={save.error} />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Field label="Code">
          <Input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} disabled={Boolean(plan)} />
        </Field>
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Term (months, 0 = perpetual)">
          <Input type="number" min={0} value={f.termMonths} onChange={(e) => setF({ ...f, termMonths: e.target.value })} />
        </Field>
        <Field label="Minimum users">
          <Input type="number" min={1} value={f.minUsers} onChange={(e) => setF({ ...f, minUsers: e.target.value })} />
        </Field>
        <Field label="External mailboxes" hint="empty = unlimited">
          <Input type="number" min={0} value={f.maxExternalAccounts} onChange={(e) => setF({ ...f, maxExternalAccounts: e.target.value })} />
        </Field>
        <Field label="AMC % per year (perpetual)">
          <Input type="number" min={0} value={f.amcPct} onChange={(e) => setF({ ...f, amcPct: e.target.value })} />
        </Field>
      </div>
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
      <Field label="Price slabs (₹ per user; leave the last “up to” empty)">
        <div className="space-y-2">
          {f.slabs.map((s, i) => (
            <div key={i} className="flex items-center gap-2">
              <span className="text-sm text-slate-500">up to</span>
              <Input className="w-24" value={s.upTo} placeholder="∞" onChange={(e) => setF({ ...f, slabs: f.slabs.map((x, j) => (j === i ? { ...x, upTo: e.target.value } : x)) })} />
              <span className="text-sm text-slate-500">users: ₹</span>
              <Input className="w-28" value={s.price} onChange={(e) => setF({ ...f, slabs: f.slabs.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)) })} />
              <Button variant="ghost" disabled={f.slabs.length === 1} onClick={() => setF({ ...f, slabs: f.slabs.filter((_, j) => j !== i) })}>
                Remove
              </Button>
            </div>
          ))}
          <Button variant="secondary" onClick={() => setF({ ...f, slabs: [...f.slabs, { upTo: '', price: '' }] })}>
            Add slab
          </Button>
        </div>
      </Field>
      <Toggle checked={f.isActive} onChange={(v) => setF({ ...f, isActive: v })} label="Available for new licences" />
    </Modal>
  );
}
