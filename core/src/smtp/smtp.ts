// LAN SMTP submission (587 STARTTLS / 465 TLS). Authenticated users only.
// Local recipients are delivered internally; everything else is queued for
// the relay worker. The From address stays the employee's own.
import { SMTPServer, type SMTPServerAddress, type SMTPServerAuthentication, type SMTPServerSession } from 'smtp-server';
import type { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import type { CoreContext } from '../context.js';
import type { AuthUser } from '../directory.js';

interface SessionUser extends AuthUser {
  addresses: string[];
}

function smtpError(code: number, message: string): Error {
  const e = new Error(message) as Error & { responseCode: number };
  e.responseCode = code;
  return e;
}

function rfc2822Date(d = new Date()): string {
  return d.toUTCString().replace('GMT', '+0000');
}

async function readStream(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

export function createSubmissionServer(ctx: CoreContext, secure: boolean): SMTPServer {
  const { config, directory, store, log } = ctx;
  const releases = new Map<string, () => void>();

  return new SMTPServer({
    secure,
    key: ctx.tls.key,
    cert: ctx.tls.cert,
    name: config.hostname,
    banner: 'Vayrone PostMaster ESMTP',
    size: config.maxMessageSize,
    authMethods: ['PLAIN', 'LOGIN'],
    authOptional: false,
    allowInsecureAuth: config.allowPlaintextAuth,
    disabledCommands: secure ? ['STARTTLS'] : [],
    logger: false,
    maxClients: 500,

    onConnect(session: SMTPServerSession, cb) {
      const release = ctx.connections.acquire(session.remoteAddress);
      if (!release) return cb(smtpError(421, '4.7.0 Too many connections from your address'));
      releases.set(session.id, release);
      cb();
    },

    onClose(session: SMTPServerSession) {
      releases.get(session.id)?.();
      releases.delete(session.id);
    },

    onAuth(auth: SMTPServerAuthentication, session: SMTPServerSession, cb) {
      directory
        .authenticate(auth.username ?? '', auth.password ?? '', 'smtp', session.remoteAddress)
        .then(async (u) => {
          if (!u) return cb(smtpError(535, '5.7.8 Authentication failed'));
          const user: SessionUser = { ...u, addresses: await directory.userAddresses(u.id) };
          cb(null, { user });
        })
        .catch((e) => cb(e as Error));
    },

    onMailFrom(address: SMTPServerAddress, session: SMTPServerSession, cb) {
      const user = session.user as unknown as SessionUser | undefined;
      if (!user) return cb(smtpError(530, '5.7.0 Authentication required'));
      const from = address.address.toLowerCase();
      if (!from) return cb(smtpError(550, '5.7.1 Null sender not allowed for submission'));
      if (!user.addresses.includes(from)) return cb(smtpError(553, `5.7.1 You are not allowed to send as <${from}>`));
      cb();
    },

    onRcptTo(address: SMTPServerAddress, session: SMTPServerSession, cb) {
      if (session.envelope.rcptTo.length >= 500) return cb(smtpError(452, '4.5.3 Too many recipients'));
      directory
        .resolve(address.address)
        .then(async (r) => {
          if (r.kind === 'unknown-local' && r.action === 'reject') return cb(smtpError(550, `5.1.1 <${address.address}>: no such user here`));
          if (r.kind === 'local' && r.listId) {
            const from = (session.envelope.mailFrom as SMTPServerAddress | false) || null;
            if (!from || !(await directory.listAllowsSender(r.listId, from.address))) {
              return cb(smtpError(550, `5.7.1 <${address.address}>: you are not allowed to send to this list`));
            }
          }
          cb();
        })
        .catch((e) => cb(e as Error));
    },

    onData(stream: Readable & { sizeExceeded?: boolean }, session: SMTPServerSession, cb) {
      (async () => {
        const body = await readStream(stream);
        if (stream.sizeExceeded) throw smtpError(552, '5.3.4 Message exceeds maximum size');
        const user = session.user as unknown as SessionUser;
        const queueId = randomBytes(6).toString('hex').toUpperCase();
        const received =
          `Received: from ${session.clientHostname || 'unknown'} ([${session.remoteAddress}])\r\n` +
          `\tby ${config.hostname} (Vayrone PostMaster) with ${secure || session.secure ? 'ESMTPSA' : 'ESMTPA'} id ${queueId}\r\n` +
          `\tfor <${session.envelope.rcptTo.map((r) => r.address).join('>, <')}>; ${rfc2822Date()}\r\n`;
        const message = await store.ingest(Buffer.concat([Buffer.from(received), body]));
        const envelopeFrom = (session.envelope.mailFrom as SMTPServerAddress).address.toLowerCase();

        const localUsers = new Set<number>();
        const external = new Set<string>();
        for (const r of session.envelope.rcptTo) {
          const res = await directory.resolve(r.address);
          if (res.kind === 'local') {
            res.userIds.forEach((u) => localUsers.add(u));
            res.external.forEach((e) => external.add(e));
          } else if (res.kind === 'unknown-local' && res.action === 'catchall' && res.catchallUserId) {
            localUsers.add(res.catchallUserId);
          } else {
            external.add(r.address.toLowerCase());
          }
        }

        const res = await ctx.mailflow.submission({
          message,
          envelopeFrom,
          senderUserId: user.id,
          localUserIds: [...localUsers],
          external: [...external],
          clientIp: session.remoteAddress,
        });
        if (res.rejected) throw smtpError(550, `5.7.1 ${res.rejected}`);
        if (res.outcomes.length && res.outcomes.every((o) => o.status === 'failed') && !external.size) throw smtpError(451, '4.3.0 Local delivery failed, try again later');
        log.info({ queueId, user: user.login, local: localUsers.size, external: external.size, size: message.size }, 'smtp accepted');
        return queueId;
      })()
        .then((id) => cb(null, `2.0.0 Ok: queued as ${id}`))
        .catch((e: Error & { responseCode?: number }) => {
          if (!e.responseCode) log.error({ err: e }, 'smtp onData failed');
          cb(e.responseCode ? e : smtpError(451, '4.3.0 Temporary server error'));
        });
    },
  });
}
