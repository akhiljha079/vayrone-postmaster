// Attachment names in a message, including names inside ZIP archives, for
// blocking dangerous file types (.exe, .js, …).
import libmime from 'libmime';
import type { MimeEntity, Params } from '../mime/mime.js';

export const DEFAULT_BLOCKED_EXTENSIONS = [
  'exe', 'scr', 'com', 'pif', 'bat', 'cmd', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'msi', 'msp', 'hta', 'cpl', 'jar',
  'ps1', 'psm1', 'lnk', 'reg', 'iso', 'img', 'vhd', 'vhdx', 'scf', 'application', 'gadget', 'msc', 'chm', 'appx', 'appxbundle', 'xll',
];

export interface AttachmentInfo {
  filename: string;
  /** "invoice.zip → setup.exe" for files inside archives. */
  display: string;
  size: number;
}

function param(p: Params, name: string): string | null {
  // RFC 2231 continuations / charset (filename*0*=…, filename*=UTF-8''…), then RFC 2047 words.
  const direct = p.find(([k]) => k.toLowerCase() === name)?.[1];
  const ext = p.filter(([k]) => k.toLowerCase().startsWith(`${name}*`)).sort(([a], [b]) => {
    const n = (k: string) => Number(/\*(\d+)/.exec(k)?.[1] ?? 0);
    return n(a) - n(b);
  });
  if (ext.length) {
    let charset = 'utf-8';
    const parts = ext.map(([k, v], i) => {
      if (!k.endsWith('*')) return v;
      let val = v;
      if (i === 0) {
        const m = /^([^']*)'[^']*'(.*)$/.exec(v);
        if (m) {
          charset = m[1] || 'utf-8';
          val = m[2]!;
        }
      }
      try {
        return decodeURIComponent(val);
      } catch {
        return Buffer.from(val.replace(/%([0-9a-f]{2})/gi, (_x, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString(charset === 'utf-8' ? 'utf8' : 'latin1');
      }
    });
    return parts.join('');
  }
  if (!direct) return null;
  try {
    return libmime.decodeWords(direct);
  } catch {
    return direct;
  }
}

export function decodeBody(raw: Buffer, e: MimeEntity): Buffer {
  const body = raw.subarray(e.bs, e.be);
  if (e.enc === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (e.enc === 'quoted-printable') {
    return Buffer.from(
      body
        .toString('latin1')
        .replace(/=\r?\n/g, '')
        .replace(/=([0-9A-Fa-f]{2})/g, (_x, h: string) => String.fromCharCode(parseInt(h, 16))),
      'latin1',
    );
  }
  return Buffer.from(body);
}

/** File names stored in a ZIP's central directory (no decompression needed). */
export function zipEntryNames(zip: Buffer, limit = 2000): string[] {
  const names: string[] = [];
  // End of central directory record: signature 0x06054b50 within the last 64 KiB.
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 65_557); i--) {
    if (zip.readUInt32LE(i) !== 0x06054b50) continue;
    const count = zip.readUInt16LE(i + 10);
    let p = zip.readUInt32LE(i + 16);
    for (let n = 0; n < Math.min(count, limit) && p + 46 <= zip.length; n++) {
      if (zip.readUInt32LE(p) !== 0x02014b50) break;
      const nameLen = zip.readUInt16LE(p + 28);
      const extraLen = zip.readUInt16LE(p + 30);
      const commentLen = zip.readUInt16LE(p + 32);
      names.push(zip.subarray(p + 46, p + 46 + nameLen).toString('utf8'));
      p += 46 + nameLen + extraLen + commentLen;
    }
    break;
  }
  return names;
}

export function listAttachments(raw: Buffer, root: MimeEntity, opts: { scanZip: boolean } = { scanZip: true }): AttachmentInfo[] {
  const out: AttachmentInfo[] = [];
  const walk = (e: MimeEntity, depth: number) => {
    if (depth > 20) return;
    if (e.parts) for (const p of e.parts) walk(p, depth + 1);
    if (e.msg) walk(e.msg, depth + 1);
    if (e.parts) return;
    const name = (e.disp ? param(e.disp[1], 'filename') : null) ?? param(e.params, 'name');
    if (!name) return;
    const size = e.be - e.bs;
    out.push({ filename: name, display: name, size });
    if (opts.scanZip && /\.zip$/i.test(name) && size < 50 * 1024 * 1024) {
      try {
        for (const inner of zipEntryNames(decodeBody(raw, e))) out.push({ filename: inner, display: `${name} → ${inner}`, size: 0 });
      } catch {
        /* damaged archive: the outer name was checked */
      }
    }
  };
  walk(root, 0);
  return out;
}

export function extensionOf(name: string): string {
  // "invoice.pdf .exe", trailing dots/spaces: Windows ignores them.
  const clean = name.trim().replace(/[.\s]+$/, '').toLowerCase();
  const i = clean.lastIndexOf('.');
  return i < 0 ? '' : clean.slice(i + 1);
}

export function blockedAttachments(list: AttachmentInfo[], blocked: string[]): AttachmentInfo[] {
  const set = new Set(blocked.map((b) => b.toLowerCase().replace(/^\./, '')));
  return list.filter((a) => set.has(extensionOf(a.filename)));
}
