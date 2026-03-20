// Canvas renderer for the hex map
import {
  MAP_COLS, MAP_ROWS, SQRT3,
  getNeighbors,
  hexToPixel, pixelToHex as _pixelToHex, hexKey,
} from './hex.js';
import {
  TileType, TILE_COLOR, BUILDING_COLOR, BUILDING_LABEL, BUILDING_ICON,
} from './tiles.js';
import { ENTITY_COLOR, EntityType } from './entities.js';
import { getVisibleEnemyHexes } from './actions.js';

export const PAD_X = 40;
export const PAD_Y = 30;
const BG_COLOR = '#0d1117';
const MIN_HEX_SIZE = 20;

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
    this.canvas  = canvas;
    this.ctx     = canvas.getContext('2d');
    this.state   = state;
    this.hexSize = 30; // will be updated by _resize()

    this.selectedHex    = null;
    this.highlightHexes = [];
    this.hoveredHex     = null;

    this._resize();
  }

  _resize() {
    const wrapper = this.canvas.parentElement;
    if (wrapper && wrapper.clientWidth > 0 && wrapper.clientHeight > 0) {
      const availW = wrapper.clientWidth  - PAD_X * 2;
      const availH = wrapper.clientHeight - PAD_Y * 2;
      const sizeByW = availW  / (SQRT3 * (MAP_COLS + 0.5));
      const sizeByH = availH  / (1.5 * MAP_ROWS + 0.5);
      this.hexSize = Math.max(MIN_HEX_SIZE, Math.floor(Math.min(sizeByW, sizeByH)));
    }

    const w = Math.ceil(SQRT3 * this.hexSize * (MAP_COLS + 0.5)) + PAD_X * 2;
    const h = Math.ceil(1.5  * this.hexSize * MAP_ROWS + this.hexSize * 0.5) + PAD_Y * 2;
    this.canvas.width  = w;
    this.canvas.height = h;
  }

  resize() {
    this._resize();
  }

  _toCanvas(col, row) {
    const { x, y } = hexToPixel(col, row, this.hexSize);
    return { x: x + PAD_X, y: y + PAD_Y };
  }

  // Convert canvas pixel coordinates back to hex grid coordinates
  canvasToHex(canvasX, canvasY) {
    return _pixelToHex(canvasX - PAD_X, canvasY - PAD_Y, this.hexSize);
  }

  draw() {
    const ctx   = this.ctx;
    const state = this.state;

    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Objective glows
    for (const obj of state.witchObjectives) {
      this._drawObjectiveGlow(obj.col, obj.row);
    }

    // Tiles
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        this._drawTile(col, row);
      }
    }

    // River connection ribbon
    this._drawRiverLayer();

    // Objective symbols
    for (const obj of state.witchObjectives) {
      this._drawObjectiveSymbol(obj.col, obj.row, obj.label, state);
    }

    // Highlights
    for (const h of this.highlightHexes) {
      this._drawHighlight(h.col, h.row, h.color || 'rgba(100,200,100,0.25)');
    }

    if (this.selectedHex) {
      this._drawOutline(this.selectedHex.col, this.selectedHex.row, '#f5c842', 2.5);
    }
    if (this.hoveredHex) {
      this._drawOutline(this.hoveredHex.col, this.hoveredHex.row, 'rgba(255,255,255,0.3)', 1);
    }

    // Visibility: baseline 2 hexes from any hero unit; SCOUT extends to 3
    const revealedHexes = state.fogOfWar ? getVisibleEnemyHexes(state) : null;

    // Entities
    const drawn = new Set();
    for (const entity of state.entities) {
      if (!entity.alive) continue;

      if (state.fogOfWar && entity.owner === 'witch') {
        const k = hexKey(entity.col, entity.row);
        if (!revealedHexes || !revealedHexes.has(k)) continue;
      }

      const key = hexKey(entity.col, entity.row);
      if (drawn.has(key)) continue;

      const stack = state.entities.filter(e => {
        if (!e.alive || e.col !== entity.col || e.row !== entity.row) return false;
        if (state.fogOfWar && e.owner === 'witch') {
          return revealedHexes && revealedHexes.has(hexKey(e.col, e.row));
        }
        return true;
      });

      drawn.add(key);
      this._drawEntityStack(entity.col, entity.row, stack);
    }
  }

  _drawTile(col, row) {
    const ctx  = this.ctx;
    const hs   = this.hexSize;
    const tile = this.state.tiles.get(hexKey(col, row));
    if (!tile) return;

    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, hs - 1);

    const color = tile.type === TileType.BUILDING
      ? BUILDING_COLOR
      : (TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS]);

    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    ctx.strokeStyle = '#111418';
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    // ── Bridge deck ───────────────────────────────────────────────────────
    if (tile.type === TileType.BRIDGE) {
      const deckH = hs * 0.38;
      ctx.fillStyle = TILE_COLOR[TileType.ROAD];
      ctx.fillRect(x - hs * SQRT3 * 0.5, y - deckH * 0.5, hs * SQRT3, deckH);
      ctx.strokeStyle = '#8a7a5a';
      ctx.lineWidth   = 1;
      ctx.beginPath();
      ctx.moveTo(x - hs * SQRT3 * 0.5, y - deckH * 0.5);
      ctx.lineTo(x + hs * SQRT3 * 0.5, y - deckH * 0.5);
      ctx.moveTo(x - hs * SQRT3 * 0.5, y + deckH * 0.5);
      ctx.lineTo(x + hs * SQRT3 * 0.5, y + deckH * 0.5);
      ctx.stroke();
      ctx.font         = `${Math.floor(hs * 0.55)}px serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('🌉', x, y);
      return;
    }

    // ── Fortification shimmer ─────────────────────────────────────────────
    if (tile.fortifyLevel > 0) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      const isMetal = tile.fortifyLevel >= 3;
      ctx.strokeStyle = isMetal ? `rgba(0,229,255,${0.4 + tile.fortifyLevel * 0.1})` : `rgba(245,200,66,${0.3 + tile.fortifyLevel * 0.1})`;
      ctx.lineWidth   = 1 + tile.fortifyLevel * 0.5;
      ctx.stroke();
    }

    // ── Building: icon + name + border ───────────────────────────────────
    if (tile.type === TileType.BUILDING && tile.building) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.strokeStyle = tile.explored ? 'rgba(245,200,66,0.80)' : 'rgba(245,200,66,0.40)';
      ctx.lineWidth   = tile.explored ? 2 : 1.5;
      ctx.stroke();

      ctx.font         = `${Math.floor(hs * 0.55)}px serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(BUILDING_ICON[tile.building] || '?', x, y - hs * 0.10);

      ctx.fillStyle    = 'rgba(255,248,230,0.92)';
      ctx.font         = `bold ${Math.max(7, Math.floor(hs * 0.25))}px "Georgia", serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(BUILDING_LABEL[tile.building] || tile.building, x, y + hs * 0.58);
    }
  }

  _drawRiverLayer() {
    const ctx   = this.ctx;
    const tiles = this.state.tiles;
    const hs    = this.hexSize;

    ctx.strokeStyle = TILE_COLOR[TileType.RIVER];
    ctx.lineWidth   = hs * 0.65;
    ctx.lineCap     = 'round';
    ctx.beginPath();

    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const tile = tiles.get(hexKey(col, row));
        if (!tile || tile.type !== TileType.RIVER) continue;

        const { x, y } = this._toCanvas(col, row);
        for (const n of getNeighbors(col, row)) {
          if (n.col < col || (n.col === col && n.row < row)) continue;
          const nt = tiles.get(hexKey(n.col, n.row));
          if (!nt || nt.type !== TileType.RIVER) continue;
          const { x: nx, y: ny } = this._toCanvas(n.col, n.row);
          ctx.moveTo(x, y);
          ctx.lineTo(nx, ny);
        }
      }
    }

    ctx.stroke();
    ctx.lineCap = 'butt';
  }

  _drawObjectiveGlow(col, row) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, hs * 1.5);
    gradient.addColorStop(0, 'rgba(160,0,220,0.25)');
    gradient.addColorStop(1, 'rgba(160,0,220,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, hs * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawObjectiveSymbol(col, row, label, state) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);

    const witchHeld = state.entities.some(
      e => e.alive && e.owner === 'witch' && e.col === col && e.row === row
    );

    ctx.fillStyle    = witchHeld ? '#ff4444' : 'rgba(180,0,255,0.7)';
    ctx.font         = `bold ${Math.floor(hs * 0.5)}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⛧', x, y - hs * 0.15);

    ctx.fillStyle = witchHeld ? '#ff8888' : 'rgba(220,160,255,0.85)';
    ctx.font      = `${Math.max(6, Math.floor(hs * 0.2))}px sans-serif`;
    ctx.fillText(label, x, y + hs * 0.35);
  }

  _drawHighlight(col, row, color) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, hs - 1);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = color.replace(/,\s*[\d.]+\)$/, ', 0.9)');
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  _drawOutline(col, row, color, lineWidth = 2) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, hs - 1.5);
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
    const hs     = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const r      = hs * 0.32;
    const max    = Math.min(stack.length, 3);

    for (let i = 0; i < max; i++) {
      const entity  = stack[i];
      const offsets = stackOffset(i, max);
      const ex = x + offsets.x * (hs / 30);
      const ey = y + offsets.y * (hs / 30);

      ctx.beginPath();
      ctx.arc(ex + 1, ey + 1, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();

      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      ctx.fillStyle = ENTITY_COLOR[entity.type];
      ctx.fill();
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth   = 1;
      ctx.stroke();

      ctx.fillStyle    = '#ffffffdd';
      ctx.font         = `bold ${Math.floor(r * 1.1)}px serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(entityGlyph(entity.type), ex, ey + 1);

      if (entity.type === EntityType.HERO || entity.type === EntityType.WITCH ||
          entity.type === EntityType.SURVIVOR || entity.type === EntityType.WOOD_GOLEM ||
          entity.type === EntityType.IRON_GOLEM) {
        const barW = r * 2;
        const barH = Math.max(2, hs * 0.08);
        const bx   = ex - r;
        const by   = ey + r + 2;
        ctx.fillStyle = '#333';
        ctx.fillRect(bx, by, barW, barH);
        const pct = entity.hp / entity.maxHp;
        ctx.fillStyle = pct > 0.5 ? '#4caf50' : pct > 0.25 ? '#ff9800' : '#f44336';
        ctx.fillRect(bx, by, barW * pct, barH);
      }

      if (entity.weapon && entity.owner === 'hero') {
        ctx.fillStyle = '#f5c842';
        ctx.beginPath();
        ctx.arc(ex + r - 2, ey - r + 2, Math.max(2, hs * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }

      if (entity.type === EntityType.SURVIVOR && entity.ability) {
        ctx.fillStyle = '#88eeff';
        ctx.beginPath();
        ctx.arc(ex - r + 2, ey - r + 2, Math.max(2, hs * 0.08), 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (stack.length > 3) {
      const bx = x + 8 * (hs / 30);
      const by = y - r - 8 * (hs / 30);
      ctx.fillStyle    = '#333c';
      ctx.fillRect(bx, by, 14, 10);
      ctx.fillStyle    = '#fff';
      ctx.font         = `${Math.max(7, Math.floor(hs * 0.25))}px monospace`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${stack.length - 3}`, bx + 7, by + 5);
    }
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

function entityGlyph(type) {
  switch (type) {
    case EntityType.HERO:       return '⚔';
    case EntityType.WITCH:      return '✦';
    case EntityType.SURVIVOR:   return '☺';
    case EntityType.ZOMBIE:     return '†';
    case EntityType.MINION:     return '☠';
    case EntityType.WOOD_GOLEM: return '🪵';
    case EntityType.IRON_GOLEM: return '⚙';
    default: return '?';
  }
}

function stackOffset(index, total) {
  if (total === 1) return { x: 0, y: 0 };
  if (total === 2) return index === 0 ? { x: -6, y: 0 } : { x: 6, y: 0 };
  const offsets = [{ x: -6, y: -4 }, { x: 6, y: -4 }, { x: 0, y: 6 }];
  return offsets[index] || { x: 0, y: 0 };
}
