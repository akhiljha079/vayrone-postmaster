// Development entry: the worker role as its own process (`npm run dev -w worker`).
// Installed servers run `vpm worker` (app/src/vpm.ts).
import { pino } from 'pino';
import { attachIpcPublisher, ipcToken, loadConfig, migrate } from '@vpm/core';
import { createLicensedContext } from '@vpm/license-client';
import { startWorker } from './service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel, base: { svc: 'vpm-worker' } });
  await migrate(config.db, config.migrationsPath, (m) => log.info(m));
  const { ctx, license } = await createLicensedContext(config, { log });
  // Mail this process delivers (fetched mail, bounces) must reach IMAP IDLE clients in core.
  if (config.ipc.port > 0) attachIpcPublisher(ctx.events, config.ipc.port, await ipcToken(config.dataPath), ctx.log);
  const worker = await startWorker(ctx, license);

  let stopping = false;
  const stop = async (sig: string) => {
    if (stopping) return;
    stopping = true;
    ctx.log.info({ sig }, 'worker shutting down');
    await worker.stop();
    license.stop();
    await ctx.db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
}

main().catch((err) => {
  console.error('vpm-worker failed to start:', err);
  process.exit(1);
});
