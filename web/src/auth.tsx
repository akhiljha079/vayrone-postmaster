import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { ApiError, get, onUnauthorized, post, type Branding, type Me } from './api';

type State = { status: 'loading' } | { status: 'anonymous' } | { status: 'mfa'; me: Me } | { status: 'ready'; me: Me };

interface AuthApi {
  state: State;
  branding: Branding | null;
  refreshBranding(): Promise<void>;
  login(login: string, password: string): Promise<void>;
  verifyMfa(code: string): Promise<void>;
  logout(): Promise<void>;
  setMode(mode: 'mail' | 'admin'): Promise<void>;
  refresh(): Promise<void>;
}

const Ctx = createContext<AuthApi | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>({ status: 'loading' });
  const [branding, setBranding] = useState<Branding | null>(null);

  const refresh = useCallback(async () => {
    try {
      const me = await get<Me>('/api/auth/me');
      setState(me.mfaPassed ? { status: 'ready', me } : { status: 'mfa', me });
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setState({ status: 'anonymous' });
      else throw e;
    }
  }, []);

  const refreshBranding = useCallback(async () => {
    setBranding(await get<Branding>('/api/public/branding').catch(() => null));
  }, []);

  useEffect(() => {
    void refresh();
    void refreshBranding();
    return onUnauthorized(() => setState({ status: 'anonymous' }));
  }, [refresh]);

  const value: AuthApi = {
    state,
    branding,
    refreshBranding,
    refresh,
    async login(login, password) {
      await post('/api/auth/login', { login, password });
      await refresh();
    },
    async verifyMfa(code) {
      await post('/api/auth/mfa', { code });
      await refresh();
    },
    async logout() {
      await post('/api/auth/logout').catch(() => {});
      setState({ status: 'anonymous' });
    },
    async setMode(mode) {
      await post('/api/auth/mode', { mode });
      await refresh();
    },
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useAuth(): AuthApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useAuth outside AuthProvider');
  return v;
}

export function useMe(): Me {
  const { state } = useAuth();
  if (state.status !== 'ready') throw new Error('Not signed in');
  return state.me;
}
