// Renders the two source images that `tauri icon` expands into the bundle icon set.
// Usage: node scripts/generate-icons.mjs
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function encodePng(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0;
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const clamp01 = (value) => Math.min(1, Math.max(0, value));
const smoothCoverage = (distance) => clamp01(0.5 - distance);

function capsule(x, y, ax, ay, bx, by, radius) {
  const pax = x - ax;
  const pay = y - ay;
  const bax = bx - ax;
  const bay = by - ay;
  const h = clamp01((pax * bax + pay * bay) / (bax * bax + bay * bay || 1));
  const dx = pax - bax * h;
  const dy = pay - bay * h;
  return Math.hypot(dx, dy) - radius;
}

function roundedBox(x, y, cx, cy, half, radius) {
  const qx = Math.abs(x - cx) - (half - radius);
  const qy = Math.abs(y - cy) - (half - radius);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
}

function circle(x, y, cx, cy, radius) {
  return Math.hypot(x - cx, y - cy) - radius;
}

function ring(x, y, cx, cy, radius, thickness) {
  return Math.abs(circle(x, y, cx, cy, radius)) - thickness;
}

function painter(size) {
  const pixels = Buffer.alloc(size * size * 4);
  return {
    blend(index, [r, g, b], alpha) {
      if (alpha <= 0) return;
      const dstA = pixels[index + 3] / 255;
      const outA = alpha + dstA * (1 - alpha);
      if (outA <= 0) return;
      for (let channel = 0; channel < 3; channel += 1) {
        const src = [r, g, b][channel];
        const dst = pixels[index + channel];
        pixels[index + channel] = Math.round((src * alpha + dst * dstA * (1 - alpha)) / outA);
      }
      pixels[index + 3] = Math.round(outA * 255);
    },
    paint(shape, color) {
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          const alpha = smoothCoverage(shape(x + 0.5, y + 0.5));
          if (alpha > 0) this.blend((y * size + x) * 4, color, alpha);
        }
      }
    },
    pixels,
  };
}

const point = (angleDegrees, radius) => {
  const radians = (angleDegrees * Math.PI) / 180;
  return [Math.sin(radians) * radius, -Math.cos(radians) * radius];
};

function drawClock({ size, background, monochrome }) {
  const canvas = painter(size);
  const c = size / 2;
  const scale = size / 1024;

  if (background) {
    for (let y = 0; y < size; y += 1) {
      const t = y / size;
      const color = [Math.round(24 - 12 * t), Math.round(30 - 14 * t), Math.round(42 - 20 * t)];
      for (let x = 0; x < size; x += 1) {
        const alpha = smoothCoverage(roundedBox(x + 0.5, y + 0.5, c, c, 496 * scale, 230 * scale));
        if (alpha > 0) canvas.blend((y * size + x) * 4, color, alpha);
      }
    }
  }

  const ink = monochrome ? [255, 255, 255] : [238, 242, 248];
  const muted = monochrome ? [255, 255, 255] : [151, 163, 184];
  const accent = monochrome ? [255, 255, 255] : [255, 107, 94];

  canvas.paint((x, y) => ring(x, y, c, c, 430 * scale, 16 * scale), monochrome ? ink : muted);
  canvas.paint((x, y) => circle(x, y, c, c, 398 * scale), monochrome ? muted : [26, 33, 48]);

  for (let hour = 0; hour < 12; hour += 1) {
    const angle = hour * 30;
    const [ox, oy] = point(angle, 350 * scale);
    const [ix, iy] = point(angle, 300 * scale);
    const wide = hour % 3 === 0;
    canvas.paint(
      (x, y) => capsule(x, y, c + ix, c + iy, c + ox, c + oy, (wide ? 13 : 8) * scale),
      ink,
    );
  }

  const hands = [
    { angle: 305, length: 200, width: 19, color: ink },
    { angle: 60, length: 300, width: 13, color: ink },
    { angle: 200, length: 330, width: 6, color: accent },
  ];
  for (const hand of hands) {
    const [dx, dy] = point(hand.angle, hand.length * scale);
    const [tailX, tailY] = point(hand.angle + 180, 40 * scale);
    canvas.paint(
      (x, y) => capsule(x, y, c + tailX, c + tailY, c + dx, c + dy, hand.width * scale),
      hand.color,
    );
  }

  canvas.paint((x, y) => circle(x, y, c, c, 26 * scale), ink);
  return encodePng(size, size, canvas.pixels);
}

writeFileSync('src-tauri/icons/app-icon.png', drawClock({ size: 1024, background: true, monochrome: false }));
writeFileSync('src-tauri/icons/tray.png', drawClock({ size: 128, background: false, monochrome: true }));
console.log('wrote src-tauri/icons/app-icon.png and src-tauri/icons/tray.png');
