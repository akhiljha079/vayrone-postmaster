import { useState } from 'react';
import { Link } from 'react-router-dom';
import { day, download, post } from '../api';
import { Badge, Button, Card, ErrorBanner, PageHeader, Textarea, useAction } from '../ui';

interface Inspect {
  request: { kind: 'activation' | 'revalidation'; machineId: string; hostname: string; version: string; activeUsers: number; createdAt: string };
  license: { id: number; licenseId: string; company: string; status: string; maxUsers: number; expiresAt: string | null; maxActivations: number } | null;
  activeOn: { id: number; machineId: string; hostname: string | null }[];
  sameMachine: boolean;
  overLimit: boolean;
}

function RequestInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <>
      <input
        type="file"
        accept=".vreq,.txt"
        className="mb-2 block text-sm"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) onChange(await f.text());
        }}
      />
      <Textarea rows={6} className="font-mono text-xs" placeholder="…or paste the request file (-----BEGIN VAYRONE POSTMASTER ACTIVATION REQUEST-----)" value={value} onChange={(e) => onChange(e.target.value)} />
    </>
  );
}

/** Staff and partners: inspect a request file, then issue the licence file. */
export function OfflinePage() {
  const [text, setText] = useState('');
  const [info, setInfo] = useState<Inspect | null>(null);
  const [issued, setIssued] = useState<string | null>(null);
  const inspect = useAction(async () => {
    setIssued(null);
    setInfo(await post<Inspect>('/api/offline/inspect', { request: text }));
  });
  const issue = useAction(async () => {
    const r = await post<{ license: string; fileName: string }>('/api/offline/issue', { request: text });
    download(r.fileName, r.license);
    setIssued(r.fileName);
  });
  const slotsFull = info?.license && !info.sameMachine && info.activeOn.length >= info.license.maxActivations;
  return (
    <>
      <PageHeader title="Offline activation" description="Process a request file from a server without internet access. Customers can also do this themselves on the public portal (/portal)." />
      <Card>
        <ErrorBanner error={inspect.error ?? issue.error} />
        <RequestInput
          value={text}
          onChange={(v) => {
            setText(v);
            setInfo(null);
          }}
        />
        <div className="mt-2 flex justify-end">
          <Button variant="secondary" busy={inspect.busy} disabled={text.length < 50} onClick={() => void inspect.run()}>
            Check request
          </Button>
        </div>
      </Card>
      {info && (
        <Card title="Request" className="mt-4">
          <div className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <b>{info.request.kind === 'activation' ? 'New activation' : 'Re-validation'}</b> from <b>{info.request.hostname}</b>
              <div className="font-mono text-xs text-slate-500">Machine {info.request.machineId}</div>
              <div className="text-xs text-slate-500">
                Version {info.request.version}, {info.request.activeUsers} active users, created {day(info.request.createdAt)}
              </div>
            </div>
            <div>
              {info.license ? (
                <>
                  <Link to={`/licenses/${info.license.id}`} className="font-mono text-brand-700 hover:underline">
                    {info.license.licenseId}
                  </Link>{' '}
                  — {info.license.company} <Badge color={info.license.status === 'active' ? 'green' : 'red'}>{info.license.status}</Badge>
                  <div className="text-xs text-slate-500">
                    {info.license.maxUsers} users, expires {day(info.license.expiresAt)}
                  </div>
                  {info.sameMachine && <div className="text-xs text-emerald-700">Same server as the current activation.</div>}
                  {slotsFull && (
                    <div className="text-xs text-red-700">
                      Already active on {info.activeOn.map((a) => a.hostname ?? a.machineId).join(', ')}. Transfer it on the licence page first.
                    </div>
                  )}
                  {info.overLimit && <div className="text-xs text-amber-700">The server has more active users than licensed.</div>}
                </>
              ) : (
                <span className="text-red-700">No licence matches this request (or it belongs to another partner).</span>
              )}
            </div>
          </div>
          <div className="mt-3 flex items-center justify-end gap-3">
            {issued && <span className="text-sm text-emerald-700">Downloaded {issued} — send it to the client.</span>}
            <Button busy={issue.busy} disabled={!info.license || Boolean(slotsFull)} onClick={() => void issue.run()}>
              Issue licence file
            </Button>
          </div>
        </Card>
      )}
    </>
  );
}

/** Public page for customers: upload the request file, download the licence file. */
export function PortalPage() {
  const [text, setText] = useState('');
  const [done, setDone] = useState<{ fileName: string; client: string; licenseId: string } | null>(null);
  const go = useAction(async () => {
    const r = await post<{ license: string; fileName: string; client: string; licenseId: string }>('/api/v1/offline', { request: text });
    download(r.fileName, r.license);
    setDone(r);
  });
  return (
    <div className="mx-auto max-w-2xl p-4 sm:p-8">
      <h1 className="text-xl font-semibold text-slate-900">Vayrone PostMaster — offline activation</h1>
      <p className="mt-1 mb-4 text-sm text-slate-600">
        For mail servers without internet access. On the server, open <b>Admin → Licence → Offline activation</b>, download the request file, bring it to this computer and upload it here. Then import the licence file you
        get back on the server.
      </p>
      <Card>
        <ErrorBanner error={go.error} />
        {done ? (
          <div className="text-sm">
            <p className="text-emerald-700">
              Licence file <b>{done.fileName}</b> downloaded for {done.client} ({done.licenseId}).
            </p>
            <p className="mt-2 text-slate-600">Copy it to the server and import it on the Licence page.</p>
            <Button
              variant="secondary"
              className="mt-3"
              onClick={() => {
                setDone(null);
                setText('');
              }}
            >
              Process another request
            </Button>
          </div>
        ) : (
          <>
            <RequestInput value={text} onChange={setText} />
            <div className="mt-2 flex justify-end">
              <Button busy={go.busy} disabled={text.length < 50} onClick={() => void go.run()}>
                Get licence file
              </Button>
            </div>
          </>
        )}
      </Card>
      <p className="mt-4 text-center text-xs text-slate-500">Vayrone Infratech, Agra · Need help? Contact Vayrone support or your partner.</p>
    </div>
  );
}
