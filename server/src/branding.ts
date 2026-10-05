// Client logo (setup wizard and Admin → Company). PNG, JPEG or WebP only,
// checked by content: SVG is refused because it can carry script.
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { db as dbm, type CoreContext } from '@vpm/core';
import { badRequest } from './http.js';

export const LOGO_MAX_BYTES = 512 * 1024;

export function decodeLogo(dataUrl: string): { ext: 'png' | 'jpg' | 'webp'; data: Buffer } {
  const m = /^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!m) throw badRequest('The logo must be a PNG, JPEG or WebP image');
  const data = Buffer.from(m[2]!, 'base64');
  if (data.length > LOGO_MAX_BYTES) throw badRequest('The logo is larger than 512 KB');
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { ext: 'png', data };
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { ext: 'jpg', data };
  if (data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') return { ext: 'webp', data };
  throw badRequest('The file is not a PNG, JPEG or WebP image');
}

/** Stores (or with null removes) the logo; the company profile row must exist. */
export async function saveLogo(ctx: CoreContext, dataUrl: string | null): Promise<string | null> {
  const dir = join(ctx.config.dataPath, 'branding');
  for (const ext of ['png', 'jpg', 'webp']) await rm(join(dir, `logo.${ext}`), { force: true });
  let rel: string | null = null;
  if (dataUrl) {
    const { ext, data } = decodeLogo(dataUrl);
    await mkdir(dir, { recursive: true });
    rel = `branding/logo.${ext}`;
    await writeFile(join(ctx.config.dataPath, rel), data);
  }
  await dbm.exec(ctx.db, 'UPDATE company_profile SET logo_path = ?, updated_at = ? WHERE id = 1', [rel, new Date()]);
  return rel;
}
