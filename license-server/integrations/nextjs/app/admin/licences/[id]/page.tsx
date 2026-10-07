// Website admin → Licences → one licence: key, users, expiry, servers, history, and actions.
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { requireWebsiteAdmin } from '../../../../lib/admin-guard';
import { VlsError } from '../../../../lib/vayrone-license';
import { vls } from '../../../../lib/vls.server';
import { changeUsersAction, releaseAction, renewAction, statusAction } from '../actions';
import { ActionForm, CopyKey } from './forms';

export const dynamic = 'force-dynamic';

const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never');
const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm';

export default async function LicencePage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ created?: string }> }) {
  await requireWebsiteAdmin();
  const { id: rawId } = await params;
  const { created } = await searchParams;
  const id = Number(rawId);
  if (!Number.isInteger(id) || id < 1) notFound();
  let l;
  try {
    l = await vls().getLicense(id);
  } catch (e) {
    if (e instanceof VlsError && e.status === 404) notFound();
    throw e;
  }
  const active = l.activations.filter((a) => a.status === 'active');
  const used = active[0]?.activeUsers ?? null;
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <Link href="/admin/licences" className="text-sm text-blue-700 hover:underline">
        ← Licences
      </Link>
      {created && <p className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">Licence created. Give the key below to the client (or their technician).</p>}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">{l.client.company}</h1>
          <p className="text-sm text-slate-600">
            {l.licenseId} · {l.plan.name} · <span className="capitalize">{l.status}</span>
            {l.statusReason ? ` (${l.statusReason})` : ''}
          </p>
        </div>
        <CopyKey value={l.licenseKey} />
      </header>

      <section className="grid gap-3 sm:grid-cols-4">
        {[
          ['Users', `${used ?? '–'} used of ${l.maxUsers}`],
          ['Expires', day(l.expiresAt)],
          ['AMC until', day(l.amcExpiresAt)],
          ['Servers', `${active.length} of ${l.maxActivations}`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-slate-200 p-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">{k}</div>
            <div className="mt-1 font-medium tabular-nums">{v}</div>
          </div>
        ))}
      </section>

      <section className="grid gap-4 md:grid-cols-2">
        <ActionForm title="Change number of users" action={changeUsersAction.bind(null, l.id)} submit="Save users">
          <label className="block text-sm">
            Users
            <input name="maxUsers" type="number" min={1} defaultValue={l.maxUsers} required className={input} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              Amount (₹)
              <input name="amount" type="number" min={0} className={input} />
            </label>
            <label className="block text-sm">
              Invoice
              <input name="invoiceRef" className={input} />
            </label>
          </div>
        </ActionForm>

        <ActionForm title="Renew" action={renewAction.bind(null, l.id)} submit="Renew">
          <div className="grid grid-cols-2 gap-2">
            <label className="block text-sm">
              What
              <select name="kind" defaultValue={l.expiresAt ? 'renewal' : 'amc'} className={input}>
                {l.expiresAt && <option value="renewal">Licence (includes AMC)</option>}
                <option value="amc">AMC only</option>
              </select>
            </label>
            <label className="block text-sm">
              Months
              <input name="months" type="number" min={1} max={120} defaultValue={12} required className={input} />
            </label>
            <label className="block text-sm">
              Amount (₹)
              <input name="amount" type="number" min={0} className={input} />
            </label>
            <label className="block text-sm">
              Invoice
              <input name="invoiceRef" className={input} />
            </label>
          </div>
        </ActionForm>

        <ActionForm
          title={l.status === 'active' ? 'Suspend' : 'Reactivate'}
          action={statusAction.bind(null, l.id)}
          submit={l.status === 'active' ? 'Suspend licence' : 'Reactivate licence'}
          danger={l.status === 'active'}
        >
          <input type="hidden" name="status" value={l.status === 'active' ? 'suspended' : 'active'} />
          {l.status === 'active' ? (
            <label className="block text-sm">
              Reason (the client sees it)
              <input name="reason" required minLength={3} className={input} placeholder="Invoice VI/26-27/031 unpaid" />
            </label>
          ) : (
            <p className="text-sm text-slate-600">The client&apos;s server becomes fully licensed again at its next check.</p>
          )}
          <p className="text-xs text-slate-500">Mail keeps flowing while suspended; the client&apos;s admin panel becomes read-only after the grace period.</p>
        </ActionForm>

        <div className="rounded-lg border border-slate-200 p-4">
          <h2 className="mb-2 font-semibold">Servers</h2>
          {!active.length ? (
            <p className="text-sm text-slate-500">Not activated yet. The client enters the key in the PostMaster setup wizard.</p>
          ) : (
            <ul className="space-y-3 text-sm">
              {active.map((a) => (
                <li key={a.id} className="space-y-1">
                  <div>
                    <span className="font-medium">{a.hostname ?? a.machineId}</span> · {a.mode} · version {a.version ?? '?'} · last seen {day(a.lastSeenAt)}
                  </div>
                  <ActionForm action={releaseAction.bind(null, l.id, a.id)} submit="Move to new hardware" compact>
                    <input type="hidden" name="reason" value="Moved to new hardware (website admin)" />
                  </ActionForm>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <section>
        <h2 className="mb-2 font-semibold">Sales and renewals</h2>
        <table className="w-full text-sm">
          <tbody>
            {l.renewals.map((r) => (
              <tr key={r.id} className="border-t border-slate-100">
                <td className="py-1.5 capitalize">{r.kind}</td>
                <td className="py-1.5">
                  {day(r.periodFrom)} – {day(r.periodTo)}
                </td>
                <td className="py-1.5 tabular-nums">{r.users} users</td>
                <td className="py-1.5 text-right tabular-nums">₹{Number(r.amount).toLocaleString('en-IN')}</td>
                <td className="py-1.5 text-slate-500">{r.invoiceRef ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
