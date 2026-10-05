// Minimal, binary-safe POP3 client (RFC 1939, RFC 2449 CAPA, RFC 2595 STLS, RFC 5034 SASL PLAIN).
import net from 'node:net';
import tls from 'node:tls';

export type FetchErrorKind = 'auth' | 'network' | 'protocol' | 'quota';

/** Error from a remote mail server, classified for the scheduler (auth → pause, network → back off). */
export class FetchError extends Error {
  constructor(
    readonly kind: FetchErrorKind,
    message: string,
  ) {
    super(message);
  }
}

export interface Pop3Options {
  host: string;
  port: number;
  security: 'none' | 'starttls' | 'tls';
  tlsVerify: boolean;
  timeoutMs?: number;
}

const CRLF = Buffer.from('\r\n');
const TERMINATOR = Buffer.from('\r\n.\r\n');

interface Waiter {
  multi: boolean;
  resolve: (r: { line: string; body: Buffer | null }) => void;
  reject: (e: Error) => void;
}

export class Pop3Client {
  private buf: Buffer = Buffer.alloc(0);
  private waiter: Waiter | null = null;
  private closed = false;
  private capabilities: string[] | null = null;
  private readonly timeout: number;

  private constructor(
    private sock: net.Socket,
    private readonly opts: Pop3Options,
  ) {
    this.timeout = opts.timeoutMs ?? 60_000;
    this.attach(sock);
  }

  static async connect(opts: Pop3Options): Promise<Pop3Client> {
    const sock = await new Promise<net.Socket>((resolve, reject) => {
      const onErr = (e: Error) => reject(new FetchError('network', `Cannot connect to ${opts.host}:${opts.port}: ${e.message}`));
      const s =
        opts.security === 'tls'
          ? tls.connect({ host: opts.host, port: opts.port, servername: net.isIP(opts.host) ? undefined : opts.host, rejectUnauthorized: opts.tlsVerify }, () => resolve(s))
          : net.connect({ host: opts.host, port: opts.port }, () => resolve(s));
      s.once('error', onErr);
      s.setTimeout(opts.timeoutMs ?? 60_000, () => s.destroy(new Error('connection timed out')));
    });
    const c = new Pop3Client(sock, opts);
    const greet = await c.read(false);
    if (!greet.line.startsWith('+OK')) throw new FetchError('protocol', `Unexpected greeting: ${greet.line}`);
    await c.loadCapa();
    if (opts.security === 'starttls') {
      if (!c.capabilities?.some((x) => x.toUpperCase() === 'STLS')) throw new FetchError('protocol', 'Server does not offer STLS (STARTTLS)');
      await c.command('STLS');
      await c.upgrade();
      await c.loadCapa();
    }
    return c;
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    sock.removeAllListeners('error');
    sock.on('data', (d: Buffer) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
      this.pump();
    });
    sock.on('error', (e) => this.fail(new FetchError('network', e.message)));
    sock.on('close', () => this.fail(new FetchError('network', 'Connection closed by server')));
  }

  private upgrade(): Promise<void> {
    return new Promise((resolve, reject) => {
      const plain = this.sock;
      plain.removeAllListeners('data');
      plain.removeAllListeners('close');
      plain.removeAllListeners('error');
      this.buf = Buffer.alloc(0);
      const s = tls.connect({ socket: plain, servername: net.isIP(this.opts.host) ? undefined : this.opts.host, rejectUnauthorized: this.opts.tlsVerify }, () => {
        this.attach(s);
        resolve();
      });
      s.once('error', (e) => reject(new FetchError('network', `TLS negotiation failed: ${e.message}`)));
    });
  }

  private fail(e: Error): void {
    this.closed = true;
    const w = this.waiter;
    this.waiter = null;
    w?.reject(e);
  }

  private pump(): void {
    const w = this.waiter;
    if (!w) return;
    const eol = this.buf.indexOf(CRLF);
    if (eol === -1) return;
    const line = this.buf.toString('utf8', 0, eol);
    if (!w.multi || !line.startsWith('+OK')) {
      this.buf = this.buf.subarray(eol + 2);
      this.waiter = null;
      w.resolve({ line, body: null });
      return;
    }
    // Multi-line: body ends with CRLF "." CRLF; an empty body is just "." after the status line.
    const end = this.buf.indexOf(TERMINATOR, eol);
    if (end === -1) return;
    let body = this.buf.subarray(eol + 2, end + 2);
    if (end === eol) body = Buffer.alloc(0);
    this.buf = this.buf.subarray(end + TERMINATOR.length);
    this.waiter = null;
    w.resolve({ line, body: unstuff(body) });
  }

  private read(multi: boolean): Promise<{ line: string; body: Buffer | null }> {
    if (this.closed) return Promise.reject(new FetchError('network', 'Connection is closed'));
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiter = null;
        this.sock.destroy();
        reject(new FetchError('network', 'Server did not respond in time'));
      }, this.timeout);
      this.waiter = {
        multi,
        resolve: (r) => {
          clearTimeout(t);
          resolve(r);
        },
        reject: (e) => {
          clearTimeout(t);
          reject(e);
        },
      };
      this.pump();
    });
  }

  private async command(cmd: string, multi = false, kind: FetchErrorKind = 'protocol'): Promise<{ line: string; body: Buffer | null }> {
    this.sock.write(cmd + '\r\n');
    const r = await this.read(multi);
    if (!r.line.startsWith('+OK')) {
      const shown = cmd.startsWith('PASS') || cmd.startsWith('AUTH') ? cmd.split(' ')[0] : cmd;
      throw new FetchError(kind, `${shown}: ${r.line.replace(/^-ERR\s*/, '') || 'rejected'}`);
    }
    return r;
  }

  private async loadCapa(): Promise<void> {
    this.sock.write('CAPA\r\n');
    const r = await this.read(true);
    this.capabilities = r.line.startsWith('+OK') && r.body ? r.body.toString('latin1').split('\r\n').filter(Boolean) : null;
  }

  get caps(): string[] {
    return this.capabilities ?? [];
  }

  async login(user: string, pass: string): Promise<void> {
    const sasl = this.caps.find((c) => c.toUpperCase().startsWith('SASL '))?.toUpperCase().split(' ') ?? [];
    if (sasl.includes('PLAIN')) {
      const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
      await this.command(`AUTH PLAIN ${token}`, false, 'auth');
      return;
    }
    await this.command(`USER ${user}`, false, 'auth');
    await this.command(`PASS ${pass}`, false, 'auth');
  }

  async stat(): Promise<{ count: number; size: number }> {
    const r = await this.command('STAT');
    const m = /^\+OK (\d+) (\d+)/.exec(r.line);
    if (!m) throw new FetchError('protocol', `Bad STAT reply: ${r.line}`);
    return { count: Number(m[1]), size: Number(m[2]) };
  }

  /** Message number → UIDL, or null when the server has no UIDL support. */
  async uidl(): Promise<Map<number, string> | null> {
    this.sock.write('UIDL\r\n');
    const r = await this.read(true);
    if (!r.line.startsWith('+OK')) return null;
    return parsePairs(r.body!, (v) => v);
  }

  async list(): Promise<Map<number, number>> {
    const r = await this.command('LIST', true);
    return parsePairs(r.body!, Number);
  }

  async retr(n: number): Promise<Buffer> {
    return (await this.command(`RETR ${n}`, true)).body!;
  }

  async top(n: number, lines: number): Promise<Buffer> {
    return (await this.command(`TOP ${n} ${lines}`, true)).body!;
  }

  async dele(n: number): Promise<void> {
    await this.command(`DELE ${n}`);
  }

  /** QUIT commits deletions. Returns false if the server did not confirm. */
  async quit(): Promise<boolean> {
    try {
      await this.command('QUIT');
      return true;
    } catch {
      return false;
    } finally {
      this.close();
    }
  }

  close(): void {
    this.closed = true;
    this.sock.destroy();
  }
}

function parsePairs<T>(body: Buffer, conv: (v: string) => T): Map<number, T> {
  const m = new Map<number, T>();
  for (const line of body.toString('latin1').split('\r\n')) {
    const sp = line.indexOf(' ');
    if (sp <= 0) continue;
    const n = Number(line.slice(0, sp));
    if (Number.isInteger(n)) m.set(n, conv(line.slice(sp + 1).trim()));
  }
  return m;
}

/** Removes POP3 byte-stuffing: a line starting with ".." becomes ".". */
export function unstuff(b: Buffer): Buffer {
  if (b.indexOf('\r\n..') === -1 && !(b[0] === 0x2e && b[1] === 0x2e)) return b;
  const parts: Buffer[] = [];
  let start = 0;
  if (b[0] === 0x2e && b[1] === 0x2e) start = 1;
  for (let i = b.indexOf('\r\n..', start); i !== -1; i = b.indexOf('\r\n..', i + 3)) {
    parts.push(b.subarray(start, i + 2));
    start = i + 3;
  }
  parts.push(b.subarray(start));
  return Buffer.concat(parts);
}
