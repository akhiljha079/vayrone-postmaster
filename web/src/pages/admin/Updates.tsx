import { useEffect, useRef, useState } from 'react';
import { formatBytes, formatDate, get, post, put } from '../../api';
import { useMe } from '../../auth';
import { Badge, Button, Card, ErrorBanner, Field, PageHeader, Select, Spinner, Table, Td, Toggle, useAction, useConfirm, useResource } from '../../components/ui';

interface Available {
  version: string;
  releasedAt: string;
  notes: string;
  size: number;
  minVersion: string;
  checkedAt: string;
}
interface Staged {
  version: string;
  file: string;
  size: number;
  source: 'online' | 'offline';
  releasedAt: string;
  notes: string;
  verifiedAt: string;
}
interface UpdatesInfo {
  current: string;
  target: string;
  format: 'sea' | 'node';
  docker: boolean;
  settings: { channel: 'stable' | 'beta'; autoCheck: boolean; url: string };
  available: Available | null;
  staged: Staged | null;
  download: { active: boolean; version: string; received: number; total: number; error: string | null };
  updater: { ok: boolean; how: string };
  history: { id: number; fromVersion: string; toVersion: string; channel: string; status: string; startedAt: string; finishedAt: string | null; startedBy: string | null }[];
}

const STATUS_COLOR: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = { installed: 'green', failed: 'red', rolled_back: 'amber', verifying: 'blue', backing_up: 'blue', migrating: 'blue', downloading: 'blue' };
const STATUS_LABEL: Record<string, string> = { installed: 'Installed', failed: 'Failed', rolled_back: 'Rolled back', verifying: 'Verifying', backing_up: 'Backing up', migrating: 'Installing', downloading: 'Downloading' };

/** Shown while the services restart: polls until the new version answers. */
function Installing({ historyId, target, from }: { historyId: number; target: string; from: string }) {
  const [state, setState] = useState<{ status: string; log: string } | null>(null);
  const [offline, setOffline] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  useEffect(() => {
    const t = setInterval(async () => {
      try {
        const h = await get<{ status: string; log: string | null }>(`/api/admin/updates/history/${historyId}`);
        setOffline(false);
        setState({ status: h.status, log: h.log ?? '' });
        if (['installed', 'failed', 'rolled_back'].includes(h.status)) setDone(h.status);
      } catch {
        // The web service restarts during the update.
        setOffline(true);
        const v = await fetch('/api/health')
          .then((r) => r.json() as Promise<{ version: string }>)
          .catch(() => null);
        if (v && v.version === target) setDone('installed');
      }
    }, 3000);
    return () => clearInterval(t);
  }, [historyId, target]);
  return (
    <Card title={`Updating ${from} → ${target}`} className="mb-4">
      {done === 'installed' ? (
        <div className="space-y-3 text-sm">
          <p className="text-emerald-800">Vayrone PostMaster {target} is installed and running.</p>
          <Button onClick={() => window.location.reload()}>Reload the page</Button>
        </div>
      ) : done ? (
        <p className="text-sm text-red-800">{done === 'rolled_back' ? 'The update did not succeed and was rolled back; the previous version is running.' : 'The update failed. See the log below.'}</p>
      ) : (
        <div className="flex items-center gap-3 text-sm text-slate-700">
          <span className="h-4 w-4 animate-spin rounded-full border-2 border-brand-500 border-t-transparent" />
          {offline ? 'The services are restarting… this page reconnects automatically.' : `${STATUS_LABEL[state?.status ?? 'verifying'] ?? state?.status}…`}
        </div>
      )}
      {state?.log && <pre className="mt-3 max-h-64 overflow-auto rounded bg-slate-900 p-3 text-xs text-slate-100">{state.log}</pre>}
      <p className="mt-2 text-xs text-slate-500">Mail clients reconnect by themselves. Incoming external mail is fetched again once the worker is back.</p>
    </Card>
  );
}

export function UpdatesPage() {
  const me = useMe();
  const owner = me.user.role === 'super_admin';
  const u = useResource(() => get<UpdatesInfo>('/api/admin/updates'));
  const [confirm, confirmNode] = useConfirm();
  const [installing, setInstalling] = useState<{ id: number; version: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const check = useAction(async () => {
    await post('/api/admin/updates/check');
    u.reload();
  });
  const dl = useAction(async () => {
    await post('/api/admin/updates/download');
    u.reload();
  });
  const upload = useAction(async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    const csrf = document.cookie.split('; ').find((c) => c.startsWith('vpm_csrf='))?.slice(9);
    const res = await fetch('/api/admin/updates/upload', { method: 'POST', body: fd, headers: csrf ? { 'x-vpm-csrf': csrf } : {} });
    if (!res.ok) throw new Error(((await res.json()) as { message?: string }).message ?? 'Upload failed');
    u.reload();
  });
  const install = useAction(async (version: string) => {
    if (!(await confirm(`Install Vayrone PostMaster ${version} now? The services stop for about a minute; mail is not lost. A database snapshot is taken first, and a failed update is rolled back automatically.`, { danger: false, confirmLabel: 'Install now' }))) return;
    const r = await post<{ historyId: number }>('/api/admin/updates/install', { version });
    setInstalling({ id: r.historyId, version });
  });
  const saveSettings = useAction(async (s: Partial<UpdatesInfo['settings']>) => {
    await put('/api/admin/updates/settings', { ...u.data!.settings, ...s });
    u.reload();
  });
  // Follow a running download.
  useEffect(() => {
    if (!u.data?.download.active) return;
    const t = setTimeout(u.reload, 2000);
    return () => clearTimeout(t);
  }, [u.data]);

  if (u.error) return <ErrorBanner error={u.error} />;
  if (!u.data) return <Spinner />;
  const d = u.data;
  const staged = d.staged;
  const offerDownload = d.available && (!staged || staged.version !== d.available.version);
  return (
    <>
      {confirmNode}
      <PageHeader title="Updates" description={`Installed: Vayrone PostMaster ${d.current} (${d.target})`} />
      {installing && <Installing historyId={installing.id} target={installing.version} from={d.current} />}
      <ErrorBanner error={check.error ?? dl.error ?? upload.error ?? install.error ?? saveSettings.error} />
      {d.docker ? (
        <Card>
          <p className="text-sm text-slate-700">This server runs in Docker. Update it by pulling the new image: docker compose pull &amp;&amp; docker compose up -d</p>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card title="Available update" actions={<Button variant="secondary" busy={check.busy} onClick={() => void check.run()}>Check now</Button>}>
            {staged ? (
              <div className="space-y-3 text-sm">
                <div>
                  <b>Version {staged.version}</b> <Badge color="green">verified</Badge>{' '}
                  <span className="text-slate-500">
                    ({staged.source === 'offline' ? 'uploaded' : 'downloaded'}, released {formatDate(staged.releasedAt)}, {formatBytes(staged.size)})
                  </span>
                </div>
                {staged.notes && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs ring-1 ring-slate-200">{staged.notes}</pre>}
                {!d.updater.ok && <p className="text-amber-800">The updater service is not running on this server; reinstall with the latest installer to enable one-click updates.</p>}
                {owner && (
                  <Button busy={install.busy} disabled={!d.updater.ok || Boolean(installing)} onClick={() => void install.run(staged.version)}>
                    Install {staged.version}
                  </Button>
                )}
              </div>
            ) : d.available ? (
              <div className="space-y-3 text-sm">
                <div>
                  <b>Version {d.available.version}</b> <span className="text-slate-500">released {formatDate(d.available.releasedAt)}, {formatBytes(d.available.size)}</span>
                </div>
                {d.available.notes && <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-2 text-xs ring-1 ring-slate-200">{d.available.notes}</pre>}
              </div>
            ) : (
              <p className="text-sm text-slate-600">No update known. {d.settings.autoCheck ? 'The server checks once a day when it has internet access.' : ''}</p>
            )}
            {offerDownload && owner && (
              <div className="mt-3">
                {d.download.active ? (
                  <div className="text-sm text-slate-700">
                    Downloading {d.download.version}: {formatBytes(d.download.received)} of {formatBytes(d.download.total)}
                    <div className="mt-1 h-1.5 rounded bg-slate-100">
                      <div className="h-1.5 rounded bg-brand-500" style={{ width: `${d.download.total ? Math.round((d.download.received / d.download.total) * 100) : 0}%` }} />
                    </div>
                  </div>
                ) : (
                  <Button busy={dl.busy} onClick={() => void dl.run()}>
                    Download {d.available!.version}
                  </Button>
                )}
                {d.download.error && <p className="mt-2 text-sm text-red-700">{d.download.error}</p>}
              </div>
            )}
          </Card>
          <Card title="Settings and offline updates">
            <Field label="Channel" hint="Beta receives new versions earlier; use it on a test server first.">
              <Select value={d.settings.channel} disabled={!owner} onChange={(e) => void saveSettings.run({ channel: e.target.value as 'stable' | 'beta' })}>
                <option value="stable">Stable</option>
                <option value="beta">Beta</option>
              </Select>
            </Field>
            <Toggle checked={d.settings.autoCheck} disabled={!owner} onChange={(v) => void saveSettings.run({ autoCheck: v })} label="Check for updates daily" />
            {owner && (
              <div className="mt-4 border-t border-slate-100 pt-3 text-sm">
                <div className="mb-1 font-medium text-slate-900">Offline update file</div>
                <p className="mb-2 text-slate-600">For servers without internet: upload the .vpmupdate file from Vayrone or your partner. It is checked against Vayrone's signature before it can be installed.</p>
                <input ref={fileRef} type="file" accept=".vpmupdate" className="block text-sm" onChange={(e) => e.target.files?.[0] && void upload.run(e.target.files[0])} />
                {upload.busy && <p className="mt-1 text-slate-500">Uploading and verifying…</p>}
              </div>
            )}
            <p className="mt-3 text-xs text-slate-500">Updates released after the AMC end date need a renewed AMC (Admin → Licence).</p>
          </Card>
        </div>
      )}
      <Card title="Update history" className="mt-4">
        {d.history.length ? (
          <Table head={['Started', 'Update', 'Source', 'By', 'Result']}>
            {d.history.map((h) => (
              <tr key={h.id}>
                <Td>{formatDate(h.startedAt)}</Td>
                <Td>
                  {h.fromVersion} → {h.toVersion}
                </Td>
                <Td>{h.channel}</Td>
                <Td>{h.startedBy ?? '—'}</Td>
                <Td>
                  <Badge color={STATUS_COLOR[h.status] ?? 'slate'}>{STATUS_LABEL[h.status] ?? h.status}</Badge>
                </Td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="text-sm text-slate-500">No updates installed yet.</p>
        )}
      </Card>
    </>
  );
}
