#!/usr/bin/env node
// Draws the PostMaster icon (the Vayrone PostMaster mark, same design as web/public/favicon.svg)
// into a Windows .ico with 16, 24, 32, 48, 64, 128 and 256 px images. No dependencies.
//   node scripts/make-icon.mjs [out.ico] [--png 512 out.png] [--white]   (default installer/windows/assets/vpm.ico)
import { writeFileSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';

const pngArg = process.argv.indexOf('--png');
const out = (pngArg === 2 ? undefined : process.argv[2]) ?? new URL('../installer/windows/assets/vpm.ico', import.meta.url).pathname;
const ORANGE = [0xff, 0x6b, 0x0a];
const NAVY = [0x0b, 0x1b, 0x35];
const WHITE = [0xff, 0xff, 0xff];

// Geometry in the favicon's viewBox (x 300…955, y 150…805): the orange V, speed lines,
// and the navy envelope with a white outline and flap.
// --white: opaque white background (installer bitmaps have no transparency).
const BACKGROUND = process.argv.includes('--white') ? WHITE : null;
const VIEW = { x: 300, y: 150, size: 655 };
const V = [[305, 167], [400, 167], [627, 610], [855, 167], [950, 167], [627, 795]];
const inPolygon = (x, y, pts) => {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
};
const inRoundRect = (x, y, rx, ry, w, h, r) => {
  const cx = Math.min(Math.max(x, rx + r), rx + w - r);
  const cy = Math.min(Math.max(y, ry + r), ry + h - r);
  return x >= rx && x <= rx + w && y >= ry && y <= ry + h && (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
};
const distSeg = (px, py, ax, ay, bx, by) => {
  const dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy)));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
};
const onPath = (x, y, pts, half) => pts.slice(1).some((p, i) => distSeg(x, y, pts[i][0], pts[i][1], p[0], p[1]) <= half);
const SPEED = [[483, 262, 86], [498, 309, 70], [515, 353, 53]];
const FLAP = [[586, 273], [676, 350], [767, 273]];
const FOLDS = [[[586, 400], [640, 347]], [[767, 400], [713, 347]]];

function sample(x, y) {
  if (inRoundRect(x, y, 580, 266, 193, 140, 9)) {
    if (onPath(x, y, FLAP, 4.5) || FOLDS.some((f) => onPath(x, y, f, 4.5))) return WHITE;
    return NAVY;
  }
  if (inRoundRect(x, y, 572, 258, 209, 156, 14)) return WHITE;
  if (inPolygon(x, y, V) || SPEED.some(([rx, ry, w]) => inRoundRect(x, y, rx, ry, w, 18, 9))) return ORANGE;
  return BACKGROUND;
}

function render(size) {
  const ss = size <= 64 ? 8 : 4; // 4×4 supersampling for smooth edges
  const px = Buffer.alloc(size * size * 4);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < ss; sy++) {
        for (let sx = 0; sx < ss; sx++) {
          const c = sample(VIEW.x + ((i + (sx + 0.5) / ss) * VIEW.size) / size, VIEW.y + ((j + (sy + 0.5) / ss) * VIEW.size) / size);
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
if (pngArg > 0) {
  const size = Number(process.argv[pngArg + 1]);
  writeFileSync(process.argv[pngArg + 2], png(size, render(size)));
  console.log(`Wrote ${process.argv[pngArg + 2]} (${size} px)`);
}
