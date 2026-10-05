import net from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pino } from 'pino';
import { inject } from 'vitest';
import { buildConfig, type DbConfig } from '../src/config.js';
import { createContext, type CoreContext } from '../src/context.js';
import { CoreService, type ListeningPorts } from '../src/service.js';

declare module 'vitest' {
  export interface ProvidedContext {
    db: DbConfig | null;
  }
}

export const dbConfig = (): DbConfig | null => inject('db');

export interface TestCore {
  ctx: CoreContext;
  svc: CoreService;
  ports: ListeningPorts;
  dataPath: string;
  stop(): Promise<void>;
}

/** Starts a core instance on random loopback ports. Reuse dataPath to simulate a service restart. */
export async function startCore(dataPath?: string, dbOverride?: DbConfig): Promise<TestCore> {
  const db = dbOverride ?? dbConfig();
  if (!db) throw new Error('No test database');
  const dp = dataPath ?? mkdtempSync(join(tmpdir(), 'vpm-test-'));
  const config = buildConfig({
    db: { ...db, connectionLimit: 10 },
    dataPath: dp,
    hostname: 'mail.test.local',
    installId: 'testinstall',
    listenHost: '127.0.0.1',
    ports: { submission: -1, smtps: 0, imap: -1, imaps: -1, pop3: -1, pop3s: 0 },
    ipc: { port: -1 },
    logLevel: 'silent',
  });
  const ctx = await createContext(config, pino({ level: process.env.VPM_TEST_LOG ?? 'silent' }));
  const svc = new CoreService(ctx);
  const ports = await svc.start();
  return {
    ctx,
    svc,
    ports,
    dataPath: dp,
    async stop() {
      await svc.stop();
      await ctx.db.end();
    },
  };
}

export function uniqueDomain(): string {
  return `t${randomBytes(4).toString('hex')}.test`;
}

export async function makeUser(ctx: CoreContext, email: string, password = 'Secret#123'): Promise<number> {
  return ctx.directory.createUser({ email, password, displayName: email.split('@')[0] });
}

// ---------------------------------------------------------------------------
// Raw line-oriented clients for transcript tests
// ---------------------------------------------------------------------------

export class RawClient {
  private buf = '';
  private waiters: (() => void)[] = [];
  private tagN = 0;
  closed = false;

  private constructor(readonly sock: net.Socket) {
    sock.setEncoding('latin1');
    sock.on('data', (d: string) => {
      this.buf += d;
      this.waiters.splice(0).forEach((w) => w());
    });
    sock.on('close', () => {
      this.closed = true;
      this.waiters.splice(0).forEach((w) => w());
    });
  }

  static connect(port: number): Promise<RawClient> {
    return new Promise((resolve, reject) => {
      const s = net.connect(port, '127.0.0.1', () => resolve(new RawClient(s)));
      s.once('error', reject);
    });
  }

  /** Waits until the buffer matches, consumes through the match end, returns consumed text. */
  async readUntil(re: RegExp, timeoutMs = 5000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const m = re.exec(this.buf);
      if (m) {
        const end = m.index + m[0].length;
        const out = this.buf.slice(0, end);
        this.buf = this.buf.slice(end);
        return out;
      }
      if (this.closed) throw new Error(`Connection closed; buffer: ${this.buf}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`Timeout waiting for ${re}; buffer: ${JSON.stringify(this.buf.slice(-500))}`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, left);
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  write(s: string | Buffer): void {
    this.sock.write(s);
  }

  /** IMAP: sends a tagged command and returns everything up to and including the tagged reply. */
  async imap(command: string): Promise<{ text: string; status: string }> {
    const tag = `T${++this.tagN}`;
    this.write(`${tag} ${command}\r\n`);
    const text = await this.readUntil(new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)[^\\r\\n]*\\r\\n`));
    const status = new RegExp(`${tag} (OK|NO|BAD)`).exec(text)![1]!;
    return { text, status };
  }

  /** POP3: sends a command; multi-line replies are read through the terminating dot. */
  async pop(command: string, multiline = false): Promise<string> {
    this.write(`${command}\r\n`);
    const first = await this.readUntil(/^[^\r\n]*\r\n/);
    if (!multiline || !first.startsWith('+OK')) return first;
    return first + (await this.readUntil(/(^|\r\n)\.\r\n/));
  }

  end(): void {
    this.sock.end();
  }
}
