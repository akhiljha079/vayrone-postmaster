// Website admin → Licences: every PostMaster licence, with search.
import Link from 'next/link';
import { requireWebsiteAdmin } from '../../../lib/admin-guard';
import { VlsError } from '../../../lib/vayrone-license';
import { vls } from '../../../lib/vls.server';

export const dynamic = 'force-dynamic';

const day = (d: string | null) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Never');
const STATUS: Record<string, string> = { active: 'bg-emerald-100 text-emerald-800', suspended: 'bg-amber-100 text-amber-800', revoked: 'bg-slate-200 text-slate-700' };

export default async function LicencesPage({ searchParams }: { searchParams: Promise<{ q?: string; page?: string }> }) {
  await requireWebsiteAdmin();
  const { q = '', page = '1' } = await searchParams;
  let data: Awaited<ReturnType<ReturnType<typeof vls>['listLicenses']>> | null = null;
  let error: string | null = null;
  try {
    data = await vls().listLicenses({ q: q || undefined, page: Number(page) || 1 });
  } catch (e) {
    error = e instanceof VlsError ? e.message : 'The License Server could not be reached';
  }
  return (
    <main className="mx-auto max-w-6xl space-y-5 px-4 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">PostMaster licences</h1>
          <p className="text-sm text-slate-600">Issued through the Vayrone License Server. The user count limits how many mailboxes each client can create.</p>
        </div>
        <div className="flex gap-2">
          <Link href="/admin/licences/offline" className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">
            Offline licence file
          </Link>
          <Link href="/admin/licences/new" className="rounded-md bg-blue-700 px-3 py-2 text-sm font-medium text-white hover:bg-blue-800">
            New licence
          </Link>
        </div>
      </header>
      <form className="flex gap-2">
        <input name="q" defaultValue={q} placeholder="Company, licence number, key, e-mail or phone" className="w-full max-w-md rounded-md border border-slate-300 px-3 py-2 text-sm" />
        <button className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-50">Search</button>
      </form>
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      {data && !data.items.length && <p className="py-10 text-center text-sm text-slate-500">{q ? 'No licence matches.' : 'No licences yet.'}</p>}
      {data && data.items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2">Licence</th>
                <th className="px-3 py-2">Client</th>
                <th className="px-3 py-2">Plan</th>
                <th className="px-3 py-2 text-right">Users</th>
                <th className="px-3 py-2">Expires</th>
                <th className="px-3 py-2">AMC</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((l) => (
                <tr key={l.id} className="border-t border-slate-100 hover:bg-slate-50">
                  <td className="px-3 py-2 font-mono text-xs">
                    <Link href={`/admin/licences/${l.id}`} className="text-blue-700 hover:underline">
                      {l.licenseId}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    {l.company}
                    {l.city && <span className="text-slate-500"> · {l.city}</span>}
                  </td>
                  <td className="px-3 py-2">{l.plan}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {l.usedUsers ?? '–'} / {l.maxUsers}
                  </td>
                  <td className="px-3 py-2">{day(l.expiresAt)}</td>
                  <td className="px-3 py-2">{day(l.amcExpiresAt)}</td>
                  <td className="px-3 py-2">
                    <span className={`rounded px-1.5 py-0.5 text-xs ${STATUS[l.status] ?? ''}`}>{l.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > 50 && (
        <nav className="flex justify-between text-sm">
          {Number(page) > 1 ? <Link href={`?q=${encodeURIComponent(q)}&page=${Number(page) - 1}`}>← Previous</Link> : <span />}
          {Number(page) * 50 < data.total && <Link href={`?q=${encodeURIComponent(q)}&page=${Number(page) + 1}`}>Next →</Link>}
        </nav>
      )}
    </main>
  );
}
