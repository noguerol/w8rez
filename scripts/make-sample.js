#!/usr/bin/env node
/*
 * w8rez — generates samples/demo.png (400×300) with zero dependencies:
 * a minimal PNG encoder (filter 0 + Node's zlib + a local CRC32).
 * The scene: gradient sky, radial-gradient sun, mountains.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const W = 400;
const H = 300;

/* CRC32 (standard table) */
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // colour type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace

  // scanlines with filter 0 (None)
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    rgba.copy(raw, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ── draw the scene into an RGBA buffer ── */
const px = Buffer.alloc(W * H * 4);

function set(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = 255;
}

function mix(a, b, t) {
  return a + (b - a) * t;
}

for (let y = 0; y < H; y++) {
  const t = y / H;
  // sky: dark blue → near black
  const r = mix(24, 4, t), g = mix(42, 8, t), b = mix(88, 16, t);
  for (let x = 0; x < W; x++) set(x, y, r, g, b);
}

// sun: circle with a radial gradient (bright → dim)
const sunX = 290, sunY = 105, sunR = 62;
for (let y = sunY - sunR; y <= sunY + sunR; y++) {
  for (let x = sunX - sunR; x <= sunX + sunR; x++) {
    const dx = x - sunX, dy = y - sunY;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d <= sunR) {
      const t = d / sunR;
      set(x, y, mix(255, 150, t), mix(214, 90, t), mix(92, 20, t));
    }
  }
}

// mountains: two dark triangles
function triangle(x1, y1, x2, y2, x3, y3, r, g, b) {
  const minX = Math.max(0, Math.min(x1, x2, x3)), maxX = Math.min(W - 1, Math.max(x1, x2, x3));
  const minY = Math.max(0, Math.min(y1, y2, y3)), maxY = Math.min(H - 1, Math.max(y1, y2, y3));
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const s1 = (x2 - x1) * (y - y1) - (y2 - y1) * (x - x1);
      const s2 = (x3 - x2) * (y - y2) - (y3 - y2) * (x - x2);
      const s3 = (x1 - x3) * (y - y3) - (y1 - y3) * (x - x3);
      const neg = s1 < 0 || s2 < 0 || s3 < 0;
      const pos = s1 > 0 || s2 > 0 || s3 > 0;
      if (!(neg && pos)) set(x, y, r, g, b);
    }
  }
}
triangle(0, 300, 130, 170, 260, 300, 26, 32, 44);
triangle(150, 300, 300, 130, 400, 300, 20, 26, 36);

// bright band at the base
for (let y = 285; y < 300; y++) {
  const t = (y - 285) / 15;
  for (let x = 0; x < W; x++) set(x, y, mix(63, 185, 80, t), mix(80, 120, t), mix(200, 40, t));
}

const png = encodePng(W, H, px);
const out = path.join(__dirname, '..', 'samples', 'demo.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log(`OK ${out} (${W}x${H}, ${png.length} bytes)`);
