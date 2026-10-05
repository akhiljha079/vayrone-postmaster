// Checking the update channel, and the AMC rule for installing updates.
import { APP_VERSION, updateSettings, type Settings } from '@vpm/core';
import type { KeyRing } from './format.js';
import { compareVersions, currentTarget, verifyUpdateIndex, type UpdateIndexPayload } from './update.js';
import type { LicenseManager } from './manager.js';

export interface AvailableUpdate extends UpdateIndexPayload {
  url: string;
  checkedAt: string;
}

export interface CheckResult {
  current: string;
  latest: AvailableUpdate | null;
  newer: boolean;
}

/** Fetches and verifies <url>/<channel>/<target>/latest.vidx; stores the result in settings. */
export async function checkForUpdates(settings: Settings, keys: KeyRing, f: typeof fetch = fetch): Promise<CheckResult> {
  const cfg = await updateSettings(settings);
  const base = `${cfg.url.replace(/\/+$/, '')}/${cfg.channel}/${currentTarget()}`;
  let res: Response;
  try {
    res = await f(`${base}/latest.vidx`, { signal: AbortSignal.timeout(20_000), headers: { 'user-agent': `VayronePostMaster/${APP_VERSION}` } });
  } catch (e) {
    throw new Error(`Could not reach the update server ${cfg.url} (${((e as { cause?: { code?: string } }).cause?.code ?? (e as Error).message)}). Use an offline update file instead.`);
  }
  if (res.status === 404) {
    await settings.set('updates', 'available', null, null);
    return { current: APP_VERSION, latest: null, newer: false };
  }
  if (!res.ok) throw new Error(`Update server answered HTTP ${res.status}`);
  const idx = verifyUpdateIndex(await res.text(), keys);
  if (idx.target !== currentTarget() || idx.channel !== cfg.channel) throw new Error('The update index does not match this server');
  const latest: AvailableUpdate = { ...idx, url: `${base}/${encodeURIComponent(idx.file)}`, checkedAt: new Date().toISOString() };
  const newer = compareVersions(idx.version, APP_VERSION) > 0;
  await settings.set('updates', 'available', newer ? latest : null, null);
  return { current: APP_VERSION, latest, newer };
}

/** Updates released while the AMC is active may be installed. Evaluation installs may always update. */
export async function updateAllowedByAmc(license: LicenseManager | null, releasedAt: string): Promise<{ ok: boolean; message: string | null }> {
  if (!license) return { ok: true, message: null };
  const l = (await license.info()).license;
  if (!l) return { ok: true, message: null };
  if (!l.amcExpiresAt) return { ok: false, message: 'This licence has no AMC; updates need an Annual Maintenance Contract.' };
  if (new Date(l.amcExpiresAt) < new Date(releasedAt)) {
    return { ok: false, message: `This update was released on ${releasedAt.slice(0, 10)}, after the AMC ended on ${l.amcExpiresAt.slice(0, 10)}. Renew the AMC to install it.` };
  }
  return { ok: true, message: null };
}
