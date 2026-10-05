import { useState } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { post } from '../api';
import { useAuth } from '../auth';
import { Button, ErrorBanner, Field, Input, useAction } from '../ui';

export function LoginPage() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const login = useAction(async () => {
    await post('/api/auth/login', { email, password });
    await refresh();
    nav('/');
  });
  if (me) return <Navigate to="/" replace />;
  return (
    <div className="flex min-h-full items-center justify-center p-4">
      <form
        className="w-full max-w-sm rounded-xl bg-white p-6 shadow-sm ring-1 ring-slate-200"
        onSubmit={(e) => {
          e.preventDefault();
          void login.run();
        }}
      >
        <h1 className="text-lg font-semibold text-slate-900">Vayrone License Server</h1>
        <p className="mb-4 text-sm text-slate-500">Sign in for Vayrone staff and partners</p>
        <ErrorBanner error={login.error} />
        <Field label="Email">
          <Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} autoFocus />
        </Field>
        <Field label="Password">
          <Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Button type="submit" className="mt-2 w-full" busy={login.busy}>
          Sign in
        </Button>
        <p className="mt-4 text-center text-xs text-slate-500">
          Customer with an offline server? <Link to="/portal" className="text-brand-600 underline">Offline activation portal</Link>
        </p>
      </form>
    </div>
  );
}
