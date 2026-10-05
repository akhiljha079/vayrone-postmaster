export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const csrf = () =>
  document.cookie
    .split('; ')
    .find((c) => c.startsWith('vls_csrf='))
    ?.slice('vls_csrf='.length);

let onUnauthorized: (() => void) | null = null;
export const setUnauthorizedHandler = (fn: () => void) => (onUnauthorized = fn);

export async function api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') {
    const t = csrf();
    if (t) headers['x-vls-csrf'] = t;
  }
  const res = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  if (!res.ok) {
    const err = new ApiError(res.status, String(data.error ?? 'ERROR'), String(data.message ?? res.statusText));
    if (res.status === 401 && path !== '/api/auth/login') onUnauthorized?.();
    throw err;
  }
  return data as T;
}

export const get = <T>(p: string) => api<T>('GET', p);
export const post = <T>(p: string, b: unknown = {}) => api<T>('POST', p, b);
export const put = <T>(p: string, b: unknown) => api<T>('PUT', p, b);
export const patch = <T>(p: string, b: unknown) => api<T>('PATCH', p, b);

export interface Me {
  user: { id: number; email: string; name: string; role: 'owner' | 'staff' | 'reseller' };
  reseller: { id: number; name: string; quotaLicenses: number | null; quotaUsers: number | null; discountPct: number } | null;
}

export const day = (d: string | null | undefined) => (d ? new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');
export const when = (d: string | null | undefined) => (d ? new Date(d).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—');
export const inr = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `₹${Number(n).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`);
export const daysLeft = (d: string | null | undefined) => (d ? Math.ceil((new Date(d).getTime() - Date.now()) / 86_400_000) : null);

export function download(name: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/octet-stream' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
