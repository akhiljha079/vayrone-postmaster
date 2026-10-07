// Website admin → Licences → Offline licence file: the client's request file in, licence file out.
import Link from 'next/link';
import { requireWebsiteAdmin } from '../../../../lib/admin-guard';

export default async function OfflinePage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  await requireWebsiteAdmin();
  const { error } = await searchParams;
  return (
    <main className="mx-auto max-w-2xl space-y-5 px-4 py-6">
      <Link href="/admin/licences" className="text-sm text-blue-700 hover:underline">
        ← Licences
      </Link>
      <h1 className="text-2xl font-semibold">Licence file for a server without internet</h1>
      <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
        <li>On the client&apos;s PostMaster: Admin → Licence → Offline activation, enter their licence key and download the request file (.vreq).</li>
        <li>Upload it here. The licence file (.vlic) downloads straight away.</li>
        <li>The client imports the .vlic file in Admin → Licence.</li>
      </ol>
      {error && <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      <form action="/api/admin/licences/offline" method="post" encType="multipart/form-data" className="space-y-3 rounded-lg border border-slate-200 p-4">
        <input name="request" type="file" accept=".vreq,text/plain" required className="block text-sm" />
        <button className="rounded-md bg-blue-700 px-4 py-2 text-sm font-medium text-white hover:bg-blue-800">Create licence file</button>
      </form>
    </main>
  );
}
