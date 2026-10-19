// Minimal PNG support in pure Node: an RGBA encoder (zlib.deflateSync + CRC32),
// an IHDR reader for validation, and the app icon generator used by `create`.

import { deflateSync } from 'node:zlib';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf, crc = 0) {
  let c = (crc ^ 0xffffffff) >>> 0;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

/**
 * Encodes 8-bit RGBA pixels. Each scanline picks the filter with the smallest
 * sum of absolute values, the usual heuristic, which keeps gradients small.
 */
export function encodePNG(width, height, rgba) {
  if (rgba.length !== width * height * 4) throw new Error('encodePNG: pixel buffer has the wrong size');
  const stride = width * 4;
  const out = Buffer.alloc((stride + 1) * height);
  const candidates = [0, 1, 2, 3, 4].map(() => Buffer.alloc(stride));
  const zero = Buffer.alloc(stride);

  for (let y = 0; y < height; y++) {
    const row = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgba.subarray((y - 1) * stride, y * stride) : zero;
    let best = 0;
    let bestSum = Infinity;
    for (let f = 0; f < 5; f++) {
      const dst = candidates[f];
      let sum = 0;
      for (let i = 0; i < stride; i++) {
        const a = i >= 4 ? row[i - 4] : 0;
        const b = prev[i];
        const c = i >= 4 ? prev[i - 4] : 0;
        let v;
        switch (f) {
          case 0: v = row[i]; break;
          case 1: v = row[i] - a; break;
          case 2: v = row[i] - b; break;
          case 3: v = row[i] - ((a + b) >> 1); break;
          default: v = row[i] - paeth(a, b, c);
        }
        v &= 0xff;
        dst[i] = v;
        sum += v < 128 ? v : 256 - v;
      }
      if (sum < bestSum) { bestSum = sum; best = f; }
    }
    const at = y * (stride + 1);
    out[at] = best;
    candidates[best].copy(out, at + 1);
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 6;   // color type: RGBA
  ihdr[10] = 0;  // compression
  ihdr[11] = 0;  // filter
  ihdr[12] = 0;  // interlace
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(out, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Reads the IHDR of a PNG. Returns null when the buffer is not a PNG.
 * @returns {{ width: number, height: number, bitDepth: number, colorType: number } | null}
 */
export function readPNGInfo(buf) {
  if (!buf || buf.length < 33 || !buf.subarray(0, 8).equals(SIGNATURE)) return null;
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null;
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
  };
}

// ------------------------------------------------------------ icon drawing

// Glyphs are signed distance functions in a 512-unit space (negative = inside),
// so edges are anti-aliased analytically without supersampling.

const len = (x, y) => Math.sqrt(x * x + y * y);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const smoothstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0), 0, 1); return t * t * (3 - 2 * t); };

function sdCircle(x, y, cx, cy, r) { return len(x - cx, y - cy) - r; }

function sdSegment(x, y, ax, ay, bx, by, r) {
  const pax = x - ax; const pay = y - ay;
  const bax = bx - ax; const bay = by - ay;
  const h = clamp((pax * bax + pay * bay) / (bax * bax + bay * bay), 0, 1);
  return len(pax - bax * h, pay - bay * h) - r;
}

// Equilateral-ish triangle pointing right, with rounded corners.
function sdPlay(x, y, cx, cy, size, r) {
  const pts = [[cx - size * 0.42, cy - size * 0.5], [cx + size * 0.58, cy], [cx - size * 0.42, cy + size * 0.5]];
  let d = Infinity;
  let inside = true;
  for (let i = 0; i < 3; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % 3];
    d = Math.min(d, sdSegment(x, y, ax, ay, bx, by, 0));
    if ((bx - ax) * (y - ay) - (by - ay) * (x - ax) < 0) inside = false;
  }
  return (inside ? -d : d) - r;
}

// Ring segment from angle a0 to a1 (radians, clockwise from 12 o'clock), round caps.
function sdArc(x, y, cx, cy, radius, width, a0, a1) {
  const dx = x - cx; const dy = y - cy;
  let a = Math.atan2(dx, -dy);
  if (a < 0) a += Math.PI * 2;
  const within = a0 <= a1 ? a >= a0 && a <= a1 : a >= a0 || a <= a1;
  if (within) return Math.abs(len(dx, dy) - radius) - width / 2;
  const cap = (t) => len(x - (cx + Math.sin(t) * radius), y - (cy - Math.cos(t) * radius)) - width / 2;
  return Math.min(cap(a0), cap(a1));
}

const GLYPHS = {
  // Steering wheel: rim plus three spokes around a hub.
  wheel(x, y) {
    const rim = Math.abs(sdCircle(x, y, 256, 256, 150)) - 26;
    const hub = sdCircle(x, y, 256, 268, 44);
    const s1 = sdSegment(x, y, 256, 268, 116, 236, 20);
    const s2 = sdSegment(x, y, 256, 268, 396, 236, 20);
    const s3 = sdSegment(x, y, 256, 268, 256, 400, 20);
    return Math.min(rim, hub, s1, s2, s3);
  },
  // Play button inside a soft disc outline.
  play(x, y) {
    const ring = Math.abs(sdCircle(x, y, 256, 256, 160)) - 18;
    const tri = sdPlay(x, y, 266, 256, 150, 16);
    return Math.min(ring, tri);
  },
  // Gauge: 270° arc, inner ticks, needle and pivot.
  gauge(x, y) {
    const arc = sdArc(x, y, 256, 276, 150, 40, Math.PI * 1.25, Math.PI * 0.75);
    let ticks = Infinity;
    for (const a of [-0.5, 0, 0.5]) {
      const t = a * Math.PI;
      const sx = Math.sin(t); const sy = -Math.cos(t);
      ticks = Math.min(ticks, sdSegment(x, y, 256 + sx * 96, 276 + sy * 96, 256 + sx * 112, 276 + sy * 112, 9));
    }
    const needle = sdSegment(x, y, 256, 276, 342, 190, 16);
    const pivot = sdCircle(x, y, 256, 276, 34);
    return Math.min(arc, ticks, needle, pivot);
  },
};

export const ICON_THEMES = {
  blank: { glyph: 'wheel', from: [10, 132, 255], to: [94, 92, 230] },
  media: { glyph: 'play', from: [255, 55, 95], to: [255, 149, 0] },
  dashboard: { glyph: 'gauge', from: [48, 209, 88], to: [0, 122, 255] },
};

/**
 * Draws a full-bleed square icon (CarPlay applies its own mask, so the corners
 * stay square): diagonal gradient, soft top-left light, white glyph with a
 * gentle drop shadow.
 */
export function drawIcon({ size = 512, glyph = 'wheel', from = [10, 132, 255], to = [94, 92, 230] } = {}) {
  const sdf = GLYPHS[glyph] || GLYPHS.wheel;
  const px = Buffer.alloc(size * size * 4);
  const k = 512 / size;
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      const x = (i + 0.5) * k;
      const y = (j + 0.5) * k;
      // Background gradient along the diagonal, plus a radial highlight.
      const t = clamp((x + y) / 1024, 0, 1);
      const glow = Math.max(0, 1 - len(x - 120, y - 80) / 520) * 0.22;
      let r = from[0] + (to[0] - from[0]) * t;
      let g = from[1] + (to[1] - from[1]) * t;
      let b = from[2] + (to[2] - from[2]) * t;
      r += (255 - r) * glow; g += (255 - g) * glow; b += (255 - b) * glow;

      // Drop shadow: the same shape, offset down, with a wide soft edge.
      const ds = sdf(x, y - 10);
      const shadow = (1 - smoothstep(-6, 26, ds)) * 0.28;
      r *= 1 - shadow; g *= 1 - shadow; b *= 1 - shadow;

      // Glyph coverage, 1px anti-aliased edge in output pixels.
      const d = sdf(x, y) / k;
      const a = clamp(0.5 - d, 0, 1);
      const o = (j * size + i) * 4;
      px[o] = Math.round(r + (255 - r) * a);
      px[o + 1] = Math.round(g + (255 - g) * a);
      px[o + 2] = Math.round(b + (255 - b) * a);
      px[o + 3] = 255;
    }
  }
  return encodePNG(size, size, px);
}
