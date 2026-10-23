// Generates build/icon.png (256x256) and build/icon.ico (multi-size: 16, 32, 48, 64, 256)
// from Aurao's concentric gradient ring & "A" emblem using pure Node.js (zero native deps).
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_DIR = path.resolve(__dirname, '..', 'build');

function lerp(a, b, t) {
  return a + (b - a) * t;
}

function lerpColor(c1, c2, t) {
  return [
    Math.round(lerp(c1[0], c2[0], t)),
    Math.round(lerp(c1[1], c2[1], t)),
    Math.round(lerp(c1[2], c2[2], t)),
  ];
}

// Aurao gradient stops from index.html (#60a5fa -> #c084fc -> #f472b6 -> #fbbf24)
const STOPS = [
  { pos: 0.0, color: [0x60, 0xa5, 0xfa] },
  { pos: 0.38, color: [0xc0, 0x84, 0xfc] },
  { pos: 0.72, color: [0xf4, 0x72, 0xb6] },
  { pos: 1.0, color: [0xfb, 0xbf, 0x24] },
];

function gradientAt(u, v) {
  const t = Math.max(0, Math.min(1, (u + v) / 2));
  for (let i = 0; i < STOPS.length - 1; i++) {
    const s0 = STOPS[i];
    const s1 = STOPS[i + 1];
    if (t >= s0.pos && t <= s1.pos) {
      return lerpColor(s0.color, s1.color, (t - s0.pos) / (s1.pos - s0.pos));
    }
  }
  return STOPS[STOPS.length - 1].color;
}

// Signed checks for the "A" glyph in 44x44 viewBox coordinates:
// Outer A polygon: (22,13.5) -> (15.2,29.5) -> (18.6,29.5) -> (19.9,26.1) -> (24.1,26.1) -> (25.4,29.5) -> (28.8,29.5)
// Inner triangle hole: (20.9,23.3) -> (22,20.1) -> (23.1,23.3)
function pointInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1];
    const xj = poly[j][0], yj = poly[j][1];
    const intersect = ((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

const OUTER_A = [
  [22.0, 13.5],
  [15.2, 29.5],
  [18.6, 29.5],
  [19.9, 26.1],
  [24.1, 26.1],
  [25.4, 29.5],
  [28.8, 29.5],
];

const INNER_HOLE = [
  [20.9, 23.3],
  [22.0, 20.1],
  [23.1, 23.3],
];

function isInsideLetterA(vx, vy) {
  return pointInPolygon(vx, vy, OUTER_A) && !pointInPolygon(vx, vy, INNER_HOLE);
}

// Sample a single subpixel in 44x44 viewBox space -> [r, g, b, a]
function sampleSubpixel(vx, vy) {
  const dx = vx - 22;
  const dy = vy - 22;
  const dist = Math.hypot(dx, dy);
  if (dist > 20.5) return [0, 0, 0, 0];
  if (dist > 18.0) {
    const [r, g, b] = gradientAt(vx / 44, vy / 44);
    return [r, g, b, 255];
  }
  if (isInsideLetterA(vx, vy)) {
    return [255, 255, 255, 255];
  }
  return [0x0f, 0x17, 0x2a, 255];
}

// Render size x size RGBA buffer with 4x4 supersampling
function renderRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const grid = 4;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      let rSum = 0, gSum = 0, bSum = 0, aSum = 0;
      for (let sy = 0; sy < grid; sy++) {
        for (let sx = 0; sx < grid; sx++) {
          const vx = ((px + (sx + 0.5) / grid) / size) * 44;
          const vy = ((py + (sy + 0.5) / grid) / size) * 44;
          const [r, g, b, a] = sampleSubpixel(vx, vy);
          rSum += r * (a / 255);
          gSum += g * (a / 255);
          bSum += b * (a / 255);
          aSum += a;
        }
      }
      const samples = grid * grid;
      const aAvg = aSum / samples;
      const idx = (py * size + px) * 4;
      if (aAvg <= 0) {
        buf[idx] = buf[idx + 1] = buf[idx + 2] = buf[idx + 3] = 0;
      } else {
        const scale = 255 / aAvg;
        buf[idx] = Math.min(255, Math.round((rSum / samples) * scale));
        buf[idx + 1] = Math.min(255, Math.round((gSum / samples) * scale));
        buf[idx + 2] = Math.min(255, Math.round((bSum / samples) * scale));
        buf[idx + 3] = Math.min(255, Math.round(aAvg));
      }
    }
  }
  return buf;
}

// CRC32 for PNG chunks
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodePng(size, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0; // filter: None
    rgba.copy(raw, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// Encode a 32-bit BGRA BMP-DIB frame for standard ICO sizes (16, 32, 48, 64)
function encodeBmpDib(size, rgba) {
  const headerSize = 40;
  const xorSize = size * size * 4;
  const andRowBytes = Math.ceil(size / 32) * 4;
  const andSize = andRowBytes * size;
  const buf = Buffer.alloc(headerSize + xorSize + andSize);

  buf.writeUInt32LE(headerSize, 0);
  buf.writeInt32LE(size, 4);
  buf.writeInt32LE(size * 2, 8); // combined height of XOR + AND masks
  buf.writeUInt16LE(1, 12); // planes
  buf.writeUInt16LE(32, 14); // bpp
  buf.writeUInt32LE(0, 16); // BI_RGB
  buf.writeUInt32LE(xorSize + andSize, 20);

  // Bottom-up scanlines in BGRA order
  for (let y = 0; y < size; y++) {
    const srcY = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const sIdx = (srcY * size + x) * 4;
      const dIdx = headerSize + (y * size + x) * 4;
      buf[dIdx] = rgba[sIdx + 2];     // B
      buf[dIdx + 1] = rgba[sIdx + 1]; // G
      buf[dIdx + 2] = rgba[sIdx];     // R
      buf[dIdx + 3] = rgba[sIdx + 3]; // A
      if (rgba[sIdx + 3] === 0) {
        const andByteIdx = headerSize + xorSize + y * andRowBytes + (x >> 3);
        buf[andByteIdx] |= (0x80 >> (x & 7));
      }
    }
  }
  return buf;
}

function buildIco(sizes) {
  const frames = sizes.map((size) => {
    const rgba = renderRgba(size);
    const data = size >= 256 ? encodePng(size, rgba) : encodeBmpDib(size, rgba);
    return { size, data, rgba };
  });

  const dirHeader = Buffer.alloc(6);
  dirHeader.writeUInt16LE(0, 0); // reserved
  dirHeader.writeUInt16LE(1, 2); // type = 1 (ICO)
  dirHeader.writeUInt16LE(frames.length, 4);

  const entries = Buffer.alloc(frames.length * 16);
  let offset = 6 + entries.length;

  frames.forEach((f, i) => {
    const eOff = i * 16;
    entries[eOff] = f.size >= 256 ? 0 : f.size;
    entries[eOff + 1] = f.size >= 256 ? 0 : f.size;
    entries[eOff + 2] = 0; // palette
    entries[eOff + 3] = 0; // reserved
    entries.writeUInt16LE(1, eOff + 4); // color planes
    entries.writeUInt16LE(32, eOff + 6); // bits per pixel
    entries.writeUInt32LE(f.data.length, eOff + 8);
    entries.writeUInt32LE(offset, eOff + 12);
    offset += f.data.length;
  });

  const ico = Buffer.concat([dirHeader, entries, ...frames.map((f) => f.data)]);
  const png256 = encodePng(256, frames.find((f) => f.size === 256).rgba);
  return { ico, png256 };
}

fs.mkdirSync(OUT_DIR, { recursive: true });
const { ico, png256 } = buildIco([16, 32, 48, 64, 256]);
fs.writeFileSync(path.join(OUT_DIR, 'icon.ico'), ico);
fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), png256);
console.log(`Generated build/icon.ico (${ico.length} bytes) and build/icon.png (${png256.length} bytes)`);
