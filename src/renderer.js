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
import { getVisibleEnemyHexes, getVisibleHeroHexes, sightRange } from './actions.js';
import { nodeController } from './game.js';

// PAD_X/PAD_Y are now computed dynamically in _resize() as this._padX / this._padY.
// These constants are kept for backward-compat imports but should not be used internally.
export const PAD_X = 40;
export const PAD_Y = 30;
const BG_COLOR = '#0d1117';
const MIN_HEX_SIZE = 10;

function hexCorners(cx, cy, size) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 180 * (60 * i - 30);
    pts.push({ x: cx + size * Math.cos(angle), y: cy + size * Math.sin(angle) });
  }
  return pts;
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

    // Move animations: sliding entity icons
    this._moveAnims = [];

    // Lunge animations: attacker slides to hex border during combat, stays there until cleared
    this._lungeAnims = [];

    // Battle hex highlights: set during combat animation, cleared after
    this._battleCombatantHexes = []; // [{col, row}] — bright red
    this._battleAllyHexes      = []; // [{col, row}] — faint red

    this._animFramePending = false;

    // Smooth zoom/pan animation: null when idle
    this._zoomAnim = null; // {startZoom,targetZoom,startPanX,targetPanX,startPanY,targetPanY,startTime,duration}

    // Tilemap sprite sheet — populated by loadImages()
    this._tilemapImg   = null;   // HTMLImageElement for assets/tilemap.png
    this._spriteRects  = null;   // Map<id, {x,y,size}> — source rect in the tilemap

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
      ['grass','forest','dirt','road','river','bridge'],
      ['town_hall','church','inn','blacksmith','graveyard','mill',
       'dock','house','barn','watchtower','apothecary','storehouse','stable'],
      ['hero','witch','zombie','minion','wood_golem','iron_golem',
       'survivor_innkeeper','survivor_nurse','survivor_blacksmith',
       'survivor_herbalist','survivor_militia','survivor_priest',
       'survivor_baker','survivor_trapper','survivor_schoolteacher',
       'survivor_gravedigger','survivor_midwife','survivor_farmhand'],
    ];

    const rects = new Map();
    let y = GAP;

    for (const ids of groups) {
      y += LABEL_H + GAP; // skip the category label row
      for (let i = 0; i < ids.length; i++) {
        const col  = i % COLS;
        const row  = Math.floor(i / COLS);
        const sx   = GAP + col * (CELL + GAP);
        const sy   = y   + row * (CELL + GAP);
        rects.set(ids[i], { x: sx, y: sy, size: CELL });
      }
      y += Math.ceil(ids.length / COLS) * (CELL + GAP);
    }

    return rects;
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
    this._spriteRects = Renderer._buildSpriteRects();
    this._portraitCache = new Map();
    this.draw();
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

  /** Map a survivor entity's title to its sprite asset id. */
  static _survivorAssetId(title) {
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
      ? Renderer._survivorAssetId(title)
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
      ? Renderer._survivorAssetId(title)
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

  /** Clear all in-flight canvas animations (moves, flashes, deaths, lunges, battle highlights, zoom). */
  clearAnimations() {
    this._moveAnims              = [];
    this._flashes                = [];
    this._deathAnims             = [];
    this._lungeAnims             = [];
    this._battleCombatantHexes   = [];
    this._battleAllyHexes        = [];
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
                 || this._lungeAnims.some(a => !a.settled || a.returning)
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
                   || this._lungeAnims.some(a => !a.settled || a.returning)
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

    // Clamp so the map doesn't drift off-screen
    const minPanX = Math.min(0, fullW - fullW * z);
    const minPanY = Math.min(0, H - H * z);
    panX = Math.max(minPanX, Math.min(0, panX));
    panY = Math.max(minPanY, Math.min(0, panY));

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
    newZoom = Math.max(0.5, Math.min(4.0, newZoom));
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
    // Content dimensions at current zoom
    const contentW = this.canvas.width  * this.zoomLevel;
    const contentH = this.canvas.height * this.zoomLevel;
    // Allow panning beyond the map edges so any hex (including edge hexes)
    // can be centered in the viewport.  The margin is ~40% of the viewport.
    const marginX = wrapW * 0.4;
    const marginY = wrapH * 0.4;
    const minX = Math.min(0, wrapW - contentW) - marginX;
    const minY = Math.min(0, wrapH - contentH) - marginY;
    this._panX = Math.max(minX, Math.min(marginX, this._panX));
    this._panY = Math.max(minY, Math.min(marginY, this._panY));
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
    ctx.fillStyle = BG_COLOR;
    ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);

    // Apply zoom and pan transform for all map content
    ctx.save();
    ctx.translate(this._panX, this._panY);
    ctx.scale(this.zoomLevel, this.zoomLevel);

    // Pass 1: terrain tiles (grass, forest, dirt, road bg, river bg, bridges)
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const t = state.tiles.get(hexKey(col, row));
        if (t && t.type !== TileType.BUILDING) this._drawTile(col, row);
      }
    }

    // River first (water), then roads on top (bridge deck above the water)
    this._drawRiverLayer();
    this._drawRoadLayer();

    // Pass 2: building tiles drawn over roads/rivers so no bleed-through
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const t = state.tiles.get(hexKey(col, row));
        if (t && t.type === TileType.BUILDING) this._drawTile(col, row);
      }
    }

    // Visibility: compute once for fog layer + entity pass + outlines.
    // In local AI games, perspective is from the human side (witchIsAI / heroIsAI).
    // In online PvP/AI games, state.myFaction is set by the client to their faction.
    const myFaction    = state.myFaction;  // 'hero' | 'witch' | undefined
    const humanIsHero  = myFaction ? myFaction === 'hero'  : (state.witchIsAI && !state.heroIsAI);
    const humanIsWitch = myFaction ? myFaction === 'witch' : (state.heroIsAI  && !state.witchIsAI);
    let revealedHexes = null;
    if (state.fogOfWar) {
      if (humanIsHero)  revealedHexes = getVisibleEnemyHexes(state); // hero sees witch
      if (humanIsWitch) revealedHexes = getVisibleHeroHexes(state);  // witch sees hero
    }

    // Full set of hexes the observer can see (used to cull animations in fog).
    // Distinct from revealedHexes, which only tracks hexes where enemy entities exist.
    let fogVisibleHexes = null;
    const hiddenOwner = humanIsHero ? 'witch' : (humanIsWitch ? 'hero' : null);
    if (state.fogOfWar && hiddenOwner) {
      const observerOwner = humanIsHero ? 'hero' : 'witch';
      fogVisibleHexes = this._buildFogVisibleHexes(observerOwner);
    }

    // Fog of war: grey overlay on all hexes outside the human player's vision
    if (state.fogOfWar && humanIsHero)  this._drawFogLayer('hero');
    if (state.fogOfWar && humanIsWitch) this._drawFogLayer('witch');

    // Explored dots — drawn after fog so they respect fog of war
    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
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

    // Objective glows and symbols — only drawn once a node has been discovered
    for (const obj of state.witchObjectives) {
      const shouldDraw = !state.fogOfWar
        || (humanIsHero  && obj.seenByHero)
        || (humanIsWitch && obj.seenByWitch)
        || (!humanIsHero && !humanIsWitch); // AI vs AI / spectator
      if (!shouldDraw) continue;
      for (const h of obj.hexes) {
        this._drawObjectiveHexGlow(h.col, h.row, obj, state);
      }
      this._drawObjectiveSymbol(obj.col, obj.row, obj.label, state);
    }

    // Thick outlines on hexes occupied by units
    this._drawUnitPresenceOutlines(revealedHexes);

    // Highlights
    for (const h of this.highlightHexes) {
      this._drawHighlight(h.col, h.row, h.color || 'rgba(100,200,100,0.25)');
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
      for (const e of state.entities) {
        if (!e.alive || !(e.guarding > 0)) continue;
        if (revealedHexes && !revealedHexes.has(hexKey(e.col, e.row))) continue;
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
      this._drawOutline(this.selectedHex.col, this.selectedHex.row, selColor, 3, true);
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

    const drawn = new Set();
    for (const entity of state.entities) {
      if (!entity.alive) continue;
      if (animatingIds.has(entity.id)) continue; // drawn by _drawMoveAnims instead

      if (revealedHexes !== null) {
        const hiddenOwner = humanIsHero ? 'witch' : 'hero';
        if (entity.owner === hiddenOwner && !revealedHexes.has(hexKey(entity.col, entity.row))) continue;
      }

      const key = hexKey(entity.col, entity.row);
      if (drawn.has(key)) continue;

      const stack = state.entities.filter(e => {
        if (!e.alive || e.col !== entity.col || e.row !== entity.row) return false;
        if (animatingIds.has(e.id)) return false;
        if (revealedHexes !== null) {
          const hiddenOwner = humanIsHero ? 'witch' : 'hero';
          if (e.owner === hiddenOwner) return revealedHexes.has(hexKey(e.col, e.row));
        }
        return true;
      });

      if (!stack.length) continue;
      drawn.add(key);
      this._drawEntityStack(entity.col, entity.row, stack);
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
    const corners = hexCorners(x, y, hs - 1);
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
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
      const corners   = hexCorners(x, y, hs - 1);

      // Red hex overlay (fades out)
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
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
        ctx.fillText(f.text, x, y - rise);
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

  _drawTile(col, row) {
    const ctx  = this.ctx;
    const hs   = this.hexSize;
    const tile = this.state.tiles.get(hexKey(col, row));
    if (!tile) return;

    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, hs - 1);

    // Road and river tiles use a grass background — the actual road strips and
    // water ribbons are drawn in dedicated layers on top.
    const color = tile.type === TileType.BUILDING
      ? (BUILDING_COLOR[tile.building] || '#8a7a5a')
      : (tile.type === TileType.ROAD || tile.type === TileType.RIVER || tile.type === TileType.BRIDGE)
        ? TILE_COLOR[TileType.GRASS]
        : (TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS]);

    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.fillStyle = color;
    ctx.fill();

    // ── Building image from sprite sheet ──────────────────────────────────
    // Terrain tile images are disabled for now (terrain uses colour fills).
    if (tile.type === TileType.BUILDING) {
      const rect = this._spriteRects?.get(tile.building);
      if (rect && this._tilemapImg) {
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(this._tilemapImg,
          rect.x, rect.y, rect.size, rect.size,  // source rect in tilemap
          x - hs, y - hs, hs * 2, hs * 2);       // destination on canvas
        ctx.restore();
      }
    }

    ctx.strokeStyle = '#111418';
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    // Bridge tiles: only the water background is drawn here.
    // The water bezier and road strip are layered on top in _drawRiverLayer / _drawRoadLayer.
    if (tile.type === TileType.BRIDGE) return;

    // ── Fortification outline — tiered colour, outer glow, inner highlight ──
    if (tile.fortifyLevel > 0) {
      const lvl = tile.fortifyLevel;
      // Colour palette: level 1 = amber wood, 2 = stone grey, 3 = silver steel, 4 = iron-gilt
      const fortPalette = [
        null,
        [160, 100,  55],   // 1 — amber/wood palisade
        [120, 135, 148],   // 2 — rough stone
        [180, 196, 210],   // 3 — dressed silver steel
        [205, 165,  35],   // 4 — iron-gilt ramparts
      ];
      const [fr, fg, fb] = fortPalette[Math.min(lvl, 4)];
      const alpha = Math.min(0.95, 0.5 + lvl * 0.12);
      const lw    = lvl * 2; // level 1: 2px, level 4: 8px

      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();

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
        const innerCs = hexCorners(x, y, hs - 1 - lw * 0.6);
        ctx.beginPath();
        ctx.moveTo(innerCs[0].x, innerCs[0].y);
        for (let i = 1; i < 6; i++) ctx.lineTo(innerCs[i].x, innerCs[i].y);
        ctx.closePath();
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
        ctx.fillText(BUILDING_ICON[tile.building] || '?', x, y - hs * 0.10);
      }

      ctx.fillStyle    = 'rgba(255,248,230,0.92)';
      ctx.font         = `bold ${Math.max(7, Math.floor(hs * 0.25))}px "Georgia", serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(BUILDING_LABEL[tile.building] || tile.building, x, y + hs * 0.58);
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
      const range = sightRange(state.phase, e.ability === SurvivorAbility.SCOUT);
      for (let row = 0; row < MAP_ROWS; row++) {
        for (let col = 0; col < MAP_COLS; col++) {
          if (hexDistance(col, row, e.col, e.row) <= range) {
            visibleSet.add(hexKey(col, row));
          }
        }
      }
    }
    return visibleSet;
  }

  _drawFogLayer(observerOwner) {
    const ctx   = this.ctx;
    const hs    = this.hexSize;

    const visibleSet = this._buildFogVisibleHexes(observerOwner);

    for (let row = 0; row < MAP_ROWS; row++) {
      for (let col = 0; col < MAP_COLS; col++) {
        const k = hexKey(col, row);
        if (visibleSet.has(k)) continue; // visible — no fog

        const { x, y } = this._toCanvas(col, row);
        const corners = hexCorners(x, y, hs);

        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fill();
      }
    }
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
      const isSelected = k === selKey;
      this._drawOutline(col, row, _hexToRgba(color, 0.85), isSelected ? 3 : 2, true);
    }
  }

  // Draw the river as smooth bezier flows through each RIVER and BRIDGE tile.
  // Endpoints (row 0 / row MAP_ROWS-1) extend their bezier off-screen so the
  // river appears to flow in from and out to the edge of the map.
  _drawRiverLayer() {
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
          // Point beyond this hex in the opposite direction (off the map edge)
          const offX = x - (dx / d) * apothem * 2;
          const offY = y - (dy / d) * apothem * 2;
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
  _drawRoadLayer() {
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

        // ── Road strip ────────────────────────────────────────────────────
        if (roadNbrs.length === 2) {
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

        // ── Bridge railings (bezier curves matching the road curve) ───────
        if (tile.type === TileType.BRIDGE && roadNbrs.length >= 2) {
          const em0 = edgeMids[0], em1 = edgeMids[1];
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
      ctrl === 'hero'      ? 'rgba(50,120,220,0.18)'  :
      ctrl === 'witch'     ? 'rgba(180,0,80,0.18)'    :
      ctrl === 'contested' ? 'rgba(200,140,0,0.18)'   :
                             null;
    const { x, y } = this._toCanvas(col, row);
    const hs = this.hexSize;
    const corners = hexCorners(x, y, hs - 1);
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    // Node color base fill (~20% opacity)
    ctx.fillStyle = nodeColor + '33';
    ctx.fill();
    // Faction overlay on controlled/contested hexes
    if (factionOverlay) {
      ctx.beginPath();
      ctx.moveTo(corners[0].x, corners[0].y);
      for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
      ctx.closePath();
      ctx.fillStyle = factionOverlay;
      ctx.fill();
    }
    // Border ring in node color (~53% opacity)
    ctx.strokeStyle = nodeColor + '88';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _drawObjectiveSymbol(col, row, label, state) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);

    const obj  = state.witchObjectives.find(o => o.col === col && o.row === row);
    const ctrl = obj ? nodeController(obj, state.entities) : 'neutral';
    const nodeColor = obj?.color ?? 'rgba(180,0,255,0.7)';

    // Symbol uses node color; faction glow tints the outline
    const glowColor =
      ctrl === 'witch'     ? '#ff4444' :
      ctrl === 'hero'      ? '#4488ff' :
      ctrl === 'contested' ? '#ffaa00' :
                             nodeColor;

    ctx.shadowColor = glowColor;
    ctx.shadowBlur  = ctrl === 'neutral' ? 4 : 8;
    ctx.fillStyle    = nodeColor;
    ctx.font         = `bold ${Math.floor(hs * 0.5)}px serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('⛧', x, y - hs * 0.15);
    ctx.shadowBlur = 0;

    ctx.fillStyle = nodeColor + 'cc';
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

    // Crisp border ring at full saturation
    const rgba = _parseColor(color);
    if (rgba) {
      const [r, g, b, a] = rgba;
      ctx.strokeStyle = `rgba(${r},${g},${b},${Math.min(1, a * 4)})`;
    } else {
      ctx.strokeStyle = color.replace(/,\s*[\d.]+\)$/, ', 0.9)');
    }
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  _drawOutline(col, row, color, lineWidth = 2, glow = false) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const corners   = hexCorners(x, y, hs - 1.5);

    if (glow) {
      const rgba = _parseColor(color);
      if (rgba) {
        const [r, g, b] = rgba;
        ctx.beginPath();
        ctx.moveTo(corners[0].x, corners[0].y);
        for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
        ctx.closePath();
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

    ctx.beginPath();
    ctx.moveTo(corners[0].x, corners[0].y);
    for (let i = 1; i < 6; i++) ctx.lineTo(corners[i].x, corners[i].y);
    ctx.closePath();
    ctx.strokeStyle = color;
    ctx.lineWidth   = lineWidth;
    ctx.stroke();

    // Specular: thin bright stroke on the upper two edges (top-lit bevel)
    // Corners 5→0→1 are the naturally lit faces of a pointy-top hex.
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
        ? Renderer._survivorAssetId(entity.title)
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
        ctx.fillText(entityGlyph(entity.type), ex, ey + 1);
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

  /** Draw the ⊕ action-hint indicator above a hex position. */
  _drawSelectionIndicator(col, row) {
    const ctx = this.ctx;
    const hs  = this.hexSize;
    const { x, y } = this._toCanvas(col, row);
    const ir = Math.max(5, hs * 0.17);
    const ix = x + hs * 0.42;
    const iy = y - hs * 0.58;

    // Semi-transparent disc
    ctx.beginPath();
    ctx.arc(ix, iy, ir, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.fill();

    // Thin border
    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth   = 0.8;
    ctx.stroke();

    // + glyph
    ctx.fillStyle    = 'rgba(20,20,40,0.82)';
    ctx.font         = `bold ${Math.floor(ir * 1.45)}px sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('+', ix, iy + 0.5);

    // Specular arc at top-left of disc
    ctx.beginPath();
    ctx.arc(ix, iy, ir * 0.72, Math.PI * 1.1, Math.PI * 1.65);
    ctx.strokeStyle = 'rgba(255,255,255,0.6)';
    ctx.lineWidth   = ir * 0.28;
    ctx.lineCap     = 'round';
    ctx.stroke();
    ctx.lineCap     = 'butt';
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
      const color = entityObj?.color ?? ENTITY_COLOR[entityType] ?? (entityOwner === 'witch' ? '#9b59b6' : '#d4a72c');

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
