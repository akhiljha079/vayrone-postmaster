import { useState } from 'react';
import { del, formatDate, get, post } from '../api';
import { useAuth, useMe } from '../auth';
import { Badge, Button, Card, ErrorBanner, Field, Input, PageHeader, Table, Td, useAction, useConfirm, useResource } from '../components/ui';

function PasswordCard() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const a = useAction(async () => {
    if (next !== confirm) throw new Error('The new passwords do not match');
    const r = await post<{ otherSessionsRevoked: number }>('/api/auth/password', { current, next });
    setDone(`Password changed. ${r.otherSessionsRevoked} other session(s) were signed out. Update the password in Outlook/Thunderbird too.`);
    setCurrent('');
    setNext('');
    setConfirm('');
  });
  return (
    <Card title="Change password">
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void a.run();
        }}
      >
        <ErrorBanner error={a.error} />
        {done && <div className="rounded-md bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{done}</div>}
        <Field label="Current password">
          <Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" required />
        </Field>
        <Field label="New password" hint="At least 8 characters, with letters and numbers.">
          <Input type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Field label="Repeat new password">
          <Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required />
        </Field>
        <Button type="submit" busy={a.busy}>
          Change password
        </Button>
      </form>
    </Card>
  );
}

function TotpCard() {
  const me = useMe();
  const { refresh } = useAuth();
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [password, setPassword] = useState('');
  const start = useAction(async () => setSetup(await post<{ secret: string; qr: string }>('/api/auth/totp/setup')));
  const enable = useAction(async () => {
    const r = await post<{ recoveryCodes: string[] }>('/api/auth/totp/enable', { code });
    setCodes(r.recoveryCodes);
    setSetup(null);
    await refresh();
  });
  const disable = useAction(async () => {
    await post('/api/auth/totp/disable', { password });
    setPassword('');
    await refresh();
  });

  return (
    <Card title="Two-step verification" actions={me.user.totpEnabled ? <Badge color="green">On</Badge> : <Badge>Off</Badge>}>
      {codes && (
        <div className="mb-4 rounded-md bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-200">
          <p className="mb-2 font-medium">Save these recovery codes now. Each works once if you lose your phone.</p>
          <div className="grid grid-cols-2 gap-1 font-mono">
            {codes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
        </div>
      )}
      {me.user.totpEnabled ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void disable.run();
          }}
        >
          <p className="text-sm text-slate-600">Sign-in requires a code from your authenticator app.</p>
          <ErrorBanner error={disable.error} />
          <Field label="Confirm your password to turn it off">
            <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required />
          </Field>
          <Button type="submit" variant="secondary" busy={disable.busy}>
            Turn off
          </Button>
        </form>
      ) : setup ? (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void enable.run();
          }}
        >
          <p className="text-sm text-slate-600">Scan with Google Authenticator, Microsoft Authenticator or a similar app, then enter the 6-digit code.</p>
          <img src={setup.qr} alt="Authenticator QR code" className="h-44 w-44 rounded ring-1 ring-slate-200" />
          <p className="text-xs text-slate-500">
            Or enter this key manually: <span className="font-mono">{setup.secret}</span>
          </p>
          <ErrorBanner error={enable.error} />
          <Field label="Code from the app">
            <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" required />
          </Field>
          <Button type="submit" busy={enable.busy}>
            Turn on
          </Button>
        </form>
      ) : (
        <div className="space-y-3">
          {me.totpEnrollmentRequired && <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">Your administrator requires two-step verification for admin accounts.</div>}
          <p className="text-sm text-slate-600">Protect your account with a code from your phone in addition to your password.</p>
          <ErrorBanner error={start.error} />
          <Button onClick={() => void start.run()} busy={start.busy}>
            Set up
          </Button>
        </div>
      )}
    </Card>
  );
}

interface SessionRow {
  handle: string;
  ip: string;
  userAgent: string | null;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}

function browserName(ua: string | null): string {
  if (!ua) return 'Unknown';
  if (/Edg\//.test(ua)) return 'Edge';
  if (/Chrome\//.test(ua)) return 'Chrome';
  if (/Firefox\//.test(ua)) return 'Firefox';
  if (/Safari\//.test(ua)) return 'Safari';
  return ua.slice(0, 40);
}

function SessionsCard() {
  const s = useResource(() => get<SessionRow[]>('/api/auth/sessions'));
  const [ask, confirmNode] = useConfirm();
  return (
    <Card title="Where you're signed in" className="lg:col-span-2">
      {confirmNode}
      <ErrorBanner error={s.error} />
      <Table head={['Browser', 'IP address', 'Signed in', 'Last active', '']}>
        {(s.data ?? []).map((x) => (
          <tr key={x.handle}>
            <Td>
              {browserName(x.userAgent)} {x.current && <Badge color="blue">This device</Badge>}
            </Td>
            <Td className="font-mono">{x.ip}</Td>
            <Td>{formatDate(x.createdAt)}</Td>
            <Td>{formatDate(x.lastSeenAt)}</Td>
            <Td className="text-right">
              {!x.current && (
                <Button
                  variant="ghost"
                  onClick={async () => {
                    if (await ask('Sign out this session?', { confirmLabel: 'Sign out' })) {
                      await del(`/api/auth/sessions/${x.handle}`);
                      s.reload();
                    }
                  }}
                >
                  Sign out
                </Button>
              )}
            </Td>
          </tr>
        ))}
      </Table>
    </Card>
  );
}

export function Account() {
  return (
    <div className="mx-auto max-w-5xl">
      <PageHeader title="Account & security" />
      <div className="grid gap-5 lg:grid-cols-2">
        <PasswordCard />
        <TotpCard />
        <SessionsCard />
      </div>
    </div>
  );
}
