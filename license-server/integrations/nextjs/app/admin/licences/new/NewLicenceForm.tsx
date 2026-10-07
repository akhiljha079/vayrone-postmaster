'use client';
import { useActionState, useState } from 'react';
import { createLicenseAction, type ActionState } from '../actions';

interface PlanOption {
  id: number;
  name: string;
  minUsers: number;
  termMonths: number;
}

const input = 'w-full rounded-md border border-slate-300 px-3 py-2 text-sm';
const label = 'block text-sm font-medium text-slate-700';

export function NewLicenceForm({ plans, clients }: { plans: PlanOption[]; clients: { id: number; company: string; city: string | null }[] }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createLicenseAction, {});
  const [clientId, setClientId] = useState<string>('');
  const [planId, setPlanId] = useState<string>(String(plans[0]?.id ?? ''));
  const plan = plans.find((p) => String(p.id) === planId);
  return (
    <form action={action} className="space-y-6">
      {state.error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{state.error}</p>}

      <fieldset className="space-y-3 rounded-lg border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold">Client</legend>
        <label className={label}>
          Existing client
          <select name="clientId" value={clientId} onChange={(e) => setClientId(e.target.value)} className={input}>
            <option value="">New client…</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.company}
                {c.city ? ` (${c.city})` : ''}
              </option>
            ))}
          </select>
        </label>
        {!clientId && (
          <div className="grid gap-3 sm:grid-cols-2">
            <label className={`${label} sm:col-span-2`}>
              Company name
              <input name="company" required minLength={2} className={input} placeholder="Agra Steel Traders" />
            </label>
            <label className={label}>
              Contact person
              <input name="contactName" className={input} />
            </label>
            <label className={label}>
              E-mail
              <input name="email" type="email" className={input} />
            </label>
            <label className={label}>
              Phone
              <input name="phone" className={input} />
            </label>
            <label className={label}>
              City
              <input name="city" className={input} />
            </label>
            <label className={`${label} sm:col-span-2`}>
              GSTIN
              <input name="gstin" maxLength={15} className={`${input} uppercase`} placeholder="09ABCDE1234F1Z5" />
            </label>
          </div>
        )}
      </fieldset>

      <fieldset className="space-y-3 rounded-lg border border-slate-200 p-4">
        <legend className="px-1 text-sm font-semibold">Licence</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className={label}>
            Plan
            <select name="planId" value={planId} onChange={(e) => setPlanId(e.target.value)} className={input} required>
              {plans.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            Number of users
            <input name="maxUsers" type="number" min={plan?.minUsers ?? 1} defaultValue={Math.max(plan?.minUsers ?? 1, 25)} required className={input} />
            {plan && plan.minUsers > 1 && <span className="mt-1 block text-xs font-normal text-slate-500">This plan starts at {plan.minUsers} users.</span>}
          </label>
          <label className={label}>
            Valid for
            <select name="term" defaultValue="plan" className={input}>
              <option value="plan">Plan default ({plan?.termMonths ? `${plan.termMonths} months` : 'perpetual'})</option>
              <option value="12">12 months</option>
              <option value="24">24 months</option>
              <option value="36">36 months</option>
              <option value="0">Perpetual (no expiry)</option>
            </select>
          </label>
          <label className={label}>
            AMC (support and updates), months
            <input name="amcMonths" type="number" min={0} max={120} placeholder="Same as validity" className={input} />
          </label>
          <label className={label}>
            Servers at the same time
            <input name="maxActivations" type="number" min={1} max={20} defaultValue={1} className={input} />
          </label>
        </div>
      </fieldset>

      <fieldset className="grid gap-3 rounded-lg border border-slate-200 p-4 sm:grid-cols-2">
        <legend className="px-1 text-sm font-semibold">Sale</legend>
        <label className={label}>
          Amount (₹)
          <input name="amount" type="number" min={0} step="1" className={input} />
        </label>
        <label className={label}>
          Invoice number
          <input name="invoiceRef" maxLength={100} className={input} placeholder="VI/26-27/031" />
        </label>
        <label className={`${label} sm:col-span-2`}>
          Notes
          <textarea name="notes" rows={2} className={input} />
        </label>
      </fieldset>

      <button disabled={pending || !plans.length} className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800 disabled:opacity-50">
        {pending ? 'Creating…' : 'Create licence'}
      </button>
      {!plans.length && <p className="text-sm text-amber-700">No active plans. Add plans in the License Server (Plans) first.</p>}
    </form>
  );
}
