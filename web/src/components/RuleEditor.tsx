import { useEffect, useState } from 'react';
import { del, formatDate, get, post, put } from '../api';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, Select, Spinner, Textarea, Toggle, useAction, useConfirm, useResource } from './ui';

// ---------------------------------------------------------------- model

type Cond = { field: string; op: string; value: string | number | boolean; header?: string; days?: number[] };
type Act = { type: string; folder?: string; to?: string[]; subject?: string; body?: string; message?: string; name?: string; value?: string };

export interface Rule {
  id: number;
  name: string;
  position: number;
  isEnabled: boolean;
  stage: 'inbound' | 'outbound' | 'both';
  matchMode: 'all' | 'any';
  conditions: Cond[];
  actions: Act[];
  stopProcessing: boolean;
  hitCount: number;
  lastHitAt: string | null;
}

const FIELDS: { key: string; label: string; ops: [string, string][]; kind: 'text' | 'number' | 'bool' | 'enum' | 'time' }[] = [
  { key: 'from', label: 'From', ops: [['contains', 'contains'], ['equals', 'is'], ['domain_is', 'domain is'], ['not_contains', 'does not contain'], ['regex', 'matches pattern']], kind: 'text' },
  { key: 'to', label: 'To', ops: [['contains', 'contains'], ['equals', 'is'], ['domain_is', 'domain is'], ['not_contains', 'does not contain']], kind: 'text' },
  { key: 'cc', label: 'Cc', ops: [['contains', 'contains'], ['equals', 'is'], ['domain_is', 'domain is']], kind: 'text' },
  { key: 'to_or_cc', label: 'To or Cc', ops: [['contains', 'contains'], ['equals', 'is'], ['domain_is', 'domain is']], kind: 'text' },
  { key: 'subject', label: 'Subject', ops: [['contains', 'contains'], ['not_contains', 'does not contain'], ['equals', 'is'], ['starts_with', 'starts with'], ['regex', 'matches pattern']], kind: 'text' },
  { key: 'body', label: 'Message text', ops: [['contains', 'contains'], ['not_contains', 'does not contain']], kind: 'text' },
  { key: 'header', label: 'Header', ops: [['contains', 'contains'], ['equals', 'is'], ['exists', 'exists']], kind: 'text' },
  { key: 'size', label: 'Size (KB)', ops: [['gt', 'larger than'], ['lt', 'smaller than']], kind: 'number' },
  { key: 'has_attachment', label: 'Has attachment', ops: [['is', 'is']], kind: 'bool' },
  { key: 'attachment_ext', label: 'Attachment type', ops: [['in', 'is one of']], kind: 'text' },
  { key: 'direction', label: 'Direction', ops: [['is', 'is']], kind: 'enum' },
  { key: 'time', label: 'Time of day', ops: [['between', 'between']], kind: 'time' },
];

const ACTIONS: { type: string; label: string; inboundOnly?: boolean }[] = [
  { type: 'move', label: 'Move to folder', inboundOnly: true },
  { type: 'copy', label: 'Copy to folder', inboundOnly: true },
  { type: 'mark_read', label: 'Mark as read', inboundOnly: true },
  { type: 'flag', label: 'Flag', inboundOnly: true },
  { type: 'forward', label: 'Forward a copy to' },
  { type: 'redirect', label: 'Redirect (no copy kept) to', inboundOnly: true },
  { type: 'auto_reply', label: 'Send automatic reply', inboundOnly: true },
  { type: 'add_header', label: 'Add header' },
  { type: 'reject', label: 'Reject (sender is told)' },
  { type: 'discard', label: 'Delete silently' },
  { type: 'stop', label: 'Stop processing more rules' },
];

function newCondition(field = 'subject'): Cond {
  const f = FIELDS.find((x) => x.key === field)!;
  const op = f.ops[0]![0];
  const value = f.kind === 'bool' ? true : f.kind === 'number' ? 1024 : f.kind === 'enum' ? 'in' : f.kind === 'time' ? '18:00-09:00' : '';
  return { field, op, value, ...(field === 'header' ? { header: 'X-' } : {}) };
}

function newAction(type: string): Act {
  switch (type) {
    case 'move':
    case 'copy':
      return { type, folder: '' };
    case 'forward':
    case 'redirect':
      return { type, to: [] };
    case 'auto_reply':
      return { type, subject: 'Re: {subject}', body: '' };
    case 'add_header':
      return { type, name: 'X-', value: '' };
    case 'reject':
      return { type, message: '' };
    default:
      return { type };
  }
}

/** UI ↔ API: size is edited in KB, stored in bytes; blank optional fields are dropped. */
function toApi(r: Omit<Rule, 'id' | 'position' | 'hitCount' | 'lastHitAt'>) {
  return {
    ...r,
    conditions: r.conditions.map((c) => (c.field === 'size' ? { ...c, value: Math.round(Number(c.value) * 1024) } : c)),
    actions: r.actions.map((a) => (a.type === 'reject' && !a.message ? { type: 'reject' } : a)),
  };
}
function fromApi(r: Rule): Rule {
  return { ...r, conditions: r.conditions.map((c) => (c.field === 'size' ? { ...c, value: Math.round(Number(c.value) / 1024) } : c)) };
}

export function describeRule(r: Rule): string {
  const c = r.conditions.length
    ? r.conditions
        .map((x) => `${FIELDS.find((f) => f.key === x.field)?.label ?? x.field} ${FIELDS.find((f) => f.key === x.field)?.ops.find((o) => o[0] === x.op)?.[1] ?? x.op} ${x.op === 'exists' ? '' : String(x.value)}`.trim())
        .join(r.matchMode === 'any' ? ' or ' : ' and ')
    : 'every message';
  const a = r.actions
    .map((x) => {
      const label = ACTIONS.find((y) => y.type === x.type)?.label ?? x.type;
      if (x.folder) return `${label} "${x.folder}"`;
      if (x.to) return `${label} ${x.to.join(', ')}`;
      if (x.type === 'add_header') return `${label} ${x.name}`;
      return label;
    })
    .join(', ');
  return `If ${c} → ${a}`;
}

// ---------------------------------------------------------------- editor modal

function ConditionRow({ c, onChange, onRemove }: { c: Cond; onChange: (c: Cond) => void; onRemove: () => void }) {
  const f = FIELDS.find((x) => x.key === c.field)!;
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Select className="w-40" value={c.field} onChange={(e) => onChange(newCondition(e.target.value))}>
        {FIELDS.map((x) => (
          <option key={x.key} value={x.key}>
            {x.label}
          </option>
        ))}
      </Select>
      {c.field === 'header' && <Input className="w-36" value={c.header ?? ''} onChange={(e) => onChange({ ...c, header: e.target.value })} placeholder="X-Priority" />}
      <Select className="w-40" value={c.op} onChange={(e) => onChange({ ...c, op: e.target.value })}>
        {f.ops.map(([k, l]) => (
          <option key={k} value={k}>
            {l}
          </option>
        ))}
      </Select>
      {c.op !== 'exists' &&
        (f.kind === 'bool' ? (
          <Select className="w-24" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value === 'true' })}>
            <option value="true">yes</option>
            <option value="false">no</option>
          </Select>
        ) : f.kind === 'enum' ? (
          <Select className="w-40" value={String(c.value)} onChange={(e) => onChange({ ...c, value: e.target.value })}>
            <option value="in">incoming</option>
            <option value="out">outgoing</option>
            <option value="internal">internal</option>
          </Select>
        ) : (
          <Input
            className="min-w-[10rem] flex-1"
            type={f.kind === 'number' ? 'number' : 'text'}
            value={String(c.value)}
            onChange={(e) => onChange({ ...c, value: f.kind === 'number' ? Number(e.target.value) : e.target.value })}
            placeholder={f.kind === 'time' ? '18:00-09:00' : c.field === 'attachment_ext' ? 'exe, zip, js' : ''}
          />
        ))}
      <Button variant="ghost" onClick={onRemove} aria-label="Remove condition">
        ✕
      </Button>
    </div>
  );
}

function ActionRow({ a, onChange, onRemove, allowed }: { a: Act; onChange: (a: Act) => void; onRemove: () => void; allowed: typeof ACTIONS }) {
  return (
    <div className="space-y-2 rounded-md bg-slate-50 p-2">
      <div className="flex items-center gap-2">
        <Select className="w-64" value={a.type} onChange={(e) => onChange(newAction(e.target.value))}>
          {allowed.map((x) => (
            <option key={x.type} value={x.type}>
              {x.label}
            </option>
          ))}
        </Select>
        {(a.type === 'move' || a.type === 'copy') && <Input className="flex-1" value={a.folder ?? ''} onChange={(e) => onChange({ ...a, folder: e.target.value })} placeholder="Folder, e.g. Clients/Sharma" />}
        {(a.type === 'forward' || a.type === 'redirect') && (
          <Input
            className="flex-1"
            value={(a.to ?? []).join(', ')}
            onChange={(e) => onChange({ ...a, to: e.target.value.split(/[,;\s]+/).filter(Boolean) })}
            placeholder="name@company.com, other@company.com"
          />
        )}
        {a.type === 'reject' && <Input className="flex-1" value={a.message ?? ''} onChange={(e) => onChange({ ...a, message: e.target.value })} placeholder="Reason shown to the sender" />}
        {a.type === 'add_header' && (
          <>
            <Input className="w-44" value={a.name ?? ''} onChange={(e) => onChange({ ...a, name: e.target.value })} />
            <Input className="flex-1" value={a.value ?? ''} onChange={(e) => onChange({ ...a, value: e.target.value })} placeholder="value" />
          </>
        )}
        <Button variant="ghost" onClick={onRemove} aria-label="Remove action">
          ✕
        </Button>
      </div>
      {a.type === 'auto_reply' && (
        <div className="grid gap-2">
          <Input value={a.subject ?? ''} onChange={(e) => onChange({ ...a, subject: e.target.value })} placeholder="Subject ({subject} = original subject)" />
          <Textarea className="font-sans" rows={3} value={a.body ?? ''} onChange={(e) => onChange({ ...a, body: e.target.value })} placeholder="Reply text" />
        </div>
      )}
    </div>
  );
}

function RuleModal({ base, query, rule, allowOutbound, onClose, onSaved }: { base: string; query: string; rule: Rule | 'new'; allowOutbound: boolean; onClose: () => void; onSaved: () => void }) {
  const isNew = rule === 'new';
  const [r, setR] = useState(() =>
    isNew
      ? { name: '', isEnabled: true, stage: 'inbound' as Rule['stage'], matchMode: 'all' as Rule['matchMode'], conditions: [newCondition()], actions: [newAction('move')], stopProcessing: false }
      : (({ id, position, hitCount, lastHitAt, ...x }) => (void id, void position, void hitCount, void lastHitAt, x))(fromApi(rule)),
  );
  const allowed = ACTIONS.filter((a) => r.stage === 'inbound' || !a.inboundOnly);
  const save = useAction(async () => {
    if (isNew) await post(`${base}/rules${query}`, toApi(r));
    else await put(`${base}/rules/${rule.id}${query}`, toApi(r));
    onSaved();
  });
  const [sample, setSample] = useState({ from: 'Client <client@example.com>', subject: '', body: '' });
  const [result, setResult] = useState<{ matched: boolean; conditions: { matched: boolean }[] } | null>(null);
  const test = useAction(async () => setResult(await post(`${base}/rules/test`, { rule: toApi(r), sample: { ...sample, direction: r.stage === 'outbound' ? 'out' : 'in' } })));
  useEffect(() => setResult(null), [r]);

  return (
    <Modal
      open
      wide
      title={isNew ? 'New rule' : `Edit rule`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save rule
          </Button>
        </>
      }
    >
      <ErrorBanner error={save.error ?? test.error} />
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Rule name" className="sm:col-span-2">
          <Input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="e.g. Vendor invoices" />
        </Field>
        {allowOutbound && (
          <Field label="Applies to">
            <Select
              value={r.stage}
              onChange={(e) => {
                const stage = e.target.value as Rule['stage'];
                setR({ ...r, stage, actions: stage === 'inbound' ? r.actions : r.actions.filter((a) => !ACTIONS.find((x) => x.type === a.type)?.inboundOnly) });
              }}
            >
              <option value="inbound">Incoming mail</option>
              <option value="outbound">Outgoing mail</option>
              <option value="both">Both</option>
            </Select>
          </Field>
        )}
      </div>
      <fieldset className="space-y-2">
        <legend className="mb-1 flex items-center gap-2 text-sm font-medium text-slate-700">
          When
          <Select className="w-auto py-0.5" value={r.matchMode} onChange={(e) => setR({ ...r, matchMode: e.target.value as 'all' })}>
            <option value="all">all</option>
            <option value="any">any</option>
          </Select>
          of these are true {r.conditions.length === 0 && <span className="font-normal text-slate-500">(no conditions = every message)</span>}
        </legend>
        {r.conditions.map((c, i) => (
          <ConditionRow
            key={i}
            c={c}
            onChange={(n) => setR({ ...r, conditions: r.conditions.map((x, j) => (j === i ? n : x)) })}
            onRemove={() => setR({ ...r, conditions: r.conditions.filter((_, j) => j !== i) })}
          />
        ))}
        <Button variant="secondary" onClick={() => setR({ ...r, conditions: [...r.conditions, newCondition()] })}>
          + Condition
        </Button>
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium text-slate-700">Do this</legend>
        {r.actions.map((a, i) => (
          <ActionRow
            key={i}
            a={a}
            allowed={allowed}
            onChange={(n) => setR({ ...r, actions: r.actions.map((x, j) => (j === i ? n : x)) })}
            onRemove={() => setR({ ...r, actions: r.actions.filter((_, j) => j !== i) })}
          />
        ))}
        <Button variant="secondary" onClick={() => setR({ ...r, actions: [...r.actions, newAction(allowed[0]!.type)] })}>
          + Action
        </Button>
      </fieldset>
      <div className="flex flex-wrap gap-4">
        <Toggle checked={r.stopProcessing} onChange={(v) => setR({ ...r, stopProcessing: v })} label="Stop processing other rules after this one" />
        <Toggle checked={r.isEnabled} onChange={(v) => setR({ ...r, isEnabled: v })} label="Enabled" />
      </div>
      <details className="rounded-md ring-1 ring-slate-200">
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-slate-700">Try it on a sample message</summary>
        <div className="space-y-2 px-3 pb-3">
          <div className="grid gap-2 sm:grid-cols-2">
            <Input value={sample.from} onChange={(e) => setSample({ ...sample, from: e.target.value })} placeholder="From" />
            <Input value={sample.subject} onChange={(e) => setSample({ ...sample, subject: e.target.value })} placeholder="Subject" />
          </div>
          <Textarea className="font-sans" rows={2} value={sample.body} onChange={(e) => setSample({ ...sample, body: e.target.value })} placeholder="Message text" />
          <div className="flex items-center gap-3">
            <Button variant="secondary" busy={test.busy} onClick={() => void test.run()}>
              Test
            </Button>
            {result && (result.matched ? <Badge color="green">Rule matches</Badge> : <Badge color="slate">No match</Badge>)}
            {result && <span className="text-xs text-slate-500">Conditions: {result.conditions.map((c) => (c.matched ? '✓' : '✗')).join(' ')}</span>}
          </div>
        </div>
      </details>
    </Modal>
  );
}

// ---------------------------------------------------------------- list with drag-and-drop ordering

/**
 * base: '/api/admin' or '/api/mail'. userId (admin only) edits that user's rules;
 * omitted on the admin base means global rules.
 */
export function RuleList({ base, userId, allowOutbound, title, description }: { base: string; userId?: number; allowOutbound?: boolean; title: string; description?: string }) {
  const query = userId ? `?userId=${userId}` : '';
  const list = useResource(() => get<Rule[]>(`${base}/rules${query}`), [base, query]);
  const [order, setOrder] = useState<Rule[]>([]);
  useEffect(() => setOrder(list.data ?? []), [list.data]);
  const [editing, setEditing] = useState<Rule | 'new' | null>(null);
  const [dragId, setDragId] = useState<number | null>(null);
  const [ask, confirmNode] = useConfirm();
  const saveOrder = useAction(async (ids: number[]) => {
    await put(`${base}/rules-order${query}`, { ids });
    list.reload();
  });

  const onDrop = (targetId: number) => {
    if (dragId === null || dragId === targetId) return;
    const from = order.findIndex((r) => r.id === dragId);
    const to = order.findIndex((r) => r.id === targetId);
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    setOrder(next);
    void saveOrder.run(next.map((r) => r.id));
  };

  return (
    <Card title={title} actions={<Button onClick={() => setEditing('new')}>New rule</Button>}>
      {confirmNode}
      {description && <p className="mb-3 text-sm text-slate-600">{description}</p>}
      <ErrorBanner error={list.error ?? saveOrder.error} />
      {list.loading && !list.data ? (
        <Spinner />
      ) : !order.length ? (
        <Empty>No rules yet.</Empty>
      ) : (
        <ol className="space-y-2">
          {order.map((r, i) => (
            <li
              key={r.id}
              draggable
              onDragStart={() => setDragId(r.id)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => onDrop(r.id)}
              onDragEnd={() => setDragId(null)}
              className={`flex items-start gap-3 rounded-md bg-white p-3 ring-1 ring-slate-200 ${dragId === r.id ? 'opacity-50' : ''} ${r.isEnabled ? '' : 'opacity-60'}`}
            >
              <span className="cursor-grab select-none pt-0.5 text-slate-400" title="Drag to change the order" aria-hidden>
                ⋮⋮
              </span>
              <span className="w-5 pt-0.5 text-right text-xs tabular text-slate-400">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{r.name}</span>
                  {r.stage !== 'inbound' && <Badge color="blue">{r.stage === 'outbound' ? 'outgoing' : 'in + out'}</Badge>}
                  {r.stopProcessing && <Badge>stops</Badge>}
                  {!r.isEnabled && <Badge color="slate">off</Badge>}
                </div>
                <div className="mt-0.5 text-xs text-slate-500">{describeRule(fromApi(r))}</div>
                <div className="mt-0.5 text-xs text-slate-400">
                  Used {r.hitCount} times{r.lastHitAt ? `, last ${formatDate(r.lastHitAt)}` : ''}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <Toggle checked={r.isEnabled} onChange={(v) => void post(`${base}/rules/${r.id}/enabled${query}`, { enabled: v }).then(list.reload)} label="" />
                <Button variant="ghost" onClick={() => setEditing(r)}>
                  Edit
                </Button>
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (await ask(`Delete rule "${r.name}"?`, { confirmLabel: 'Delete' })) {
                      await del(`${base}/rules/${r.id}${query}`);
                      list.reload();
                    }
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ol>
      )}
      {editing && (
        <RuleModal
          base={base}
          query={query}
          rule={editing}
          allowOutbound={Boolean(allowOutbound)}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- forwarding & out of office

export function ForwardingCard({ url, externalAllowed }: { url: string; externalAllowed?: boolean }) {
  const f = useResource(() => get<{ address: string; keepLocalCopy: boolean; isEnabled: boolean }[]>(url), [url]);
  const [rows, setRows] = useState<{ address: string; keepLocalCopy: boolean; isEnabled: boolean }[]>([]);
  useEffect(() => setRows(f.data ?? []), [f.data]);
  const [saved, setSaved] = useState(false);
  const save = useAction(async () => {
    await put(url, { targets: rows.filter((r) => r.address.trim()) });
    setSaved(true);
    f.reload();
  });
  return (
    <Card title="Forwarding">
      <p className="mb-3 text-sm text-slate-600">
        Send a copy of every incoming message to another address.
        {externalAllowed === false && ' Only addresses in the company domains are allowed.'}
      </p>
      <ErrorBanner error={f.error ?? save.error} />
      <div className="space-y-2">
        {rows.map((r, i) => (
          <div key={i} className="flex flex-wrap items-center gap-3">
            <Input className="min-w-[14rem] flex-1" value={r.address} onChange={(e) => (setSaved(false), setRows(rows.map((x, j) => (j === i ? { ...x, address: e.target.value } : x))))} placeholder="colleague@company.com" />
            <Toggle checked={r.keepLocalCopy} onChange={(v) => (setSaved(false), setRows(rows.map((x, j) => (j === i ? { ...x, keepLocalCopy: v } : x))))} label="Keep a copy here" />
            <Toggle checked={r.isEnabled} onChange={(v) => (setSaved(false), setRows(rows.map((x, j) => (j === i ? { ...x, isEnabled: v } : x))))} label="On" />
            <Button variant="ghost" onClick={() => (setSaved(false), setRows(rows.filter((_, j) => j !== i)))}>
              ✕
            </Button>
          </div>
        ))}
        <div className="flex items-center gap-2">
          <Button variant="secondary" onClick={() => setRows([...rows, { address: '', keepLocalCopy: true, isEnabled: true }])} disabled={rows.length >= 10}>
            + Address
          </Button>
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
          {saved && <span className="text-sm text-emerald-700">Saved</span>}
        </div>
      </div>
    </Card>
  );
}

export function AutoReplyCard({ url }: { url: string }) {
  const a = useResource(() => get<{ isEnabled: boolean; subject: string; bodyText: string; startsAt: string | null; endsAt: string | null; internalOnly: boolean; oncePerDays: number }>(url), [url]);
  const [f, setF] = useState({ isEnabled: false, subject: 'Out of office', bodyText: '', startsAt: '', endsAt: '', internalOnly: false, oncePerDays: 4 });
  useEffect(() => {
    if (a.data) setF({ ...a.data, startsAt: a.data.startsAt?.slice(0, 16) ?? '', endsAt: a.data.endsAt?.slice(0, 16) ?? '' });
  }, [a.data]);
  const [saved, setSaved] = useState(false);
  const save = useAction(async () => {
    await put(url, { ...f, startsAt: f.startsAt ? new Date(f.startsAt).toISOString() : null, endsAt: f.endsAt ? new Date(f.endsAt).toISOString() : null });
    setSaved(true);
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => (setSaved(false), setF((s) => ({ ...s, [k]: v })));
  return (
    <Card title="Out of office" actions={f.isEnabled ? <Badge color="amber">On</Badge> : <Badge>Off</Badge>}>
      <div className="space-y-3">
        <ErrorBanner error={a.error ?? save.error} />
        <Toggle checked={f.isEnabled} onChange={(v) => set('isEnabled', v)} label="Send automatic replies" />
        <Field label="Subject" hint="{subject} is replaced with the original subject.">
          <Input value={f.subject} onChange={(e) => set('subject', e.target.value)} />
        </Field>
        <Field label="Message">
          <Textarea className="font-sans" rows={4} value={f.bodyText} onChange={(e) => set('bodyText', e.target.value)} placeholder="I am out of the office until Monday and will reply on my return." />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="From (optional)">
            <Input type="datetime-local" value={f.startsAt} onChange={(e) => set('startsAt', e.target.value)} />
          </Field>
          <Field label="Until (optional)">
            <Input type="datetime-local" value={f.endsAt} onChange={(e) => set('endsAt', e.target.value)} />
          </Field>
        </div>
        <Toggle checked={f.internalOnly} onChange={(v) => set('internalOnly', v)} label="Only reply to colleagues (company domains)" />
        <p className="text-xs text-slate-500">Each sender gets at most one reply every {f.oncePerDays} days. Mailing lists and automated messages are never answered.</p>
        <div className="flex items-center gap-3">
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
          {saved && <span className="text-sm text-emerald-700">Saved</span>}
        </div>
      </div>
    </Card>
  );
}
