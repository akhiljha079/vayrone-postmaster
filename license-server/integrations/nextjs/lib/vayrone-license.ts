// Vayrone License Server client for the Vayrone website (server side only).
//
// Uses the License Server's staff API with an API key created in
// License Server → Settings → API keys. Never import this into browser code:
// the key would leak. In Next.js, import it from server components, server
// actions or route handlers only (see vls.server.ts).
//
// No dependencies; needs Node 18+ (global fetch).

export interface VlsOptions {
  /** e.g. https://license.vayrone.com */
  baseUrl: string;
  /** vls_… from License Server → Settings → API keys */
  apiKey: string;
  /** Request timeout in ms (default 15 s). */
  timeoutMs?: number;
  fetch?: typeof fetch;
}

export class VlsError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'VlsError';
  }
}

export interface Plan {
  id: number;
  code: string;
  name: string;
  description: string | null;
  features: string[];
  minUsers: number;
  termMonths: number; // 0 = perpetual
  isActive: boolean;
}

export interface ClientInput {
  company: string;
  contactName?: string | null;
  email?: string | null;
  phone?: string | null;
  whatsapp?: string | null;
  city?: string | null;
  state?: string | null;
  gstin?: string | null;
  address?: string | null;
  notes?: string | null;
}

export interface Client extends Required<ClientInput> {
  id: number;
  createdAt: string;
  activeLicenses?: number;
}

export interface LicenseSummary {
  id: number;
  licenseId: string;
  licenseKey: string;
  status: 'active' | 'suspended' | 'revoked';
  maxUsers: number;
  expiresAt: string | null;
  amcExpiresAt: string | null;
  createdAt: string;
  clientId: number;
  company: string;
  city: string | null;
  plan: string;
  planCode: string;
  activations: number;
  lastSeenAt: string | null;
  usedUsers: number | null;
}

export interface LicenseDetail {
  id: number;
  licenseId: string;
  licenseKey: string;
  status: 'active' | 'suspended' | 'revoked';
  statusReason: string | null;
  maxUsers: number;
  features: string[];
  startsAt: string;
  expiresAt: string | null;
  amcExpiresAt: string | null;
  maxActivations: number;
  notes: string | null;
  client: { id: number; company: string; contactName: string | null; email: string | null; phone: string | null; city: string | null; gstin: string | null };
  plan: { id: number; code: string; name: string; termMonths: number };
  activations: { id: number; activationId: string; machineId: string; mode: 'online' | 'offline'; status: string; activatedAt: string; lastSeenAt: string | null; version: string | null; hostname: string | null; activeUsers: number | null }[];
  renewals: { id: number; kind: string; periodFrom: string; periodTo: string; users: number; amount: number; invoiceRef: string | null; createdAt: string }[];
}

export type ServerState = 'problem' | 'silent' | 'warning' | 'no_data' | 'ok' | 'offline';
export interface ServerHealth {
  at: string;
  status: 'ok' | 'warning' | 'problem';
  issues: { level: 'problem' | 'warning'; text: string }[];
  version: string;
  uptimeHours: number;
  diskFreePct: number | null;
  diskFreeGb: number | null;
  dbOk: boolean;
  mailboxes: number;
  queue: { waiting: number; oldestMinutes: number | null; failed24h: number; sent24h: number };
  fetch: { accounts: number; failing: number; authFailed: number };
  backup: { lastOkAt: string | null; ageHours: number | null; scheduled: boolean };
  certDaysLeft: number | null;
  alerts: { critical: number; warning: number };
  licenseMode: string;
}
/** One activated client server (License Server → Client servers). */
export interface ClientServer {
  id: number;
  licenseRowId: number;
  licenseId: string;
  company: string;
  city: string | null;
  phone: string | null;
  plan: string;
  hostname: string | null;
  version: string | null;
  mode: string;
  activeUsers: number | null;
  maxUsers: number;
  lastSeenAt: string | null;
  healthAt: string | null;
  health: ServerHealth | null;
  reseller: string | null;
  state: ServerState;
}

export interface CreateLicenseInput {
  clientId: number;
  /** Plan id, or use planCode with createLicense's helper. */
  planId: number;
  /** Number of mailbox users the client may create. */
  maxUsers: number;
  /** Validity in months; 0 = perpetual. Default: the plan's term. */
  termMonths?: number;
  /** AMC (support and updates) months. Default: the term, or 12 for perpetual. */
  amcMonths?: number;
  /** Feature list; default: the plan's features. */
  features?: string[];
  /** Servers that may use the licence at the same time (default 1). */
  maxActivations?: number;
  amount?: number;
  invoiceRef?: string;
  notes?: string;
  startsAt?: string;
}

export function createVlsClient(o: VlsOptions) {
  const base = o.baseUrl.replace(/\/+$/, '');
  if (!/^vls_[A-Za-z0-9_-]{20,}$/.test(o.apiKey)) throw new Error('VLS API key is missing or malformed (expected vls_…)');
  const doFetch = o.fetch ?? fetch;

  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), o.timeoutMs ?? 15_000);
    try {
      const res = await doFetch(`${base}/api${path}`, {
        method,
        headers: { authorization: `Bearer ${o.apiKey}`, accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: ctrl.signal,
        cache: 'no-store',
      });
      const data = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) throw new VlsError(res.status, data.error ?? 'HTTP_ERROR', data.message ?? `License Server answered ${res.status}`);
      return data as T;
    } catch (e) {
      if (e instanceof VlsError) throw e;
      throw new VlsError(0, 'UNREACHABLE', `License Server not reachable: ${(e as Error).message}`);
    } finally {
      clearTimeout(t);
    }
  }
  const qs = (p: Record<string, string | number | undefined>) => {
    const s = new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]): [string, string] => [k, String(v)])).toString();
    return s ? `?${s}` : '';
  };

  return {
    plans: () => call<Plan[]>('GET', '/plans'),
    features: () => call<string[]>('GET', '/features'),

    listClients: (p: { q?: string; page?: number; pageSize?: number } = {}) => call<{ items: Client[]; total: number }>('GET', `/clients${qs(p)}`),
    getClient: (id: number) => call<Client & { licenses: { id: number; licenseId: string; plan: string; maxUsers: number; status: string; expiresAt: string | null }[] }>('GET', `/clients/${id}`),
    createClient: (c: ClientInput) => call<{ id: number }>('POST', '/clients', c),
    updateClient: (id: number, c: Partial<ClientInput>) => call<{ ok: true }>('PATCH', `/clients/${id}`, c),

    listLicenses: (p: { q?: string; status?: string; clientId?: number; expiring?: number; page?: number } = {}) => call<{ items: LicenseSummary[]; total: number }>('GET', `/licenses${qs(p)}`),
    getLicense: (id: number) => call<LicenseDetail>('GET', `/licenses/${id}`),
    /** Returns the licence key (VPM-…) to give to the client. */
    createLicense: (l: CreateLicenseInput) => call<{ id: number; licenseId: string; licenseKey: string }>('POST', '/licenses', l),
    /** Change the user count (or other terms). Online servers pick it up within a day. */
    updateLicense: (id: number, p: { maxUsers?: number; features?: string[]; maxActivations?: number; notes?: string | null; amount?: number; invoiceRef?: string }) =>
      call<{ ok: true }>('PATCH', `/licenses/${id}`, p),
    renewLicense: (id: number, p: { kind: 'renewal' | 'amc'; months: number; amount?: number; invoiceRef?: string; notes?: string }) =>
      call<{ ok: true; expiresAt?: string; amcExpiresAt?: string }>('POST', `/licenses/${id}/renew`, p),
    setLicenseStatus: (id: number, status: 'active' | 'suspended' | 'revoked', reason?: string) => call<{ ok: true }>('POST', `/licenses/${id}/status`, { status, reason }),
    /** Frees the licence for a new server (hardware change). */
    releaseActivation: (activationId: number, reason: string) => call<{ ok: true }>('POST', `/activations/${activationId}/release`, { reason }),

    /** Health of every activated client server, worst first. */
    servers: () => call<{ items: ClientServer[]; summary: Record<ServerState, number>; checkedAt: string }>('GET', '/servers'),

    /** Reads a request file without issuing anything: which licence and machine it is for. */
    inspectOffline: (requestText: string) =>
      call<{
        request: { kind: 'activation' | 'revalidation'; machineId: string; hostname: string; version: string; activeUsers: number; createdAt: string };
        license: { id: number; licenseId: string; company: string; status: string; maxUsers: number; expiresAt: string | null; maxActivations: number } | null;
        activeOn: { id: number; machineId: string; hostname: string | null }[];
        sameMachine: boolean;
        overLimit: boolean;
      }>('POST', '/offline/inspect', { request: requestText }),

    /** Offline servers: the client's request file (.vreq) in, the licence file (.vlic) out. */
    issueOfflineLicense: (requestText: string) => call<{ license: string; fileName: string; licenseId: string; activationId: string; client: string }>('POST', '/offline/issue', { request: requestText }),
  };
}

export type VlsClient = ReturnType<typeof createVlsClient>;
