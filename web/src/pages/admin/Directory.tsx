import { useMemo, useState } from 'react';
import { del, formatBytes, get, patch, post } from '../../api';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea, Toggle, useAction, useConfirm, useResource } from '../../components/ui';
import { useUserOptions, type UserRow } from './Users';

const GB = 1024 ** 3;

type Target = { userId: number } | { external: string };

/** One address per line → local user targets where the address is a mailbox, external otherwise. */
function parseTargets(text: string, users: UserRow[]): Target[] {
  const byLogin = new Map(users.filter((u) => u.hasMailbox).map((u) => [u.login.toLowerCase(), u.id]));
  return text
    .split(/[\n,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((a) => (byLogin.has(a) ? { userId: byLogin.get(a)! } : { external: a }));
}

function targetsText(list: { userId: number | null; login: string | null; external: string | null }[]): string {
  return list.map((t) => t.login ?? t.external ?? '').join('\n');
}

// =================================================================== Domains

interface DomainRow {
  id: number;
  name: string;
  isEnabled: number;
  unknownRecipientAction: 'reject' | 'catchall' | 'relay';
  catchallUserId: number | null;
  defaultQuotaBytes: number;
  userCount: number;
  aliasCount: number;
}

const UNKNOWN_LABEL = {
  relay: 'Send through the relay (mailbox exists only at the provider)',
  reject: 'Reject the message',
  catchall: 'Deliver to a catch-all mailbox',
};

function DomainModal({ d, onClose, onSaved }: { d: DomainRow | 'new'; onClose: () => void; onSaved: () => void }) {
  const isNew = d === 'new';
  const users = useUserOptions();
  const [f, setF] = useState({
    name: isNew ? '' : d.name,
    isEnabled: isNew ? true : Boolean(d.isEnabled),
    unknownRecipientAction: isNew ? ('relay' as const) : d.unknownRecipientAction,
    catchallUserId: isNew ? '' : String(d.catchallUserId ?? ''),
    quotaGb: isNew ? '5' : String(d.defaultQuotaBytes / GB),
  });
  const save = useAction(async () => {
    const body = {
      isEnabled: f.isEnabled,
      unknownRecipientAction: f.unknownRecipientAction,
      catchallUserId: f.catchallUserId ? Number(f.catchallUserId) : null,
      defaultQuotaBytes: Math.round(Number(f.quotaGb) * GB),
    };
    if (isNew) await post('/api/admin/domains', { name: f.name, ...body });
    else await patch(`/api/admin/domains/${d.id}`, body);
    onSaved();
  });
  const domainUsers = (users.data ?? []).filter((u) => u.hasMailbox && (isNew || u.domain === d.name));
  return (
    <Modal
      open
      title={isNew ? 'Add domain' : d.name}
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
      <Field label="Domain name">
        <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} disabled={!isNew} placeholder="company.com" />
      </Field>
      <Field label="Mail to an unknown address in this domain" hint="Applies to mail sent from the LAN to an address that has no local mailbox.">
        <Select value={f.unknownRecipientAction} onChange={(e) => setF({ ...f, unknownRecipientAction: e.target.value as 'relay' })}>
          {Object.entries(UNKNOWN_LABEL).map(([k, v]) => (
            <option key={k} value={k}>
              {v}
            </option>
          ))}
        </Select>
      </Field>
      {f.unknownRecipientAction === 'catchall' && (
        <Field label="Catch-all mailbox">
          <Select value={f.catchallUserId} onChange={(e) => setF({ ...f, catchallUserId: e.target.value })}>
            <option value="">Choose…</option>
            {domainUsers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.login}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Default mailbox quota (GB)">
        <Input type="number" min={0} step={0.5} value={f.quotaGb} onChange={(e) => setF({ ...f, quotaGb: e.target.value })} />
      </Field>
      <Toggle checked={f.isEnabled} onChange={(v) => setF({ ...f, isEnabled: v })} label="Domain enabled" />
    </Modal>
  );
}

export function Domains() {
  const list = useResource(() => get<DomainRow[]>('/api/admin/domains'));
  const [editing, setEditing] = useState<DomainRow | 'new' | null>(null);
  const [ask, confirmNode] = useConfirm();
  const remove = useAction(async (d: DomainRow) => {
    if (await ask(`Remove domain ${d.name}?`, { confirmLabel: 'Remove' })) {
      await del(`/api/admin/domains/${d.id}`);
      list.reload();
    }
  });
  return (
    <div>
      {confirmNode}
      <PageHeader title="Domains" description="Mail domains handled by this server." actions={<Button onClick={() => setEditing('new')}>Add domain</Button>} />
      <ErrorBanner error={list.error ?? remove.error} />
      <Card>
        {list.loading && !list.data ? (
          <Spinner />
        ) : !list.data?.length ? (
          <Empty>No domains yet. Add your company's email domain to get started.</Empty>
        ) : (
          <Table head={['Domain', 'Users', 'Aliases & lists', 'Default quota', 'Unknown addresses', '']}>
            {list.data.map((d) => (
              <tr key={d.id}>
                <Td>
                  <span className="font-medium">{d.name}</span> {!d.isEnabled && <Badge color="red">Disabled</Badge>}
                </Td>
                <Td className="tabular">{d.userCount}</Td>
                <Td className="tabular">{d.aliasCount}</Td>
                <Td className="tabular">{formatBytes(d.defaultQuotaBytes)}</Td>
                <Td className="capitalize">{d.unknownRecipientAction}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button variant="ghost" onClick={() => setEditing(d)}>
                    Edit
                  </Button>
                  <Button variant="ghost" onClick={() => void remove.run(d)} disabled={d.userCount > 0} title={d.userCount ? 'Remove its users first' : ''}>
                    Remove
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && <DomainModal d={editing} onClose={() => setEditing(null)} onSaved={() => (setEditing(null), list.reload())} />}
    </div>
  );
}

// =================================================================== Aliases

interface AliasRow {
  id: number;
  address: string;
  isEnabled: number;
  targets: { userId: number | null; login: string | null; external: string | null }[];
}

export function Aliases() {
  const list = useResource(() => get<AliasRow[]>('/api/admin/aliases'));
  const users = useUserOptions();
  const [editing, setEditing] = useState<AliasRow | 'new' | null>(null);
  const [f, setF] = useState({ address: '', targets: '', isEnabled: true });
  const [ask, confirmNode] = useConfirm();
  const open = (a: AliasRow | 'new') => {
    setEditing(a);
    setF(a === 'new' ? { address: '', targets: '', isEnabled: true } : { address: a.address, targets: targetsText(a.targets), isEnabled: Boolean(a.isEnabled) });
  };
  const save = useAction(async () => {
    const targets = parseTargets(f.targets, users.data ?? []);
    if (editing === 'new') await post('/api/admin/aliases', { address: f.address, targets, isEnabled: f.isEnabled });
    else await patch(`/api/admin/aliases/${(editing as AliasRow).id}`, { targets, isEnabled: f.isEnabled });
    setEditing(null);
    list.reload();
  });
  return (
    <div>
      {confirmNode}
      <PageHeader title="Aliases" description="Extra addresses that deliver to one or more mailboxes (e.g. info@, sales@)." actions={<Button onClick={() => open('new')}>New alias</Button>} />
      <ErrorBanner error={list.error} />
      <Card>
        {!list.data?.length ? (
          <Empty>No aliases yet.</Empty>
        ) : (
          <Table head={['Alias', 'Delivers to', '']}>
            {list.data.map((a) => (
              <tr key={a.id}>
                <Td>
                  <span className="font-medium">{a.address}</span> {!a.isEnabled && <Badge color="red">Disabled</Badge>}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {a.targets.map((t, i) => (
                      <Badge key={i} color={t.userId ? 'blue' : 'slate'}>
                        {t.login ?? t.external}
                      </Badge>
                    ))}
                  </div>
                </Td>
                <Td className="whitespace-nowrap text-right">
                  <Button variant="ghost" onClick={() => open(a)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (await ask(`Delete alias ${a.address}?`, { confirmLabel: 'Delete' })) {
                        await del(`/api/admin/aliases/${a.id}`);
                        list.reload();
                      }
                    }}
                  >
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'New alias' : `Edit ${f.address}`}
        onClose={() => setEditing(null)}
        footer={
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        }
      >
        <ErrorBanner error={save.error} />
        <Field label="Alias address">
          <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} disabled={editing !== 'new'} placeholder="info@company.com" />
        </Field>
        <Field label="Deliver to" hint="One address per line. Local mailboxes receive a copy directly; other addresses are sent out through the relay.">
          <Textarea rows={5} value={f.targets} onChange={(e) => setF({ ...f, targets: e.target.value })} />
        </Field>
        <Toggle checked={f.isEnabled} onChange={(v) => setF({ ...f, isEnabled: v })} label="Enabled" />
      </Modal>
    </div>
  );
}

// =================================================================== Lists

interface ListRow {
  id: number;
  address: string;
  name: string;
  senderPolicy: 'anyone' | 'domain' | 'members' | 'listed';
  allowedSenders: string[];
  expandExternal: number;
  isEnabled: number;
  members: { userId: number | null; login: string | null; external: string | null }[];
}

const POLICY_LABEL = {
  domain: 'Anyone in our domains',
  members: 'Only list members',
  listed: 'Only the addresses below',
  anyone: 'Anyone (including outside senders)',
};

export function Lists() {
  const list = useResource(() => get<ListRow[]>('/api/admin/lists'));
  const users = useUserOptions();
  const [editing, setEditing] = useState<ListRow | 'new' | null>(null);
  const empty = { address: '', name: '', senderPolicy: 'domain' as ListRow['senderPolicy'], allowed: '', members: '', expandExternal: true, isEnabled: true };
  const [f, setF] = useState(empty);
  const [ask, confirmNode] = useConfirm();
  const open = (l: ListRow | 'new') => {
    setEditing(l);
    setF(
      l === 'new'
        ? empty
        : {
            address: l.address,
            name: l.name,
            senderPolicy: l.senderPolicy,
            allowed: l.allowedSenders.join('\n'),
            members: targetsText(l.members),
            expandExternal: Boolean(l.expandExternal),
            isEnabled: Boolean(l.isEnabled),
          },
    );
  };
  const save = useAction(async () => {
    const body = {
      name: f.name,
      senderPolicy: f.senderPolicy,
      allowedSenders: f.allowed
        .split(/[\n,;]+/)
        .map((s) => s.trim())
        .filter(Boolean),
      members: parseTargets(f.members, users.data ?? []),
      expandExternal: f.expandExternal,
      isEnabled: f.isEnabled,
    };
    if (editing === 'new') await post('/api/admin/lists', { address: f.address, ...body });
    else await patch(`/api/admin/lists/${(editing as ListRow).id}`, body);
    setEditing(null);
    list.reload();
  });
  return (
    <div>
      {confirmNode}
      <PageHeader title="Distribution lists" description="Group addresses such as all@ or accounts@ that send to every member." actions={<Button onClick={() => open('new')}>New list</Button>} />
      <ErrorBanner error={list.error} />
      <Card>
        {!list.data?.length ? (
          <Empty>No distribution lists yet.</Empty>
        ) : (
          <Table head={['List', 'Members', 'Who can send', '']}>
            {list.data.map((l) => (
              <tr key={l.id}>
                <Td>
                  <div className="font-medium">{l.address}</div>
                  <div className="text-xs text-slate-500">{l.name}</div>
                </Td>
                <Td className="tabular">{l.members.length}</Td>
                <Td>{POLICY_LABEL[l.senderPolicy]}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button variant="ghost" onClick={() => open(l)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (await ask(`Delete list ${l.address}?`, { confirmLabel: 'Delete' })) {
                        await del(`/api/admin/lists/${l.id}`);
                        list.reload();
                      }
                    }}
                  >
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal
        open={editing !== null}
        wide
        title={editing === 'new' ? 'New distribution list' : `Edit ${f.address}`}
        onClose={() => setEditing(null)}
        footer={
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        }
      >
        <ErrorBanner error={save.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="List address">
            <Input value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} disabled={editing !== 'new'} placeholder="all@company.com" />
          </Field>
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="All staff" />
          </Field>
          <Field label="Members" hint="One address per line.">
            <Textarea rows={8} value={f.members} onChange={(e) => setF({ ...f, members: e.target.value })} />
          </Field>
          <div className="space-y-4">
            <Field label="Who can send to this list">
              <Select value={f.senderPolicy} onChange={(e) => setF({ ...f, senderPolicy: e.target.value as ListRow['senderPolicy'] })}>
                {Object.entries(POLICY_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </Select>
            </Field>
            {f.senderPolicy === 'listed' && (
              <Field label="Allowed senders">
                <Textarea rows={3} value={f.allowed} onChange={(e) => setF({ ...f, allowed: e.target.value })} />
              </Field>
            )}
            <Toggle checked={f.expandExternal} onChange={(v) => setF({ ...f, expandExternal: v })} label="Also send to outside members" />
            <Toggle checked={f.isEnabled} onChange={(v) => setF({ ...f, isEnabled: v })} label="Enabled" />
          </div>
        </div>
      </Modal>
    </div>
  );
}

// =================================================================== Groups

interface GroupRow {
  id: number;
  name: string;
  description: string | null;
  members: { userId: number; login: string }[];
}

export function Groups() {
  const list = useResource(() => get<GroupRow[]>('/api/admin/groups'));
  const users = useUserOptions();
  const [editing, setEditing] = useState<GroupRow | 'new' | null>(null);
  const [f, setF] = useState({ name: '', description: '', members: new Set<number>() });
  const [filter, setFilter] = useState('');
  const [ask, confirmNode] = useConfirm();
  const open = (g: GroupRow | 'new') => {
    setEditing(g);
    setFilter('');
    setF(g === 'new' ? { name: '', description: '', members: new Set() } : { name: g.name, description: g.description ?? '', members: new Set(g.members.map((m) => m.userId)) });
  };
  const save = useAction(async () => {
    const body = { name: f.name, description: f.description || null, memberIds: [...f.members] };
    if (editing === 'new') await post('/api/admin/groups', body);
    else await patch(`/api/admin/groups/${(editing as GroupRow).id}`, body);
    setEditing(null);
    list.reload();
  });
  const visible = useMemo(() => (users.data ?? []).filter((u) => `${u.login} ${u.displayName}`.toLowerCase().includes(filter.toLowerCase())), [users.data, filter]);
  return (
    <div>
      {confirmNode}
      <PageHeader title="Groups" description="Groups of users, used for rules, journaling and policies." actions={<Button onClick={() => open('new')}>New group</Button>} />
      <ErrorBanner error={list.error} />
      <Card>
        {!list.data?.length ? (
          <Empty>No groups yet.</Empty>
        ) : (
          <Table head={['Group', 'Members', '']}>
            {list.data.map((g) => (
              <tr key={g.id}>
                <Td>
                  <div className="font-medium">{g.name}</div>
                  {g.description && <div className="text-xs text-slate-500">{g.description}</div>}
                </Td>
                <Td className="tabular">{g.members.length}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button variant="ghost" onClick={() => open(g)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (await ask(`Delete group ${g.name}?`, { confirmLabel: 'Delete' })) {
                        await del(`/api/admin/groups/${g.id}`);
                        list.reload();
                      }
                    }}
                  >
                    Delete
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal
        open={editing !== null}
        title={editing === 'new' ? 'New group' : `Edit ${f.name}`}
        onClose={() => setEditing(null)}
        footer={
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        }
      >
        <ErrorBanner error={save.error} />
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        </Field>
        <Field label="Description">
          <Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        </Field>
        <Field label={`Members (${f.members.size})`}>
          <Input placeholder="Filter users" value={filter} onChange={(e) => setFilter(e.target.value)} className="mb-2" />
          <div className="max-h-56 space-y-1 overflow-y-auto rounded-md p-2 ring-1 ring-slate-200">
            {visible.map((u) => (
              <label key={u.id} className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={f.members.has(u.id)}
                  onChange={(e) => {
                    const m = new Set(f.members);
                    if (e.target.checked) m.add(u.id);
                    else m.delete(u.id);
                    setF({ ...f, members: m });
                  }}
                />
                {u.displayName} <span className="text-slate-500">{u.login}</span>
              </label>
            ))}
          </div>
        </Field>
      </Modal>
    </div>
  );
}
