import { useState, type FormEvent } from 'react';
import { useAuth } from '../auth';
import { Button, ErrorBanner, Field, Input } from '../components/ui';
import { Footer } from '../components/Layout';

export function Login() {
  const { state, login, verifyMfa, logout, branding } = useAuth();
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const mfa = state.status === 'mfa';

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mfa) await verifyMfa(code);
      else await login(loginName, password);
    } catch (err) {
      setError(err);
      if (mfa) setCode('');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full flex-col bg-gradient-to-br from-brand-900 via-brand-700 to-brand-500">
      <div className="flex flex-1 items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="mb-6 text-center text-white">
            {branding?.company?.logoUrl ? (
              <img src={branding.company.logoUrl} alt="" className="mx-auto mb-3 h-16 w-16 rounded-lg bg-white object-contain p-1.5" />
            ) : (
              <img src="/logo.png" alt="Vayrone PostMaster" className="mx-auto mb-3 h-36 w-36 rounded-2xl bg-white p-1 shadow-xl" />
            )}
            {branding?.company && <div className="text-lg font-semibold">{branding.company.name}</div>}
            <div className="text-sm text-white/80">Vayrone PostMaster by Vayrone Infratech</div>
          </div>
          <form onSubmit={submit} className="space-y-4 rounded-xl bg-white p-6 shadow-2xl">
            <h1 className="text-lg font-semibold text-slate-900">{mfa ? 'Two-step verification' : 'Sign in'}</h1>
            <ErrorBanner error={error} />
            {mfa ? (
              <>
                <p className="text-sm text-slate-600">Enter the 6-digit code from your authenticator app, or one of your recovery codes.</p>
                <Field label="Verification code">
                  <Input value={code} onChange={(e) => setCode(e.target.value)} inputMode="numeric" autoComplete="one-time-code" autoFocus required />
                </Field>
                <Button type="submit" busy={busy} className="w-full">
                  Verify
                </Button>
                <button type="button" onClick={() => void logout()} className="w-full text-center text-sm text-slate-500 hover:text-slate-700">
                  Use a different account
                </button>
              </>
            ) : (
              <>
                <Field label="Email address">
                  <Input value={loginName} onChange={(e) => setLoginName(e.target.value)} autoComplete="username" autoFocus required placeholder="you@company.com" />
                </Field>
                <Field label="Password" hint="Your office (LAN) mail password — not your email provider password.">
                  <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
                </Field>
                <Button type="submit" busy={busy} className="w-full">
                  Sign in
                </Button>
              </>
            )}
          </form>
        </div>
      </div>
      <Footer />
    </div>
  );
}
