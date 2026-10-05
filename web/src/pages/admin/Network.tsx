import { useEffect, useState } from 'react';
import { formatDate, get, put } from '../../api';
import { useMe } from '../../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, PageHeader, Select, Spinner, Textarea, useAction, useConfirm, useResource } from '../../components/ui';

interface NetworkState {
  hostname: string;
  listenHost: string;
  ports: Record<'submission' | 'smtps' | 'imap' | 'imaps' | 'pop3' | 'pop3s', number>;
  webPort: number;
  addresses: string[];
  tls: { subject: string; issuer: string; validFrom: string; validTo: string; selfSigned: boolean; names: string[]; custom: boolean } | null;
}

const PORTS: [keyof NetworkState['ports'], string, string][] = [
  ['submission', 'SMTP submission', 'STARTTLS, usually 587'],
  ['smtps', 'SMTP over SSL', 'usually 465'],
  ['imap', 'IMAP', 'STARTTLS, usually 143'],
  ['imaps', 'IMAP over SSL', 'usually 993'],
  ['pop3', 'POP3', 'STLS, usually 110'],
  ['pop3s', 'POP3 over SSL', 'usually 995'],
];

function readText(f: File): Promise<string> {
  return f.text();
}

export function NetworkPage() {
  const me = useMe();
  const owner = me.user.role === 'super_admin';
  const n = useResource(() => get<NetworkState>('/api/admin/network'));
  const [ask, confirmNode] = useConfirm();
  const [f, setF] = useState<{ hostname: string; listenHost: string; webPort: string; ports: Record<string, string> } | null>(null);
  const [tls, setTls] = useState<'keep' | 'selfsigned' | 'upload'>('keep');
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [restarting, setRestarting] = useState<string | null>(null);
  useEffect(() => {
    if (n.data) setF({ hostname: n.data.hostname, listenHost: n.data.listenHost, webPort: String(n.data.webPort), ports: Object.fromEntries(Object.entries(n.data.ports).map(([k, v]) => [k, String(v)])) });
  }, [n.data]);
  const save = useAction(async () => {
    if (!(await ask('Save the network settings? If anything changed, the mail services restart (about 10 seconds); connected mail programs reconnect by themselves.', { danger: false, confirmLabel: 'Save and apply' }))) return;
    const r = await put<{ restart: boolean; url: string }>('/api/admin/network', {
      hostname: f!.hostname,
      listenHost: f!.listenHost,
      webPort: Number(f!.webPort),
      ports: Object.fromEntries(Object.entries(f!.ports).map(([k, v]) => [k, Number(v) || 0])),
      tls: tls === 'upload' ? { mode: 'upload', cert, key } : { mode: tls },
    });
    if (r.restart) {
      setRestarting(r.url);
      setTimeout(() => window.location.assign(r.url), 12_000);
    } else n.reload();
  });
  if (n.error) return <ErrorBanner error={n.error} />;
  if (!n.data || !f) return <Spinner />;
  const t = n.data.tls;
  const days = t ? Math.floor((new Date(t.validTo).getTime() - Date.now()) / 86_400_000) : null;
  if (restarting) {
    return (
      <Card title="Applying network settings">
        <p className="text-sm text-slate-700">
          The services are restarting. Opening <a className="text-brand-700 underline" href={restarting}>{restarting}</a> in a few seconds…
        </p>
      </Card>
    );
  }
  return (
    <>
      {confirmNode}
      <PageHeader title="Network and TLS" description="Server name, ports and the certificate used by mail programs and browsers." />
      <ErrorBanner error={save.error} />
      <div className="grid gap-4 xl:grid-cols-2">
        <Card title="Certificate">
          {t ? (
            <div className="space-y-1 text-sm">
              <div>
                {t.selfSigned ? <Badge color="amber">self-signed</Badge> : <Badge color="green">issued by a certificate authority</Badge>}{' '}
                {days !== null && days < 30 && <Badge color={days < 7 ? 'red' : 'amber'}>{days < 0 ? 'expired' : `${days} days left`}</Badge>}
              </div>
              <div className="text-slate-600">Names: {t.names.join(', ') || t.subject}</div>
              <div className="text-slate-600">
                Valid {formatDate(t.validFrom)} – {formatDate(t.validTo)}
              </div>
              <div className="text-slate-600">
                Mail programs trust a self-signed certificate after it is installed once on each PC:{' '}
                <a className="text-brand-700 underline" href="/api/public/certificate">
                  download the certificate
                </a>
                .
              </div>
            </div>
          ) : (
            <p className="text-sm text-slate-600">No certificate found.</p>
          )}
          {owner && (
            <div className="mt-4 space-y-2 border-t border-slate-100 pt-3 text-sm">
              <label className="flex items-center gap-2">
                <input type="radio" checked={tls === 'keep'} onChange={() => setTls('keep')} /> Keep this certificate
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={tls === 'selfsigned'} onChange={() => setTls('selfsigned')} /> Create a new self-signed certificate (10 years)
              </label>
              <label className="flex items-center gap-2">
                <input type="radio" checked={tls === 'upload'} onChange={() => setTls('upload')} /> Install a certificate from a certificate authority (PEM)
              </label>
              {tls === 'upload' && (
                <div className="grid gap-2 sm:grid-cols-2">
                  <div>
                    <input type="file" accept=".crt,.pem,.cer" className="mb-1 block text-xs" onChange={async (e) => e.target.files?.[0] && setCert(await readText(e.target.files[0]))} />
                    <Textarea rows={5} className="font-mono text-xs" placeholder="Certificate with chain" value={cert} onChange={(e) => setCert(e.target.value)} />
                  </div>
                  <div>
                    <input type="file" accept=".key,.pem" className="mb-1 block text-xs" onChange={async (e) => e.target.files?.[0] && setKey(await readText(e.target.files[0]))} />
                    <Textarea rows={5} className="font-mono text-xs" placeholder="Private key (unencrypted)" value={key} onChange={(e) => setKey(e.target.value)} />
                  </div>
                </div>
              )}
            </div>
          )}
        </Card>
        <Card title="Server name and ports">
          <div className="grid gap-x-3 sm:grid-cols-2">
            <Field label="Server name" hint="The name in Outlook settings and on the certificate">
              <Input value={f.hostname} disabled={!owner} onChange={(e) => setF({ ...f, hostname: e.target.value })} />
            </Field>
            <Field label="Listen on">
              <Select value={f.listenHost} disabled={!owner} onChange={(e) => setF({ ...f, listenHost: e.target.value })}>
                <option value="0.0.0.0">All addresses</option>
                {n.data.addresses.map((a) => (
                  <option key={a}>{a}</option>
                ))}
              </Select>
            </Field>
            <Field label="Web admin / webmail (HTTPS)">
              <Input value={f.webPort} disabled={!owner} onChange={(e) => setF({ ...f, webPort: e.target.value })} />
            </Field>
            {PORTS.map(([k, label, hint]) => (
              <Field key={k} label={label} hint={`${hint}; 0 = off`}>
                <Input value={f.ports[k]} disabled={!owner} onChange={(e) => setF({ ...f, ports: { ...f.ports, [k]: e.target.value } })} />
              </Field>
            ))}
          </div>
          <p className="text-xs text-slate-500">Changing a port also needs the firewall (Windows Firewall, ufw or firewalld) and the mail programs updated.</p>
        </Card>
      </div>
      {owner && (
        <div className="mt-4 flex justify-end">
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save and apply
          </Button>
        </div>
      )}
    </>
  );
}
