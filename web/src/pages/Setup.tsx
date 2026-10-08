// First-run setup wizard (/setup). Talks to /api/setup with the setup token
// from the installer (?token=…), kept in sessionStorage for this tab.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError, formatBytes } from '../api';
import { Badge, Button, Card, ErrorBanner, Field, Input, Select, Spinner, Textarea, Toggle, generatePassword, useAction } from '../components/ui';
import { LicenseDetails, type LicenseDetailsData } from '../components/LicenseDetails';

const TOKEN_KEY = 'vpm_setup_token';

function token(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

async function setupApi<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  const t = token();
  if (t) headers['x-vpm-setup'] = t;
  const res = await fetch(`/api/setup${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) throw new ApiError(res.status, String(data.error ?? 'ERROR'), String(data.message ?? res.statusText));
  return data as T;
}

interface LicenseInfo {
  status: string;
  mode: string;
  reason: string;
  license: LicenseDetailsData | null;
  machine: { id: string };
}

interface SetupState {
  steps: string[];
  restartNeeded: boolean;
  license: LicenseInfo | null;
  company: { companyName: string; address: string | null; gstin: string | null; contactPerson: string | null; phone: string | null; email: string | null; logoPath: string | null } | null;
  domains: string[];
  admin: { id: number; login: string; displayName: string; hasMailbox: number } | null;
  relay: { host: string; port: number; security: 'none' | 'starttls' | 'tls'; authUser: string | null; passwordSet: number; lastTestResult: string | null } | null;
  network: {
    hostname: string;
    listenHost: string;
    ports: { submission: number; smtps: number; imap: number; imaps: number; pop3: number; pop3s: number };
    webPort: number;
    addresses: string[];
    tls: { subject: string; issuer: string; validTo: string; selfSigned: boolean; names: string[]; custom: boolean } | null;
  };
  storage: {
    dataPath: string;
    freeBytes: number | null;
    totalBytes: number | null;
    backupPath: string | null;
    archiveEnabled: boolean;
    archiveDays: number | null;
    archiveLicensed: boolean;
    trashDays: number | null;
    /** PostMaster start date; absent = not chosen yet, null = all mail at the provider. */
    fetchStartAt?: string | null;
  };
}

const STEPS = [
  { id: 'license', label: 'Licence' },
  { id: 'company', label: 'Company' },
  { id: 'domains', label: 'Mail domains' },
  { id: 'admin', label: 'Super admin' },
  { id: 'relay', label: 'Outgoing mail (relay)' },
  { id: 'network', label: 'Network and TLS' },
  { id: 'storage', label: 'Storage and backup' },
  { id: 'summary', label: 'Summary' },
] as const;
type StepId = (typeof STEPS)[number]['id'];

function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function readFile(f: File, as: 'text' | 'dataUrl'): Promise<string> {
  return new Promise((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result));
    r.onerror = () => fail(r.error);
    if (as === 'text') r.readAsText(f);
    else r.readAsDataURL(f);
  });
}

function StepFooter({ busy, onSave, onSkip, saveLabel = 'Save and continue', disabled }: { busy: boolean; onSave: () => void; onSkip?: () => void; saveLabel?: string; disabled?: boolean }) {
  return (
    <div className="mt-5 flex items-center justify-end gap-2 border-t border-slate-100 pt-4">
      {onSkip && (
        <Button variant="ghost" onClick={onSkip}>
          Skip for now
        </Button>
      )}
      <Button busy={busy} disabled={disabled} onClick={onSave}>
        {saveLabel}
      </Button>
    </div>
  );
}

// ================================================================ wizard

export function SetupWizard() {
  const [status, setStatus] = useState<{ required: boolean; needsToken: boolean; version: string } | null>(null);
  const [state, setState] = useState<SetupState | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [step, setStep] = useState<StepId>('license');
  const [authorized, setAuthorized] = useState(false);

  const load = async () => {
    try {
      const s = await setupApi<SetupState>('GET', '/state');
      setState(s);
      setAuthorized(true);
      return s;
    } catch (e) {
      if (e instanceof ApiError && e.code === 'SETUP_TOKEN') setAuthorized(false);
      else setError(e);
      return null;
    }
  };

  useEffect(() => {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('token');
    if (t) {
      try {
        sessionStorage.setItem(TOKEN_KEY, t);
      } catch {
        /* private mode: the token stays in the URL */
      }
      url.searchParams.delete('token');
      window.history.replaceState(null, '', `/setup${url.search}`);
    } else if (window.location.pathname !== '/setup') window.history.replaceState(null, '', '/setup');
    void (async () => {
      setStatus(await setupApi('GET', '/status'));
      const s = await load();
      if (s) {
        const first = STEPS.find((x) => x.id !== 'summary' && !s.steps.includes(x.id));
        setStep(first?.id ?? 'summary');
      }
    })().catch(setError);
  }, []);

  if (error && !state) return <ErrorBanner error={error} />;
  if (!status) return <Spinner />;
  if (!authorized) return <TokenScreen onOk={() => void load()} />;
  if (!state) return <Spinner />;

  const done = (id: string) => state.steps.includes(id);
  const next = async (current: StepId) => {
    await load();
    const i = STEPS.findIndex((s) => s.id === current);
    setStep(STEPS[Math.min(i + 1, STEPS.length - 1)]!.id);
  };

  return (
    <div className="min-h-full bg-slate-50">
      <header className="flex items-center gap-3 bg-brand-900 px-6 py-4 text-white">
        <img src="/favicon.svg" alt="" className="h-10 w-10" />
        <div>
          <div className="text-lg font-semibold">Vayrone PostMaster — setup</div>
          <div className="text-sm text-white/70">Vayrone PostMaster by Vayrone Infratech · version {status.version}</div>
        </div>
      </header>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 p-4 md:flex-row md:p-8">
        <nav className="md:w-60">
          <ol className="space-y-1">
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <button
                  onClick={() => setStep(s.id)}
                  className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm ${step === s.id ? 'bg-white font-medium text-brand-700 shadow-sm ring-1 ring-slate-200' : 'text-slate-600 hover:bg-white'}`}
                >
                  <span className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${done(s.id) ? 'bg-emerald-600 text-white' : 'bg-slate-200 text-slate-600'}`}>{done(s.id) ? '✓' : i + 1}</span>
                  {s.label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <main className="min-w-0 flex-1">
          {step === 'license' && <LicenseStep s={state} onDone={() => next('license')} />}
          {step === 'company' && <CompanyStep s={state} onDone={() => next('company')} />}
          {step === 'domains' && <DomainsStep s={state} onDone={() => next('domains')} />}
          {step === 'admin' && <AdminStep s={state} onDone={() => next('admin')} />}
          {step === 'relay' && <RelayStep s={state} onDone={() => next('relay')} />}
          {step === 'network' && <NetworkStep s={state} onDone={() => next('network')} />}
          {step === 'storage' && <StorageStep s={state} onDone={() => next('storage')} />}
          {step === 'summary' && <SummaryStep s={state} goto={setStep} />}
        </main>
      </div>
    </div>
  );
}

function TokenScreen({ onOk }: { onOk: () => void }) {
  const [t, setT] = useState('');
  const check = useAction(async () => {
    sessionStorage.setItem(TOKEN_KEY, t.trim());
    await setupApi('POST', '/verify');
    onOk();
  });
  return (
    <div className="flex min-h-full flex-col items-center justify-center gap-4 p-4">
      <img src="/logo.png" alt="Vayrone PostMaster" className="h-32 w-32 rounded-2xl bg-white shadow" />
      <Card title="Vayrone PostMaster setup" className="w-full max-w-md">
        <p className="mb-3 text-sm text-slate-600">
          Enter the setup token shown at the end of the installation. On the server you can also run <code className="rounded bg-slate-100 px-1">vpm setup-token</code>.
        </p>
        <ErrorBanner error={check.error} />
        <Field label="Setup token">
          <Input value={t} onChange={(e) => setT(e.target.value)} autoFocus className="font-mono" />
        </Field>
        <Button className="w-full" busy={check.busy} disabled={t.trim().length < 8} onClick={() => void check.run()}>
          Continue
        </Button>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- 1. licence
function LicenseStep({ s, onDone }: { s: SetupState; onDone: () => void }) {
  const [mode, setMode] = useState<'online' | 'offline'>('online');
  const [key, setKey] = useState('');
  const [text, setText] = useState('');
  const activate = useAction(async () => {
    await setupApi('POST', '/license/activate', { key });
    onDone();
  });
  const request = useAction(async () => {
    const r = await setupApi<{ fileName: string; text: string }>('POST', '/license/offline-request', { key });
    download(r.fileName, r.text);
  });
  const imp = useAction(async () => {
    await setupApi('POST', '/license/import', { text });
    onDone();
  });
  const evaluate = useAction(async () => {
    await setupApi('POST', '/license/evaluate');
    onDone();
  });
  const l = s.license;
  return (
    <Card title="1. Licence">
      {l?.license ? (
        <div className="mb-4 space-y-2">
          <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm font-medium text-emerald-900 ring-1 ring-emerald-200">Licence active. Check the details below, then continue.</div>
          <div className="rounded-md px-3 ring-1 ring-slate-200">
            <LicenseDetails l={l.license} />
          </div>
        </div>
      ) : (
        <p className="mb-4 text-sm text-slate-600">Enter the licence key from Vayrone Infratech or your partner. Servers without internet access use offline activation.</p>
      )}
      <div className="mb-4 flex gap-2">
        <Button variant={mode === 'online' ? 'primary' : 'secondary'} onClick={() => setMode('online')}>
          Online activation
        </Button>
        <Button variant={mode === 'offline' ? 'primary' : 'secondary'} onClick={() => setMode('offline')}>
          Offline activation
        </Button>
      </div>
      <ErrorBanner error={activate.error ?? request.error ?? imp.error ?? evaluate.error} />
      <Field label="Licence key">
        <Input className="font-mono" placeholder="VPM-XXXXX-XXXXX-XXXXX-XXXXX-X" value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      {mode === 'online' ? (
        <Button busy={activate.busy} disabled={key.trim().length < 20} onClick={() => void activate.run()}>
          Activate
        </Button>
      ) : (
        <div className="space-y-3 text-sm">
          <div>
            <Button variant="secondary" busy={request.busy} disabled={key.trim().length < 20} onClick={() => void request.run()}>
              Download request file
            </Button>
            <p className="mt-1 text-slate-500">Send it to Vayrone Infratech or your partner (e-mail or WhatsApp is fine). Import the licence file (.vlic) you receive back below. No login or website is needed.</p>
          </div>
          <input type="file" accept=".vlic,.txt" className="block text-sm" onChange={async (e) => e.target.files?.[0] && setText(await readFile(e.target.files[0], 'text'))} />
          <Textarea rows={4} className="font-mono text-xs" placeholder="…or paste the licence file" value={text} onChange={(e) => setText(e.target.value)} />
          <Button busy={imp.busy} disabled={text.trim().length < 50} onClick={() => void imp.run()}>
            Import licence
          </Button>
        </div>
      )}
      <div className="mt-5 border-t border-slate-100 pt-4 text-sm text-slate-600">
        Machine ID of this server: <span className="font-mono">{l?.machine.id ?? '—'}</span>
        <div className="mt-3 flex justify-end gap-2">
          {l?.license ? (
            <Button onClick={onDone}>Continue</Button>
          ) : (
            <Button variant="ghost" busy={evaluate.busy} onClick={() => void evaluate.run()}>
              Continue in evaluation mode (30 days, 5 users)
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------- 2. company
function CompanyStep({ s, onDone }: { s: SetupState; onDone: () => void }) {
  const c = s.company;
  const [f, setF] = useState({ companyName: c?.companyName ?? '', address: c?.address ?? '', gstin: c?.gstin ?? '', contactPerson: c?.contactPerson ?? '', phone: c?.phone ?? '', email: c?.email ?? '' });
  const [logo, setLogo] = useState<string | null | undefined>(undefined);
  const [logoError, setLogoError] = useState<string | null>(null);
  const save = useAction(async () => {
    await setupApi('PUT', '/company', { ...f, ...(logo !== undefined ? { logo } : {}) });
    onDone();
  });
  const input = (k: keyof typeof f, label: string, extra: Record<string, unknown> = {}) => (
    <Field label={label}>
      <Input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} {...extra} />
    </Field>
  );
  return (
    <Card title="2. Company details">
      <p className="mb-3 text-sm text-slate-600">Shown on the login page and in the app, and sent to Vayrone with the licence activation.</p>
      <ErrorBanner error={save.error} />
      <div className="grid gap-x-4 sm:grid-cols-2">
        {input('companyName', 'Company name')}
        {input('gstin', 'GSTIN')}
        {input('contactPerson', 'Contact person')}
        {input('phone', 'Phone')}
        {input('email', 'Email')}
      </div>
      <Field label="Address">
        <Textarea rows={2} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
      </Field>
      <Field label="Logo" hint="PNG, JPEG or WebP, up to 512 KB. Square logos look best." error={logoError}>
        <div className="flex items-center gap-3">
          {(logo || (logo === undefined && c?.logoPath)) && <img src={logo ?? '/api/public/logo'} alt="" className="h-14 w-14 rounded bg-white object-contain ring-1 ring-slate-200" />}
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp"
            className="text-sm"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              if (file.size > 512 * 1024) return setLogoError('The logo is larger than 512 KB');
              setLogoError(null);
              setLogo(await readFile(file, 'dataUrl'));
            }}
          />
          {(logo || c?.logoPath) && (
            <Button variant="ghost" onClick={() => setLogo(null)}>
              Remove
            </Button>
          )}
        </div>
      </Field>
      <StepFooter busy={save.busy} disabled={f.companyName.trim().length < 2} onSave={() => void save.run()} />
    </Card>
  );
}

// ---------------------------------------------------------------- 3. domains
function DomainsStep({ s, onDone }: { s: SetupState; onDone: () => void }) {
  const [list, setList] = useState<string[]>(s.domains);
  const [v, setV] = useState('');
  const add = () => {
    const d = v.trim().toLowerCase().replace(/^@/, '');
    if (d && !list.includes(d)) setList([...list, d]);
    setV('');
  };
  const save = useAction(async () => {
    await setupApi('PUT', '/domains', { domains: list });
    onDone();
  });
  return (
    <Card title="3. Mail domains">
      <p className="mb-3 text-sm text-slate-600">The email domains of this company, e.g. agrasteel.com. Mailboxes are created under these domains.</p>
      <ErrorBanner error={save.error} />
      <div className="mb-3 flex flex-wrap gap-2">
        {list.map((d) => (
          <span key={d} className="inline-flex items-center gap-1 rounded-full bg-brand-50 px-3 py-1 text-sm text-brand-700 ring-1 ring-brand-100">
            {d}
            {!s.domains.includes(d) && (
              <button aria-label={`Remove ${d}`} className="ml-1 text-brand-700/60 hover:text-brand-900" onClick={() => setList(list.filter((x) => x !== d))}>
                ×
              </button>
            )}
          </span>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input placeholder="example.com" value={v} onChange={(e) => setV(e.target.value)} />
        <Button type="submit" variant="secondary">
          Add
        </Button>
      </form>
      <StepFooter busy={save.busy} disabled={list.length === 0} onSave={() => void save.run()} />
    </Card>
  );
}

// ---------------------------------------------------------------- 4. super admin
function AdminStep({ s, onDone }: { s: SetupState; onDone: () => void }) {
  const [f, setF] = useState({ login: s.admin?.login ?? (s.domains[0] ? `admin@${s.domains[0]}` : 'admin'), displayName: s.admin?.displayName ?? 'Administrator', password: '', confirm: '', mailbox: Boolean(s.admin?.hasMailbox) });
  const [shown, setShown] = useState(false);
  const save = useAction(async () => {
    if (f.password !== f.confirm) throw new Error('The passwords do not match');
    await setupApi('PUT', '/admin', { login: f.login, displayName: f.displayName, password: f.password, mailbox: f.mailbox });
    onDone();
  });
  const domainOk = f.login.includes('@') && s.domains.includes(f.login.split('@')[1] ?? '');
  return (
    <Card title="4. Super admin account">
      <p className="mb-3 text-sm text-slate-600">The first administrator. It can create other admins and users later. Keep the password safe.</p>
      <ErrorBanner error={save.error} />
      <div className="grid gap-x-4 sm:grid-cols-2">
        <Field label="Login">
          <Input value={f.login} onChange={(e) => setF({ ...f, login: e.target.value })} autoComplete="username" />
        </Field>
        <Field label="Name">
          <Input value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} />
        </Field>
        <Field label="Password" hint="At least 10 characters with letters and digits.">
          <Input type={shown ? 'text' : 'password'} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </Field>
        <Field label="Repeat password">
          <Input type={shown ? 'text' : 'password'} value={f.confirm} onChange={(e) => setF({ ...f, confirm: e.target.value })} autoComplete="new-password" />
        </Field>
      </div>
      <div className="mb-3 flex gap-2">
        <Button
          variant="ghost"
          onClick={() => {
            const p = generatePassword(16);
            setF({ ...f, password: p, confirm: p });
            setShown(true);
          }}
        >
          Generate a strong password
        </Button>
        <Button variant="ghost" onClick={() => setShown(!shown)}>
          {shown ? 'Hide' : 'Show'} password
        </Button>
      </div>
      <Toggle checked={f.mailbox && domainOk} disabled={!domainOk} onChange={(v) => setF({ ...f, mailbox: v })} label="Also give this account a mailbox (uses one licensed user)" />
      <StepFooter busy={save.busy} disabled={!f.login || f.password.length < 10} onSave={() => void save.run()} />
    </Card>
  );
}

// ---------------------------------------------------------------- 5. relay
const PRESETS: { label: string; host: string; port: number; security: 'starttls' | 'tls' }[] = [
  { label: 'Zoho Mail (India)', host: 'smtp.zoho.in', port: 465, security: 'tls' },
  { label: 'Zoho Mail', host: 'smtp.zoho.com', port: 465, security: 'tls' },
  { label: 'Hostinger', host: 'smtp.hostinger.com', port: 465, security: 'tls' },
  { label: 'GoDaddy', host: 'smtpout.secureserver.net', port: 465, security: 'tls' },
  { label: 'Google Workspace', host: 'smtp.gmail.com', port: 587, security: 'starttls' },
  { label: 'Microsoft 365', host: 'smtp.office365.com', port: 587, security: 'starttls' },
];

function RelayStep({ s, onDone }: { s: SetupState; onDone: () => void }) {
  const r = s.relay;
  const [f, setF] = useState({ host: r?.host ?? (s.domains[0] ? `mail.${s.domains[0]}` : ''), port: String(r?.port ?? 465), security: r?.security ?? 'tls', authUser: r?.authUser ?? (s.domains[0] ? `mailserver@${s.domains[0]}` : ''), password: '' });
  const [to, setTo] = useState('');
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(r?.lastTestResult ? { ok: true, message: `Last test: ${r.lastTestResult}` } : null);
  const persist = () => setupApi('PUT', '/relay', { host: f.host, port: Number(f.port), security: f.security, authUser: f.authUser || null, password: f.password || null });
  const test = useAction(async () => {
    await persist();
    setResult(await setupApi('POST', '/relay/test', to ? { to } : {}));
  });
  const save = useAction(async () => {
    await persist();
    onDone();
  });
  return (
    <Card title="5. Outgoing mail (SMTP relay)">
      <p className="mb-3 text-sm text-slate-600">All outgoing mail leaves through one account at your mail provider, e.g. mailserver@{s.domains[0] ?? 'yourdomain.com'}. Each employee's own address stays as the From.</p>
      <ErrorBanner error={test.error ?? save.error} />
      <Field label="Provider">
        <Select
          value=""
          onChange={(e) => {
            const p = PRESETS.find((x) => x.label === e.target.value);
            if (p) setF({ ...f, host: p.host, port: String(p.port), security: p.security });
          }}
        >
          <option value="">Choose a preset (or enter the server below)…</option>
          {PRESETS.map((p) => (
            <option key={p.label}>{p.label}</option>
          ))}
        </Select>
      </Field>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field label="SMTP server" className="sm:col-span-2">
          <Input value={f.host} onChange={(e) => setF({ ...f, host: e.target.value })} />
        </Field>
        <Field label="Port">
          <Input value={f.port} onChange={(e) => setF({ ...f, port: e.target.value })} />
        </Field>
        <Field label="Security">
          <Select value={f.security} onChange={(e) => setF({ ...f, security: e.target.value as typeof f.security })}>
            <option value="tls">SSL/TLS (465)</option>
            <option value="starttls">STARTTLS (587)</option>
            <option value="none">None</option>
          </Select>
        </Field>
        <Field label="Username (relay mailbox)">
          <Input value={f.authUser} onChange={(e) => setF({ ...f, authUser: e.target.value })} />
        </Field>
        <Field label="Password" hint={r?.passwordSet ? 'Stored. Leave empty to keep it.' : undefined}>
          <Input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </Field>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Send a test message to (optional)" className="min-w-64 flex-1">
          <Input type="email" placeholder="you@example.com" value={to} onChange={(e) => setTo(e.target.value)} />
        </Field>
        <Button variant="secondary" className="mb-3" busy={test.busy} disabled={!f.host} onClick={() => void test.run()}>
          {to ? 'Send test' : 'Test connection'}
        </Button>
      </div>
      {result && <div className={`rounded-md px-3 py-2 text-sm ring-1 ${result.ok ? 'bg-emerald-50 text-emerald-900 ring-emerald-200' : 'bg-red-50 text-red-800 ring-red-200'}`}>{result.message}</div>}
      <StepFooter busy={save.busy} disabled={!f.host} onSave={() => void save.run()} onSkip={onDone} />
    </Card>
  );
}

// ---------------------------------------------------------------- 6. network
const PORT_LABELS: [keyof SetupState['network']['ports'], string, string][] = [
  ['submission', 'SMTP submission', 'STARTTLS, usually 587'],
  ['smtps', 'SMTP over SSL', 'usually 465'],
  ['imap', 'IMAP', 'STARTTLS, usually 143'],
  ['imaps', 'IMAP over SSL', 'usually 993'],
  ['pop3', 'POP3', 'STLS, usually 110'],
  ['pop3s', 'POP3 over SSL', 'usually 995'],
];

function NetworkStep({ s, onDone }: { s: SetupState; onDone: () => void }) {
  const n = s.network;
  const [f, setF] = useState({ hostname: n.hostname, listenHost: n.listenHost, webPort: String(n.webPort), ports: Object.fromEntries(Object.entries(n.ports).map(([k, v]) => [k, String(v)])) as Record<string, string> });
  const [tls, setTls] = useState<'keep' | 'selfsigned' | 'upload'>(n.tls ? 'keep' : 'selfsigned');
  const [cert, setCert] = useState('');
  const [key, setKey] = useState('');
  const [restart, setRestart] = useState(s.restartNeeded);
  const save = useAction(async () => {
    const r = await setupApi<{ restartNeeded: boolean }>('PUT', '/network', {
      hostname: f.hostname,
      listenHost: f.listenHost,
      webPort: Number(f.webPort),
      ports: Object.fromEntries(Object.entries(f.ports).map(([k, v]) => [k, Number(v) || 0])),
      tls: tls === 'upload' ? { mode: 'upload', cert, key } : { mode: tls },
    });
    setRestart(r.restartNeeded);
    onDone();
  });
  return (
    <Card title="6. Network and TLS certificate">
      <ErrorBanner error={save.error} />
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field label="Server name" hint="The name Outlook and browsers use, e.g. mail.agrasteel.local" className="sm:col-span-2">
          <Input value={f.hostname} onChange={(e) => setF({ ...f, hostname: e.target.value })} />
        </Field>
        <Field label="Listen on">
          <Select value={f.listenHost} onChange={(e) => setF({ ...f, listenHost: e.target.value })}>
            <option value="0.0.0.0">All addresses</option>
            {n.addresses.map((a) => (
              <option key={a}>{a}</option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="grid gap-x-4 sm:grid-cols-3">
        <Field label="Web admin / webmail (HTTPS)" hint="usually 443">
          <Input value={f.webPort} onChange={(e) => setF({ ...f, webPort: e.target.value })} />
        </Field>
        {PORT_LABELS.map(([k, label, hint]) => (
          <Field key={k} label={label} hint={`${hint}; 0 = off`}>
            <Input value={f.ports[k]} onChange={(e) => setF({ ...f, ports: { ...f.ports, [k]: e.target.value } })} />
          </Field>
        ))}
      </div>
      <Field label="TLS certificate">
        <div className="space-y-2 text-sm">
          {n.tls && (
            <label className="flex items-start gap-2">
              <input type="radio" checked={tls === 'keep'} onChange={() => setTls('keep')} className="mt-1" />
              <span>
                Keep the current certificate{' '}
                <span className="text-slate-500">
                  ({n.tls.selfSigned ? 'self-signed' : n.tls.issuer.split('\n').find((x) => x.startsWith('O='))?.slice(2) ?? 'CA-issued'}, for {n.tls.names.join(', ') || n.tls.subject}, valid until {n.tls.validTo.slice(0, 10)})
                </span>
              </span>
            </label>
          )}
          <label className="flex items-start gap-2">
            <input type="radio" checked={tls === 'selfsigned'} onChange={() => setTls('selfsigned')} className="mt-1" />
            <span>
              New self-signed certificate for {f.hostname} and this server's addresses <span className="text-slate-500">(Outlook asks once to trust it)</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" checked={tls === 'upload'} onChange={() => setTls('upload')} className="mt-1" />
            <span>Upload a certificate (PEM): certificate with chain, and the private key</span>
          </label>
          {tls === 'upload' && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <input type="file" accept=".crt,.pem,.cer" className="mb-1 block text-xs" onChange={async (e) => e.target.files?.[0] && setCert(await readFile(e.target.files[0], 'text'))} />
                <Textarea rows={5} className="font-mono text-xs" placeholder="-----BEGIN CERTIFICATE-----" value={cert} onChange={(e) => setCert(e.target.value)} />
              </div>
              <div>
                <input type="file" accept=".key,.pem" className="mb-1 block text-xs" onChange={async (e) => e.target.files?.[0] && setKey(await readFile(e.target.files[0], 'text'))} />
                <Textarea rows={5} className="font-mono text-xs" placeholder="-----BEGIN PRIVATE KEY-----" value={key} onChange={(e) => setKey(e.target.value)} />
              </div>
            </div>
          )}
        </div>
      </Field>
      {restart && <p className="text-sm text-amber-800">The services restart with these settings when you finish the setup.</p>}
      <StepFooter busy={save.busy} onSave={() => void save.run()} />
    </Card>
  );
}

// ---------------------------------------------------------------- 7. storage
function StorageStep({ s, onDone }: { s: SetupState; onDone: () => void }) {
  const st = s.storage;
  const sep = st.dataPath.includes('\\') ? '\\' : '/';
  const [f, setF] = useState({
    backup: true,
    backupPath: st.backupPath ?? '',
    backupTime: '01:00',
    keepFull: '4',
    archiveEnabled: st.archiveEnabled,
    archiveYears: st.archiveDays === null ? 'forever' : String(Math.round(st.archiveDays / 365)),
    trashDays: st.trashDays === null ? '30' : String(st.trashDays),
    // PostMaster's start date: defaults to now, the moment PostMaster takes over the mail.
    fetchFrom: (st.fetchStartAt === undefined || st.fetchStartAt ? 'date' : 'all') as 'date' | 'all',
    fetchStartAt: st.fetchStartAt ?? nowLocal(),
  });
  const save = useAction(async () => {
    await setupApi('PUT', '/storage', {
      backupPath: f.backup && f.backupPath.trim() ? f.backupPath.trim() : null,
      backupTime: f.backupTime,
      keepFull: Number(f.keepFull),
      archiveEnabled: f.archiveEnabled,
      archiveDays: f.archiveYears === 'forever' ? null : Number(f.archiveYears) * 365,
      trashDays: f.trashDays === 'never' ? null : Number(f.trashDays),
      fetchStartAt: f.fetchFrom === 'date' ? f.fetchStartAt : null,
    });
    onDone();
  });
  return (
    <Card title="7. Storage, backup and retention">
      <ErrorBanner error={save.error} />
      <div className="mb-4 rounded-md bg-slate-50 px-3 py-2 text-sm ring-1 ring-slate-200">
        Mail is stored in <span className="font-mono">{st.dataPath}</span>
        {st.freeBytes !== null && (
          <span className="text-slate-500">
            {' '}
            — {formatBytes(st.freeBytes)} free of {formatBytes(st.totalBytes)}
          </span>
        )}
        . <span className="text-slate-500">The mail folder is chosen during installation.</span>
      </div>
      <Toggle checked={f.backup} onChange={(v) => setF({ ...f, backup: v })} label="Back up automatically every night" />
      {f.backup && (
        <div className="mt-2 grid gap-x-4 sm:grid-cols-4">
          <Field label="Backup folder" hint="A second disk, USB drive or NAS share (e.g. \\nas\backups). Not the mail disk." className="sm:col-span-2">
            <Input value={f.backupPath} placeholder={sep === '\\' ? 'D:\\PostMaster-Backup' : '/mnt/backup/postmaster'} onChange={(e) => setF({ ...f, backupPath: e.target.value })} />
          </Field>
          <Field label="Time">
            <Input type="time" value={f.backupTime} onChange={(e) => setF({ ...f, backupTime: e.target.value })} />
          </Field>
          <Field label="Keep (weeks)">
            <Input type="number" min={1} value={f.keepFull} onChange={(e) => setF({ ...f, keepFull: e.target.value })} />
          </Field>
        </div>
      )}
      <div className="mt-4 grid gap-x-4 sm:grid-cols-2">
        <Field label="Compliance archive" hint={st.archiveLicensed ? 'A copy of every incoming and outgoing message, searchable by auditors.' : 'Not included in this licence.'}>
          <Select value={f.archiveEnabled ? f.archiveYears : 'off'} disabled={!st.archiveLicensed} onChange={(e) => setF({ ...f, archiveEnabled: e.target.value !== 'off', archiveYears: e.target.value === 'off' ? f.archiveYears : e.target.value })}>
            <option value="off">Off</option>
            {['1', '3', '5', '7', '8', '10'].map((y) => (
              <option key={y} value={y}>
                Keep {y} year{y === '1' ? '' : 's'}
              </option>
            ))}
            <option value="forever">Keep forever</option>
          </Select>
        </Field>
        <Field label="Empty Trash and Junk folders">
          <Select value={f.trashDays} onChange={(e) => setF({ ...f, trashDays: e.target.value })}>
            {['7', '15', '30', '60', '90'].map((d) => (
              <option key={d} value={d}>
                after {d} days
              </option>
            ))}
            <option value="never">never</option>
          </Select>
        </Field>
      </div>
      <div className="mt-4 rounded-md px-3 py-3 ring-1 ring-slate-200">
        <div className="text-sm font-medium text-slate-900">PostMaster start date</div>
        <p className="mb-2 text-xs text-slate-500">
          External mail received from this moment on is downloaded into the office mailboxes. Older mail stays at the provider and in the PCs&apos; existing Outlook (for example when moving from
          another mail server such as QLC PostMaster), so nobody gets it twice. You can change this later in Admin → External mailboxes.
        </p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <Field label="Download external mail">
            <Select value={f.fetchFrom} onChange={(e) => setF({ ...f, fetchFrom: e.target.value as 'date' | 'all' })}>
              <option value="date">Received from a date and time</option>
              <option value="all">All mail already at the provider</option>
            </Select>
          </Field>
          {f.fetchFrom === 'date' && (
            <Field label="Received on or after">
              <Input type="datetime-local" value={f.fetchStartAt} onChange={(e) => setF({ ...f, fetchStartAt: e.target.value })} />
            </Field>
          )}
        </div>
      </div>
      <StepFooter busy={save.busy} disabled={(f.backup && !f.backupPath.trim()) || (f.fetchFrom === 'date' && !f.fetchStartAt)} onSave={() => void save.run()} />
    </Card>
  );
}

/** Now as YYYY-MM-DDTHH:MM (datetime-local) on this computer's clock. */
function nowLocal(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

// ---------------------------------------------------------------- 8. summary
function SummaryStep({ s, goto }: { s: SetupState; goto: (id: StepId) => void }) {
  const [finished, setFinished] = useState<{ restart: boolean; url: string } | null>(null);
  const [countdown, setCountdown] = useState(15);
  const timer = useRef<number | null>(null);
  const finish = useAction(async () => {
    const r = await setupApi<{ restart: boolean; url: string }>('POST', '/complete');
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    setFinished(r);
    if (!r.restart) window.location.assign('/login');
  });
  useEffect(() => {
    if (!finished?.restart) return;
    timer.current = window.setInterval(() => setCountdown((c) => Math.max(0, c - 1)), 1000);
    return () => {
      if (timer.current) window.clearInterval(timer.current);
    };
  }, [finished]);
  useEffect(() => {
    if (finished?.restart && countdown === 0) window.location.assign(finished.url);
  }, [countdown, finished]);

  const n = s.network;
  const rows: [StepId, string, ReactNode, boolean][] = [
    ['license', 'Licence', s.license?.license ? `${s.license.license.client.name} — ${s.license.license.plan.name}, ${s.license.license.maxUsers} users` : 'Evaluation (30 days, 5 users)', true],
    ['company', 'Company', s.company?.companyName ?? 'missing', Boolean(s.company)],
    ['domains', 'Domains', s.domains.join(', ') || 'missing', s.domains.length > 0],
    ['admin', 'Super admin', s.admin?.login ?? 'missing', Boolean(s.admin)],
    ['relay', 'Relay', s.relay ? `${s.relay.authUser ?? ''} via ${s.relay.host}:${s.relay.port}` : 'not set (outgoing mail stays queued)', true],
    ['network', 'Network', `${n.hostname} — HTTPS ${n.webPort}, SMTP ${n.ports.submission}/${n.ports.smtps}, IMAP ${n.ports.imap}/${n.ports.imaps}, POP3 ${n.ports.pop3}/${n.ports.pop3s}`, true],
    ['storage', 'Backup', s.storage.backupPath ?? 'no automatic backup', true],
  ];
  if (finished?.restart) {
    return (
      <Card title="Setup complete">
        <p className="text-sm text-slate-700">The mail services are restarting with the new network settings.</p>
        <p className="mt-2 text-sm text-slate-700">
          Opening <a className="text-brand-700 underline" href={finished.url}>{finished.url}</a> in {countdown} s…
        </p>
        <p className="mt-2 text-xs text-slate-500">If the address does not open, check that the server name resolves on this computer, or use the server's IP address.</p>
      </Card>
    );
  }
  const missing = rows.filter((r) => !r[3]);
  return (
    <Card title="8. Summary">
      <ErrorBanner error={finish.error} />
      <dl className="divide-y divide-slate-100 text-sm">
        {rows.map(([id, label, value, ok]) => (
          <div key={id} className="flex items-center justify-between gap-4 py-2">
            <dt className="w-32 text-slate-500">{label}</dt>
            <dd className="flex-1">{ok ? value : <Badge color="red">{value}</Badge>}</dd>
            <dd>
              <Button variant="ghost" onClick={() => goto(id)}>
                Change
              </Button>
            </dd>
          </div>
        ))}
      </dl>
      {s.restartNeeded && <p className="mt-3 text-sm text-amber-800">Finishing restarts the services with the new network settings.</p>}
      <div className="mt-5 flex justify-end">
        <Button busy={finish.busy} disabled={missing.length > 0} onClick={() => void finish.run()}>
          Finish setup and start
        </Button>
      </div>
    </Card>
  );
}
