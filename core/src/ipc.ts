// Loopback IPC: the worker and web processes write mailbox state directly
// (transactional, safe across processes) and then tell the core process which
// folders changed, so IMAP IDLE sessions get instant pushes. The DB remains
// the source of truth — a lost notification only delays an update until the
// client's next command.
import http from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Logger } from 'pino';
import type { MailEvents } from './events.js';

const HEADER = 'x-vpm-ipc';

/** Shared secret in <dataPath>/ipc.token, created atomically on first use. */
export async function ipcToken(dataPath: string): Promise<string> {
  const file = join(dataPath, 'ipc.token');
  if (!existsSync(file)) {
    await mkdir(dataPath, { recursive: true });
    await writeFile(file, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
  }
  for (let i = 0; i < 20; i++) {
    const t = (await readFile(file, 'utf8')).trim();
    if (t.length === 64) return t;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('IPC token file is incomplete');
}

/** Runs in the core process: accepts change notifications on 127.0.0.1. */
export class IpcServer {
  private server: http.Server | null = null;

  constructor(
    private readonly events: MailEvents,
    private readonly token: string,
    private readonly log: Logger,
  ) {}

  listen(port: number): Promise<number> {
    const expected = Buffer.from(this.token);
    this.server = http.createServer((req, res) => {
      const got = Buffer.from(String(req.headers[HEADER] ?? ''));
      if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
        res.writeHead(403).end();
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/stream') return this.stream(res);
      if (req.method !== 'POST' || req.url !== '/v1/events') {
        res.writeHead(404).end();
        return;
      }
      let body = '';
      req.on('data', (c: Buffer) => {
        body += c.toString();
        if (body.length > 1_000_000) req.destroy();
      });
      req.on('end', () => {
        try {
          const { folders } = JSON.parse(body) as { folders?: unknown };
          if (Array.isArray(folders)) for (const f of folders) if (Number.isInteger(f)) this.events.folderChanged(f as number);
          res.writeHead(204).end();
        } catch {
          res.writeHead(400).end();
        }
      });
    });
    return new Promise((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, '127.0.0.1', () => {
        this.server!.off('error', reject);
        resolve((this.server!.address() as AddressInfo).port);
      });
    }).then((p) => {
      this.log.info({ port: p }, 'ipc listening');
      return p as number;
    });
  }

  private readonly streams = new Set<http.ServerResponse>();

  /** Server-sent events: one line per changed folder id, for the web process (Socket.IO push). */
  private stream(res: http.ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(': connected\n\n');
    const off = this.events.onAnyFolder((id) => res.write(`data: ${id}\n\n`));
    const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
    this.streams.add(res);
    res.on('close', () => {
      off();
      clearInterval(ping);
      this.streams.delete(res);
    });
  }

  close(): Promise<void> {
    for (const s of this.streams) s.destroy();
    return new Promise((r) => (this.server ? this.server.close(() => r()) : r()));
  }
}

/**
 * Runs in the web process: receives every folder change from core (which also
 * re-broadcasts what the worker publishes) and emits it locally without
 * publishing it again. Reconnects with backoff.
 */
export function subscribeIpcStream(events: MailEvents, port: number, token: string, log: Logger): () => void {
  let stopped = false;
  let req: http.ClientRequest | null = null;
  let delay = 1000;
  const connect = () => {
    if (stopped) return;
    req = http.get({ host: '127.0.0.1', port, path: '/v1/stream', headers: { [HEADER]: token } }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        return retry();
      }
      delay = 1000;
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buf += chunk;
        let i: number;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const m = /^data: (\d+)$/m.exec(frame);
          if (m) events.emitLocal(Number(m[1]));
        }
      });
      res.on('end', retry);
      res.on('error', retry);
    });
    req.on('error', (err) => {
      log.debug({ err }, 'ipc stream connect failed');
      retry();
    });
  };
  let retrying = false;
  const retry = () => {
    if (stopped || retrying) return;
    retrying = true;
    setTimeout(() => {
      retrying = false;
      connect();
    }, delay);
    delay = Math.min(delay * 2, 30_000);
  };
  connect();
  return () => {
    stopped = true;
    req?.destroy();
  };
}

/**
 * Runs in worker/web processes: every local folderChanged() is also forwarded
 * to core (batched for 50 ms). Failures are logged at debug level and ignored.
 */
export function attachIpcPublisher(events: MailEvents, port: number, token: string, log: Logger): () => void {
  const pending = new Set<number>();
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    const folders = [...pending];
    pending.clear();
    const body = JSON.stringify({ folders });
    const req = http.request(
      { host: '127.0.0.1', port, path: '/v1/events', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), [HEADER]: token }, timeout: 2000 },
      (res) => res.resume(),
    );
    req.on('error', (err) => log.debug({ err }, 'ipc publish failed'));
    req.on('timeout', () => req.destroy());
    req.end(body);
  };
  const original = events.folderChanged.bind(events);
  events.folderChanged = (id: number) => {
    original(id);
    pending.add(id);
    if (!timer) timer = setTimeout(flush, 50);
  };
  return () => {
    events.folderChanged = original;
    if (timer) clearTimeout(timer);
  };
}
