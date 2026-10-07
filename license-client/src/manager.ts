// LicenseManager: the real LicenseGate. Each process (core, web, worker) runs
// one; they share state through the license_state row and re-evaluate every
// minute, so a licence activated in the admin panel applies everywhere within
// a minute without restarts.
import { hostname } from 'node:os';
import { APP_VERSION, db as dbm, licensedUserCount, raiseAlert, resolveAlert, type CoreConfig, type Db, type LicenseGate, type LicenseMode, type SecretBox } from '@vpm/core';
import {
  encodeRequest,
  LICENSE_FORMAT,
  LicenseFormatError,
  newNonce,
  normalizeLicenseKey,
  REQUEST_FORMAT,
  REVOCATION_FORMAT,
  verifyDoc,
  type KeyRing,
  type LicensePayload,
  type RevocationPayload,
} from './format.js';
import { collectFingerprint, matchFingerprint, type Fingerprint } from './fingerprint.js';
import { evaluate, GRACE_DAYS, type Evaluation, type LicenseStatus } from './evaluate.js';
import { appRoot, checkIntegrity, type IntegrityResult } from './integrity.js';
import { trustedKeys } from './keys.js';
import type { ActivateResponse, ApiError, DeactivateResponse, HeartbeatResponse, ProductInfo, UsageInfo } from './protocol.js';

const { exec, one, tx } = dbm;

export const DEFAULT_LICENSE_SERVER = 'https://license.vayrone.com';
/** A signed server time this close to the local clock proves the clock is right. */
const TIME_CONFIRM_MS = 10 * 60_000;
const HEARTBEAT_RETRY_MS = 3600_000;
const FINGERPRINT_TTL_MS = 6 * 3600_000;
const INTEGRITY_TTL_MS = 24 * 3600_000;

interface Log {
  info(o: unknown, m?: string): void;
  warn(o: unknown, m?: string): void;
  error(o: unknown, m?: string): void;
}

export interface LicenseDeps {
  db: Db;
  secrets: SecretBox;
  config: Pick<CoreConfig, 'dataPath' | 'installId' | 'hostname'> & { license?: { serverUrl?: string } };
  log?: Log;
}

export interface LicenseManagerOptions {
  keys?: KeyRing;
  serverUrl?: string;
  now?: () => Date;
  fingerprint?: () => Promise<Fingerprint>;
  integrity?: () => Promise<IntegrityResult>;
  fetch?: typeof fetch;
}

export class LicenseActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

interface SealedState {
  v: 1;
  installedAt: string;
  highWater: string;
  mismatch: { licenseId: string; since: string } | null;
}

interface SealedSecret {
  key: string | null;
  token: string | null;
  activationId: string | null;
}

interface StateRow {
  license_blob: string | null;
  revocation_blob: string | null;
  state_seal: Buffer | null;
  secret_seal: Buffer | null;
  status: LicenseStatus;
  activation_mode: 'online' | 'offline' | null;
  activated_at: Date | null;
  last_validated_at: Date | null;
  last_heartbeat_at: Date | null;
  last_heartbeat_error: string | null;
  heartbeat_failures: number;
  reason: string | null;
}

export interface LicenseInfo {
  status: LicenseStatus;
  mode: LicenseMode;
  reason: string;
  warning: string | null;
  graceEndsAt: string | null;
  deadline: string | null;
  license: (Omit<LicensePayload, 'activation' | 'format' | 'product'> & { activationMode: 'online' | 'offline'; amcActive: boolean; licensedMachineId: string }) | null;
  usage: UsageInfo;
  machine: { id: string; available: string[]; changed: string[] };
  activation: { at: string | null; lastValidatedAt: string | null; lastHeartbeatAt: string | null; heartbeatFailures: number; lastError: string | null; serverUrl: string };
  revocation: { reason: string; message: string; at: string } | null;
  integrity: IntegrityResult['status'];
  installedAt: string;
}

const iso = (d: Date | null | undefined) => (d ? new Date(d).toISOString() : null);
const maxDate = (...ds: (Date | string | null | undefined)[]) =>
  ds.filter((d): d is Date | string => Boolean(d)).reduce<Date | null>((m, d) => (m && m >= new Date(d) ? m : new Date(d)), null);

export class LicenseManager implements LicenseGate {
  private ev: Evaluation;
  private fp: Fingerprint | null = null;
  private fpAt = 0;
  private integrityResult: IntegrityResult = { status: 'skipped', problems: [], checkedAt: new Date(0) };
  private timer: NodeJS.Timeout | null = null;
  private readonly keys: KeyRing;
  private readonly now: () => Date;
  readonly serverUrl: string;

  private constructor(
    private readonly deps: LicenseDeps,
    private readonly opts: LicenseManagerOptions,
  ) {
    this.keys = opts.keys ?? trustedKeys(deps.config.dataPath);
    this.now = opts.now ?? (() => new Date());
    this.serverUrl = (opts.serverUrl ?? deps.config.license?.serverUrl ?? DEFAULT_LICENSE_SERVER).replace(/\/+$/, '');
    // Until the first evaluation completes nothing is allowed beyond evaluation limits.
    this.ev = evaluate({
      now: this.now(),
      license: null,
      licenseError: null,
      revocation: null,
      fingerprint: { machineId: '', components: { os: null, board: null, uuid: null, disk: null, cpu: null }, available: [] },
      clockFloor: null,
      mismatchSince: null,
      installedAt: this.now(),
      integrity: 'skipped',
    });
  }

  static async open(deps: LicenseDeps, opts: LicenseManagerOptions = {}): Promise<LicenseManager> {
    const m = new LicenseManager(deps, opts);
    await m.checkIntegrityNow();
    await m.refresh();
    return m;
  }

  // ------------------------------------------------------------ LicenseGate
  maxUsers(): number | null {
    return this.ev.maxUsers;
  }
  maxExternalAccounts(): number | null {
    return this.ev.maxExternalAccounts;
  }
  feature(name: string): boolean {
    return this.ev.features.includes(name);
  }
  mode(): LicenseMode {
    return this.ev.mode;
  }
  evaluation(): Evaluation {
    return this.ev;
  }

  /** Re-evaluates every `ms` (default one minute). */
  start(ms = 60_000): void {
    this.stop();
    this.timer = setInterval(() => {
      this.refresh().catch((err) => this.deps.log?.error({ err }, 'licence refresh failed'));
    }, ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async fingerprint(force = false): Promise<Fingerprint> {
    if (force || !this.fp || Date.now() - this.fpAt > FINGERPRINT_TTL_MS) {
      this.fp = await (this.opts.fingerprint ?? (() => collectFingerprint(this.deps.config.dataPath)))();
      this.fpAt = Date.now();
    }
    return this.fp;
  }

  async checkIntegrityNow(): Promise<IntegrityResult> {
    this.integrityResult = await (this.opts.integrity ?? (() => checkIntegrity(appRoot(), this.keys)))();
    if (this.integrityResult.status === 'failed') this.deps.log?.error({ problems: this.integrityResult.problems }, 'program file integrity check failed');
    return this.integrityResult;
  }

  // ------------------------------------------------------------ state

  private verifyLicense(blob: string | null): { license: LicensePayload | null; error: string | null } {
    if (!blob) return { license: null, error: null };
    try {
      const { payload } = verifyDoc<LicensePayload>(LICENSE_FORMAT, blob, this.keys);
      if (payload.product !== 'postmaster') return { license: null, error: 'licence is for another product' };
      return { license: payload, error: null };
    } catch (e) {
      return { license: null, error: (e as Error).message };
    }
  }

  private verifyRevocation(blob: string | null): RevocationPayload | null {
    if (!blob) return null;
    try {
      return verifyDoc<RevocationPayload>(REVOCATION_FORMAT, blob, this.keys).payload;
    } catch {
      return null; // an altered notice is ignored; the server re-sends it on the next heartbeat
    }
  }

  private openSealed<T>(blob: Buffer | null): T | null {
    if (!blob) return null;
    try {
      return JSON.parse(this.deps.secrets.open(Buffer.from(blob))) as T;
    } catch {
      return null;
    }
  }

  private seal(v: unknown): Buffer {
    return this.deps.secrets.seal(JSON.stringify(v));
  }

  private async lockRow(c: dbm.PoolConnection): Promise<StateRow> {
    const sql = 'SELECT * FROM license_state WHERE id = 1 FOR UPDATE';
    let row = await one<StateRow>(c, sql);
    if (!row) {
      await exec(c, "INSERT IGNORE INTO license_state (id, status, updated_at) VALUES (1, 'unlicensed', ?)", [this.now()]);
      row = await one<StateRow>(c, sql);
    }
    return row!;
  }

  private async loadState(c: dbm.PoolConnection, row: StateRow): Promise<SealedState> {
    const s = this.openSealed<SealedState>(row.state_seal);
    if (s?.v === 1) return s;
    if (row.state_seal) {
      await this.event(c, 'tamper', { what: 'state_seal', note: 'sealed licence state could not be read; rebuilt' });
    }
    // First start (or unreadable seal): the install date is the first migration.
    const first = await one<{ at: Date | null }>(c, 'SELECT MIN(applied_at) AS at FROM schema_migrations');
    const installedAt = first?.at ? new Date(first.at) : this.now();
    return { v: 1, installedAt: installedAt.toISOString(), highWater: (maxDate(installedAt, row.last_validated_at) ?? this.now()).toISOString(), mismatch: null };
  }

  private async event(c: dbm.Queryable, event: string, detail: Record<string, unknown> | null = null): Promise<void> {
    await exec(c, 'INSERT INTO license_events (at, event, detail) VALUES (?,?,?)', [this.now(), event, detail ? JSON.stringify(detail) : null]);
  }

  /** Re-reads the licence, re-evaluates, and records state changes. */
  async refresh(): Promise<Evaluation> {
    const fp = await this.fingerprint();
    if (Date.now() - this.integrityResult.checkedAt.getTime() > INTEGRITY_TTL_MS) await this.checkIntegrityNow();
    const now = this.now();
    this.ev = await tx(this.deps.db, async (c) => {
      const row = await this.lockRow(c);
      const state = await this.loadState(c, row);
      const before = JSON.stringify(state);
      const { license, error } = this.verifyLicense(row.license_blob);
      const revocation = this.verifyRevocation(row.revocation_blob);

      const match = license ? matchFingerprint(license.activation.components, fp.components) : null;
      if (license && match && !match.ok) {
        if (state.mismatch?.licenseId !== license.licenseId) state.mismatch = { licenseId: license.licenseId, since: now.toISOString() };
      } else state.mismatch = null;

      const ev = evaluate({
        now,
        license,
        licenseError: error,
        revocation,
        fingerprint: fp,
        clockFloor: maxDate(state.highWater, license?.issuedAt, revocation?.issuedAt),
        mismatchSince: state.mismatch ? new Date(state.mismatch.since) : null,
        installedAt: new Date(state.installedAt),
        integrity: this.integrityResult.status,
      });

      // The high-water mark only moves forward (in 5-minute steps to limit writes).
      if (now.getTime() > new Date(state.highWater).getTime() + 5 * 60_000) state.highWater = now.toISOString();
      const changedState = JSON.stringify(state) !== before || !row.state_seal;
      const changedStatus = row.status !== ev.status || row.reason !== ev.reason.slice(0, 500);
      if (changedState || changedStatus) {
        await exec(
          c,
          `UPDATE license_state SET state_seal = ?, status = ?, reason = ?, high_water_clock = ?, grace_started_at = ?,
             license_id = ?, key_hint = ?, client_name = ?, plan = ?, max_users = ?, max_external_accounts = ?, features = ?, issued_at = ?,
             expires_at = ?, amc_expires_at = ?, check_by = ?, machine_fingerprint = ?, updated_at = ? WHERE id = 1`,
          [
            this.seal(state),
            ev.status,
            ev.reason.slice(0, 500),
            new Date(state.highWater),
            ev.graceEndsAt ? new Date(ev.graceEndsAt.getTime() - GRACE_DAYS * 86_400_000) : null,
            license?.licenseId ?? null,
            license?.keyHint ?? null,
            license?.client.name.slice(0, 200) ?? null,
            license?.plan.name ?? null,
            license?.maxUsers ?? null,
            license?.maxExternalAccounts ?? null,
            license ? JSON.stringify(license.features) : null,
            license ? new Date(license.issuedAt) : null,
            license?.expiresAt ? new Date(license.expiresAt) : null,
            license?.amcExpiresAt ? new Date(license.amcExpiresAt) : null,
            license ? new Date(license.checkBy) : null,
            fp.machineId,
            now,
          ],
        );
      }
      if (row.status !== ev.status) {
        const event = { active: 'active', grace: 'grace_start', expired: 'expired', tampered: 'tamper', fingerprint_mismatch: 'fingerprint_mismatch', unlicensed: 'unlicensed' }[ev.status];
        await this.event(c, event, { from: row.status, reason: ev.reason });
        if (ev.mode === 'readonly' || ev.mode === 'grace') this.deps.log?.warn({ status: ev.status }, ev.reason);
      }
      if (ev.mode === 'readonly') await raiseAlert(c, { severity: 'critical', code: 'license.readonly', message: ev.reason, dedupeKey: 'license.state' });
      else if (ev.mode === 'grace') await raiseAlert(c, { severity: 'critical', code: 'license.grace', message: ev.reason, dedupeKey: 'license.state' });
      else if (ev.warning) await raiseAlert(c, { severity: 'warning', code: 'license.warning', message: ev.warning, dedupeKey: 'license.state' });
      else if (row.status !== ev.status || changedStatus) await resolveAlert(c, 'license.state');
      return ev;
    });
    return this.ev;
  }

  async usage(): Promise<UsageInfo> {
    const ext = await one<{ n: number }>(this.deps.db, 'SELECT COUNT(*) AS n FROM external_accounts WHERE is_enabled = 1');
    return { activeUsers: await licensedUserCount(this.deps.db), externalAccounts: Number(ext?.n ?? 0) };
  }

  private async product(): Promise<ProductInfo> {
    const c = await one<{ company_name: string; gstin: string | null; contact_person: string | null; phone: string | null; email: string | null; address: string | null }>(
      this.deps.db,
      'SELECT company_name, gstin, contact_person, phone, email, address FROM company_profile WHERE id = 1',
    ).catch(() => undefined);
    return {
      version: APP_VERSION,
      installId: this.deps.config.installId,
      hostname: this.deps.config.hostname || hostname(),
      site: c ? { company: c.company_name, gstin: c.gstin, contact: c.contact_person, phone: c.phone, email: c.email, address: c.address?.slice(0, 500) ?? null } : null,
    };
  }

  async info(): Promise<LicenseInfo> {
    const ev = await this.refresh();
    const row = (await one<StateRow>(this.deps.db, 'SELECT * FROM license_state WHERE id = 1'))!;
    const { license } = this.verifyLicense(row.license_blob);
    const revocation = this.verifyRevocation(row.revocation_blob);
    const state = this.openSealed<SealedState>(row.state_seal);
    const fp = await this.fingerprint();
    const now = this.now();
    let lic: LicenseInfo['license'] = null;
    if (license) {
      const { activation, format: _f, product: _p, ...rest } = license;
      lic = { ...rest, activationMode: activation.mode, licensedMachineId: activation.machineId, amcActive: Boolean(license.amcExpiresAt && new Date(license.amcExpiresAt) > now) };
    }
    return {
      status: ev.status,
      mode: ev.mode,
      reason: ev.reason,
      warning: ev.warning,
      graceEndsAt: iso(ev.graceEndsAt),
      deadline: iso(ev.deadline),
      license: lic,
      usage: await this.usage(),
      machine: { id: fp.machineId, available: fp.available, changed: ev.match?.changed ?? [] },
      activation: {
        at: iso(row.activated_at),
        lastValidatedAt: iso(row.last_validated_at),
        lastHeartbeatAt: iso(row.last_heartbeat_at),
        heartbeatFailures: row.heartbeat_failures,
        lastError: row.last_heartbeat_error,
        serverUrl: this.serverUrl,
      },
      revocation: revocation && license && revocation.licenseId === license.licenseId ? { reason: revocation.reason, message: revocation.message, at: revocation.issuedAt } : null,
      integrity: this.integrityResult.status,
      installedAt: state?.installedAt ?? iso(row.activated_at) ?? now.toISOString(),
    };
  }

  // ------------------------------------------------------------ License Server calls

  private async call<T>(path: string, body: unknown): Promise<T> {
    const f = this.opts.fetch ?? fetch;
    let res: Response;
    try {
      res = await f(`${this.serverUrl}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': `VayronePostMaster/${APP_VERSION}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      throw new LicenseActionError('NETWORK', `Could not reach the Vayrone License Server at ${this.serverUrl} (${cause?.code ?? cause?.message ?? (e as Error).message}). Check internet access, or use offline activation.`);
    }
    const text = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new LicenseActionError('BAD_RESPONSE', `The License Server returned an unexpected response (HTTP ${res.status})`);
    }
    if (!res.ok) {
      const err = data as Partial<ApiError>;
      throw new LicenseActionError(err.error ?? `HTTP_${res.status}`, err.message ?? `License Server error (HTTP ${res.status})`);
    }
    return data as T;
  }

  /** Verifies a licence for this machine. Throws LicenseActionError with a user-facing message. */
  private async acceptLicense(text: string, current: LicensePayload | null): Promise<LicensePayload> {
    let lic: LicensePayload;
    try {
      lic = verifyDoc<LicensePayload>(LICENSE_FORMAT, text, this.keys).payload;
    } catch (e) {
      throw new LicenseActionError(e instanceof LicenseFormatError ? e.code : 'MALFORMED', (e as Error).message);
    }
    if (lic.product !== 'postmaster') throw new LicenseActionError('WRONG_PRODUCT', 'This licence is for another Vayrone product');
    const fp = await this.fingerprint(true);
    if (!matchFingerprint(lic.activation.components, fp.components).ok) {
      throw new LicenseActionError('WRONG_MACHINE', `This licence file was issued for machine ${lic.activation.machineId}; this server is ${fp.machineId}. Generate a new request file on this server.`);
    }
    if (current && current.licenseId === lic.licenseId && lic.issuedAt < current.issuedAt) {
      throw new LicenseActionError('OLDER_FILE', 'This licence file is older than the one already installed');
    }
    return lic;
  }

  private async storeLicense(blob: string, lic: LicensePayload, secret: SealedSecret | 'keep', how: 'activated' | 'offline_import' | 'heartbeat_ok'): Promise<void> {
    const now = this.now();
    await tx(this.deps.db, async (c) => {
      const row = await this.lockRow(c);
      const state = await this.loadState(c, row);
      state.mismatch = null;
      // A fresh signed server time that agrees with our clock proves the clock
      // is right, so a high-water mark from an earlier wrong clock is reset.
      if (Math.abs(new Date(lic.issuedAt).getTime() - now.getTime()) < TIME_CONFIRM_MS) state.highWater = now.toISOString();
      const params: unknown[] = [blob, this.seal(state), lic.activation.mode, now];
      let sql = 'UPDATE license_state SET license_blob = ?, revocation_blob = NULL, state_seal = ?, activation_mode = ?, last_validated_at = ?';
      if (how !== 'heartbeat_ok') {
        sql += ', activated_at = ?, heartbeat_failures = 0, last_heartbeat_error = NULL';
        params.push(now);
      }
      if (secret !== 'keep') {
        sql += ', secret_seal = ?';
        params.push(this.seal(secret));
      }
      await exec(c, `${sql}, updated_at = ? WHERE id = 1`, [...params, now]);
      if (how !== 'heartbeat_ok') await this.event(c, how, { licenseId: lic.licenseId, plan: lic.plan.code, maxUsers: lic.maxUsers, expiresAt: lic.expiresAt, machineId: lic.activation.machineId });
    });
  }

  private async current(): Promise<{ row: StateRow; license: LicensePayload | null; secret: SealedSecret }> {
    const row = (await one<StateRow>(this.deps.db, 'SELECT * FROM license_state WHERE id = 1')) ?? ({ license_blob: null, secret_seal: null } as StateRow);
    return { row, license: this.verifyLicense(row.license_blob).license, secret: this.openSealed<SealedSecret>(row.secret_seal) ?? { key: null, token: null, activationId: null } };
  }

  /** Online activation with a licence key. */
  async activateOnline(keyInput: string): Promise<Evaluation> {
    const key = normalizeLicenseKey(keyInput);
    if (!key) throw new LicenseActionError('INVALID_KEY', 'The licence key is not valid. Check it for typing mistakes (format VPM-XXXXX-XXXXX-XXXXX-XXXXX-X).');
    const fp = await this.fingerprint(true);
    const res = await this.call<ActivateResponse>('/api/v1/activate', { key, machine: { id: fp.machineId, components: fp.components }, product: await this.product(), usage: await this.usage() });
    const { license: current } = await this.current();
    const lic = await this.acceptLicense(res.license, current);
    await this.storeLicense(res.license, lic, { key, token: res.token, activationId: lic.activation.id }, 'activated');
    this.deps.log?.info({ licenseId: lic.licenseId }, 'licence activated online');
    return this.refresh();
  }

  /** True when an online install should call the heartbeat endpoint now. */
  async heartbeatDue(): Promise<boolean> {
    const { row, license } = await this.current();
    if (!license || license.activation.mode !== 'online') return false;
    if (!row.last_heartbeat_at) return true;
    const wait = row.heartbeat_failures > 0 ? HEARTBEAT_RETRY_MS : license.heartbeatHours * 3600_000;
    return this.now().getTime() - new Date(row.last_heartbeat_at).getTime() >= wait;
  }

  async heartbeat(): Promise<{ ok: boolean; error?: string; skipped?: boolean }> {
    const { license, secret } = await this.current();
    if (!license || license.activation.mode !== 'online') return { ok: false, skipped: true };
    const now = this.now();
    const fp = await this.fingerprint(true);
    try {
      if (!secret.token || secret.activationId !== license.activation.id) throw new LicenseActionError('BAD_TOKEN', 'This install has no activation token for the current licence. Activate online again.');
      const res = await this.call<HeartbeatResponse>('/api/v1/heartbeat', {
        licenseId: license.licenseId,
        activationId: license.activation.id,
        token: secret.token,
        machine: { id: fp.machineId, components: fp.components },
        product: await this.product(),
        usage: await this.usage(),
      });
      if (res.revocation) {
        const r = verifyDoc<RevocationPayload>(REVOCATION_FORMAT, res.revocation, this.keys).payload;
        if (r.licenseId === license.licenseId && r.activationId === license.activation.id) {
          await exec(this.deps.db, 'UPDATE license_state SET revocation_blob = ?, last_heartbeat_at = ?, heartbeat_failures = 0, last_heartbeat_error = NULL, updated_at = ? WHERE id = 1', [res.revocation, now, now]);
          await this.event(this.deps.db, 'revoked', { reason: r.reason, message: r.message });
          await this.refresh();
          return { ok: true };
        }
      }
      if (res.license) {
        const lic = await this.acceptLicense(res.license, license);
        if (lic.licenseId !== license.licenseId) throw new LicenseActionError('MISMATCH', 'The License Server returned a different licence');
        await this.storeLicense(res.license, lic, 'keep', 'heartbeat_ok');
      }
      await exec(this.deps.db, 'UPDATE license_state SET last_heartbeat_at = ?, heartbeat_failures = 0, last_heartbeat_error = NULL, updated_at = ? WHERE id = 1', [now, now]);
      await this.refresh();
      return { ok: true };
    } catch (e) {
      const msg = (e as Error).message.slice(0, 500);
      await exec(this.deps.db, 'UPDATE license_state SET last_heartbeat_at = ?, heartbeat_failures = heartbeat_failures + 1, last_heartbeat_error = ?, updated_at = ? WHERE id = 1', [now, msg, now]);
      const n = await one<{ heartbeat_failures: number }>(this.deps.db, 'SELECT heartbeat_failures FROM license_state WHERE id = 1');
      if (n?.heartbeat_failures === 1 || (n?.heartbeat_failures ?? 0) % 24 === 0) await this.event(this.deps.db, 'heartbeat_fail', { error: msg, failures: n?.heartbeat_failures });
      this.deps.log?.warn({ err: msg }, 'licence heartbeat failed');
      return { ok: false, error: msg };
    }
  }

  /** Releases this machine on the License Server (before moving to new hardware). */
  async deactivate(): Promise<Evaluation> {
    const { license, secret } = await this.current();
    if (!license) throw new LicenseActionError('NO_LICENSE', 'No licence is installed');
    if (license.activation.mode !== 'online' || !secret.token) {
      throw new LicenseActionError('OFFLINE', 'This licence was activated offline. Ask Vayrone (or your partner) to release it on the License Server.');
    }
    const res = await this.call<DeactivateResponse>('/api/v1/deactivate', { licenseId: license.licenseId, activationId: license.activation.id, token: secret.token });
    verifyDoc<RevocationPayload>(REVOCATION_FORMAT, res.revocation, this.keys);
    const now = this.now();
    await exec(this.deps.db, 'UPDATE license_state SET revocation_blob = ?, secret_seal = ?, updated_at = ? WHERE id = 1', [res.revocation, this.seal({ ...secret, token: null }), now]);
    await this.event(this.deps.db, 'deactivated', { licenseId: license.licenseId });
    return this.refresh();
  }

  /** Activation/re-validation request file for offline installs. */
  async offlineRequest(keyInput?: string | null): Promise<{ fileName: string; text: string }> {
    const { license, secret } = await this.current();
    let key: string | null = null;
    if (keyInput) {
      key = normalizeLicenseKey(keyInput);
      if (!key) throw new LicenseActionError('INVALID_KEY', 'The licence key is not valid. Check it for typing mistakes.');
    } else if (!license) {
      key = secret.key;
      if (!key) throw new LicenseActionError('NEED_KEY', 'Enter the licence key to create an activation request');
    }
    const fp = await this.fingerprint(true);
    const text = encodeRequest({
      format: REQUEST_FORMAT,
      key,
      licenseId: key ? null : license!.licenseId,
      machine: { id: fp.machineId, components: fp.components },
      product: await this.product(),
      usage: await this.usage(),
      createdAt: this.now().toISOString(),
      nonce: newNonce(),
    });
    if (key) await exec(this.deps.db, 'UPDATE license_state SET secret_seal = ?, updated_at = ? WHERE id = 1', [this.seal({ ...secret, key }), this.now()]);
    await this.event(this.deps.db, 'offline_request', { machineId: fp.machineId, licenseId: license?.licenseId ?? null });
    return { fileName: `postmaster-request-${fp.machineId.slice(0, 11)}.vreq`, text };
  }

  /** Imports a licence file (offline activation/renewal) or a revocation notice. */
  async importFile(text: string): Promise<Evaluation> {
    if (text.includes('REVOCATION-----')) throw new LicenseActionError('WRONG_TYPE', 'This is a revocation notice, not a licence file');
    if (text.includes('ACTIVATION REQUEST-----')) throw new LicenseActionError('WRONG_TYPE', 'This is the request file. Send it to Vayrone Infratech or your partner, then import the licence file you receive.');
    const { license: current, secret } = await this.current();
    const lic = await this.acceptLicense(text, current);
    const keep = secret.activationId === lic.activation.id ? secret : { key: secret.key, token: null, activationId: lic.activation.id };
    await this.storeLicense(text.trim(), lic, keep, 'offline_import');
    return this.refresh();
  }
}

export async function openLicense(deps: LicenseDeps, opts: LicenseManagerOptions = {}): Promise<LicenseManager> {
  return LicenseManager.open(deps, opts);
}
