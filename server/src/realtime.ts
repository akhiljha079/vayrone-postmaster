// Realtime push to browsers (Socket.IO). Every mailbox change — from this
// process, from core (IMAP/SMTP) or from the worker (fetched mail), relayed
// through core's IPC stream — becomes a "mail" event for the folder's owner.
import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { db as dbm, type CoreContext } from '@vpm/core';
import type { Sessions } from './sessions.js';
import { SID_COOKIE } from './guards.js';

const FLUSH_MS = 250;
const REVALIDATE_MS = 60_000;

export function attachRealtime(app: FastifyInstance, ctx: CoreContext, sessions: Sessions): Server {
  const io = new Server(app.server, { path: '/socket.io', serveClient: false, transports: ['websocket', 'polling'] });

  io.use((socket, next) => {
    void (async () => {
      const h = socket.handshake.headers;
      // Same-origin only (the session cookie is SameSite=Strict, this is defence in depth).
      if (h.origin) {
        try {
          if (new URL(h.origin).host !== h.host) return next(new Error('forbidden origin'));
        } catch {
          return next(new Error('forbidden origin'));
        }
      }
      const cookies = app.parseCookie(String(h.cookie ?? ''));
      const token = cookies[SID_COOKIE];
      const v = token ? await sessions.validate(token) : null;
      if (!v || !v.session.mfa_passed || !v.user.has_mailbox) return next(new Error('unauthorized'));
      socket.data.userId = v.user.id;
      socket.data.token = token;
      await socket.join(`user:${v.user.id}`);
      next();
    })().catch(() => next(new Error('unauthorized')));
  });

  // Sessions can be revoked (sign out everywhere, password change): re-check periodically.
  const revalidate = setInterval(() => {
    for (const s of io.sockets.sockets.values()) {
      void sessions.validate(String(s.data.token ?? '')).then((v) => {
        if (!v) s.disconnect(true);
      });
    }
  }, REVALIDATE_MS);
  revalidate.unref();

  const owner = new Map<number, number>();
  const pending = new Map<number, Set<number>>();
  let timer: NodeJS.Timeout | null = null;
  const flush = () => {
    timer = null;
    for (const [userId, folders] of pending) io.to(`user:${userId}`).emit('mail', { folders: [...folders] });
    pending.clear();
  };
  const off = ctx.events.onAnyFolder((folderId) => {
    void (async () => {
      let uid = owner.get(folderId);
      if (uid === undefined) {
        const f = await dbm.one<{ user_id: number }>(ctx.db, 'SELECT user_id FROM folders WHERE id = ?', [folderId]);
        if (!f) return;
        uid = f.user_id;
        if (owner.size > 100_000) owner.clear();
        owner.set(folderId, uid);
      }
      if (!io.sockets.adapter.rooms.has(`user:${uid}`)) return;
      const set = pending.get(uid) ?? new Set<number>();
      set.add(folderId);
      pending.set(uid, set);
      if (!timer) timer = setTimeout(flush, FLUSH_MS);
    })().catch(() => {});
  });

  app.addHook('onClose', async () => {
    off();
    clearInterval(revalidate);
    if (timer) clearTimeout(timer);
    await io.close();
  });
  return io;
}
