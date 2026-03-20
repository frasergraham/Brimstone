// Canvas renderer for the hex map
import {
  MAP_COLS, MAP_ROWS, HEX_SIZE, SQRT3,
  hexToPixel, pixelToHex as _pixelToHex, hexKey,
} from './hex.js';
import { TileType, TILE_COLOR, BUILDING_COLOR, BUILDING_LABEL } from './tiles.js';
import { ENTITY_COLOR, EntityType } from './entities.js';
import { Phase } from './game.js';

const PAD_X = 40;
const PAD_Y = 30;

// Precompute hex corner offsets for pointy-top
function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 180 * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return pts;
}

export class Renderer {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext('2d');
    this.state  = state;

    // Selection / highlight state set by UI
    this.selectedHex   = null;   // { col, row }
    this.highlightHexes = [];    // [{ col, row }] — move/battle targets
    this.hoveredHex    = null;   // { col, row }

    this._resize();
  }

  _resize() {
    // Canvas size to fit the full grid
    const w = Math.ceil(SQRT3 * HEX_SIZE * (MAP_COLS + 0.5)) + PAD_X * 2;
    const h = Math.ceil(1.5  * HEX_SIZE * MAP_ROWS + HEX_SIZE * 0.5) + PAD_Y * 2;
    this.canvas.width  = w;
    this.canvas.height = h;
  }

  // Convert (col, row) to canvas pixel
  _toCanvas(col, row) {
    const { x, y } = hexToPixel(col, row);
    return { x: x + PAD_X, y: y + PAD_Y };
  }

  // ── Main draw ────────────────────────────────────────────────────────────

  draw() {
    const ctx   = this.ctx;
    const state = this.state;
    const isNight = state.phase === Phase.NIGHT;

    // Background
    ctx.fillStyle = isNight ? '#07090f' : '#0d1117';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Draw all tiles
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        this._drawTile(col, row, isNight);
      }
    }

    // Highlights (move range, attack range)
    for (const h of this.highlightHexes) {
      this._drawHighlight(h.col, h.row, h.color || 'rgba(100,200,100,0.25)');
    }

    // Selected hex outline
    if (this.selectedHex) {
      this._drawOutline(this.selectedHex.col, this.selectedHex.row, '#f5c842', 2.5);
    }

    // Hovered hex outline
    if (this.hoveredHex) {
      this._drawOutline(this.hoveredHex.col, this.hoveredHex.row, 'rgba(255,255,255,0.3)', 1);
    }

    // Entities
    const drawn = new Set();
    for (const entity of state.entities) {
      if (!entity.alive) continue;
      const key = hexKey(entity.col, entity.row);
      const stack = state.entities.filter(
        e => e.alive && e.col === entity.col && e.row === entity.row
      );
      if (!drawn.has(key)) {
        drawn.add(key);
        this._drawEntityStack(entity.col, entity.row, stack);
      }
    }

    // Day/night overlay tint
    if (isNight) {
      ctx.fillStyle = 'rgba(10,5,30,0.18)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  _drawTile(col, row, isNight) {
    const ctx  = this.ctx;
    const tile = this.state.tiles.get(hexKey(col, row));
    if (!tile) return;

    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, HEX_SIZE - 1);

    // Fill colour
    let color;
    if (tile.type === TileType.BUILDING && tile.building) {
      color = BUILDING_COLOR[tile.building];
    } else {
      color = TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS];
    }

    // Darken unexplored tiles
    if (!tile.explored) {
      color = blendHex(color, '#000000', 0.5);
    }

    // Night tint
    if (isNight) {
      color = blendHex(color, '#0a0520', 0.3);
    }

    // Draw hex
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // Outline
    ctx.strokeStyle = isNight ? '#1a1a2e' : '#151a14';
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    // Fortified shimmer
    if (tile.fortified) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.strokeStyle = '#f5c84266';
      ctx.lineWidth   = 2;
      ctx.stroke();
    }

    // Building label (only explored)
    if (tile.type === TileType.BUILDING && tile.building && tile.explored) {
      ctx.fillStyle   = '#e8dcc8cc';
      ctx.font        = `bold 7px "Georgia", serif`;
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      const label = BUILDING_LABEL[tile.building] || tile.building;
      ctx.fillText(label, x, y + HEX_SIZE * 0.55);
    }

    // Resource indicator (unexplored tile with resource)
    if (!tile.explored && tile.resource) {
      ctx.fillStyle = 'rgba(200,180,80,0.4)';
      ctx.beginPath();
      ctx.arc(x, y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  _drawHighlight(col, row, color) {
    const ctx  = this.ctx;
    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, HEX_SIZE - 1);

    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
  }

  _drawOutline(col, row, color, lineWidth = 2) {
    const ctx   = this.ctx;
    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, HEX_SIZE - 1.5);

    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = lineWidth;
    ctx.stroke();
  }

  _drawEntityStack(col, row, stack) {
    const ctx    = this.ctx;
    const { x, y } = this._toCanvas(col, row);
    const r      = HEX_SIZE * 0.32;
    const max    = Math.min(stack.length, 3);

    for (let i = 0; i < max; i++) {
      const entity  = stack[i];
      const offsets = stackOffset(i, max);
      const ex = x + offsets.x;
      const ey = y + offsets.y;
      const color = ENTITY_COLOR[entity.type];

      // Shadow
      ctx.beginPath();
      ctx.arc(ex + 1, ey + 1, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();

      // Body
      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth   = 1;
      ctx.stroke();

      // Icon glyph
      ctx.fillStyle   = '#ffffffdd';
      ctx.font        = `bold ${Math.floor(r * 1.1)}px serif`;
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(entityGlyph(entity.type), ex, ey + 1);

      // HP bar (only for hero/witch, or survivors)
      if (entity.type === EntityType.HERO || entity.type === EntityType.WITCH ||
          entity.type === EntityType.SURVIVOR) {
        const barW = r * 2;
        const barH = 3;
        const bx   = ex - r;
        const by   = ey + r + 3;
        ctx.fillStyle = '#333';
        ctx.fillRect(bx, by, barW, barH);
        const pct = entity.hp / entity.maxHp;
        ctx.fillStyle = pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ff9800' : '#f44336';
        ctx.fillRect(bx, by, barW * pct, barH);
      }
    }

    // Overflow badge
    if (stack.length > 3) {
      ctx.fillStyle   = '#333c';
      ctx.fillRect(x + 8, y - r - 8, 14, 10);
      ctx.fillStyle   = '#fff';
      ctx.font        = '8px monospace';
      ctx.textAlign   = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${stack.length - 3}`, x + 15, y - r - 3);
    }
  }

  // ── Coordinate helpers for UI ─────────────────────────────────────────────

  canvasToHex(canvasX, canvasY) {
    return _pixelToHex(canvasX - PAD_X, canvasY - PAD_Y);
  }
}

// ── Module-level helpers ───────────────────────────────────────────────────

function entityGlyph(type) {
  switch (type) {
    case EntityType.HERO:     return '⚔';
    case EntityType.WITCH:    return '✦';
    case EntityType.SURVIVOR: return '☺';
    case EntityType.ZOMBIE:   return '†';
    case EntityType.MINION:   return '☠';
    default: return '?';
  }
}

function stackOffset(index, total) {
  if (total === 1) return { x: 0, y: 0 };
  if (total === 2) return index === 0 ? { x: -6, y: 0 } : { x: 6, y: 0 };
  const offsets = [{ x: -6, y: -4 }, { x: 6, y: -4 }, { x: 0, y: 6 }];
  return offsets[index] || { x: 0, y: 0 };
}

// Blend two hex-color strings by `t` (0=a, 1=b)
function blendHex(a, b, t) {
  const ra = parseInt(a.slice(1, 3), 16), ga = parseInt(a.slice(3, 5), 16), ba = parseInt(a.slice(5, 7), 16);
  const rb = parseInt(b.slice(1, 3), 16), gb = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  const r  = Math.round(ra + (rb - ra) * t);
  const g  = Math.round(ga + (gb - ga) * t);
  const bv = Math.round(ba + (bb - ba) * t);
  return `rgb(${r},${g},${bv})`;
}

export { PAD_X, PAD_Y };
