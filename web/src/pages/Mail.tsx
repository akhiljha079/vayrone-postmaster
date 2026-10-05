import { formatBytes, get } from '../api';
import { useMe } from '../auth';
import { Badge, Card, ErrorBanner, PageHeader, Spinner, Table, Td, useResource } from '../components/ui';

interface Summary {
  login: string;
  displayName: string;
  addresses: string[];
  quota: { used: number; limit: number | null };
  folders: { path: string; specialUse: string | null; messages: number; unseen: number; bytes: number }[];
  server: {
    host: string;
    imap: { ssl: number | null; starttls: number | null } | null;
    pop3: { ssl: number | null; starttls: number | null } | null;
    smtp: { ssl: number | null; starttls: number | null } | null;
  };
}

function ServerRow({ label, s, host }: { label: string; s: { ssl: number | null; starttls: number | null } | null; host: string }) {
  if (!s) {
    return (
      <tr>
        <Td className="font-medium">{label}</Td>
        <Td colSpan={2}>
          <Badge>Disabled for your account</Badge>
        </Td>
      </tr>
    );
  }
  return (
    <tr>
      <Td className="font-medium">{label}</Td>
      <Td className="font-mono">{host}</Td>
      <Td className="tabular">
        {s.ssl ? `${s.ssl} (SSL/TLS)` : ''}
        {s.ssl && s.starttls ? ' or ' : ''}
        {s.starttls ? `${s.starttls} (STARTTLS)` : ''}
      </Td>
    </tr>
  );
}

export function MailHome() {
  const me = useMe();
  const { data, error, loading } = useResource(() => get<Summary>('/api/mail/summary'));
  const pct = data?.quota.limit ? Math.min(100, Math.round((data.quota.used / data.quota.limit) * 100)) : 0;
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader title={`Hello, ${me.user.displayName}`} description="Your office mailbox on the LAN mail server." />
      <ErrorBanner error={error} />
      {loading && <Spinner />}
      {data && (
        <div className="grid gap-5 md:grid-cols-2">
          <Card title="Mailbox">
            <dl className="space-y-2 text-sm">
              <div>
                <dt className="text-slate-500">Addresses</dt>
                <dd className="font-medium">{data.addresses.join(', ')}</dd>
              </div>
              <div>
                <dt className="text-slate-500">Storage</dt>
                <dd>
                  {formatBytes(data.quota.used)} of {data.quota.limit ? formatBytes(data.quota.limit) : 'unlimited'}
                  {data.quota.limit && (
                    <div className="mt-1 h-2 rounded bg-slate-100">
                      <div className={`h-2 rounded ${pct > 90 ? 'bg-red-500' : pct > 75 ? 'bg-amber-500' : 'bg-brand-500'}`} style={{ width: `${pct}%` }} />
                    </div>
                  )}
                </dd>
              </div>
            </dl>
          </Card>
          <Card title="Folders">
            <Table head={['Folder', 'Messages', 'Unread']}>
              {data.folders.map((f) => (
                <tr key={f.path}>
                  <Td>{f.path}</Td>
                  <Td className="tabular">{f.messages}</Td>
                  <Td className="tabular">{f.unseen ? <Badge color="blue">{f.unseen}</Badge> : '—'}</Td>
                </tr>
              ))}
            </Table>
          </Card>
          <Card title="Set up Outlook or Thunderbird" className="md:col-span-2">
            <p className="mb-3 text-sm text-slate-600">
              Use your email address <span className="font-medium">{data.login}</span> as the user name and your office mail password. Choose IMAP to keep mail in sync across
              devices.
            </p>
            <Table head={['Protocol', 'Server', 'Port']}>
              <ServerRow label="Incoming (IMAP)" s={data.server.imap} host={data.server.host} />
              <ServerRow label="Incoming (POP3)" s={data.server.pop3} host={data.server.host} />
              <ServerRow label="Outgoing (SMTP)" s={data.server.smtp} host={data.server.host} />
            </Table>
            <p className="mt-3 text-xs text-slate-500">Outgoing mail requires authentication with the same user name and password.</p>
          </Card>
          <Card title="Rules & out of office">
            <p className="mb-3 text-sm text-slate-600">Set an automatic reply while you are away, forward your mail, or sort it into folders automatically.</p>
            <a href="/mail/settings" className="inline-flex rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
              Open settings
            </a>
          </Card>
          <Card title="Webmail">
            <p className="mb-3 text-sm text-slate-600">Read and write mail in the browser — new mail appears instantly.</p>
            <a href="/mail" className="inline-flex rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">
              Open webmail
            </a>
          </Card>
        </div>
      )}
    </div>
  );
}
