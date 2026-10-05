import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import { MailEvents } from '../src/events.js';
import { attachIpcPublisher, ipcToken } from '../src/ipc.js';
import { pino } from 'pino';
import { dbConfig, startCore, type TestCore } from './helpers.js';

describe.skipIf(!dbConfig())('cross-process change notifications', () => {
  let core: TestCore;
  beforeAll(async () => {
    core = await startCore();
  });
  afterAll(() => core.stop());

  it('a worker-side folderChanged reaches listeners in the core process', async () => {
    const workerEvents = new MailEvents(); // stands in for the worker process
    const detach = attachIpcPublisher(workerEvents, core.ports.ipc!, await ipcToken(core.dataPath), pino({ level: 'silent' }));
    const got = new Promise<number>((resolve) => core.ctx.events.onFolder(4242, () => resolve(Date.now())));
    const t0 = Date.now();
    workerEvents.folderChanged(4242);
    expect((await got) - t0).toBeLessThan(1000);
    detach();
  });

  it('rejects requests without the shared token', async () => {
    const status = await new Promise<number>((resolve) => {
      const req = http.request({ host: '127.0.0.1', port: core.ports.ipc, path: '/v1/events', method: 'POST', headers: { 'x-vpm-ipc': 'nope' } }, (res) => resolve(res.statusCode!));
      req.end(JSON.stringify({ folders: [1] }));
    });
    expect(status).toBe(403);
  });
});
