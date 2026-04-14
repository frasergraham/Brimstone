// Canvas renderer for the hex map
import {
  MAP_COLS, MAP_ROWS, SQRT3,
  getNeighbors,
  hexToPixel, pixelToHex as _pixelToHex, hexKey, hexDistance,
} from './hex.js';
import {
  TileType, TILE_COLOR, BUILDING_COLOR, BUILDING_LABEL, BUILDING_ICON,
} from './tiles.js';
import { ENTITY_COLOR, EntityType, SurvivorAbility } from './entities.js';
import { getVisiblePositions, sightRange, buildFogMovementHexes } from './actions.js';
import { getFaction } from './factions.js';
import { getFactionTheme, NEUTRAL_NODE_FILL } from './theme.js';
import { nodeController, Phase } from './game.js';

// PAD_X/PAD_Y are now computed dynamically in _resize() as this._padX / this._padY.
// These constants are kept for backward-compat imports but should not be used internally.
export const PAD_X = 40;
export const PAD_Y = 30;
const BG_COLOR = '#2a2a2f';
const MIN_HEX_SIZE = 10;

// Hoisted from _drawTile — avoids allocating a new object per hex per frame.
const TERRAIN_SPRITES = Object.freeze({
  [TileType.GRASS]: 1, [TileType.DIRT]: 1, [TileType.FOREST]: 1,
  [TileType.ROAD]: 1, [TileType.RIVER]: 1, [TileType.BRIDGE]: 1,
  [TileType.BUILDING]: 1,
});

function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 180 * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return pts;
}

// ── Cached hex-corner offsets ────────────────────────────────────────────────
// hexCorners() computes 12 trig ops per call.  For a given `size` the offsets
// are constant, so we pre-compute them once and reuse across every hex.
const _hexOffsetCache = new Map();  // size → Float64Array(12) [dx0,dy0,…dx5,dy5]

function _getHexOffsets(size) {
  let arr = _hexOffsetCache.get(size);
  if (arr) return arr;
  arr = new Float64Array(12);
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 180 * (60 * i - 30);
    arr[i * 2]     = size * Math.cos(angle);
    arr[i * 2 + 1] = size * Math.sin(angle);
  }
  _hexOffsetCache.set(size, arr);
  return arr;
}

/** Trace a hex path on `ctx` using cached offsets — zero allocation. */
function _traceHexPath(ctx, cx, cy, size) {
  const o = _getHexOffsets(size);
  ctx.beginPath();
  ctx.moveTo(cx + o[0], cy + o[1]);
  for (let i = 1; i < 6; i++) ctx.lineTo(cx + o[i * 2], cy + o[i * 2 + 1]);
  ctx.closePath();
}

/** Return corners as an array of {x,y} using cached offsets. */
function _cachedHexCorners(cx, cy, size) {
  const o = _getHexOffsets(size);
  const pts = new Array(6);
  for (let i = 0; i < 6; i++) pts[i] = { x: cx + o[i * 2], y: cy + o[i * 2 + 1] };
  return pts;
}

/** Convert a 0–1 alpha value to a 2-char hex string (e.g. 0.5 → '80'). */
function _alphaHex(a) {
  return Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');
}

/** Convert a 6-digit hex colour string to an rgba() string with the given alpha. */
function _hexToRgba(hex, alpha) {
  if (typeof hex === 'string' && hex.startsWith('#') && hex.length === 7) {
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  return hex; // already rgba / named — pass through unchanged
}

/**
 * Parse a '#rrggbb' or 'rgba(r,g,b,a)' / 'rgb(r,g,b)' string into [r,g,b,a].
 * Returns null if the format is unrecognised.
 */
export function _parseColor(color) {
  if (typeof color !== 'string') return null;
  if (color.startsWith('#') && color.length === 7) {
    return [
      parseInt(color.slice(1, 3), 16),
      parseInt(color.slice(3, 5), 16),
      parseInt(color.slice(5, 7), 16),
      1,
    ];
  }
  const m = color.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+))?\s*\)/);
  if (m) return [+m[1], +m[2], +m[3], m[4] !== undefined ? +m[4] : 1];
  return null;
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

    /** Ghost overlay steps from computeGhostState(). null = no overlay. */
    this.planGhostSteps = null;

    /** Tutorial spotlight: pulsing ring drawn over this hex. null = inactive. */
    this.tutorialSpotlightHex = null;

    /** ID of the currently selected entity; drives the ⊕ indicator drawn above its hex. */
    this.selectedEntityId = null;

    /** Arc menu connecting lines: { col, row, items: [{ x, y, color }] } or null. */
    this.arcMenuLines = null;

    /**
     * AI debug overlay data — set by main.js when AI debugger is active.
     * @type {{ hexGoals: Map, nodes: Array, unitCommitments: Map, board: object, faction: string }|null}
     */
    this.aiDebugOverlay = null;

    // Zoom & pan
    this.zoomLevel  = 1.0;
    this._panX      = 0;
    this._panY      = 0;
    this.viewLocked = false;  // when true: blocks frameHexes, setZoom, and drag-pan
    // Insets account for panels that overlay the canvas (plan panel right, chronicle sidebar left).
    // Set by UIController when panels open/close so framing targets only the visible area.
    this.insetLeft  = 0;
    this.insetRight = 0;

    // Damage flash overlays: [{col, row, text, color, endTime, fontScale, textColor}]
    this._flashes = [];

    // Death burst animations: [{col, row, color, startTime, duration}]
    this._deathAnims = [];

    // Fade-out animations for killed entities: Map<entityId, {startTime, duration}>
    this._fadeOutAnims = new Map();

    // Move animations: sliding entity icons
    this._moveAnims = [];

    // Lunge animations: attacker slides to hex border during combat, stays there until cleared
    this._lungeAnims = [];

    // Battle hex highlights: set during combat animation, cleared after
    this._battleCombatantHexes = []; // [{col, row}] — bright red
    this._battleAllyHexes      = []; // [{col, row}] — faint red

    // Node reveal animations: [{hexes, color, startTime, duration}]
    this._nodeRevealAnims = [];

    this._animFramePending = false;

    // Smooth zoom/pan animation: null when idle
    this._zoomAnim = null; // {startZoom,targetZoom,startPanX,targetPanX,startPanY,targetPanY,startTime,duration}

    // Tilemap sprite sheet — populated by loadImages()
    this._tilemapImg   = null;   // HTMLImageElement for assets/tilemap.png
    this._spriteRects  = null;   // Map<id, {x,y,size}> — source rect in the tilemap

    /** When false, terrain/building sprites are hidden and only colour fills are drawn. */
    this.useTileImages = true;

    // Pre-clipped hex tile sprite cache — avoids per-frame save/clip/drawImage/restore.
    this._hexTileCache      = new Map(); // spriteId → {canvas, scale}
    this._hexTileCacheSize  = 0;         // hexSize when cache was built
    this._hexTileCacheScale = 0;         // zoom scale when cache was built

    this._resize();
  }

  /**
   * Build a map of asset-id → source rect within assets/tilemap.png.
   * The layout mirrors the stitchTilemap() function in scripts/generate-assets.js:
   *   CELL=256, GAP=6, COLS=7, LABEL_H=30, groups: Tiles → Buildings → Units
   */
  static _buildSpriteRects() {
    const CELL = 256, GAP = 6, COLS = 7, LABEL_H = 30;
    const groups = [
      ['grass_1','grass_2','grass_3','grass_4','grass_5',
       'forest_1','forest_2','forest_3','forest_4','forest_5',
       'dirt_1','dirt_2','dirt_3','dirt_4','dirt_5',
       'road','river','bridge'],
      ['town_hall','church','inn','blacksmith','graveyard','mill',
       'dock','house','barn','watchtower','apothecary','storehouse','stable'],
      ['hero','witch','zombie','minion','wood_golem','iron_golem',
       'survivor_innkeeper','survivor_nurse','survivor_blacksmith',
       'survivor_herbalist','survivor_militia','survivor_priest',
       'survivor_baker','survivor_trapper','survivor_schoolteacher',
       'survivor_gravedigger','survivor_midwife','survivor_farmhand',
       'survivor_tanner','survivor_chandler','survivor_goodwife',
       'survivor_constable','survivor_weaver','survivor_carpenter',
       'survivor_apothecary','survivor_fisherman'],
      ['cycle_dawn','cycle_day','cycle_dusk','cycle_night'],
    ];

    const rects = new Map();
    const variantCounts = new Map(); // e.g. 'grass' → 5
    let y = GAP;

    for (const ids of groups) {
      y += LABEL_H + GAP; // skip the category label row
      for (let i = 0; i < ids.length; i++) {
        const col  = i % COLS;
        const row  = Math.floor(i / COLS);
        const sx   = GAP + col * (CELL + GAP);
        const sy   = y   + row * (CELL + GAP);
        rects.set(ids[i], { x: sx, y: sy, size: CELL });
        // Count variants: "grass_3" → base "grass", variant 3
        const m = ids[i].match(/^(.+)_(\d+)$/);
        if (m) {
          const base = m[1], num = parseInt(m[2]);
          variantCounts.set(base, Math.max(variantCounts.get(base) ?? 0, num));
        }
      }
      y += Math.ceil(ids.length / COLS) * (CELL + GAP);
    }

    return { rects, variantCounts };
  }

  /**
   * Load assets/tilemap.png and compute per-sprite source rects.
   * Falls back gracefully (colour fills) when the file is absent.
   */
  async loadImages(basePath = 'assets') {
    const img = new Image();
    await new Promise(resolve => {
      img.onload  = resolve;
      img.onerror = resolve; // absent tilemap → silent fallback
      img.src = `${basePath}/tilemap.png`;
    });

    if (!img.naturalWidth) return; // failed to load — keep colour fallbacks

    this._tilemapImg  = img;
    const { rects, variantCounts } = Renderer._buildSpriteRects();
    this._spriteRects    = rects;
    this._variantCounts  = variantCounts;
    this._portraitCache = new Map();
    this.draw();
    if (this.onImagesLoaded) this.onImagesLoaded();
  }

  /**
   * Compute screen-space positions and sizes for entities in a stack at a hex.
   * Used by the disambiguation menu to position DOM clones over canvas entities.
   */
  getEntityScreenPositions(col, row, entities, canvasRect) {
    const { x, y } = this._toCanvas(col, row);
    const hs = this.hexSize;
    const r  = entities.length === 1 ? hs * 0.42 : hs * 0.32;
    const scale = canvasRect.width / this.canvas.width;
    const max = Math.min(entities.length, 3);

    return entities.slice(0, max).map((entity, i) => {
      const off = stackOffset(i, max);
      const ex = x + off.x * (hs / 30);
      const ey = y + off.y * (hs / 30);
      const screenX = canvasRect.left + (ex * this.zoomLevel + this._panX) * scale;
      const screenY = canvasRect.top  + (ey * this.zoomLevel + this._panY) * scale;
      const screenR = r * this.zoomLevel * scale;
      return { entityId: entity.id, screenX, screenY, screenR };
    });
  }

  /**
   * Compute screen position for a single entity at a specific hex,
   * given its index within a stack of `stackTotal` entities.
   */
  getEntityScreenPos(col, row, entityId, stackIndex, stackTotal, canvasRect) {
    const { x, y } = this._toCanvas(col, row);
    const hs = this.hexSize;
    const r  = stackTotal === 1 ? hs * 0.42 : hs * 0.32;
    const scale = canvasRect.width / this.canvas.width;
    const off = stackOffset(stackIndex, Math.min(stackTotal, 3));
    const ex = x + off.x * (hs / 30);
    const ey = y + off.y * (hs / 30);
    const screenX = canvasRect.left + (ex * this.zoomLevel + this._panX) * scale;
    const screenY = canvasRect.top  + (ey * this.zoomLevel + this._panY) * scale;
    const screenR = r * this.zoomLevel * scale;
    return { entityId, screenX, screenY, screenR };
  }

  /**
   * Draw the named sprite to an offscreen canvas and return a cached data URL
   * suitable for use as an <img src>.  Returns null if the tilemap isn't loaded
   * or the asset id is unknown.
   */
  getPortraitDataURL(assetId, size = 128) {
    if (!this._tilemapImg || !this._spriteRects) return null;
    const rect = this._spriteRects.get(assetId);
    if (!rect) return null;
    const key = `${assetId}@${size}`;
    if (this._portraitCache.has(key)) return this._portraitCache.get(key);
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(this._tilemapImg, rect.x, rect.y, rect.size, rect.size, 0, 0, size, size);
    const url = c.toDataURL();
    this._portraitCache.set(key, url);
    return url;
  }

  /**
   * Render a small hex tile thumbnail and return a cached data URL.
   * Shows terrain colour fill, sprite texture, building overlay, and fortification ring.
   */
  getTileDataURL(tile, col, row, size = 28) {
    if (!this._portraitCache) return null;
    const fortKey = tile.fortifyLevel || 0;
    const bldg = tile.building || '';
    const cacheKey = `tile_${tile.type}_${bldg}_${fortKey}@${size}`;
    if (this._portraitCache.has(cacheKey)) return this._portraitCache.get(cacheKey);

    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const hs = size / 2;

    // Hex fill colour
    const color = tile.type === TileType.BUILDING
      ? (BUILDING_COLOR[tile.building] || '#8a7a5a')
      : (tile.type === 'road' || tile.type === 'river' || tile.type === 'bridge')
        ? TILE_COLOR[TileType.GRASS]
        : (TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS]);
    _traceHexPath(ctx, hs, hs, hs - 0.5);
    ctx.fillStyle = color;
    ctx.fill();

    // Sprite texture (if tilemap available)
    if (this._tilemapImg && this._spriteRects && TERRAIN_SPRITES[tile.type]) {
      const baseType = tile.type === TileType.BUILDING ? TileType.DIRT
        : (tile.type === 'road' || tile.type === 'river' || tile.type === 'bridge') ? TileType.GRASS
        : tile.type;
      const spriteId = this._pickVariant(baseType, col, row);
      const rect = this._spriteRects.get(spriteId);
      if (rect) {
        ctx.save();
        _traceHexPath(ctx, hs, hs, hs - 0.5);
        ctx.clip();
        ctx.drawImage(this._tilemapImg, rect.x, rect.y, rect.size, rect.size, 0, 0, size, size);
        ctx.restore();
      }
    }

    // Building overlay
    if (tile.type === TileType.BUILDING && this._tilemapImg) {
      const bldgRect = this._spriteRects?.get(tile.building);
      if (bldgRect) {
        ctx.save();
        _traceHexPath(ctx, hs, hs, hs - 0.5);
        ctx.clip();
        ctx.drawImage(this._tilemapImg, bldgRect.x, bldgRect.y, bldgRect.size, bldgRect.size, 0, 0, size, size);
        ctx.restore();
      }
    }

    // Fortification ring
    if (tile.fortifyLevel > 0) {
      const lvl = tile.fortifyLevel;
      const fortPalette = [
        null,
        [160, 100, 55],
        [120, 135, 148],
        [180, 196, 210],
        [205, 165, 35],
      ];
      const [fr, fg, fb] = fortPalette[Math.min(lvl, 4)];
      const alpha = Math.min(0.95, 0.5 + lvl * 0.12);
      _traceHexPath(ctx, hs, hs, hs - 1);
      ctx.strokeStyle = `rgba(${fr},${fg},${fb},${alpha})`;
      ctx.lineWidth = Math.max(1.5, lvl * 1.2);
      ctx.stroke();
    }

    // Hex outline
    _traceHexPath(ctx, hs, hs, hs - 0.5);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    const url = c.toDataURL();
    this._portraitCache.set(cacheKey, url);
    return url;
  }

  /** Map a survivor entity's title to its sprite asset id. */
  static survivorAssetId(title) {
    const MAP = {
      'Innkeeper':        'survivor_innkeeper',
      'Nurse':            'survivor_nurse',
      'Blacksmith':       'survivor_blacksmith',
      'Herbalist':        'survivor_herbalist',
      'Militia Sergeant': 'survivor_militia',
      'Parish Priest':    'survivor_priest',
      'Baker':            'survivor_baker',
      'Trapper':          'survivor_trapper',
      'Schoolteacher':    'survivor_schoolteacher',
      'Gravedigger':      'survivor_gravedigger',
      'Midwife':          'survivor_midwife',
      'Farmhand':         'survivor_farmhand',
      'Tanner':           'survivor_tanner',
      'Chandler':         'survivor_chandler',
      'Goodwife':         'survivor_goodwife',
      'Constable':        'survivor_constable',
      'Weaver':           'survivor_weaver',
      'Carpenter':        'survivor_carpenter',
      "Apothecary's Daughter": 'survivor_apothecary',
      'Fisherman':        'survivor_fisherman',
    };
    return MAP[title] ?? null;
  }

  // Add a brief flash overlay on a hex (e.g. damage numbers).
  // fontScale: multiplier on hexSize for the text size (default 0.85).
  // textColor: explicit rgba string for the rising number (defaults to a bright version of color).
  addFlash(col, row, text, color = 'rgba(220,40,40,0.7)', durationMs = 1800, fontScale = 0.85, textColor = null) {
    this._flashes.push({ col, row, text, color, startTime: Date.now(), endTime: Date.now() + durationMs, fontScale, textColor });
    this._startAnimLoop();
  }

  /** Burst of expanding rings at a hex — used for unit death. */
  addDeathAnim(col, row, color = '#ff4444') {
    this._deathAnims.push({ col, row, color, startTime: Date.now(), duration: 600 });
    this._startAnimLoop();
  }

  /** Fade out a killed entity's sprite over the given duration. */
  addFadeOutAnim(entityId, duration = 600) {
    this._fadeOutAnims.set(entityId, { startTime: Date.now(), duration });
    this._startAnimLoop();
  }

  /** Returns current opacity for an entity (1.0 if not fading, 0.0 when fully faded). */
  getFadeOutOpacity(entityId) {
    const anim = this._fadeOutAnims.get(entityId);
    if (!anim) return 1;
    const t = (Date.now() - anim.startTime) / anim.duration;
    return Math.max(0, 1 - t);
  }

  /** Pulsing glow animation on a node cluster — used when a power node is first revealed. */
  addNodeRevealAnim(hexes, color, { radiusMultiplier = 2, duration = 2000 } = {}) {
    this._nodeRevealAnims.push({
      hexes,  // [{col, row}]
      color,
      startTime: Date.now(),
      duration,
      radiusMultiplier,
    });
    this._startAnimLoop();
  }

  /** Sparkle animation at a hex — used for summon/spawn. */
  addSpawnAnim(col, row, color = '#b39ddb') {
    // Reuse flash with sparkle text and a short purple burst
    this.addFlash(col, row, '✦', color, 900, 1.1, null);
    this._deathAnims.push({ col, row, color, startTime: Date.now(), duration: 500, spawn: true });
    this._startAnimLoop();
  }

  /** Slide an entity icon from one hex to another (opponent move feedback). */
  addMoveAnim(entityId, fromCol, fromRow, toCol, toRow, entityType, owner, title = null) {
    const from = this._toCanvas(fromCol, fromRow);
    const to   = this._toCanvas(toCol,   toRow);
    const portraitId = entityType === EntityType.SURVIVOR
      ? Renderer.survivorAssetId(title)
      : entityType; // non-survivor type values match asset ids directly
    this._moveAnims = this._moveAnims.filter(a => a.entityId !== entityId);
    this._moveAnims.push({
      entityId,
      owner,
      fromCol, fromRow, toCol, toRow,
      fromX: from.x, fromY: from.y,
      toX:   to.x,   toY:   to.y,
      glyph: entityGlyph(entityType),
      color: ENTITY_COLOR[entityType],
      portraitId,
      startTime: Date.now(),
      duration:  480,
    });
    this._startAnimLoop();
  }

  /**
   * Slide the attacker to the border of the target hex and hold it there.
   * The entity stays at the midpoint until clearAllLungeAnims() is called.
   */
  addLungeAnim(entityId, fromCol, fromRow, toCol, toRow, entityType, owner, title = null) {
    const from = this._toCanvas(fromCol, fromRow);
    const to   = this._toCanvas(toCol,   toRow);
    const midX = (from.x + to.x) * 0.5;
    const midY = (from.y + to.y) * 0.5;
    const portraitId = entityType === EntityType.SURVIVOR
      ? Renderer.survivorAssetId(title)
      : entityType;
    // Replace any existing lunge for this entity
    this._lungeAnims = this._lungeAnims.filter(a => a.entityId !== entityId);
    this._lungeAnims.push({
      entityId,
      owner,
      fromCol, fromRow, toCol, toRow,
      fromX: from.x, fromY: from.y,
      midX, midY,
      glyph:     entityGlyph(entityType),
      color:     ENTITY_COLOR[entityType],
      portraitId,
      startTime: Date.now(),
      duration:  250,
      settled:   false,
    });
    this._startAnimLoop();
  }

  /** Remove all lunge animations immediately (snaps entities back to their state positions). */
  clearAllLungeAnims() {
    this._lungeAnims = [];
  }

  /** Clear only hex flash overlays (loot floaters, HP text, etc.). */
  clearFlashes() { this._flashes = []; }

  /** Clear all in-flight canvas animations (moves, flashes, deaths, lunges, battle highlights, zoom). */
  clearAnimations() {
    this._moveAnims              = [];
    this._flashes                = [];
    this._deathAnims             = [];
    this._fadeOutAnims           = new Map();
    this._lungeAnims             = [];
    this._battleCombatantHexes   = [];
    this._battleAllyHexes        = [];
    this._nodeRevealAnims        = [];
    this._zoomAnim               = null;  // cancel any ongoing camera zoom so it doesn't bleed into next round
  }

  /**
   * Trigger a return animation on all active lunge anims so entities slide back
   * to their home hex instead of snapping. Completed returns are auto-removed.
   * Call waitForAnimations() afterwards to await the returns.
   */
  returnAllLungeAnims() {
    const returnDuration = 180;
    for (const a of this._lungeAnims) {
      if (!a.returning) {
        a.settled       = true; // treat as settled so it starts at midX/midY
        a.returning     = true;
        a.returnStartTime = Date.now();
        a.returnDuration  = returnDuration;
      }
    }
    if (this._lungeAnims.length) this._startAnimLoop();
  }

  /** Set which hexes should be highlighted red during a combat sequence. */
  setBattleHighlights(combatantHexes, allyHexes) {
    this._battleCombatantHexes = combatantHexes ?? [];
    this._battleAllyHexes      = allyHexes ?? [];
  }

  /** Clear combat hex highlights. */
  clearBattleHighlights() {
    this._battleCombatantHexes = [];
    this._battleAllyHexes      = [];
  }

  /** Flash attacker (orange) and target (red) hexes during a battle. */
  addAttackAnim(actorCol, actorRow, targetCol, targetRow) {
    this.addFlash(actorCol,  actorRow,  '', 'rgba(255,140,0,0.75)', 700);
    this.addFlash(targetCol, targetRow, '', 'rgba(220,40,40,0.75)',  700);
  }

  /** Show a floating HP-change number over a hex (red for damage, green for healing). */
  addHpChangeFlash(col, row, delta) {
    if (delta === 0) return;
    if (delta < 0) {
      this.addFlash(col, row, `${delta}`, 'rgba(220,40,40,0.1)', 1200, 0.88, 'rgba(255,100,100,1)');
    } else {
      this.addFlash(col, row, `+${delta}`, 'rgba(40,180,40,0.1)', 1200, 0.88, 'rgba(100,255,100,1)');
    }
  }

  /** Keep calling draw() until all animations have expired. */
  _startAnimLoop() {
    if (this._animFramePending) return;
    this._animFramePending = true;
    const loop = () => {
      const now = Date.now();
      const alive = this._moveAnims.some(a => now < a.startTime + a.duration)
                 || this._flashes.some(f => now < f.endTime)
                 || this._deathAnims.some(a => now < a.startTime + a.duration)
                 || [...this._fadeOutAnims.values()].some(a => now < a.startTime + a.duration)
                 || this._lungeAnims.some(a => !a.settled || a.returning)
                 || this._nodeRevealAnims.some(a => now < a.startTime + a.duration)
                 || !!this._zoomAnim;
      this.draw();
      if (alive) {
        requestAnimationFrame(loop);
      } else {
        this._animFramePending = false;
      }
    };
    requestAnimationFrame(loop);
  }

  /**
   * Returns a Promise that resolves once all active canvas animations
   * (move, flash, death, lunge, zoom) have completed.
   * Safe to call when no animations are running — resolves on next frame.
   */
  waitForAnimations() {
    return new Promise(resolve => {
      const check = () => {
        const now = Date.now();
        const alive = this._moveAnims.some(a => now < a.startTime + a.duration)
                   || this._flashes.some(f => now < f.endTime)
                   || this._deathAnims.some(a => now < a.startTime + a.duration)
                   || [...this._fadeOutAnims.values()].some(a => now < a.startTime + a.duration)
                   || this._lungeAnims.some(a => !a.settled || a.returning)
                   || this._nodeRevealAnims.some(a => now < a.startTime + a.duration)
                   || !!this._zoomAnim;
        if (alive) requestAnimationFrame(check);
        else resolve();
      };
      requestAnimationFrame(check);
    });
  }

  /**
   * Compute a target {zoom, panX, panY} that frames the given hex positions
   * with padding, clamped to [1.0, maxZoom].
   */
  _computeFrameView(positions, paddingHexes, maxZoom) {
    if (!positions || positions.length === 0) return null;
    const fullW = this.canvas.width;
    const H     = this.canvas.height;
    const hs    = this.hexSize;
    // Effective visible width excludes panels that overlay the canvas edges
    const visW  = fullW - (this.insetLeft ?? 0) - (this.insetRight ?? 0);
    const offX  = this.insetLeft ?? 0; // left offset of the visible area

    const pts = positions.map(p => this._toCanvas(p.col, p.row));
    let minX = pts[0].x, maxX = pts[0].x, minY = pts[0].y, maxY = pts[0].y;
    for (const { x, y } of pts) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }

    const pad = hs * paddingHexes;
    minX -= pad; maxX += pad;
    minY -= pad; maxY += pad;

    // Zoom to fit the padded box within the visible area, clamped to [1.0, maxZoom]
    const z = Math.max(1.0, Math.min(maxZoom, Math.min(visW / (maxX - minX), H / (maxY - minY))));

    // Pan to center the box within the visible area (shifted by insetLeft)
    const cx = (minX + maxX) / 2;
    const cy = (minY + maxY) / 2;
    let panX = offX + visW / 2 - cx * z;
    let panY = H / 2 - cy * z;

    // Clamp using the same logic as _clampPan — accounts for _padX which
    // can be deeply negative on large maps (42×42).
    const mapW = SQRT3 * hs * (MAP_COLS + 0.5) * z;
    const mapH = (1.5 * MAP_ROWS + 0.5) * hs * z;
    const contentW = Math.max(fullW * z, mapW);
    const contentH = Math.max(H * z, mapH);
    const padXz = this._padX * z;
    const padYz = this._padY * z;
    const maxPanX = -padXz + fullW * 0.5;
    const maxPanY = -padYz + H * 0.5;
    const minPanX = fullW - contentW - padXz - fullW * 0.5;
    const minPanY = H - contentH - padYz - H * 0.5;
    panX = Math.max(minPanX, Math.min(maxPanX, panX));
    panY = Math.max(minPanY, Math.min(maxPanY, panY));

    return { zoom: z, panX, panY };
  }

  /**
   * Smoothly zoom/pan to frame a set of hex positions.
   *
   * @param {Array<{col,row}>} positions  Hexes to include in the frame.
   * @param {{ paddingHexes?: number, maxZoom?: number, duration?: number }} [opts]
   *   paddingHexes – extra space around the bounding box, in hex radii (default 2.0)
   *   maxZoom      – hard cap so the view never gets too close (default 2.0)
   *   duration     – animation length in ms; 0 = instant (default 500)
   */
  frameHexes(positions, { paddingHexes = 2.0, maxZoom = 2.0, duration = 500 } = {}) {
    if (this.viewLocked) return;
    const target = this._computeFrameView(positions, paddingHexes, maxZoom);
    if (!target) return;

    if (duration <= 0) {
      this.zoomLevel = target.zoom;
      this._panX     = target.panX;
      this._panY     = target.panY;
      return;
    }

    this._zoomAnim = {
      startZoom:  this.zoomLevel,
      targetZoom: target.zoom,
      startPanX:  this._panX,
      targetPanX: target.panX,
      startPanY:  this._panY,
      targetPanY: target.panY,
      startTime:  Date.now(),
      duration,
    };
    this._startAnimLoop();
  }

  _resize() {
    const wrapper = this.canvas.parentElement;
    const W = (wrapper && wrapper.clientWidth  > 0) ? wrapper.clientWidth  : this.canvas.width;
    const H = (wrapper && wrapper.clientHeight > 0) ? wrapper.clientHeight : this.canvas.height;

    // Compute hex size to fit grid within the full wrapper (no padding subtracted here —
    // padding is derived from hexSize afterward and used to center the grid).
    const sizeByW = W / (SQRT3 * (MAP_COLS + 0.5));
    const sizeByH = H / (1.5 * MAP_ROWS + 0.5);
    this.hexSize = Math.max(MIN_HEX_SIZE, Math.floor(Math.min(sizeByW, sizeByH)));

    // Canvas fills the wrapper exactly — only update if size actually changed.
    // After a canvas dimension change the GPU may composite a transparent frame
    // before the next draw() call, so immediately fill the background to prevent
    // a blank flash.
    let sizeChanged = false;
    if (this.canvas.width  !== W) { this.canvas.width  = W; sizeChanged = true; }
    if (this.canvas.height !== H) { this.canvas.height = H; sizeChanged = true; }
    if (sizeChanged && this.ctx) {
      this.ctx.fillStyle = '#0d1117';
      this.ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }

    // Center the hex grid within the canvas
    const hs = this.hexSize;
    this._padX = Math.round((W - SQRT3 * hs * (MAP_COLS + 0.5)) / 2 + SQRT3 * hs * 0.5);
    this._padY = Math.round((H - (1.5 * MAP_ROWS + 0.5) * hs) / 2 + hs);

    this._clampPan();
  }

  resize() {
    this._resize();
  }

  /** Draw text with a dark rounded box behind it for legibility over busy terrain. */
  _shadowText(text, x, y) {
    const ctx = this.ctx;
    const prevFill = ctx.fillStyle;
    const metrics = ctx.measureText(text);
    const tw = metrics.width;
    const th = metrics.actualBoundingBoxAscent + metrics.actualBoundingBoxDescent;
    const px = 3, py = 2; // padding
    const bx = x - tw / 2 - px;
    const by = y - metrics.actualBoundingBoxAscent - py;
    const bw = tw + px * 2;
    const bh = th + py * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    const r = 3;
    ctx.beginPath();
    ctx.moveTo(bx + r, by);
    ctx.lineTo(bx + bw - r, by);
    ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
    ctx.lineTo(bx + bw, by + bh - r);
    ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
    ctx.lineTo(bx + r, by + bh);
    ctx.quadraticCurveTo(bx, by + bh, bx, by + bh - r);
    ctx.lineTo(bx, by + r);
    ctx.quadraticCurveTo(bx, by, bx + r, by);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = prevFill;
    ctx.fillText(text, x, y);
  }

  _toCanvas(col, row) {
    const { x, y } = hexToPixel(col, row, this.hexSize);
    return { x: x + this._padX, y: y + this._padY };
  }

  // Convert canvas pixel coordinates back to hex grid coordinates (accounts for zoom/pan)
  canvasToHex(canvasX, canvasY) {
    const x = (canvasX - this._panX) / this.zoomLevel;
    const y = (canvasY - this._panY) / this.zoomLevel;
    return _pixelToHex(x - this._padX, y - this._padY, this.hexSize);
  }

  // Return the canvas-pixel centre of a hex (for overlay positioning, accounts for zoom/pan)
  hexToCanvasPos(col, row) {
    const { x, y } = this._toCanvas(col, row);
    return {
      x: x * this.zoomLevel + this._panX,
      y: y * this.zoomLevel + this._panY,
    };
  }

  // Zoom toward a focal point (canvas pixel coordinates)
  setZoom(newZoom, focalX, focalY) {
    if (this.viewLocked) return;
    this._zoomAnim = null; // cancel any auto-framing animation on manual input
    // Scale max zoom so large maps can zoom in to the same effective hex size
    // as small maps. Target: hexSize * maxZoom ≈ 96px (same as standard at 4×).
    const maxZoom = Math.max(4.0, Math.ceil(96 / Math.max(1, this.hexSize)));
    newZoom = Math.max(0.5, Math.min(maxZoom, newZoom));
    const ratio  = newZoom / this.zoomLevel;
    this._panX   = focalX - ratio * (focalX - this._panX);
    this._panY   = focalY - ratio * (focalY - this._panY);
    this.zoomLevel = newZoom;
    this._clampPan();
  }

  resetView() {
    this.zoomLevel = 1.0;
    // Offset pan so the map centers within the visible area (excluding side-panel insets)
    this._panX = (this.insetLeft ?? 0) / 2 - (this.insetRight ?? 0) / 2;
    this._panY = 0;
  }

  _clampPan() {
    const wrapper = this.canvas.parentElement;
    const wrapW = wrapper?.clientWidth  ?? this.canvas.width;
    const wrapH = wrapper?.clientHeight ?? this.canvas.height;
    // Content dimensions at current zoom — use the actual map pixel extent
    // (not just canvas size) so large maps can be fully panned.
    const hs = this.hexSize;
    const z  = this.zoomLevel;
    const mapW = SQRT3 * hs * (MAP_COLS + 0.5) * z;
    const mapH = (1.5 * MAP_ROWS + 0.5) * hs * z;
    const contentW = Math.max(this.canvas.width * z, mapW);
    const contentH = Math.max(this.canvas.height * z, mapH);

    // Margin: allow any hex (including edge hexes) to be centered in the viewport.
    // Account for _padX offset which can be negative on large maps.
    const padXz = this._padX * z;
    const padYz = this._padY * z;
    // Max pan: leftmost map edge can reach right side of viewport
    const maxPanX = -padXz + wrapW * 0.5;
    const maxPanY = -padYz + wrapH * 0.5;
    // Min pan: rightmost map edge can reach left side of viewport
    const minPanX = wrapW - contentW - padXz - wrapW * 0.5;
    const minPanY = wrapH - contentH - padYz - wrapH * 0.5;
    this._panX = Math.max(minPanX, Math.min(maxPanX, this._panX));
    this._panY = Math.max(minPanY, Math.min(maxPanY, this._panY));
  }

  // ── Viewport culling ────────────────────────────────────────────────────
  // Returns the min/max col/row range visible in the current viewport,
  // accounting for zoom and pan.  A 1-hex margin is added on each side so
  // partially-visible hexes at the edges are still drawn.
  _getVisibleRange() {
    const hs = this.hexSize;
    const z  = this.zoomLevel;
    // Viewport bounds in map-local (pre-zoom) coordinates
    const left   = -this._panX / z;
    const top    = -this._panY / z;
    const right  = (this.canvas.width  - this._panX) / z;
    const bottom = (this.canvas.height - this._panY) / z;
    // Convert to col/row with 1-hex margin for partially visible hexes
    const colW = SQRT3 * hs;
    const rowH = 1.5 * hs;
    return {
      minCol: Math.max(0, Math.floor((left   - this._padX) / colW - 1)),
      maxCol: Math.min(MAP_COLS - 1, Math.ceil((right  - this._padX) / colW + 1)),
      minRow: Math.max(0, Math.floor((top    - this._padY) / rowH - 1)),
      maxRow: Math.min(MAP_ROWS - 1, Math.ceil((bottom - this._padY) / rowH + 1)),
    };
  }

  draw() {
    const ctx   = this.ctx;
    const state = this.state;

    // Build ownerId → playerColor from leader entities so hex outlines show
    // the owning player's colour regardless of entity type.
    this._playerColorMap = new Map();
    for (const e of state.entities) {
      if (e.color && e.ownerId && (e.type === EntityType.HERO || e.type === EntityType.WITCH)) {
        this._playerColorMap.set(e.ownerId, e.color);
      }
    }

    // Tick smooth zoom/pan animation
    if (this._zoomAnim) {
      const t    = Math.min(1, (Date.now() - this._zoomAnim.startTime) / this._zoomAnim.duration);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease-in-out
      this.zoomLevel = this._zoomAnim.startZoom  + (this._zoomAnim.targetZoom  - this._zoomAnim.startZoom)  * ease;
      this._panX     = this._zoomAnim.startPanX  + (this._zoomAnim.targetPanX  - this._zoomAnim.startPanX)  * ease;
      this._panY     = this._zoomAnim.startPanY  + (this._zoomAnim.targetPanY  - this._zoomAnim.startPanY)  * ease;
      if (t >= 1) this._zoomAnim = null;
    }

    // Background covers the full canvas regardless of zoom/pan
    // Tint backdrop by time-of-day: warm grey (day), mid grey (dawn/dusk), dark blue-grey (night)
    {
      const phase = state.phase;
      let bg;
      if (this.useTileImages && this._tilemapImg) {
        bg = BG_COLOR;
      } else if (phase === Phase.DAY) {
        bg = '#2a2820'; // light grey with subtle warm/yellow hint
      } else if (phase === Phase.DAWN || phase === Phase.DUSK) {
        bg = '#1e1e22'; // mid grey
      } else if (phase === Phase.NIGHT) {
        bg = '#0e1320'; // dark grey with blue tint
      } else {
        bg = '#0d1117';
      }
      ctx.fillStyle = bg;
    }
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Apply zoom and pan transform for all map content
    ctx.save();
    ctx.translate(this._panX, this._panY);
    ctx.scale(this.zoomLevel, this.zoomLevel);

    // Viewport culling — only draw hexes visible on screen
    const vr = this._getVisibleRange();

    // Visibility: compute once for fog layer + entity pass + outlines + terrain culling.
    // In local AI games, perspective is from the human side (witchIsAI / heroIsAI).
    // In online PvP/AI games, state.myFaction is set by the client to their faction.
    const myFaction    = state.myFaction;  // 'hero' | 'witch' | undefined
    const humanIsHero  = myFaction ? myFaction === 'hero'  : (state.witchIsAI && !state.heroIsAI);
    const humanIsWitch = myFaction ? myFaction === 'witch' : (state.heroIsAI  && !state.witchIsAI);
    const fogActive = state.fogOfWar !== 'none';
    let revealedHexes = null;
    if (fogActive) {
      const myFaction = humanIsHero ? 'hero' : humanIsWitch ? 'witch' : null;
      if (myFaction) revealedHexes = getVisiblePositions(state, myFaction);
    }

    // Full set of hexes the observer can see (used to cull animations in fog).
    // Distinct from revealedHexes, which only tracks hexes where enemy entities exist.
    let fogVisibleHexes = null;
    const hiddenOwner = humanIsHero ? 'witch' : (humanIsWitch ? 'hero' : null);
    if (fogActive && hiddenOwner) {
      const observerOwner = humanIsHero ? 'hero' : 'witch';
      fogVisibleHexes = this._buildFogVisibleHexes(observerOwner);
    }

    // For full fog, compute the set of "known" hexes (sight + movement + explored).
    // Unseen hexes outside this set are not rendered at all — the dark canvas
    // background shows through instead of painting an opaque black overlay.
    let fogKnownHexes = null;
    if (fogActive && state.fogOfWar === 'full' && fogVisibleHexes) {
      const observerOwner = humanIsHero ? 'hero' : 'witch';
      const lastStep = this.planGhostSteps?.at(-1);
      const projectedPositions = lastStep?.positions ?? null;
      const moveSet = buildFogMovementHexes(state, observerOwner, projectedPositions);
      const explored = state.exploredHexes?.[observerOwner];
      // Update explored hex memory with current sight + movement sets
      if (explored) {
        for (const k of fogVisibleHexes) explored.add(k);
        for (const k of moveSet) explored.add(k);
      }
      fogKnownHexes = new Set(fogVisibleHexes);
      for (const k of moveSet) fogKnownHexes.add(k);
      if (explored) for (const k of explored) fogKnownHexes.add(k);
    }

    // Pass 1: terrain tiles (grass, forest, dirt, road bg, river bg, bridges)
    for (let row = vr.minRow; row <= vr.maxRow; row++) {
      for (let col = vr.minCol; col <= vr.maxCol; col++) {
        if (fogKnownHexes && !fogKnownHexes.has(hexKey(col, row))) continue;
        const t = state.tiles.get(hexKey(col, row));
        if (t && t.type !== TileType.BUILDING) this._drawTile(col, row);
      }
    }

    // River first (water), then roads on top (bridge deck above the water)
    this._drawRiverLayer(fogKnownHexes);
    this._drawRoadLayer(fogKnownHexes);

    // Pass 2: building tiles drawn over roads/rivers so no bleed-through
    for (let row = vr.minRow; row <= vr.maxRow; row++) {
      for (let col = vr.minCol; col <= vr.maxCol; col++) {
        if (fogKnownHexes && !fogKnownHexes.has(hexKey(col, row))) continue;
        const t = state.tiles.get(hexKey(col, row));
        if (t && t.type === TileType.BUILDING) this._drawTile(col, row);
      }
    }

    // Fog of war layer (dim overlay for partial/explored hexes; unseen hexes already skipped above)
    if (fogActive) {
      const observerOwner = humanIsHero ? 'hero' : (humanIsWitch ? 'witch' : null);
      if (observerOwner) {
        this._drawFogLayer(observerOwner, state.fogOfWar, fogVisibleHexes, vr, fogKnownHexes);
      }
    }

    // Phase tint — subtle colour wash so dusk/night feel distinct
    {
      const phase = state.phase;
      let tint = null;
      if (phase === Phase.DAWN || phase === Phase.DUSK) tint = 'rgba(30,40,70,0.20)';
      if (phase === Phase.NIGHT) tint = 'rgba(20,28,55,0.35)';
      if (tint) {
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, 0, 0); // reset to screen coords
        ctx.fillStyle = tint;
        ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.restore();
      }
    }

    // Explored dots — drawn after fog so they respect fog of war
    {
      const hs = this.hexSize;
      for (let row = vr.minRow; row <= vr.maxRow; row++) {
        for (let col = vr.minCol; col <= vr.maxCol; col++) {
          const t = state.tiles.get(hexKey(col, row));
          if (!t || !t.explored) continue;
          if (fogVisibleHexes && !fogVisibleHexes.has(hexKey(col, row))) continue;
          const { x, y } = this._toCanvas(col, row);
          ctx.fillStyle = 'rgba(245,200,66,0.70)';
          ctx.beginPath();
          ctx.arc(x, y + hs * 0.55, Math.max(2, hs * 0.08), 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }

    // Objective glows and symbols — only drawn once a node has been discovered
    for (const obj of state.witchObjectives) {
      const myFactionId = humanIsHero ? 'hero' : humanIsWitch ? 'witch' : null;
      const shouldDraw = !fogActive
        || (myFactionId && obj[getFaction(myFactionId).getNodeSeenKey()])
        || !myFactionId; // AI vs AI / spectator
      if (!shouldDraw) continue;
      for (const h of obj.hexes) {
        this._drawObjectiveHexGlow(h.col, h.row, obj, state);
      }
      // Draw symbol at the centroid of all cluster hexes (not the center hex)
      let cx = 0, cy = 0;
      for (const h of obj.hexes) {
        const p = this._toCanvas(h.col, h.row);
        cx += p.x; cy += p.y;
      }
      cx /= obj.hexes.length; cy /= obj.hexes.length;
      this._drawObjectiveSymbolAt(cx, cy, obj.label, state, obj);
    }

    // Mission target hex (reach_hex objective) — rendered like a power node with a flag symbol
    if (state.missionTargetHex) {
      const mt = state.missionTargetHex;
      const shouldDrawTarget = !fogActive || mt.seen;
      if (shouldDrawTarget) {
        const mtObj = { color: mt.color, hexes: [mt] };
        this._drawObjectiveHexGlow(mt.col, mt.row, mtObj, state);
        const { x, y } = this._toCanvas(mt.col, mt.row);
        this._drawMissionTargetSymbol(x, y, mt);
      }
    }

    // Node reveal pulse animations — expanding glow rings on newly discovered nodes
    this._drawNodeRevealAnims();

    // Thick outlines on hexes occupied by units
    this._drawUnitPresenceOutlines(revealedHexes);

    // Highlights
    for (const h of this.highlightHexes) {
      this._drawHighlight(h.col, h.row, h.color || 'rgba(100,200,100,0.15)');
    }

    // Battle highlights (combatants = bright red, assisting allies = faint red)
    for (const h of this._battleCombatantHexes) {
      this._drawHighlight(h.col, h.row, 'rgba(200,40,40,0.30)');
    }
    for (const h of this._battleAllyHexes) {
      this._drawHighlight(h.col, h.row, 'rgba(200,80,80,0.14)');
    }

    // Guard zone highlights — light orange on hexes adjacent to guarding units
    // Only during resolution playback, not during planning
    if (!state.planningPhase) {
      const guardZoneKeys = new Set();
      const hiddenFaction = humanIsHero ? 'witch' : (humanIsWitch ? 'hero' : null);
      for (const e of state.entities) {
        if (!e.alive || !(e.guarding > 0)) continue;
        if (revealedHexes && e.owner === hiddenFaction && !revealedHexes.has(hexKey(e.col, e.row))) continue;
        for (const n of getNeighbors(e.col, e.row)) {
          guardZoneKeys.add(hexKey(n.col, n.row));
        }
      }
      for (const key of guardZoneKeys) {
        const [c, r] = key.split(',').map(Number);
        this._drawHighlight(c, r, 'rgba(230,160,60,0.18)');
      }
    }

    if (this.selectedHex) {
      const selEntity = this.selectedEntityId
        ? this.state.entities.find(e => e.id === this.selectedEntityId)
        : null;
      // Use faction colour for the selected hex outline (consistent with unit
      // presence outlines); in multiplayer use the per-player colour.
      let selColor = '#f5c842';
      if (selEntity) {
        const playerColor = selEntity.ownerId
          ? this._playerColorMap.get(selEntity.ownerId) : null;
        const factionColor = selEntity.owner === 'hero'
          ? ENTITY_COLOR[EntityType.HERO]
          : ENTITY_COLOR[EntityType.WITCH];
        selColor = _hexToRgba(playerColor ?? factionColor, 0.95);
      }
      this._drawOutline(this.selectedHex.col, this.selectedHex.row, selColor, 2, true);
    }
    if (this.hoveredHex) {
      this._drawOutline(this.hoveredHex.col, this.hoveredHex.row, 'rgba(255,255,255,0.3)', 1);
    }

    // Entities — skip any entity whose move or lunge animation is still in flight
    const now = Date.now();
    const animatingIds = new Set(
      this._moveAnims
        .filter(a => now < a.startTime + a.duration)
        .map(a => a.entityId)
    );
    // Lunge anims suppress entity drawing for as long as the lunge is active (settled or not)
    for (const a of this._lungeAnims) animatingIds.add(a.entityId);

    // Pre-build spatial index: hexKey → entity[] (avoids O(entities²) filter)
    const entityByHex = new Map();
    for (const entity of state.entities) {
      if (!entity.alive) continue;
      if (animatingIds.has(entity.id)) continue;
      if (this.disambigHiddenIds?.has(entity.id)) continue;
      if (revealedHexes !== null) {
        const hOwner = humanIsHero ? 'witch' : 'hero';
        if (entity.owner === hOwner && !revealedHexes.has(hexKey(entity.col, entity.row))) continue;
      }
      const key = hexKey(entity.col, entity.row);
      const arr = entityByHex.get(key);
      if (arr) arr.push(entity); else entityByHex.set(key, [entity]);
    }

    for (const [key, stack] of entityByHex) {
      const [col, row] = key.split(',').map(Number);
      this._drawEntityStack(col, row, stack);
    }

    // Damage flash overlays (night/day hazard animations)
    this._drawFlashes(fogVisibleHexes);

    // Death burst / spawn sparkle rings
    this._drawDeathAnims(fogVisibleHexes);

    // Sliding entity icons for move animations (opponent moves / own moves)
    this._drawMoveAnims(fogVisibleHexes, hiddenOwner);

    // Lunge animations — attacker held at hex border during combat
    this._drawLungeAnims(fogVisibleHexes, hiddenOwner);

    // Plan ghost overlay — numbered arrows for move steps
    if (this.planGhostSteps?.length) {
      this._drawPlanOverlay(this.planGhostSteps);
    }

    // Arc menu connecting lines (under the ⊕ indicator)
    this._drawArcMenuLines();

    // AI debug overlay — only drawn when the debug panel is visible
    if (this.aiDebugOverlay && this._isAIDebugPanelVisible()) {
      this._drawAIDebugOverlay();
    }

    // ⊕ indicator at ghost position (falls back to real position outside planning mode)
    if (this.selectedEntityId) {
      const lastStep  = this.planGhostSteps?.at(-1);
      const ghostPos  = lastStep?.positions.get(this.selectedEntityId);
      const selEntity = ghostPos ? null
        : this.state.entities.find(e => e.id === this.selectedEntityId && e.alive);
      const pos = ghostPos ?? (selEntity ? { col: selEntity.col, row: selEntity.row } : null);
      if (pos) this._drawSelectionIndicator(pos.col, pos.row);
    }

    // Tutorial spotlight — pulsing gold ring on the target hex
    if (this.tutorialSpotlightHex) {
      this._drawTutorialSpotlight(this.tutorialSpotlightHex.col, this.tutorialSpotlightHex.row);
    }

    ctx.restore(); // end zoom/pan transform

  }

  _drawTutorialSpotlight(col, row) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    // Sine-wave pulse: alpha oscillates between 0.4 and 0.95 at ~1.5 Hz
    const pulse = 0.675 + 0.325 * Math.sin(Date.now() / 340);
    _traceHexPath(ctx, x, y, hs - 1);
    ctx.save();
    ctx.strokeStyle = `rgba(255,215,0,${pulse})`; // gold
    ctx.lineWidth   = 3.5;
    ctx.shadowColor = 'rgba(255,200,0,0.8)';
    ctx.shadowBlur  = 12;
    ctx.stroke();
    ctx.restore();
    // Drive the animation loop so the pulse redraws continuously
    this._startAnimLoop();
  }

  _drawFlashes(fogVisibleHexes = null) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const now = Date.now();
    this._flashes = this._flashes.filter(f => now < f.endTime);

    for (const f of this._flashes) {
      if (fogVisibleHexes !== null && !fogVisibleHexes.has(hexKey(f.col, f.row))) continue;
      const total = f.endTime - f.startTime;
      const remaining = f.endTime - now;
      const t = remaining / total; // 1.0 = just started, 0.0 = expired

      const { x, y } = this._toCanvas(f.col, f.row);

      // Red hex overlay (fades out)
      _traceHexPath(ctx, x, y, hs - 1);
      ctx.fillStyle = f.color.replace(/[\d.]+\)$/, `${(t * 0.55).toFixed(2)})`);
      ctx.fill();

      // Floating damage text (rises upward as it fades)
      if (f.text) {
        const rise = (1 - t) * hs * 1.4;
        const tc = f.textColor ?? 'rgba(255,120,120,1)';
        // Replace last alpha group in rgba(...) if present, otherwise append
        ctx.fillStyle = tc.replace(/,\s*[\d.]+\)$/, `, ${t.toFixed(2)})`);
        ctx.font         = `bold ${Math.floor(hs * (f.fontScale ?? 0.85))}px sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        this._shadowText(f.text, x, y - rise);
      }
    }
  }

  _drawDeathAnims(fogVisibleHexes = null) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const now = Date.now();
    this._deathAnims = this._deathAnims.filter(a => now < a.startTime + a.duration);
    for (const a of this._deathAnims) {
      if (fogVisibleHexes !== null && !fogVisibleHexes.has(hexKey(a.col, a.row))) continue;
      const t = (now - a.startTime) / a.duration; // 0→1
      const { x, y } = this._toCanvas(a.col, a.row);

      if (a.spawn) {
        // Sparkle: 6 small dots radiating outward
        const n = 6;
        for (let i = 0; i < n; i++) {
          const angle = (i / n) * Math.PI * 2;
          const dist  = t * hs * 0.85;
          const px    = x + Math.cos(angle) * dist;
          const py    = y + Math.sin(angle) * dist;
          const r     = hs * 0.08 * (1 - t);
          ctx.globalAlpha = (1 - t) * 0.85;
          ctx.beginPath();
          ctx.arc(px, py, r, 0, Math.PI * 2);
          ctx.fillStyle = a.color;
          ctx.fill();
        }
      } else {
        // Death burst: 2 expanding rings that fade out
        for (let ring = 0; ring < 2; ring++) {
          const rt = Math.min(1, t * 1.5 - ring * 0.3);
          if (rt < 0) continue;
          const radius = hs * 0.3 + rt * hs * 0.7;
          ctx.globalAlpha = (1 - rt) * 0.7;
          ctx.beginPath();
          ctx.arc(x, y, radius, 0, Math.PI * 2);
          ctx.strokeStyle = a.color;
          ctx.lineWidth   = hs * 0.08 * (1 - rt);
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;
    }
  }

  // ── Hex tile sprite cache ──────────────────────────────────────────────
  // Pre-renders each sprite variant clipped to a hex shape on an offscreen
  // canvas at a resolution that accounts for zoom level and devicePixelRatio.
  // Eliminates per-tile save/clip/drawImage/restore every frame.
  // Cache is invalidated when hexSize or effective zoom scale changes.

  _getHexTileSprite(spriteId, clipSize) {
    const hs = this.hexSize;
    // Quantise zoom to nearest 0.25× step so the cache isn't rebuilt on every
    // sub-pixel zoom change during pinch/scroll animations.
    const dpr = (typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1);
    const rawScale = Math.max(1, this.zoomLevel) * dpr;
    const scale = Math.ceil(rawScale * 4) / 4; // snap to 0.25 increments

    if (this._hexTileCacheSize !== hs || this._hexTileCacheScale !== scale) {
      this._hexTileCache.clear();
      this._hexTileCacheSize  = hs;
      this._hexTileCacheScale = scale;
    }
    const key = clipSize === hs ? spriteId : `${spriteId}@${clipSize}`;
    let cached = this._hexTileCache.get(key);
    if (cached) return cached;

    const rect = this._spriteRects?.get(spriteId);
    if (!rect || !this._tilemapImg) return null;

    // Render at scaled resolution for crisp output when zoomed in
    const logicalDim = hs * 2;
    const bufferDim  = Math.ceil(logicalDim * scale);
    const c = document.createElement('canvas');
    c.width = bufferDim; c.height = bufferDim;
    const tctx = c.getContext('2d');
    tctx.scale(scale, scale);
    _traceHexPath(tctx, hs, hs, clipSize);
    tctx.clip();
    tctx.drawImage(this._tilemapImg,
      rect.x, rect.y, rect.size, rect.size,
      0, 0, logicalDim, logicalDim);
    this._hexTileCache.set(key, c);
    return c;
  }

  _pickVariant(baseType, col, row) {
    const count = this._variantCounts?.get(baseType) ?? 0;
    if (count > 0) {
      const variant = ((col * 7 + row * 13 + col * row) % count) + 1;
      return `${baseType}_${variant}`;
    }
    return baseType;
  }

  _drawTile(col, row) {
    const ctx  = this.ctx;
    const hs   = this.hexSize;
    const tile = this.state.tiles.get(hexKey(col, row));
    if (!tile) return;

    const { x, y } = this._toCanvas(col, row);
    const tileImgs = this.useTileImages && this._tilemapImg;
    const fillSize = tileImgs ? hs - 0.5 : hs - 1;

    // Road and river tiles use a grass background — the actual road strips and
    // water ribbons are drawn in dedicated layers on top.
    const color = tile.type === TileType.BUILDING
      ? (BUILDING_COLOR[tile.building] || '#8a7a5a')
      : (tile.type === TileType.ROAD || tile.type === TileType.RIVER || tile.type === TileType.BRIDGE)
        ? TILE_COLOR[TileType.GRASS]
        : (TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS]);

    // Color fill — always drawn as base; skipped for buildings when tile
    // images are active (dirt sprite covers it).
    if (!(tile.type === TileType.BUILDING && tileImgs)) {
      _traceHexPath(ctx, x, y, fillSize);
      ctx.fillStyle = color;
      ctx.fill();
    }

    // Hex outline — only in classic colour-fill mode
    if (!tileImgs) {
      _traceHexPath(ctx, x, y, fillSize);
      ctx.strokeStyle = '#111418';
      ctx.lineWidth   = 0.8;
      ctx.stroke();
    }

    // ── Sprite image from tilemap (using pre-clipped cache) ──────────────
    if (TERRAIN_SPRITES[tile.type] && tileImgs) {
      const baseId = tile.type === TileType.BUILDING
        ? this._pickVariant(TileType.DIRT, col, row)
        : (tile.type === TileType.ROAD || tile.type === TileType.RIVER || tile.type === TileType.BRIDGE)
          ? this._pickVariant(TileType.GRASS, col, row)
          : this._pickVariant(tile.type, col, row);
      const clipSize = tile.type === TileType.BUILDING ? hs : fillSize;
      const cached = this._getHexTileSprite(baseId, clipSize);
      if (cached) {
        // cached buffer is rendered at higher resolution; draw it at logical size
        ctx.drawImage(cached, 0, 0, cached.width, cached.height,
          x - hs, y - hs, hs * 2, hs * 2);
      }
    }

    // Building image overlay — always drawn when tilemap is available
    if (tile.type === TileType.BUILDING && this._tilemapImg) {
      const bldgRect = this._spriteRects?.get(tile.building);
      if (bldgRect) {
        ctx.drawImage(this._tilemapImg,
          bldgRect.x, bldgRect.y, bldgRect.size, bldgRect.size,
          x - hs, y - hs, hs * 2, hs * 2);
      }
    }

    // Bridge tiles: only the water background is drawn here.
    // The water bezier and road strip are layered on top in _drawRiverLayer / _drawRoadLayer.
    if (tile.type === TileType.BRIDGE) return;

    // ── Fortification outline — tiered colour, outer glow, inner highlight ──
    if (tile.fortifyLevel > 0) {
      const lvl = tile.fortifyLevel;
      const fortPalette = [
        null,
        [160, 100,  55],   // 1 — amber/wood palisade
        [120, 135, 148],   // 2 — rough stone
        [180, 196, 210],   // 3 — dressed silver steel
        [205, 165,  35],   // 4 — iron-gilt ramparts
      ];
      const [fr, fg, fb] = fortPalette[Math.min(lvl, 4)];
      const alpha = Math.min(0.95, 0.5 + lvl * 0.12);
      const lw    = lvl * 2;

      _traceHexPath(ctx, x, y, fillSize);

      // Outer diffuse glow
      ctx.strokeStyle = `rgba(${fr},${fg},${fb},0.18)`;
      ctx.lineWidth   = lw + 5;
      ctx.stroke();

      // Main fort ring
      ctx.strokeStyle = `rgba(${fr},${fg},${fb},${alpha})`;
      ctx.lineWidth   = lw;
      ctx.stroke();

      // Inner highlight rim for level 2+ (lighter edge for depth)
      if (lvl >= 2) {
        _traceHexPath(ctx, x, y, hs - 1 - lw * 0.6);
        ctx.strokeStyle = `rgba(${Math.min(255, fr + 65)},${Math.min(255, fg + 65)},${Math.min(255, fb + 65)},0.45)`;
        ctx.lineWidth   = 1;
        ctx.stroke();
      }
    }


    // ── Building: icon + name ─────────────────────────────────────────────
    if (tile.type === TileType.BUILDING && tile.building) {
      const hasBuildingImg = !!this._spriteRects?.get(tile.building) && !!this._tilemapImg;

      // Show emoji icon only when there is no image (image provides the visual)
      if (!hasBuildingImg) {
        ctx.font         = `${Math.floor(hs * 0.55)}px serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        this._shadowText(BUILDING_ICON[tile.building] || '?', x, y - hs * 0.10);
      }

      ctx.fillStyle    = 'rgba(255,248,230,0.92)';
      ctx.font         = `bold ${Math.max(7, Math.floor(hs * 0.25))}px "Georgia", serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      this._shadowText(BUILDING_LABEL[tile.building] || tile.building, x, y + hs * 0.58);
    }
  }

  // Fog of war: draw a dark grey overlay on every hex NOT within the observer's
  // sight range. observerOwner is 'hero' or 'witch'.
  /** Returns the Set of hexKeys visible to observerOwner's units (used for fog culling). */
  _buildFogVisibleHexes(observerOwner) {
    const state = this.state;
    const visibleSet = new Set();
    for (const e of state.entities) {
      if (!e.alive || e.owner !== observerOwner) continue;
      const range = getFaction(e.owner).getSightRange(state.phase, e.ability === SurvivorAbility.SCOUT);
      // Only iterate hexes within sight range of this entity (not entire map)
      const rMin = Math.max(0, e.row - range);
      const rMax = Math.min(MAP_ROWS - 1, e.row + range);
      const cMin = Math.max(0, e.col - range);
      const cMax = Math.min(MAP_COLS - 1, e.col + range);
      for (let row = rMin; row <= rMax; row++) {
        for (let col = cMin; col <= cMax; col++) {
          if (hexDistance(col, row, e.col, e.row) <= range) {
            visibleSet.add(hexKey(col, row));
          }
        }
      }
    }
    return visibleSet;
  }

  _drawFogLayer(observerOwner, mode, sightSet, vr, fogKnownHexes) {
    const ctx   = this.ctx;
    const hs    = this.hexSize;
    const state = this.state;

    if (mode === 'partial') {
      // Original behavior: dim overlay outside sight range
      for (let row = vr.minRow; row <= vr.maxRow; row++) {
        for (let col = vr.minCol; col <= vr.maxCol; col++) {
          if (sightSet.has(hexKey(col, row))) continue;
          this._fillFogHex(col, row, hs, 'rgba(0,0,0,0.55)');
        }
      }
      return;
    }

    // Full fog: two tiers — bright (no overlay) / dimmed.
    // Unseen hexes are not rendered at all (terrain passes skip them),
    // so the dark canvas background shows through naturally.
    for (let row = vr.minRow; row <= vr.maxRow; row++) {
      for (let col = vr.minCol; col <= vr.maxCol; col++) {
        const k = hexKey(col, row);
        if (sightSet.has(k)) continue; // bright — no overlay
        if (fogKnownHexes && !fogKnownHexes.has(k)) continue; // unseen — not rendered
        // Dimmed — terrain visible but darkened (explored / movement range)
        this._fillFogHex(col, row, hs, 'rgba(0,0,0,0.55)');
      }
    }
  }

  _fillFogHex(col, row, hs, color) {
    const { x, y } = this._toCanvas(col, row);
    _traceHexPath(this.ctx, x, y, hs);
    this.ctx.fillStyle = color;
    this.ctx.fill();
  }

  // Thick coloured outlines on hexes occupied by units — colour matches the
  // entity's per-player colour so each player's territory is visually distinct.
  _drawUnitPresenceOutlines(revealedHexes) {
    const state = this.state;
    const myFaction    = state.myFaction;
    const humanIsHero  = myFaction ? myFaction === 'hero'  : (state.witchIsAI && !state.heroIsAI);
    const humanIsWitch = myFaction ? myFaction === 'witch' : (state.heroIsAI  && !state.witchIsAI);

    // Map hexKey → outline colour of the first (highest-priority) entity on that hex.
    // Leaders are pushed to entities before followers so they win ties naturally.
    const hexColors = new Map();

    for (const e of state.entities) {
      if (!e.alive) continue;
      const k = hexKey(e.col, e.row);

      // Fog filtering — same rules as before
      if (e.owner === 'hero'  && humanIsWitch && revealedHexes && !revealedHexes.has(k)) continue;
      if (e.owner === 'witch' && humanIsHero  && revealedHexes && !revealedHexes.has(k)) continue;

      if (!hexColors.has(k)) {
        // Hex outline always shows the faction colour so every unit on a hex
        // reads as belonging to that side regardless of unit type.
        // In multiplayer (2v2+) use the per-player colour from playerColorMap;
        // in 1v1/offline fall back to the faction leader colour.
        const playerColor = e.ownerId ? this._playerColorMap.get(e.ownerId) : null;
        const factionColor = e.owner === 'hero'
          ? ENTITY_COLOR[EntityType.HERO]
          : ENTITY_COLOR[EntityType.WITCH];
        hexColors.set(k, playerColor ?? factionColor);
      }
    }

    const selKey = this.selectedHex
      ? hexKey(this.selectedHex.col, this.selectedHex.row)
      : null;
    for (const [k, color] of hexColors) {
      const [col, row] = k.split(',').map(Number);
      // Skip the selected hex here — the main render loop draws a separate,
      // glowing selected-hex outline on top that would otherwise fight with
      // this one. Keep ownership outlines flat (no glow) and semi-transparent
      // so they're informative without being visually overbearing.
      if (k === selKey) continue;
      this._drawOutline(col, row, _hexToRgba(color, 0.55), 2, false);
    }
  }

  // Draw the river as smooth bezier flows through each RIVER and BRIDGE tile.
  // Endpoints (row 0 / row MAP_ROWS-1) extend their bezier off-screen so the
  // river appears to flow in from and out to the edge of the map.
  _drawRiverLayer(fogKnownHexes) {
    const ctx     = this.ctx;
    const tiles   = this.state.tiles;
    const hs      = this.hexSize;
    const apothem = hs * SQRT3 / 2;

    const isWater = t => t && (t.type === TileType.RIVER || t.type === TileType.BRIDGE);

    ctx.strokeStyle = TILE_COLOR[TileType.RIVER];
    ctx.lineWidth   = hs * 0.52;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';

    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        if (fogKnownHexes && !fogKnownHexes.has(hexKey(col, row))) continue;
        const tile = tiles.get(hexKey(col, row));
        // Bridges handle their own water+road layering in _drawRoadLayer
        if (!tile || tile.type !== TileType.RIVER) continue;

        const { x, y } = this._toCanvas(col, row);
        const riverNbrs = getNeighbors(col, row).filter(n => isWater(tiles.get(hexKey(n.col, n.row))));

        // Build edge midpoints toward each river/bridge neighbour
        const edgeMids = riverNbrs.map(n => {
          const { x: nx, y: ny } = this._toCanvas(n.col, n.row);
          const dx = nx - x, dy = ny - y;
          const d  = Math.sqrt(dx * dx + dy * dy);
          return { x: x + dx / d * apothem, y: y + dy / d * apothem };
        });

        ctx.beginPath();
        if (riverNbrs.length >= 2) {
          // Two river neighbours: smooth bezier entry → center → exit
          ctx.moveTo(edgeMids[0].x, edgeMids[0].y);
          ctx.quadraticCurveTo(x, y, edgeMids[1].x, edgeMids[1].y);
        } else if (riverNbrs.length === 1) {
          // Endpoint tile: extend bezier off-screen in the upstream/downstream direction
          const { x: nx, y: ny } = this._toCanvas(riverNbrs[0].col, riverNbrs[0].row);
          const dx = nx - x, dy = ny - y;
          const d  = Math.sqrt(dx * dx + dy * dy);
          // Cap at the far edge of this hex (don't extend beyond the map)
          const offX = x - (dx / d) * apothem;
          const offY = y - (dy / d) * apothem;
          ctx.moveTo(offX, offY);
          ctx.quadraticCurveTo(x, y, edgeMids[0].x, edgeMids[0].y);
        } else {
          continue; // isolated water tile — skip
        }
        ctx.stroke();
      }
    }

    ctx.lineCap  = 'butt';
    ctx.lineJoin = 'miter';
  }

  // Draw road strips as directional paths on ROAD and BRIDGE tiles.
  // Roads connect to road/bridge/building neighbours, capped at 3 connections
  // (T-junction max).  Bridges additionally draw railing lines over the water.
  _drawRoadLayer(fogKnownHexes) {
    const ctx     = this.ctx;
    const tiles   = this.state.tiles;
    const hs      = this.hexSize;
    const apothem = hs * SQRT3 / 2;

    const isRoadLike = t => t && (
      t.type === TileType.ROAD || t.type === TileType.BRIDGE || t.type === TileType.BUILDING
    );

    ctx.lineCap = 'round';

    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        if (fogKnownHexes && !fogKnownHexes.has(hexKey(col, row))) continue;
        const tile = tiles.get(hexKey(col, row));
        if (!tile || (tile.type !== TileType.ROAD && tile.type !== TileType.BRIDGE)) continue;

        // Reset per-tile so bridge water/railing state changes never bleed through
        ctx.lineWidth   = hs * 0.42;
        ctx.strokeStyle = TILE_COLOR[TileType.ROAD];

        const { x, y } = this._toCanvas(col, row);
        // Use explicit roadDirs recorded at generation time rather than
        // inferring from adjacent tile types — prevents phantom junctions.
        const roadNbrs = [...tile.roadDirs].map(k => tiles.get(k)).filter(Boolean);
        if (roadNbrs.length === 0) continue;

        const edgeMids = roadNbrs.map(n => {
          const { x: nx, y: ny } = this._toCanvas(n.col, n.row);
          const dx = nx - x, dy = ny - y;
          const d  = Math.sqrt(dx * dx + dy * dy);
          return { x: x + dx / d * apothem, y: y + dy / d * apothem };
        });

        // ── Bridge: draw water bezier first, then road on top ─────────────
        if (tile.type === TileType.BRIDGE) {
          const isWater = t => t && (t.type === TileType.RIVER || t.type === TileType.BRIDGE);
          const waterNbrs = getNeighbors(col, row).filter(n => isWater(tiles.get(hexKey(n.col, n.row))));
          if (waterNbrs.length >= 1) {
            const wEdge = waterNbrs.map(n => {
              const { x: nx, y: ny } = this._toCanvas(n.col, n.row);
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
              // single water neighbour — extend bezier off-screen on the other side
              const { x: nx, y: ny } = this._toCanvas(waterNbrs[0].col, waterNbrs[0].row);
              const dx = nx - x, dy = ny - y, d = Math.sqrt(dx * dx + dy * dy);
              ctx.moveTo(x - (dx / d) * apothem * 2, y - (dy / d) * apothem * 2);
              ctx.quadraticCurveTo(x, y, wEdge[0].x, wEdge[0].y);
            }
            ctx.stroke();
          }
          // Restore road colour + width after the water bezier
          ctx.strokeStyle = TILE_COLOR[TileType.ROAD];
          ctx.lineWidth   = hs * 0.42;
        }

        // ── For bridges, select the primary crossing pair ─────────────────
        // The crossing pair is the road exits most perpendicular to the
        // river flow (inferred from water neighbour directions).
        let primaryA = 0, primaryB = Math.min(1, edgeMids.length - 1);
        if (tile.type === TileType.BRIDGE && edgeMids.length >= 2) {
          const bWaterNbrs = getNeighbors(col, row).filter(n => {
            const t = tiles.get(hexKey(n.col, n.row));
            return t && (t.type === TileType.RIVER || t.type === TileType.BRIDGE);
          });
          const edgeDirs = edgeMids.map(em => {
            const dx = em.x - x, dy = em.y - y;
            const d = Math.sqrt(dx * dx + dy * dy) || 1;
            return { dx: dx / d, dy: dy / d };
          });
          if (bWaterNbrs.length >= 1) {
            let wdx = 0, wdy = 0;
            for (const wn of bWaterNbrs) {
              const { x: wx, y: wy } = this._toCanvas(wn.col, wn.row);
              wdx += wx - x; wdy += wy - y;
            }
            const wl = Math.sqrt(wdx * wdx + wdy * wdy) || 1;
            wdx /= wl; wdy /= wl;
            // Pick pair most perpendicular to water (highest |cross product|)
            let best = -Infinity;
            for (let i = 0; i < edgeDirs.length; i++) {
              for (let j = i + 1; j < edgeDirs.length; j++) {
                const s = Math.abs(edgeDirs[i].dx * wdy - edgeDirs[i].dy * wdx)
                        + Math.abs(edgeDirs[j].dx * wdy - edgeDirs[j].dy * wdx);
                if (s > best) { best = s; primaryA = i; primaryB = j; }
              }
            }
          } else {
            // No water neighbours — fall back to most-opposing pair
            let minDot = Infinity;
            for (let i = 0; i < edgeDirs.length; i++) {
              for (let j = i + 1; j < edgeDirs.length; j++) {
                const dot = edgeDirs[i].dx * edgeDirs[j].dx + edgeDirs[i].dy * edgeDirs[j].dy;
                if (dot < minDot) { minDot = dot; primaryA = i; primaryB = j; }
              }
            }
          }
        }

        // ── Road strip ────────────────────────────────────────────────────
        if (tile.type === TileType.BRIDGE && edgeMids.length >= 2) {
          // Bridge: draw crossing bezier along the primary pair, spokes for branches
          ctx.beginPath();
          ctx.moveTo(edgeMids[primaryA].x, edgeMids[primaryA].y);
          ctx.quadraticCurveTo(x, y, edgeMids[primaryB].x, edgeMids[primaryB].y);
          ctx.stroke();
          for (let i = 0; i < edgeMids.length; i++) {
            if (i === primaryA || i === primaryB) continue;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(edgeMids[i].x, edgeMids[i].y);
            ctx.stroke();
          }
        } else if (roadNbrs.length === 2) {
          // Smooth bezier through-road
          ctx.beginPath();
          ctx.moveTo(edgeMids[0].x, edgeMids[0].y);
          ctx.quadraticCurveTo(x, y, edgeMids[1].x, edgeMids[1].y);
          ctx.stroke();
        } else if (roadNbrs.length === 1) {
          // Dead-end stub toward building entrance
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(edgeMids[0].x, edgeMids[0].y);
          ctx.stroke();
        } else {
          // Junction (3+): bezier for the most-opposing pair, spokes for branches
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

        // ── Bridge railings (bezier curves matching the crossing pair) ─────
        if (tile.type === TileType.BRIDGE && edgeMids.length >= 2) {
          const em0 = edgeMids[primaryA], em1 = edgeMids[primaryB];
          // Perpendicular offset based on overall road direction
          const dx = em1.x - em0.x, dy = em1.y - em0.y;
          const len = Math.sqrt(dx * dx + dy * dy);
          const perpX = (-dy / len) * hs * 0.18;
          const perpY = ( dx / len) * hs * 0.18;
          ctx.strokeStyle = '#8a7a5a';
          ctx.lineWidth   = Math.max(1, hs * 0.06);
          for (const sign of [-1, 1]) {
            ctx.beginPath();
            // Offset start, control (hex centre), and end by the same perp vector
            ctx.moveTo(em0.x + perpX * sign, em0.y + perpY * sign);
            ctx.quadraticCurveTo(
              x   + perpX * sign, y   + perpY * sign,
              em1.x + perpX * sign, em1.y + perpY * sign,
            );
            ctx.stroke();
          }
          // Restore road lineWidth for subsequent tiles
          ctx.lineWidth = hs * 0.42;
        }
      }
    }

    ctx.lineCap = 'butt';
  }

  // Decorative border frame drawn in canvas coordinates (outside the zoom transform).

  _drawObjectiveHexGlow(col, row, obj, state) {
    const ctrl = nodeController(obj, state.entities);
    const nodeColor = obj.color ?? '#8800cc';
    // Faction-tinted overlay
    const factionOverlay =
      ctrl === 'contested' ? 'rgba(200,140,0,0.18)' :
      (ctrl !== 'neutral'  ? getFactionTheme(ctrl).nodeFill : null);
    const { x, y } = this._toCanvas(col, row);
    const hs = this.hexSize;
    const ctx = this.ctx;
    _traceHexPath(ctx, x, y, hs - 1);
    // Node color base fill (~20% opacity)
    ctx.fillStyle = nodeColor + '33';
    ctx.fill();
    // Faction overlay on controlled/contested hexes
    if (factionOverlay) {
      _traceHexPath(ctx, x, y, hs - 1);
      ctx.fillStyle = factionOverlay;
      ctx.fill();
    }
    // Border ring in node color (~53% opacity)
    ctx.strokeStyle = nodeColor + '88';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  /** @deprecated Use _drawObjectiveSymbolAt instead */
  _drawObjectiveSymbol(col, row, label, state) {
    const { x, y } = this._toCanvas(col, row);
    const obj = state.witchObjectives.find(o => o.col === col && o.row === row);
    this._drawObjectiveSymbolAt(x, y, label, state, obj);
  }

  _drawObjectiveSymbolAt(x, y, label, state, obj) {
    const ctx = this.ctx;
    const hs  = this.hexSize;

    const ctrl = obj ? nodeController(obj, state.entities) : 'neutral';
    const nodeColor = obj?.color ?? 'rgba(180,0,255,0.7)';

    // Symbol uses node color; faction glow tints the outline
    const glowColor =
      ctrl === 'contested' ? '#ffaa00' :
      ctrl === 'neutral'   ? nodeColor :
                             getFactionTheme(ctrl).highlight;

    ctx.shadowColor = glowColor;
    ctx.shadowBlur  = ctrl === 'neutral' ? 4 : 8;
    ctx.fillStyle    = nodeColor;
    ctx.font         = `bold ${Math.floor(hs * 0.5)}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    this._shadowText('⛧', x, y - hs * 0.15);
    ctx.shadowBlur = 0;

    ctx.fillStyle = nodeColor + 'cc';
    ctx.font      = `${Math.max(6, Math.floor(hs * 0.2))}px sans-serif`;
    this._shadowText(label, x, y + hs * 0.35);
  }

  /** Draw a flag symbol for a mission target hex (reach_hex objective). */
  _drawMissionTargetSymbol(x, y, mt) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    ctx.shadowColor = mt.color;
    ctx.shadowBlur  = 6;
    ctx.fillStyle   = mt.color;
    ctx.font        = `bold ${Math.floor(hs * 0.5)}px serif`;
    ctx.textAlign   = 'center';
    ctx.textBaseline = 'middle';
    this._shadowText('⚑', x, y - hs * 0.15);
    ctx.shadowBlur = 0;
    ctx.fillStyle  = mt.color + 'cc';
    ctx.font       = `${Math.max(6, Math.floor(hs * 0.2))}px sans-serif`;
    this._shadowText(mt.label, x, y + hs * 0.35);
  }

  /** Draw pulsing glow rings on recently revealed power nodes. */
  _drawNodeRevealAnims() {
    const now = Date.now();
    this._nodeRevealAnims = this._nodeRevealAnims.filter(a => now < a.startTime + a.duration);
    if (!this._nodeRevealAnims.length) return;

    const ctx = this.ctx;
    const hs  = this.hexSize;

    for (const anim of this._nodeRevealAnims) {
      const elapsed = now - anim.startTime;
      const t = elapsed / anim.duration; // 0→1

      // Expanding ring radius: starts at hex size, expands to radiusMultiplier × hex size
      const maxR = anim.radiusMultiplier ?? 2;
      const ringRadius = hs * (1.0 + t * (maxR - 1.0));
      // Opacity: bright at start, fades out
      const alpha = Math.max(0, 1.0 - t);
      // Pulsing inner glow: rapid sine pulse that slows over time
      const pulse = 0.5 + 0.5 * Math.sin(elapsed / 120);
      const innerAlpha = alpha * (0.3 + 0.3 * pulse);

      for (const h of anim.hexes) {
        const { x, y } = this._toCanvas(h.col, h.row);

        // Inner hex glow fill
        _traceHexPath(ctx, x, y, hs - 1);
        ctx.fillStyle = anim.color + _alphaHex(innerAlpha);
        ctx.fill();

        // Expanding ring
        ctx.beginPath();
        ctx.arc(x, y, ringRadius, 0, Math.PI * 2);
        ctx.strokeStyle = anim.color + _alphaHex(alpha * 0.6);
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }
    }
    this._startAnimLoop();
  }

  _drawHighlight(col, row, color) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    _traceHexPath(ctx, x, y, hs - 1);
    ctx.fillStyle = color;
    ctx.fill();

    // Crisp border ring at full saturation
    const rgba = _parseColor(color);
    if (rgba) {
      const [r, g, b, a] = rgba;
      ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(1, a * 4)})`;
    } else {
      ctx.strokeStyle = color.replace(/,\s*[\d.]+\)$/, ', 0.9)');
    }
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  _drawOutline(col, row, color, lineWidth = 2, glow = false) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);

    if (glow) {
      const rgba = _parseColor(color);
      if (rgba) {
        const [r, g, b] = rgba;
        _traceHexPath(ctx, x, y, hs - 1.5);
        // Outer soft halo
        ctx.strokeStyle = `rgba(${r},${g},${b},0.12)`;
        ctx.lineWidth   = lineWidth + 7;
        ctx.stroke();
        // Mid glow ring
        ctx.strokeStyle = `rgba(${r},${g},${b},0.28)`;
        ctx.lineWidth   = lineWidth + 3;
        ctx.stroke();
      }
    }

    _traceHexPath(ctx, x, y, hs - 1.5);
    ctx.strokeStyle = color;
    ctx.lineWidth   = lineWidth;
    ctx.stroke();

    // Specular: thin bright stroke on the upper two edges (top-lit bevel)
    // Corners 5→0→1 are the naturally lit faces of a pointy-top hex.
    const corners = _cachedHexCorners(x, y, hs - 1.5);
    ctx.beginPath();
    ctx.moveTo(corners[5].x, corners[5].y);
    ctx.lineTo(corners[0].x, corners[0].y);
    ctx.lineTo(corners[1].x, corners[1].y);
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth   = Math.max(0.5, lineWidth * 0.45);
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.lineCap     = 'butt';
  }

  _drawEntityStack(col, row, stack) {
    const ctx    = this.ctx;
    const hs     = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    // Larger portrait radius when a single unit occupies the hex
    const r      = stack.length === 1 ? hs * 0.42 : hs * 0.32;
    const max    = Math.min(stack.length, 3);

    for (let i = 0; i < max; i++) {
      const entity  = stack[i];
      const offsets = stackOffset(i, max);
      const ex = x + offsets.x * (hs / 30);
      const ey = y + offsets.y * (hs / 30);

      // Apply fade-out opacity for dying entities
      const fadeOpacity = this.getFadeOutOpacity(entity.id);
      if (fadeOpacity <= 0) continue; // fully faded — skip drawing
      const fading = fadeOpacity < 1;
      if (fading) { ctx.save(); ctx.globalAlpha = fadeOpacity; }

      // Drop shadow — offset slightly for lift effect
      ctx.beginPath();
      ctx.arc(ex + 2, ey + 2, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();

      // Base fill with radial gradient: highlight top-left, dark bottom-right
      const baseCol  = entity.color ?? ENTITY_COLOR[entity.type];
      const baseRgba = _parseColor(baseCol);
      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      if (baseRgba) {
        const [cr, cg, cb] = baseRgba;
        const grad = ctx.createRadialGradient(ex - r * 0.3, ey - r * 0.35, r * 0.05,
                                               ex + r * 0.1, ey + r * 0.15, r);
        grad.addColorStop(0,    `rgb(${Math.min(255, cr + 70)},${Math.min(255, cg + 65)},${Math.min(255, cb + 55)})`);
        grad.addColorStop(0.45, `rgb(${cr},${cg},${cb})`);
        grad.addColorStop(1,    `rgb(${Math.max(0, cr - 45)},${Math.max(0, cg - 45)},${Math.max(0, cb - 45)})`);
        ctx.fillStyle = grad;
      } else {
        ctx.fillStyle = baseCol;
      }
      ctx.fill();

      // ── Portrait image from sprite sheet ───────────────────────────────
      const portraitKey = entity.type === EntityType.SURVIVOR
        ? Renderer.survivorAssetId(entity.title)
        : entity.type; // 'hero', 'witch', 'zombie', etc.

      const pRect = portraitKey ? this._spriteRects?.get(portraitKey) : null;
      const portrait = pRect && this._tilemapImg;
      if (portrait) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(ex, ey, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(this._tilemapImg,
          pRect.x, pRect.y, pRect.size, pRect.size,
          ex - r, ey - r, r * 2, r * 2);
        // Vignette overlay: darken portrait edges for depth
        const vGrad = ctx.createRadialGradient(ex, ey, r * 0.4, ex, ey, r);
        vGrad.addColorStop(0, 'rgba(0,0,0,0)');
        vGrad.addColorStop(1, 'rgba(0,0,0,0.42)');
        ctx.fillStyle = vGrad;
        ctx.fill();
        ctx.restore();
      }

      // Circle border: coloured glow ring + crisp inner border + specular arc
      const entityCol  = entity.color ?? ENTITY_COLOR[entity.type];
      const borderRgba = _parseColor(entityCol);
      if (borderRgba) {
        const [br, bg, bb] = borderRgba;
        ctx.beginPath();
        ctx.arc(ex, ey, r + 1.5, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${br},${bg},${bb},0.4)`;
        ctx.lineWidth   = 3;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(ex, ey, r, 0, Math.PI * 2);
      ctx.strokeStyle = portrait ? _hexToRgba(entityCol, 0.9) : 'rgba(255,255,255,0.7)';
      ctx.lineWidth   = portrait ? 2 : 1.5;
      ctx.stroke();
      // Specular highlight arc — top-left quadrant
      ctx.beginPath();
      ctx.arc(ex, ey, r * 0.8, Math.PI * 1.1, Math.PI * 1.65);
      ctx.strokeStyle = 'rgba(255,255,255,0.3)';
      ctx.lineWidth   = r * 0.22;
      ctx.lineCap     = 'round';
      ctx.stroke();
      ctx.lineCap     = 'butt';

      // Draw glyph only when no portrait image is available
      if (!portrait) {
        ctx.fillStyle    = '#ffffffdd';
        ctx.font         = `bold ${Math.floor(r * 1.1)}px serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        this._shadowText(entityGlyph(entity.type), ex, ey + 1);
      }

      if (entity.type === EntityType.HERO || entity.type === EntityType.WITCH ||
          entity.type === EntityType.SURVIVOR || entity.type === EntityType.WOOD_GOLEM ||
          entity.type === EntityType.IRON_GOLEM) {
        const barW = r * 2;
        const barH = Math.max(2, hs * 0.08);
        const bx   = ex - r;
        const by   = ey + r + 2;
        // Background trough with shadow
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(bx - 1, by - 1, barW + 2, barH + 2);
        ctx.fillStyle = '#1a1a1a';
        ctx.fillRect(bx, by, barW, barH);
        // Gradient fill: lighter top edge, base colour bottom
        const pct = entity.hp / entity.maxHp;
        const hpRgb = pct > 0.5 ? [76, 175, 80] : pct > 0.25 ? [255, 152, 0] : [244, 67, 54];
        const barFill = ctx.createLinearGradient(bx, by, bx, by + barH);
        barFill.addColorStop(0, `rgba(${Math.min(255, hpRgb[0] + 45)},${Math.min(255, hpRgb[1] + 45)},${Math.min(255, hpRgb[2] + 45)},1)`);
        barFill.addColorStop(1, `rgba(${hpRgb[0]},${hpRgb[1]},${hpRgb[2]},1)`);
        ctx.fillStyle = barFill;
        ctx.fillRect(bx, by, barW * pct, barH);
        // Shine stripe along the top
        ctx.fillStyle = 'rgba(255,255,255,0.18)';
        ctx.fillRect(bx, by, barW * pct, Math.max(1, barH * 0.4));
      }

      // Guard stance indicator — small shield badge at bottom-right
      if (entity.guarding > 0) {
        const br = Math.max(5, hs * 0.13);
        const bx = ex + r - br * 0.3;
        const by = ey + r - br * 0.3;
        // Background circle
        ctx.beginPath();
        ctx.arc(bx, by, br, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(230,160,60,0.9)';
        ctx.fill();
        ctx.strokeStyle = '#fff';
        ctx.lineWidth = 1;
        ctx.stroke();
        // Charge number
        ctx.fillStyle = '#fff';
        ctx.font = `bold ${Math.max(7, Math.floor(br * 1.3))}px monospace`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(entity.guarding), bx, by + 0.5);
      }

      if (fading) ctx.restore();
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

    // ⊕ indicator is now drawn in draw() at the ghost position — removed from here.
  }

  /** Draw the ⊕ action-hint indicator centered over a hex position. */
  _drawSelectionIndicator(col, row) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const ir = Math.max(6, hs * 0.22);

    // Draw centered over the unit
    const ix = x;
    const iy = y;

    // Semi-transparent disc overlay
    ctx.beginPath();
    ctx.arc(ix, iy, ir, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.28)';
    ctx.fill();

    // Thin border
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    // + glyph
    ctx.fillStyle    = 'rgba(255,255,255,0.75)';
    ctx.font         = `bold ${Math.floor(ir * 1.3)}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+', ix, iy + 0.5);
  }

  /**
   * Draw connecting lines from hex center to arc menu item positions.
   * Called during draw() when arcMenuLines is set.
   */
  _drawArcMenuLines() {
    if (!this.arcMenuLines) return;
    const ctx = this.ctx;
    const { col, row, items } = this.arcMenuLines;
    const { x: cx, y: cy } = this._toCanvas(col, row);

    ctx.save();
    ctx.lineCap = 'round';
    for (const item of items) {
      // item.x, item.y are offsets in screen px from the hex center;
      // convert to canvas units by dividing by zoomLevel
      const tx = cx + item.x / this.zoomLevel;
      const ty = cy + item.y / this.zoomLevel;

      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(tx, ty);
      ctx.strokeStyle = item.color ? item.color + '50' : 'rgba(180,170,210,0.3)';
      ctx.lineWidth   = 1.5;
      ctx.stroke();

      // Small dot at the end
      ctx.beginPath();
      ctx.arc(tx, ty, 1.5, 0, Math.PI * 2);
      ctx.fillStyle = item.color ? item.color + '88' : 'rgba(180,170,210,0.5)';
      ctx.fill();
    }
    ctx.restore();
  }

  /** Draw plan ghost overlay: ghost entities, summon icons, move arrows, attack arrows. */
  _drawPlanOverlay(ghostSteps) {
    const ctx = this.ctx;
    const hs  = this.hexSize;

    ctx.save();
    ctx.lineCap  = 'round';
    ctx.lineJoin = 'round';

    // ── Layer 1: Ghost entity circles at move destinations ───────────────────
    const moveSteps = ghostSteps.filter(s => s.arrow !== null);
    for (const step of moveSteps) {
      const arrow = step.arrow;
      const to    = this._toCanvas(arrow.toCol, arrow.toRow);
      const r     = hs * 0.32;

      // Find entity type/owner for color
      const entityId = arrow.entityId;
      // Look up entity from last step positions where it was moved
      let entityType  = null;
      let entityOwner = null;
      for (const e of (this.state?.entities ?? [])) {
        if (e.id === entityId) { entityType = e.type; entityOwner = e.owner; break; }
      }
      const entityObj = this.state?.entities.find(e => e.id === entityId);
      const color = entityObj?.color ?? ENTITY_COLOR[entityType] ?? getFactionTheme(entityOwner).primary;

      ctx.globalAlpha = 0.4;
      ctx.beginPath();
      ctx.arc(to.x, to.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (entityType) {
        ctx.globalAlpha = 0.55;
        ctx.fillStyle   = '#fff';
        ctx.font        = `${Math.floor(r * 1.1)}px sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(entityGlyph(entityType), to.x, to.y + 1);
      }
      ctx.globalAlpha = 1;
    }

    // ── Layer 2: Translucent summon icons at summon hexes ────────────────────
    for (const step of ghostSteps) {
      if (!step.summonInfo) continue;
      const { col, row, type } = step.summonInfo;
      const center = this._toCanvas(col, row);
      const r      = hs * 0.32;
      const color  = ENTITY_COLOR[type] ?? '#c0392b';

      ctx.globalAlpha = 0.45;
      ctx.beginPath();
      ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      ctx.setLineDash([3, 3]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.globalAlpha = 0.6;
      ctx.fillStyle   = '#fff';
      ctx.font        = `${Math.floor(r * 1.1)}px sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(entityGlyph(type), center.x, center.y + 1);
      ctx.globalAlpha = 1;
    }

    // ── Layer 3: Coloured move arrows with step badges ───────────────────────
    moveSteps.forEach((step, i) => {
      const arrow  = step.arrow;
      const ob     = step.overBudget;

      // Use the entity's own colour (survivors have distinct colours).
      const arrowEntity = this.state?.entities.find(e => e.id === arrow.entityId);
      const baseColor   = arrowEntity?.color ?? ENTITY_COLOR[arrowEntity?.type] ?? '#f5c842';

      // Helper: parse a hex color and return rgba string with given alpha.
      const rgba = (hex, a) => {
        const r = parseInt(hex.slice(1,3),16);
        const g = parseInt(hex.slice(3,5),16);
        const b = parseInt(hex.slice(5,7),16);
        return `rgba(${r},${g},${b},${a})`;
      };

      const from = this._toCanvas(arrow.fromCol, arrow.fromRow);
      const to   = this._toCanvas(arrow.toCol,   arrow.toRow);

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) return;
      const ux = dx / len;
      const uy = dy / len;

      const startX = from.x + ux * hs * 0.35;
      const startY = from.y + uy * hs * 0.35;
      const endX   = to.x   - ux * hs * 0.45;
      const endY   = to.y   - uy * hs * 0.45;

      ctx.strokeStyle = ob ? 'rgba(140,140,140,0.45)' : rgba(baseColor, 0.75);
      ctx.lineWidth   = ob ? 1.5 : 2;
      ctx.setLineDash(ob ? [3, 6] : [4, 4]);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX,   endY);
      ctx.stroke();
      ctx.setLineDash([]);

      const headLen = hs * 0.22;
      const angle   = Math.atan2(dy, dx);
      ctx.strokeStyle = ob ? 'rgba(140,140,140,0.55)' : rgba(baseColor, 0.9);
      ctx.lineWidth   = ob ? 1.5 : 2;
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - headLen * Math.cos(angle - 0.4), endY - headLen * Math.sin(angle - 0.4));
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - headLen * Math.cos(angle + 0.4), endY - headLen * Math.sin(angle + 0.4));
      ctx.stroke();

      const num    = arrow.stepNumber ?? (i + 1);
      const badgeR = hs * 0.22;
      ctx.beginPath();
      ctx.arc(to.x, to.y, badgeR, 0, Math.PI * 2);
      ctx.fillStyle = ob ? 'rgba(60,60,60,0.80)' : rgba(baseColor, 0.85);
      ctx.fill();
      ctx.fillStyle    = ob ? 'rgba(180,80,80,0.95)' : '#111';
      ctx.font         = `bold ${Math.floor(badgeR * 1.1)}px sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ob ? '✕' : String(num), to.x, to.y + 0.5);
    });

    // ── Layer 4: Red attack arrows with ×N badge ─────────────────────────────
    // Count attacks per target hex key for badge.
    const attackCounts = new Map(); // "col,row" → count
    for (const step of ghostSteps) {
      if (!step.attackArrow) continue;
      const key = `${step.attackArrow.toCol},${step.attackArrow.toRow}`;
      attackCounts.set(key, (attackCounts.get(key) ?? 0) + 1);
    }

    const drawnBadges = new Set();
    for (const step of ghostSteps) {
      if (!step.attackArrow) continue;
      const aa   = step.attackArrow;
      const from = this._toCanvas(aa.fromCol, aa.fromRow);
      const to   = this._toCanvas(aa.toCol,   aa.toRow);

      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const len = Math.hypot(dx, dy);
      if (len < 1) continue;
      const ux = dx / len;
      const uy = dy / len;

      const startX = from.x + ux * hs * 0.38;
      const startY = from.y + uy * hs * 0.38;
      const endX   = to.x   - ux * hs * 0.45;
      const endY   = to.y   - uy * hs * 0.45;

      ctx.strokeStyle = 'rgba(220,60,60,0.80)';
      ctx.lineWidth   = 2;
      ctx.setLineDash([3, 4]);
      ctx.beginPath();
      ctx.moveTo(startX, startY);
      ctx.lineTo(endX,   endY);
      ctx.stroke();
      ctx.setLineDash([]);

      const headLen = hs * 0.20;
      const angle   = Math.atan2(dy, dx);
      ctx.strokeStyle = 'rgba(220,60,60,0.90)';
      ctx.lineWidth   = 2;
      ctx.beginPath();
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - headLen * Math.cos(angle - 0.4), endY - headLen * Math.sin(angle - 0.4));
      ctx.moveTo(endX, endY);
      ctx.lineTo(endX - headLen * Math.cos(angle + 0.4), endY - headLen * Math.sin(angle + 0.4));
      ctx.stroke();

      // Badge at target hex (draw once per unique target)
      const badgeKey = `${aa.toCol},${aa.toRow}`;
      if (!drawnBadges.has(badgeKey)) {
        drawnBadges.add(badgeKey);
        const count  = attackCounts.get(badgeKey) ?? 1;
        const label  = count > 1 ? `×${count}` : '⚔';
        const badgeR = hs * 0.24;
        const bx     = to.x + hs * 0.28;
        const by     = to.y - hs * 0.28;
        ctx.beginPath();
        ctx.arc(bx, by, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(180,30,30,0.85)';
        ctx.fill();
        ctx.fillStyle    = '#fff';
        ctx.font         = `bold ${Math.floor(badgeR * (count > 1 ? 0.9 : 1.1))}px sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, bx, by + 0.5);
      }
    }

    ctx.restore();
  }

  // ── AI Debug Overlay ────────────────────────────────────────────────────────
  // Renders hex goal tints, node feasibility badges, combat estimates,
  // and unit goal labels when the AI debugger is active.

  /** Returns true when the AI debug DOM panel is visible (not hidden or collapsed). */
  _isAIDebugPanelVisible() {
    const panel = document.getElementById('ai-debug-panel');
    return panel && panel.style.display !== 'none' && !panel.classList.contains('collapsed');
  }

  _drawAIDebugOverlay() {
    const overlay = this.aiDebugOverlay;
    if (!overlay) return;

    const ctx   = this.ctx;
    const hs    = this.hexSize;
    const state = this.state;

    ctx.save();

    // 1. Grey move arrows — same style as the planning overlay but grey
    if (overlay.moveArrows?.length) {
      // Destination circles
      for (const arrow of overlay.moveArrows) {
        const to = this._toCanvas(arrow.toCol, arrow.toRow);
        const r  = hs * 0.32;
        ctx.globalAlpha = 0.35;
        ctx.beginPath();
        ctx.arc(to.x, to.y, r, 0, Math.PI * 2);
        ctx.fillStyle = '#888';
        ctx.fill();
        ctx.strokeStyle = 'rgba(255,255,255,0.5)';
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Arrows with step badges
      overlay.moveArrows.forEach((arrow, i) => {
        const from = this._toCanvas(arrow.fromCol, arrow.fromRow);
        const to   = this._toCanvas(arrow.toCol,   arrow.toRow);

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const len = Math.hypot(dx, dy);
        if (len < 1) return;
        const ux = dx / len;
        const uy = dy / len;

        const startX = from.x + ux * hs * 0.35;
        const startY = from.y + uy * hs * 0.35;
        const endX   = to.x   - ux * hs * 0.45;
        const endY   = to.y   - uy * hs * 0.45;

        // Dashed grey arrow line
        ctx.strokeStyle = 'rgba(160,160,160,0.6)';
        ctx.lineWidth   = 2;
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(startX, startY);
        ctx.lineTo(endX,   endY);
        ctx.stroke();
        ctx.setLineDash([]);

        // Arrowhead
        const headLen = hs * 0.22;
        const angle   = Math.atan2(dy, dx);
        ctx.strokeStyle = 'rgba(180,180,180,0.8)';
        ctx.lineWidth   = 2;
        ctx.beginPath();
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - headLen * Math.cos(angle - 0.4), endY - headLen * Math.sin(angle - 0.4));
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - headLen * Math.cos(angle + 0.4), endY - headLen * Math.sin(angle + 0.4));
        ctx.stroke();

        // Step number badge
        const badgeR = hs * 0.22;
        ctx.beginPath();
        ctx.arc(to.x, to.y, badgeR, 0, Math.PI * 2);
        ctx.fillStyle = 'rgba(100,100,100,0.85)';
        ctx.fill();
        ctx.fillStyle    = '#fff';
        ctx.font         = `bold ${Math.floor(badgeR * 1.1)}px sans-serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(arrow.stepNumber ?? (i + 1)), to.x, to.y + 0.5);
      });
    }

    // 1b. Intent markers — pulsing rings at the AI's ultimate destination
    if (overlay.intentMarkers?.length) {
      for (const marker of overlay.intentMarkers) {
        const { x, y } = this._toCanvas(marker.col, marker.row);
        const color = overlay.goalColors?.[marker.goal] || '#888';
        const r = hs * 0.6;

        // Outer dashed ring
        ctx.strokeStyle = _hexToRgba(color, 0.6);
        ctx.lineWidth = 2;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);

        // Inner fill
        ctx.fillStyle = _hexToRgba(color, 0.1);
        ctx.fill();

        // Label below
        if (marker.label) {
          const fontSize = Math.max(8, Math.floor(hs * 0.26));
          ctx.font = `bold ${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = _hexToRgba(color, 0.85);
          ctx.fillText(marker.label, x, y + r + 2);
        }
      }
    }

    // 2. Node feasibility badges — score at each power node
    if (overlay.nodes) {
      const fontSize = Math.max(9, Math.floor(hs * 0.32));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      for (const n of overlay.nodes) {
        if (n.feasibility == null) continue;
        const { x, y } = this._toCanvas(n.col, n.row);
        const f = n.feasibility;

        const badgeColor = f > 0.5 ? '#40c070' : f > 0.25 ? '#e0c040' : '#e04040';
        const label = f.toFixed(2);

        const bw = fontSize * 2.2;
        const bh = fontSize * 1.3;
        const bx = x - bw / 2;
        const by = y + hs * 0.55;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 3);
        ctx.fill();
        ctx.strokeStyle = badgeColor;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = badgeColor;
        ctx.fillText(label, x, by + bh / 2);
      }
    }

    // 3. Combat estimate badges — classification near enemy entities
    if (overlay.combatEstimates) {
      const fontSize = Math.max(8, Math.floor(hs * 0.26));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';

      const classColors = {
        overwhelming: '#40c070',
        favorable:    '#80d080',
        unfavorable:  '#e0a030',
        suicidal:     '#e04040',
      };

      for (const est of overlay.combatEstimates) {
        const { x, y } = this._toCanvas(est.col, est.row);
        const label = est.classification.slice(0, 5).toUpperCase();
        const color = classColors[est.classification] || '#888';

        const bw = fontSize * 3;
        const bh = fontSize * 1.3;
        const bx = x + hs * 0.2 - bw / 2;
        const by = y - hs * 0.65;
        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.beginPath();
        ctx.roundRect(bx, by, bw, bh, 3);
        ctx.fill();
        ctx.strokeStyle = color;
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = color;
        ctx.fillText(label, bx + bw / 2, by + bh / 2);

        const fav = est.favorability != null ? (est.favorability > 0 ? '+' : '') + est.favorability.toFixed(1) : '';
        if (fav) {
          ctx.font = `${Math.floor(fontSize * 0.85)}px sans-serif`;
          ctx.fillStyle = 'rgba(255,255,255,0.7)';
          ctx.fillText(fav, bx + bw / 2, by + bh + fontSize * 0.6);
          ctx.font = `bold ${fontSize}px sans-serif`;
        }
      }
    }

    // 4. Unit goal labels — small text above each AI entity showing its committed goal
    if (overlay.unitCommitments && overlay.faction) {
      const fontSize = Math.max(8, Math.floor(hs * 0.24));
      ctx.font = `bold ${fontSize}px sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';

      for (const e of state.entities) {
        if (!e.alive || e.owner !== overlay.faction) continue;
        const goalName = overlay.unitCommitments.get(e.id);
        if (!goalName) continue;

        const { x, y } = this._toCanvas(e.col, e.row);
        const label = goalName.replace(/_/g, ' ');
        const color = overlay.goalColors?.[goalName] || '#ccc';

        const tw = ctx.measureText(label).width + 6;
        const th = fontSize + 2;
        const tx = x - tw / 2;
        const ty = y - hs * 0.7 - th;
        ctx.fillStyle = 'rgba(0,0,0,0.75)';
        ctx.beginPath();
        ctx.roundRect(tx, ty, tw, th, 2);
        ctx.fill();

        ctx.fillStyle = color;
        ctx.fillText(label, x, ty + th - 1);
      }
    }

    ctx.restore();
  }

  _drawLungeAnims(fogVisibleHexes = null, hiddenOwner = null) {
    const ctx = this.ctx;
    const now = Date.now();
    const hs  = this.hexSize;
    const r   = hs * 0.35;

    // Remove returns that have fully completed
    this._lungeAnims = this._lungeAnims.filter(
      a => !a.returning || now < a.returnStartTime + a.returnDuration
    );

    if (!this._lungeAnims.length) return;

    for (const a of this._lungeAnims) {
      if (fogVisibleHexes !== null && hiddenOwner !== null && a.owner === hiddenOwner) {
        const fromVisible = fogVisibleHexes.has(hexKey(a.fromCol, a.fromRow));
        const toVisible   = fogVisibleHexes.has(hexKey(a.toCol,   a.toRow));
        if (!fromVisible && !toVisible) continue;
      }
      let x, y;
      if (a.returning) {
        const t    = Math.min(1, (now - a.returnStartTime) / a.returnDuration);
        const ease = 1 - (1 - t) * (1 - t); // ease-out quad
        x = a.midX + (a.fromX - a.midX) * ease;
        y = a.midY + (a.fromY - a.midY) * ease;
      } else {
        const t    = Math.min(1, (now - a.startTime) / a.duration);
        if (t >= 1) a.settled = true;
        const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease in-out quad
        x = a.fromX + (a.midX - a.fromX) * ease;
        y = a.fromY + (a.midY - a.fromY) * ease;
      }

      // Shadow
      ctx.beginPath();
      ctx.arc(x + 1, y + 2, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();

      // Entity circle
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = a.color;
      ctx.fill();

      // Portrait image if available, otherwise glyph
      const pRect = a.portraitId ? this._spriteRects?.get(a.portraitId) : null;
      if (pRect && this._tilemapImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(this._tilemapImg, pRect.x, pRect.y, pRect.size, pRect.size, x - r, y - r, r * 2, r * 2);
        ctx.restore();
      } else {
        ctx.fillStyle    = '#ffffffee';
        ctx.font         = `bold ${Math.floor(r * 1.1)}px serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(a.glyph, x, y + 1);
      }

      ctx.strokeStyle = a.color;
      ctx.lineWidth   = 2;
      ctx.stroke();
    }
  }

  _drawMoveAnims(fogVisibleHexes = null, hiddenOwner = null) {
    const ctx = this.ctx;
    const now = Date.now();
    const hs  = this.hexSize;
    const r   = hs * 0.35;

    this._moveAnims = this._moveAnims.filter(a => now < a.startTime + a.duration);
    if (!this._moveAnims.length) return;

    for (const a of this._moveAnims) {
      if (fogVisibleHexes !== null && hiddenOwner !== null && a.owner === hiddenOwner) {
        const fromVisible = fogVisibleHexes.has(hexKey(a.fromCol, a.fromRow));
        const toVisible   = fogVisibleHexes.has(hexKey(a.toCol,   a.toRow));
        if (!fromVisible && !toVisible) continue;
      }
      const t    = Math.min(1, (now - a.startTime) / a.duration);
      const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; // ease in-out quad
      const x    = a.fromX + (a.toX - a.fromX) * ease;
      const y    = a.fromY + (a.toY - a.fromY) * ease;

      // Shadow
      ctx.beginPath();
      ctx.arc(x + 1, y + 2, r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fill();

      // Entity circle
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = a.color;
      ctx.fill();

      // Portrait image if available, otherwise glyph
      const pRect = a.portraitId ? this._spriteRects?.get(a.portraitId) : null;
      if (pRect && this._tilemapImg) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.clip();
        ctx.drawImage(this._tilemapImg, pRect.x, pRect.y, pRect.size, pRect.size, x - r, y - r, r * 2, r * 2);
        ctx.restore();
      } else {
        ctx.fillStyle    = '#ffffffee';
        ctx.font         = `bold ${Math.floor(r * 1.1)}px serif`;
        ctx.textAlign    = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(a.glyph, x, y + 1);
      }

      ctx.strokeStyle = a.color;
      ctx.lineWidth   = 2;
      ctx.stroke();
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
