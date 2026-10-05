// Development entry: the web role as its own process (`npm run dev -w server`).
// Installed servers run it inside `vpm core` (app/src/vpm.ts).
import { pino } from 'pino';
import { attachIpcPublisher, ipcToken, loadConfig, migrate, subscribeIpcStream } from '@vpm/core';
import { createLicensedContext } from '@vpm/license-client';
import { startWeb } from './service.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel, base: { svc: 'vpm-web' } });
  await migrate(config.db, config.migrationsPath, (m) => log.info(m));
  const { ctx, license } = await createLicensedContext(config, { log });
  if (config.ipc.port > 0) {
    const token = await ipcToken(config.dataPath);
    attachIpcPublisher(ctx.events, config.ipc.port, token, ctx.log);
    // Hear about every change made by core (IMAP/SMTP) and the worker, for browser push.
    subscribeIpcStream(ctx.events, config.ipc.port, token, ctx.log);
  }
  const web = await startWeb(ctx, license);

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await web.stop();
    license.stop();
    await ctx.db.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
}

main().catch((err) => {
  console.error('vpm-web failed to start:', err);
  process.exit(1);
});
