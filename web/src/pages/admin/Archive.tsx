import { useEffect, useState } from 'react';
import { del, formatBytes, formatDate, get, patch, post, put } from '../../api';
import { useMe } from '../../auth';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Toggle, useAction, useConfirm, useResource } from '../../components/ui';
import { MailFrame } from '../webmail/Reader';
import { useUserOptions } from './Users';

interface Hit {
  id: number;
  direction: 'in' | 'out' | 'internal';
  envelopeFrom: string;
  envelopeRcpts: string[];
  subject: string | null;
  date: string | null;
  size: number;
  archivedAt: string;
  retentionUntil: string | null;
  legalHold: number;
  fromHeader: string | null;
  hasAttachments: number;
}

interface Viewed {
  id: number;
  subject: string;
  from: { name: string; address: string }[];
  to: { name: string; address: string }[];
  cc: { name: string; address: string }[];
  date: string | null;
  html: string;
  remoteImages: boolean;
  attachments: { index: number; filename: string; size: number }[];
  direction: string;
  envelopeFrom: string;
  envelopeRcpts: string[];
  archivedAt: string;
  retentionUntil: string | null;
  legalHold: boolean;
  users: string[];
}

const DIR: Record<string, { label: string; color: 'blue' | 'green' | 'slate' }> = {
  in: { label: 'Received', color: 'blue' },
  out: { label: 'Sent', color: 'green' },
  internal: { label: 'Internal', color: 'slate' },
};

/** Downloads a POST response (export) as a file. */
async function downloadPost(url: string, body: unknown, fallbackName: string): Promise<void> {
  const csrf = document.cookie.split('; ').find((c) => c.startsWith('vpm_csrf='))?.slice(9) ?? '';
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-vpm-csrf': csrf }, body: JSON.stringify(body), credentials: 'same-origin' });
  if (!res.ok) throw new Error(((await res.json().catch(() => ({}))) as { message?: string }).message ?? 'Export failed');
  const blob = await res.blob();
  const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? fallbackName;
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  a.click();
  URL.revokeObjectURL(a.href);
}

function Viewer({ id, onClose, onChanged }: { id: number; onClose: () => void; onChanged: () => void }) {
  const me = useMe();
  const [images, setImages] = useState(false);
  const v = useResource(() => get<Viewed>(`/api/admin/archive/items/${id}${images ? '?images=1' : ''}`), [id, images]);
  const users = useUserOptions();
  const [target, setTarget] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const restore = useAction(async () => {
    const r = await post<{ folder: string }>(`/api/admin/archive/items/${id}/restore`, { userId: Number(target) });
    setMsg(`Copied into the "${r.folder}" folder.`);
  });
  const hold = useAction(async (on: boolean) => {
    await post(`/api/admin/archive/items/${id}/legal-hold`, { hold: on });
    v.reload();
    onChanged();
  });
  const d = v.data;
  return (
    <Modal open wide title={d?.subject || 'Archived message'} onClose={onClose}>
      <ErrorBanner error={v.error ?? restore.error ?? hold.error} />
      {!d ? (
        <Spinner />
      ) : (
        <>
          <div className="grid gap-1 text-sm">
            <div>
              <Badge color={DIR[d.direction]?.color}>{DIR[d.direction]?.label}</Badge> <span className="font-medium">{d.from.map((f) => (f.name ? `${f.name} <${f.address}>` : f.address)).join(', ')}</span>
            </div>
            <div className="text-slate-600">To: {d.to.map((f) => f.address).join(', ')}</div>
            {d.cc.length > 0 && <div className="text-slate-600">Cc: {d.cc.map((f) => f.address).join(', ')}</div>}
            <div className="text-xs text-slate-500">
              Envelope: {d.envelopeFrom || '<>'} → {d.envelopeRcpts.join(', ')} · Mailboxes: {d.users.join(', ') || '—'}
            </div>
            <div className="text-xs text-slate-500">
              Sent {formatDate(d.date)} · archived {formatDate(d.archivedAt)} · kept until {d.retentionUntil ? formatDate(d.retentionUntil) : 'forever'} {d.legalHold && <Badge color="amber">Legal hold</Badge>}
            </div>
          </div>
          {d.attachments.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {d.attachments.map((a) => (
                <a key={a.index} href={`/api/admin/archive/items/${id}/attachments/${a.index}`} className="rounded bg-slate-100 px-2 py-1 text-xs hover:bg-slate-200">
                  📎 {a.filename} ({formatBytes(a.size)})
                </a>
              ))}
            </div>
          )}
          {d.remoteImages && !images && (
            <div className="flex items-center justify-between rounded bg-slate-100 px-3 py-1.5 text-xs">
              Remote pictures are blocked.
              <Button variant="secondary" onClick={() => setImages(true)}>
                Show images
              </Button>
            </div>
          )}
          <div className="max-h-[50vh] overflow-y-auto rounded ring-1 ring-slate-200 px-3">
            <MailFrame html={d.html} images={images} />
          </div>
          <div className="flex flex-wrap items-end gap-2 border-t border-slate-100 pt-3">
            <a href={`/api/admin/archive/items/${id}/raw`} className="rounded-md px-3 py-1.5 text-sm ring-1 ring-slate-300 hover:bg-slate-50">
              Download .eml
            </a>
            {me.user.role !== 'auditor' && (
              <>
                <Select className="w-64" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Restore into mailbox">
                  <option value="">Restore into mailbox…</option>
                  {(users.data ?? [])
                    .filter((u) => u.hasMailbox)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.login}
                      </option>
                    ))}
                </Select>
                <Button variant="secondary" disabled={!target} busy={restore.busy} onClick={() => void restore.run()}>
                  Restore
                </Button>
              </>
            )}
            {me.user.role === 'super_admin' && (
              <Button variant={d.legalHold ? 'secondary' : 'danger'} className="ml-auto" busy={hold.busy} onClick={() => void hold.run(!d.legalHold)}>
                {d.legalHold ? 'Release legal hold' : 'Place on legal hold'}
              </Button>
            )}
          </div>
          {msg && <p className="text-sm text-emerald-700">{msg}</p>}
        </>
      )}
    </Modal>
  );
}

function PolicyCard() {
  const me = useMe();
  const isSuper = me.user.role === 'super_admin';
  const p = useResource(() => get<{ enabled: boolean; retentionDays: number | null; includeInternal: boolean; licensed: boolean }>('/api/admin/archive/policy'));
  const stats = useResource(() => get<{ items: number; bytes: number; legalHold: number; oldest: string | null; notYetIndexed: number }>('/api/admin/archive/stats'));
  const [f, setF] = useState<{ enabled: boolean; years: string; includeInternal: boolean } | null>(null);
  useEffect(() => {
    if (p.data) setF({ enabled: p.data.enabled, years: p.data.retentionDays ? String(Math.round((p.data.retentionDays / 365) * 10) / 10) : '', includeInternal: p.data.includeInternal });
  }, [p.data]);
  const save = useAction(async () => {
    await put('/api/admin/archive/policy', { enabled: f!.enabled, includeInternal: f!.includeInternal, retentionDays: f!.years ? Math.round(Number(f!.years) * 365) : null });
    p.reload();
  });
  return (
    <Card title="Archive settings">
      <ErrorBanner error={p.error ?? save.error} />
      {stats.data && (
        <p className="mb-3 text-sm text-slate-600">
          {stats.data.items.toLocaleString('en-IN')} messages ({formatBytes(stats.data.bytes)}), {stats.data.legalHold} on legal hold
          {stats.data.oldest && `, since ${formatDate(stats.data.oldest)}`}.{stats.data.notYetIndexed > 0 && ` ${stats.data.notYetIndexed} still being indexed for search.`}
        </p>
      )}
      {p.data && !p.data.licensed && <p className="mb-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">Archiving is not included in your licence.</p>}
      {f && (
        <div className="space-y-3">
          <Toggle checked={f.enabled} disabled={!isSuper} onChange={(v) => setF({ ...f, enabled: v })} label="Archive all sent and received mail" />
          <Toggle checked={f.includeInternal} disabled={!isSuper} onChange={(v) => setF({ ...f, includeInternal: v })} label="Include mail between colleagues" />
          <Field label="Keep for (years)" hint="Empty = keep forever. A longer retention policy for a user, group or domain wins.">
            <Input type="number" min={0.1} step={0.5} value={f.years} disabled={!isSuper} onChange={(e) => setF({ ...f, years: e.target.value })} />
          </Field>
          {isSuper && (
            <Button busy={save.busy} onClick={() => void save.run()}>
              Save
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}

interface RetentionRow {
  id: number;
  name: string;
  target: 'archive' | 'mailbox_folder';
  scope: string;
  scopeId: number | null;
  specialUse: string | null;
  keepDays: number;
  isEnabled: number;
}

function RetentionCard() {
  const me = useMe();
  const isSuper = me.user.role === 'super_admin';
  const list = useResource(() => get<RetentionRow[]>('/api/admin/retention-policies'));
  const [f, setF] = useState({ name: '', target: 'mailbox_folder' as RetentionRow['target'], specialUse: 'trash', keepDays: '30' });
  const [ask, confirmNode] = useConfirm();
  const add = useAction(async () => {
    await post('/api/admin/retention-policies', { name: f.name || `${f.specialUse} ${f.keepDays} days`, target: f.target, specialUse: f.target === 'mailbox_folder' ? f.specialUse : null, keepDays: Number(f.keepDays) });
    list.reload();
  });
  return (
    <Card title="Retention rules">
      {confirmNode}
      <p className="mb-3 text-sm text-slate-600">Automatically clean up old mail every night, e.g. empty Trash after 30 days. Archive items on legal hold are never removed.</p>
      <ErrorBanner error={list.error ?? add.error} />
      {list.data?.length ? (
        <Table head={['Rule', 'Applies to', 'Keep', '']}>
          {list.data.map((r) => (
            <tr key={r.id}>
              <Td>
                {r.name} {!r.isEnabled && <Badge>off</Badge>}
              </Td>
              <Td>{r.target === 'archive' ? 'Archive' : `Mailbox folder: ${r.specialUse}`}</Td>
              <Td className="tabular">{r.keepDays} days</Td>
              <Td className="text-right">
                {isSuper && (
                  <>
                    <Button variant="ghost" onClick={() => void patch(`/api/admin/retention-policies/${r.id}`, { isEnabled: !r.isEnabled }).then(list.reload)}>
                      {r.isEnabled ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={async () => {
                        if (await ask(`Delete retention rule "${r.name}"?`, { confirmLabel: 'Delete' })) {
                          await del(`/api/admin/retention-policies/${r.id}`);
                          list.reload();
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      ) : (
        <p className="text-sm text-slate-500">No retention rules.</p>
      )}
      {isSuper && (
        <div className="mt-3 grid gap-2 sm:grid-cols-4">
          <Select value={f.target} onChange={(e) => setF({ ...f, target: e.target.value as RetentionRow['target'] })}>
            <option value="mailbox_folder">Mailbox folder</option>
            <option value="archive">Archive</option>
          </Select>
          {f.target === 'mailbox_folder' ? (
            <Select value={f.specialUse} onChange={(e) => setF({ ...f, specialUse: e.target.value })}>
              {['trash', 'junk', 'sent', 'drafts', 'inbox', 'archive'].map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </Select>
          ) : (
            <Input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          )}
          <Input type="number" min={1} value={f.keepDays} onChange={(e) => setF({ ...f, keepDays: e.target.value })} aria-label="Days" />
          <Button busy={add.busy} onClick={() => void add.run()}>
            Add rule
          </Button>
        </div>
      )}
    </Card>
  );
}

interface ArchiveMailbox {
  userId: number;
  address: string;
  name: string | null;
  deleted: boolean;
  received: number;
  sent: number;
  last: string | null;
}

/** The archive as folders: one per address, each with Received and Sent. */
function Mailboxes({ onOpen }: { onOpen: (id: number) => void }) {
  const [q, setQ] = useState('');
  const list = useResource(() => get<{ items: ArchiveMailbox[] }>(`/api/admin/archive/mailboxes`), []);
  const [sel, setSel] = useState<{ userId: number; role: 'received' | 'sent' } | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const qs = sel ? new URLSearchParams({ userId: String(sel.userId), role: sel.role, page: String(pageNo), pageSize: '50' }).toString() : '';
  const msgs = useResource(() => (sel ? get<{ items: Hit[]; total: number }>(`/api/admin/archive/search?${qs}`) : Promise.resolve(null)), [qs]);
  const exportAct = useAction(async (userIds?: number[]) => {
    await downloadPost('/api/admin/archive/export', { format: 'eml_zip', layout: 'mailboxes', ...(userIds ? { userIds } : {}) }, 'archive-mailboxes.zip');
  });
  const shown = (list.data?.items ?? []).filter((m) => !q || m.address.toLowerCase().includes(q.toLowerCase()) || (m.name ?? '').toLowerCase().includes(q.toLowerCase()));
  const current = list.data?.items.find((m) => m.userId === sel?.userId) ?? null;
  const pick = (userId: number, role: 'received' | 'sent') => {
    setSel({ userId, role });
    setPageNo(1);
  };
  return (
    <div className="grid gap-5 lg:grid-cols-[18rem_minmax(0,1fr)]">
      <Card
        title={`Mailboxes${list.data ? ` (${list.data.items.length})` : ''}`}
        actions={
          list.data?.items.length ? (
            <Button variant="secondary" busy={exportAct.busy} onClick={() => void exportAct.run()} title="One folder per address, with Received and Sent">
              Download all
            </Button>
          ) : null
        }
      >
        <div className="space-y-3">
          <Input placeholder="Find an address or name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Find mailbox" />
          {!list.data ? (
            <Spinner />
          ) : !shown.length ? (
            <Empty>{list.data.items.length ? 'No mailbox matches.' : 'Nothing archived yet.'}</Empty>
          ) : (
            <ul className="max-h-[60vh] space-y-0.5 overflow-y-auto text-sm" aria-label="Archived mailboxes">
              {shown.map((m) => {
                const open = sel?.userId === m.userId;
                return (
                  <li key={m.userId}>
                    <button
                      onClick={() => pick(m.userId, 'received')}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left ${open ? 'bg-brand-50 text-brand-900' : 'hover:bg-slate-50'}`}
                    >
                      <span aria-hidden>{open ? '📂' : '📁'}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium">{m.address}</span>
                        {m.name && <span className="block truncate text-xs text-slate-500">{m.name}</span>}
                      </span>
                      {m.deleted && <Badge color="slate">Deleted user</Badge>}
                    </button>
                    {open && (
                      <div className="ml-6 mt-0.5 space-y-0.5">
                        {(['received', 'sent'] as const).map((role) => (
                          <button
                            key={role}
                            onClick={() => pick(m.userId, role)}
                            className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-left ${sel?.role === role ? 'bg-brand-100 font-medium text-brand-900' : 'text-slate-700 hover:bg-slate-50'}`}
                          >
                            <span aria-hidden>{role === 'received' ? '📥' : '📤'}</span>
                            {role === 'received' ? 'Received' : 'Sent'}
                            <span className="ml-auto text-xs tabular text-slate-500">{(role === 'received' ? m.received : m.sent).toLocaleString('en-IN')}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </Card>
      <div className="min-w-0 space-y-3">
        <ErrorBanner error={list.error ?? msgs.error ?? exportAct.error} />
        {!sel || !current ? (
          <Card>
            <Empty>Choose a mailbox. Every address has a Received and a Sent folder holding all mail it got and sent, including mail the user has deleted.</Empty>
          </Card>
        ) : (
          <Card
            title={
              <span>
                {current.address} <span className="font-normal text-slate-500">/ {sel.role === 'received' ? 'Received' : 'Sent'}</span>
              </span>
            }
            actions={
              <Button variant="secondary" busy={exportAct.busy} onClick={() => void exportAct.run([current.userId])}>
                Download this mailbox (.zip)
              </Button>
            }
          >
            {!msgs.data ? (
              <Spinner />
            ) : !msgs.data.items.length ? (
              <Empty>No {sel.role === 'received' ? 'received' : 'sent'} mail archived for this address.</Empty>
            ) : (
              <>
                <Table head={['Date', sel.role === 'sent' ? 'To' : 'From', 'Subject', 'Size']}>
                  {msgs.data.items.map((h) => (
                    <tr key={h.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen(h.id)}>
                      <Td className="whitespace-nowrap text-xs">{formatDate(h.date ?? h.archivedAt)}</Td>
                      <Td className="max-w-[14rem] truncate">{sel.role === 'sent' ? h.envelopeRcpts.join(', ') : (h.fromHeader ?? h.envelopeFrom)}</Td>
                      <Td className="max-w-md truncate">
                        {h.hasAttachments ? '📎 ' : ''}
                        {h.subject || '(no subject)'}
                        {h.legalHold ? (
                          <span className="ml-1">
                            <Badge color="amber">Hold</Badge>
                          </span>
                        ) : null}
                      </Td>
                      <Td className="tabular text-xs">{formatBytes(h.size)}</Td>
                    </tr>
                  ))}
                </Table>
                <div className="mt-3 flex items-center justify-between text-sm">
                  <Button variant="secondary" disabled={pageNo <= 1} onClick={() => setPageNo(pageNo - 1)}>
                    Previous
                  </Button>
                  <span className="text-slate-500">
                    {msgs.data.total.toLocaleString('en-IN')} message(s) · page {pageNo}
                  </span>
                  <Button variant="secondary" disabled={pageNo * 50 >= msgs.data.total} onClick={() => setPageNo(pageNo + 1)}>
                    Next
                  </Button>
                </div>
              </>
            )}
          </Card>
        )}
      </div>
    </div>
  );
}

export function ArchivePage() {
  const [tab, setTab] = useState<'mailboxes' | 'search' | 'settings'>('mailboxes');
  const [open, setOpen] = useState<number | null>(null);
  const tabs = { mailboxes: 'Mailboxes', search: 'Search', settings: 'Retention & settings' } as const;
  return (
    <div>
      <PageHeader title="Compliance archive" description="Every message sent or received, kept read-only until its retention date, even when users delete it. All searches, views and exports are recorded in the audit log." />
      <div className="mb-4 flex gap-1 overflow-x-auto border-b border-slate-200" role="tablist">
        {(Object.keys(tabs) as (keyof typeof tabs)[]).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}>
            {tabs[k]}
          </button>
        ))}
      </div>
      {tab === 'mailboxes' && <Mailboxes onOpen={setOpen} />}
      {tab === 'search' && <ArchiveSearch onOpen={setOpen} />}
      {tab === 'settings' && (
        <div className="grid gap-5 lg:grid-cols-2">
          <PolicyCard />
          <RetentionCard />
        </div>
      )}
      {open !== null && <Viewer id={open} onClose={() => setOpen(null)} onChanged={() => undefined} />}
    </div>
  );
}

function ArchiveSearch({ onOpen }: { onOpen: (id: number) => void }) {
  const users = useUserOptions();
  const [f, setF] = useState({ q: '', from: '', to: '', direction: '', userId: '', sender: '', recipient: '' });
  const [criteria, setCriteria] = useState<Record<string, string> | null>(null);
  const [pageNo, setPageNo] = useState(1);
  const qs = criteria ? new URLSearchParams({ ...Object.fromEntries(Object.entries(criteria).filter(([, v]) => v)), page: String(pageNo), pageSize: '50' }).toString() : '';
  const res = useResource(() => (criteria ? get<{ items: Hit[]; total: number }>(`/api/admin/archive/search?${qs}`) : Promise.resolve(null)), [qs]);
  const exportAct = useAction(async (format: 'mbox' | 'eml_zip') => {
    const c = Object.fromEntries(Object.entries(criteria ?? {}).filter(([, v]) => v));
    await downloadPost('/api/admin/archive/export', { format, criteria: c }, format === 'mbox' ? 'archive.mbox' : 'archive.zip');
  });
  return (
    <div>
      <div className="space-y-5">
        <div className="space-y-5">
          <Card title="Search">
            <form
              className="grid gap-3 sm:grid-cols-3"
              onSubmit={(e) => {
                e.preventDefault();
                setPageNo(1);
                setCriteria({ ...f });
              }}
            >
              <Field label="Words (subject, text, attachments, addresses)" className="sm:col-span-3">
                <Input value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} placeholder='e.g. quotation "steel pipes"' />
              </Field>
              <Field label="From date">
                <Input type="date" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
              </Field>
              <Field label="To date">
                <Input type="date" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} />
              </Field>
              <Field label="Direction">
                <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value })}>
                  <option value="">Any</option>
                  <option value="in">Received</option>
                  <option value="out">Sent</option>
                  <option value="internal">Internal</option>
                </Select>
              </Field>
              <Field label="Mailbox">
                <Select value={f.userId} onChange={(e) => setF({ ...f, userId: e.target.value })}>
                  <option value="">Anyone</option>
                  {(users.data ?? [])
                    .filter((u) => u.hasMailbox)
                    .map((u) => (
                      <option key={u.id} value={u.id}>
                        {u.login}
                      </option>
                    ))}
                </Select>
              </Field>
              <Field label="Sender contains">
                <Input value={f.sender} onChange={(e) => setF({ ...f, sender: e.target.value })} />
              </Field>
              <Field label="Recipient contains">
                <Input value={f.recipient} onChange={(e) => setF({ ...f, recipient: e.target.value })} />
              </Field>
              <div className="flex gap-2 sm:col-span-3">
                <Button type="submit">Search</Button>
                {res.data && res.data.total > 0 && (
                  <>
                    <Button variant="secondary" busy={exportAct.busy} onClick={() => void exportAct.run('mbox')}>
                      Export MBOX
                    </Button>
                    <Button variant="secondary" busy={exportAct.busy} onClick={() => void exportAct.run('eml_zip')}>
                      Export ZIP (.eml)
                    </Button>
                  </>
                )}
              </div>
            </form>
          </Card>
          <ErrorBanner error={res.error ?? exportAct.error} />
          {criteria && (
            <Card title={res.data ? `${res.data.total.toLocaleString('en-IN')} message(s)` : 'Searching…'}>
              {!res.data ? (
                <Spinner />
              ) : !res.data.items.length ? (
                <Empty>No archived messages match.</Empty>
              ) : (
                <>
                  <Table head={['', 'Date', 'From', 'To', 'Subject', 'Size']}>
                    {res.data.items.map((h) => (
                      <tr key={h.id} className="cursor-pointer hover:bg-slate-50" onClick={() => onOpen(h.id)}>
                        <Td>
                          <Badge color={DIR[h.direction]?.color}>{DIR[h.direction]?.label}</Badge>
                          {h.legalHold ? (
                            <span className="ml-1">
                              <Badge color="amber">Hold</Badge>
                            </span>
                          ) : null}
                        </Td>
                        <Td className="whitespace-nowrap text-xs">{formatDate(h.date ?? h.archivedAt)}</Td>
                        <Td className="max-w-[12rem] truncate">{h.fromHeader ?? h.envelopeFrom}</Td>
                        <Td className="max-w-[12rem] truncate text-xs">{h.envelopeRcpts.join(', ')}</Td>
                        <Td className="max-w-xs truncate">
                          {h.hasAttachments ? '📎 ' : ''}
                          {h.subject || '(no subject)'}
                        </Td>
                        <Td className="tabular text-xs">{formatBytes(h.size)}</Td>
                      </tr>
                    ))}
                  </Table>
                  <div className="mt-3 flex items-center justify-between text-sm">
                    <Button variant="secondary" disabled={pageNo <= 1} onClick={() => setPageNo(pageNo - 1)}>
                      Previous
                    </Button>
                    <span className="text-slate-500">Page {pageNo}</span>
                    <Button variant="secondary" disabled={pageNo * 50 >= res.data.total} onClick={() => setPageNo(pageNo + 1)}>
                      Next
                    </Button>
                  </div>
                </>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
