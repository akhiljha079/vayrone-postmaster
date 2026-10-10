import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { del, formatBytes, formatDate, get, patch, post, put } from '../../api';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Toggle, useAction, useConfirm, useResource } from '../../components/ui';
import { useUserOptions } from './Users';

type Sec = 'none' | 'starttls' | 'tls';

interface Account {
  id: number;
  userId: number;
  userLogin: string;
  userName: string;
  label: string | null;
  providerPreset: string | null;
  protocol: 'pop3' | 'imap';
  host: string;
  port: number;
  security: Sec;
  tlsVerify: number;
  username: string;
  remoteFolders: string[] | null;
  targetFolder: string;
  intervalSec: number;
  useIdle: number;
  leavePolicy: 'delete' | 'keep' | 'keep_days';
  keepDays: number;
  /** "Download mail received from" (YYYY-MM-DD); null = all mail at the provider. */
  fetchSince: string | null;
  isEnabled: number;
  status: string;
  lastError: string | null;
  lastSuccessAt: string | null;
  nextRunAt: string | null;
  consecutiveFails: number;
  fetchedTotal: number;
  remoteCount: number | null;
  remoteBytes: number | null;
  idleActive: number;
}

interface Preset {
  key: string;
  name: string;
  imap: [string, number, Sec];
  pop3: [string, number, Sec];
  note?: string;
}

interface Run {
  startedAt: string;
  triggerKind: string;
  fetched: number;
  duplicates: number;
  deletedRemote: number;
  result: string | null;
  error: string | null;
}

const STATUS: Record<string, { label: string; color: 'green' | 'red' | 'amber' | 'blue' | 'slate' }> = {
  idle: { label: 'OK', color: 'green' },
  idling: { label: 'Live (push)', color: 'green' },
  fetching: { label: 'Fetching…', color: 'blue' },
  connecting: { label: 'Connecting…', color: 'blue' },
  backoff: { label: 'Retrying', color: 'amber' },
  quota_full: { label: 'Mailbox full', color: 'amber' },
  auth_failed: { label: 'Wrong password', color: 'red' },
  error: { label: 'Error', color: 'red' },
  disabled: { label: 'Disabled', color: 'slate' },
};

const LEAVE_LABEL = { keep_days: 'Leave a copy, delete after N days', keep: 'Leave a copy on the server', delete: 'Delete from the server after download' };

/** Now as YYYY-MM-DDTHH:MM (a datetime-local value) on this computer's clock. */
function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
const showSince = (v: string) => new Date(`${v}:00`).toLocaleString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });

/** One start date for all mailboxes: the day the office switches to PostMaster. */
/** PostMaster's start date: every mailbox without its own date downloads mail received from then on. */
function StartDateModal({ current, onClose, onDone }: { current: string | null; onClose: () => void; onDone: (msg: string) => void }) {
  const [mode, setMode] = useState<'since' | 'all'>(current || current === undefined ? 'since' : 'all');
  const [date, setDate] = useState(current ?? nowLocal());
  const apply = useAction(async () => {
    const r = await put<{ startAt: string | null; mailboxes: number }>('/api/admin/external-accounts/start-date', { startAt: mode === 'since' ? date : null });
    onDone(r.startAt ? `PostMaster start date saved: ${showSince(r.startAt)}. ${r.mailboxes} mailbox(es) are checked again now.` : `All mail at the provider will be downloaded. ${r.mailboxes} mailbox(es) are checked again now.`);
  });
  return (
    <Modal
      open
      title="PostMaster start date"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={apply.busy} disabled={mode === 'since' && !date} onClick={() => void apply.run()}>
            Save
          </Button>
        </>
      }
    >
      <ErrorBanner error={apply.error} />
      <p className="text-sm text-slate-600">
        The moment PostMaster takes over the mail. External mail received from then on is downloaded; older mail stays at the provider and in the PCs&apos; existing Outlook (for example after moving from
        QLC PostMaster), so nobody gets it twice. After this date PostMaster works as usual. Applies to every mailbox that has no date of its own.
      </p>
      <Field label="Download external mail">
        <Select value={mode} onChange={(e) => setMode(e.target.value as 'since' | 'all')}>
          <option value="since">Received from a date and time</option>
          <option value="all">All mail already at the provider</option>
        </Select>
      </Field>
      {mode === 'since' && (
        <Field label="Received on or after" hint="Older mail is never downloaded and never deleted. Downloaded mail keeps its original date and time.">
          <Input type="datetime-local" value={date} max={nowLocal()} onChange={(e) => setDate(e.target.value)} />
        </Field>
      )}
    </Modal>
  );
}

function StatusBadge({ a }: { a: Account }) {
  const s = a.isEnabled ? (STATUS[a.status] ?? { label: a.status, color: 'slate' as const }) : STATUS.disabled!;
  return <Badge color={s.color}>{s.label}</Badge>;
}

function AccountModal({ acc, presets, defaultUserId, onClose, onSaved }: { acc: Account | 'new'; presets: Preset[]; defaultUserId: number | null; onClose: () => void; onSaved: () => void }) {
  const isNew = acc === 'new';
  const x = isNew ? null : acc;
  const users = useUserOptions();
  const [f, setF] = useState({
    userId: String(x?.userId ?? defaultUserId ?? ''),
    label: x?.label ?? '',
    preset: x?.providerPreset ?? 'hostinger',
    protocol: x?.protocol ?? ('imap' as 'imap' | 'pop3'),
    host: x?.host ?? '',
    port: String(x?.port ?? 993),
    security: x?.security ?? ('tls' as Sec),
    tlsVerify: x ? Boolean(x.tlsVerify) : true,
    username: x?.username ?? '',
    password: '',
    remoteFolders: x?.remoteFolders?.join(', ') ?? '',
    targetFolder: x?.targetFolder ?? 'INBOX',
    intervalSec: String(x?.intervalSec ?? 30),
    useIdle: x ? Boolean(x.useIdle) : true,
    leavePolicy: x?.leavePolicy ?? ('keep_days' as Account['leavePolicy']),
    keepDays: String(x?.keepDays ?? 14),
    fetchMode: (x?.fetchSince ? 'since' : 'global') as 'global' | 'since',
    fetchSince: x?.fetchSince ?? nowLocal(),
    isEnabled: x ? Boolean(x.isEnabled) : true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const preset = presets.find((p) => p.key === f.preset);
  const user = (users.data ?? []).find((u) => String(u.id) === f.userId);

  /** Apply preset server settings for the chosen protocol. */
  const applyPreset = (key: string, protocol: 'imap' | 'pop3') => {
    const p = presets.find((x) => x.key === key);
    if (!p || key === 'custom') return;
    const [host, port, sec] = p[protocol];
    const domain = (f.username || user?.login || '').split('@')[1] ?? '';
    setF((s) => ({ ...s, preset: key, protocol, host: host.replace('{domain}', domain || '{domain}'), port: String(port), security: sec }));
  };
  useEffect(() => {
    if (isNew && presets.length) applyPreset(f.preset, f.protocol);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [presets.length]);
  useEffect(() => {
    if (isNew && user && !f.username) set('username', user.login);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.login]);

  const payload = () => ({
    label: f.label || null,
    providerPreset: f.preset,
    protocol: f.protocol,
    host: f.host,
    port: Number(f.port),
    security: f.security,
    tlsVerify: f.tlsVerify,
    username: f.username,
    ...(f.password ? { password: f.password } : {}),
    remoteFolders: f.protocol === 'imap' && f.remoteFolders.trim() ? f.remoteFolders.split(',').map((s) => s.trim()).filter(Boolean) : null,
    targetFolder: f.targetFolder || 'INBOX',
    intervalSec: Number(f.intervalSec),
    useIdle: f.useIdle,
    leavePolicy: f.leavePolicy,
    keepDays: Number(f.keepDays),
    // Sent only when it changes: a new start date re-checks the mail skipped under the old one.
    ...(isNew || (f.fetchMode === 'since' ? f.fetchSince : null) !== (x?.fetchSince ?? null) ? { fetchSince: f.fetchMode === 'since' ? f.fetchSince : null } : {}),
    isEnabled: f.isEnabled,
  });
  const save = useAction(async () => {
    if (isNew) await post('/api/admin/external-accounts', { userId: Number(f.userId), ...payload() });
    else await patch(`/api/admin/external-accounts/${x!.id}`, payload());
    onSaved();
  });
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const test = useAction(async () => {
    setResult(null);
    const p = payload();
    const body = { protocol: p.protocol, host: p.host, port: p.port, security: p.security, tlsVerify: p.tlsVerify, username: p.username, ...(f.password ? { password: f.password } : {}) };
    setResult(isNew ? await post('/api/admin/external-accounts/test', body) : await post(`/api/admin/external-accounts/${x!.id}/test`, body));
  });

  return (
    <Modal
      open
      wide
      title={isNew ? 'Connect an external mailbox' : `Edit ${x!.username}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" busy={test.busy} onClick={() => void test.run()} disabled={!f.host || !f.username || (isNew && !f.password)}>
            Test connection
          </Button>
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        </>
      }
    >
      <ErrorBanner error={save.error ?? test.error} />
      {result && <div className={`rounded-md px-3 py-2 text-sm ${result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>{result.message}</div>}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Deliver into the mailbox of">
          <Select value={f.userId} onChange={(e) => set('userId', e.target.value)} disabled={!isNew}>
            <option value="">Choose a user…</option>
            {(users.data ?? [])
              .filter((u) => u.hasMailbox)
              .map((u) => (
                <option key={u.id} value={u.id}>
                  {u.displayName} — {u.login}
                </option>
              ))}
          </Select>
        </Field>
        <Field label="Provider">
          <Select value={f.preset} onChange={(e) => applyPreset(e.target.value, f.protocol)}>
            {presets.map((p) => (
              <option key={p.key} value={p.key}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Protocol" hint="IMAP is faster (instant push where supported) and can read several folders.">
          <Select value={f.protocol} onChange={(e) => (f.preset !== 'custom' ? applyPreset(f.preset, e.target.value as 'imap') : set('protocol', e.target.value as 'imap'))}>
            <option value="imap">IMAP</option>
            <option value="pop3">POP3</option>
          </Select>
        </Field>
        <div className="grid gap-2 sm:grid-cols-3">
          <Field label="Server" className="col-span-2">
            <Input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="imap.provider.com" />
          </Field>
          <Field label="Port">
            <Input type="number" value={f.port} onChange={(e) => set('port', e.target.value)} />
          </Field>
        </div>
        <Field label="Encryption">
          <Select value={f.security} onChange={(e) => set('security', e.target.value as Sec)}>
            <option value="tls">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </Select>
        </Field>
        <Field label="Provider user name">
          <Input value={f.username} onChange={(e) => set('username', e.target.value)} autoComplete="off" />
        </Field>
        <Field label="Provider password" hint={isNew ? 'Stored encrypted. The employee never sees it.' : 'Leave empty to keep the stored password.'}>
          <Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={isNew ? '' : '••••••••'} />
        </Field>
        <Field label="Label (optional)">
          <Input value={f.label} onChange={(e) => set('label', e.target.value)} placeholder="e.g. Old Gmail" />
        </Field>
        {f.protocol === 'imap' && (
          <Field label="Provider folders to fetch" hint="Comma separated. Empty = INBOX.">
            <Input value={f.remoteFolders} onChange={(e) => set('remoteFolders', e.target.value)} placeholder="INBOX" />
          </Field>
        )}
        <Field label="Deliver into folder">
          <Input value={f.targetFolder} onChange={(e) => set('targetFolder', e.target.value)} />
        </Field>
        <Field label="Check every (seconds)" hint={f.protocol === 'imap' && f.useIdle ? 'With push active, a safety check runs every 5 minutes instead.' : undefined}>
          <Input type="number" min={10} value={f.intervalSec} onChange={(e) => set('intervalSec', e.target.value)} />
        </Field>
        <Field label="After download">
          <Select value={f.leavePolicy} onChange={(e) => set('leavePolicy', e.target.value as Account['leavePolicy'])}>
            {Object.entries(LEAVE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        {f.leavePolicy === 'keep_days' && (
          <Field label="Delete from the server after (days)">
            <Input type="number" min={1} value={f.keepDays} onChange={(e) => set('keepDays', e.target.value)} />
          </Field>
        )}
        <Field label="Download mail received" hint="Usually the PostMaster start date (set at the top of this page). Choose a date only for a mailbox that should start differently.">
          <Select value={f.fetchMode} onChange={(e) => set('fetchMode', e.target.value as 'global' | 'since')}>
            <option value="global">From the PostMaster start date</option>
            <option value="since">From a date and time for this mailbox</option>
          </Select>
        </Field>
        {f.fetchMode === 'since' && (
          <Field label="Received on or after (date and time)" hint="Older mail stays at the provider untouched; it is never downloaded or deleted.">
            <Input type="datetime-local" value={f.fetchSince} max={nowLocal()} onChange={(e) => set('fetchSince', e.target.value)} />
          </Field>
        )}
      </div>
      {preset?.note && <p className="rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-900">{preset.note.replace('{domain}', (f.username.split('@')[1] ?? 'domain'))}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        {f.protocol === 'imap' && <Toggle checked={f.useIdle} onChange={(v) => set('useIdle', v)} label="Instant push (IMAP IDLE)" />}
        <Toggle checked={f.tlsVerify} onChange={(v) => set('tlsVerify', v)} label="Verify TLS certificate" />
        <Toggle checked={f.isEnabled} onChange={(v) => set('isEnabled', v)} label="Enabled" />
      </div>
    </Modal>
  );
}

function RunsModal({ id, onClose }: { id: number; onClose: () => void }) {
  const d = useResource(() => get<Account & { runs: Run[] }>(`/api/admin/external-accounts/${id}`), [id]);
  return (
    <Modal open wide title={d.data ? `History — ${d.data.username}` : 'History'} onClose={onClose}>
      {!d.data ? (
        <Spinner />
      ) : !d.data.runs.length ? (
        <Empty>No fetches yet.</Empty>
      ) : (
        <Table head={['Started', 'Trigger', 'New', 'Duplicates', 'Removed remotely', 'Result']}>
          {d.data.runs.map((r, i) => (
            <tr key={i}>
              <Td className="whitespace-nowrap">{formatDate(r.startedAt)}</Td>
              <Td>{r.triggerKind}</Td>
              <Td className="tabular">{r.fetched}</Td>
              <Td className="tabular">{r.duplicates}</Td>
              <Td className="tabular">{r.deletedRemote}</Td>
              <Td>
                {r.result === 'ok' || r.result === 'partial' ? <Badge color="green">{r.result}</Badge> : r.result ? <Badge color="red">{r.result}</Badge> : <Badge color="blue">running</Badge>}
                {r.error && <div className="mt-1 max-w-xs text-xs text-red-600">{r.error}</div>}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Modal>
  );
}

export function ExternalPage() {
  const [params] = useSearchParams();
  const userFilter = params.get('userId');
  const [tick, setTick] = useState(0);
  const list = useResource(() => get<{ items: Account[]; summary: Record<string, number>; max: number | null }>(`/api/admin/external-accounts${userFilter ? `?userId=${userFilter}` : ''}`), [userFilter, tick]);
  const presets = useResource(() => get<Preset[]>('/api/admin/external-accounts/presets'));
  const [editing, setEditing] = useState<Account | 'new' | null>(null);
  const [startDate, setStartDate] = useState(false);
  const [startNote, setStartNote] = useState<string | null>(null);
  const startInfo = useResource(() => get<{ startAt: string | null; mailboxesWithOwnDate: number }>('/api/admin/external-accounts/start-date'));
  const [history, setHistory] = useState<number | null>(null);
  const [q, setQ] = useState('');
  const [ask, confirmNode] = useConfirm();

  // Live status: refresh every 5 seconds while the page is open (Socket.IO arrives with webmail).
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 5000);
    return () => clearInterval(t);
  }, []);

  const items = useMemo(
    () => (list.data?.items ?? []).filter((a) => `${a.userLogin} ${a.userName} ${a.username} ${a.host}`.toLowerCase().includes(q.toLowerCase())),
    [list.data, q],
  );
  const s = list.data?.summary ?? {};
  const problems = (s.auth_failed ?? 0) + (s.backoff ?? 0) + (s.quota_full ?? 0) + (s.error ?? 0);

  return (
    <div>
      {confirmNode}
      <PageHeader
        title="External mailboxes"
        description="Provider mailboxes (Hostinger, GoDaddy, Zoho, cPanel…) fetched into each employee's office mailbox."
        actions={
          <>
            <Button onClick={() => setEditing('new')}>Connect mailbox</Button>
          </>
        }
      />
      {startInfo.data && (
        <div className="mb-4 flex flex-wrap items-center gap-3 rounded-lg bg-white px-4 py-3 text-sm shadow-sm ring-1 ring-slate-200">
          <div className="min-w-0 flex-1">
            <span className="font-medium text-slate-900">PostMaster start date: </span>
            {startInfo.data.startAt ? (
              <>
                {showSince(startInfo.data.startAt)}
                <span className="text-slate-500"> · external mail received before this is not downloaded</span>
              </>
            ) : (
              <span>all mail already at the provider is downloaded</span>
            )}
            {startInfo.data.mailboxesWithOwnDate > 0 && <span className="text-slate-500"> · {startInfo.data.mailboxesWithOwnDate} mailbox(es) use their own date</span>}
          </div>
          <Button variant="secondary" onClick={() => setStartDate(true)}>
            Change
          </Button>
        </div>
      )}
      {startNote && <div className="mb-4 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">{startNote}</div>}
      <div className="mb-4 flex flex-wrap items-center gap-2 text-sm">
        <Badge color="green">{(s.idle ?? 0) + (s.idling ?? 0)} OK</Badge>
        <Badge color="blue">{s.idling ?? 0} with instant push</Badge>
        {problems > 0 && <Badge color="red">{problems} need attention</Badge>}
        {list.data?.max != null && <span className="text-slate-500">Licence: {list.data.items.filter((a) => a.isEnabled).length} of {list.data.max} accounts</span>}
        <Input className="w-full sm:ml-auto sm:max-w-xs" placeholder="Filter by user, account or server" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      <ErrorBanner error={list.error} />
      <Card>
        {list.loading && !list.data ? (
          <Spinner />
        ) : !items.length ? (
          <Empty>No external mailboxes connected yet.</Empty>
        ) : (
          <Table head={['Employee', 'Provider account', 'Status', 'On server', 'Fetched', 'Last success', '']}>
            {items.map((a) => (
              <tr key={a.id}>
                <Td>
                  <div className="font-medium">{a.userName}</div>
                  <div className="text-xs text-slate-500">{a.userLogin}</div>
                </Td>
                <Td>
                  <div>{a.username}</div>
                  <div className="text-xs text-slate-500">
                    <span className="uppercase">{a.protocol}</span> · {a.host}
                    {a.label && ` · ${a.label}`}
                  </div>
                  {a.fetchSince && <div className="text-xs text-slate-500">Own start: {showSince(a.fetchSince)}</div>}
                </Td>
                <Td className="max-w-xs">
                  <StatusBadge a={a} />
                  {a.lastError && a.status !== 'idle' && a.status !== 'idling' && (
                    <div className="mt-1 truncate text-xs text-red-600" title={a.lastError}>
                      {a.lastError}
                    </div>
                  )}
                  {a.status === 'backoff' && a.nextRunAt && <div className="text-xs text-slate-500">Next try {formatDate(a.nextRunAt)}</div>}
                </Td>
                <Td className="tabular">
                  {a.remoteCount ?? '—'}
                  {a.remoteBytes != null && <div className="text-xs text-slate-500">{formatBytes(a.remoteBytes)}</div>}
                </Td>
                <Td className="tabular">{a.fetchedTotal}</Td>
                <Td className="whitespace-nowrap text-xs">{formatDate(a.lastSuccessAt)}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button variant="ghost" disabled={!a.isEnabled} onClick={() => void post(`/api/admin/external-accounts/${a.id}/fetch-now`).then(() => setTick((x) => x + 1))}>
                    Fetch now
                  </Button>
                  <Button variant="ghost" onClick={() => setHistory(a.id)}>
                    History
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing(a)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (await ask(`Disconnect ${a.username}? Mail already downloaded stays in the mailbox.`, { confirmLabel: 'Disconnect' })) {
                        await del(`/api/admin/external-accounts/${a.id}`);
                        list.reload();
                      }
                    }}
                  >
                    Remove
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {startDate && startInfo.data && (
        <StartDateModal
          current={startInfo.data.startAt}
          onClose={() => setStartDate(false)}
          onDone={(msg) => {
            setStartDate(false);
            setStartNote(msg);
            startInfo.reload();
            list.reload();
          }}
        />
      )}
      {editing && presets.data && (
        <AccountModal
          acc={editing}
          presets={presets.data}
          defaultUserId={userFilter ? Number(userFilter) : null}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
      {history !== null && <RunsModal id={history} onClose={() => setHistory(null)} />}
    </div>
  );
}
