// Activation, heartbeat, deactivation and offline processing. Used by the
// product REST API (/api/v1), the public offline portal and the admin UI.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { decodeRequest, LicenseFormatError, normalizeLicenseKey, type Components } from '@vpm/license-client/format';
import { matchFingerprint } from '@vpm/license-client/fingerprint';
import type { ActivateResponse, DeactivateResponse, HeartbeatResponse } from '@vpm/license-client/protocol';
import { exec, json, one, rows, tx, type Db, type Q } from '../db.js';
import { sha256 } from '../crypto.js';
import type { Signer } from '../signer.js';

const DAY = 86_400_000;

export class ApiFail extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

const Hash = z.string().regex(/^[0-9a-f]{32}$/).nullable();
const Machine = z.object({
  id: z.string().min(5).max(32),
  components: z.object({ os: Hash, board: Hash, uuid: Hash, disk: Hash, cpu: Hash }),
});
const Site = z
  .object({
    company: z.string().max(200),
    gstin: z.string().max(15).nullable(),
    contact: z.string().max(120).nullable(),
    phone: z.string().max(32).nullable(),
    email: z.string().max(254).nullable(),
    address: z.string().max(500).nullable(),
  })
  .nullish();
const Product = z.object({ version: z.string().max(32), installId: z.string().max(64), hostname: z.string().max(253), site: Site });
const Usage = z.object({ activeUsers: z.number().int().min(0).max(1_000_000), externalAccounts: z.number().int().min(0).max(1_000_000) });
export const ActivateBody = z.object({ key: z.string().max(60), machine: Machine, product: Product, usage: Usage });
export const HeartbeatBody = z.object({ licenseId: z.string().max(32), activationId: z.string().max(32), token: z.string().max(100), machine: Machine, product: Product, usage: Usage });
export const DeactivateBody = z.object({ licenseId: z.string().max(32), activationId: z.string().max(32), token: z.string().max(100) });

export interface LicenseRow {
  id: number;
  license_id: string;
  license_key: string;
  client_id: number;
  reseller_id: number | null;
  plan_id: number;
  max_users: number;
  max_external_accounts: number | null;
  features: unknown;
  status: 'active' | 'suspended' | 'revoked';
  status_reason: string | null;
  starts_at: Date;
  expires_at: Date | null;
  amc_expires_at: Date | null;
  max_activations: number;
  heartbeat_hours: number;
  online_check_days: number;
  offline_check_days: number;
}

export interface ActivationRow {
  id: number;
  activation_id: string;
  license_id: number;
  machine_id: string;
  components: unknown;
  mode: 'online' | 'offline';
  token_hash: Buffer | null;
  status: 'active' | 'released';
  hostname: string | null;
  last_seen_at: Date;
  release_reason: string | null;
}

export interface Actor {
  userId: number | null;
  resellerId: number | null;
  ip: string | null;
}

const fmt = (d: Date) => d.toISOString().slice(0, 10);
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const newActivationId = () => `ACT-${[...randomBytes(10)].map((b) => B32[b & 31]).join('')}`;
const keyHint = (key: string) => key.replace(/-/g, '').slice(-5);

export async function logEvent(q: Q, e: { kind: string; licenseId?: number | null; activationId?: number | null; actor?: Actor | null; detail?: Record<string, unknown> | null }): Promise<void> {
  await exec(q, 'INSERT INTO events (at, license_id, activation_id, actor_user_id, kind, ip, detail) VALUES (?,?,?,?,?,?,?)', [
    new Date(),
    e.licenseId ?? null,
    e.activationId ?? null,
    e.actor?.userId ?? null,
    e.kind,
    e.actor?.ip ?? null,
    e.detail ? JSON.stringify(e.detail) : null,
  ]);
}

export class Licensing {
  constructor(
    private readonly db: Db,
    private readonly signer: Signer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Builds and signs the licence file for one activation. */
  async issue(q: Q, lic: LicenseRow, act: Pick<ActivationRow, 'activation_id' | 'machine_id' | 'components' | 'mode'>): Promise<string> {
    const client = await one<{ company: string; contact_name: string | null; email: string | null; phone: string | null; city: string | null; gstin: string | null }>(q, 'SELECT * FROM clients WHERE id = ?', [lic.client_id]);
    const plan = await one<{ code: string; name: string }>(q, 'SELECT code, name FROM plans WHERE id = ?', [lic.plan_id]);
    const reseller = lic.reseller_id ? await one<{ name: string }>(q, 'SELECT name FROM resellers WHERE id = ?', [lic.reseller_id]) : null;
    const now = this.now();
    return this.signer.license({
      licenseId: lic.license_id,
      keyHint: keyHint(lic.license_key),
      client: { name: client!.company, contact: client!.contact_name, email: client!.email, phone: client!.phone, city: client!.city, gstin: client!.gstin },
      reseller: reseller ? { name: reseller.name } : null,
      plan: { code: plan!.code, name: plan!.name },
      maxUsers: lic.max_users,
      maxExternalAccounts: lic.max_external_accounts,
      features: json<string[]>(lic.features),
      issuedAt: now.toISOString(),
      expiresAt: lic.expires_at ? new Date(lic.expires_at).toISOString() : null,
      amcExpiresAt: lic.amc_expires_at ? new Date(lic.amc_expires_at).toISOString() : null,
      checkBy: new Date(now.getTime() + (act.mode === 'online' ? lic.online_check_days : lic.offline_check_days) * DAY).toISOString(),
      heartbeatHours: lic.heartbeat_hours,
      activation: { id: act.activation_id, mode: act.mode, machineId: act.machine_id, components: json<Components>(act.components) },
    });
  }

  private assertUsable(lic: LicenseRow): void {
    if (lic.status === 'suspended') throw new ApiFail(403, 'LICENSE_SUSPENDED', `This licence is suspended${lic.status_reason ? `: ${lic.status_reason}` : ''}. Contact Vayrone or your partner.`);
    if (lic.status === 'revoked') throw new ApiFail(403, 'LICENSE_REVOKED', 'This licence has been revoked. Contact Vayrone or your partner.');
    if (lic.expires_at && new Date(lic.expires_at) < this.now()) throw new ApiFail(403, 'LICENSE_EXPIRED', `This licence expired on ${fmt(new Date(lic.expires_at))}. Renew it first.`);
  }

  private async findByKey(q: Q, keyInput: string, lock = false): Promise<LicenseRow> {
    const key = normalizeLicenseKey(keyInput);
    const lic = key ? await one<LicenseRow>(q, `SELECT * FROM licenses WHERE license_key = ?${lock ? ' FOR UPDATE' : ''}`, [key]) : undefined;
    if (!lic) throw new ApiFail(404, 'INVALID_KEY', 'This licence key does not exist. Check it for typing mistakes.');
    return lic;
  }

  /**
   * Finds the activation for this machine (same hardware, at most one part
   * changed) or creates a new one if a slot is free.
   */
  private async bind(c: Q, lic: LicenseRow, machine: z.infer<typeof Machine>, mode: 'online' | 'offline', meta: { product?: z.infer<typeof Product>; usage?: z.infer<typeof Usage>; ip: string | null }, actor: Actor | null) {
    const active = await rows<ActivationRow>(c, "SELECT * FROM activations WHERE license_id = ? AND status = 'active' ORDER BY id", [lic.id]);
    const same = active.find((a) => matchFingerprint(json<Components>(a.components), machine.components).ok);
    const token = mode === 'online' ? randomBytes(32).toString('base64url') : null;
    const now = this.now();
    const fields = {
      machine_id: machine.id,
      components: JSON.stringify(machine.components),
      mode,
      token_hash: token ? sha256(token) : null,
      last_seen_at: now,
      last_ip: meta.ip,
      product_version: meta.product?.version ?? null,
      install_id: meta.product?.installId ?? null,
      hostname: meta.product?.hostname ?? null,
      active_users: meta.usage?.activeUsers ?? null,
      external_accounts: meta.usage?.externalAccounts ?? null,
      ...(meta.product?.site ? { site: JSON.stringify(meta.product.site) } : {}),
    };
    let act: Pick<ActivationRow, 'id' | 'activation_id' | 'machine_id' | 'components' | 'mode'>;
    if (same) {
      await exec(c, 'UPDATE activations SET ? WHERE id = ?', [fields, same.id]);
      act = { id: same.id, activation_id: same.activation_id, machine_id: machine.id, components: machine.components, mode };
      await logEvent(c, { kind: 'reactivate', licenseId: lic.id, activationId: same.id, actor, detail: { mode, machineId: machine.id, hostname: fields.hostname } });
    } else {
      if (active.length >= lic.max_activations) {
        const a = active[0]!;
        throw new ApiFail(
          409,
          'ALREADY_ACTIVATED',
          `This licence is already in use on server ${a.hostname ?? ''} (machine ${a.machine_id}, last seen ${fmt(new Date(a.last_seen_at))}). Deactivate it on that server's Licence page, or ask Vayrone or your partner to transfer it.`.replace('server  (', 'another server ('),
        );
      }
      const activationId = newActivationId();
      const r = await exec(c, 'INSERT INTO activations SET ?', [{ ...fields, activation_id: activationId, license_id: lic.id, status: 'active', activated_at: now }]);
      act = { id: r.insertId, activation_id: activationId, machine_id: machine.id, components: machine.components, mode };
      await logEvent(c, { kind: 'activate', licenseId: lic.id, activationId: r.insertId, actor, detail: { mode, machineId: machine.id, hostname: fields.hostname, version: fields.product_version } });
    }
    if (meta.usage) await this.recordUsage(c, lic.id, meta.usage, meta.product?.version ?? null);
    return { act, token };
  }

  private async recordUsage(q: Q, licenseId: number, u: z.infer<typeof Usage>, version: string | null): Promise<void> {
    await exec(
      q,
      `INSERT INTO usage_daily (day, license_id, active_users, external_accounts, product_version) VALUES (?,?,?,?,?)
       ON DUPLICATE KEY UPDATE active_users = VALUES(active_users), external_accounts = VALUES(external_accounts), product_version = VALUES(product_version)`,
      [this.now().toISOString().slice(0, 10), licenseId, u.activeUsers, u.externalAccounts, version],
    );
  }

  async activate(body: unknown, ip: string | null): Promise<ActivateResponse> {
    const b = ActivateBody.parse(body);
    return tx(this.db, async (c) => {
      const lic = await this.findByKey(c, b.key, true);
      this.assertUsable(lic);
      const { act, token } = await this.bind(c, lic, b.machine, 'online', { product: b.product, usage: b.usage, ip }, { userId: null, resellerId: null, ip });
      return { license: await this.issue(c, lic, act), token: token! };
    });
  }

  private async authActivation(q: Q, licenseId: string, activationId: string, token: string): Promise<{ lic: LicenseRow; act: ActivationRow }> {
    const act = await one<ActivationRow>(q, 'SELECT a.* FROM activations a JOIN licenses l ON l.id = a.license_id WHERE a.activation_id = ? AND l.license_id = ?', [activationId, licenseId]);
    if (!act) throw new ApiFail(404, 'ACTIVATION_NOT_FOUND', 'This activation is not known to the License Server. Activate again with the licence key.');
    const h = sha256(token);
    if (!act.token_hash || act.token_hash.length !== h.length || !timingSafeEqual(Buffer.from(act.token_hash), h)) {
      throw new ApiFail(401, 'BAD_TOKEN', 'The activation token does not match. Activate again with the licence key.');
    }
    const lic = (await one<LicenseRow>(q, 'SELECT * FROM licenses WHERE id = ?', [act.license_id]))!;
    return { lic, act };
  }

  private revocationFor(lic: LicenseRow, act: ActivationRow): string | null {
    const base = { licenseId: lic.license_id, activationId: act.activation_id, issuedAt: this.now().toISOString() };
    if (act.status === 'released') return this.signer.revocation({ ...base, reason: 'transferred', message: act.release_reason ?? '' });
    if (lic.status === 'suspended') return this.signer.revocation({ ...base, reason: 'suspended', message: lic.status_reason ?? '' });
    if (lic.status === 'revoked') return this.signer.revocation({ ...base, reason: 'revoked', message: lic.status_reason ?? '' });
    return null;
  }

  async heartbeat(body: unknown, ip: string | null): Promise<HeartbeatResponse> {
    const b = HeartbeatBody.parse(body);
    return tx(this.db, async (c) => {
      const { lic, act } = await this.authActivation(c, b.licenseId, b.activationId, b.token);
      const now = this.now();
      const revocation = this.revocationFor(lic, act);
      if (revocation) return { revocation, serverTime: now.toISOString() };
      const m = matchFingerprint(json<Components>(act.components), b.machine.components);
      const update: Record<string, unknown> = {
        last_seen_at: now,
        last_ip: ip,
        product_version: b.product.version,
        hostname: b.product.hostname,
        active_users: b.usage.activeUsers,
        external_accounts: b.usage.externalAccounts,
        ...(b.product.site ? { site: JSON.stringify(b.product.site) } : {}),
      };
      if (m.ok) {
        // Follow gradual hardware upgrades (one part at a time).
        update.components = JSON.stringify(b.machine.components);
        update.machine_id = b.machine.id;
        if (m.changed.length) await logEvent(c, { kind: 'hardware_changed', licenseId: lic.id, activationId: act.id, actor: { userId: null, resellerId: null, ip }, detail: { changed: m.changed } });
      } else {
        await logEvent(c, { kind: 'clone_suspected', licenseId: lic.id, activationId: act.id, actor: { userId: null, resellerId: null, ip }, detail: { machineId: b.machine.id, activatedOn: act.machine_id, changed: m.changed, hostname: b.product.hostname } });
      }
      await exec(c, 'UPDATE activations SET ? WHERE id = ?', [update, act.id]);
      await this.recordUsage(c, lic.id, b.usage, b.product.version);
      const fresh = (await one<ActivationRow>(c, 'SELECT * FROM activations WHERE id = ?', [act.id]))!;
      return { license: await this.issue(c, lic, fresh), serverTime: now.toISOString() };
    });
  }

  async deactivate(body: unknown, ip: string | null): Promise<DeactivateResponse> {
    const b = DeactivateBody.parse(body);
    return tx(this.db, async (c) => {
      const { lic, act } = await this.authActivation(c, b.licenseId, b.activationId, b.token);
      if (act.status === 'active') {
        await exec(c, "UPDATE activations SET status = 'released', released_at = ?, release_reason = ?, token_hash = NULL WHERE id = ?", [this.now(), 'Deactivated on the server for transfer', act.id]);
        await logEvent(c, { kind: 'deactivate', licenseId: lic.id, activationId: act.id, actor: { userId: null, resellerId: null, ip }, detail: { machineId: act.machine_id } });
      }
      const released = (await one<ActivationRow>(c, 'SELECT * FROM activations WHERE id = ?', [act.id]))!;
      return { revocation: this.revocationFor(lic, released)! };
    });
  }

  /**
   * Offline activation / re-validation from a request file. `scope` limits a
   * reseller to their own licences; the public portal passes no scope.
   */
  async processOffline(text: string, actor: Actor, scope: { resellerId: number | null } | null = null): Promise<{ license: string; fileName: string; licenseId: string; activationId: string; client: string }> {
    let r;
    try {
      r = decodeRequest(text);
    } catch (e) {
      throw new ApiFail(400, 'BAD_REQUEST', e instanceof LicenseFormatError ? e.message : 'The request file is damaged');
    }
    const machine = Machine.safeParse(r.machine);
    if (!machine.success) throw new ApiFail(400, 'BAD_REQUEST', 'The request file is damaged (machine data)');
    return tx(this.db, async (c) => {
      let lic: LicenseRow;
      if (r.key) lic = await this.findByKey(c, r.key, true);
      else {
        const l = await one<LicenseRow>(c, 'SELECT * FROM licenses WHERE license_id = ? FOR UPDATE', [r.licenseId]);
        if (!l) throw new ApiFail(404, 'INVALID_KEY', 'The licence in this request does not exist');
        lic = l;
        // Re-validation without the key only works for the machine it is activated on.
        const active = await rows<ActivationRow>(c, "SELECT * FROM activations WHERE license_id = ? AND status = 'active'", [lic.id]);
        if (!active.some((a) => matchFingerprint(json<Components>(a.components), machine.data.components).ok)) {
          throw new ApiFail(409, 'ALREADY_ACTIVATED', 'This server is not the one the licence is activated on. Create the request with the licence key instead.');
        }
      }
      if (scope && scope.resellerId !== null && lic.reseller_id !== scope.resellerId) throw new ApiFail(404, 'INVALID_KEY', 'This licence key does not exist');
      this.assertUsable(lic);
      const product = Product.safeParse(r.product);
      const { act } = await this.bind(c, lic, machine.data, 'offline', { ...(product.success ? { product: product.data } : {}), usage: r.usage, ip: actor.ip }, actor);
      const license = await this.issue(c, lic, act);
      await logEvent(c, { kind: 'offline_issue', licenseId: lic.id, activationId: act.id, actor, detail: { machineId: machine.data.id, hostname: r.product.hostname, requestCreatedAt: r.createdAt } });
      const client = (await one<{ company: string }>(c, 'SELECT company FROM clients WHERE id = ?', [lic.client_id]))!.company;
      return { license, fileName: `${lic.license_id}-${machine.data.id.slice(0, 5)}.vlic`, licenseId: lic.license_id, activationId: act.activation_id, client };
    });
  }

  /** Frees an activation slot (machine transfer). Online installs learn it at their next heartbeat. */
  async release(activationDbId: number, actor: Actor, reason: string): Promise<void> {
    await tx(this.db, async (c) => {
      const a = await one<ActivationRow>(c, 'SELECT * FROM activations WHERE id = ? FOR UPDATE', [activationDbId]);
      if (!a || a.status !== 'active') return;
      await exec(c, "UPDATE activations SET status = 'released', released_at = ?, release_reason = ? WHERE id = ?", [this.now(), reason.slice(0, 200), a.id]);
      await logEvent(c, { kind: 'transfer', licenseId: a.license_id, activationId: a.id, actor, detail: { machineId: a.machine_id, hostname: a.hostname, reason } });
    });
  }
}
