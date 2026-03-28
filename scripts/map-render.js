#!/usr/bin/env node
// Standalone map renderer — generates a map and saves it as a PNG.
// Usage:  node scripts/map-render.js [seed] [mapSize] [outfile.png]
// Sizes:  skirmish | standard | regional | campaign
// Exports renderMapToBuffer(seed, mapSize) → Buffer for use by map-validator.js

import { createCanvas } from 'canvas';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

import { generateMap, MAP_SIZES } from '../src/map.js';
import {
  setMapDimensions, hexToPixel, hexKey, getNeighbors, SQRT3,
} from '../src/hex.js';
import {
  TileType, TILE_COLOR, BUILDING_COLOR, BUILDING_LABEL,
} from '../src/tiles.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Hex geometry ──────────────────────────────────────────────────────────────

function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return pts;
}

// ── Main render function ──────────────────────────────────────────────────────

export function renderMapToBuffer(seed, mapSize = 'standard') {
  const cfg = MAP_SIZES[mapSize];
  if (!cfg) throw new Error(`Unknown map size "${mapSize}". Valid: ${Object.keys(MAP_SIZES).join(', ')}`);

  const { cols, rows } = cfg;
  setMapDimensions(cols, rows);

  const hs      = 44; // hex size in px (larger than game default for clarity)
  const apothem = hs * SQRT3 / 2;
  const padX    = Math.ceil(hs * 1.5);
  const padY    = Math.ceil(hs * 1.5);

  const width  = Math.ceil(hs * SQRT3 * (cols + 0.5)) + padX * 2;
  const height = Math.ceil(hs * 1.5 * rows + hs * 0.5) + padY * 2;

  const canvas = createCanvas(width, height);
  const ctx    = canvas.getContext('2d');

  // Generate map
  const { tiles, witchObjectives, heroStart, witchStart } = generateMap(seed, mapSize);

  function toCanvas(col, row) {
    const { x, y } = hexToPixel(col, row, hs);
    return { x: x + padX, y: y + padY };
  }

  // ── Background ──────────────────────────────────────────────────────────────
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, width, height);

  // ── Pass 1: terrain hexes ───────────────────────────────────────────────────
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tile = tiles.get(hexKey(col, row));
      if (!tile) continue;
      const { x, y } = toCanvas(col, row);
      const corners  = hexCorners(x, y, hs - 1);

      // Road/river/bridge tiles get grass base; building tiles use building color
      let color;
      if (tile.type === TileType.BUILDING) {
        color = BUILDING_COLOR[tile.building] ?? '#8a7a5a';
      } else if (
        tile.type === TileType.ROAD ||
        tile.type === TileType.RIVER ||
        tile.type === TileType.BRIDGE
      ) {
        color = TILE_COLOR[TileType.GRASS];
      } else {
        color = TILE_COLOR[tile.type] ?? TILE_COLOR[TileType.GRASS];
      }

      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#111418';
      ctx.lineWidth   = 0.8;
      ctx.stroke();
    }
  }

  // ── River layer ─────────────────────────────────────────────────────────────
  const isWater = t => t && (t.type === TileType.RIVER || t.type === TileType.BRIDGE);

  ctx.strokeStyle = TILE_COLOR[TileType.RIVER];
  ctx.lineWidth   = hs * 0.52;
  ctx.lineCap     = 'round';
  ctx.lineJoin    = 'round';

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tile = tiles.get(hexKey(col, row));
      if (!tile || tile.type !== TileType.RIVER) continue;

      const { x, y } = toCanvas(col, row);
      const riverNbrs = getNeighbors(col, row).filter(n => isWater(tiles.get(hexKey(n.col, n.row))));

      const edgeMids = riverNbrs.map(n => {
        const { x: nx, y: ny } = toCanvas(n.col, n.row);
        const dx = nx - x, dy = ny - y, d = Math.sqrt(dx * dx + dy * dy);
        return { x: x + dx / d * apothem, y: y + dy / d * apothem };
      });

      ctx.beginPath();
      if (riverNbrs.length >= 2) {
        ctx.moveTo(edgeMids[0].x, edgeMids[0].y);
        ctx.quadraticCurveTo(x, y, edgeMids[1].x, edgeMids[1].y);
      } else if (riverNbrs.length === 1) {
        const { x: nx, y: ny } = toCanvas(riverNbrs[0].col, riverNbrs[0].row);
        const dx = nx - x, dy = ny - y, d = Math.sqrt(dx * dx + dy * dy);
        ctx.moveTo(x - (dx / d) * apothem * 2, y - (dy / d) * apothem * 2);
        ctx.quadraticCurveTo(x, y, edgeMids[0].x, edgeMids[0].y);
      } else {
        continue;
      }
      ctx.stroke();
    }
  }

  ctx.lineCap  = 'butt';
  ctx.lineJoin = 'miter';

  // ── Road layer (includes bridge water + road deck + railings) ───────────────
  const isRoadLike = t => t && (
    t.type === TileType.ROAD || t.type === TileType.BRIDGE || t.type === TileType.BUILDING
  );

  ctx.lineCap = 'round';

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tile = tiles.get(hexKey(col, row));
      if (!tile || (tile.type !== TileType.ROAD && tile.type !== TileType.BRIDGE)) continue;

      const { x, y } = toCanvas(col, row);
      const roadNbrs = [...tile.roadDirs].map(k => tiles.get(k)).filter(t => isRoadLike(t));
      if (roadNbrs.length === 0) continue;

      const edgeMids = roadNbrs.map(n => {
        const { x: nx, y: ny } = toCanvas(n.col, n.row);
        const dx = nx - x, dy = ny - y, d = Math.sqrt(dx * dx + dy * dy);
        return { x: x + dx / d * apothem, y: y + dy / d * apothem };
      });

      // Bridge: draw river ribbon beneath road deck
      if (tile.type === TileType.BRIDGE) {
        const waterNbrs = getNeighbors(col, row).filter(n => isWater(tiles.get(hexKey(n.col, n.row))));
        if (waterNbrs.length >= 1) {
          const wEdge = waterNbrs.map(n => {
            const { x: nx, y: ny } = toCanvas(n.col, n.row);
            const dx = nx - x, dy = ny - y, d = Math.sqrt(dx * dx + dy * dy);
            return { x: x + dx / d * apothem, y: y + dy / d * apothem };
          });
          ctx.strokeStyle = TILE_COLOR[TileType.RIVER];
          ctx.lineWidth   = hs * 0.52;
          ctx.beginPath();
          if (wEdge.length >= 2) {
            ctx.moveTo(wEdge[0].x, wEdge[0].y);
            ctx.quadraticCurveTo(x, y, wEdge[1].x, wEdge[1].y);
          } else {
            const { x: nx, y: ny } = toCanvas(waterNbrs[0].col, waterNbrs[0].row);
            const dx = nx - x, dy = ny - y, d = Math.sqrt(dx * dx + dy * dy);
            ctx.moveTo(x - (dx / d) * apothem * 2, y - (dy / d) * apothem * 2);
            ctx.quadraticCurveTo(x, y, wEdge[0].x, wEdge[0].y);
          }
          ctx.stroke();
        }
      }

      // Road strip
      ctx.strokeStyle = TILE_COLOR[TileType.ROAD];
      ctx.lineWidth   = hs * 0.42;

      if (roadNbrs.length === 2) {
        ctx.beginPath();
        ctx.moveTo(edgeMids[0].x, edgeMids[0].y);
        ctx.quadraticCurveTo(x, y, edgeMids[1].x, edgeMids[1].y);
        ctx.stroke();
      } else if (roadNbrs.length === 1) {
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(edgeMids[0].x, edgeMids[0].y);
        ctx.stroke();
      } else {
        // Junction: bezier for most-opposing pair, spokes for branches
        const dirs = edgeMids.map(em => {
          const dx = em.x - x, dy = em.y - y, d = Math.sqrt(dx * dx + dy * dy);
          return { dx: dx / d, dy: dy / d };
        });
        let pA = 0, pB = 1, minDot = Infinity;
        for (let i = 0; i < dirs.length; i++) {
          for (let j = i + 1; j < dirs.length; j++) {
            const dot = dirs[i].dx * dirs[j].dx + dirs[i].dy * dirs[j].dy;
            if (dot < minDot) { minDot = dot; pA = i; pB = j; }
          }
        }
        ctx.beginPath();
        ctx.moveTo(edgeMids[pA].x, edgeMids[pA].y);
        ctx.quadraticCurveTo(x, y, edgeMids[pB].x, edgeMids[pB].y);
        ctx.stroke();
        for (let i = 0; i < edgeMids.length; i++) {
          if (i === pA || i === pB) continue;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(edgeMids[i].x, edgeMids[i].y);
          ctx.stroke();
        }
      }

      // Bridge railings
      if (tile.type === TileType.BRIDGE && roadNbrs.length >= 2) {
        const em0 = edgeMids[0], em1 = edgeMids[1];
        const dx = em1.x - em0.x, dy = em1.y - em0.y;
        const len = Math.sqrt(dx * dx + dy * dy);
        const perpX = (-dy / len) * hs * 0.18;
        const perpY = ( dx / len) * hs * 0.18;
        ctx.strokeStyle = '#8a7a5a';
        ctx.lineWidth   = Math.max(1, hs * 0.06);
        for (const sign of [-1, 1]) {
          ctx.beginPath();
          ctx.moveTo(em0.x + perpX * sign, em0.y + perpY * sign);
          ctx.quadraticCurveTo(
            x   + perpX * sign, y   + perpY * sign,
            em1.x + perpX * sign, em1.y + perpY * sign,
          );
          ctx.stroke();
        }
      }
    }
  }

  ctx.lineCap = 'butt';

  // ── Pass 2: building labels ─────────────────────────────────────────────────
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const tile = tiles.get(hexKey(col, row));
      if (!tile || tile.type !== TileType.BUILDING || !tile.building) continue;

      const { x, y } = toCanvas(col, row);
      const label = BUILDING_LABEL[tile.building] ?? tile.building;

      ctx.fillStyle    = 'rgba(255,248,230,0.92)';
      ctx.font         = `bold ${Math.max(7, Math.floor(hs * 0.22))}px Georgia, serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, x, y);
    }
  }

  // ── Power nodes ─────────────────────────────────────────────────────────────
  for (const obj of witchObjectives) {
    const { x, y } = toCanvas(obj.col, obj.row);

    // Radial purple glow
    const grad = ctx.createRadialGradient(x, y, hs * 0.1, x, y, hs * 0.9);
    grad.addColorStop(0, 'rgba(155,89,182,0.55)');
    grad.addColorStop(1, 'rgba(155,89,182,0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    const corners = hexCorners(x, y, hs - 1);
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fill();

    // Glyph
    ctx.fillStyle    = 'rgba(200,160,255,0.95)';
    ctx.font         = `bold ${Math.floor(hs * 0.45)}px Georgia, serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⛧', x, y - hs * 0.08);

    // Label
    ctx.fillStyle    = 'rgba(220,180,255,0.85)';
    ctx.font         = `bold ${Math.max(7, Math.floor(hs * 0.20))}px Georgia, serif`;
    ctx.fillText(obj.label ?? 'Node', x, y + hs * 0.50);
  }

  // ── Start positions ─────────────────────────────────────────────────────────
  function drawStartMarker(col, row, glyph, color) {
    const { x, y } = toCanvas(col, row);
    const r = hs * 0.32;

    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = color;
    ctx.lineWidth   = 2;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.stroke();

    ctx.fillStyle    = color;
    ctx.font         = `bold ${Math.floor(hs * 0.38)}px Georgia, serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(glyph, x, y);
  }

  drawStartMarker(heroStart.col, heroStart.row,  '⚔', '#d4a72c');
  drawStartMarker(witchStart.col, witchStart.row, '✦', '#9b59b6');

  // ── Legend ──────────────────────────────────────────────────────────────────
  const legendItems = [
    { color: '#d4a72c', glyph: '⚔', label: 'Hero start' },
    { color: '#9b59b6', glyph: '✦', label: 'Witch start' },
    { color: 'rgba(200,160,255,0.95)', glyph: '⛧', label: 'Power node' },
  ];
  const lx = 8, ly = height - 8;
  ctx.font = `${Math.max(9, Math.floor(hs * 0.28))}px Georgia, serif`;
  ctx.textBaseline = 'bottom';
  let lxOff = lx;
  for (const item of legendItems) {
    ctx.fillStyle = item.color;
    ctx.textAlign = 'left';
    ctx.fillText(`${item.glyph} ${item.label}`, lxOff, ly);
    lxOff += ctx.measureText(`${item.glyph} ${item.label}`).width + 18;
  }

  // Size + seed label (top-right)
  ctx.fillStyle    = 'rgba(180,170,150,0.75)';
  ctx.font         = `${Math.max(9, Math.floor(hs * 0.26))}px Georgia, serif`;
  ctx.textAlign    = 'right';
  ctx.textBaseline = 'top';
  ctx.fillText(`${mapSize}  seed:${seed}`, width - 8, 6);

  return canvas.toBuffer('image/png');
}

// ── CLI ───────────────────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const seed    = parseInt(process.argv[2] ?? String(Date.now()), 10);
  const mapSize = process.argv[3] ?? 'standard';
  const outFile = process.argv[4] ?? path.join(__dirname, `map-renders/${mapSize}_${seed}.png`);

  if (!MAP_SIZES[mapSize]) {
    console.error(`Unknown map size "${mapSize}". Valid: ${Object.keys(MAP_SIZES).join(', ')}`);
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  const buf = renderMapToBuffer(seed, mapSize);
  fs.writeFileSync(outFile, buf);
  console.log(`Rendered ${mapSize} map (seed ${seed}) → ${outFile}`);
}
