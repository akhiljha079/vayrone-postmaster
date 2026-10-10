import { useEffect, useState } from 'react';
import { del, formatBytes, formatDate, get, post, put } from '../../api';
import { useMe } from '../../auth';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea, Toggle, useAction, useConfirm, useResource } from '../../components/ui';

type Dir = 'in' | 'internal' | 'out';
interface FilterConfig {
  spam: { engine: 'off' | 'builtin' | 'rspamd'; rspamdUrl: string; junkScore: number; quarantineScore: number | null };
  antivirus: { engine: 'off' | 'clamav'; host: string; port: number; socket: string | null; onError: 'deliver' | 'quarantine' };
  attachments: { enabled: boolean; blocked: string[]; scanZip: boolean; directions: Dir[] };
  quarantineDays: number;
  notifyRecipients: boolean;
  antivirusLicensed: boolean;
  defaults: { attachments: { blocked: string[] } };
}
interface Held {
  id: number;
  kind: 'virus' | 'attachment' | 'spam';
  direction: Dir;
  reason: string;
  from: string;
  subject: string | null;
  size: number;
  recipients: string[];
  createdAt: string;
  releasedAt: string | null;
  deletedAt: string | null;
}

const KIND: Record<Held['kind'], { label: string; color: 'red' | 'amber' | 'slate' }> = {
  virus: { label: 'Virus', color: 'red' },
  attachment: { label: 'Blocked attachment', color: 'amber' },
  spam: { label: 'Spam', color: 'slate' },
};
const DIR_LABEL: Record<Dir, string> = { in: 'incoming', internal: 'internal', out: 'outgoing' };

export function FilteringPage() {
  const [tab, setTab] = useState<'quarantine' | 'settings' | 'senders'>('quarantine');
  return (
    <>
      <PageHeader title="Spam, virus and attachment filtering" description="Every message is checked once before rules run. Held messages wait in quarantine; nothing is lost." />
      <div className="mb-4 flex gap-1 border-b border-slate-200">
        {(
          [
            ['quarantine', 'Quarantine'],
            ['settings', 'Settings'],
            ['senders', 'Allowed and blocked senders'],
          ] as const
        ).map(([k, l]) => (
          <button key={k} onClick={() => setTab(k)} className={`-mb-px border-b-2 px-3 py-2 text-sm ${tab === k ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-slate-600 hover:text-slate-900'}`}>
            {l}
          </button>
        ))}
      </div>
      {tab === 'quarantine' && <Quarantine />}
      {tab === 'settings' && <Settings />}
      {tab === 'senders' && <Senders />}
    </>
  );
}

function Quarantine() {
  const me = useMe();
  const [state, setState] = useState('held');
  const [kind, setKind] = useState('');
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const list = useResource(() => get<{ total: number; items: Held[] }>(`/api/admin/quarantine?state=${state}&kind=${kind}&q=${encodeURIComponent(search)}`), [state, kind, search]);
  const [view, setView] = useState<number | null>(null);
  const [ask, confirmNode] = useConfirm();
  const act = useAction(async (h: Held, what: 'release' | 'delete') => {
    const msg =
      what === 'release'
        ? h.kind === 'virus'
          ? `Release a message that contains a virus to ${h.recipients.join(', ')}? Only do this if you are sure it is a false alarm.`
          : `Deliver this message to ${h.recipients.join(', ')}?`
        : 'Delete this held message permanently?';
    if (!(await ask(msg, { danger: what === 'delete' || h.kind === 'virus', confirmLabel: what === 'release' ? 'Release' : 'Delete' }))) return;
    await post(`/api/admin/quarantine/${h.id}/${what}`);
    list.reload();
  });
  return (
    <Card>
      {confirmNode}
      <ErrorBanner error={list.error ?? act.error} />
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="w-36">
          <Select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="held">Held</option>
            <option value="released">Released</option>
            <option value="deleted">Deleted</option>
            <option value="all">All</option>
          </Select>
        </div>
        <div className="w-44">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            <option value="">All reasons</option>
            <option value="virus">Virus</option>
            <option value="attachment">Blocked attachment</option>
            <option value="spam">Spam</option>
          </Select>
        </div>
        <form
          className="w-full sm:w-64"
          onSubmit={(e) => {
            e.preventDefault();
            setSearch(q);
          }}
        >
          <Input placeholder="Search sender or subject" value={q} onChange={(e) => setQ(e.target.value)} />
        </form>
      </div>
      {!list.data ? (
        <Spinner />
      ) : !list.data.items.length ? (
        <Empty>No messages here.</Empty>
      ) : (
        <Table head={['Received', 'Reason', 'From / subject', 'To', '']}>
          {list.data.items.map((h) => (
            <tr key={h.id}>
              <Td className="whitespace-nowrap text-xs">{formatDate(h.createdAt)}</Td>
              <Td>
                <Badge color={KIND[h.kind].color}>{KIND[h.kind].label}</Badge>
                <div className="mt-1 max-w-xs text-xs text-slate-500">{h.reason}</div>
              </Td>
              <Td>
                <div className="max-w-xs truncate text-sm">{h.from || '(no sender)'}</div>
                <div className="max-w-xs truncate text-xs text-slate-500">
                  {h.subject ?? '(no subject)'} · {formatBytes(h.size)} · {DIR_LABEL[h.direction]}
                </div>
              </Td>
              <Td className="text-xs">{h.recipients.join(', ')}</Td>
              <Td className="whitespace-nowrap text-right">
                <Button variant="ghost" onClick={() => setView(h.id)}>
                  Details
                </Button>
                {!h.releasedAt && !h.deletedAt && (
                  <>
                    <Button variant="secondary" disabled={h.kind === 'virus' && me.user.role !== 'super_admin'} onClick={() => void act.run(h, 'release')}>
                      Release
                    </Button>
                    <Button variant="ghost" onClick={() => void act.run(h, 'delete')}>
                      Delete
                    </Button>
                  </>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
      {view && <HeldDetails id={view} onClose={() => setView(null)} />}
    </Card>
  );
}

function HeldDetails({ id, onClose }: { id: number; onClose: () => void }) {
  const d = useResource(() => get<{ reason: string; headers: string | null; attachments: { name: string; size: number }[] }>(`/api/admin/quarantine/${id}`), [id]);
  return (
    <Modal open wide title={`Held message #${id}`} onClose={onClose}>
      {!d.data ? (
        <Spinner />
      ) : (
        <div className="space-y-3 text-sm">
          <div>
            <b>Reason:</b> {d.data.reason}
          </div>
          {d.data.attachments.length > 0 && (
            <div>
              <b>Attachments:</b>
              <ul className="ml-5 list-disc">
                {d.data.attachments.map((a, i) => (
                  <li key={i}>
                    {a.name} {a.size ? <span className="text-slate-500">({formatBytes(a.size)})</span> : null}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div>
            <b>Headers</b> (the message itself is not shown for safety)
            <pre className="mt-1 max-h-80 overflow-auto rounded bg-slate-50 p-2 text-xs ring-1 ring-slate-200">{d.data.headers ?? '(message file missing)'}</pre>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Settings() {
  const me = useMe();
  const owner = me.user.role === 'super_admin';
  const r = useResource(() => get<FilterConfig>('/api/admin/filter'));
  const [f, setF] = useState<FilterConfig | null>(null);
  const [blocked, setBlocked] = useState('');
  const [avResult, setAvResult] = useState<{ ok: boolean; message: string } | null>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (r.data) {
      setF(r.data);
      setBlocked(r.data.attachments.blocked.join(', '));
    }
  }, [r.data]);
  const save = useAction(async () => {
    const { antivirusLicensed: _l, defaults: _d, ...body } = f!;
    await put('/api/admin/filter', { ...body, attachments: { ...f!.attachments, blocked: blocked.split(/[\s,;]+/).filter(Boolean) } });
    setSaved(true);
    r.reload();
  });
  const testAv = useAction(async () => {
    setAvResult(await post('/api/admin/filter/test-antivirus'));
  });
  if (r.error) return <ErrorBanner error={r.error} />;
  if (!f) return <Spinner />;
  const set = <K extends keyof FilterConfig>(k: K, v: FilterConfig[K]) => (setSaved(false), setF({ ...f, [k]: v }));
  const dir = (d: Dir) => (
    <label key={d} className="flex items-center gap-1.5 text-sm">
      <input
        type="checkbox"
        disabled={!owner}
        checked={f.attachments.directions.includes(d)}
        onChange={(e) => set('attachments', { ...f.attachments, directions: e.target.checked ? [...f.attachments.directions, d] : f.attachments.directions.filter((x) => x !== d) })}
      />
      {DIR_LABEL[d]}
    </label>
  );
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      <ErrorBanner error={save.error} />
      <Card title="Spam">
        <div className="space-y-3">
          <Field label="Spam check">
            <Select value={f.spam.engine} disabled={!owner} onChange={(e) => set('spam', { ...f.spam, engine: e.target.value as FilterConfig['spam']['engine'] })}>
              <option value="builtin">Built-in rules (no extra software)</option>
              <option value="rspamd">Rspamd server (Linux, strongest)</option>
              <option value="off">Off</option>
            </Select>
          </Field>
          {f.spam.engine === 'rspamd' && (
            <Field label="Rspamd address" hint="Install: apt install rspamd (or dnf). Uses the normal worker port 11333.">
              <Input value={f.spam.rspamdUrl} disabled={!owner} onChange={(e) => set('spam', { ...f.spam, rspamdUrl: e.target.value })} />
            </Field>
          )}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Move to Junk from score">
              <Input type="number" value={String(f.spam.junkScore)} disabled={!owner} onChange={(e) => set('spam', { ...f.spam, junkScore: Number(e.target.value) })} />
            </Field>
            <Field label="Quarantine from score" hint="empty = never">
              <Input value={f.spam.quarantineScore === null ? '' : String(f.spam.quarantineScore)} disabled={!owner} onChange={(e) => set('spam', { ...f.spam, quarantineScore: e.target.value === '' ? null : Number(e.target.value) })} />
            </Field>
          </div>
          <p className="text-xs text-slate-500">Users move mail with Junk / Not junk in webmail; the server then remembers the sender for them. Mail already marked as spam by the provider counts too.</p>
        </div>
      </Card>

      <Card title="Viruses (ClamAV)">
        <div className="space-y-3">
          {!f.antivirusLicensed && <p className="mb-2 text-sm text-amber-800">Virus scanning is not included in this licence.</p>}
          <Field label="Virus scan">
            <Select value={f.antivirus.engine} disabled={!owner || !f.antivirusLicensed} onChange={(e) => set('antivirus', { ...f.antivirus, engine: e.target.value as 'off' | 'clamav' })}>
              <option value="off">Off</option>
              <option value="clamav">ClamAV</option>
            </Select>
          </Field>
          {f.antivirus.engine === 'clamav' && (
            <>
              <div className="grid gap-3 sm:grid-cols-3">
                <Field label="Host" className="col-span-2">
                  <Input value={f.antivirus.host} disabled={!owner} onChange={(e) => set('antivirus', { ...f.antivirus, host: e.target.value })} />
                </Field>
                <Field label="Port">
                  <Input value={String(f.antivirus.port)} disabled={!owner} onChange={(e) => set('antivirus', { ...f.antivirus, port: Number(e.target.value) })} />
                </Field>
              </div>
              <Field label="Unix socket (Linux, instead of host and port)" hint="e.g. /var/run/clamav/clamd.ctl (Ubuntu/Debian) or /run/clamd.scan/clamd.sock (RHEL)">
                <Input value={f.antivirus.socket ?? ''} disabled={!owner} onChange={(e) => set('antivirus', { ...f.antivirus, socket: e.target.value.trim() || null })} />
              </Field>
              <Field label="If ClamAV is not reachable">
                <Select value={f.antivirus.onError} disabled={!owner} onChange={(e) => set('antivirus', { ...f.antivirus, onError: e.target.value as 'deliver' | 'quarantine' })}>
                  <option value="deliver">Deliver unscanned (and alert)</option>
                  <option value="quarantine">Hold incoming mail (and alert)</option>
                </Select>
              </Field>
              <div className="flex items-center gap-2">
                <Button variant="secondary" busy={testAv.busy} onClick={() => void testAv.run()}>
                  Test with the EICAR test file
                </Button>
                {avResult && <span className={`text-sm ${avResult.ok ? 'text-emerald-700' : 'text-red-700'}`}>{avResult.message}</span>}
              </div>
              <p className="mt-2 text-xs text-slate-500">Linux: apt install clamav-daemon (or dnf install clamd), then set TCPSocket 3310 and TCPAddr 127.0.0.1. Windows: ClamAV for Windows with clamd. Save before testing.</p>
            </>
          )}
        </div>
      </Card>

      <Card title="Blocked attachments">
        <div className="space-y-3">
          <Toggle checked={f.attachments.enabled} disabled={!owner} onChange={(v) => set('attachments', { ...f.attachments, enabled: v })} label="Block dangerous file types" />
          <Field label="File types" hint="Separated by commas. Incoming and internal mail is held in quarantine; outgoing mail is refused with an error to the sender.">
            <Textarea rows={3} value={blocked} disabled={!owner} onChange={(e) => (setSaved(false), setBlocked(e.target.value))} />
          </Field>
          <div className="mb-2 flex flex-wrap gap-4">{(['in', 'internal', 'out'] as Dir[]).map(dir)}</div>
          <Toggle checked={f.attachments.scanZip} disabled={!owner} onChange={(v) => set('attachments', { ...f.attachments, scanZip: v })} label="Also look inside ZIP files" />
          {owner && (
            <Button variant="ghost" className="mt-2" onClick={() => (setSaved(false), setBlocked(f.defaults.attachments.blocked.join(', ')))}>
              Restore the default list
            </Button>
          )}
        </div>
      </Card>

      <Card title="Quarantine">
        <div className="space-y-3">
          <Field label="Keep held messages for (days)">
            <Input type="number" value={String(f.quarantineDays)} disabled={!owner} onChange={(e) => set('quarantineDays', Number(e.target.value))} />
          </Field>
          <Toggle checked={f.notifyRecipients} disabled={!owner} onChange={(v) => set('notifyRecipients', v)} label="Tell recipients when a message to them is held (virus / attachment)" />
        </div>
      </Card>

      {owner && (
        <div className="flex items-center justify-end gap-3 xl:col-span-2">
          {saved && <span className="text-sm text-emerald-700">Saved</span>}
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        </div>
      )}
    </div>
  );
}

function Senders() {
  const list = useResource(() => get<{ id: number; pattern: string; kind: 'allow' | 'block'; source: string; createdAt: string }[]>('/api/admin/sender-lists'));
  const [pattern, setPattern] = useState('');
  const [kind, setKind] = useState<'allow' | 'block'>('block');
  const add = useAction(async () => {
    await post('/api/admin/sender-lists', { pattern, kind });
    setPattern('');
    list.reload();
  });
  return (
    <Card title="Server-wide sender lists">
      <p className="mb-3 text-sm text-slate-600">Allowed senders skip the spam check (never the virus or attachment checks). Blocked senders always go to Junk. Users have their own lists, filled by Junk / Not junk in webmail.</p>
      <ErrorBanner error={list.error ?? add.error} />
      <div className="mb-3 flex flex-wrap gap-2">
        <div className="w-full sm:w-72">
          <Input placeholder="name@domain.com or @domain.com" value={pattern} onChange={(e) => setPattern(e.target.value)} />
        </div>
        <div className="w-32">
          <Select value={kind} onChange={(e) => setKind(e.target.value as 'allow' | 'block')}>
            <option value="block">Block</option>
            <option value="allow">Allow</option>
          </Select>
        </div>
        <Button busy={add.busy} disabled={!pattern} onClick={() => void add.run()}>
          Add
        </Button>
      </div>
      {!list.data?.length ? (
        <Empty>No entries.</Empty>
      ) : (
        <Table head={['Sender', 'List', 'Added', '']}>
          {list.data.map((s) => (
            <tr key={s.id}>
              <Td className="font-mono text-sm">{s.pattern}</Td>
              <Td>
                <Badge color={s.kind === 'allow' ? 'green' : 'red'}>{s.kind}</Badge>
              </Td>
              <Td className="text-xs">{formatDate(s.createdAt)}</Td>
              <Td className="text-right">
                <Button variant="ghost" onClick={() => void del(`/api/admin/sender-lists/${s.id}`).then(list.reload)}>
                  Remove
                </Button>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </Card>
  );
}
