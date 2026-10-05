// POP3 (RFC 1939) with UIDL, TOP, CAPA, STLS (RFC 2595), AUTH PLAIN/LOGIN (RFC 5034).
// Serves INBOX only. UIDLs are the stored mail_items.pop3_uidl values, so they
// survive restarts, upgrades, backup/restore and moves — Outlook's "leave a
// copy on server" never re-downloads.
import net from 'node:net';
import tls, { TLSSocket } from 'node:tls';
import type { CoreContext } from '../context.js';
import type { AuthUser } from '../directory.js';
import { rows } from '../db.js';
import { DELETED_BIT } from '../store/mailstore.js';

interface Pop3Item {
  id: number;
  uid: number;
  size: number;
  pop3_uidl: string;
  storage_path: string;
  codec: number;
  deleted: boolean;
}

const TIMEOUT = 10 * 60_000;

function dotStuff(raw: Buffer): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  if (raw[0] === 0x2e) parts.push(Buffer.from('.'));
  for (let i = raw.indexOf('\n.'); i !== -1; i = raw.indexOf('\n.', i + 1)) {
    parts.push(raw.subarray(start, i + 1), Buffer.from('.'));
    start = i + 1;
  }
  parts.push(raw.subarray(start));
  if (raw.length && raw[raw.length - 1] !== 0x0a) parts.push(Buffer.from('\r\n'));
  parts.push(Buffer.from('.\r\n'));
  return Buffer.concat(parts);
}

class Pop3Session {
  private sock: net.Socket;
  private buf = '';
  private state: 'auth' | 'trans' | 'closed' = 'auth';
  private pendingUser: string | null = null;
  private user: AuthUser | null = null;
  private folderId = 0;
  private items: Pop3Item[] = [];
  private chain: Promise<void> = Promise.resolve();
  private lineHook: ((l: string | null) => void) | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly ctx: CoreContext,
    socket: net.Socket,
    private secure: boolean,
    private readonly onClose: (s: Pop3Session) => void,
  ) {
    this.sock = socket;
  }

  start(): void {
    this.attach(this.sock);
    this.send('+OK Vayrone PostMaster POP3 ready');
  }

  private attach(sock: net.Socket): void {
    this.sock = sock;
    sock.setEncoding('utf8');
    sock.on('data', (d: string) => {
      this.touch();
      this.buf += d;
      if (this.buf.length > 8192 && !this.buf.includes('\n')) return this.close();
      let nl: number;
      while ((nl = this.buf.indexOf('\n')) !== -1) {
        const line = this.buf.slice(0, nl).replace(/\r$/, '');
        this.buf = this.buf.slice(nl + 1);
        if (this.lineHook) {
          const h = this.lineHook;
          this.lineHook = null;
          h(line);
          continue;
        }
        this.chain = this.chain.then(() => this.handle(line)).catch((err) => {
          this.ctx.log.error({ err }, 'pop3 command failed');
          this.send('-ERR [SYS/TEMP] Internal error');
        });
      }
    });
    sock.on('error', () => this.close());
    sock.on('close', () => this.close());
    this.touch();
  }

  private touch(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.close(), TIMEOUT);
    this.timer.unref();
  }

  private send(s: string | Buffer): void {
    if (this.state === 'closed') return;
    this.sock.write(typeof s === 'string' ? s + '\r\n' : s);
  }

  close(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.timer) clearTimeout(this.timer);
    this.lineHook?.(null);
    this.sock.end();
    this.onClose(this);
  }

  private nextLine(): Promise<string | null> {
    return new Promise((r) => (this.lineHook = r));
  }

  private capa(): string[] {
    const c = ['TOP', 'UIDL', 'USER', 'RESP-CODES', 'AUTH-RESP-CODE', 'PIPELINING', 'SASL PLAIN LOGIN', 'IMPLEMENTATION Vayrone-PostMaster'];
    if (!this.secure) c.push('STLS');
    return c;
  }

  private msg(arg: string | undefined): Pop3Item | string {
    const n = Number(arg);
    if (!arg || !Number.isInteger(n) || n < 1 || n > this.items.length) return '-ERR No such message';
    const it = this.items[n - 1]!;
    if (it.deleted) return '-ERR Message is deleted';
    return it;
  }

  private async login(u: AuthUser | null): Promise<void> {
    if (!u) {
      this.send('-ERR [AUTH] Invalid credentials');
      return;
    }
    const inbox = await this.ctx.store.getSpecialFolder(u.id, 'inbox');
    if (!inbox) {
      this.send('-ERR [SYS/PERM] No INBOX');
      return;
    }
    this.user = u;
    this.folderId = inbox.id;
    const list = await rows<Omit<Pop3Item, 'deleted'>>(
      this.ctx.db,
      `SELECT i.id, i.uid, i.size, i.pop3_uidl, m.storage_path, m.codec
         FROM mail_items i JOIN messages m ON m.id = i.message_id
        WHERE i.folder_id = ? AND (i.flags & ?) = 0 ORDER BY i.uid`,
      [inbox.id, DELETED_BIT],
    );
    this.items = list.map((x) => ({ ...x, size: Number(x.size), deleted: false }));
    this.state = 'trans';
    this.send(`+OK Logged in, ${this.items.length} messages`);
  }

  private plainBlocked(): boolean {
    return !this.secure && !this.ctx.config.allowPlaintextAuth;
  }

  private async handle(line: string): Promise<void> {
    if (this.state === 'closed') return;
    const sp = line.indexOf(' ');
    const cmd = (sp === -1 ? line : line.slice(0, sp)).toUpperCase();
    const arg = sp === -1 ? '' : line.slice(sp + 1);
    const args = arg.split(' ').filter(Boolean);
    const ip = this.sock.remoteAddress ?? '';

    if (cmd === 'CAPA') {
      this.send('+OK Capability list follows');
      for (const c of this.capa()) this.send(c);
      return this.send('.');
    }
    if (cmd === 'QUIT') return this.quit();
    if (cmd === 'NOOP') return this.send(this.state === 'trans' ? '+OK' : '-ERR Not logged in');

    if (this.state === 'auth') {
      switch (cmd) {
        case 'STLS': {
          if (this.secure) return this.send('-ERR Already using TLS');
          this.send('+OK Begin TLS negotiation');
          const plain = this.sock;
          plain.removeAllListeners('data');
          plain.removeAllListeners('close');
          plain.removeAllListeners('error');
          this.buf = '';
          const s = new TLSSocket(plain, { isServer: true, secureContext: this.ctx.tls.context });
          this.secure = true;
          this.attach(s);
          return;
        }
        case 'USER':
          if (this.plainBlocked()) return this.send('-ERR [SYS/PERM] Use STLS first');
          this.pendingUser = arg;
          return this.send('+OK Send password');
        case 'PASS': {
          if (this.pendingUser === null) return this.send('-ERR USER first');
          const u = await this.ctx.directory.authenticate(this.pendingUser, arg, 'pop3', ip);
          this.pendingUser = null;
          return this.login(u);
        }
        case 'AUTH': {
          if (!args[0]) {
            this.send('+OK');
            this.send('PLAIN');
            this.send('LOGIN');
            return this.send('.');
          }
          if (this.plainBlocked()) return this.send('-ERR [SYS/PERM] Use STLS first');
          const mech = args[0].toUpperCase();
          const ask = async (p: string) => {
            this.send(`+ ${p}`);
            const l = await this.nextLine();
            return l === null || l === '*' ? null : l;
          };
          if (mech === 'PLAIN') {
            const data = args[1] ?? (await ask(''));
            if (data === null) return this.send('-ERR Authentication cancelled');
            const p = Buffer.from(data, 'base64').toString('utf8').split('\0');
            if (p.length !== 3) return this.send('-ERR Invalid PLAIN data');
            return this.login(await this.ctx.directory.authenticate(p[1]!, p[2]!, 'pop3', ip));
          }
          if (mech === 'LOGIN') {
            const u = args[1] ?? (await ask(Buffer.from('Username:').toString('base64')));
            if (u === null) return this.send('-ERR Authentication cancelled');
            const p = await ask(Buffer.from('Password:').toString('base64'));
            if (p === null) return this.send('-ERR Authentication cancelled');
            return this.login(
              await this.ctx.directory.authenticate(Buffer.from(u, 'base64').toString('utf8'), Buffer.from(p, 'base64').toString('utf8'), 'pop3', ip),
            );
          }
          return this.send('-ERR Unsupported mechanism');
        }
        default:
          return this.send('-ERR Not logged in');
      }
    }

    // TRANSACTION state
    switch (cmd) {
      case 'STAT': {
        const live = this.items.filter((i) => !i.deleted);
        return this.send(`+OK ${live.length} ${live.reduce((s, i) => s + i.size, 0)}`);
      }
      case 'LIST':
      case 'UIDL': {
        const val = (i: Pop3Item) => (cmd === 'LIST' ? String(i.size) : i.pop3_uidl);
        if (args[0]) {
          const it = this.msg(args[0]);
          if (typeof it === 'string') return this.send(it);
          return this.send(`+OK ${args[0]} ${val(it)}`);
        }
        this.send('+OK');
        this.items.forEach((i, idx) => {
          if (!i.deleted) this.send(`${idx + 1} ${val(i)}`);
        });
        return this.send('.');
      }
      case 'RETR':
      case 'TOP': {
        const it = this.msg(args[0]);
        if (typeof it === 'string') return this.send(it);
        let raw = await this.ctx.store.loadRaw(it);
        if (cmd === 'TOP') {
          const n = Number(args[1]);
          if (!Number.isInteger(n) || n < 0) return this.send('-ERR Invalid line count');
          let hdrEnd = raw.indexOf('\r\n\r\n');
          hdrEnd = hdrEnd === -1 ? raw.length : hdrEnd + 4;
          let end = hdrEnd;
          for (let k = 0; k < n && end < raw.length; k++) {
            const nl = raw.indexOf(0x0a, end);
            end = nl === -1 ? raw.length : nl + 1;
          }
          raw = raw.subarray(0, end);
        }
        this.send(`+OK ${it.size} octets`);
        return this.send(dotStuff(raw));
      }
      case 'DELE': {
        const it = this.msg(args[0]);
        if (typeof it === 'string') return this.send(it);
        it.deleted = true;
        return this.send('+OK Marked for deletion');
      }
      case 'RSET':
        this.items.forEach((i) => (i.deleted = false));
        return this.send('+OK');
      default:
        return this.send('-ERR Unknown command');
    }
  }

  private async quit(): Promise<void> {
    if (this.state === 'trans') {
      const del = this.items.filter((i) => i.deleted).map((i) => i.uid);
      if (del.length) {
        await this.ctx.store.storeFlags(this.folderId, del, 'add', DELETED_BIT, null);
        await this.ctx.store.expunge(this.folderId, del);
      }
    }
    this.send('+OK Bye');
    this.close();
  }
}

export class Pop3Server {
  private readonly server: net.Server;
  private readonly sessions = new Set<Pop3Session>();

  constructor(ctx: CoreContext, implicitTls: boolean) {
    const onConn = (sock: net.Socket) => {
      if (!implicitTls) {
        const release = ctx.connections.acquire(sock.remoteAddress);
        if (!release) return void sock.end('-ERR Too many connections from your address\r\n');
        sock.once('close', release);
      }
      const s = new Pop3Session(ctx, sock, implicitTls, (x) => this.sessions.delete(x));
      this.sessions.add(s);
      s.start();
    };
    this.server = implicitTls ? tls.createServer({ key: ctx.tls.key, cert: ctx.tls.cert, minVersion: 'TLSv1.2' }, onConn) : net.createServer(onConn);
    if (implicitTls) {
      this.server.on('connection', (raw: net.Socket) => {
        const release = ctx.connections.acquire(raw.remoteAddress);
        if (!release) return void raw.destroy();
        raw.once('close', release);
      });
    }
    this.server.on('tlsClientError', () => {});
    this.server.on('error', (err) => ctx.log.error({ err }, 'pop3 server error'));
  }

  listen(port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve((this.server.address() as net.AddressInfo).port);
      });
    });
  }

  async close(): Promise<void> {
    for (const s of this.sessions) s.close();
    await new Promise<void>((r) => this.server.close(() => r()));
  }
}
