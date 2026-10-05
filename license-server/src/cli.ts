// License Server setup commands.
import { randomBytes } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { loadLsConfig } from './config.js';
import { createPool, exec } from './db.js';
import { migrate } from './migrate.js';
import { hashPassword } from './crypto.js';

const USAGE = `Usage: vls-cli <command>
  migrate                               Create / upgrade the License Server database
  secret:gen <file>                     Create the settings encryption key file (64 hex)
  owner:add <email> <password> [name]   Create an owner login`;

async function run([cmd, ...a]: string[]): Promise<void> {
  if (cmd === 'secret:gen') {
    if (!a[0]) throw new Error('file required');
    if (existsSync(a[0])) throw new Error(`${a[0]} already exists`);
    writeFileSync(a[0], randomBytes(32).toString('hex'), { mode: 0o600 });
    return console.log(`Written ${a[0]} (keep it with the database backups; credentials in settings need it)`);
  }
  const config = loadLsConfig();
  if (cmd === 'migrate') {
    const r = await migrate(config.db, config.migrationsPath, console.log);
    return console.log(`Applied: ${r.join(', ') || 'nothing (up to date)'}`);
  }
  if (cmd === 'owner:add') {
    const [email, password, name] = a;
    if (!email || !password || password.length < 10) throw new Error('email and a password of at least 10 characters required');
    const db = createPool(config.db);
    try {
      await exec(db, "INSERT INTO staff_users (email, name, password_hash, role, created_at) VALUES (?,?,?,'owner',?)", [email.toLowerCase(), name ?? email, await hashPassword(password), new Date()]);
      console.log(`Owner ${email} created`);
    } finally {
      await db.end();
    }
    return;
  }
  console.log(USAGE);
}

run(process.argv.slice(2)).catch((e) => {
  console.error((e as Error).message);
  process.exit(1);
});
