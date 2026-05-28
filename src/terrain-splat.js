// Per-vertex terrain texture-splatting — pure helpers (no DOM, no Babylon).
//
// The 3D renderer can render the playable map as a SINGLE merged ground mesh
// whose fragments blend three tiling greyscale DETAIL textures (grass / dirt /
// forest) by per-vertex material weights, multiplied by a procedural COLOR map.
// This module owns the CPU-side maths: which channel a tile belongs to, the
// per-vertex blend weights (so terrain types fade smoothly across hex
// boundaries), the world→hex inverse used for picking, the procedural colour
// reference that the GLSL fragment shader mirrors, and the per-vertex fog
// weights.
//
// All functions here are deterministic and Babylon-free so they can be unit
// tested in node. The GLSL plugin (`terrain-splat-plugin.js`) mirrors
// `proceduralTerrainColor` in a `procColor()` helper — the two are kept
// visually (not bit-) identical.

import { baseOf, TileType } from './tiles.js';

export const SPLAT_GRASS = 0;
export const SPLAT_DIRT = 1;
export const SPLAT_FOREST = 2;
export const SPLAT_CHANNELS = 3;

const SQRT3 = Math.sqrt(3);

// Neighbour direction deltas in offset coords (odd-r), index-aligned with
// `hex.js` DIRS_EVEN / DIRS_ODD. Replicated here (rather than importing
// `getNeighbors`) because `getNeighbors` filters out negative coords, which
// would misalign the direction index → we need the raw 6-entry arrays so a
// corner can address a specific neighbour by direction index.
const DIRS_EVEN = [[-1, 0], [-1, -1], [0, -1], [1, 0], [0, 1], [-1, 1]];
const DIRS_ODD  = [[-1, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1]];

// `_buildFlatHexMesh` lays rim vertex i at angle (π/6 + i·π/3). Each rim vertex
// is a hex CORNER shared by two edges; each edge faces one neighbour. Mapping
// (verified by computing neighbour world-angles for both row parities — the
// direction-index → world-angle table is identical for even and odd rows):
//   corner i (angle 30°+i·60°) is shared by the neighbours whose edge centres
//   sit at angle (corner−30°) and (corner+30°).
// Edge-centre angles → direction index: {0°:3, 60°:4, 120°:5, 180°:0, 240°:1,
// 300°:2}. So:
const CORNER_NEIGHBOR_DIRS = [
  [3, 4], // corner 0 (30°)  ↔ edges 0°,60°
  [4, 5], // corner 1 (90°)  ↔ edges 60°,120°
  [5, 0], // corner 2 (150°) ↔ edges 120°,180°
  [0, 1], // corner 3 (210°) ↔ edges 180°,240°
  [1, 2], // corner 4 (270°) ↔ edges 240°,300°
  [2, 3], // corner 5 (330°) ↔ edges 300°,0°
];

/** The splat channel a tile's GROUND belongs to. Mirrors the base-material
 *  logic of `terrainSpriteIdFor`: a tile's ground is its real BASE layer
 *  (`baseOf`), so a road / river / bridge / building inherits whatever it was
 *  laid over (a building's base is dirt; a road over grass stays grass).
 *
 *  FOREST base maps to the dedicated FOREST channel: the original 2D
 *  forest→grass swap existed because a *painted* forest sprite clashed with
 *  the 3D cone silhouettes — but a greyscale detail map + a forest-floor
 *  colour tint reads as undergrowth UNDER the cones, so it's an asset to use,
 *  not avoid. (To restore strict 2D parity, return SPLAT_GRASS here instead.) */
export function splatChannelForTile(tile) {
  const base = baseOf(tile);
  if (base === TileType.DIRT) return SPLAT_DIRT;
  if (base === TileType.FOREST) return SPLAT_FOREST;
  return SPLAT_GRASS; // grass + any path/structure laid over a grass base
}

/** Blend weights for a single vertex. Returns a normalized [w0,w1,w2] summing
 *  to 1.
 *
 *  Centre vertex → 100% own channel. Rim (corner) vertex → the symmetric
 *  average of the channels of the hexes incident to that corner (own + the up
 *  to two neighbours the corner faces). The incident-set average is the key to
 *  edge continuity: a corner is shared by (at most) three hexes, and every one
 *  of them sees the SAME multiset of incident channels, so each computes an
 *  identical weight at that coincident world position — the GPU's per-fragment
 *  interpolation then matches on both sides of every shared edge.
 *
 *  `blendShare` biases between own-only (0) and the symmetric average (0.5+).
 *  At the default 0.5 the rim is the pure symmetric average (edge-continuous).
 *  Lowering it sharpens the blend toward `own` at the cost of strict symmetry. */
export function vertexSplatWeights(own, neighborChannels, isCenter, { blendShare = 0.5 } = {}) {
  if (isCenter || !neighborChannels || neighborChannels.length === 0) {
    const w = [0, 0, 0];
    w[own] = 1;
    return w;
  }
  const incident = [own];
  for (const c of neighborChannels) {
    if (c !== null && c !== undefined) incident.push(c);
  }
  const avg = [0, 0, 0];
  for (const c of incident) avg[c] += 1 / incident.length;

  const t = Math.max(0, Math.min(1, blendShare * 2));
  const w = [0, 0, 0];
  w[own] += (1 - t); // own-only contribution
  for (let i = 0; i < 3; i++) w[i] += t * avg[i];

  const s = w[0] + w[1] + w[2] || 1;
  return [w[0] / s, w[1] / s, w[2] / s];
}

/** Per-vertex splat weights for a whole hex fan, row-major in the vertex order
 *  `_buildFlatHexMesh` emits: vertex 0 = centre, vertices 1..6 = rim corners at
 *  angle (π/6 + i·π/3). Returns a Float32Array(7*3).
 *
 *  `channelAt(col,row) -> 0|1|2|null` resolves a neighbour's channel (null when
 *  off-map). */
export function hexSplatWeights(tile, channelAt, opts = {}) {
  const out = new Float32Array(SPLAT_CHANNELS * 7);
  const own = splatChannelForTile(tile);

  const c = vertexSplatWeights(own, null, true, opts);
  out[0] = c[0]; out[1] = c[1]; out[2] = c[2];

  const dirs = (tile.row & 1) ? DIRS_ODD : DIRS_EVEN;
  for (let i = 0; i < 6; i++) {
    const [da, db] = CORNER_NEIGHBOR_DIRS[i];
    const na = neighborChannelVia(tile, dirs, da, channelAt);
    const nb = neighborChannelVia(tile, dirs, db, channelAt);
    const w = vertexSplatWeights(own, [na, nb], false, opts);
    const base = (i + 1) * SPLAT_CHANNELS;
    out[base] = w[0]; out[base + 1] = w[1]; out[base + 2] = w[2];
  }
  return out;
}

function neighborChannelVia(tile, dirs, dirIdx, channelAt) {
  const [dc, dr] = dirs[dirIdx];
  return channelAt(tile.col + dc, tile.row + dr);
}

// ── World ↔ hex (algebraic inverse of `hexToWorld`) ────────────────────────
// `hexToWorld(col,row,R)` = { x: R√3·(col+0.5·(row&1)), z: R·1.5·row }. This is
// the same pointy-top layout as `hexToPixel(size)`, so the inverse is the same
// axial-rounding `pixelToHex` math with size = R.

function axialRound(q, r) {
  const s = -q - r;
  let rq = Math.round(q), rr = Math.round(r);
  const rs = Math.round(s);
  const dq = Math.abs(rq - q), dr = Math.abs(rr - r), ds = Math.abs(rs - s);
  if (dq > dr && dq > ds) rq = -rr - rs;
  else if (dr > ds) rr = -rq - rs;
  return { q: rq, r: rr };
}

/** World (x,z) → offset (col,row). Exact algebraic inverse of `hexToWorld`
 *  (mapRoot has no transform offset, so world XZ == tile-local XZ). Uses axial
 *  rounding so points near a hex boundary resolve to the correct cell. */
export function worldToHex(x, z, radius = 1) {
  const q = (SQRT3 / 3 * x - 1 / 3 * z) / radius;
  const r = (2 / 3 * z) / radius;
  const { q: rq, r: rr } = axialRound(q, r);
  // `+ 0` normalizes JS's signed zero (-0 from Math.round) to +0 so callers
  // and tests see a canonical { col: 0, row: 0 }.
  return { col: (rq + (rr - (rr & 1)) / 2) + 0, row: rr + 0 };
}

// ── Procedural terrain colour (CPU reference for the GLSL `procColor`) ──────

/** Per-terrain base colour tint (0..1 RGB), one per splat channel. Multiplied
 *  by the value-noise variation and the greyscale detail texel in the shader. */
export const DEFAULT_TERRAIN_TINTS = [
  [0.34, 0.50, 0.24], // grass — cool meadow green
  [0.52, 0.42, 0.28], // dirt  — warm earth
  [0.24, 0.38, 0.20], // forest floor — deep mossy green
];

export const DEFAULT_COLOR_VARIATION = Object.freeze({ amp: 0.18, freq: 0.12 });

function hash2(ix, iz) {
  const s = Math.sin(ix * 127.1 + iz * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function smoothstep01(t) {
  return t * t * (3 - 2 * t);
}

/** Deterministic value noise on the integer lattice, smoothstep-interpolated.
 *  Returns 0..1. Exported for the test + the renderer to seed identical
 *  large-scale variation as the GLSL mirror. */
export function valueNoise2D(x, z) {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const ux = smoothstep01(fx), uz = smoothstep01(fz);
  const a = hash2(ix, iz);
  const b = hash2(ix + 1, iz);
  const c = hash2(ix, iz + 1);
  const d = hash2(ix + 1, iz + 1);
  const top = a * (1 - ux) + b * ux;
  const bot = c * (1 - ux) + d * ux;
  return top * (1 - uz) + bot * uz;
}

/** Procedural ground colour for a splat channel at a world XZ point. Returns
 *  an [r,g,b] in 0..1: the channel's base tint modulated by large-scale value
 *  noise (so a grass field varies between lighter/darker green instead of one
 *  flat tone). This is the CPU reference the GLSL `procColor()` mirrors. */
export function proceduralTerrainColor(channel, worldX, worldZ, opts = {}) {
  const baseTints = opts.baseTints || DEFAULT_TERRAIN_TINTS;
  const variation = opts.variation || DEFAULT_COLOR_VARIATION;
  const amp = variation.amp ?? DEFAULT_COLOR_VARIATION.amp;
  const freq = variation.freq ?? DEFAULT_COLOR_VARIATION.freq;
  const tint = baseTints[channel] || baseTints[0];
  const n = valueNoise2D(worldX * freq, worldZ * freq); // 0..1
  const m = 1 + (n - 0.5) * 2 * amp; // 1 ± amp
  return [
    Math.min(1, Math.max(0, tint[0] * m)),
    Math.min(1, Math.max(0, tint[1] * m)),
    Math.min(1, Math.max(0, tint[2] * m)),
  ];
}

// ── Fog weights ────────────────────────────────────────────────────────────

/** Per-vertex fog weights (0 = unfogged, 1 = fogged) for one hex fan, matching
 *  `_buildFlatHexMesh` vertex order: Float32Array(7).
 *
 *  Centre = own hex's fog state. Rim corners = the symmetric average of the
 *  incident hexes' fog states (own + the up-to-two neighbours the corner
 *  faces) — same incident-set averaging as `vertexSplatWeights`, so the soft
 *  veil edge is continuous across shared edges.
 *
 *  `neighborKeys` is a 6-entry array of hexKey strings (or null for off-map),
 *  index-aligned with the odd-r DIRS arrays. `foggedSet` is the Set of fogged
 *  hexKeys. */
/** Map an ArcRotate camera radius to the hex-wireframe overlay alpha. Pure for
 *  testability — the renderer calls this each frame and assigns the result to
 *  `_hexGridMesh.material.alpha`. At the close-in zoom (`radius ≤ minR`) the
 *  grid sits at full `peak` alpha; at max zoom-out it eases toward
 *  `minVisible`. Smoothstep on `(radius-minR)/(maxR-minR)` keeps the fade
 *  perceptually even across the zoom range. */
export function hexGridAlphaForZoom(radius, minR, maxR, opts = {}) {
  const peak = opts.peak ?? 0.5;
  const minVisible = opts.minVisible ?? 0;
  if (!(maxR > minR)) return peak;
  const t = Math.max(0, Math.min(1, (radius - minR) / (maxR - minR)));
  const eased = t * t * (3 - 2 * t); // smoothstep
  return minVisible + (peak - minVisible) * (1 - eased);
}

export function hexFogWeights(tileKey, neighborKeys, foggedSet, opts = {}) {
  // softness=0 (default) → rim verts carry the OWN value, producing a uniform
  // fog state per hex with a crisp jump at the boundary — reads as a clear
  // "you cannot see this hex" signal. softness=1 → original rim-averages-with-
  // neighbour behaviour, giving a soft fade across the boundary.
  const softness = Math.max(0, Math.min(1, opts.softness ?? 0));
  const out = new Float32Array(7);
  const fogOf = (k) => (k != null && foggedSet.has(k) ? 1 : 0);
  const own = fogOf(tileKey);
  out[0] = own;
  for (let i = 0; i < 6; i++) {
    if (softness === 0) { out[i + 1] = own; continue; }
    const [da, db] = CORNER_NEIGHBOR_DIRS[i];
    let sum = own;
    let count = 1;
    const ka = neighborKeys ? neighborKeys[da] : null;
    const kb = neighborKeys ? neighborKeys[db] : null;
    if (ka != null) { sum += fogOf(ka); count++; }
    if (kb != null) { sum += fogOf(kb); count++; }
    const avg = sum / count;
    out[i + 1] = own + (avg - own) * softness;
  }
  return out;
}

/** The 6 neighbour (col,row) deltas for a hex row parity, index-aligned with
 *  the DIRS arrays + `hexFogWeights` / `hexSplatWeights`. Exported so the
 *  renderer builds `neighborKeys` in the matching order. */
export function neighborDeltas(row) {
  return (row & 1) ? DIRS_ODD : DIRS_EVEN;
}
