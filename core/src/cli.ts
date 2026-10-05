// vpm cli — technician commands. The admin panel (Phase 3) replaces most of
// these for day-to-day use; they remain for setup, recovery and support.
import { readFileSync, writeFileSync } from 'node:fs';
import { createLicensedContext, collectFingerprint, privilegedHwid, LicenseManager } from '@vpm/license-client';
import { loadConfig } from './config.js';
import { initInstall, setupCompleted } from './install.js';
import { ensureSetupToken } from './control.js';
import { migrate } from './migrate.js';
import { createMasterKey } from './secrets.js';
import { runBackup, verifyBackup } from './backup/backup.js';
import { restoreFull } from './backup/restore.js';
import { indexPending } from './archive/search-index.js';
import { materializeRun, type BackupTargetRow } from './backup/service.js';
import { createInterface } from 'node:readline/promises';

const USAGE = `Usage: vpm cli <command>
  init --data <dir> [options]              First install: database, config, master key, schema, setup token
                                           (installers run this; see installer/README.md for the options)
  setup-token                              Show the setup wizard address while setup is not finished
  migrate                                  Create / upgrade the database schema
  keygen                                   Create the master encryption key (installer)
  domain:add <domain>                      Add a mail domain
  user:add <email> <password> [name] [role]  Add a mailbox user (role: user|admin|super_admin|auditor)
  staff:add <login> <password> <role> [name]  Add an account without a mailbox (admin|super_admin|auditor|vayrone_support)
  user:passwd <email> <password>           Set a user's LAN password
  folders <email>                          Show folders with UIDVALIDITY / UIDNEXT
  backup <folder> [full]                   Write a full backup to a folder now
  verify <backup-folder>                   Check every file of a backup against its manifest
  restore-full <backup-folder> [--yes]     Replace ALL server data with a backup (stop the services first!)
  backup:list                              Backups recorded on this server (id, target, folder, status)
  backup:download <run-id|dir> <folder> [--target <id>] [--passphrase <p>]
                                           Copy a backup (with its base runs) from S3/FTP into a local folder.
                                           New server (disaster recovery), give the location instead of --target:
                                             --kind s3 --endpoint <url> --region <r> --bucket <b> [--prefix <p>]
                                                       --access-key <id> --secret-key <secret> [--path-style]
                                             --kind ftp --host <h> [--port 21] [--secure explicit|implicit|none]
                                                        --user <u> --password <p> [--path /postmaster]
  reindex                                  Rebuild the full-text search index
  license                                  Show the licence status
  license:activate <key>                   Activate online with a licence key
  license:request [key] [file]             Write an offline activation / re-validation request file
  license:import <file>                    Import a licence file from the Vayrone portal
  hwid [--write <file>]                    Show the machine ID; --write saves root-only hardware IDs (service pre-start)`;

/** --name value / --flag pairs. */
export function parseFlags(a: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < a.length; i++) {
    const k = a[i]!;
    if (!k.startsWith('--')) continue;
    const next = a[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[k.slice(2)] = next;
      i++;
    } else out[k.slice(2)] = true;
  }
  return out;
}

export interface CliDefaults {
  /** Install folder of a packaged release (db/ and web/ live there). */
  home?: string;
  configPath?: string;
}

async function init(a: string[], d: CliDefaults): Promise<void> {
  const f = parseFlags(a);
  const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
  const num = (k: string) => (str(k) ? Number(str(k)) : undefined);
  const data = str('data');
  if (!data) throw new Error('--data <dir> is required');
  const home = str('home') ?? d.home;
  const adminUser = str('db-admin-user');
  const r = await initInstall({
    configPath: str('config') ?? d.configPath ?? 'vpm.config.json',
    dataPath: data,
    migrationsPath: str('migrations') ?? (home ? `${home}/db` : './db'),
    ...(str('webroot') ?? (home ? `${home}/web` : undefined) ? { webRoot: str('webroot') ?? `${home}/web` } : {}),
    db: {
      database: str('db-name') ?? 'vayrone_postmaster',
      ...(str('db-host') ? { host: str('db-host') } : {}),
      ...(num('db-port') ? { port: num('db-port') } : {}),
      ...(str('db-socket') ? { socketPath: str('db-socket') } : {}),
      ...(str('db-user') ? { user: str('db-user') } : {}),
      ...(str('db-password') !== undefined ? { password: str('db-password') } : {}),
    },
    ...(adminUser
      ? {
          dbAdmin: {
            user: adminUser,
            ...(str('db-admin-password') ?? process.env.VPM_DB_ADMIN_PASSWORD ? { password: str('db-admin-password') ?? process.env.VPM_DB_ADMIN_PASSWORD } : {}),
            ...(str('db-admin-socket') ? { socketPath: str('db-admin-socket') } : str('db-host') ? { host: str('db-host') } : {}),
            ...(num('db-port') && !str('db-admin-socket') ? { port: num('db-port') } : {}),
          },
        }
      : {}),
    ...(str('hostname') ? { hostname: str('hostname') } : {}),
    ...(num('web-port') ? { webPort: num('web-port') } : {}),
    masterKey: f.dpapi ? { dpapiFile: str('master-key') ?? `${data}/master.key.dpapi` } : { file: str('master-key') ?? `${data}/master.key` },
    ...(str('log-dir') ? { logDir: str('log-dir') } : {}),
    force: f.force === true,
    log: console.log,
  });
  if (r.setupUrl) {
    console.log('');
    console.log(`Open the setup wizard: ${r.setupUrl}`);
    console.log(`Setup token: ${r.setupToken}`);
  }
}

export async function runCli(argv: string[], d: CliDefaults = {}): Promise<void> {
  const [cmd, ...a] = argv;
  if (!cmd || cmd === 'help') return console.log(USAGE);
  if (cmd === 'init') return init(a, d);
  const config = loadConfig(process.env.VPM_CONFIG ?? d.configPath);
  if (cmd === 'setup-token') {
    if (await setupCompleted(config.db)) return console.log('Setup is complete; sign in at the admin panel.');
    const t = ensureSetupToken(config.dataPath);
    const port = config.web.port === 443 && config.web.tls ? '' : `:${config.web.port}`;
    console.log(`Setup wizard: ${config.web.tls ? 'https' : 'http'}://${config.hostname}${port}/setup?token=${t}`);
    return;
  }
  if (cmd === 'migrate') {
    const r = await migrate(config.db, config.migrationsPath, console.log);
    console.log(r.fresh ? 'Fresh schema created.' : `Applied: ${r.applied.join(', ') || 'nothing (up to date)'}`);
    return;
  }
  if (cmd === 'verify') {
    if (!a[0]) throw new Error('backup folder required');
    const v = await verifyBackup(a[0]);
    console.log(v.ok ? `OK — ${v.checkedFiles} files verified` : `FAILED:\n  ${v.problems.join('\n  ')}`);
    for (const w of v.warnings) console.log(`Warning: ${w}`);
    if (!v.ok) process.exitCode = 2;
    return;
  }
  if (cmd === 'restore-full') {
    if (!a[0]) throw new Error('backup folder required');
    if (!a.includes('--yes')) {
      console.log('This REPLACES every mailbox, user and setting on this server with the backup.');
      console.log('Stop the Vayrone PostMaster services before continuing.');
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = await rl.question('Type RESTORE to continue: ');
      rl.close();
      if (answer.trim() !== 'RESTORE') return console.log('Cancelled.');
    }
    const r = await restoreFull({ db: config.db, dataPath: config.dataPath, migrationsPath: config.migrationsPath, backupDir: a[0], log: console.log });
    console.log(`Restore complete: ${r.tables} tables, ${r.rows} rows, ${r.files} message files.`);
    return;
  }
  if (cmd === 'hwid') {
    const w = a.indexOf('--write');
    if (w >= 0) {
      if (!a[w + 1]) throw new Error('file required');
      writeFileSync(a[w + 1]!, await privilegedHwid(config.dataPath), { mode: 0o444 });
      return;
    }
    const fp = await collectFingerprint(config.dataPath);
    console.log(`Machine ID: ${fp.machineId}\nComponents read: ${fp.available.join(', ') || 'none'}`);
    return;
  }
  if (cmd === 'keygen') {
    console.log(`Master key created: ${await createMasterKey(config)}`);
    return;
  }
  // The CLI is licensed like the services: user:add respects the seat limit.
  const { ctx, license } = await createLicensedContext(config);
  license.stop();
  try {
    switch (cmd) {
      case 'license': {
        printLicense(await license.info());
        break;
      }
      case 'license:activate': {
        if (!a[0]) throw new Error('licence key required');
        await license.activateOnline(a[0]);
        printLicense(await license.info());
        break;
      }
      case 'license:request': {
        const key = a[0] && /^vpm/i.test(a[0]) ? a[0] : null;
        const out = key ? a[1] : a[0];
        const r = await license.offlineRequest(key);
        writeFileSync(out ?? r.fileName, r.text);
        console.log(`Request written to ${out ?? r.fileName}. Upload it to the Vayrone portal and import the licence file you receive.`);
        break;
      }
      case 'license:import': {
        if (!a[0]) throw new Error('licence file required');
        await license.importFile(readFileSync(a[0], 'utf8'));
        printLicense(await license.info());
        break;
      }
      case 'domain:add': {
        if (!a[0]) throw new Error('domain required');
        console.log(`Domain ${a[0]} added (id ${await ctx.directory.createDomain(a[0])})`);
        break;
      }
      case 'user:add': {
        const [email, password, name, role] = a;
        if (!email || !password) throw new Error('email and password required');
        const id = await ctx.directory.createUser({ email, password, ...(name ? { displayName: name } : {}), ...(role ? { role: role as 'user' } : {}) });
        console.log(`User ${email} created (id ${id})`);
        break;
      }
      case 'staff:add': {
        const [login, password, role, name] = a;
        if (!login || !password || !role) throw new Error('login, password and role required');
        if (!['admin', 'super_admin', 'auditor', 'vayrone_support'].includes(role)) throw new Error('invalid role');
        const id = await ctx.directory.createStaffUser({ login, password, role: role as 'admin', displayName: name ?? login });
        console.log(`Staff account ${login} created (id ${id})`);
        break;
      }
      case 'backup': {
        if (!a[0]) throw new Error('target folder required');
        const r = await runBackup({ db: ctx.db, dataPath: config.dataPath, targetPath: a[0], kind: 'full', runId: Date.now() % 1_000_000, installId: config.installId, hostname: config.hostname, onProgress: (p) => process.stdout.write(`\r${p}%`) });
        console.log(`\nBackup written: ${r.dirName} (${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB)`);
        break;
      }
      case 'backup:list': {
        for (const r of await ctx.db.query('SELECT r.id, t.name AS target, t.kind, r.kind AS type, r.dir_name, r.status, r.finished_at FROM backup_runs r JOIN backup_targets t ON t.id = r.target_id ORDER BY r.id DESC LIMIT 50').then((x) => x[0] as Record<string, unknown>[])) {
          console.log(`${String(r.id).padStart(5)}  ${String(r.target).padEnd(18)} ${String(r.kind).padEnd(5)} ${String(r.type).padEnd(11)} ${String(r.status).padEnd(9)} ${r.dir_name ?? ''}`);
        }
        break;
      }
      case 'backup:download': {
        // Also works on a freshly installed server that never ran these backups: give --target and the folder name.
        const [what, folder] = a;
        const f = parseFlags(a);
        if (!what || !folder) throw new Error('usage: backup:download <run-id|dir> <folder> [--target <id>] [--passphrase <p>]');
        let dirName = what;
        let targetId = typeof f.target === 'string' ? Number(f.target) : null;
        if (/^\d+$/.test(what)) {
          const [r] = (await ctx.db.query('SELECT target_id, dir_name FROM backup_runs WHERE id = ?', [Number(what)]))[0] as { target_id: number; dir_name: string }[];
          if (!r) throw new Error(`No backup run ${what}`);
          dirName = r.dir_name;
          targetId ??= r.target_id;
        }
        let t: BackupTargetRow | undefined;
        const str = (k: string) => (typeof f[k] === 'string' ? (f[k] as string) : undefined);
        const seal = (v: string | undefined) => (v ? ctx.secrets.seal(v).toString('base64') : null);
        if (str('kind') === 's3') {
          t = { id: 0, name: 'command line', kind: 's3', is_enabled: 1, config: { endpoint: str('endpoint'), region: str('region') ?? 'us-east-1', bucket: str('bucket'), prefix: str('prefix') ?? 'postmaster', accessKeyId: str('access-key'), secretAccessKey: seal(str('secret-key')), pathStyle: f['path-style'] === true } };
        } else if (str('kind') === 'ftp') {
          t = { id: 0, name: 'command line', kind: 'ftp', is_enabled: 1, config: { host: str('host'), port: Number(str('port') ?? 21), secure: str('secure') ?? 'explicit', user: str('user'), password: seal(str('password')), path: str('path') ?? '/postmaster', tlsVerify: f['no-tls-verify'] !== true } };
        } else {
          if (!targetId) throw new Error('Give --target <id> (see backup:list), or the location with --kind s3|ftp …');
          t = ((await ctx.db.query('SELECT * FROM backup_targets WHERE id = ?', [targetId]))[0] as BackupTargetRow[])[0];
          if (!t) throw new Error(`No backup target ${targetId}`);
        }
        const m = await materializeRun(ctx, t, dirName, { ...(typeof f.passphrase === 'string' ? { passphrase: f.passphrase } : {}) });
        try {
          // Copy the run and its base runs next to each other (restore-full follows the chain).
          const { cp } = await import('node:fs/promises');
          const { dirname: dn, join: j } = await import('node:path');
          const { readdirSync } = await import('node:fs');
          for (const d of readdirSync(dn(m.dir))) await cp(j(dn(m.dir), d), j(folder, d), { recursive: true });
          console.log(`Downloaded to ${j(folder, dirName)}. Check it with: vpm cli verify "${j(folder, dirName)}"`);
        } finally {
          await m.cleanup();
        }
        break;
      }
      case 'reindex': {
        await ctx.db.query('DELETE FROM message_search');
        let n = 0;
        for (let k = 0; (k = await indexPending(ctx.db, ctx.blobs, 500)) > 0; ) n += k;
        console.log(`Indexed ${n} messages`);
        break;
      }
      case 'user:passwd': {
        const [email, password] = a;
        const id = email ? await ctx.directory.findUserIdByLogin(email) : null;
        if (!id || !password) throw new Error('unknown user or missing password');
        await ctx.directory.setPassword(id, password);
        console.log('Password updated');
        break;
      }
      case 'folders': {
        const id = a[0] ? await ctx.directory.findUserIdByLogin(a[0]) : null;
        if (!id) throw new Error('unknown user');
        for (const f of await ctx.store.listFolders(id)) {
          console.log(`${f.path.padEnd(30)} uidvalidity=${f.uidvalidity} uidnext=${f.uidnext} messages=${f.message_count} modseq=${f.highest_modseq}`);
        }
        break;
      }
      default:
        console.log(USAGE);
        process.exitCode = 1;
    }
  } finally {
    await ctx.db.end();
  }
}

function printLicense(i: Awaited<ReturnType<LicenseManager['info']>>): void {
  const l = i.license;
  console.log(`Status:     ${i.status} (${i.mode})`);
  console.log(`            ${i.reason}`);
  if (i.warning) console.log(`Warning:    ${i.warning}`);
  if (l) {
    console.log(`Licence:    ${l.licenseId} (key …${l.keyHint}) — ${l.client.name}`);
    console.log(`Plan:       ${l.plan.name}, ${l.maxUsers} users${l.maxExternalAccounts !== null ? `, ${l.maxExternalAccounts} external accounts` : ''}`);
    console.log(`Features:   ${l.features.join(', ') || '—'}`);
    console.log(`Expires:    ${l.expiresAt?.slice(0, 10) ?? 'never'}   AMC: ${l.amcExpiresAt?.slice(0, 10) ?? '—'}   Validate by: ${l.checkBy.slice(0, 10)} (${l.activationMode})`);
  }
  console.log(`Users:      ${i.usage.activeUsers} active`);
  console.log(`Machine ID: ${i.machine.id}`);
}

