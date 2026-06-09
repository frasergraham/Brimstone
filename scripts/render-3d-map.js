#!/usr/bin/env node
// ============================================================================
// render-3d-map.js — Headless screenshot CLI for the 3D map renderer
// ============================================================================
//
// Usage:
//   node scripts/render-3d-map.js [--size skirmish|standard|regional|campaign]
//                                 [--seed N] [--out path] [--width W] [--height H]
//
// Example:
//   node scripts/render-3d-map.js --seed 42 --size skirmish --out /tmp/m.png
//
// Output: a PNG of an isometric "3D-style" preview of the generated map.
// Deterministic for a given seed/size/dimensions tuple — same inputs yield
// byte-identical bytes (the precondition for visual regression baselines).
//
// ── Why this script does not import src/renderer-3d.js (yet) ────────────────
//
// Renderer3D lazy-loads Babylon.js via a CDN URL dynamic import:
//     await import('https://cdn.jsdelivr.net/npm/@babylonjs/core@7.42.0/+esm')
// Node.js does not natively resolve `https://` ESM imports (the experimental
// flag was removed in Node 22+). Even if Babylon were locally installed,
// `BABYLON.NullEngine` is a no-op engine: it stubs the WebGL API enough to
// let scene construction run for unit tests, but it does NOT rasterize —
// `readPixels()` returns a zero-filled buffer. There is no software
// rasterizer shipped with Babylon.
//
// So a "screenshot via NullEngine" today would yield a blank/zero PNG, which
// is useless for PR previews and visual regression baselines.
//
// The pragmatic alternative used here: render an isometric (axonometric)
// projection of the same hex map via the `canvas` package (already a project
// dependency, used by scripts/map-render.js). This produces a real,
// visually meaningful preview that approximates the eventual 3D look —
// hex prisms with side faces, soft shading, height variation. As later
// phases of the 3D renderer come online and a real headless WebGL path
// becomes viable (e.g. via Puppeteer driving scripts/3d-preview.html), this
// script can be re-pointed at the real renderer.
//
// Until then, both this CLI and the live preview share the same map
// generator, so the headless preview is faithful to the gameplay layout
// even if the visual shading differs slightly from the browser 3D scene.
// ============================================================================

import { createCanvas, registerFont } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { generateMap, MAP_SIZES } from '../src/map.js';
import { setMapDimensions, hexKey, hexToPixel, SQRT3 } from '../src/hex.js';
import { TileType, TILE_COLOR, BUILDING_COLOR, BUILDING_LABEL, legacyTileType, hasBuilding, isRiver, isBridge, pathOf } from '../src/tiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VALID_SIZES = Object.keys(MAP_SIZES);
const DEFAULT_WIDTH  = 1280;
const DEFAULT_HEIGHT = 720;

// ── Font registration (so building labels render with a known glyph set) ─────

const FONT_FAMILY = 'BrimstoneSerif';
const _fontPath = path.join(__dirname, '..', 'assets', 'fonts', 'DejaVuSerif-Bold.ttf');
let _fontRegistered = false;
function _ensureFontRegistered() {
  if (_fontRegistered) return;
  try {
    if (fs.existsSync(_fontPath)) {
      registerFont(_fontPath, { family: FONT_FAMILY, weight: 'bold' });
    }
  } catch { /* fall back to system serif */ }
  _fontRegistered = true;
}

// ── CLI parsing ──────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = {
    size:   'standard',
    seed:   null,
    out:    null,
    width:  DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--size')        args.size   = next();
    else if (a === '--seed')   args.seed   = parseInt(next(), 10);
    else if (a === '--out')    args.out    = next();
    else if (a === '--width')  args.width  = parseInt(next(), 10);
    else if (a === '--height') args.height = parseInt(next(), 10);
    else if (a === '--help' || a === '-h') { _printHelp(); process.exit(0); }
    else { console.error(`Unknown arg: ${a}`); _printHelp(); process.exit(2); }
  }
  return args;
}

function _printHelp() {
  console.error(
    'Usage: node scripts/render-3d-map.js \\\n' +
    '         [--size skirmish|standard|regional|campaign] \\\n' +
    '         [--seed N] [--out path] [--width W] [--height H]\n',
  );
}

// ── Isometric projection ─────────────────────────────────────────────────────
//
// We project world-space (x, y, z) onto 2D using a fixed axonometric matrix.
// World axes: +x → east, +y → south (map convention), +z → up.
// Standard 30° isometric:
//   screenX =  (x - y) * cos(30°)
//   screenY =  (x + y) * sin(30°) - z
//
// hexToPixel() gives us pointy-top hex centers in flat 2D map space. We treat
// those (x, y) as world coordinates and lift hex tops to z = tileHeight.

const ISO_COS = Math.cos(Math.PI / 6);   // ≈ 0.8660
const ISO_SIN = Math.sin(Math.PI / 6);   // 0.5

function project(wx, wy, wz) {
  return {
    x: (wx - wy) * ISO_COS,
    y: (wx + wy) * ISO_SIN - wz,
  };
}

// Six pointy-top hex corners in world XY (z=0). Index 0 is the top vertex,
// clockwise from there.
function hexCornersXY(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 90); // top first
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return pts;
}

// Darken a hex string by `factor` (0..1) — used for hex side faces.
function darken(hex, factor) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  const r = Math.max(0, Math.min(255, Math.round(((n >> 16) & 0xff) * factor)));
  const g = Math.max(0, Math.min(255, Math.round(((n >>  8) & 0xff) * factor)));
  const b = Math.max(0, Math.min(255, Math.round(( n        & 0xff) * factor)));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

// Per-tile height in world units. Buildings rise above grass; forests are
// medium-height; water sits below grass; everything else is grass level.
function tileHeight(tile) {
  if (!tile) return 0;
  switch (legacyTileType(tile)) {
    case TileType.BUILDING: return 0.95;
    case TileType.FOREST:   return 0.55;
    case TileType.HILL:     return 0.65;
    case TileType.MOUNTAIN: return 0.95;
    case TileType.DIRT:     return 0.15;
    case TileType.RIVER:    return -0.05;
    case TileType.BRIDGE:   return 0.10;
    case TileType.ROAD:     return 0.10;
    default:                return 0.20; // grass / default
  }
}

function tileFillColor(tile) {
  if (!tile) return TILE_COLOR[TileType.GRASS];
  if (hasBuilding(tile)) return BUILDING_COLOR[tile.building] ?? '#8a7a5a';
  if (pathOf(tile) === TileType.ROAD || isBridge(tile)) return '#6b5a3a';
  if (isRiver(tile)) return TILE_COLOR[TileType.RIVER];
  return TILE_COLOR[legacyTileType(tile)] ?? TILE_COLOR[TileType.GRASS];
}

// ── Main render ──────────────────────────────────────────────────────────────

export function render3DMapToBuffer({ seed, size = 'standard', width = DEFAULT_WIDTH, height = DEFAULT_HEIGHT } = {}) {
  if (!MAP_SIZES[size]) {
    throw new Error(`Unknown map size "${size}". Valid: ${VALID_SIZES.join(', ')}`);
  }
  if (seed == null || Number.isNaN(seed)) {
    throw new Error('seed is required');
  }

  _ensureFontRegistered();

  const cfg = MAP_SIZES[size];
  setMapDimensions(cfg.cols, cfg.rows);

  const { tiles, witchObjectives, heroStart, witchStart } = generateMap(seed, size);

  // Hex world size (the cells live in flat 2D world space before projection).
  // Pick something that gives reasonable density on the target canvas.
  const hs = 32;

  // Compute projected bounding box so we can centre and scale to the canvas.
  let minX =  Infinity, maxX = -Infinity;
  let minY =  Infinity, maxY = -Infinity;
  for (let row = 0; row < cfg.rows; row++) {
    for (let col = 0; col < cfg.cols; col++) {
      const { x: wx, y: wy } = hexToPixel(col, row, hs);
      const corners = hexCornersXY(wx, wy, hs);
      const tile = tiles.get(hexKey(col, row));
      const tz = tileHeight(tile) * hs;
      for (const c of corners) {
        const p0 = project(c.x, c.y, 0);
        const p1 = project(c.x, c.y, tz);
        if (p0.x < minX) minX = p0.x;
        if (p0.x > maxX) maxX = p0.x;
        if (p0.y < minY) minY = p0.y;
        if (p0.y > maxY) maxY = p0.y;
        if (p1.y < minY) minY = p1.y;
      }
    }
  }

  // Margin in canvas pixels around the map.
  const margin = 32;
  const worldW = maxX - minX;
  const worldH = maxY - minY;
  const scale  = Math.min((width - margin * 2) / worldW, (height - margin * 2) / worldH);
  const offX   = (width  - worldW * scale) / 2 - minX * scale;
  const offY   = (height - worldH * scale) / 2 - minY * scale;

  const canvas = createCanvas(width, height);
  const ctx    = canvas.getContext('2d');

  // ── Background gradient: dark gothic sky → near-black ground glow ──────────
  const sky = ctx.createLinearGradient(0, 0, 0, height);
  sky.addColorStop(0,    '#0d0a14');
  sky.addColorStop(0.65, '#13101c');
  sky.addColorStop(1,    '#0a0810');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, width, height);

  // Convert a (world x, world y, world z) point into canvas pixel coords.
  function toCanvas(wx, wy, wz = 0) {
    const p = project(wx, wy, wz);
    return { x: p.x * scale + offX, y: p.y * scale + offY };
  }

  // Painter's algorithm: iterate hexes in row order (which approximates depth
  // for a 30° iso view since +y goes "back" into the screen). Within a row,
  // left-to-right is fine.
  for (let row = 0; row < cfg.rows; row++) {
    for (let col = 0; col < cfg.cols; col++) {
      const tile = tiles.get(hexKey(col, row));
      if (!tile) continue;

      const { x: wx, y: wy } = hexToPixel(col, row, hs);
      const corners = hexCornersXY(wx, wy, hs * 0.96); // small gap between tiles
      const tz = tileHeight(tile) * hs;
      const baseColor = tileFillColor(tile);

      // Side faces — only those facing "the camera" (positive screen-x or
      // positive screen-y direction in projection). For 30° iso, the visible
      // sides are the three on the +x/+y/front half of each hex; we draw the
      // three corner-pairs whose midpoint is closer to camera by checking
      // projected Y of the top vs base.
      for (let i = 0; i < 6; i++) {
        const a = corners[i];
        const b = corners[(i + 1) % 6];
        const aTop  = toCanvas(a.x, a.y, tz);
        const bTop  = toCanvas(b.x, b.y, tz);
        const aBase = toCanvas(a.x, a.y, 0);
        const bBase = toCanvas(b.x, b.y, 0);
        // Skip back-facing sides (whose base sits above the top in screen Y).
        const midTop  = (aTop.y  + bTop.y)  / 2;
        const midBase = (aBase.y + bBase.y) / 2;
        if (midBase <= midTop) continue;

        // Edge orientation drives shading: edges parallel to world-x are
        // "lit" sides; edges parallel to world-y are "shadowed" sides; the
        // others land between.
        const edgeAngle = Math.atan2(b.y - a.y, b.x - a.x);
        const shade = 0.55 + 0.25 * Math.abs(Math.cos(edgeAngle));
        ctx.fillStyle = darken(baseColor, shade);
        ctx.beginPath();
        ctx.moveTo(aTop.x,  aTop.y);
        ctx.lineTo(bTop.x,  bTop.y);
        ctx.lineTo(bBase.x, bBase.y);
        ctx.lineTo(aBase.x, aBase.y);
        ctx.closePath();
        ctx.fill();
      }

      // Top face
      ctx.fillStyle = baseColor;
      ctx.beginPath();
      const c0 = toCanvas(corners[0].x, corners[0].y, tz);
      ctx.moveTo(c0.x, c0.y);
      for (let i = 1; i < 6; i++) {
        const c = toCanvas(corners[i].x, corners[i].y, tz);
        ctx.lineTo(c.x, c.y);
      }
      ctx.closePath();
      ctx.fill();

      // Subtle outline on the top face for readability.
      ctx.strokeStyle = 'rgba(10,8,14,0.55)';
      ctx.lineWidth   = 0.8;
      ctx.stroke();

      // Building label
      if (hasBuilding(tile) && tile.building) {
        const label = BUILDING_LABEL[tile.building] ?? tile.building;
        const centre = toCanvas(wx, wy, tz);
        ctx.fillStyle    = 'rgba(255,248,230,0.92)';
        ctx.font         = `bold ${Math.max(8, Math.floor(hs * scale * 0.18))}px ${FONT_FAMILY}, Georgia, serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, centre.x, centre.y);
      }
    }
  }

  // ── Power nodes (purple glow + glyph) ──────────────────────────────────────
  for (const obj of witchObjectives) {
    const { x: wx, y: wy } = hexToPixel(obj.col, obj.row, hs);
    const tile = tiles.get(hexKey(obj.col, obj.row));
    const tz = tileHeight(tile) * hs;
    const centre = toCanvas(wx, wy, tz);

    const r = hs * scale * 1.0;
    const grad = ctx.createRadialGradient(centre.x, centre.y, r * 0.1, centre.x, centre.y, r);
    grad.addColorStop(0, 'rgba(155,89,182,0.65)');
    grad.addColorStop(1, 'rgba(155,89,182,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle    = 'rgba(220,180,255,0.95)';
    ctx.font         = `bold ${Math.floor(hs * scale * 0.45)}px ${FONT_FAMILY}, Georgia, serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⛧', centre.x, centre.y - hs * scale * 0.08);

    if (obj.label) {
      ctx.fillStyle = 'rgba(220,180,255,0.85)';
      ctx.font      = `bold ${Math.max(8, Math.floor(hs * scale * 0.20))}px ${FONT_FAMILY}, Georgia, serif`;
      ctx.fillText(obj.label, centre.x, centre.y + hs * scale * 0.45);
    }
  }

  // ── Start markers ──────────────────────────────────────────────────────────
  function drawStartMarker(col, row, glyph, color) {
    const { x: wx, y: wy } = hexToPixel(col, row, hs);
    const tile = tiles.get(hexKey(col, row));
    const tz = tileHeight(tile) * hs;
    const centre = toCanvas(wx, wy, tz);
    const r = hs * scale * 0.34;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(centre.x, centre.y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle    = color;
    ctx.font         = `bold ${Math.floor(hs * scale * 0.38)}px ${FONT_FAMILY}, Georgia, serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, centre.x, centre.y);
  }
  if (heroStart)  drawStartMarker(heroStart.col,  heroStart.row,  '⚔', '#d4a72c');
  if (witchStart) drawStartMarker(witchStart.col, witchStart.row, '✦', '#9b59b6');

  // ── Caption (size + seed, top-right) ───────────────────────────────────────
  ctx.fillStyle    = 'rgba(180,170,150,0.80)';
  ctx.font         = `${Math.max(11, Math.floor(height * 0.018))}px ${FONT_FAMILY}, Georgia, serif`;
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(`3D preview · ${size} · seed ${seed}`, width - 14, 12);

  return canvas.toBuffer('image/png');
}

// ── CLI entry point ──────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  if (!VALID_SIZES.includes(args.size)) {
    console.error(`Unknown map size "${args.size}". Valid: ${VALID_SIZES.join(', ')}`);
    process.exit(2);
  }
  const seed = args.seed != null && !Number.isNaN(args.seed)
    ? args.seed
    : Math.floor(Math.random() * 0x7fffffff);
  const out = args.out ?? path.join(process.cwd(), `3d-map-${args.size}-${seed}.png`);

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  const buf = render3DMapToBuffer({
    seed,
    size:   args.size,
    width:  args.width,
    height: args.height,
  });
  fs.writeFileSync(out, buf);
  console.log(`wrote ${out}`);
}
