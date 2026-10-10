import { useEffect, useState } from 'react';
import { del, formatDate, get, post, put } from '../../api';
import { useAuth, useMe } from '../../auth';
import { Badge, Button, Card, Empty, ErrorBanner, Field, Input, PageHeader, Spinner, Table, Td, Textarea, Toggle, useAction, useConfirm, useResource } from '../../components/ui';

// =================================================================== Sessions

interface SessionRow {
  handle: string;
  login: string;
  displayName: string;
  mode: string;
  ip: string;
  userAgent: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export function SessionsPage() {
  const list = useResource(() => get<SessionRow[]>('/api/admin/sessions'));
  const [ask, confirmNode] = useConfirm();
  return (
    <div>
      {confirmNode}
      <PageHeader title="Active sessions" description="Everyone currently signed in to the web panel." actions={<Button variant="secondary" onClick={list.reload}>Refresh</Button>} />
      <ErrorBanner error={list.error} />
      <Card>
        {!list.data?.length ? (
          <Empty>No active sessions.</Empty>
        ) : (
          <Table head={['User', 'IP address', 'Mode', 'Signed in', 'Last active', '']}>
            {list.data.map((s) => (
              <tr key={s.handle}>
                <Td>
                  <div className="font-medium">{s.displayName}</div>
                  <div className="text-xs text-slate-500">{s.login}</div>
                </Td>
                <Td className="font-mono">{s.ip}</Td>
                <Td className="capitalize">{s.mode}</Td>
                <Td>{formatDate(s.createdAt)}</Td>
                <Td>{formatDate(s.lastSeenAt)}</Td>
                <Td className="text-right">
                  <Button
                    variant="ghost"
                    onClick={async () => {
                      if (await ask(`Sign out ${s.login} from ${s.ip}?`, { confirmLabel: 'Sign out' })) {
                        await del(`/api/admin/sessions/${s.handle}`);
                        list.reload();
                      }
                    }}
                  >
                    Sign out
                  </Button>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </div>
  );
}

// =================================================================== Security

interface Policy {
  lockoutThreshold: number;
  lockoutMinutes: number;
  sessionIdleMinutes: number;
  sessionMaxHours: number;
  supportAccessEnabled: boolean;
  requireTotpForAdmins: boolean;
  supportLicensed: boolean;
}

interface IpRule {
  id: number;
  cidr: string;
  appliesTo: string[];
  description: string | null;
}

const SCOPES = [
  ['admin', 'Admin panel'],
  ['web', 'Webmail / sign-in'],
  ['imap', 'IMAP'],
  ['pop3', 'POP3'],
  ['smtp', 'SMTP'],
] as const;

export function SecurityPage() {
  const me = useMe();
  const isSuper = me.user.role === 'super_admin';
  const policy = useResource(() => get<Policy>('/api/admin/security/policy'));
  const ips = useResource(() => get<{ rules: IpRule[]; yourIp: string }>('/api/admin/security/ip-allowlist'));
  const [p, setP] = useState<Policy | null>(null);
  useEffect(() => setP(policy.data), [policy.data]);
  const [saved, setSaved] = useState(false);
  const savePolicy = useAction(async () => {
    const { supportLicensed, ...body } = p!;
    void supportLicensed;
    await put('/api/admin/security/policy', body);
    setSaved(true);
    policy.reload();
  });
  const [rule, setRule] = useState({ cidr: '', description: '', scopes: new Set<string>(['admin']) });
  const [ask, confirmNode] = useConfirm();
  const addRule = useAction(async (force = false) => {
    try {
      await post('/api/admin/security/ip-allowlist', { cidr: rule.cidr, description: rule.description || undefined, appliesTo: [...rule.scopes], force });
    } catch (e) {
      if ((e as { code?: string }).code === 'SELF_LOCKOUT' && (await ask(`${(e as Error).message}`, { confirmLabel: 'Add anyway' }))) {
        await post('/api/admin/security/ip-allowlist', { cidr: rule.cidr, description: rule.description || undefined, appliesTo: [...rule.scopes], force: true });
      } else throw e;
    }
    setRule({ cidr: '', description: '', scopes: new Set(['admin']) });
    ips.reload();
  });
  const num = (k: keyof Policy) => (
    <Input type="number" value={String(p?.[k] ?? '')} disabled={!isSuper} onChange={(e) => (setSaved(false), setP({ ...p!, [k]: Number(e.target.value) }))} />
  );

  return (
    <div>
      {confirmNode}
      <PageHeader title="Security" description={!isSuper ? 'Only a Super Admin can change these settings.' : undefined} />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Sign-in policy">
          {!p ? (
            <Spinner />
          ) : (
            <div className="space-y-4">
              <ErrorBanner error={savePolicy.error} />
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Lock account after failed attempts">{num('lockoutThreshold')}</Field>
                <Field label="Lock for (minutes)">{num('lockoutMinutes')}</Field>
                <Field label="Sign out after inactivity (minutes)">{num('sessionIdleMinutes')}</Field>
                <Field label="Maximum session length (hours)">{num('sessionMaxHours')}</Field>
              </div>
              <Toggle checked={p.requireTotpForAdmins} disabled={!isSuper} onChange={(v) => (setSaved(false), setP({ ...p, requireTotpForAdmins: v }))} label="Require two-step verification for admins" />
              <Toggle
                checked={p.supportAccessEnabled}
                disabled={!isSuper || !p.supportLicensed}
                onChange={(v) => (setSaved(false), setP({ ...p, supportAccessEnabled: v }))}
                label={
                  <span>
                    Allow Vayrone Support technician access
                    <span className="block text-xs text-slate-500">Every action they take is recorded in the audit log.{!p.supportLicensed && ' Not included in your licence.'}</span>
                  </span>
                }
              />
              {isSuper && (
                <div className="flex items-center gap-3">
                  <Button busy={savePolicy.busy} onClick={() => void savePolicy.run()}>
                    Save policy
                  </Button>
                  {saved && <span className="text-sm text-emerald-700">Saved</span>}
                </div>
              )}
            </div>
          )}
        </Card>
        <Card title="Network allowlist">
          <p className="mb-3 text-sm text-slate-600">
            Limit access to listed LAN addresses. A service with no rules is open to every address. The server itself (localhost) is always allowed. Your address: <span className="font-mono">{ips.data?.yourIp}</span>
          </p>
          <ErrorBanner error={ips.error ?? addRule.error} />
          {ips.data?.rules.length ? (
            <Table head={['Network', 'Applies to', '']}>
              {ips.data.rules.map((r) => (
                <tr key={r.id}>
                  <Td>
                    <div className="font-mono">{r.cidr}</div>
                    {r.description && <div className="text-xs text-slate-500">{r.description}</div>}
                  </Td>
                  <Td>
                    <div className="flex flex-wrap gap-1">
                      {r.appliesTo.map((s) => (
                        <Badge key={s}>{s}</Badge>
                      ))}
                    </div>
                  </Td>
                  <Td className="text-right">
                    {isSuper && (
                      <Button variant="ghost" onClick={() => void del(`/api/admin/security/ip-allowlist/${r.id}`).then(ips.reload)}>
                        Remove
                      </Button>
                    )}
                  </Td>
                </tr>
              ))}
            </Table>
          ) : (
            <p className="text-sm text-slate-500">No rules — all addresses are allowed.</p>
          )}
          {isSuper && (
            <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="IP address or range">
                  <Input value={rule.cidr} onChange={(e) => setRule({ ...rule, cidr: e.target.value })} placeholder="192.168.1.0/24" />
                </Field>
                <Field label="Description">
                  <Input value={rule.description} onChange={(e) => setRule({ ...rule, description: e.target.value })} placeholder="Office LAN" />
                </Field>
              </div>
              <div className="flex flex-wrap gap-3">
                {SCOPES.map(([k, label]) => (
                  <label key={k} className="flex items-center gap-1.5 text-sm">
                    <input
                      type="checkbox"
                      checked={rule.scopes.has(k)}
                      onChange={(e) => {
                        const s = new Set(rule.scopes);
                        if (e.target.checked) s.add(k);
                        else s.delete(k);
                        setRule({ ...rule, scopes: s });
                      }}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <Button disabled={!rule.cidr || !rule.scopes.size} busy={addRule.busy} onClick={() => void addRule.run()}>
                Add rule
              </Button>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

// =================================================================== Logs

interface AuditItem {
  id: number;
  at: string;
  actor: string | null;
  role: string | null;
  isSupport: number;
  ip: string | null;
  action: string;
  targetType: string | null;
  targetId: string | null;
  details: Record<string, unknown> | null;
}

export function LogsPage() {
  const [tab, setTab] = useState<'audit' | 'logins' | 'mail'>('audit');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const audit = useResource(() => (tab === 'audit' ? get<{ items: AuditItem[] }>(`/api/admin/audit?pageSize=200&action=${encodeURIComponent(query)}`) : Promise.resolve(null)), [tab, query]);
  const logins = useResource(() => (tab === 'logins' ? get<{ at: string; login: string; protocol: string; ip: string; success: number; reason: string | null }[]>('/api/admin/login-attempts?pageSize=200') : Promise.resolve(null)), [tab]);
  const mail = useResource(
    () =>
      tab === 'mail'
        ? get<{ at: string; event: string; direction: string | null; envelopeFrom: string | null; rcpt: string | null; subject: string | null; detail: string | null }[]>(
            `/api/admin/mail-log?pageSize=200&q=${encodeURIComponent(query)}`,
          )
        : Promise.resolve(null),
    [tab, query],
  );
  const [verify, setVerify] = useState<{ ok: boolean; count: number; brokenAt?: number } | null>(null);
  const check = useAction(async () => setVerify(await get('/api/admin/audit/verify')));

  return (
    <div>
      <PageHeader title="Logs & audit" />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {(
          [
            ['audit', 'Admin audit log'],
            ['logins', 'Sign-in attempts'],
            ['mail', 'Mail log'],
          ] as const
        ).map(([k, l]) => (
          <button
            key={k}
            onClick={() => (setTab(k), setQuery(''), setQ(''))}
            className={`rounded-md px-3 py-1.5 text-sm ${tab === k ? 'bg-brand-600 text-white' : 'bg-white text-slate-600 ring-1 ring-slate-200'}`}
          >
            {l}
          </button>
        ))}
        {tab !== 'logins' && (
          <form
            className="ml-auto flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setQuery(q);
            }}
          >
            <Input placeholder={tab === 'audit' ? 'Action, e.g. user.' : 'Address, subject, Message-ID'} value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" variant="secondary">
              Filter
            </Button>
          </form>
        )}
      </div>
      {tab === 'audit' && (
        <Card
          actions={
            <>
              {verify && (verify.ok ? <Badge color="green">Chain intact · {verify.count} entries</Badge> : <Badge color="red">Tampering detected at entry #{verify.brokenAt}</Badge>)}
              <Button variant="secondary" busy={check.busy} onClick={() => void check.run()}>
                Verify integrity
              </Button>
            </>
          }
          title="Every admin action, tamper-evident"
        >
          <ErrorBanner error={audit.error ?? check.error} />
          <Table head={['Time', 'Who', 'Action', 'Target', 'Details']}>
            {(audit.data?.items ?? []).map((a) => (
              <tr key={a.id}>
                <Td className="whitespace-nowrap">{formatDate(a.at)}</Td>
                <Td>
                  <div>{a.actor ?? 'system'}</div>
                  <div className="text-xs text-slate-500">
                    {a.ip} {a.isSupport ? <Badge color="amber">Vayrone Support</Badge> : null}
                  </div>
                </Td>
                <Td className="font-mono text-xs">{a.action}</Td>
                <Td className="text-xs">{a.targetType ? `${a.targetType} ${a.targetId ?? ''}` : '—'}</Td>
                <Td className="max-w-md truncate font-mono text-xs" title={a.details ? JSON.stringify(a.details) : ''}>
                  {a.details ? JSON.stringify(a.details) : ''}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {tab === 'logins' && (
        <Card>
          <ErrorBanner error={logins.error} />
          <Table head={['Time', 'Login', 'Protocol', 'IP address', 'Result']}>
            {(logins.data ?? []).map((l, i) => (
              <tr key={i}>
                <Td className="whitespace-nowrap">{formatDate(l.at)}</Td>
                <Td>{l.login}</Td>
                <Td className="uppercase">{l.protocol}</Td>
                <Td className="font-mono">{l.ip}</Td>
                <Td>{l.success ? <Badge color="green">OK</Badge> : <Badge color="red">{l.reason ?? 'failed'}</Badge>}</Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
      {tab === 'mail' && (
        <Card>
          <ErrorBanner error={mail.error} />
          <Table head={['Time', 'Event', 'From', 'To', 'Subject', 'Detail']}>
            {(mail.data ?? []).map((m, i) => (
              <tr key={i}>
                <Td className="whitespace-nowrap">{formatDate(m.at)}</Td>
                <Td>
                  <Badge color={m.event === 'delivered' || m.event === 'relayed' ? 'green' : m.event === 'bounced' || m.event === 'failed' ? 'red' : m.event === 'deferred' ? 'amber' : 'slate'}>{m.event}</Badge>
                </Td>
                <Td className="max-w-[12rem] truncate">{m.envelopeFrom}</Td>
                <Td className="max-w-[12rem] truncate">{m.rcpt}</Td>
                <Td className="max-w-[14rem] truncate">{m.subject}</Td>
                <Td className="max-w-xs truncate text-xs" title={m.detail ?? ''}>
                  {m.detail}
                </Td>
              </tr>
            ))}
          </Table>
        </Card>
      )}
    </div>
  );
}

// =================================================================== Company

interface Company {
  companyName: string;
  address: string | null;
  gstin: string | null;
  contactPerson: string | null;
  phone: string | null;
  email: string | null;
  logoPath?: string | null;
}

function LogoCard({ hasLogo, canEdit, onChanged }: { hasLogo: boolean; canEdit: boolean; onChanged: () => void }) {
  const { refreshBranding } = useAuth();
  const [v, setV] = useState(0);
  const upload = useAction(async (logo: string | null) => {
    await put('/api/admin/company/logo', { logo });
    setV((x) => x + 1);
    onChanged();
    await refreshBranding();
  });
  return (
    <Card title="Logo" className="mt-4">
      <ErrorBanner error={upload.error} />
      <div className="flex items-center gap-4">
        {hasLogo ? <img src={`/api/public/logo?v=${v}`} alt="Company logo" className="h-16 w-16 rounded bg-white object-contain ring-1 ring-slate-200" /> : <div className="flex h-16 w-16 items-center justify-center rounded bg-slate-100 text-xs text-slate-400">no logo</div>}
        {canEdit && (
          <div className="space-y-2">
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp"
              className="block text-sm"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                if (file.size > 512 * 1024) return upload.setError(new Error('The logo is larger than 512 KB'));
                const r = new FileReader();
                r.onload = () => void upload.run(String(r.result));
                r.readAsDataURL(file);
              }}
            />
            <p className="text-xs text-slate-500">PNG, JPEG or WebP, up to 512 KB.</p>
            {hasLogo && (
              <Button variant="ghost" busy={upload.busy} onClick={() => void upload.run(null)}>
                Remove logo
              </Button>
            )}
          </div>
        )}
      </div>
    </Card>
  );
}

export function CompanyPage() {
  const me = useMe();
  const isSuper = me.user.role === 'super_admin';
  const c = useResource(() => get<Company | null>('/api/admin/company'));
  const [f, setF] = useState<Company>({ companyName: '', address: '', gstin: '', contactPerson: '', phone: '', email: '' });
  useEffect(() => {
    if (c.data) setF({ ...c.data, address: c.data.address ?? '', gstin: c.data.gstin ?? '', contactPerson: c.data.contactPerson ?? '', phone: c.data.phone ?? '', email: c.data.email ?? '' });
  }, [c.data]);
  const [saved, setSaved] = useState(false);
  const save = useAction(async () => {
    await put('/api/admin/company', f);
    setSaved(true);
  });
  const field = (k: keyof Company, label: string) => (
    <Field label={label}>
      <Input value={f[k] ?? ''} disabled={!isSuper} onChange={(e) => (setSaved(false), setF({ ...f, [k]: e.target.value }))} />
    </Field>
  );
  return (
    <div className="max-w-2xl">
      <PageHeader title="Company" description="Shown on the sign-in page and in the top bar. Also included in licence activation." />
      <Card>
        <div className="space-y-4">
          <ErrorBanner error={c.error ?? save.error} />
          {field('companyName', 'Company name')}
          <Field label="Address">
            <Textarea className="font-sans" rows={3} value={f.address ?? ''} disabled={!isSuper} onChange={(e) => setF({ ...f, address: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            {field('gstin', 'GSTIN')}
            {field('contactPerson', 'Contact person')}
            {field('phone', 'Phone')}
            {field('email', 'Email')}
          </div>
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
      {c.data && <LogoCard hasLogo={Boolean(c.data.logoPath)} canEdit={isSuper} onChanged={c.reload} />}
    </div>
  );
}
