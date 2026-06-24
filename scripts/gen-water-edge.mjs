// Generates assets/water-edge.png — a vertical opacity gradient used as the
// river water's opacityTexture so its alpha ramps to 0 at the banks (soft
// waterline) instead of a hard edge. The water surface's cross-channel V runs
// 0.25→0.75, so the band is opaque in 0.34..0.66 and fades over 0.25..0.34 /
// 0.66..0.75. getAlphaFromRGB reads this greyscale as alpha.
//
//   node scripts/gen-water-edge.mjs
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'assets', 'water-edge.png');

const W = 8, H = 64;
const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const buf = Buffer.alloc(W * H * 3);
for (let y = 0; y < H; y++) {
  const v = y / (H - 1);
  const a = smooth(0.25, 0.34, v) * (1 - smooth(0.66, 0.75, v)); // opaque band, faded edges
  const c = Math.round(a * 255);
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 3;
    buf[i] = c; buf[i + 1] = c; buf[i + 2] = c;
  }
}
await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(OUT);
console.log('wrote', OUT, `(${W}x${H})`);
