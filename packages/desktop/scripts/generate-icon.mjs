#!/usr/bin/env node
// Render the app icon source (src-tauri/icons/source.png, 1024×1024)
// with zero image dependencies — a hand-rolled PNG encoder over an
// RGBA raster. The mark mirrors the in-app brand (app-shell.tsx): a
// dark rounded square carrying the lucide "Server" glyph — two rounded
// bars, each with an indicator dot.
//
// Regenerate the full platform icon set (ico/icns/PNG sizes) with:
//   node scripts/generate-icon.mjs && pnpm exec tauri icon src-tauri/icons/source.png
// `tauri icon` writes into src-tauri/icons/, which tauri.conf.json's
// bundle.icon references. Windows bundling (NSIS/MSI) hard-requires
// the .ico this produces.

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const SS = 4; // supersampling factor for clean anti-aliased edges

// Colors (sRGB). Background matches the app's dark foreground chip;
// the glyph is near-white, dots use the accent.
const BG = [23, 23, 23, 255];
const GLYPH = [250, 250, 250, 255];
const DOT = [82, 196, 130, 255];

/** Signed distance to a rounded rectangle centered at (cx, cy). */
function sdRoundRect(px, py, cx, cy, halfW, halfH, radius) {
  const qx = Math.abs(px - cx) - (halfW - radius);
  const qy = Math.abs(py - cy) - (halfH - radius);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - radius;
}

function sdCircle(px, py, cx, cy, r) {
  return Math.hypot(px - cx, py - cy) - r;
}

// Scene in 1024-space. Outer tile: rounded square with the classic
// app-icon corner radius (~22.5%). Server glyph: two bars.
const tile = (px, py) => sdRoundRect(px, py, 512, 512, 448, 448, 200);
const barTop = (px, py) => sdRoundRect(px, py, 512, 400, 232, 76, 48);
const barBottom = (px, py) => sdRoundRect(px, py, 512, 624, 232, 76, 48);
const dotTop = (px, py) => sdCircle(px, py, 372, 400, 30);
const dotBottom = (px, py) => sdCircle(px, py, 372, 624, 30);

function shade(px, py) {
  if (tile(px, py) > 0) return [0, 0, 0, 0];
  if (dotTop(px, py) <= 0 || dotBottom(px, py) <= 0) return DOT;
  if (barTop(px, py) <= 0 || barBottom(px, py) <= 0) return GLYPH;
  return BG;
}

function render() {
  const raster = Buffer.alloc(SIZE * SIZE * 4);
  const step = 1 / SS;
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [cr, cg, cb, ca] = shade(x + (sx + 0.5) * step, y + (sy + 0.5) * step);
          r += cr * (ca / 255);
          g += cg * (ca / 255);
          b += cb * (ca / 255);
          a += ca;
        }
      }
      const samples = SS * SS;
      const alpha = a / samples;
      const idx = (y * SIZE + x) * 4;
      // Un-premultiply back to straight alpha for PNG.
      const w = alpha > 0 ? 255 / alpha : 0;
      raster[idx] = Math.round(Math.min(255, (r / samples) * w));
      raster[idx + 1] = Math.round(Math.min(255, (g / samples) * w));
      raster[idx + 2] = Math.round(Math.min(255, (b / samples) * w));
      raster[idx + 3] = Math.round(alpha);
    }
  }
  return raster;
}

// --- minimal PNG writer (8-bit RGBA, no interlace) ---
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function encodePng(raster) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(SIZE, 0);
  ihdr.writeUInt32BE(SIZE, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  // scanlines with filter byte 0
  const stride = SIZE * 4;
  const rawData = Buffer.alloc((stride + 1) * SIZE);
  for (let y = 0; y < SIZE; y++) {
    rawData[y * (stride + 1)] = 0;
    raster.copy(rawData, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(rawData, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(__dirname, '..', 'src-tauri', 'icons', 'source.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, encodePng(render()));
console.log(`generate-icon: wrote ${out} (${SIZE}×${SIZE})`);
