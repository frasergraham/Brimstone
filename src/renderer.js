// Canvas renderer for the hex map
import {
  MAP_COLS, MAP_ROWS, HEX_SIZE, SQRT3,
  hexToPixel, pixelToHex as _pixelToHex, hexKey, hexDistance,
} from './hex.js';
import { TileType, TILE_COLOR, BUILDING_COLOR, BUILDING_LABEL, ResourceType } from './tiles.js';
import { ENTITY_COLOR, EntityType, SurvivorAbility } from './entities.js';
import { Phase } from './game.js';

const PAD_X = 40;
const PAD_Y = 30;

// Phase-specific background and tile tint
const PHASE_BG = {
  [Phase.DAWN]:  '#100e18',
  [Phase.DAY]:   '#0d1117',
  [Phase.DUSK]:  '#120a08',
  [Phase.NIGHT]: '#07090f',
};

const PHASE_TINT = {
  [Phase.DAWN]:  { color: '#ff8c00', strength: 0.08 },  // warm orange hint
  [Phase.DAY]:   null,                                    // no tint
  [Phase.DUSK]:  { color: '#8b1a00', strength: 0.10 },  // deep red
  [Phase.NIGHT]: { color: '#1a1a3a', strength: 0.15 },  // blue-grey
};

const RESOURCE_DOT = {
  [ResourceType.WOOD]:      '#8B5E3C',
  [ResourceType.METAL]:     '#9E9E9E',
  [ResourceType.HERBS]:     '#4CAF50',
  [ResourceType.FOOD]:      '#FF9800',
  [ResourceType.SILVER]:    '#CFD8DC',
  [ResourceType.SCRIPTURE]: '#FFF176',
};

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

    this.selectedHex    = null;
    this.highlightHexes = [];
    this.hoveredHex     = null;

    this._resize();
  }

  _resize() {
    const w = Math.ceil(SQRT3 * HEX_SIZE * (MAP_COLS + 0.5)) + PAD_X * 2;
    const h = Math.ceil(1.5  * HEX_SIZE * MAP_ROWS + HEX_SIZE * 0.5) + PAD_Y * 2;
    this.canvas.width  = w;
    this.canvas.height = h;
  }

  _toCanvas(col, row) {
    const { x, y } = hexToPixel(col, row);
    return { x: x + PAD_X, y: y + PAD_Y };
  }

  draw() {
    const ctx   = this.ctx;
    const state = this.state;
    const phase = state.phase;

    // Background
    ctx.fillStyle = PHASE_BG[phase] || '#0d1117';
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Objective glows
    for (const obj of state.witchObjectives) {
      this._drawObjectiveGlow(obj.col, obj.row);
    }

    // Tiles
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        this._drawTile(col, row, phase);
      }
    }

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

    // Build set of revealed witch-entity positions (SCOUT ability)
    const revealedHexes = state.fogOfWar ? _scoutRevealedHexes(state) : null;

    // Entities
    const drawn = new Set();
    for (const entity of state.entities) {
      if (!entity.alive) continue;

      // Fog of war: hide witch-side entities unless revealed by scout
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

    // Phase overlay tint (applied last so it's subtle)
    const tint = PHASE_TINT[phase];
    if (tint) {
      ctx.fillStyle = hexToRgba(tint.color, tint.strength);
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
  }

  _drawTile(col, row, phase) {
    const ctx  = this.ctx;
    const tile = this.state.tiles.get(hexKey(col, row));
    if (!tile) return;

    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, HEX_SIZE - 1);

    let color;
    if (tile.type === TileType.BUILDING && tile.building) {
      color = BUILDING_COLOR[tile.building];
    } else {
      color = TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS];
    }

    // Darken unexplored terrain; buildings stay bright so the town is readable
    if (!tile.explored) {
      if (tile.type === TileType.BUILDING) color = blendHex(color, '#000000', 0.15);
      else color = blendHex(color, '#000000', 0.5);
    }

    // Phase tint — subtle, keeps colors recognizable
    if (phase === Phase.NIGHT) color = blendHex(color, '#1a1a3a', 0.15);
    if (phase === Phase.DAWN)  color = blendHex(color, '#3a2000', 0.08);
    if (phase === Phase.DUSK)  color = blendHex(color, '#3a0a00', 0.12);

    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    ctx.strokeStyle = (phase === Phase.NIGHT || phase === Phase.DUSK) ? '#1a1a2e' : '#151a14';
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    // Fortification shimmer: gold = wood (1), cyan = metal (2)
    if (tile.fortifyLevel > 0) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.strokeStyle = tile.fortifyLevel >= 2 ? '#00e5ff99' : '#f5c84266';
      ctx.lineWidth   = tile.fortifyLevel >= 2 ? 3 : 2;
      ctx.stroke();
    }

    // Building label — always visible so the player can see the town layout
    if (tile.type === TileType.BUILDING && tile.building) {
      ctx.fillStyle    = tile.explored ? '#fff8e8' : 'rgba(255,240,200,0.70)';
      ctx.font         = `bold 8px "Georgia", serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(BUILDING_LABEL[tile.building] || tile.building, x, y + HEX_SIZE * 0.55);
    }

    // Explored marker — small dot in the top-right corner so the player
    // can see at a glance which terrain they have already scouted.
    // Buildings already show their name label; non-passable tiles are skipped.
    if (tile.explored && tile.type !== TileType.BUILDING && tile.type !== TileType.RIVER) {
      ctx.fillStyle   = 'rgba(255,255,255,0.35)';
      ctx.beginPath();
      ctx.arc(x + HEX_SIZE * 0.55, y - HEX_SIZE * 0.52, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // Building border — always visible; brighter once explored
    if (tile.type === TileType.BUILDING) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.strokeStyle = tile.explored
        ? 'rgba(245,200,66,0.75)'
        : 'rgba(245,200,66,0.35)';
      ctx.lineWidth   = tile.explored ? 2 : 1.5;
      ctx.stroke();
    }
  }

  _drawObjectiveGlow(col, row) {
    const ctx = this.ctx;
    const { x, y } = this._toCanvas(col, row);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, HEX_SIZE * 1.5);
    gradient.addColorStop(0, 'rgba(160,0,220,0.25)');
    gradient.addColorStop(1, 'rgba(160,0,220,0)');
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, HEX_SIZE * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  _drawObjectiveSymbol(col, row, label, state) {
    const ctx = this.ctx;
    const { x, y } = this._toCanvas(col, row);

    const witchHeld = state.entities.some(
      e => e.alive && e.owner === 'witch' && e.col === col && e.row === row
    );

    ctx.fillStyle    = witchHeld ? '#ff4444' : 'rgba(180,0,255,0.7)';
    ctx.font         = `bold ${Math.floor(HEX_SIZE * 0.5)}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⛧', x, y - HEX_SIZE * 0.15);

    ctx.fillStyle = witchHeld ? '#ff8888' : 'rgba(220,160,255,0.85)';
    ctx.font      = `6px sans-serif`;
    ctx.fillText(label, x, y + HEX_SIZE * 0.35);
  }

  _drawHighlight(col, row, color) {
    const ctx = this.ctx;
    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, HEX_SIZE - 1);
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();
    // Bright border so highlights are visible even on dark unexplored tiles
    ctx.strokeStyle = color.replace(/,\s*[\d.]+\)$/, ', 0.9)');
    ctx.lineWidth   = 2;
    ctx.stroke();
  }

  _drawOutline(col, row, color, lineWidth = 2) {
    const ctx = this.ctx;
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

      // Shadow
      ctx.beginPath();
      ctx.arc(ex + 1, ey + 1, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fill();

      // Body
      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      ctx.fillStyle = ENTITY_COLOR[entity.type];
      ctx.fill();
      ctx.strokeStyle = '#ffffffaa';
      ctx.lineWidth   = 1;
      ctx.stroke();

      // Glyph
      ctx.fillStyle    = '#ffffffdd';
      ctx.font         = `bold ${Math.floor(r * 1.1)}px serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(entityGlyph(entity.type), ex, ey + 1);

      // HP bar
      if (entity.type === EntityType.HERO || entity.type === EntityType.WITCH ||
          entity.type === EntityType.SURVIVOR || entity.type === EntityType.WOOD_GOLEM ||
          entity.type === EntityType.IRON_GOLEM) {
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

      // Weapon dot indicator
      if (entity.weapon && entity.owner === 'hero') {
        ctx.fillStyle = '#f5c842';
        ctx.beginPath();
        ctx.arc(ex + r - 2, ey - r + 2, 3, 0, Math.PI * 2);
        ctx.fill();
      }

      // Survivor ability indicator dot
      if (entity.type === EntityType.SURVIVOR && entity.ability) {
        ctx.fillStyle = '#88eeff';
        ctx.beginPath();
        ctx.arc(ex - r + 2, ey - r + 2, 3, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    if (stack.length > 3) {
      ctx.fillStyle    = '#333c';
      ctx.fillRect(x + 8, y - r - 8, 14, 10);
      ctx.fillStyle    = '#fff';
      ctx.font         = '8px monospace';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`+${stack.length - 3}`, x + 15, y - r - 3);
    }
  }

  canvasToHex(canvasX, canvasY) {
    return _pixelToHex(canvasX - PAD_X, canvasY - PAD_Y);
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────

// Returns a Set of hexKeys that SCOUT survivors reveal
function _scoutRevealedHexes(state) {
  const revealed = new Set();
  for (const e of state.entities) {
    if (!e.alive || e.owner !== 'hero' || e.ability !== SurvivorAbility.SCOUT) continue;
    // Reveal all hexes within 3 steps
    for (const we of state.entities) {
      if (!we.alive || we.owner !== 'witch') continue;
      if (hexDistance(e.col, e.row, we.col, we.row) <= 3) {
        revealed.add(hexKey(we.col, we.row));
      }
    }
  }
  return revealed;
}

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

function blendHex(a, b, t) {
  const ra = parseInt(a.slice(1, 3), 16), ga = parseInt(a.slice(3, 5), 16), ba = parseInt(a.slice(5, 7), 16);
  const rb = parseInt(b.slice(1, 3), 16), gb = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
  const r  = Math.round(ra + (rb - ra) * t);
  const g  = Math.round(ga + (gb - ga) * t);
  const bv = Math.round(ba + (bb - ba) * t);
  return `rgb(${r},${g},${bv})`;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

export { PAD_X, PAD_Y };
