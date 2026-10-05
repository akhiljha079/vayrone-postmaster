// Worker role: outbound relay sender, external fetcher, job runner, scheduler
// (and the licence heartbeat). Used by `vpm worker`, `vpm all` and dev main.ts.
import type { CoreContext } from '@vpm/core';
import type { LicenseManager } from '@vpm/license-client';
import { OutboundSender } from './sender.js';
import { Fetcher } from './fetcher.js';
import { JobRunner } from './jobs.js';
import { Scheduler, jobHandlers } from './scheduler.js';

export interface RunningWorker {
  stop(): Promise<void>;
}

export async function startWorker(ctx: CoreContext, license: LicenseManager | null): Promise<RunningWorker> {
  const sender = new OutboundSender(ctx);
  const fetcher = new Fetcher(ctx);
  const jobs = new JobRunner(ctx, jobHandlers(ctx));
  const scheduler = new Scheduler(ctx, license);
  sender.start();
  fetcher.start();
  jobs.start();
  await scheduler.start();
  ctx.log.info({ pollMs: ctx.config.worker.pollMs, fetchConcurrency: ctx.config.worker.fetchConcurrency }, 'worker role started');
  return {
    async stop() {
      scheduler.stop();
      await Promise.all([sender.stop(), fetcher.stop(), jobs.stop()]);
    },
  };
}
