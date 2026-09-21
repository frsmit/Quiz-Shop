/**
 * Generates the extension's PNG icons without an image dependency.
 * Run with `node scripts/make-icons.mjs` after changing the design below.
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const OUT_DIR = fileURLToPath(new URL('../public/icons/', import.meta.url));
const SIZES = [16, 32, 48, 128];

const BACKGROUND = [37, 99, 235]; // indigo-600
const GLYPH = [255, 255, 255];

function crc32(buf) {
  let c = ~0;
  for (const byte of buf) {
    c ^= byte;
    for (let k = 0; k < 8; k += 1) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** Signed distance from a point to a rounded square, used for antialiasing. */
function roundedSquareAlpha(x, y, size) {
  const radius = size * 0.22;
  const inset = size * 0.06;
  const half = size / 2 - inset;
  const dx = Math.abs(x - size / 2) - (half - radius);
  const dy = Math.abs(y - size / 2) - (half - radius);
  const outside = Math.hypot(Math.max(dx, 0), Math.max(dy, 0));
  const distance = outside + Math.min(Math.max(dx, dy), 0) - radius;
  return Math.min(Math.max(0.5 - distance, 0), 1);
}

/** A question mark rendered as three primitives: arc, stem and dot. */
function glyphAlpha(x, y, size) {
  const cx = size / 2;
  const arcCy = size * 0.4;
  const arcR = size * 0.17;
  const stroke = Math.max(size * 0.105, 1.4);

  const ringDistance = Math.abs(Math.hypot(x - cx, y - arcCy) - arcR);
  const onUpperArc = y <= arcCy + arcR * 0.35 || x >= cx;
  const arc = onUpperArc ? Math.min(Math.max(0.5 + (stroke / 2 - ringDistance), 0), 1) : 0;

  const stemTop = arcCy + arcR * 0.55;
  const stemBottom = size * 0.68;
  const inStem = y >= stemTop && y <= stemBottom;
  const stem = inStem ? Math.min(Math.max(0.5 + (stroke / 2 - Math.abs(x - cx)), 0), 1) : 0;

  const dotDistance = Math.hypot(x - cx, y - size * 0.8);
  const dot = Math.min(Math.max(0.5 + (stroke * 0.6 - dotDistance), 0), 1);

  return Math.max(arc, stem, dot);
}

function renderPng(size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  let offset = 0;
  for (let y = 0; y < size; y += 1) {
    raw[offset] = 0; // no per-scanline filter
    offset += 1;
    for (let x = 0; x < size; x += 1) {
      const px = x + 0.5;
      const py = y + 0.5;
      const shape = roundedSquareAlpha(px, py, size);
      const glyph = glyphAlpha(px, py, size) * shape;
      for (let channel = 0; channel < 3; channel += 1) {
        raw[offset + channel] = Math.round(
          BACKGROUND[channel] * (1 - glyph) + GLYPH[channel] * glyph,
        );
      }
      raw[offset + 3] = Math.round(shape * 255);
      offset += 4;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // colour type: RGBA

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(OUT_DIR, { recursive: true });
for (const size of SIZES) {
  writeFileSync(`${OUT_DIR}icon-${size}.png`, renderPng(size));
}
console.log(`Wrote ${SIZES.length} icons to ${OUT_DIR}`);
