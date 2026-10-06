// License Server commands (setup, and licensing from the command line).
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createPrivateKey } from 'node:crypto';
import { decodeRequest, generateLicenseKey, LICENSE_FORMAT, signDoc, type LicensePayload } from '@vpm/license-client/format';
import { loadLsConfig } from './config.js';
import { createPool, exec, one, type Db } from './db.js';
import { migrate } from './migrate.js';
import { hashPassword } from './crypto.js';
import { Signer } from './signer.js';
import { Licensing } from './services/licensing.js';

const USAGE = `Usage: vls-cli <command>      (database commands read LS_CONFIG)
Setup
  migrate                               Create / upgrade the License Server database
  secret:gen <file>                     Create the settings encryption key file (64 hex)
  owner:add <email> <password> [name]   Create an owner login
  plans:seed                            Create the standard plans (edit prices afterwards in Plans)
Licensing
  client:add --company <name> [--email e] [--phone p] [--whatsapp w] [--city c] [--gstin g] [--contact name]
  license:create --client <id> --plan <code> --users <n> [--months 12] [--activations 1] [--amount ₹] [--invoice no]
                                        Prints the licence key to give to the client
  license:list [--client <id>]          Licences with key, users, expiry
  license:offline <request.vreq> [--out file.vlic]
                                        Issue the licence file for an offline server's request
Without a License Server (signing key only)
  license:issue-file <request.vreq> --key <private.pem> --kid <id> --client <name> --plan <code> --plan-name <name>
                     --users <n> [--months 12 | --perpetual] [--amc-months 12] [--features archive,journaling,…]
                     [--offline-days 365] [--license-id LIC-…] [--out file.vlic]`;

function flags(a: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i]!;
    if (!k.startsWith('--')) continue;
    const v = a[i + 1];
    if (v !== undefined && !v.startsWith('--')) {
      out[k.slice(2)] = v;
      i++;
    } else out[k.slice(2)] = true;
  }
  return out;
}

const DAY = 86_400_000;
const addMonths = (d: Date, m: number) => {
  const x = new Date(d);
  x.setUTCMonth(x.getUTCMonth() + m);
  return x;
};

/** Example plans; prices are placeholders to be set by Vayrone in the admin UI. */
const STANDARD_PLANS = [
  { code: 'starter', name: 'Starter', min: 5, features: ['archive', 'journaling', 'external_fetch'], slabs: [{ upTo: 25, pricePerUser: 1200 }, { upTo: null, pricePerUser: 1000 }], term: 12, amc: 0, ext: 50 },
  { code: 'business', name: 'Business', min: 10, features: ['archive', 'journaling', 'external_fetch', 'support_access', 'antivirus'], slabs: [{ upTo: 50, pricePerUser: 1500 }, { upTo: 200, pricePerUser: 1300 }, { upTo: null, pricePerUser: 1100 }], term: 12, amc: 0, ext: null },
  { code: 'enterprise', name: 'Enterprise', min: 50, features: ['archive', 'journaling', 'external_fetch', 'support_access', 'antivirus', 'backup_cloud'], slabs: [{ upTo: 200, pricePerUser: 1800 }, { upTo: null, pricePerUser: 1500 }], term: 12, amc: 0, ext: null },
  { code: 'perpetual', name: 'Perpetual (one-time)', min: 10, features: ['archive', 'journaling', 'external_fetch', 'support_access'], slabs: [{ upTo: 50, pricePerUser: 4000 }, { upTo: null, pricePerUser: 3500 }], term: 0, amc: 20, ext: null },
];

async function withDb<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const config = loadLsConfig();
  const db = createPool(config.db);
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function nextLicenseId(db: Db, prefix: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  await exec(db, 'INSERT INTO id_counters (name, value) VALUES (?, LAST_INSERT_ID(1)) ON DUPLICATE KEY UPDATE value = LAST_INSERT_ID(value + 1)', [`lic${year}`]);
  const r = await one<{ id: number }>(db, 'SELECT LAST_INSERT_ID() id');
  return `${prefix}-${year}-${String(r!.id).padStart(6, '0')}`;
}

export async function run([cmd, ...a]: string[]): Promise<void> {
  const f = flags(a);
  const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
  const need = (k: string) => str(k) ?? (() => { throw new Error(`--${k} is required`); })();

  switch (cmd) {
    case 'secret:gen': {
      if (!a[0]) throw new Error('file required');
      if (existsSync(a[0])) throw new Error(`${a[0]} already exists`);
      writeFileSync(a[0], randomBytes(32).toString('hex'), { mode: 0o600 });
      return console.log(`Written ${a[0]} (keep it with the database backups; credentials in settings need it)`);
    }
    case 'migrate': {
      const config = loadLsConfig();
      const r = await migrate(config.db, config.migrationsPath, console.log);
      return console.log(`Applied: ${r.join(', ') || 'nothing (up to date)'}`);
    }
    case 'owner:add': {
      const [email, password, name] = a;
      if (!email || !password || password.length < 10) throw new Error('email and a password of at least 10 characters required');
      const hash = await hashPassword(password);
      await withDb((db) => exec(db, "INSERT INTO staff_users (email, name, password_hash, role, created_at) VALUES (?,?,?,'owner',?)", [email.toLowerCase(), name ?? email, hash, new Date()]));
      return console.log(`Owner ${email} created`);
    }
    case 'plans:seed': {
      await withDb(async (db) => {
        for (const p of STANDARD_PLANS) {
          const now = new Date();
          const r = await exec(
            db,
            `INSERT IGNORE INTO plans (code, name, description, features, max_external_accounts, min_users, slabs, term_months, amc_pct, is_active, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,?,1,?,?)`,
            [p.code, p.name, 'Example prices — set your prices in Plans & pricing', JSON.stringify(p.features), p.ext, p.min, JSON.stringify(p.slabs), p.term, p.amc, now, now],
          );
          console.log(`${r.affectedRows ? 'Created' : 'Exists '}  ${p.code.padEnd(11)} ${p.name}`);
        }
      });
      return;
    }
    case 'client:add': {
      const company = need('company');
      const id = await withDb(async (db) => {
        const now = new Date();
        const r = await exec(db, 'INSERT INTO clients (company, contact_name, email, phone, whatsapp, city, gstin, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)', [
          company,
          str('contact') ?? null,
          str('email') ?? null,
          str('phone') ?? null,
          str('whatsapp') ?? null,
          str('city') ?? null,
          str('gstin')?.toUpperCase() ?? null,
          now,
          now,
        ]);
        return r.insertId;
      });
      return console.log(`Client ${id}: ${company}`);
    }
    case 'license:create': {
      const config = loadLsConfig();
      await withDb(async (db) => {
        const client = await one<{ id: number; company: string; reseller_id: number | null }>(db, 'SELECT id, company, reseller_id FROM clients WHERE id = ?', [Number(need('client'))]);
        if (!client) throw new Error('No such client (see client:add)');
        const plan = await one<{ id: number; features: unknown; max_external_accounts: number | null; term_months: number; min_users: number }>(db, 'SELECT * FROM plans WHERE code = ?', [need('plan')]);
        if (!plan) throw new Error('No such plan (see plans:seed or the Plans page)');
        const users = Number(need('users'));
        if (!(users >= plan.min_users)) throw new Error(`This plan needs at least ${plan.min_users} users`);
        const starts = new Date();
        const term = str('months') ? Number(str('months')) : plan.term_months;
        const expires = term === 0 ? null : addMonths(starts, term);
        const amc = addMonths(starts, term === 0 ? 12 : term);
        const key = generateLicenseKey();
        const licenseId = await nextLicenseId(db, config.licenseIdPrefix);
        const now = new Date();
        const r = await exec(db, 'INSERT INTO licenses SET ?', [
          {
            license_id: licenseId,
            license_key: key,
            client_id: client.id,
            reseller_id: client.reseller_id,
            plan_id: plan.id,
            max_users: users,
            max_external_accounts: plan.max_external_accounts,
            features: typeof plan.features === 'string' ? plan.features : JSON.stringify(plan.features),
            status: 'active',
            starts_at: starts,
            expires_at: expires,
            amc_expires_at: amc,
            max_activations: Number(str('activations') ?? 1),
            notes: 'Created with vls-cli',
            created_at: now,
            updated_at: now,
          },
        ]);
        await exec(db, "INSERT INTO renewals (license_id, kind, period_from, period_to, users, amount, invoice_ref, created_at) VALUES (?, 'new', ?, ?, ?, ?, ?, ?)", [
          r.insertId,
          starts,
          expires ?? amc,
          users,
          Number(str('amount') ?? 0),
          str('invoice') ?? null,
          now,
        ]);
        await exec(db, "INSERT INTO events (at, license_id, kind, detail) VALUES (?, ?, 'license_create', ?)", [now, r.insertId, JSON.stringify({ via: 'cli', users })]);
        console.log(`Licence ${licenseId} for ${client.company}: ${users} users, ${expires ? `until ${expires.toISOString().slice(0, 10)}` : 'perpetual'}`);
        console.log(`Licence key: ${key}`);
      });
      return;
    }
    case 'license:list': {
      await withDb(async (db) => {
        const list = (await db.query(
          `SELECT l.license_id, l.license_key, c.company, p.code plan, l.max_users, l.status, l.expires_at,
             (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id AND a.status = 'active') act
           FROM licenses l JOIN clients c ON c.id = l.client_id JOIN plans p ON p.id = l.plan_id ${str('client') ? 'WHERE l.client_id = ?' : ''} ORDER BY l.id DESC LIMIT 200`,
          str('client') ? [Number(str('client'))] : [],
        ))[0] as Record<string, unknown>[];
        for (const l of list) {
          console.log(`${l.license_id}  ${l.license_key}  ${String(l.company).slice(0, 28).padEnd(28)} ${String(l.plan).padEnd(10)} ${String(l.max_users).padStart(5)} users  ${l.status}  ${l.expires_at ? new Date(l.expires_at as Date).toISOString().slice(0, 10) : 'perpetual'}  servers:${l.act}`);
        }
      });
      return;
    }
    case 'license:offline': {
      if (!a[0]) throw new Error('request file required');
      const config = loadLsConfig();
      const signer = Signer.fromFile(config.signingKeyFile, config.signingKeyId);
      await withDb(async (db) => {
        const r = await new Licensing(db, signer).processOffline(readFileSync(a[0]!, 'utf8'), { userId: null, resellerId: null, ip: null });
        const out = str('out') ?? r.fileName;
        writeFileSync(out, r.license);
        console.log(`Licence file for ${r.client} (${r.licenseId}) written to ${out}`);
      });
      return;
    }
    case 'license:issue-file': {
      // No database: signs a licence for the machine in the request file directly.
      if (!a[0]) throw new Error('request file required');
      const req = decodeRequest(readFileSync(a[0], 'utf8'));
      const key = createPrivateKey(readFileSync(need('key'), 'utf8'));
      const now = new Date();
      const perpetual = f.perpetual === true;
      const months = Number(str('months') ?? 12);
      const p: LicensePayload = {
        format: LICENSE_FORMAT,
        product: 'postmaster',
        licenseId: str('license-id') ?? `LIC-${now.getUTCFullYear()}-F${randomBytes(3).toString('hex').toUpperCase()}`,
        keyHint: (req.key ?? 'FILE').replace(/-/g, '').slice(-5),
        client: { name: need('client'), email: str('email') ?? null, phone: str('phone') ?? null, city: str('city') ?? null, gstin: str('gstin') ?? null, contact: str('contact') ?? null },
        reseller: str('reseller') ? { name: str('reseller')! } : null,
        plan: { code: need('plan'), name: str('plan-name') ?? need('plan') },
        maxUsers: Number(need('users')),
        maxExternalAccounts: str('external') ? Number(str('external')) : null,
        features: (str('features') ?? 'archive,journaling,external_fetch,support_access').split(',').map((x) => x.trim()).filter(Boolean),
        issuedAt: now.toISOString(),
        expiresAt: perpetual ? null : addMonths(now, months).toISOString(),
        amcExpiresAt: addMonths(now, Number(str('amc-months') ?? (perpetual ? 12 : months))).toISOString(),
        checkBy: new Date(now.getTime() + Number(str('offline-days') ?? 365) * DAY).toISOString(),
        heartbeatHours: 24,
        activation: { id: `ACT-F${randomBytes(5).toString('hex').toUpperCase()}`, mode: 'offline', machineId: req.machine.id, components: req.machine.components },
      };
      const out = str('out') ?? `${p.licenseId}-${req.machine.id.slice(0, 5)}.vlic`;
      writeFileSync(out, signDoc(p, key, need('kid')));
      console.log(`Licence ${p.licenseId} for ${p.client.name} (${p.maxUsers} users, machine ${req.machine.id}${req.product?.hostname ? `, ${req.product.hostname}` : ''}) written to ${out}`);
      console.log(`Expires ${p.expiresAt?.slice(0, 10) ?? 'never'}; re-validate by ${p.checkBy.slice(0, 10)}.`);
      return;
    }
    default:
      console.log(USAGE);
  }
}

if (process.argv[1] && /cli\.(ts|js|mjs)$/.test(process.argv[1])) {
  run(process.argv.slice(2)).catch((e) => {
    console.error((e as Error).message);
    process.exit(1);
  });
}
