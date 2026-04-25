#!/usr/bin/env node
// Full game-state renderer — renders map + entities + HUD info to a PNG buffer.
// Used by headless.js --render mode to capture per-turn snapshots.
//
// Usage as module:  import { renderGameState } from './game-render.js';
//                   const buf = renderGameState(state);

import { createCanvas } from 'canvas';
import {
  setMapDimensions, hexToPixel, hexKey, getNeighbors, SQRT3,
} from '../src/hex.js';
import {
  TileType, TILE_COLOR, BUILDING_COLOR, BUILDING_LABEL,
} from '../src/tiles.js';
import { EntityType, ENTITY_COLOR } from '../src/entities.js';
import { nodeController, Phase } from '../src/game.js';
import { MAP_SIZES } from '../src/map.js';
import { Renderer } from '../src/renderer.js';

// ── Tilemap sprite support ───────────────────────────────────────────────────

let _tilemapImg = null;
let _spriteRects = null;
let _variantCounts = null;

export async function loadTilemap(tilemapPath = 'assets/tilemap.png') {
  try {
    const { loadImage } = await import('canvas');
    _tilemapImg = await loadImage(tilemapPath);
    const result = Renderer._buildSpriteRects();
    _spriteRects = result.rects;
    _variantCounts = result.variantCounts;
  } catch {
    _tilemapImg = null;
  }
}

function _pickVariant(baseType, col, row) {
  const count = _variantCounts?.get(baseType) ?? 0;
  if (count > 0) {
    const variant = ((col * 7 + row * 13 + col * row) % count) + 1;
    return `${baseType}_${variant}`;
  }
  return baseType;
}

function _survivorAssetId(title) {
  return Renderer.survivorAssetId(title);
}

// ── Hex geometry ──────────────────────────────────────────────────────────────

function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = (Math.PI / 180) * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return pts;
}

const ENTITY_GLYPH = {
  [EntityType.HERO]:       '\u2694',  // ⚔
  [EntityType.WITCH]:      '\u2726',  // ✦
  [EntityType.SURVIVOR]:   '\u263A',  // ☺
  [EntityType.ZOMBIE]:     '\u2020',  // †
  [EntityType.MINION]:     '\u2620',  // ☠
  [EntityType.WOOD_GOLEM]: '\uD83E\uDEB5',  // 🪵
  [EntityType.IRON_GOLEM]: '\u2699',  // ⚙
};

const PHASE_TINT = {
  [Phase.DAWN]:  'rgba(30,40,70,0.20)',
  [Phase.DAY]:   null,
  [Phase.DUSK]:  'rgba(30,40,70,0.20)',
  [Phase.NIGHT]: 'rgba(20,28,55,0.35)',
};

// ── Main render function ──────────────────────────────────────────────────────

export function renderGameState(state, opts = {}) {
  const hexSize = opts.hexSize ?? 36;
  const chronicle = opts.chronicle ?? [];  // array of log entries for this round
  const cfg = MAP_SIZES[state.mapSize] ?? MAP_SIZES.standard;
  const { cols, rows } = cfg;
  setMapDimensions(cols, rows);

  const hs      = hexSize;
  const apothem = hs * SQRT3 / 2;
  const padX    = Math.ceil(hs * 1.5);
  const padY    = Math.ceil(hs * 1.5);
  const hudH    = 36; // space for HUD text at top

  const mapW   = Math.ceil(hs * SQRT3 * (cols + 0.5)) + padX * 2;
  const mapH   = Math.ceil(hs * 1.5 * rows + hs * 0.5) + padY * 2;

  // Chronicle panel on the right — wide enough for readable text
  const chronW  = chronicle.length > 0 ? 420 : 0;

  const width  = mapW + chronW;
  const height = mapH + hudH;

  const canvas = createCanvas(width, height);
  const ctx    = canvas.getContext('2d');

  function toCanvas(col, row) {
    const { x, y } = hexToPixel(col, row, hs);
    return { x: x + padX, y: y + padY + hudH };
  }

  // ── Background ──────────────────────────────────────────────────────────────
  ctx.fillStyle = '#0d1117';
  ctx.fillRect(0, 0, width, height);

  // ── HUD bar ─────────────────────────────────────────────────────────────────
  ctx.fillStyle = '#161b22';
  ctx.fillRect(0, 0, width, hudH);
  ctx.strokeStyle = '#30363d';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, hudH); ctx.lineTo(width, hudH);
  ctx.stroke();

  const fontSize = Math.max(11, Math.floor(hs * 0.38));
  ctx.font = `bold ${fontSize}px Georgia, serif`;
  ctx.textBaseline = 'middle';
  const hudY = hudH / 2;

  // Round & phase
  const phaseColors = { dawn: '#e8a838', day: '#f0d060', dusk: '#c87030', night: '#6070b0' };
  ctx.fillStyle = '#c0b8a0';
  ctx.textAlign = 'left';
  ctx.fillText(`Round ${state.round}`, 10, hudY);

  const phaseStr = (state.phase ?? 'day').toUpperCase();
  ctx.fillStyle = phaseColors[state.phase] ?? '#c0b8a0';
  ctx.fillText(phaseStr, 100, hudY);

  // Node scores
  const heroScore  = state.nodeScore?.hero  ?? 0;
  const witchScore = state.nodeScore?.witch ?? 0;
  ctx.textAlign = 'center';
  ctx.fillStyle = ENTITY_COLOR[EntityType.HERO];
  ctx.fillText(`Hero: ${heroScore}`, width / 2 - 60, hudY);
  ctx.fillStyle = ENTITY_COLOR[EntityType.WITCH];
  ctx.fillText(`Witch: ${witchScore}`, width / 2 + 60, hudY);

  // Hero/witch HP
  const hero  = state.entities.find(e => e.type === EntityType.HERO);
  const witch = state.entities.find(e => e.type === EntityType.WITCH);
  ctx.textAlign = 'right';
  ctx.fillStyle = ENTITY_COLOR[EntityType.HERO];
  if (hero)  ctx.fillText(`HP ${hero.hp}/${hero.maxHp}`, width - 150, hudY);
  ctx.fillStyle = ENTITY_COLOR[EntityType.WITCH];
  if (witch) ctx.fillText(`HP ${witch.hp}/${witch.maxHp}`, width - 10, hudY);

  // ── Pass 1: terrain hexes ───────────────────────────────────────────────────
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = state.tiles.get(hexKey(c, r));
      if (!tile) continue;
      const { x, y } = toCanvas(c, r);
      const corners  = hexCorners(x, y, hs - 1);

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

      if (_tilemapImg && _spriteRects) {
        const baseType = tile.type === TileType.BUILDING ? TileType.DIRT
          : (tile.type === TileType.ROAD || tile.type === TileType.RIVER || tile.type === TileType.BRIDGE) ? TileType.GRASS
          : tile.type;
        const spriteId = _pickVariant(baseType, c, r);
        const rect = _spriteRects.get(spriteId);
        if (rect) {
          ctx.save();
          ctx.beginPath();
          ctx.moveTo(corners[0].x, corners[0].y);
          for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
          ctx.closePath();
          ctx.clip();
          ctx.drawImage(_tilemapImg, rect.x, rect.y, rect.size, rect.size,
            x - hs, y - hs, hs * 2, hs * 2);
          ctx.restore();
        }
      }

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

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = state.tiles.get(hexKey(c, r));
      if (!tile || tile.type !== TileType.RIVER) continue;

      const { x, y } = toCanvas(c, r);
      const riverNbrs = getNeighbors(c, r).filter(n => isWater(state.tiles.get(hexKey(n.col, n.row))));

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

  // ── Road layer ──────────────────────────────────────────────────────────────
  const isRoadLike = t => t && (
    t.type === TileType.ROAD || t.type === TileType.BRIDGE || t.type === TileType.BUILDING
  );

  ctx.lineCap = 'round';

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = state.tiles.get(hexKey(c, r));
      if (!tile || (tile.type !== TileType.ROAD && tile.type !== TileType.BRIDGE)) continue;

      const { x, y } = toCanvas(c, r);
      const roadNbrs = [...tile.roadDirs].map(k => state.tiles.get(k)).filter(t => isRoadLike(t));
      if (roadNbrs.length === 0) continue;

      const edgeMids = roadNbrs.map(n => {
        const { x: nx, y: ny } = toCanvas(n.col, n.row);
        const dx = nx - x, dy = ny - y, d = Math.sqrt(dx * dx + dy * dy);
        return { x: x + dx / d * apothem, y: y + dy / d * apothem };
      });

      // Bridge: draw river ribbon beneath
      if (tile.type === TileType.BRIDGE) {
        const waterNbrs = getNeighbors(c, r).filter(n => isWater(state.tiles.get(hexKey(n.col, n.row))));
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
        // Junction
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
            x + perpX * sign, y + perpY * sign,
            em1.x + perpX * sign, em1.y + perpY * sign,
          );
          ctx.stroke();
        }
      }
    }
  }

  ctx.lineCap = 'butt';

  // ── Building sprites / labels ────────────────────────────────────────────────
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const tile = state.tiles.get(hexKey(c, r));
      if (!tile || tile.type !== TileType.BUILDING || !tile.building) continue;

      const { x, y } = toCanvas(c, r);

      if (_tilemapImg && _spriteRects) {
        const bRect = _spriteRects.get(tile.building);
        if (bRect) {
          const bSize = hs * 1.4;
          ctx.drawImage(_tilemapImg, bRect.x, bRect.y, bRect.size, bRect.size,
            x - bSize / 2, y - bSize / 2, bSize, bSize);
        }
      } else {
        const label = BUILDING_LABEL[tile.building] ?? tile.building;
        ctx.fillStyle    = 'rgba(255,248,230,0.92)';
        ctx.font         = `bold ${Math.max(7, Math.floor(hs * 0.22))}px Georgia, serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, x, y);
      }
    }
  }

  // ── Power nodes ─────────────────────────────────────────────────────────────
  for (const obj of state.witchObjectives) {
    // Determine controller for colouring
    const ctrl = nodeController(obj, state.entities);
    const ctrlFill = ctrl === 'hero' ? 'rgba(212,167,44,0.40)'
      : ctrl === 'witch' ? 'rgba(155,89,182,0.40)'
      : 'rgba(140,120,200,0.25)';
    const ctrlStroke = ctrl === 'hero' ? 'rgba(240,200,60,0.90)'
      : ctrl === 'witch' ? 'rgba(200,130,255,0.90)'
      : 'rgba(180,170,220,0.70)';

    for (const h of obj.hexes) {
      const { x, y } = toCanvas(h.col, h.row);
      const corners = hexCorners(x, y, hs - 1);

      // Glow fill
      const grad = ctx.createRadialGradient(x, y, 0, x, y, hs);
      grad.addColorStop(0, ctrlFill);
      grad.addColorStop(0.7, ctrlFill);
      grad.addColorStop(1, ctrlFill.replace(/[\d.]+\)$/, '0)'));
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Bold hex outline
      ctx.strokeStyle = ctrlStroke;
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Symbol at centroid
    let cx = 0, cy = 0;
    for (const h of obj.hexes) {
      const p = toCanvas(h.col, h.row);
      cx += p.x; cy += p.y;
    }
    cx /= obj.hexes.length; cy /= obj.hexes.length;

    // Dark backing circle for readability
    ctx.beginPath();
    ctx.arc(cx, cy, hs * 0.42, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fill();

    ctx.fillStyle = ctrl === 'hero' ? '#f0d050'
      : ctrl === 'witch' ? '#d0a0ff'
      : '#c0b8d8';
    ctx.font = `bold ${Math.floor(hs * 0.55)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('\u26E7', cx, cy); // ⛧

    ctx.fillStyle = ctrl === 'hero' ? 'rgba(240,200,80,0.95)'
      : ctrl === 'witch' ? 'rgba(220,180,255,0.95)'
      : 'rgba(200,190,220,0.85)';
    ctx.font = `bold ${Math.max(8, Math.floor(hs * 0.22))}px Georgia, serif`;
    ctx.fillText(obj.label ?? 'Node', cx, cy + hs * 0.55);
  }

  // ── Player hex outlines ──────────────────────────────────────────────────────
  // Build ownerId → color map from leader entities (mirrors renderer._playerColorMap)
  const playerColorMap = new Map();
  for (const e of state.entities) {
    if (e.color && e.ownerId && (e.type === EntityType.HERO || e.type === EntityType.WITCH)) {
      playerColorMap.set(e.ownerId, e.color);
    }
  }

  // Map each occupied hex to the first entity's player/faction colour
  const hexOutlines = new Map();
  for (const e of state.entities) {
    if (!e.alive) continue;
    const key = hexKey(e.col, e.row);
    if (hexOutlines.has(key)) continue;
    const playerColor = e.ownerId ? playerColorMap.get(e.ownerId) : null;
    const factionColor = e.owner === 'hero'
      ? ENTITY_COLOR[EntityType.HERO]
      : ENTITY_COLOR[EntityType.WITCH];
    hexOutlines.set(key, playerColor ?? factionColor);
  }

  for (const [key, color] of hexOutlines) {
    const [oc, or] = key.split(',').map(Number);
    const { x: ox, y: oy } = toCanvas(oc, or);
    const corners = hexCorners(ox, oy, hs - 1);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.85;
    ctx.lineWidth   = 2.5;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ── Entities ────────────────────────────────────────────────────────────────
  // Group by hex
  const entityByHex = new Map();
  for (const e of state.entities) {
    if (!e.alive) continue;
    const key = hexKey(e.col, e.row);
    const arr = entityByHex.get(key);
    if (arr) arr.push(e); else entityByHex.set(key, [e]);
  }

  for (const [key, stack] of entityByHex) {
    const [col, row] = key.split(',').map(Number);
    const { x, y } = toCanvas(col, row);
    const r      = stack.length === 1 ? hs * 0.42 : hs * 0.32;
    const max    = Math.min(stack.length, 3);

    for (let i = 0; i < max; i++) {
      const entity = stack[i];
      // Stack offset
      let ox = 0, oy = 0;
      if (max === 2) { ox = (i === 0 ? -6 : 6); }
      else if (max === 3) {
        if (i === 0) { ox = -7; oy = -3; }
        else if (i === 1) { ox = 7; oy = -3; }
        else { ox = 0; oy = 6; }
      }
      const ex = x + ox * (hs / 30);
      const ey = y + oy * (hs / 30);

      // Shadow
      ctx.beginPath();
      ctx.arc(ex + 2, ey + 2, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();

      // Portrait sprite or color fill
      const portraitKey = entity.type === EntityType.SURVIVOR
        ? _survivorAssetId(entity.title) : entity.type;
      const pRect = portraitKey ? _spriteRects?.get(portraitKey) : null;

      if (pRect && _tilemapImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(_tilemapImg, pRect.x, pRect.y, pRect.size, pRect.size,
          ex - r, ey - r, r * 2, r * 2);
        ctx.restore();
      } else {
        const baseCol = entity.color ?? ENTITY_COLOR[entity.type];
        ctx.beginPath();
        ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.fillStyle = baseCol;
        ctx.fill();

        const glyph = ENTITY_GLYPH[entity.type] ?? '?';
        ctx.fillStyle    = '#ffffffdd';
        ctx.font         = `bold ${Math.floor(r * 1.1)}px serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(glyph, ex, ey + 1);
      }

      // Border
      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.7)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // HP bar for major entities
      if (entity.maxHp > 1) {
        const barW = r * 2;
        const barH = Math.max(2, hs * 0.08);
        const bx   = ex - r;
        const by   = ey + r + 2;
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(bx, by, barW, barH);
        const pct = entity.hp / entity.maxHp;
        const hpColor = pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ff9800' : '#f44336';
        ctx.fillStyle = hpColor;
        ctx.fillRect(bx, by, barW * pct, barH);
      }
    }

    // Overflow badge
    if (stack.length > 3) {
      ctx.fillStyle    = 'rgba(255,255,255,0.85)';
      ctx.font         = `bold ${Math.floor(hs * 0.28)}px sans-serif`;
      ctx.textAlign    = 'right';
      ctx.textBaseline = 'top';
      ctx.fillText(`+${stack.length - 3}`, x + hs * 0.5, y - hs * 0.5);
    }
  }

  // ── Phase tint ──────────────────────────────────────────────────────────────
  const tint = PHASE_TINT[state.phase];
  if (tint) {
    ctx.fillStyle = tint;
    ctx.fillRect(0, hudH, width, height - hudH);
  }

  // ── Game over banner ────────────────────────────────────────────────────────
  if (state.gameOver && state.winner) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(0, mapH / 2 + hudH - 24, mapW, 48);
    ctx.fillStyle = state.winner === 'hero' ? ENTITY_COLOR[EntityType.HERO] : ENTITY_COLOR[EntityType.WITCH];
    ctx.font = `bold ${Math.floor(hs * 0.6)}px Georgia, serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const winText = `${state.winner.toUpperCase()} WINS — ${state.winReason ?? ''}`;
    ctx.fillText(winText, mapW / 2, mapH / 2 + hudH);
  }

  // ── Chronicle panel ─────────────────────────────────────────────────────────
  if (chronicle.length > 0) {
    const panelX = mapW;
    const lineH  = 22;
    const padC   = 14;

    // Panel background
    ctx.fillStyle = '#10131a';
    ctx.fillRect(panelX, 0, chronW, height);

    // Panel header
    ctx.fillStyle = '#161b22';
    ctx.fillRect(panelX, 0, chronW, hudH);
    ctx.strokeStyle = '#30363d';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(panelX, hudH); ctx.lineTo(panelX + chronW, hudH);
    ctx.stroke();
    // Vertical divider
    ctx.beginPath();
    ctx.moveTo(panelX, 0); ctx.lineTo(panelX, height);
    ctx.stroke();

    ctx.fillStyle    = '#c0b8a0';
    ctx.font         = `bold 16px Georgia, serif`;
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Chronicle', panelX + padC, hudH / 2);

    // Log entries
    const logFont = '14px Georgia, serif';
    ctx.font = logFont;
    ctx.textBaseline = 'top';

    const heroColor    = ENTITY_COLOR[EntityType.HERO];   // #d4a72c
    const witchColor   = ENTITY_COLOR[EntityType.WITCH];  // #9b59b6
    const neutralColor = '#a0a0a0';

    let ly = hudH + padC;
    const maxTextW = chronW - padC * 2;

    for (const entry of chronicle) {
      const text  = typeof entry === 'string' ? entry : entry.text;
      const color = typeof entry === 'string'
        ? neutralColor
        : entry.color ?? (entry.owner === 'hero' ? heroColor
          : entry.owner === 'witch' ? witchColor
          : neutralColor);

      // Word-wrap the text to fit the panel
      const lines = _wrapText(ctx, text, maxTextW);
      for (const line of lines) {
        if (ly + lineH > height - padC) break; // ran out of space
        ctx.fillStyle = color;
        ctx.fillText(line, panelX + padC, ly);
        ly += lineH;
      }

      if (ly + lineH > height - padC) break;
    }
  }

  return canvas.toBuffer('image/png');
}

// ── Text wrapping helper ──────────────────────────────────────────────────────

function _wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let current = '';

  for (const word of words) {
    const test = current ? `${current} ${word}` : word;
    if (ctx.measureText(test).width <= maxWidth) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [''];
}

/**
 * Encode a sequence of frame buffers (PNG buffers from renderGameState) as a
 * looping animated GIF on disk. The final frame is held longer.
 *
 * Defers the `gif-encoder-2` and `canvas` imports so callers that only want
 * static-frame rendering don't pay the cost.
 */
export async function renderFramesToGif(frames, outPath, opts = {}) {
  const fs = await import('fs');
  const path = await import('path');
  const { createCanvas, loadImage } = await import('canvas');
  const { default: GIFEncoder } = await import('gif-encoder-2');

  const delay = opts.delay ?? 800;
  const finalDelay = opts.finalDelay ?? 3000;

  const firstImg = await loadImage(frames[0]);
  const w = firstImg.width, h = firstImg.height;
  const encoder = new GIFEncoder(w, h);
  encoder.setDelay(delay);
  encoder.setRepeat(0);
  encoder.setQuality(opts.quality ?? 10);
  encoder.start();
  for (let i = 0; i < frames.length; i++) {
    if (i === frames.length - 1) encoder.setDelay(finalDelay);
    const img = await loadImage(frames[i]);
    const canvas = createCanvas(w, h);
    canvas.getContext('2d').drawImage(img, 0, 0);
    encoder.addFrame(canvas.getContext('2d'));
  }
  encoder.finish();
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, encoder.out.getData());
  return { path: outPath, bytes: fs.statSync(outPath).size, frames: frames.length, width: w, height: h };
}
