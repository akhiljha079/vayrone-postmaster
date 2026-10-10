import { useState } from 'react';
import { del, formatBytes, formatDate, get, patch, post, put } from '../../api';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Toggle, useAction, useConfirm, useResource } from '../../components/ui';
import { useUserOptions } from './Users';

interface Relay {
  id: number;
  name: string;
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  authUser: string | null;
  passwordSet: number;
  envelopeFrom: 'relay_account' | 'original_sender';
  setSenderHeader: number;
  maxMsgsPerMin: number | null;
  maxConnections: number;
  tlsVerify: number;
  isDefault: number;
  isEnabled: number;
  lastTestAt: string | null;
  lastTestResult: string | null;
}

interface RouteRow {
  id: number;
  scope: 'domain' | 'user';
  domain: string | null;
  login: string | null;
  relayName: string | null;
  viaExternalAccountId: number | null;
}

function RelayModal({ r, onClose, onSaved }: { r: Relay | 'new'; onClose: () => void; onSaved: () => void }) {
  const isNew = r === 'new';
  const x = isNew ? null : r;
  const [f, setF] = useState({
    name: x?.name ?? '',
    host: x?.host ?? '',
    port: String(x?.port ?? 587),
    security: x?.security ?? 'starttls',
    authUser: x?.authUser ?? '',
    password: '',
    envelopeFrom: x?.envelopeFrom ?? 'relay_account',
    setSenderHeader: x ? Boolean(x.setSenderHeader) : true,
    maxMsgsPerMin: x?.maxMsgsPerMin ? String(x.maxMsgsPerMin) : '',
    maxConnections: String(x?.maxConnections ?? 2),
    tlsVerify: x ? Boolean(x.tlsVerify) : true,
    isDefault: x ? Boolean(x.isDefault) : true,
    isEnabled: x ? Boolean(x.isEnabled) : true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useAction(async () => {
    const body = {
      name: f.name,
      host: f.host,
      port: Number(f.port),
      security: f.security,
      authUser: f.authUser || null,
      ...(f.password ? { password: f.password } : {}),
      envelopeFrom: f.envelopeFrom,
      setSenderHeader: f.setSenderHeader,
      maxMsgsPerMin: f.maxMsgsPerMin ? Number(f.maxMsgsPerMin) : null,
      maxConnections: Number(f.maxConnections),
      tlsVerify: f.tlsVerify,
      isDefault: f.isDefault,
      isEnabled: f.isEnabled,
    };
    if (isNew) await post('/api/admin/relays', body);
    else await patch(`/api/admin/relays/${x!.id}`, body);
    onSaved();
  });
  return (
    <Modal
      open
      wide
      title={isNew ? 'Add SMTP relay account' : `Edit ${x!.name}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        </>
      }
    >
      <ErrorBanner error={save.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Name">
          <Input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="Hostinger relay" />
        </Field>
        <Field label="SMTP server">
          <Input value={f.host} onChange={(e) => set('host', e.target.value)} placeholder="smtp.hostinger.com" />
        </Field>
        <Field label="Port">
          <Input type="number" value={f.port} onChange={(e) => set('port', e.target.value)} />
        </Field>
        <Field label="Encryption">
          <Select value={f.security} onChange={(e) => set('security', e.target.value as 'tls')}>
            <option value="starttls">STARTTLS (usually port 587)</option>
            <option value="tls">SSL/TLS (usually port 465)</option>
            <option value="none">None (not recommended)</option>
          </Select>
        </Field>
        <Field label="Account (user name)">
          <Input value={f.authUser} onChange={(e) => set('authUser', e.target.value)} placeholder="mailserver@company.com" autoComplete="off" />
        </Field>
        <Field label="Password" hint={x?.passwordSet ? 'A password is stored. Leave empty to keep it.' : 'Stored encrypted; never shown again.'}>
          <Input type="password" value={f.password} onChange={(e) => set('password', e.target.value)} autoComplete="new-password" placeholder={x?.passwordSet ? '••••••••' : ''} />
        </Field>
        <Field label="Envelope sender (MAIL FROM)" hint="The visible From address always stays the employee's own.">
          <Select value={f.envelopeFrom} onChange={(e) => set('envelopeFrom', e.target.value as 'relay_account')}>
            <option value="relay_account">The relay account (best for SPF/DKIM)</option>
            <option value="original_sender">The employee's address</option>
          </Select>
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Max messages / minute" hint="Empty = no limit">
            <Input type="number" min={1} value={f.maxMsgsPerMin} onChange={(e) => set('maxMsgsPerMin', e.target.value)} />
          </Field>
          <Field label="Connections">
            <Input type="number" min={1} max={20} value={f.maxConnections} onChange={(e) => set('maxConnections', e.target.value)} />
          </Field>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Toggle checked={f.setSenderHeader} onChange={(v) => set('setSenderHeader', v)} label="Add a Sender: header with the relay account" />
        <Toggle checked={f.tlsVerify} onChange={(v) => set('tlsVerify', v)} label="Verify the server's TLS certificate" />
        <Toggle checked={f.isDefault} onChange={(v) => set('isDefault', v)} label="Default relay for all outgoing mail" />
        <Toggle checked={f.isEnabled} onChange={(v) => set('isEnabled', v)} label="Enabled" />
      </div>
    </Modal>
  );
}

function TestModal({ r, onClose }: { r: Relay; onClose: () => void }) {
  const [to, setTo] = useState('');
  const [from, setFrom] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const test = useAction(async (send: boolean) => {
    setResult(await post(`/api/admin/relays/${r.id}/test`, send ? { to, ...(from ? { from } : {}) } : {}));
  });
  return (
    <Modal open title={`Test ${r.name}`} onClose={onClose}>
      {result && (
        <div className={`rounded-md px-3 py-2 text-sm ${result.ok ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-700'}`}>
          {result.ok ? '✓ ' : '✗ '}
          {result.message}
        </div>
      )}
      <ErrorBanner error={test.error} />
      <Button variant="secondary" busy={test.busy} onClick={() => void test.run(false)}>
        Check connection and login
      </Button>
      <div className="space-y-3 border-t border-slate-100 pt-4">
        <Field label="Send a test message to">
          <Input value={to} onChange={(e) => setTo(e.target.value)} placeholder="your-phone@gmail.com" />
        </Field>
        <Field label="From address (optional)" hint="Use an employee address to check whether the provider accepts a From different from the relay account.">
          <Input value={from} onChange={(e) => setFrom(e.target.value)} placeholder={r.authUser ?? ''} />
        </Field>
        <Button busy={test.busy} disabled={!to} onClick={() => void test.run(true)}>
          Send test message
        </Button>
      </div>
    </Modal>
  );
}

function RoutesCard({ relays }: { relays: Relay[] }) {
  const routes = useResource(() => get<RouteRow[]>('/api/admin/relay-routes'));
  const domains = useResource(() => get<{ id: number; name: string }[]>('/api/admin/domains'));
  const users = useUserOptions();
  const [f, setF] = useState({ scope: 'user' as 'user' | 'domain', target: '', relayId: '' });
  const add = useAction(async () => {
    await put('/api/admin/relay-routes', {
      scope: f.scope,
      ...(f.scope === 'domain' ? { domainId: Number(f.target) } : { userId: Number(f.target) }),
      relayAccountId: Number(f.relayId),
    });
    setF({ ...f, target: '' });
    routes.reload();
  });
  return (
    <Card title="Routing overrides">
      <p className="mb-3 text-sm text-slate-600">Send mail from a particular domain or user through a different relay. The most specific rule wins: user, then domain, then the default relay.</p>
      <ErrorBanner error={routes.error ?? add.error} />
      {routes.data?.length ? (
        <Table head={['Applies to', 'Relay', '']}>
          {routes.data.map((r) => (
            <tr key={r.id}>
              <Td>
                <Badge>{r.scope}</Badge> {r.domain ?? r.login}
              </Td>
              <Td>{r.relayName ?? (r.viaExternalAccountId ? "User's own provider account" : '—')}</Td>
              <Td className="text-right">
                <Button variant="ghost" onClick={() => void del(`/api/admin/relay-routes/${r.id}`).then(routes.reload)}>
                  Remove
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      ) : (
        <p className="text-sm text-slate-500">No overrides: all mail uses the default relay.</p>
      )}
      <div className="mt-4 grid gap-2 sm:grid-cols-4">
        <Select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as 'user', target: '' })}>
          <option value="user">User</option>
          <option value="domain">Domain</option>
        </Select>
        <Select value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })}>
          <option value="">Choose…</option>
          {f.scope === 'domain'
            ? (domains.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))
            : (users.data ?? [])
                .filter((u) => u.hasMailbox)
                .map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.login}
                  </option>
                ))}
        </Select>
        <Select value={f.relayId} onChange={(e) => setF({ ...f, relayId: e.target.value })}>
          <option value="">Relay…</option>
          {relays.map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
        </Select>
        <Button disabled={!f.target || !f.relayId} busy={add.busy} onClick={() => void add.run()}>
          Add override
        </Button>
      </div>
    </Card>
  );
}

export function RelayPage() {
  const list = useResource(() => get<Relay[]>('/api/admin/relays'));
  const [editing, setEditing] = useState<Relay | 'new' | null>(null);
  const [testing, setTesting] = useState<Relay | null>(null);
  const [ask, confirmNode] = useConfirm();
  return (
    <div>
      {confirmNode}
      <PageHeader
        title="SMTP relay"
        description="Outgoing mail to the internet is sent through these provider accounts. Employees keep their own From address."
        actions={<Button onClick={() => setEditing('new')}>Add relay</Button>}
      />
      <ErrorBanner error={list.error} />
      <div className="space-y-5">
        <Card>
          {list.loading && !list.data ? (
            <Spinner />
          ) : !list.data?.length ? (
            <Empty>No relay configured yet. Outgoing mail will wait in the queue until you add one.</Empty>
          ) : (
            <Table head={['Relay', 'Server', 'Account', 'Last test', '']}>
              {list.data.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <div className="font-medium">{r.name}</div>
                    <div className="mt-0.5 flex gap-1">
                      {r.isDefault ? <Badge color="blue">Default</Badge> : null}
                      {!r.isEnabled && <Badge color="red">Disabled</Badge>}
                    </div>
                  </Td>
                  <Td className="font-mono text-xs">
                    {r.host}:{r.port} <span className="uppercase text-slate-500">{r.security}</span>
                  </Td>
                  <Td>{r.authUser ?? '—'}</Td>
                  <Td className="max-w-xs text-xs">
                    {r.lastTestAt ? (
                      <>
                        <div>{formatDate(r.lastTestAt)}</div>
                        <div className="truncate text-slate-500" title={r.lastTestResult ?? ''}>
                          {r.lastTestResult}
                        </div>
                      </>
                    ) : (
                      'Never'
                    )}
                  </Td>
                  <Td className="whitespace-nowrap text-right">
                    <Button variant="ghost" onClick={() => setTesting(r)}>
                      Test
                    </Button>
                    <Button variant="ghost" onClick={() => setEditing(r)}>
                      Edit
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (await ask(`Remove relay ${r.name}?`, { confirmLabel: 'Remove' })) {
                          await del(`/api/admin/relays/${r.id}`);
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
        {list.data && list.data.length > 0 && <RoutesCard relays={list.data} />}
      </div>
      {editing && <RelayModal r={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), list.reload())} />}
      {testing && <TestModal r={testing} onClose={() => (setTesting(null), list.reload())} />}
    </div>
  );
}

// =================================================================== Queue

interface QueueItem {
  id: number;
  status: string;
  envelopeFrom: string;
  sender: string | null;
  subject: string | null;
  size: number;
  attempts: number;
  nextAttemptAt: string;
  lastError: string | null;
  holdReason: string | null;
  relay: string | null;
  createdAt: string;
  recipients: number;
  recipientList: string | null;
}

interface QueueDetail {
  id: number;
  status: string;
  recipients: { rcpt: string; status: string; attempts: number; smtpCode: number | null; smtpResponse: string | null; updatedAt: string }[];
  log: { at: string; event: string; rcpt: string; detail: string }[];
}

const STATUS_COLOR: Record<string, 'green' | 'red' | 'amber' | 'blue' | 'slate'> = {
  queued: 'blue',
  sending: 'blue',
  deferred: 'amber',
  held: 'slate',
  sent: 'green',
  partial: 'amber',
  failed: 'red',
};
const TABS = [
  { key: 'queued,deferred,sending', label: 'Waiting' },
  { key: 'held', label: 'Held' },
  { key: 'failed,partial', label: 'Failed' },
  { key: 'sent', label: 'Sent' },
  { key: '', label: 'All' },
];

export function QueuePage() {
  const [tab, setTab] = useState(TABS[0]!.key);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<number | null>(null);
  const list = useResource(
    () => get<{ items: QueueItem[]; total: number; counts: Record<string, number> }>(`/api/admin/queue?pageSize=200&status=${tab}&q=${encodeURIComponent(query)}`),
    [tab, query],
  );
  const d = useResource(() => (detail ? get<QueueDetail>(`/api/admin/queue/${detail}`) : Promise.resolve(null)), [detail]);
  const [ask, confirmNode] = useConfirm();
  const bulk = useAction(async (action: 'retry' | 'hold' | 'release' | 'delete') => {
    if (action === 'delete' && !(await ask(`Delete ${selected.size} message(s) from the queue? They will not be delivered.`, { confirmLabel: 'Delete' }))) return;
    const r = await post<{ done: number; errors: { id: number; message: string }[] }>('/api/admin/queue/bulk', { ids: [...selected], action });
    setSelected(new Set());
    list.reload();
    if (r.errors.length) throw new Error(r.errors.map((e) => e.message).join('; '));
  });
  const count = (k: string) => k.split(',').reduce((s, x) => s + (list.data?.counts[x] ?? 0), 0);
  const toggle = (id: number) => {
    const s = new Set(selected);
    if (s.has(id)) s.delete(id);
    else s.add(id);
    setSelected(s);
  };
  return (
    <div>
      {confirmNode}
      <PageHeader title="Mail queue" description="Outgoing mail waiting for, or finished with, the SMTP relay." actions={<Button variant="secondary" onClick={list.reload}>Refresh</Button>} />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {TABS.map((t) => (
          <button
            key={t.label}
            onClick={() => (setTab(t.key), setSelected(new Set()))}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === t.key ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50'}`}
          >
            {t.label}
            {t.key && <span className="ml-1.5 tabular opacity-75">{count(t.key)}</span>}
          </button>
        ))}
        <form
          className="ml-auto flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q);
          }}
        >
          <Input placeholder="Sender, recipient or subject" value={q} onChange={(e) => setQ(e.target.value)} />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
      </div>
      <ErrorBanner error={list.error ?? bulk.error} />
      {selected.size > 0 && (
        <div className="mb-3 flex items-center gap-2 rounded-md bg-brand-50 px-3 py-2 text-sm">
          <span className="font-medium">{selected.size} selected</span>
          <Button variant="secondary" onClick={() => void bulk.run('retry')}>
            Retry now
          </Button>
          <Button variant="secondary" onClick={() => void bulk.run('hold')}>
            Hold
          </Button>
          <Button variant="secondary" onClick={() => void bulk.run('release')}>
            Release
          </Button>
          <Button variant="danger" onClick={() => void bulk.run('delete')}>
            Delete
          </Button>
        </div>
      )}
      <Card>
        {!list.data?.items.length ? (
          <Empty>Nothing here.</Empty>
        ) : (
          <Table head={['', 'Message', 'Recipients', 'Status', 'Attempts', 'Next try', '']}>
            {list.data.items.map((m) => (
              <tr key={m.id} className={selected.has(m.id) ? 'bg-brand-50/50' : ''}>
                <Td>
                  <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m.id)} aria-label={`Select message ${m.id}`} />
                </Td>
                <Td className="max-w-xs">
                  <div className="truncate font-medium">{m.subject || '(no subject)'}</div>
                  <div className="truncate text-xs text-slate-500">
                    {m.envelopeFrom || 'bounce'} · {formatBytes(m.size)} · {formatDate(m.createdAt)}
                  </div>
                </Td>
                <Td className="max-w-xs">
                  <div className="truncate text-xs">{m.recipientList}</div>
                </Td>
                <Td>
                  <Badge color={STATUS_COLOR[m.status] ?? 'slate'}>{m.status}</Badge>
                  {m.lastError && m.status !== 'sent' && (
                    <div className="mt-1 max-w-[16rem] truncate text-xs text-red-600" title={m.lastError}>
                      {m.lastError}
                    </div>
                  )}
                  {m.holdReason && <div className="mt-1 text-xs text-slate-500">{m.holdReason}</div>}
                </Td>
                <Td className="tabular">{m.attempts}</Td>
                <Td className="whitespace-nowrap text-xs">{['queued', 'deferred'].includes(m.status) ? formatDate(m.nextAttemptAt) : '—'}</Td>
                <Td>
                  <Button variant="ghost" onClick={() => setDetail(m.id)}>
                    Details
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal open={detail !== null} wide title={`Queue entry #${detail}`} onClose={() => setDetail(null)}>
        {d.data && (
          <>
            <Table head={['Recipient', 'Status', 'Tries', 'Server response']}>
              {d.data.recipients.map((r) => (
                <tr key={r.rcpt}>
                  <Td>{r.rcpt}</Td>
                  <Td>
                    <Badge color={STATUS_COLOR[r.status] ?? 'slate'}>{r.status}</Badge>
                  </Td>
                  <Td className="tabular">{r.attempts}</Td>
                  <Td className="text-xs">{r.smtpResponse ?? '—'}</Td>
                </tr>
              ))}
            </Table>
            <h3 className="text-sm font-semibold">History</h3>
            <ul className="space-y-1 text-xs">
              {d.data.log.map((l, i) => (
                <li key={i}>
                  <span className="text-slate-500">{formatDate(l.at)}</span> <Badge>{l.event}</Badge> {l.rcpt} — {l.detail}
                </li>
              ))}
            </ul>
          </>
        )}
      </Modal>
    </div>
  );
}
