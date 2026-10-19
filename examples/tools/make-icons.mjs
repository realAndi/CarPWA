#!/usr/bin/env node
// Renders the example apps' icons: 512×512 opaque PNGs, flat shapes, square
// corners (CarPlay applies its own mask). No dependencies beyond node:zlib.
//
//   node examples/tools/make-icons.mjs            # writes every icon
//   node examples/tools/make-icons.mjs hello-car  # just one
//
// Shapes are signed distance functions; a pixel's coverage is how far its
// centre sits inside the edge, which gives one pixel of anti-aliasing for free.

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 512;
const EXAMPLES = dirname(dirname(fileURLToPath(import.meta.url)));

// ------------------------------------------------------------------ canvas

class Canvas {
  constructor(size) {
    this.size = size;
    this.px = new Float32Array(size * size * 3);
  }

  /** Paints `paint(x, y) → [r, g, b]` wherever `sdf(x, y)` is inside (≤ 0). */
  fill(sdf, paint, alpha = 1) {
    const { size, px } = this;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const cx = x + 0.5;
        const cy = y + 0.5;
        const cover = Math.min(1, Math.max(0, 0.5 - sdf(cx, cy))) * alpha;
        if (cover <= 0) continue;
        const [r, g, b] = paint(cx, cy);
        const i = (y * size + x) * 3;
        px[i] += (r - px[i]) * cover;
        px[i + 1] += (g - px[i + 1]) * cover;
        px[i + 2] += (b - px[i + 2]) * cover;
      }
    }
  }

  background(paint) {
    this.fill(() => -1, paint);
  }

  png() {
    const { size, px } = this;
    const stride = size * 3 + 1;
    const raw = Buffer.alloc(stride * size);
    for (let y = 0; y < size; y++) {
      raw[y * stride] = 0; // filter: none
      for (let x = 0; x < size * 3; x++) {
        raw[y * stride + 1 + x] = Math.round(Math.min(1, Math.max(0, px[y * size * 3 + x])) * 255);
      }
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // colour type: RGB
    return Buffer.concat([
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      chunk('IHDR', ihdr),
      chunk('IDAT', deflateSync(raw, { level: 9 })),
      chunk('IEND', Buffer.alloc(0)),
    ]);
  }
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

// ------------------------------------------------------------------ shapes

const circle = (cx, cy, r) => (x, y) => Math.hypot(x - cx, y - cy) - r;

const ellipse = (cx, cy, rx, ry, angle = 0) => {
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  return (x, y) => {
    const dx = x - cx;
    const dy = y - cy;
    const u = (dx * cos - dy * sin) / rx;
    const v = (dx * sin + dy * cos) / ry;
    return (Math.hypot(u, v) - 1) * Math.min(rx, ry);
  };
};

/** Axis-aligned rectangle from its corners, with corner radius r. */
const rect = (x0, y0, x1, y1, r = 0) => {
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  const hw = (x1 - x0) / 2;
  const hh = (y1 - y0) / 2;
  return (x, y) => {
    const qx = Math.abs(x - cx) - hw + r;
    const qy = Math.abs(y - cy) - hh + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
  };
};

/** Polygon from [x, y] points; `round` grows it outward with round corners. */
const polygon = (points, round = 0) => (x, y) => {
  let d = Infinity;
  let sign = 1;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [ax, ay] = points[j];
    const [bx, by] = points[i];
    const ex = bx - ax;
    const ey = by - ay;
    const wx = x - ax;
    const wy = y - ay;
    const t = Math.min(1, Math.max(0, (wx * ex + wy * ey) / (ex * ex + ey * ey)));
    d = Math.min(d, Math.hypot(wx - ex * t, wy - ey * t));
    const c1 = y >= ay;
    const c2 = y < by;
    const c3 = ex * wy > ey * wx;
    if ((c1 && c2 && c3) || (!c1 && !c2 && !c3)) sign = -sign;
  }
  return sign * d - round;
};

/** Ring segment: centre, radius, stroke width, from/to angles (radians, clockwise from 3 o'clock). */
const arc = (cx, cy, r, width, from, to) => (x, y) => {
  let a = Math.atan2(y - cy, x - cx);
  if (a < from) a += Math.PI * 2;
  if (a >= from && a <= to) return Math.abs(Math.hypot(x - cx, y - cy) - r) - width / 2;
  const end = (t) => Math.hypot(x - (cx + r * Math.cos(t)), y - (cy + r * Math.sin(t))) - width / 2;
  return Math.min(end(from), end(to));
};

/** Thick line segment with round caps. */
const line = (ax, ay, bx, by, width) => (x, y) => {
  const ex = bx - ax;
  const ey = by - ay;
  const t = Math.min(1, Math.max(0, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
  return Math.hypot(x - ax - ex * t, y - ay - ey * t) - width / 2;
};

const union = (...shapes) => (x, y) => Math.min(...shapes.map((s) => s(x, y)));

/** Moves a shape by (dx, dy), for centring a glyph without rewriting its numbers. */
const shift = (dx, dy, shape) => (x, y) => shape(x - dx, y - dy);

// ------------------------------------------------------------------ paints

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const solid = (h) => { const c = hex(h); return () => c; };

/** Linear gradient from (x0, y0) in colour a to (x1, y1) in colour b. */
const linear = (x0, y0, a, x1, y1, b) => {
  const ca = hex(a);
  const cb = hex(b);
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len2 = dx * dx + dy * dy;
  return (x, y) => {
    const t = Math.min(1, Math.max(0, ((x - x0) * dx + (y - y0) * dy) / len2));
    return [0, 1, 2].map((k) => ca[k] + (cb[k] - ca[k]) * t);
  };
};

// ------------------------------------------------------------------- icons

const ICONS = {
  // A car seen from the front, cut out of a CarPlay-blue tile.
  'hello-car': (cv) => {
    const bg = linear(0, 0, '#40a0ff', SIZE, SIZE, '#0058d6');
    const white = solid('#ffffff');
    const up = (shape) => shift(0, -22, shape);
    cv.background(bg);
    cv.fill(up(polygon([[150, 262], [190, 158], [322, 158], [362, 262]], 26)), white);  // cabin
    cv.fill(up(rect(98, 236, 414, 360, 46)), white);                                     // body
    cv.fill(up(rect(122, 330, 196, 404, 22)), white);                                    // wheels
    cv.fill(up(rect(316, 330, 390, 404, 22)), white);
    cv.fill(up(rect(70, 226, 112, 250, 12)), white);                                     // mirrors
    cv.fill(up(rect(400, 226, 442, 250, 12)), white);
    cv.fill(up(polygon([[186, 236], [212, 182], [300, 182], [326, 236]], 8)), bg);       // windshield
    cv.fill(up(circle(166, 296, 24)), bg);                                               // headlights
    cv.fill(up(circle(346, 296, 24)), bg);
    cv.fill(up(rect(214, 300, 298, 320, 10)), bg);                                       // grille
  },

  // Beamed eighth notes over a progress bar, on a warm red tile.
  'now-playing': (cv) => {
    cv.background(linear(0, 0, '#ff6b81', SIZE, SIZE, '#d1173d'));
    const white = solid('#ffffff');
    cv.fill(shift(-18, -12, union(
      ellipse(196, 332, 54, 40, -0.35),
      ellipse(352, 302, 54, 40, -0.35),
      rect(226, 150, 252, 330, 6),
      rect(382, 120, 408, 300, 6),
      polygon([[226, 146], [408, 114], [408, 176], [226, 208]], 6),
    )), white);
    cv.fill(rect(112, 410, 400, 426, 8), white, 0.35);                              // progress track
    cv.fill(rect(112, 410, 290, 426, 8), white);                                     // progress fill
  },

  // Four widgets of different sizes, like the dashboard itself.
  dashboard: (cv) => {
    cv.background(linear(0, 0, '#3a3a3c', SIZE, SIZE, '#0b0b0c'));
    const white = solid('#ffffff');
    // Clock tile.
    cv.fill(rect(84, 84, 300, 300, 40), linear(84, 84, '#4aa3ff', 300, 300, '#0a6cff'));
    cv.fill(arc(192, 192, 62, 16, 0, Math.PI * 2), white);
    cv.fill(line(192, 192, 192, 152, 16), white);
    cv.fill(line(192, 192, 222, 208, 16), white);
    // Weather tile.
    cv.fill(rect(320, 84, 428, 300, 34), linear(320, 84, '#ffc233', 428, 300, '#ff8a00'));
    cv.fill(circle(374, 150, 28), white);
    cv.fill(rect(344, 214, 404, 230, 8), white, 0.85);
    cv.fill(rect(344, 246, 386, 262, 8), white, 0.6);
    // Navigation tile.
    cv.fill(rect(84, 320, 192, 428, 34), linear(84, 320, '#4be07a', 192, 428, '#1fb24c'));
    cv.fill(polygon([[138, 344], [168, 404], [138, 390], [108, 404]], 4), white);
    // Music tile.
    cv.fill(rect(212, 320, 428, 428, 34), linear(212, 320, '#ff6b81', 428, 428, '#d1173d'));
    cv.fill(rect(244, 366, 396, 382, 8), white, 0.35);
    cv.fill(rect(244, 366, 340, 382, 8), white);
  },

  // A prompt and a cursor in phosphor green, on a black screen.
  terminal: (cv) => {
    cv.background(linear(0, 0, '#16201a', SIZE, SIZE, '#020403'));
    const green = solid('#8affb0');
    const screen = rect(70, 70, 442, 442, 56);
    cv.fill(screen, solid('#07100a'));
    cv.fill((x, y) => Math.max(screen(x, y), y - 132), solid('#1f3d2a'));           // title bar: the screen's top
    for (const [x, c] of [[118, '#ff6b6b'], [158, '#ffb347'], [198, '#8affb0']]) cv.fill(circle(x, 101, 13), solid(c));
    cv.fill(union(line(136, 220, 214, 286, 34), line(136, 352, 214, 286, 34)), green);   // >
    cv.fill(rect(250, 336, 370, 368, 8), green);                                     // _
  },
};

const wanted = process.argv.slice(2);
for (const [name, draw] of Object.entries(ICONS)) {
  if (wanted.length && !wanted.includes(name)) continue;
  const cv = new Canvas(SIZE);
  draw(cv);
  const out = join(EXAMPLES, name, 'icon.png');
  writeFileSync(out, cv.png());
  console.log(`wrote ${out}`);
}
