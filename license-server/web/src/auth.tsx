import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { get, post, setUnauthorizedHandler, type Me } from './api';
import { Spinner } from './ui';

interface Auth {
  me: Me | null;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}
const AuthCtx = createContext<Auth | null>(null);
export const useAuth = () => useContext(AuthCtx)!;
export const useMe = () => useAuth().me!;

export function AuthProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null | undefined>(undefined);
  const refresh = useCallback(async () => {
    setMe(await get<Me>('/api/auth/me').catch(() => null));
  }, []);
  useEffect(() => {
    setUnauthorizedHandler(() => setMe(null));
    void refresh();
  }, [refresh]);
  const logout = async () => {
    await post('/api/auth/logout').catch(() => undefined);
    setMe(null);
  };
  if (me === undefined) return <Spinner />;
  return <AuthCtx.Provider value={{ me, refresh, logout }}>{children}</AuthCtx.Provider>;
}

