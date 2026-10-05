import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { del, get, patch, post, put } from '../../api';
import { useMe } from '../../auth';
import { AutoReplyCard, ForwardingCard, RuleList } from '../../components/RuleEditor';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Toggle, useAction, useConfirm, useResource } from '../../components/ui';
import { useUserOptions } from './Users';

interface Policy {
  allowUserExternalForwarding: boolean;
  rewriteFromOnExternalForward: boolean;
  timezone: string;
}

function PolicyCard() {
  const me = useMe();
  const isSuper = me.user.role === 'super_admin';
  const p = useResource(() => get<Policy>('/api/admin/mail-policy'));
  const [f, setF] = useState<Policy | null>(null);
  useEffect(() => setF(p.data), [p.data]);
  const [saved, setSaved] = useState(false);
  const save = useAction(async () => {
    await put('/api/admin/mail-policy', f);
    setSaved(true);
  });
  if (!f) return <Spinner />;
  return (
    <Card title="Forwarding policy">
      <div className="space-y-3">
        <ErrorBanner error={p.error ?? save.error} />
        <Toggle
          checked={f.allowUserExternalForwarding}
          disabled={!isSuper}
          onChange={(v) => (setSaved(false), setF({ ...f, allowUserExternalForwarding: v }))}
          label={
            <span>
              Employees may forward mail outside the company
              <span className="block text-xs text-slate-500">Off by default to prevent data leaks. Admin-configured forwarding is always allowed.</span>
            </span>
          }
        />
        <Toggle
          checked={f.rewriteFromOnExternalForward}
          disabled={!isSuper}
          onChange={(v) => (setSaved(false), setF({ ...f, rewriteFromOnExternalForward: v }))}
          label={
            <span>
              Rewrite the sender on forwarded outside mail ("Client via Ravi")
              <span className="block text-xs text-slate-500">Needed for providers that check SPF/DMARC; replies still go to the original sender.</span>
            </span>
          }
        />
        <Field label="Time zone for time-of-day rules">
          <Input value={f.timezone} disabled={!isSuper} onChange={(e) => (setSaved(false), setF({ ...f, timezone: e.target.value }))} />
        </Field>
        {isSuper && (
          <div className="flex items-center gap-3">
            <Button busy={save.busy} onClick={() => void save.run()}>
              Save
            </Button>
            {saved && <span className="text-sm text-emerald-700">Saved</span>}
          </div>
        )}
      </div>
    </Card>
  );
}

export function MailRulesPage() {
  return (
    <div>
      <PageHeader title="Mail rules" description="Company-wide rules run first, in this order, before each employee's personal rules. Changes take effect within 10 seconds." />
      <div className="grid gap-5 xl:grid-cols-3">
        <div className="xl:col-span-2">
          <RuleList base="/api/admin" allowOutbound title="Company rules" description="Drag rules to change their order." />
        </div>
        <PolicyCard />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- journaling

interface Journal {
  id: number;
  name: string;
  direction: 'in' | 'out' | 'both';
  scope: 'all' | 'domain' | 'group' | 'user';
  scopeId: number | null;
  includeInternal: boolean;
  matchMode: 'all' | 'any';
  conditions: unknown[];
  targetAddress: string;
  isEnabled: boolean;
  hitCount: number;
}

const DIR_LABEL = { in: 'Received mail', out: 'Sent mail', both: 'Sent and received' };

export function JournalPage() {
  const list = useResource(() => get<Journal[]>('/api/admin/journal-rules'));
  const users = useUserOptions();
  const domains = useResource(() => get<{ id: number; name: string }[]>('/api/admin/domains'));
  const groups = useResource(() => get<{ id: number; name: string }[]>('/api/admin/groups'));
  const [editing, setEditing] = useState<Journal | 'new' | null>(null);
  const empty = { name: '', direction: 'both' as Journal['direction'], scope: 'all' as Journal['scope'], scopeId: '', includeInternal: true, targetAddress: '', isEnabled: true, subjectContains: '' };
  const [f, setF] = useState(empty);
  const [ask, confirmNode] = useConfirm();
  const open = (j: Journal | 'new') => {
    setEditing(j);
    const sc = j === 'new' ? null : (j.conditions.find((c) => (c as { field: string }).field === 'subject') as { value: string } | undefined);
    setF(j === 'new' ? empty : { name: j.name, direction: j.direction, scope: j.scope, scopeId: String(j.scopeId ?? ''), includeInternal: j.includeInternal, targetAddress: j.targetAddress, isEnabled: j.isEnabled, subjectContains: sc?.value ?? '' });
  };
  const save = useAction(async () => {
    const body = {
      name: f.name,
      direction: f.direction,
      scope: f.scope,
      scopeId: f.scope === 'all' ? null : Number(f.scopeId),
      includeInternal: f.includeInternal,
      targetAddress: f.targetAddress,
      isEnabled: f.isEnabled,
      conditions: f.subjectContains ? [{ field: 'subject', op: 'contains', value: f.subjectContains }] : [],
    };
    if (editing === 'new') await post('/api/admin/journal-rules', body);
    else await patch(`/api/admin/journal-rules/${(editing as Journal).id}`, body);
    setEditing(null);
    list.reload();
  });
  const scopeName = (j: Journal) =>
    j.scope === 'all'
      ? 'Everyone'
      : j.scope === 'domain'
        ? (domains.data?.find((d) => d.id === j.scopeId)?.name ?? `domain ${j.scopeId}`)
        : j.scope === 'group'
          ? `Group: ${groups.data?.find((g) => g.id === j.scopeId)?.name ?? j.scopeId}`
          : (users.data?.find((u) => u.id === j.scopeId)?.login ?? `user ${j.scopeId}`);

  return (
    <div>
      {confirmNode}
      <PageHeader
        title="Journaling (BCC copies)"
        description="Send a copy of all or selected mail to another address, e.g. a compliance mailbox. Copies are marked with X-VPM-Journal headers listing the real recipients."
        actions={<Button onClick={() => open('new')}>New journal rule</Button>}
      />
      <ErrorBanner error={list.error} />
      <Card>
        {!list.data ? (
          <Spinner />
        ) : !list.data.length ? (
          <Empty>No journal rules.</Empty>
        ) : (
          <Table head={['Rule', 'Mail', 'Whose mail', 'Copy to', 'Copies sent', '']}>
            {list.data.map((j) => (
              <tr key={j.id}>
                <Td>
                  <span className="font-medium">{j.name}</span> {!j.isEnabled && <Badge>off</Badge>}
                  {j.conditions.length > 0 && <div className="text-xs text-slate-500">Selected mail only</div>}
                </Td>
                <Td>
                  {DIR_LABEL[j.direction]}
                  {j.includeInternal && <div className="text-xs text-slate-500">incl. internal</div>}
                </Td>
                <Td>{scopeName(j)}</Td>
                <Td>{j.targetAddress}</Td>
                <Td className="tabular">{j.hitCount}</Td>
                <Td className="whitespace-nowrap text-right">
                  <Button variant="ghost" onClick={() => open(j)}>
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (await ask(`Delete journal rule "${j.name}"?`, { confirmLabel: 'Delete' })) {
                        await del(`/api/admin/journal-rules/${j.id}`);
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
        title={editing === 'new' ? 'New journal rule' : 'Edit journal rule'}
        onClose={() => setEditing(null)}
        footer={
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        }
      >
        <ErrorBanner error={save.error} />
        <Field label="Name">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Compliance copy of all mail" />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Which mail">
            <Select value={f.direction} onChange={(e) => setF({ ...f, direction: e.target.value as 'both' })}>
              {Object.entries(DIR_LABEL).map(([k, v]) => (
                <option key={k} value={k}>
                  {v}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Whose mail">
            <Select value={f.scope} onChange={(e) => setF({ ...f, scope: e.target.value as 'all', scopeId: '' })}>
              <option value="all">Everyone</option>
              <option value="domain">A domain</option>
              <option value="group">A group</option>
              <option value="user">One user</option>
            </Select>
          </Field>
        </div>
        {f.scope !== 'all' && (
          <Field label={f.scope === 'domain' ? 'Domain' : f.scope === 'group' ? 'Group' : 'User'}>
            <Select value={f.scopeId} onChange={(e) => setF({ ...f, scopeId: e.target.value })}>
              <option value="">Choose…</option>
              {(f.scope === 'domain' ? (domains.data ?? []).map((d) => [d.id, d.name]) : f.scope === 'group' ? (groups.data ?? []).map((g) => [g.id, g.name]) : (users.data ?? []).filter((u) => u.hasMailbox).map((u) => [u.id, u.login])).map(
                ([id, name]) => (
                  <option key={id} value={id}>
                    {name}
                  </option>
                ),
              )}
            </Select>
          </Field>
        )}
        <Field label="Only when the subject contains (optional)" hint="Leave empty to copy all matching mail.">
          <Input value={f.subjectContains} onChange={(e) => setF({ ...f, subjectContains: e.target.value })} />
        </Field>
        <Field label="Send copies to">
          <Input value={f.targetAddress} onChange={(e) => setF({ ...f, targetAddress: e.target.value })} placeholder="compliance@company.com" />
        </Field>
        <Toggle checked={f.includeInternal} onChange={(v) => setF({ ...f, includeInternal: v })} label="Include mail between colleagues" />
        <Toggle checked={f.isEnabled} onChange={(v) => setF({ ...f, isEnabled: v })} label="Enabled" />
      </Modal>
    </div>
  );
}

// ---------------------------------------------------------------- one user's mail settings

export function UserMailSettingsPage() {
  const { id } = useParams();
  const userId = Number(id);
  const u = useResource(() => get<{ login: string; displayName: string }>(`/api/admin/users/${userId}`), [userId]);
  return (
    <div>
      <PageHeader title={u.data ? `Mail settings — ${u.data.displayName}` : 'Mail settings'} description={u.data?.login} />
      <div className="grid gap-5 lg:grid-cols-2">
        <ForwardingCard url={`/api/admin/users/${userId}/forwarding`} />
        <AutoReplyCard url={`/api/admin/users/${userId}/autoreply`} />
        <div className="lg:col-span-2">
          <RuleList base="/api/admin" userId={userId} title="Personal rules" description="These run after the company rules." />
        </div>
      </div>
    </div>
  );
}
