// Generates a seamless tiling water-ripple NORMAL map → assets/water-normal.png
// Used by the river bed material (StandardMaterial.bumpTexture), scrolled along
// the flow axis so the sun glints break into moving ripples. Procedural (sum of
// integer-frequency sine waves → tiles exactly), so no external/binary asset.
//
//   node scripts/gen-water-normal.mjs
import sharp from 'sharp';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'assets', 'water-normal.png');

const W = 256;
const STRENGTH = 1.5; // ripple intensity (bigger = sharper normals, more glint)

// Directional ripple waves. Integer (fx,fy) ⇒ each sine tiles exactly over the
// [0,1] texture, so the whole map is seamless. MID/HIGH frequencies + many
// directions = fine, busy brook chop (lots of small ripples) without a single
// dominant repeat that reads as a grating. The tile scale (uScale/vScale, large)
// then shrinks these to small on-screen ripples fitting a ~2m-wide brook.
const waves = [
  [2, 1, 0.80, 0.0],
  [1, 2, 0.70, 1.7],
  [3, 2, 0.62, 0.5],
  [2, 3, 0.55, 2.3],
  [4, 3, 0.48, 3.1],
  [3, 4, 0.42, 0.9],
  [5, 4, 0.34, 1.4],
  [4, 6, 0.28, 2.7],
  [6, 5, 0.22, 0.4],
  [7, 6, 0.17, 1.9],
  [6, 8, 0.14, 2.6],
];
const TWO_PI = Math.PI * 2;
const h = (u, v) => {
  let s = 0;
  for (const [fx, fy, a, ph] of waves) s += a * Math.sin(TWO_PI * (fx * u + fy * v) + ph);
  return s;
};

const buf = Buffer.alloc(W * W * 3);
const eps = 1 / W;
for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const u = x / W, v = y / W;
    const dhdx = (h(u + eps, v) - h(u - eps, v)) / (2 * eps);
    const dhdy = (h(u, v + eps) - h(u, v - eps)) / (2 * eps);
    let nx = -dhdx * STRENGTH * 0.02;
    let ny = -dhdy * STRENGTH * 0.02;
    let nz = 1;
    const len = Math.hypot(nx, ny, nz);
    nx /= len; ny /= len; nz /= len;
    const i = (y * W + x) * 3;
    buf[i]     = Math.round((nx * 0.5 + 0.5) * 255);
    buf[i + 1] = Math.round((ny * 0.5 + 0.5) * 255);
    buf[i + 2] = Math.round((nz * 0.5 + 0.5) * 255);
  }
}
await sharp(buf, { raw: { width: W, height: W, channels: 3 } }).png().toFile(OUT);
console.log('wrote', OUT, `(${W}x${W})`);
