import { useEffect, useState } from 'react';
import { get, patch, post, put, when } from '../api';
import { Badge, Button, Card, ErrorBanner, Field, Input, Modal, PageHeader, Select, Spinner, Table, Td, Textarea, Toggle, generatePassword, useAction, useResource } from '../ui';

interface Settings {
  smtp: { host: string; port: number; secure: boolean; user: string | null; from: string; passwordSet: boolean } | null;
  whatsapp: {
    provider: 'off' | 'meta' | 'webhook';
    meta: { phoneNumberId: string; language: string; templates: { expiry: string; amc: string }; tokenSet: boolean } | null;
    webhook: { url: string; authHeaderSet: boolean } | null;
  };
  notifications: { salesEmail: string | null; expiryDays: number[]; amcDays: number[]; supportPhone: string };
  signing: { kid: string; publicKey: string };
}

export function SettingsPage() {
  const s = useResource(() => get<Settings>('/api/settings'));
  if (!s.data) return s.error ? <ErrorBanner error={s.error} /> : <Spinner />;
  return (
    <>
      <PageHeader title="Settings" />
      <div className="grid gap-4 xl:grid-cols-2">
        <EmailCard s={s.data} onSaved={s.reload} />
        <WhatsAppCard s={s.data} onSaved={s.reload} />
        <RemindersCard s={s.data} onSaved={s.reload} />
        <Card title="Licence signing key">
          <p className="mb-2 text-sm text-slate-600">
            Key id <span className="font-mono">{s.data.signing.kid}</span>. PostMaster builds embed this public key (<span className="font-mono">scripts/license-keygen.mjs</span>). The private key stays on this server and is never shown.
          </p>
          <Textarea readOnly rows={4} className="font-mono text-xs" value={s.data.signing.publicKey} />
        </Card>
      </div>
      <Logins />
      <ReminderLog />
    </>
  );
}

function EmailCard({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const [f, setF] = useState({ host: s.smtp?.host ?? '', port: String(s.smtp?.port ?? 465), secure: s.smtp?.secure ?? true, user: s.smtp?.user ?? '', password: '', from: s.smtp?.from ?? 'Vayrone Infratech <licensing@vayrone.com>' });
  const [to, setTo] = useState('');
  const save = useAction(async () => {
    await put('/api/settings/smtp', { ...f, port: Number(f.port), password: f.password || null });
    setF({ ...f, password: '' });
    onSaved();
  });
  const test = useAction(() => post('/api/settings/test-email', { to }));
  return (
    <Card title="Email (SMTP)">
      <ErrorBanner error={save.error ?? test.error} />
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="Server">
          <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} placeholder="smtp.zoho.in" />
        </Field>
        <Field label="Port">
          <Input value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />
        </Field>
        <Field label="Username">
          <Input value={f.user} onChange={(e) => setF({ ...f, user: e.target.value })} />
        </Field>
        <Field label="Password" hint={s.smtp?.passwordSet ? 'Stored. Leave empty to keep it.' : undefined}>
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </Field>
      </div>
      <Field label="From">
        <Input value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} />
      </Field>
      <Toggle checked={f.secure} onChange={(v) => setF({ ...f, secure: v })} label="Implicit TLS (port 465); off = STARTTLS" />
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Input className="w-56" placeholder="test@vayrone.com" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant="secondary" busy={test.busy} disabled={!to} onClick={() => void test.run()}>
            Send test
          </Button>
        </div>
        <Button busy={save.busy} onClick={() => void save.run()}>
          Save
        </Button>
      </div>
    </Card>
  );
}

function WhatsAppCard({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const w = s.whatsapp;
  const [f, setF] = useState({
    provider: w.provider,
    phoneNumberId: w.meta?.phoneNumberId ?? '',
    token: '',
    language: w.meta?.language ?? 'en',
    expiry: w.meta?.templates.expiry ?? 'licence_expiry',
    amc: w.meta?.templates.amc ?? 'amc_expiry',
    url: w.webhook?.url ?? '',
    authHeader: '',
  });
  const [to, setTo] = useState('');
  const save = useAction(async () => {
    await put('/api/settings/whatsapp', {
      provider: f.provider,
      meta: f.provider === 'meta' ? { phoneNumberId: f.phoneNumberId, token: f.token || null, language: f.language, templates: { expiry: f.expiry, amc: f.amc } } : null,
      webhook: f.provider === 'webhook' ? { url: f.url, authHeader: f.authHeader || null } : null,
    });
    onSaved();
  });
  const test = useAction(() => post('/api/settings/test-whatsapp', { to }));
  return (
    <Card title="WhatsApp reminders">
      <ErrorBanner error={save.error ?? test.error} />
      <Field label="Provider">
        <Select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value as typeof f.provider })}>
          <option value="off">Off</option>
          <option value="meta">WhatsApp Cloud API (Meta)</option>
          <option value="webhook">Other provider (webhook: Gupshup, Interakt, AiSensy…)</option>
        </Select>
      </Field>
      {f.provider === 'meta' && (
        <>
          <div className="grid grid-cols-2 gap-x-3">
            <Field label="Phone number ID">
              <Input value={f.phoneNumberId} onChange={(e) => setF({ ...f, phoneNumberId: e.target.value })} />
            </Field>
            <Field label="Access token" hint={w.meta?.tokenSet ? 'Stored. Leave empty to keep it.' : undefined}>
              <Input type="password" value={f.token} onChange={(e) => setF({ ...f, token: e.target.value })} autoComplete="new-password" />
            </Field>
            <Field label="Expiry template name" hint="Approved template with 5 body parameters: name, licence, date, days, contact">
              <Input value={f.expiry} onChange={(e) => setF({ ...f, expiry: e.target.value })} />
            </Field>
            <Field label="AMC template name">
              <Input value={f.amc} onChange={(e) => setF({ ...f, amc: e.target.value })} />
            </Field>
            <Field label="Template language">
              <Input value={f.language} onChange={(e) => setF({ ...f, language: e.target.value })} />
            </Field>
          </div>
        </>
      )}
      {f.provider === 'webhook' && (
        <>
          <Field label="Webhook URL" hint='Receives POST {"to","template","params","text"}'>
            <Input value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} />
          </Field>
          <Field label="Authorization header" hint={w.webhook?.authHeaderSet ? 'Stored. Leave empty to keep it.' : undefined}>
            <Input type="password" value={f.authHeader} onChange={(e) => setF({ ...f, authHeader: e.target.value })} autoComplete="new-password" />
          </Field>
        </>
      )}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-2">
          <Input className="w-44" placeholder="98765 43210" value={to} onChange={(e) => setTo(e.target.value)} />
          <Button variant="secondary" busy={test.busy} disabled={!to || w.provider === 'off'} onClick={() => void test.run()}>
            Send test
          </Button>
        </div>
        <Button busy={save.busy} onClick={() => void save.run()}>
          Save
        </Button>
      </div>
    </Card>
  );
}

function RemindersCard({ s, onSaved }: { s: Settings; onSaved: () => void }) {
  const n = s.notifications;
  const [f, setF] = useState({ salesEmail: n.salesEmail ?? '', expiryDays: n.expiryDays.join(', '), amcDays: n.amcDays.join(', '), supportPhone: n.supportPhone });
  const [result, setResult] = useState<string | null>(null);
  const nums = (v: string) => v.split(/[\s,]+/).filter(Boolean).map(Number);
  const save = useAction(async () => {
    await put('/api/settings/notifications', { salesEmail: f.salesEmail, expiryDays: nums(f.expiryDays), amcDays: nums(f.amcDays), supportPhone: f.supportPhone });
    onSaved();
  });
  const run = useAction(async () => {
    const r = await post<{ sent: number; failed: number; skipped: number }>('/api/settings/run-reminders');
    setResult(`${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped`);
  });
  return (
    <Card title="Renewal reminders">
      <ErrorBanner error={save.error ?? run.error} />
      <p className="mb-2 text-sm text-slate-600">Sent every morning at 9:30 IST to the client (partner in copy), by email and WhatsApp.</p>
      <Field label="Licence expiry: days before" hint="Negative numbers remind during the grace period after expiry">
        <Input value={f.expiryDays} onChange={(e) => setF({ ...f, expiryDays: e.target.value })} />
      </Field>
      <Field label="AMC expiry: days before">
        <Input value={f.amcDays} onChange={(e) => setF({ ...f, amcDays: e.target.value })} />
      </Field>
      <div className="grid grid-cols-2 gap-x-3">
        <Field label="Daily digest to (Vayrone sales)">
          <Input value={f.salesEmail} onChange={(e) => setF({ ...f, salesEmail: e.target.value })} />
        </Field>
        <Field label="Support phone in messages">
          <Input value={f.supportPhone} onChange={(e) => setF({ ...f, supportPhone: e.target.value })} />
        </Field>
      </div>
      <div className="mt-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Button variant="secondary" busy={run.busy} onClick={() => void run.run()}>
            Send due reminders now
          </Button>
          {result && <span className="text-sm text-slate-600">{result}</span>}
        </div>
        <Button busy={save.busy} onClick={() => void save.run()}>
          Save
        </Button>
      </div>
    </Card>
  );
}

interface Login {
  id: number;
  email: string;
  name: string;
  role: 'owner' | 'staff' | 'reseller';
  resellerName: string | null;
  isEnabled: boolean;
  lastLoginAt: string | null;
}

function Logins() {
  const list = useResource(() => get<Login[]>('/api/staff'));
  const partners = useResource(() => get<{ id: number; name: string }[]>('/api/resellers'));
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ email: '', name: '', role: 'staff', resellerId: '', password: '' });
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (adding) setF((x) => ({ ...x, password: generatePassword(14) }));
  }, [adding]);
  const add = useAction(async () => {
    await post('/api/staff', { ...f, resellerId: f.resellerId ? Number(f.resellerId) : null });
    setShown(`${f.email} / ${f.password}`);
    setAdding(false);
    list.reload();
  });
  const toggle = useAction(async (u: Login) => {
    await patch(`/api/staff/${u.id}`, { isEnabled: !u.isEnabled });
    list.reload();
  });
  const reset = useAction(async (u: Login) => {
    const pw = generatePassword(14);
    await patch(`/api/staff/${u.id}`, { password: pw });
    setShown(`${u.email} / ${pw}`);
  });
  return (
    <Card title="Logins" className="mt-4" actions={<Button onClick={() => setAdding(true)}>Add login</Button>}>
      <ErrorBanner error={list.error ?? toggle.error ?? reset.error} />
      {shown && (
        <div className="mb-3 rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-900 ring-1 ring-emerald-200">
          Give these sign-in details to the person (shown once): <span className="font-mono">{shown}</span>
        </div>
      )}
      <Table head={['Name', 'Email', 'Role', 'Last sign-in', '']}>
        {list.data?.map((u) => (
          <tr key={u.id}>
            <Td>
              {u.name} {!u.isEnabled && <Badge color="red">disabled</Badge>}
            </Td>
            <Td>{u.email}</Td>
            <Td>{u.role === 'reseller' ? `partner — ${u.resellerName}` : u.role}</Td>
            <Td className="text-xs">{when(u.lastLoginAt)}</Td>
            <Td>
              <Button variant="ghost" onClick={() => void reset.run(u)}>
                Reset password
              </Button>
              <Button variant="ghost" onClick={() => void toggle.run(u)}>
                {u.isEnabled ? 'Disable' : 'Enable'}
              </Button>
            </Td>
          </tr>
        ))}
      </Table>
      {adding && (
        <Modal
          open
          title="Add login"
          onClose={() => setAdding(false)}
          footer={
            <Button busy={add.busy} onClick={() => void add.run()}>
              Create
            </Button>
          }
        >
          <ErrorBanner error={add.error} />
          <Field label="Name">
            <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          </Field>
          <Field label="Email">
            <Input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </Field>
          <Field label="Role">
            <Select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
              <option value="staff">Vayrone staff (sales / support)</option>
              <option value="owner">Owner (everything)</option>
              <option value="reseller">Partner</option>
            </Select>
          </Field>
          {f.role === 'reseller' && (
            <Field label="Partner">
              <Select value={f.resellerId} onChange={(e) => setF({ ...f, resellerId: e.target.value })}>
                <option value="">Choose…</option>
                {partners.data?.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Initial password">
            <Input value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} className="font-mono" />
          </Field>
        </Modal>
      )}
    </Card>
  );
}

function ReminderLog() {
  const list = useResource(() => get<{ id: number; kind: string; dueDate: string; daysBefore: number; channel: string; recipient: string | null; status: string; error: string | null; sentAt: string; licenseId: string; company: string }[]>('/api/reminders'));
  if (!list.data?.length) return null;
  return (
    <Card title="Recent reminders" className="mt-4">
      <Table head={['Sent', 'Licence', 'Client', 'Type', 'Channel', 'Status']}>
        {list.data.map((r) => (
          <tr key={r.id}>
            <Td className="text-xs">{when(r.sentAt)}</Td>
            <Td className="font-mono text-xs">{r.licenseId}</Td>
            <Td>{r.company}</Td>
            <Td>
              {r.kind} {r.daysBefore >= 0 ? `${r.daysBefore}d before` : `${-r.daysBefore}d after`}
            </Td>
            <Td>
              {r.channel} <span className="text-xs text-slate-500">{r.recipient}</span>
            </Td>
            <Td>
              <Badge color={r.status === 'sent' ? 'green' : r.status === 'failed' ? 'red' : 'slate'}>{r.status}</Badge>
              {r.error && <div className="text-xs text-slate-500">{r.error}</div>}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}
