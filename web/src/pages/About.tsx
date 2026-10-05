import { formatDate, get } from '../api';
import { Card, ErrorBanner, PageHeader, Spinner, useResource } from '../components/ui';

interface About {
  product: { name: string; vendor: string; tagline: string };
  version: string;
  company: string | null;
  hostname: string;
  license: { status: string; licensedTo: string | null; licenseId: string | null; plan: string | null; maxUsers: number | null; expiresAt: string | null; amcExpiresAt: string | null } | null;
  copyright: string;
}

export function AboutPage() {
  const a = useResource(() => get<About>('/api/about'));
  if (a.error) return <ErrorBanner error={a.error} />;
  if (!a.data) return <Spinner />;
  const x = a.data;
  return (
    <>
      <PageHeader title={`About ${x.product.name}`} />
      <Card>
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-brand-700 text-xl font-bold text-white">VP</div>
          <div>
            <div className="text-lg font-semibold text-slate-900">{x.product.tagline}</div>
            <div className="text-sm text-slate-500">Version {x.version}</div>
          </div>
        </div>
        <dl className="mt-5 grid gap-y-2 text-sm sm:grid-cols-[12rem_1fr]">
          {x.company && (
            <>
              <dt className="text-slate-500">Installed for</dt>
              <dd>{x.company}</dd>
            </>
          )}
          <dt className="text-slate-500">Server</dt>
          <dd>{x.hostname}</dd>
          {x.license && (
            <>
              <dt className="text-slate-500">Licence</dt>
              <dd>
                {x.license.licenseId ? `${x.license.licenseId} — ${x.license.plan}, ${x.license.maxUsers} users, licensed to ${x.license.licensedTo}` : x.license.status}
              </dd>
              <dt className="text-slate-500">Expires / AMC</dt>
              <dd>
                {x.license.expiresAt ? formatDate(x.license.expiresAt) : x.license.licenseId ? 'perpetual' : '—'} / {formatDate(x.license.amcExpiresAt)}
              </dd>
            </>
          )}
          <dt className="text-slate-500">Support</dt>
          <dd>Vayrone Infratech, Agra, India — or your Vayrone partner</dd>
        </dl>
        <p className="mt-6 text-xs text-slate-500">
          {x.copyright} This product includes open-source components; their licences are listed in THIRD_PARTY_LICENSES.md in the installation folder.
        </p>
      </Card>
    </>
  );
}
