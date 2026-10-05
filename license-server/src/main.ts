// Vayrone License Server. Runs on Vayrone's VPS (aaPanel: Node project +
// nginx reverse proxy with TLS), with its own MySQL database.
import { Cron } from 'croner';
import { pino } from 'pino';
import { loadLsConfig } from './config.js';
import { createPool, exec } from './db.js';
import { migrate } from './migrate.js';
import { Signer } from './signer.js';
import { Vault } from './crypto.js';
import { Licensing } from './services/licensing.js';
import { Notifier } from './services/notify.js';
import { runReminders } from './services/reminders.js';
import { buildApp } from './app.js';

async function main(): Promise<void> {
  const config = loadLsConfig();
  const log = pino({ level: config.logLevel, base: { svc: 'vls' } });
  await migrate(config.db, config.migrationsPath, (m) => log.info(m));
  const db = createPool(config.db);
  const signer = Signer.fromFile(config.signingKeyFile, config.signingKeyId, (m) => log.warn(m));
  const vault = Vault.fromFile(config.secretKeyFile);
  const notifier = new Notifier(db, vault);
  const ctx = { config, db, signer, vault, notifier, licensing: new Licensing(db, signer) };
  const app = await buildApp(ctx, { logger: { level: config.logLevel } });
  await app.listen({ host: config.listenHost, port: config.port });
  log.info({ kid: signer.kid }, 'Vayrone License Server started');

  // Reminders every morning (India time); expired sessions cleaned nightly.
  const reminders = new Cron('30 9 * * *', { timezone: config.timezone, protect: true }, async () => {
    try {
      log.info(await runReminders(db, notifier, { tz: config.timezone }), 'reminders sent');
    } catch (err) {
      log.error({ err }, 'reminders failed');
    }
  });
  const cleanup = new Cron('15 3 * * *', { timezone: config.timezone }, async () => {
    await exec(db, 'DELETE FROM sessions WHERE expires_at < ?', [new Date()]).catch((err) => log.error({ err }, 'session cleanup failed'));
  });

  const stop = async () => {
    reminders.stop();
    cleanup.stop();
    await app.close();
    await db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error('License Server failed to start:', err);
  process.exit(1);
});
