'use server';
// Server actions for the licence pages. They run on the website server only:
// the License Server API key never reaches the browser.
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { requireWebsiteAdmin } from '../../../lib/admin-guard';
import { VlsError } from '../../../lib/vayrone-license';
import { vls } from '../../../lib/vls.server';

export interface ActionState {
  error?: string;
  ok?: string;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const num = (f: FormData, k: string) => (str(f, k) === '' ? undefined : Number(str(f, k)));
const message = (e: unknown) => (e instanceof VlsError ? e.message : e instanceof Error ? e.message : 'Something went wrong');

/** New licence for an existing client, or for a new client typed into the form. */
export async function createLicenseAction(_prev: ActionState, f: FormData): Promise<ActionState> {
  await requireWebsiteAdmin();
  let id: number;
  try {
    const api = vls();
    let clientId = num(f, 'clientId');
    if (!clientId) {
      const company = str(f, 'company');
      if (company.length < 2) return { error: 'Choose a client or type the company name' };
      clientId = (
        await api.createClient({
          company,
          contactName: str(f, 'contactName') || null,
          email: str(f, 'email') || null,
          phone: str(f, 'phone') || null,
          city: str(f, 'city') || null,
          gstin: str(f, 'gstin') || null,
        })
      ).id;
    }
    const users = num(f, 'maxUsers');
    if (!users || users < 1) return { error: 'Enter the number of users' };
    const term = str(f, 'term');
    const created = await api.createLicense({
      clientId,
      planId: Number(str(f, 'planId')),
      maxUsers: users,
      ...(term === 'plan' ? {} : { termMonths: Number(term) }),
      amcMonths: num(f, 'amcMonths'),
      maxActivations: num(f, 'maxActivations'),
      amount: num(f, 'amount'),
      invoiceRef: str(f, 'invoiceRef') || undefined,
      notes: str(f, 'notes') || undefined,
    });
    id = created.id;
  } catch (e) {
    return { error: message(e) };
  }
  revalidatePath('/admin/licences');
  redirect(`/admin/licences/${id}?created=1`);
}

/** More (or fewer) users; online servers pick it up within a day. */
export async function changeUsersAction(id: number, _prev: ActionState, f: FormData): Promise<ActionState> {
  await requireWebsiteAdmin();
  const users = num(f, 'maxUsers');
  if (!users || users < 1) return { error: 'Enter the number of users' };
  try {
    await vls().updateLicense(id, { maxUsers: users, amount: num(f, 'amount') ?? 0, invoiceRef: str(f, 'invoiceRef') || '' });
  } catch (e) {
    return { error: message(e) };
  }
  revalidatePath(`/admin/licences/${id}`);
  return { ok: `Now ${users} users. Online servers update within a day; offline servers need a new request file.` };
}

export async function renewAction(id: number, _prev: ActionState, f: FormData): Promise<ActionState> {
  await requireWebsiteAdmin();
  const months = num(f, 'months');
  if (!months) return { error: 'Enter the months' };
  try {
    const r = await vls().renewLicense(id, { kind: str(f, 'kind') === 'amc' ? 'amc' : 'renewal', months, amount: num(f, 'amount') ?? 0, invoiceRef: str(f, 'invoiceRef') || undefined });
    revalidatePath(`/admin/licences/${id}`);
    return { ok: `Extended to ${new Date((r.expiresAt ?? r.amcExpiresAt)!).toLocaleDateString('en-IN', { dateStyle: 'medium' })}` };
  } catch (e) {
    return { error: message(e) };
  }
}

export async function statusAction(id: number, _prev: ActionState, f: FormData): Promise<ActionState> {
  await requireWebsiteAdmin();
  const status = str(f, 'status') as 'active' | 'suspended';
  try {
    await vls().setLicenseStatus(id, status, str(f, 'reason') || undefined);
  } catch (e) {
    return { error: message(e) };
  }
  revalidatePath(`/admin/licences/${id}`);
  return { ok: status === 'active' ? 'Licence reactivated' : 'Licence suspended' };
}

/** Moving to new hardware: frees the licence so the new server can activate it. */
export async function releaseAction(licenceId: number, activationId: number, _prev: ActionState, f: FormData): Promise<ActionState> {
  await requireWebsiteAdmin();
  try {
    await vls().releaseActivation(activationId, str(f, 'reason') || 'Moved to new hardware');
  } catch (e) {
    return { error: message(e) };
  }
  revalidatePath(`/admin/licences/${licenceId}`);
  return { ok: 'Released. The client can now activate the key on the new server.' };
}
