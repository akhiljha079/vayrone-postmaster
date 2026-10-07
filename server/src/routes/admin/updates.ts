// Software updates: channel check, download or offline upload, verification,
// install request (applied by the privileged updater), history.
import { createReadStream, createWriteStream, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import * as sea from 'node:sea';
import { rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { basename, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import type { FastifyInstance } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import {
  APP_VERSION,
  db as dbm,
  startUpdateHistory,
  updateSettings,
  updaterInstalled,
  updatesDir,
  writeApplyRequest,
  type CoreContext,
} from '@vpm/core';
import {
  checkForUpdates,
  compareVersions,
  currentTarget,
  trustedKeys,
  updateAllowedByAmc,
  UpdateError,
  verifyUpdatePackage,
  type AvailableUpdate,
  type LicenseManager,
  type UpdatePayload,
} from '@vpm/license-client';
import { audit, requireAdmin } from '../../guards.js';
import { HttpError, badRequest, notFound } from '../../http.js';

const { one, rows } = dbm;

interface Staged {
  version: string;
  file: string;
  sha256: string;
  size: number;
  source: 'online' | 'offline';
  channel: 'stable' | 'beta' | 'offline';
  releasedAt: string;
  minVersion: string;
  notes: string;
  packageFormat: 'sea' | 'node';
  verifiedAt: string;
}

async function installFormat(): Promise<'sea' | 'node'> {
  try {
    return (sea as { isSea?: () => boolean }).isSea?.() ? 'sea' : 'node';
  } catch {
    return 'node';
  }
}

async function sha256File(f: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(
    createReadStream(f),
    new Transform({
      transform(c: Buffer, _e, cb) {
        h.update(c);
        cb();
      },
    }),
  );
  return h.digest('hex');
}

export function updateRoutes(ctx: CoreContext, license: LicenseManager | null) {
  const read = requireAdmin(ctx, 'read');
  const owner = requireAdmin(ctx, 'super');
  const keys = () => trustedKeys(ctx.config.dataPath);
  const download = { active: false, version: '', received: 0, total: 0, error: null as string | null };
  const docker = process.env.VPM_DOCKER === '1';

  /** Verifies a package file and records it as staged. */
  const stage = async (file: string, source: Staged['source'], channel: Staged['channel']): Promise<Staged> => {
    let p: UpdatePayload;
    try {
      p = await verifyUpdatePackage(file, keys());
    } catch (e) {
      rmSync(file, { force: true });
      throw badRequest(e instanceof UpdateError ? e.message : `The update file is damaged (${(e as Error).message})`, 'UPDATE_INVALID');
    }
    if (p.target !== currentTarget()) {
      rmSync(file, { force: true });
      throw badRequest(`This update is for ${p.target}; this server is ${currentTarget()}`, 'UPDATE_WRONG_PLATFORM');
    }
    const st: Staged = {
      version: p.version,
      file,
      sha256: await sha256File(file),
      size: statSync(file).size,
      source,
      channel: source === 'offline' ? 'offline' : channel,
      releasedAt: p.releasedAt,
      minVersion: p.minVersion,
      notes: p.notes,
      packageFormat: p.packageFormat,
      verifiedAt: new Date().toISOString(),
    };
    // Keep only this package.
    const dir = updatesDir(ctx.config.dataPath, 'download');
    for (const f of readdirSync(dir)) if (join(dir, f) !== file) rmSync(join(dir, f), { force: true });
    await ctx.settings.set('updates', 'staged', st, null);
    return st;
  };

  return async (app: FastifyInstance) => {
    await app.register(multipart, { limits: { fileSize: 1024 * 1024 * 1024, files: 1, fields: 2 } });

    app.get('/updates', { preHandler: read }, async () => {
      const staged = await ctx.settings.get<Staged | null>('updates', 'staged', null);
      return {
        current: APP_VERSION,
        target: currentTarget(),
        format: await installFormat(),
        docker,
        settings: await updateSettings(ctx.settings),
        available: await ctx.settings.get<AvailableUpdate | null>('updates', 'available', null),
        staged: staged && existsSync(staged.file) && compareVersions(staged.version, APP_VERSION) > 0 ? { ...staged, file: basename(staged.file) } : null,
        download: { ...download },
        updater: updaterInstalled(ctx.config.dataPath),
        history: await rows(
          ctx.db,
          `SELECT h.id, h.from_version AS fromVersion, h.to_version AS toVersion, h.channel, h.status, h.started_at AS startedAt, h.finished_at AS finishedAt, u.login AS startedBy
             FROM update_history h LEFT JOIN users u ON u.id = h.started_by ORDER BY h.id DESC LIMIT 20`,
        ),
      };
    });

    app.get<{ Params: { id: string } }>('/updates/history/:id', { preHandler: read }, async (req) => {
      const h = await one(ctx.db, 'SELECT id, from_version AS fromVersion, to_version AS toVersion, status, started_at AS startedAt, finished_at AS finishedAt, log FROM update_history WHERE id = ?', [req.params.id]);
      if (!h) throw notFound('Update not found');
      return h;
    });

    app.put('/updates/settings', { preHandler: owner }, async (req) => {
      const b = z.object({ channel: z.enum(['stable', 'beta']), autoCheck: z.boolean(), url: z.url().max(300).optional() }).parse(req.body);
      const next = { ...(await updateSettings(ctx.settings)), ...b };
      await ctx.settings.set('updates', 'config', next, req.auth!.user.id);
      await ctx.settings.set('updates', 'available', null, null);
      await audit(ctx, req, 'update.settings', 'settings', 'updates', b);
      return next;
    });

    app.post('/updates/check', { preHandler: read, config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async () => {
      if (docker) throw badRequest('This server runs in Docker: update by pulling the new image.', 'UPDATE_DOCKER');
      try {
        return await checkForUpdates(ctx.settings, keys());
      } catch (e) {
        throw new HttpError(502, 'UPDATE_CHECK_FAILED', (e as Error).message);
      }
    });

    app.post('/updates/download', { preHandler: owner }, async (req) => {
      if (docker) throw badRequest('This server runs in Docker: update by pulling the new image.', 'UPDATE_DOCKER');
      const a = await ctx.settings.get<AvailableUpdate | null>('updates', 'available', null);
      if (!a) throw badRequest('No update is available; check for updates first');
      if (download.active) return { ok: true, download };
      Object.assign(download, { active: true, version: a.version, received: 0, total: a.size, error: null });
      const dest = join(updatesDir(ctx.config.dataPath, 'download'), basename(a.file));
      const userLogin = req.auth!.user.login;
      void (async () => {
        try {
          const res = await fetch(a.url, { signal: AbortSignal.timeout(60 * 60_000) });
          if (!res.ok || !res.body) throw new Error(`Download failed (HTTP ${res.status})`);
          const h = createHash('sha256');
          await pipeline(
            Readable.fromWeb(res.body as never),
            new Transform({
              transform(c: Buffer, _e, cb) {
                h.update(c);
                download.received += c.length;
                cb(null, c);
              },
            }),
            createWriteStream(`${dest}.part`),
          );
          if (h.digest('hex') !== a.sha256) throw new Error('The downloaded file does not match the update index (checksum)');
          await rename(`${dest}.part`, dest);
          await stage(dest, 'online', a.channel);
          await ctx.audit.log({ actorUserId: null, actorLogin: userLogin, actorRole: null, isSupport: false, ip: null, action: 'update.downloaded', targetType: 'update', targetId: a.version, details: null });
        } catch (e) {
          download.error = (e as Error).message;
          rmSync(`${dest}.part`, { force: true });
        } finally {
          download.active = false;
        }
      })();
      return { ok: true, download };
    });

    app.post('/updates/upload', { preHandler: owner, bodyLimit: 1024 * 1024 * 1024 }, async (req) => {
      const part = await req.file();
      if (!part) throw badRequest('Choose the .vpmupdate file');
      if (!/\.vpmupdate$/i.test(part.filename)) throw badRequest('Choose a .vpmupdate file');
      const dest = join(updatesDir(ctx.config.dataPath, 'download'), `upload-${Date.now()}.vpmupdate`);
      await pipeline(part.file, createWriteStream(dest));
      if (part.file.truncated) {
        rmSync(dest, { force: true });
        throw badRequest('The file is too large');
      }
      const st = await stage(dest, 'offline', 'offline');
      await audit(ctx, req, 'update.uploaded', 'update', st.version, { file: part.filename, sha256: st.sha256 });
      return { ...st, file: basename(st.file) };
    });

    app.post('/updates/install', { preHandler: owner }, async (req) => {
      const { version } = z.object({ version: z.string().max(32) }).parse(req.body);
      const st = await ctx.settings.get<Staged | null>('updates', 'staged', null);
      if (!st || st.version !== version || !existsSync(st.file)) throw badRequest('Download or upload this update first');
      if (compareVersions(st.version, APP_VERSION) <= 0) throw badRequest(`Version ${st.version} is not newer than ${APP_VERSION}`);
      if (compareVersions(APP_VERSION, st.minVersion) < 0) throw badRequest(`Install version ${st.minVersion} first`);
      if ((await sha256File(st.file)) !== st.sha256) throw badRequest('The staged file changed since it was verified; download it again', 'UPDATE_INVALID');
      if (st.packageFormat !== (await installFormat())) throw badRequest('This update package does not match how this server was installed');
      const amc = await updateAllowedByAmc(license, st.releasedAt);
      if (!amc.ok) throw new HttpError(403, 'AMC_REQUIRED', amc.message!);
      const updater = updaterInstalled(ctx.config.dataPath);
      if (!updater.ok) throw new HttpError(409, 'UPDATER_MISSING', 'The updater service is not installed or not running. Reinstall with the latest installer, or run "vpm update-apply" as administrator after requesting the update.');
      if (existsSync(join(ctx.config.dataPath, 'updates', 'apply.json'))) throw new HttpError(409, 'UPDATE_PENDING', 'An update is already being installed');
      const id = await startUpdateHistory(ctx.db, { from: APP_VERSION, to: st.version, channel: st.channel, sha256: st.sha256, userId: req.auth!.user.id });
      writeApplyRequest(ctx.config.dataPath, { historyId: id, package: st.file, version: st.version, requestedAt: new Date().toISOString(), requestedBy: req.auth!.user.login });
      await audit(ctx, req, 'update.install', 'update', st.version, { from: APP_VERSION, historyId: id });
      return { ok: true, historyId: id };
    });
  };
}
