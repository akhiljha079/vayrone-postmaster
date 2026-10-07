// Website admin → Licences → New licence.
import Link from 'next/link';
import { requireWebsiteAdmin } from '../../../../lib/admin-guard';
import { vls } from '../../../../lib/vls.server';
import { NewLicenceForm } from './NewLicenceForm';

export const dynamic = 'force-dynamic';

export default async function NewLicencePage() {
  await requireWebsiteAdmin();
  const api = vls();
  const [plans, clients] = await Promise.all([api.plans(), api.listClients({ pageSize: 500 })]);
  return (
    <main className="mx-auto max-w-3xl space-y-5 px-4 py-6">
      <Link href="/admin/licences" className="text-sm text-blue-700 hover:underline">
        ← Licences
      </Link>
      <h1 className="text-2xl font-semibold">New PostMaster licence</h1>
      <NewLicenceForm
        plans={plans.filter((p) => p.isActive).map((p) => ({ id: p.id, name: p.name, minUsers: p.minUsers, termMonths: p.termMonths }))}
        clients={clients.items.map((c) => ({ id: c.id, company: c.company, city: c.city }))}
      />
    </main>
  );
}
