export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function csrfToken(): string | undefined {
  return document.cookie
    .split('; ')
    .find((c) => c.startsWith('vpm_csrf='))
    ?.slice('vpm_csrf='.length);
}

type Listener = (e: ApiError) => void;
const unauthorizedListeners = new Set<Listener>();
/** Called when any request comes back 401 (session expired, revoked, logged out elsewhere). */
export function onUnauthorized(fn: Listener): () => void {
  unauthorizedListeners.add(fn);
  return () => unauthorizedListeners.delete(fn);
}

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const t = csrfToken();
    if (t) headers['x-vpm-csrf'] = t;
  }
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const err = new ApiError(res.status, String(data.error ?? 'ERROR'), String(data.message ?? res.statusText));
    if (res.status === 401 && path !== '/api/auth/login' && err.code !== 'MFA_INVALID') unauthorizedListeners.forEach((l) => l(err));
    throw err;
  }
  return data as T;
}

export const get = <T>(p: string) => api<T>('GET', p);
export const post = <T>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T>(p: string, b: unknown) => api<T>('PUT', p, b);
export const patch = <T>(p: string, b: unknown) => api<T>('PATCH', p, b);
export const del = <T>(p: string) => api<T>('DELETE', p);

// ---------------------------------------------------------------- types

export type Role = 'super_admin' | 'admin' | 'user' | 'auditor' | 'vayrone_support';

export interface Me {
  user: { id: number; login: string; displayName: string; role: Role; hasMailbox: boolean; totpEnabled: boolean };
  mode: 'mail' | 'admin';
  mfaPassed: boolean;
  canUseAdmin: boolean;
  canUseMail: boolean;
  totpEnrollmentRequired: boolean;
  license: { mode: 'active' | 'grace' | 'readonly' | 'unlicensed'; message: string | null; level: 'info' | 'warning' | 'critical' | null };
}

export interface Branding {
  product: { name: string; vendor: string; tagline: string };
  version: string;
  company: { name: string; logoUrl: string | null } | null;
}

export const ROLE_LABEL: Record<Role, string> = {
  super_admin: 'Super Admin',
  admin: 'Admin',
  user: 'User',
  auditor: 'Auditor',
  vayrone_support: 'Vayrone Support',
};

export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Number(n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i ? v.toFixed(1) : Math.round(v)} ${u[i]}`;
}

export function formatDate(d: string | Date | null | undefined): string {
  if (!d) return '—';
  return new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' });
}
