import type { AddressInfo } from 'node:net';
import type { SMTPServer } from 'smtp-server';
import type { CoreContext } from './context.js';
import { createSubmissionServer } from './smtp/smtp.js';
import { ImapServer } from './imap/server.js';
import { Pop3Server } from './pop3/pop3.js';
import { IpcServer, ipcToken } from './ipc.js';

export interface ListeningPorts {
  submission?: number;
  smtps?: number;
  imap?: number;
  imaps?: number;
  pop3?: number;
  pop3s?: number;
  ipc?: number;
}

function listenSmtp(s: SMTPServer, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(port, host, () => {
      s.off('error', reject);
      resolve((s.server.address() as AddressInfo).port);
    });
  });
}

/** Starts every enabled mail listener of the core role. */
export class CoreService {
  private smtp: SMTPServer[] = [];
  private imap: ImapServer[] = [];
  private pop3: Pop3Server[] = [];
  private ipc: IpcServer | null = null;

  constructor(private readonly ctx: CoreContext) {}

  async start(): Promise<ListeningPorts> {
    const { ports, listenHost } = this.ctx.config;
    const out: ListeningPorts = {};
    const want = (p: number) => p !== 0 && p !== undefined;
    // Port -1 means "any free port" (tests).
    const real = (p: number) => (p < 0 ? 0 : p);

    if (want(ports.submission)) {
      const s = createSubmissionServer(this.ctx, false);
      s.on('error', (err) => this.ctx.log.error({ err }, 'smtp error'));
      out.submission = await listenSmtp(s, real(ports.submission), listenHost);
      this.smtp.push(s);
    }
    if (want(ports.smtps)) {
      const s = createSubmissionServer(this.ctx, true);
      s.on('error', (err) => this.ctx.log.error({ err }, 'smtps error'));
      out.smtps = await listenSmtp(s, real(ports.smtps), listenHost);
      this.smtp.push(s);
    }
    if (want(ports.imap)) {
      const s = new ImapServer(this.ctx, false);
      out.imap = await s.listen(real(ports.imap), listenHost);
      this.imap.push(s);
    }
    if (want(ports.imaps)) {
      const s = new ImapServer(this.ctx, true);
      out.imaps = await s.listen(real(ports.imaps), listenHost);
      this.imap.push(s);
    }
    if (want(ports.pop3)) {
      const s = new Pop3Server(this.ctx, false);
      out.pop3 = await s.listen(real(ports.pop3), listenHost);
      this.pop3.push(s);
    }
    if (want(ports.pop3s)) {
      const s = new Pop3Server(this.ctx, true);
      out.pop3s = await s.listen(real(ports.pop3s), listenHost);
      this.pop3.push(s);
    }
    if (want(this.ctx.config.ipc.port)) {
      this.ipc = new IpcServer(this.ctx.events, await ipcToken(this.ctx.config.dataPath), this.ctx.log);
      out.ipc = await this.ipc.listen(real(this.ctx.config.ipc.port));
    }
    this.ctx.log.info({ ports: out }, 'vpm-core listening');
    return out;
  }

  async stop(): Promise<void> {
    await Promise.all([
      ...this.smtp.map((s) => new Promise<void>((r) => s.close(() => r()))),
      ...this.imap.map((s) => s.close()),
      ...this.pop3.map((s) => s.close()),
      this.ipc?.close(),
    ]);
    this.ipc = null;
    this.smtp = [];
    this.imap = [];
    this.pop3 = [];
  }
}
