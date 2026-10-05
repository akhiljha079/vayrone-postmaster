import { useEffect, useState, type ReactNode } from 'react';
import { formatBytes, formatDate, get, post, put } from '../../api';
import { useMe } from '../../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, PageHeader, Select, Spinner, useAction, useResource } from '../../components/ui';

interface Health {
  version: string;
  hostname: string;
  checkedAt: string;
  process: { uptimeSec: number; rssBytes: number; heapUsedBytes: number; node: string };
  system: { uptimeSec: number; load1: number; cpus: number; memFreeBytes: number; memTotalBytes: number };
  db: { ok: boolean; latencyMs: number | null; sizeBytes: number | null; error: string | null };
  disk: { path: string; freeBytes: number; totalBytes: number; freePct: number } | null;
  store: { messages: number; bytes: number };
  users: { active: number; mailboxes: number };
  queue: { queued: number; deferred: number; held: number; oldestMinutes: number | null; failed24h: number; sent24h: number };
  fetch: { accounts: number; failing: number; authFailed: number; lastSuccessMinutes: number | null };
  backup: { lastOkAt: string | null; ageHours: number | null; schedules: number };
  tls: { validTo: string; daysLeft: number; selfSigned: boolean } | null;
  license: { mode: string };
  alerts: { critical: number; warning: number; info: number };
}
interface Settings {
  emails: string[];
  minSeverity: 'warning' | 'critical';
  diskWarnPct: number;
  diskCriticalPct: number;
  queueWarnMinutes: number;
  fetchFailHours: number;
  certWarnDays: number;
}

type Level = 'ok' | 'warn' | 'bad';
const DOT: Record<Level, string> = { ok: 'bg-emerald-500', warn: 'bg-amber-500', bad: 'bg-red-500' };
const dur = (s: number) => (s >= 86400 ? `${Math.floor(s / 86400)} d ${Math.floor((s % 86400) / 3600)} h` : s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min` : `${Math.floor(s / 60)} min`);

function Tile({ title, level, children }: { title: string; level: Level; children: ReactNode }) {
  return (
    <div className="rounded-lg bg-white p-4 ring-1 ring-slate-200">
      <div className="mb-2 flex items-center gap-2 text-sm font-medium text-slate-900">
        <span className={`h-2.5 w-2.5 rounded-full ${DOT[level]}`} />
        {title}
      </div>
      <div className="space-y-0.5 text-sm text-slate-600">{children}</div>
    </div>
  );
}

export function HealthPage() {
  const me = useMe();
  const owner = me.user.role === 'super_admin';
  const r = useResource(() => get<{ health: Health; settings: Settings; metrics: { enabled: boolean; createdAt: string | null } }>('/api/admin/health'));
  useEffect(() => {
    const t = setInterval(r.reload, 30_000);
    return () => clearInterval(t);
  }, []);
  if (r.error) return <ErrorBanner error={r.error} />;
  if (!r.data) return <Spinner />;
  const h = r.data.health;
  const s = r.data.settings;
  const q = h.queue.oldestMinutes ?? 0;
  return (
    <>
      <PageHeader title="System health" description={`${h.hostname} · version ${h.version} · checked ${formatDate(h.checkedAt)} (refreshes every 30 s)`} />
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Tile title="Database" level={h.db.ok ? (h.db.latencyMs! > 200 ? 'warn' : 'ok') : 'bad'}>
          {h.db.ok ? (
            <>
              <div>Responding in {h.db.latencyMs} ms</div>
              <div>Size {formatBytes(h.db.sizeBytes)}</div>
            </>
          ) : (
            <div className="text-red-700">{h.db.error}</div>
          )}
        </Tile>
        <Tile title="Mail data disk" level={!h.disk ? 'warn' : h.disk.freePct < s.diskCriticalPct ? 'bad' : h.disk.freePct < s.diskWarnPct ? 'warn' : 'ok'}>
          {h.disk ? (
            <>
              <div>
                {formatBytes(h.disk.freeBytes)} free of {formatBytes(h.disk.totalBytes)} ({h.disk.freePct}%)
              </div>
              <div className="truncate text-xs" title={h.disk.path}>
                {h.disk.path}
              </div>
              <div>
                {h.store.messages.toLocaleString('en-IN')} messages, {formatBytes(h.store.bytes)}
              </div>
            </>
          ) : (
            'unknown'
          )}
        </Tile>
        <Tile title="Outgoing mail" level={q > 240 ? 'bad' : q > s.queueWarnMinutes || h.queue.held ? 'warn' : 'ok'}>
          <div>
            {h.queue.queued} queued, {h.queue.deferred} deferred, {h.queue.held} held
          </div>
          <div>{h.queue.oldestMinutes !== null ? `Oldest waiting ${h.queue.oldestMinutes} min` : 'Nothing waiting'}</div>
          <div>
            Last 24 h: {h.queue.sent24h} sent, {h.queue.failed24h} failed
          </div>
        </Tile>
        <Tile title="External mailboxes" level={h.fetch.authFailed ? 'bad' : h.fetch.failing ? 'warn' : 'ok'}>
          <div>
            {h.fetch.accounts} active, {h.fetch.failing} with errors
          </div>
          {h.fetch.authFailed > 0 && <div className="text-red-700">{h.fetch.authFailed} with wrong password</div>}
          <div>{h.fetch.lastSuccessMinutes !== null ? `Last fetch ${h.fetch.lastSuccessMinutes} min ago` : 'No fetch yet'}</div>
        </Tile>
        <Tile title="Backups" level={!h.backup.schedules ? 'warn' : h.backup.ageHours === null || h.backup.ageHours > 48 ? 'bad' : h.backup.ageHours > 26 ? 'warn' : 'ok'}>
          <div>{h.backup.lastOkAt ? `Last good backup ${formatDate(h.backup.lastOkAt)}` : 'No successful backup yet'}</div>
          <div>{h.backup.schedules ? `${h.backup.schedules} schedule(s)` : 'No schedule configured'}</div>
        </Tile>
        <Tile title="TLS certificate" level={!h.tls ? 'warn' : h.tls.daysLeft < 7 ? 'bad' : h.tls.daysLeft < s.certWarnDays ? 'warn' : 'ok'}>
          {h.tls ? (
            <>
              <div>
                Valid until {formatDate(h.tls.validTo)} ({h.tls.daysLeft} days)
              </div>
              <div>{h.tls.selfSigned ? 'Self-signed' : 'Issued by a certificate authority'}</div>
            </>
          ) : (
            'No certificate found'
          )}
        </Tile>
        <Tile title="Server" level={h.system.load1 > h.system.cpus * 2 || h.system.memFreeBytes / h.system.memTotalBytes < 0.05 ? 'warn' : 'ok'}>
          <div>
            Load {h.system.load1.toFixed(2)} on {h.system.cpus} CPUs
          </div>
          <div>
            Memory {formatBytes(h.system.memFreeBytes)} free of {formatBytes(h.system.memTotalBytes)}
          </div>
          <div>Server up {dur(h.system.uptimeSec)}</div>
        </Tile>
        <Tile title="Alerts and licence" level={h.alerts.critical ? 'bad' : h.alerts.warning || h.license.mode !== 'active' ? 'warn' : 'ok'}>
          <div>
            {h.alerts.critical} critical, {h.alerts.warning} warnings open
          </div>
          <div>Licence: {h.license.mode}</div>
          <div>
            Web service up {dur(h.process.uptimeSec)}, {formatBytes(h.process.rssBytes)}
          </div>
        </Tile>
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <AlertMail settings={s} owner={owner} onSaved={r.reload} />
        <Metrics enabled={r.data.metrics.enabled} createdAt={r.data.metrics.createdAt} owner={owner} onChanged={r.reload} />
      </div>
    </>
  );
}

function AlertMail({ settings, owner, onSaved }: { settings: Settings; owner: boolean; onSaved: () => void }) {
  const [emails, setEmails] = useState(settings.emails.join(', '));
  const [f, setF] = useState(settings);
  const [result, setResult] = useState<string | null>(null);
  const save = useAction(async () => {
    await put('/api/admin/health/settings', { ...f, emails: emails.split(/[\s,;]+/).filter(Boolean) });
    onSaved();
  });
  const test = useAction(async () => {
    const r = await post<{ recipients: string[] }>('/api/admin/health/test-email');
    setResult(`Test alert sent to ${r.recipients.join(', ')}`);
  });
  const num = (k: keyof Settings, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      <Input type="number" value={String(f[k])} disabled={!owner} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />
    </Field>
  );
  return (
    <Card title="Alert e-mails">
      <ErrorBanner error={save.error ?? test.error} />
      <p className="mb-3 text-sm text-slate-600">The server checks itself every 5 minutes and e-mails new problems (once a day while they last). Local mailboxes receive alerts even without internet.</p>
      <Field label="Send alerts to" hint="Comma-separated, e.g. it@company.com, admin@company.local">
        <Input value={emails} disabled={!owner} onChange={(e) => setEmails(e.target.value)} />
      </Field>
      <Field label="Which alerts">
        <Select value={f.minSeverity} disabled={!owner} onChange={(e) => setF({ ...f, minSeverity: e.target.value as Settings['minSeverity'] })}>
          <option value="critical">Critical only</option>
          <option value="warning">Warnings and critical</option>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-x-3">
        {num('diskWarnPct', 'Disk warning below (%)')}
        {num('diskCriticalPct', 'Disk critical below (%)')}
        {num('queueWarnMinutes', 'Outgoing mail stuck after (min)')}
        {num('fetchFailHours', 'Fetch failing for (hours)')}
        {num('certWarnDays', 'Certificate warning (days before)')}
      </div>
      {owner && (
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Button variant="secondary" busy={test.busy} onClick={() => void test.run()}>
              Send test alert
            </Button>
            {result && <span className="text-sm text-emerald-700">{result}</span>}
          </div>
          <Button busy={save.busy} onClick={() => void save.run()}>
            Save
          </Button>
        </div>
      )}
    </Card>
  );
}

function Metrics({ enabled, createdAt, owner, onChanged }: { enabled: boolean; createdAt: string | null; owner: boolean; onChanged: () => void }) {
  const [token, setToken] = useState<string | null>(null);
  const toggle = useAction(async (on: boolean) => {
    const r = await post<{ token?: string }>('/api/admin/health/metrics-token', { enabled: on });
    setToken(r.token ?? null);
    onChanged();
  });
  return (
    <Card title="Prometheus / Zabbix monitoring">
      <ErrorBanner error={toggle.error} />
      <p className="mb-3 text-sm text-slate-600">
        Network monitoring tools can read <code className="rounded bg-slate-100 px-1">https://{window.location.host}/metrics</code> with a bearer token.
      </p>
      <div className="mb-3 text-sm">
        Status: {enabled ? <Badge color="green">enabled since {formatDate(createdAt)}</Badge> : <Badge>off</Badge>}
      </div>
      {token && (
        <div className="mb-3 rounded-md bg-emerald-50 p-3 text-sm ring-1 ring-emerald-200">
          Copy this token now; it is not shown again:
          <div className="mt-1 break-all font-mono">{token}</div>
        </div>
      )}
      {owner && (
        <div className="flex gap-2">
          <Button variant="secondary" busy={toggle.busy} onClick={() => void toggle.run(true)}>
            {enabled ? 'Generate a new token' : 'Enable with a new token'}
          </Button>
          {enabled && (
            <Button variant="ghost" onClick={() => void toggle.run(false)}>
              Disable
            </Button>
          )}
        </div>
      )}
    </Card>
  );
}
