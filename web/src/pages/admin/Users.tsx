import { useState } from 'react';
import { del, formatBytes, formatDate, get, patch, post, ROLE_LABEL, type Role } from '../../api';
import { useMe } from '../../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Toggle, generatePassword, useAction, useConfirm, useResource } from '../../components/ui';

export interface UserRow {
  id: number;
  login: string;
  displayName: string;
  role: Role;
  domain: string | null;
  hasMailbox: number;
  isEnabled: number;
  allowImap: number;
  allowPop3: number;
  allowSmtp: number;
  allowWebmail: number;
  quotaBytes: number | null;
  effectiveQuotaBytes: number | null;
  usedBytes: number;
  totpEnabled: number;
  lockedUntil: string | null;
  lastLoginAt: string | null;
  lastLoginIp: string | null;
}

interface UserList {
  items: UserRow[];
  total: number;
  licensed: { used: number; max: number | null };
}

export function useUserOptions() {
  return useResource(() => get<UserList>('/api/admin/users?pageSize=500').then((r) => r.items));
}

const GB = 1024 ** 3;

function rolesFor(actor: Role): Role[] {
  if (actor === 'super_admin') return ['user', 'admin', 'auditor', 'super_admin', 'vayrone_support'];
  return ['user', 'admin', 'auditor'];
}

function UserModal({ user, onClose, onSaved }: { user: UserRow | 'new'; onClose: () => void; onSaved: () => void }) {
  const me = useMe();
  const isNew = user === 'new';
  const u = isNew ? null : user;
  const [f, setF] = useState({
    email: '',
    displayName: u?.displayName ?? '',
    password: isNew ? generatePassword() : '',
    role: (u?.role ?? 'user') as Role,
    hasMailbox: u ? Boolean(u.hasMailbox) : true,
    quotaGb: u?.quotaBytes ? String(Math.round((u.quotaBytes / GB) * 10) / 10) : '',
    isEnabled: u ? Boolean(u.isEnabled) : true,
    allowImap: u ? Boolean(u.allowImap) : true,
    allowPop3: u ? Boolean(u.allowPop3) : true,
    allowSmtp: u ? Boolean(u.allowSmtp) : true,
    allowWebmail: u ? Boolean(u.allowWebmail) : true,
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const [ask, confirmNode] = useConfirm();
  const save = useAction(async () => {
    const quotaBytes = f.quotaGb ? Math.round(Number(f.quotaGb) * GB) : null;
    const common = {
      displayName: f.displayName,
      role: f.role,
      quotaBytes,
      isEnabled: f.isEnabled,
      allowImap: f.allowImap,
      allowPop3: f.allowPop3,
      allowSmtp: f.allowSmtp,
      allowWebmail: f.allowWebmail,
    };
    if (isNew) await post('/api/admin/users', { ...common, password: f.password, hasMailbox: f.hasMailbox, ...(f.hasMailbox ? { email: f.email } : { login: f.email }) });
    else await patch(`/api/admin/users/${u!.id}`, { ...common, ...(f.password ? { password: f.password } : {}) });
    onSaved();
  });
  const action = useAction(async (kind: 'unlock' | 'resetTotp' | 'logout' | 'delete') => {
    if (kind === 'delete') {
      if (!(await ask(`Delete ${u!.login} and ALL of their mail? This cannot be undone. Consider disabling the account instead.`, { confirmLabel: 'Delete user and mail' }))) return;
      await del(`/api/admin/users/${u!.id}`);
    } else if (kind === 'logout') await post(`/api/admin/users/${u!.id}/logout`);
    else await patch(`/api/admin/users/${u!.id}`, { [kind]: true });
    onSaved();
  });

  return (
    <Modal
      open
      wide
      title={isNew ? 'New user' : `Edit ${u!.login}`}
      onClose={onClose}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button busy={save.busy} onClick={() => void save.run()}>
            {isNew ? 'Create user' : 'Save changes'}
          </Button>
        </>
      }
    >
      {confirmNode}
      <ErrorBanner error={save.error ?? action.error} />
      <div className="grid gap-4 sm:grid-cols-2">
        {isNew ? (
          <Field label={f.hasMailbox ? 'Email address' : 'Login name'} hint={f.hasMailbox ? 'Must be in one of your mail domains.' : 'Staff login without a mailbox.'}>
            <Input value={f.email} onChange={(e) => set('email', e.target.value)} placeholder="name@company.com" />
          </Field>
        ) : (
          <Field label="Login">
            <Input value={u!.login} disabled />
          </Field>
        )}
        <Field label="Display name">
          <Input value={f.displayName} onChange={(e) => set('displayName', e.target.value)} />
        </Field>
        <Field label={isNew ? 'LAN password' : 'New LAN password'} hint={isNew ? 'Give this to the employee. It is not their provider password.' : 'Leave empty to keep the current password.'}>
          <div className="flex gap-2">
            <Input value={f.password} onChange={(e) => set('password', e.target.value)} className="font-mono" autoComplete="new-password" />
            <Button variant="secondary" onClick={() => set('password', generatePassword())}>
              Generate
            </Button>
          </div>
        </Field>
        <Field label="Role">
          <Select value={f.role} onChange={(e) => set('role', e.target.value as Role)} disabled={!isNew && u!.id === me.user.id}>
            {rolesFor(me.user.role).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABEL[r]}
              </option>
            ))}
          </Select>
        </Field>
        {(isNew ? f.hasMailbox : Boolean(u!.hasMailbox)) && (
          <Field label="Mailbox quota (GB)" hint="Leave empty to use the domain default.">
            <Input type="number" min={0} step={0.5} value={f.quotaGb} onChange={(e) => set('quotaGb', e.target.value)} />
          </Field>
        )}
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {isNew && <Toggle checked={f.hasMailbox} onChange={(v) => set('hasMailbox', v)} label="Has a mailbox (uses a licence seat)" />}
        <Toggle checked={f.isEnabled} onChange={(v) => set('isEnabled', v)} label="Account enabled" disabled={!isNew && u!.id === me.user.id} />
      </div>
      {(isNew ? f.hasMailbox : Boolean(u!.hasMailbox)) && (
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">Allowed access</legend>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Toggle checked={f.allowImap} onChange={(v) => set('allowImap', v)} label="IMAP" />
            <Toggle checked={f.allowPop3} onChange={(v) => set('allowPop3', v)} label="POP3" />
            <Toggle checked={f.allowSmtp} onChange={(v) => set('allowSmtp', v)} label="SMTP (send)" />
            <Toggle checked={f.allowWebmail} onChange={(v) => set('allowWebmail', v)} label="Webmail" />
          </div>
        </fieldset>
      )}
      {!isNew && (
        <div className="flex flex-wrap gap-2 border-t border-slate-100 pt-4">
          {u!.lockedUntil && new Date(u!.lockedUntil) > new Date() && (
            <Button variant="secondary" onClick={() => void action.run('unlock')}>
              Unlock account
            </Button>
          )}
          {Boolean(u!.totpEnabled) && (
            <Button variant="secondary" onClick={() => void action.run('resetTotp')}>
              Reset two-step verification
            </Button>
          )}
          <Button variant="secondary" onClick={() => void action.run('logout')}>
            Sign out everywhere
          </Button>
          {Boolean(u!.hasMailbox) && (
            <a href={`/admin/external?userId=${u!.id}`} className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-brand-700 ring-1 ring-slate-300 hover:bg-slate-50">
              External mailboxes
            </a>
          )}
          {Boolean(u!.hasMailbox) && (
            <a href={`/admin/users/${u!.id}/mail`} className="inline-flex items-center rounded-md px-3 py-1.5 text-sm font-medium text-brand-700 ring-1 ring-slate-300 hover:bg-slate-50">
              Forwarding, out of office & rules
            </a>
          )}
          {u!.id !== me.user.id && (
            <Button variant="danger" className="ml-auto" onClick={() => void action.run('delete')}>
              Delete user
            </Button>
          )}
        </div>
      )}
    </Modal>
  );
}

export function Users() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<UserRow | 'new' | null>(null);
  const list = useResource(() => get<UserList>(`/api/admin/users?pageSize=500&q=${encodeURIComponent(query)}`), [query]);
  const lic = list.data?.licensed;
  return (
    <div>
      <PageHeader
        title="Users"
        description={
          lic && (
            <>
              Licensed mailboxes in use: <span className="font-medium tabular">{lic.used}</span>
              {lic.max !== null && <span className="tabular"> of {lic.max}</span>}
            </>
          )
        }
        actions={<Button onClick={() => setEditing('new')}>New user</Button>}
      />
      <Card>
        <form
          className="mb-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setQuery(q);
          }}
        >
          <Input placeholder="Search name or email" value={q} onChange={(e) => setQ(e.target.value)} className="w-full sm:max-w-xs" />
          <Button type="submit" variant="secondary">
            Search
          </Button>
        </form>
        <ErrorBanner error={list.error} />
        {list.loading && !list.data ? (
          <Spinner />
        ) : (
          <Table head={['User', 'Role', 'Storage', 'Access', 'Last sign-in', 'Status']}>
            {(list.data?.items ?? []).map((u) => (
              <tr key={u.id} className="cursor-pointer hover:bg-slate-50" onClick={() => setEditing(u)}>
                <Td>
                  <div className="font-medium text-slate-900">{u.displayName}</div>
                  <div className="text-xs text-slate-500">{u.login}</div>
                </Td>
                <Td>{ROLE_LABEL[u.role]}</Td>
                <Td className="tabular">{u.hasMailbox ? `${formatBytes(u.usedBytes)} / ${u.effectiveQuotaBytes ? formatBytes(u.effectiveQuotaBytes) : '∞'}` : '—'}</Td>
                <Td>
                  {u.hasMailbox ? (
                    <div className="flex flex-wrap gap-1">
                      {u.allowImap ? <Badge>IMAP</Badge> : null}
                      {u.allowPop3 ? <Badge>POP3</Badge> : null}
                      {u.allowSmtp ? <Badge>SMTP</Badge> : null}
                      {u.allowWebmail ? <Badge>Web</Badge> : null}
                    </div>
                  ) : (
                    <Badge color="blue">Staff</Badge>
                  )}
                </Td>
                <Td>
                  <div>{formatDate(u.lastLoginAt)}</div>
                  {u.lastLoginIp && <div className="text-xs text-slate-500">{u.lastLoginIp}</div>}
                </Td>
                <Td>
                  <div className="flex flex-wrap gap-1">
                    {u.isEnabled ? <Badge color="green">Active</Badge> : <Badge color="red">Disabled</Badge>}
                    {u.lockedUntil && new Date(u.lockedUntil) > new Date() && <Badge color="amber">Locked</Badge>}
                    {u.totpEnabled ? <Badge color="blue">2FA</Badge> : null}
                  </div>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      {editing && (
        <UserModal
          user={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            list.reload();
          }}
        />
      )}
    </div>
  );
}
