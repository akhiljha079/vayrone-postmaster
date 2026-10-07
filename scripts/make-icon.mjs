#!/usr/bin/env node
// Draws the PostMaster icon (same design as web/public/favicon.svg) into a
// Windows .ico with 16, 24, 32, 48, 64, 128 and 256 px images. No dependencies.
//   node scripts/make-icon.mjs [out.ico]   (default installer/windows/assets/vpm.ico)
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const out = process.argv[2] ?? new URL('../installer/windows/assets/vpm.ico', import.meta.url).pathname;
const NAVY = [0x1e, 0x3a, 0x8a];
const WHITE = [0xff, 0xff, 0xff];
const SKY = [0x38, 0xbd, 0xf8];

// Geometry in the favicon's 32×32 coordinate space.
const insideRoundRect = (x, y) => {
  const r = 7;
  const cx = Math.min(Math.max(x, r), 32 - r);
  const cy = Math.min(Math.max(y, r), 32 - r);
  return x >= 0 && x <= 32 && y >= 0 && y <= 32 && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const onPath = (x, y, pts, half) => pts.slice(1).some((p, i) => distSeg(x, y, pts[i][0], pts[i][1], p[0], p[1]) <= half);
const ENVELOPE = [[7, 10], [25, 10], [25, 22], [7, 22], [7, 10]];
const FLAP = [[7, 11], [16, 18], [25, 11]];

function sample(x, y) {
  if (!insideRoundRect(x, y)) return null;
  if (onPath(x, y, FLAP, 1)) return SKY;
  if (onPath(x, y, ENVELOPE, 1)) return WHITE;
  return NAVY;
}

function render(size) {
  const ss = 4; // 4×4 supersampling for smooth edges
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(((i + (sx + 0.5) / ss) * 32) / size, ((j + (sy + 0.5) / ss) * 32) / size);
          if (c) (r += c[0], g += c[1], b += c[2], a++);
        }
      }
      const o = (j * size + i) * 4;
      if (a) (px[o] = Math.round(r / a), px[o + 1] = Math.round(g / a), px[o + 2] = Math.round(b / a));
      px[o + 3] = Math.round((a / (ss * ss)) * 255);
    }
  }
  return px;
}

function png(size, rgba) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

const sizes = [16, 24, 32, 48, 64, 128, 256];
const images = sizes.map((s) => png(s, render(s)));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);
header.writeUInt16LE(1, 2); // icon
header.writeUInt16LE(sizes.length, 4);
let offset = 6 + 16 * sizes.length;
const dir = sizes.map((s, i) => {
  const e = Buffer.alloc(16);
  e[0] = s === 256 ? 0 : s;
  e[1] = s === 256 ? 0 : s;
  e.writeUInt16LE(1, 4); // planes
  e.writeUInt16LE(32, 6); // bits per pixel
  e.writeUInt32LE(images[i].length, 8);
  e.writeUInt32LE(offset, 12);
  offset += images[i].length;
  return e;
});
writeFileSync(out, Buffer.concat([header, ...dir, ...images]));
console.log(`Wrote ${out} (${sizes.join(', ')} px)`);
