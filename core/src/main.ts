// vpm core — mail listeners. Run under WinSW / systemd (Phase 9).
import { pino } from 'pino';
import { createLicensedContext } from '@vpm/license-client';
import { loadConfig } from './config.js';
import { migrate } from './migrate.js';
import { CoreService } from './service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel, base: { svc: 'vpm' } });
  const res = await migrate(config.db, config.migrationsPath, (m) => log.info(m));
  if (res.applied.length) log.info({ applied: res.applied }, 'database migrated');
  // Licence enforcement never stops the mail listeners (see license-client/src/evaluate.ts).
  const { ctx, license } = await createLicensedContext(config, { log });
  log.info({ mode: license.mode(), status: license.evaluation().status }, license.evaluation().reason);
  const svc = new CoreService(ctx);
  await svc.start();

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    ctx.log.info({ sig }, 'shutting down');
    await svc.stop();
    license.stop();
    await ctx.db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  console.error('vpm-core failed to start:', err);
  process.exit(1);
});
