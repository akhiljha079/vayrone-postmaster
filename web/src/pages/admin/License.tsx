import { useRef, useState, type ReactNode } from 'react';
import { formatDate, get, post } from '../../api';
import { useAuth, useMe } from '../../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Spinner, Table, Td, Textarea, useAction, useResource } from '../../components/ui';

type Status = 'unlicensed' | 'active' | 'grace' | 'expired' | 'tampered' | 'fingerprint_mismatch';

interface LicenseInfo {
  managed: boolean;
  status: Status;
  mode: 'active' | 'grace' | 'readonly' | 'unlicensed';
  reason: string;
  warning: string | null;
  graceEndsAt: string | null;
  deadline: string | null;
  license: {
    licenseId: string;
    keyHint: string;
    client: { name: string; city?: string | null; gstin?: string | null };
    reseller: { name: string } | null;
    plan: { code: string; name: string };
    maxUsers: number;
    maxExternalAccounts: number | null;
    features: string[];
    issuedAt: string;
    expiresAt: string | null;
    amcExpiresAt: string | null;
    checkBy: string;
    activationMode: 'online' | 'offline';
    amcActive: boolean;
    licensedMachineId: string;
  } | null;
  usage: { activeUsers: number; externalAccounts: number };
  machine: { id: string; available: string[]; changed: string[] };
  activation: { at: string | null; lastValidatedAt: string | null; lastHeartbeatAt: string | null; heartbeatFailures: number; lastError: string | null; serverUrl: string };
  revocation: { reason: string; message: string; at: string } | null;
  integrity: 'ok' | 'skipped' | 'failed';
  installedAt: string;
}

interface LicenseEvent {
  id: number;
  at: string;
  event: string;
  detail: Record<string, unknown> | null;
}

const STATUS: Record<Status, { label: string; color: 'green' | 'amber' | 'red' | 'blue' }> = {
  active: { label: 'Active', color: 'green' },
  grace: { label: 'Grace period', color: 'amber' },
  expired: { label: 'Expired — read-only', color: 'red' },
  tampered: { label: 'Needs attention', color: 'red' },
  fingerprint_mismatch: { label: 'Hardware changed', color: 'amber' },
  unlicensed: { label: 'Not activated', color: 'blue' },
};

const FEATURE_LABEL: Record<string, string> = {
  archive: 'Mail archive',
  backup_cloud: 'Cloud backup',
  antivirus: 'Antivirus',
  support_access: 'Vayrone Support access',
  journaling: 'Journaling',
  external_fetch: 'External mailboxes',
};

const EVENT_LABEL: Record<string, string> = {
  activated: 'Activated online',
  offline_import: 'Licence file imported',
  offline_request: 'Request file created',
  heartbeat_fail: 'Licence check failed',
  revoked: 'Notice from License Server',
  deactivated: 'Released for transfer',
  grace_start: 'Grace period started',
  expired: 'Admin panel became read-only',
  tamper: 'Tamper check',
  fingerprint_mismatch: 'Hardware change detected',
  active: 'Licence active',
  unlicensed: 'Evaluation',
};

const day = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
const daysFrom = (d: string) => Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000);

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-4 border-b border-slate-100 py-2 text-sm last:border-0">
      <span className="text-slate-500">{label}</span>
      <span className="text-right font-medium text-slate-900">{children}</span>
    </div>
  );
}

function UsageBar({ used, max }: { used: number; max: number | null }) {
  if (!max) return <span>{used}</span>;
  const pct = Math.min(100, Math.round((used / max) * 100));
  return (
    <div className="w-40">
      <div className="text-right">
        {used} / {max}
      </div>
      <div className="mt-1 h-1.5 rounded bg-slate-100">
        <div className={`h-1.5 rounded ${pct >= 100 ? 'bg-red-500' : pct >= 90 ? 'bg-amber-500' : 'bg-emerald-500'}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function LicensePage() {
  const me = useMe();
  const { refresh } = useAuth();
  const info = useResource(() => get<LicenseInfo>('/api/admin/license'));
  const events = useResource(() => get<LicenseEvent[]>('/api/admin/license/events'), [info.data]);
  const [modal, setModal] = useState<null | 'activate' | 'offline' | 'transfer'>(null);
  const isOwner = me.user.role === 'super_admin';
  const isAdmin = isOwner || me.user.role === 'admin' || me.user.role === 'vayrone_support';
  const changed = async () => {
    info.reload();
    await refresh();
  };
  const check = useAction(async () => {
    await post('/api/admin/license/check');
    await changed();
  });

  if (info.error) return <ErrorBanner error={info.error} />;
  if (!info.data) return <Spinner />;
  const i = info.data;
  if (!i.managed) {
    return (
      <>
        <PageHeader title="Licence" />
        <Card>
          <p className="text-sm text-slate-600">Licensing is not active in this process (development mode).</p>
        </Card>
      </>
    );
  }
  const l = i.license;
  const st = STATUS[i.status];

  return (
    <>
      <PageHeader
        title="Licence"
        description="Your Vayrone PostMaster licence, user count and renewal status. Mail keeps flowing in every licence state."
        actions={
          isOwner && (
            <>
              {l?.activationMode === 'online' && (
                <Button variant="secondary" busy={check.busy} onClick={() => void check.run()}>
                  Check now
                </Button>
              )}
              <Button variant="secondary" onClick={() => setModal('offline')}>
                Offline activation
              </Button>
              <Button onClick={() => setModal('activate')}>{l ? 'Enter new key' : 'Activate'}</Button>
            </>
          )
        }
      />
      <ErrorBanner error={check.error} />

      <div className={`mb-4 rounded-lg px-4 py-3 text-sm ring-1 ${i.mode === 'readonly' ? 'bg-red-50 text-red-900 ring-red-200' : i.mode === 'grace' ? 'bg-amber-50 text-amber-900 ring-amber-200' : i.mode === 'unlicensed' ? 'bg-sky-50 text-sky-900 ring-sky-200' : 'bg-emerald-50 text-emerald-900 ring-emerald-200'}`}>
        <div className="flex items-center gap-2">
          <Badge color={st.color}>{st.label}</Badge>
          <span>{i.reason}</span>
        </div>
        {i.warning && <div className="mt-1 font-medium">{i.warning}</div>}
        {!isOwner && isAdmin && i.mode !== 'active' && <div className="mt-1">Ask a super admin to renew or activate the licence.</div>}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Licence">
          {l ? (
            <>
              <Row label="Licensed to">
                {l.client.name}
                {l.client.city ? `, ${l.client.city}` : ''}
              </Row>
              <Row label="Plan">{l.plan.name}</Row>
              <Row label="Licence">
                <span className="font-mono">{l.licenseId}</span> <span className="text-xs text-slate-500">(key …{l.keyHint})</span>
              </Row>
              <Row label="Expires">
                {l.expiresAt ? (
                  <>
                    {day(l.expiresAt)}
                    {daysFrom(l.expiresAt) >= 0 && <span className="ml-1 text-xs text-slate-500">({daysFrom(l.expiresAt)} days)</span>}
                  </>
                ) : (
                  'Perpetual'
                )}
              </Row>
              <Row label="AMC (updates and support)">
                {day(l.amcExpiresAt)} <Badge color={l.amcActive ? 'green' : 'red'}>{l.amcActive ? 'Active' : 'Expired'}</Badge>
              </Row>
              <Row label="Validation">
                {l.activationMode === 'online' ? 'Online, automatic' : 'Offline, by file'} — due by {day(l.checkBy)}
              </Row>
              {l.reseller && <Row label="Partner">{l.reseller.name}</Row>}
              <Row label="Features">
                <span className="flex flex-wrap justify-end gap-1">
                  {l.features.map((f) => (
                    <Badge key={f} color="blue">
                      {FEATURE_LABEL[f] ?? f}
                    </Badge>
                  ))}
                </span>
              </Row>
            </>
          ) : (
            <div className="space-y-2 text-sm text-slate-600">
              <p>This server runs in evaluation mode: up to 5 users for 30 days from installation ({day(i.installedAt)}).</p>
              <p>Activate with the licence key from Vayrone Infratech or your partner. Without internet access, use offline activation.</p>
            </div>
          )}
        </Card>

        <Card title="Usage and this server">
          <Row label="Active mailbox users">
            <UsageBar used={i.usage.activeUsers} max={l?.maxUsers ?? (i.mode === 'unlicensed' ? 5 : null)} />
          </Row>
          <Row label="External mailboxes">{l?.maxExternalAccounts != null ? `${i.usage.externalAccounts} / ${l.maxExternalAccounts}` : i.usage.externalAccounts}</Row>
          <Row label="Machine ID">
            <span className="font-mono">{i.machine.id}</span>
          </Row>
          {l && l.licensedMachineId !== i.machine.id && (
            <Row label="Activated on">
              <span className="font-mono">{l.licensedMachineId}</span>
              {i.machine.changed.length > 0 && <span className="ml-1 text-xs text-amber-700">(changed: {i.machine.changed.join(', ')})</span>}
            </Row>
          )}
          <Row label="Activated">{formatDate(i.activation.at)}</Row>
          {l?.activationMode === 'online' && (
            <>
              <Row label="Last successful check">{formatDate(i.activation.lastValidatedAt)}</Row>
              {i.activation.heartbeatFailures > 0 && (
                <Row label="Last check">
                  <span className="text-amber-700">
                    failed {i.activation.heartbeatFailures}× — {i.activation.lastError}
                  </span>
                </Row>
              )}
            </>
          )}
          <Row label="Program files">{i.integrity === 'ok' ? 'Verified' : i.integrity === 'failed' ? <span className="text-red-700">Modified — reinstall</span> : 'Not checked (development build)'}</Row>
          {isOwner && l?.activationMode === 'online' && !i.revocation && (
            <div className="pt-3 text-right">
              <Button variant="ghost" onClick={() => setModal('transfer')}>
                Move licence to another server…
              </Button>
            </div>
          )}
        </Card>
      </div>

      <Card title="Licence history" className="mt-4">
        {events.data && events.data.length > 0 ? (
          <Table head={['When', 'Event', 'Details']}>
            {events.data.slice(0, 30).map((e) => (
              <tr key={e.id}>
                <Td className="whitespace-nowrap">{formatDate(e.at)}</Td>
                <Td>{EVENT_LABEL[e.event] ?? e.event}</Td>
                <Td className="text-xs text-slate-500">{e.detail ? String(e.detail.reason ?? e.detail.error ?? e.detail.message ?? e.detail.licenseId ?? '') : ''}</Td>
              </tr>
            ))}
          </Table>
        ) : (
          <p className="text-sm text-slate-500">No licence events yet.</p>
        )}
      </Card>

      {modal === 'activate' && <ActivateModal onClose={() => setModal(null)} onDone={changed} />}
      {modal === 'offline' && <OfflineModal hasLicense={Boolean(l)} onClose={() => setModal(null)} onDone={changed} />}
      {modal === 'transfer' && <TransferModal onClose={() => setModal(null)} onDone={changed} />}
    </>
  );
}

function ActivateModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const act = useAction(async () => {
    await post('/api/admin/license/activate', { key });
    await onDone();
    onClose();
  });
  return (
    <Modal
      open
      title="Activate online"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={act.busy} disabled={key.trim().length < 20} onClick={() => void act.run()}>
            Activate
          </Button>
        </>
      }
    >
      <ErrorBanner error={act.error} />
      <Field label="Licence key" hint="From your Vayrone invoice or partner, e.g. VPM-7K2QD-…. This server needs internet access for a moment.">
        <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="VPM-XXXXX-XXXXX-XXXXX-XXXXX-X" className="font-mono" autoFocus />
      </Field>
    </Modal>
  );
}

function OfflineModal({ hasLicense, onClose, onDone }: { hasLicense: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [key, setKey] = useState('');
  const [text, setText] = useState('');
  const file = useRef<HTMLInputElement>(null);
  const request = useAction(async () => {
    const r = await post<{ fileName: string; text: string }>('/api/admin/license/offline-request', { key: key.trim() || null });
    download(r.fileName, r.text);
  });
  const imp = useAction(async () => {
    await post('/api/admin/license/import', { text });
    await onDone();
    onClose();
  });
  return (
    <Modal open wide title="Offline activation" onClose={onClose}>
      <ol className="space-y-5 text-sm">
        <li>
          <div className="mb-2 font-medium text-slate-900">1. Create a request file on this server</div>
          <ErrorBanner error={request.error} />
          <div className="flex flex-wrap items-end gap-2">
            <Field label={hasLicense ? 'Licence key (only for a new licence)' : 'Licence key'} className="min-w-72 flex-1">
              <Input value={key} onChange={(e) => setKey(e.target.value)} placeholder="VPM-XXXXX-XXXXX-XXXXX-XXXXX-X" className="font-mono" />
            </Field>
            <Button variant="secondary" busy={request.busy} disabled={!hasLicense && key.trim().length < 20} onClick={() => void request.run()}>
              Download request file
            </Button>
          </div>
          {hasLicense && <p className="mt-1 text-xs text-slate-500">Leave the key empty to re-validate the current licence (needed every 90 days for offline servers).</p>}
        </li>
        <li>
          <div className="font-medium text-slate-900">2. On any computer with internet</div>
          <p className="text-slate-600">Upload the request file on the Vayrone licence portal (or send it to your partner / Vayrone support). You receive a licence file (.vlic).</p>
        </li>
        <li>
          <div className="mb-2 font-medium text-slate-900">3. Import the licence file</div>
          <ErrorBanner error={imp.error} />
          <input
            ref={file}
            type="file"
            accept=".vlic,.txt"
            className="mb-2 block text-sm"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) setText(await f.text());
            }}
          />
          <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} placeholder="…or paste the licence file here" className="font-mono text-xs" />
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
            <Button busy={imp.busy} disabled={text.trim().length < 50} onClick={() => void imp.run()}>
              Import licence
            </Button>
          </div>
        </li>
      </ol>
    </Modal>
  );
}

function TransferModal({ onClose, onDone }: { onClose: () => void; onDone: () => Promise<void> }) {
  const [confirm, setConfirm] = useState('');
  const act = useAction(async () => {
    await post('/api/admin/license/deactivate', { confirm: 'TRANSFER' });
    await onDone();
    onClose();
  });
  return (
    <Modal
      open
      title="Move the licence to another server"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" busy={act.busy} disabled={confirm !== 'TRANSFER'} onClick={() => void act.run()}>
            Release this server
          </Button>
        </>
      }
    >
      <ErrorBanner error={act.error} />
      <div className="space-y-2 text-sm text-slate-700">
        <p>This releases the licence on the License Server so you can activate the same key on your new server.</p>
        <p>This server then has 15 days to finish the move: mail keeps flowing, after that its admin panel becomes read-only.</p>
        <Field label="Type TRANSFER to confirm">
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        </Field>
      </div>
    </Modal>
  );
}
