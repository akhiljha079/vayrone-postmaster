import net from 'node:net';
import tls from 'node:tls';
import type { CoreContext } from '../context.js';
import { ImapSession } from './session.js';

/** IMAP listener: plain+STARTTLS (143) or implicit TLS (993). */
export class ImapServer {
  private readonly server: net.Server;
  private readonly sessions = new Set<ImapSession>();

  constructor(
    private readonly ctx: CoreContext,
    implicitTls: boolean,
  ) {
    const onConn = (sock: net.Socket) => {
      const release = implicitTls ? null : ctx.connections.acquire(sock.remoteAddress);
      if (!implicitTls) {
        if (!release) return void sock.end('* BYE Too many connections from your address\r\n');
        sock.once('close', release);
      }
      sock.setKeepAlive(true, 60_000);
      const s = new ImapSession(ctx, sock, implicitTls, (x) => this.sessions.delete(x));
      this.sessions.add(s);
      s.start();
    };
    this.server = implicitTls
      ? tls.createServer({ key: ctx.tls.key, cert: ctx.tls.cert, minVersion: 'TLSv1.2' }, onConn)
      : net.createServer(onConn);
    // Implicit TLS: count the raw connection before the handshake.
    if (implicitTls) {
      this.server.on('connection', (raw: net.Socket) => {
        const release = ctx.connections.acquire(raw.remoteAddress);
        if (!release) return void raw.destroy();
        raw.once('close', release);
      });
    }
    this.server.on('tlsClientError', (err: Error) => ctx.log.debug({ err }, 'imap tls client error'));
    this.server.on('error', (err) => ctx.log.error({ err }, 'imap server error'));
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

  get connectionCount(): number {
    return this.sessions.size;
  }
}
