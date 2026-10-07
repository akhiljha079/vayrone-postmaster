import { useState, type ReactNode } from 'react';
import { del, get, patch, post, put } from '../../api';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Toggle, useAction, useConfirm, useResource } from '../../components/ui';
import { useUserOptions } from './Users';

// Admin → Easy rules: the common "send a copy to someone" jobs as plain sentences.
// Copies use journaling rules (core/src/mailflow.ts journal(): incoming = the person
// received it, outgoing = the person sent it); "forward" uses the user's forwarding.
// Advanced options stay on the Mail rules and Journaling pages.

type Direction = 'in' | 'out' | 'both';
type Scope = 'all' | 'user' | 'domain' | 'group';
type Cond = { field: string; op: string; value: string | number | boolean };

interface Journal {
  id: number;
  name: string;
  direction: Direction;
  scope: Scope;
  scopeId: number | null;
  includeInternal: boolean;
  matchMode: 'all' | 'any';
  conditions: Cond[];
  targetAddress: string;
  isEnabled: boolean;
  hitCount: number;
}
interface Forwarding {
  userId: number;
  login: string;
  name: string;
  address: string;
  keepLocalCopy: boolean;
  isEnabled: boolean;
}

type Recipe = 'copyAll' | 'fromSender' | 'withAddress' | 'words' | 'forward';

const RECIPES: { id: Recipe; icon: string; title: string; example: string }[] = [
  { id: 'copyAll', icon: '📨', title: 'Copy all mail of a person', example: 'Every email Rahul sends and receives also goes to the manager.' },
  { id: 'fromSender', icon: '📥', title: 'Copy mail from a sender', example: 'When anyone gets mail from @bigclient.com, accounts gets a copy.' },
  { id: 'withAddress', icon: '🤝', title: 'Copy mail to or from an address', example: 'All mail exchanged with orders@sharma.com is copied to the owner.' },
  { id: 'words', icon: '🔤', title: 'Copy mail by subject or words', example: 'Emails with "invoice" in the subject are copied to accounts.' },
  { id: 'forward', icon: '↪️', title: "Forward a person's mail", example: 'While Priya is on leave, her mail goes to Rahul.' },
];

const DIRECTION_TEXT: Record<Direction, string> = { both: 'incoming and outgoing', in: 'incoming', out: 'outgoing' };
const emailOk = (s: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim());

function useScopeNames() {
  const users = useUserOptions();
  const domains = useResource(() => get<{ id: number; name: string }[]>('/api/admin/domains'));
  const groups = useResource(() => get<{ id: number; name: string }[]>('/api/admin/groups'));
  const name = (scope: Scope, id: number | null | string) => {
    const n = Number(id);
    if (scope === 'all') return 'everyone';
    if (scope === 'domain') return `everyone at ${domains.data?.find((d) => d.id === n)?.name ?? '…'}`;
    if (scope === 'group') return `group ${groups.data?.find((g) => g.id === n)?.name ?? '…'}`;
    return users.data?.find((u) => u.id === n)?.login ?? '…';
  };
  return { users, domains, groups, name };
}

/** One plain sentence for any journal rule, including ones made on the Journaling page. */
function describe(j: Pick<Journal, 'direction' | 'scope' | 'scopeId' | 'conditions' | 'targetAddress'>, scopeName: (s: Scope, id: number | null) => string): string {
  const who = scopeName(j.scope, j.scopeId);
  const parts = j.conditions.map((c) => {
    const v = String(c.value);
    if (c.field === 'from') return c.op === 'domain_is' ? `from @${v}` : `from ${v}`;
    if (c.field === 'to_or_cc') return `to or from ${v}`;
    if (c.field === 'subject') return `with "${v}" in the subject`;
    if (c.field === 'body') return `with "${v}" in the text`;
    return `${c.field} ${c.op} ${v}`;
  });
  const what = j.conditions.length ? `${DIRECTION_TEXT[j.direction]} emails ${parts.join(' and ')}` : `every ${DIRECTION_TEXT[j.direction]} email`;
  const of = j.scope === 'all' ? '' : ` of ${who}`;
  return `A copy of ${what}${of} goes to ${j.targetAddress}.`;
}

export function EasyRulesPage() {
  const journals = useResource(() => get<Journal[]>('/api/admin/journal-rules'));
  const forwards = useResource(() => get<Forwarding[]>('/api/admin/forwardings'));
  const scope = useScopeNames();
  const [open, setOpen] = useState<Recipe | null>(null);
  const [ask, confirmNode] = useConfirm();
  const toggle = useAction(async (j: Journal) => {
    await patch(`/api/admin/journal-rules/${j.id}`, { isEnabled: !j.isEnabled });
    journals.reload();
  });
  const removeJ = useAction(async (j: Journal) => {
    if (!(await ask(`Stop this rule?\n${describe(j, scope.name)}`, { confirmLabel: 'Delete rule' }))) return;
    await del(`/api/admin/journal-rules/${j.id}`);
    journals.reload();
  });
  const setForward = useAction(async (f: Forwarding, change: 'toggle' | 'delete') => {
    if (change === 'delete' && !(await ask(`Stop forwarding ${f.login}'s mail to ${f.address}?`, { confirmLabel: 'Stop forwarding' }))) return;
    const current = forwards.data!.filter((x) => x.userId === f.userId);
    const next = current
      .filter((x) => !(change === 'delete' && x.address === f.address))
      .map((x) => ({ address: x.address, keepLocalCopy: x.keepLocalCopy, isEnabled: x.address === f.address && change === 'toggle' ? !x.isEnabled : x.isEnabled }));
    await put(`/api/admin/users/${f.userId}/forwarding`, { targets: next });
    forwards.reload();
  });
  const done = () => {
    setOpen(null);
    journals.reload();
    forwards.reload();
  };

  return (
    <div>
      {confirmNode}
      <PageHeader title="Easy rules" description="Send copies of mail to someone, or forward a person's mail, in a few clicks. Rules work for everyone's mail on the server, whichever program people use." />

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
        {RECIPES.map((r) => (
          <button
            key={r.id}
            onClick={() => setOpen(r.id)}
            className="group flex flex-col items-start gap-1 rounded-lg bg-white p-4 text-left shadow-sm ring-1 ring-slate-200 transition hover:ring-brand-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            <span className="flex items-center gap-2 font-medium text-slate-900">
              <span aria-hidden className="text-lg">
                {r.icon}
              </span>
              {r.title}
            </span>
            <span className="text-sm text-slate-500">{r.example}</span>
            <span className="mt-1 text-sm font-medium text-brand-700 group-hover:underline">Set up →</span>
          </button>
        ))}
      </div>

      <ErrorBanner error={journals.error ?? forwards.error ?? toggle.error ?? removeJ.error ?? setForward.error} />
      <Card title="Rules in use" className="mt-5">
        {!journals.data || !forwards.data ? (
          <Spinner />
        ) : !journals.data.length && !forwards.data.length ? (
          <Empty>No copy or forwarding rules yet. Choose one of the jobs above.</Empty>
        ) : (
          <ul className="divide-y divide-slate-100">
            {journals.data.map((j) => (
              <li key={`j${j.id}`} className={`flex flex-wrap items-center gap-3 py-3 ${j.isEnabled ? '' : 'opacity-60'}`}>
                <span aria-hidden>📨</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-900">{describe(j, scope.name)}</div>
                  <div className="text-xs text-slate-500">
                    {j.name} · used {j.hitCount} time{j.hitCount === 1 ? '' : 's'}
                    {!j.isEnabled && ' · off'}
                  </div>
                </div>
                <Toggle checked={j.isEnabled} onChange={() => void toggle.run(j)} label={<span className="sr-only">On</span>} />
                <Button variant="ghost" onClick={() => void removeJ.run(j)}>
                  Delete
                </Button>
              </li>
            ))}
            {forwards.data.map((f) => (
              <li key={`f${f.userId}-${f.address}`} className={`flex flex-wrap items-center gap-3 py-3 ${f.isEnabled ? '' : 'opacity-60'}`}>
                <span aria-hidden>↪️</span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-slate-900">
                    {f.login}&apos;s incoming mail is forwarded to {f.address}
                    {f.keepLocalCopy ? ', and stays in their mailbox too.' : '. It does not stay in their mailbox.'}
                  </div>
                  <div className="text-xs text-slate-500">Forwarding{!f.isEnabled && ' · off'}</div>
                </div>
                <Toggle checked={f.isEnabled} onChange={() => void setForward.run(f, 'toggle')} label={<span className="sr-only">On</span>} />
                <Button variant="ghost" onClick={() => void setForward.run(f, 'delete')}>
                  Delete
                </Button>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-slate-500">
          More options (several conditions, moving to folders, auto-replies, rejecting mail) are on the <a className="text-brand-700 hover:underline" href="/admin/rules">Mail rules</a> and{' '}
          <a className="text-brand-700 hover:underline" href="/admin/journal">Journaling</a> pages.
        </p>
      </Card>

      {open && open !== 'forward' && <CopyDialog recipe={open} scope={scope} onClose={() => setOpen(null)} onDone={done} />}
      {open === 'forward' && <ForwardDialog users={scope.users.data ?? []} existing={forwards.data ?? []} onClose={() => setOpen(null)} onDone={done} />}
    </div>
  );
}

function WhoPicker({ scope, value, onChange, label }: { scope: ReturnType<typeof useScopeNames>; value: { scope: Scope; id: string }; onChange: (v: { scope: Scope; id: string }) => void; label: string }) {
  return (
    <Field label={label}>
      <div className="flex flex-wrap gap-2">
        <div className="w-44">
          <Select id="easy-scope" value={value.scope} onChange={(e) => onChange({ scope: e.target.value as Scope, id: '' })}>
            <option value="user">A person</option>
            <option value="all">Everyone</option>
            <option value="domain">Everyone at a domain</option>
            <option value="group">A group</option>
          </Select>
        </div>
        {value.scope !== 'all' && (
          <div className="min-w-0 flex-1">
            <Select id="easy-scope-id" value={value.id} onChange={(e) => onChange({ ...value, id: e.target.value })}>
              <option value="">Choose…</option>
              {value.scope === 'user' &&
                (scope.users.data ?? [])
                  .filter((u) => u.hasMailbox)
                  .map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.login}
                    </option>
                  ))}
              {value.scope === 'domain' &&
                (scope.domains.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              {value.scope === 'group' &&
                (scope.groups.data ?? []).map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
            </Select>
          </div>
        )}
      </div>
    </Field>
  );
}

function Preview({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md bg-brand-50 px-3 py-2 text-sm text-brand-900 ring-1 ring-brand-100">
      <span className="font-medium">This rule: </span>
      {children}
    </div>
  );
}

function CopyDialog({ recipe, scope, onClose, onDone }: { recipe: Exclude<Recipe, 'forward'>; scope: ReturnType<typeof useScopeNames>; onClose: () => void; onDone: () => void }) {
  const title = RECIPES.find((r) => r.id === recipe)!.title;
  const [who, setWho] = useState<{ scope: Scope; id: string }>({ scope: recipe === 'copyAll' ? 'user' : 'all', id: '' });
  const [direction, setDirection] = useState<Direction>(recipe === 'fromSender' ? 'in' : 'both');
  const [value, setValue] = useState('');
  const [where, setWhere] = useState<'subject' | 'body'>('subject');
  const [target, setTarget] = useState('');
  const [internal, setInternal] = useState(true);

  const conditions: Cond[] =
    recipe === 'fromSender' && value.trim()
      ? [value.trim().startsWith('@') ? { field: 'from', op: 'domain_is', value: value.trim().slice(1).toLowerCase() } : { field: 'from', op: 'contains', value: value.trim().toLowerCase() }]
      : recipe === 'withAddress' && value.trim()
        ? [{ field: 'to_or_cc', op: 'contains', value: value.trim().toLowerCase() }]
        : recipe === 'withAddress'
          ? []
          : recipe === 'words' && value.trim()
            ? [{ field: where, op: 'contains', value: value.trim() }]
            : [];
  // "to or from an address": outgoing mail TO it, or incoming mail FROM it.
  const rules =
    recipe === 'withAddress' && value.trim()
      ? [
          { direction: 'out' as Direction, conditions: [{ field: 'to_or_cc', op: 'contains', value: value.trim().toLowerCase() }] },
          { direction: 'in' as Direction, conditions: [{ field: 'from', op: 'contains', value: value.trim().toLowerCase() }] },
        ]
      : [{ direction, conditions }];

  const needsValue = recipe !== 'copyAll';
  const valueOk = !needsValue || (recipe === 'fromSender' ? /^@?[^\s@]+(\.[^\s@]+)+$|^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) : recipe === 'withAddress' ? emailOk(value) : value.trim().length >= 2);
  const whoOk = who.scope === 'all' || Boolean(who.id);
  const ready = whoOk && valueOk && emailOk(target);
  const sentence = rules.map((r) => describe({ direction: r.direction, scope: who.scope, scopeId: who.id ? Number(who.id) : null, conditions: r.conditions, targetAddress: target.trim() || '…' }, scope.name)).join(' ');

  const save = useAction(async () => {
    for (const r of rules) {
      await post('/api/admin/journal-rules', {
        name: `${title}: ${describe({ direction: r.direction, scope: who.scope, scopeId: who.id ? Number(who.id) : null, conditions: r.conditions, targetAddress: target.trim() }, scope.name)}`.slice(0, 200),
        direction: r.direction,
        scope: who.scope,
        scopeId: who.scope === 'all' ? null : Number(who.id),
        includeInternal: internal,
        matchMode: 'all',
        conditions: r.conditions,
        targetAddress: target.trim().toLowerCase(),
        isEnabled: true,
      });
    }
    onDone();
  });

  return (
    <Modal
      open
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.busy} disabled={!ready} onClick={() => void save.run()}>
            Create rule
          </Button>
        </>
      }
    >
      <ErrorBanner error={save.error} />
      {recipe === 'copyAll' && (
        <Field label="Which emails">
          <Select id="easy-direction" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            <option value="both">Incoming and outgoing</option>
            <option value="in">Incoming only (received)</option>
            <option value="out">Outgoing only (sent)</option>
          </Select>
        </Field>
      )}
      <WhoPicker scope={scope} value={who} onChange={setWho} label={recipe === 'copyAll' ? 'Whose emails' : recipe === 'fromSender' ? 'Received by' : 'Whose emails (usually everyone)'} />
      {recipe === 'fromSender' && (
        <Field label="Sender" hint="An address (client@example.com) or a whole company (@example.com).">
          <Input id="easy-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="@bigclient.com" />
        </Field>
      )}
      {recipe === 'withAddress' && (
        <Field label="Outside address" hint="Mail your team sends to this address, and mail received from it.">
          <Input id="easy-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="orders@sharma.com" />
        </Field>
      )}
      {recipe === 'words' && (
        <div className="flex flex-wrap gap-2">
          <div className="w-40">
            <Field label="Look in">
              <Select id="easy-where" value={where} onChange={(e) => setWhere(e.target.value as 'subject' | 'body')}>
                <option value="subject">Subject</option>
                <option value="body">Text of the email</option>
              </Select>
            </Field>
          </div>
          <div className="min-w-0 flex-1">
            <Field label="Contains">
              <Input id="easy-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="invoice" />
            </Field>
          </div>
        </div>
      )}
      {recipe === 'words' && (
        <Field label="Which emails">
          <Select id="easy-direction" value={direction} onChange={(e) => setDirection(e.target.value as Direction)}>
            <option value="both">Incoming and outgoing</option>
            <option value="in">Incoming only</option>
            <option value="out">Outgoing only</option>
          </Select>
        </Field>
      )}
      <Field label="Send the copy to" hint="Anyone: a colleague here, or an outside address.">
        <Input id="easy-target" type="email" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="manager@company.com" />
      </Field>
      <Toggle checked={internal} onChange={setInternal} label="Also copy mail between colleagues" />
      {ready && <Preview>{sentence}</Preview>}
      <p className="text-xs text-slate-500">The copy is the original email, unchanged. It arrives as soon as the email is sent or received. Copies never trigger more copies.</p>
    </Modal>
  );
}

function ForwardDialog({ users, existing, onClose, onDone }: { users: { id: number; login: string; hasMailbox: number | boolean }[]; existing: Forwarding[]; onClose: () => void; onDone: () => void }) {
  const [userId, setUserId] = useState('');
  const [target, setTarget] = useState('');
  const [keep, setKeep] = useState(true);
  const person = users.find((u) => String(u.id) === userId);
  const ready = Boolean(person) && emailOk(target) && target.trim().toLowerCase() !== person?.login.toLowerCase();
  const save = useAction(async () => {
    const current = existing.filter((f) => String(f.userId) === userId).filter((f) => f.address !== target.trim().toLowerCase());
    await put(`/api/admin/users/${userId}/forwarding`, {
      targets: [...current.map((f) => ({ address: f.address, keepLocalCopy: f.keepLocalCopy, isEnabled: f.isEnabled })), { address: target.trim().toLowerCase(), keepLocalCopy: keep, isEnabled: true }],
    });
    onDone();
  });
  return (
    <Modal
      open
      title="Forward a person's mail"
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.busy} disabled={!ready} onClick={() => void save.run()}>
            Start forwarding
          </Button>
        </>
      }
    >
      <ErrorBanner error={save.error} />
      <Field label="Whose mail">
        <Select id="fwd-user" value={userId} onChange={(e) => setUserId(e.target.value)}>
          <option value="">Choose…</option>
          {users
            .filter((u) => u.hasMailbox)
            .map((u) => (
              <option key={u.id} value={u.id}>
                {u.login}
              </option>
            ))}
        </Select>
      </Field>
      <Field label="Forward to">
        <Input id="fwd-target" type="email" value={target} onChange={(e) => setTarget(e.target.value)} placeholder="rahul@company.com" />
      </Field>
      <Toggle checked={keep} onChange={setKeep} label="Also keep the mail in their own mailbox" />
      {ready && (
        <Preview>
          {person!.login}&apos;s incoming mail goes to {target.trim()}
          {keep ? ' and also stays in their mailbox.' : ' and does not stay in their mailbox.'} Turn it off in &quot;Rules in use&quot; when they are back.
        </Preview>
      )}
      <p className="flex items-center gap-1 text-xs text-slate-500">
        <Badge color="blue">Tip</Badge> For copies of sent mail too, use &quot;Copy all mail of a person&quot; instead.
      </p>
    </Modal>
  );
}
