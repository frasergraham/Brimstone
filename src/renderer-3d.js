// ============================================================================
// Renderer3D — Babylon.js (WebGL) renderer
// ============================================================================
//
// Phase 2 (this file): renders the actual hex map — terrain, river, roads,
// bridges, buildings — under a locked isometric camera that pans and zooms
// but does not yaw or tilt. Entities, fog, plan overlay, animations remain
// stubbed for later phases.
//
// World-unit scale (carried forward from Phase 1):
//   * hex radius = 1 world unit
//   * tile cylinder: diameter 2, height 0.15
//   * 2D pixel→world ratio is therefore 1 unit ≈ 30 pixels (HEX_SIZE = 30)
//
// Babylon is loaded lazily on first draw() via a dynamic import() from a
// pinned CDN URL, keeping src/renderer-3d.js importable in node-test (no DOM,
// no Babylon) so the interface-conformance test and pure-helper tests run
// without a WebGL context. Pure math is exported from this module for tests.
//
// Babylon CDN pin: @babylonjs/core 7.42.0 (ESM build via jsdelivr +esm).

import {
  TileType,
  TILE_COLOR,
  BUILDING_COLOR,
} from './tiles.js';
import { EntityType, isLeaderType } from './entities.js';
import { Renderer } from './renderer.js';
import { getFactionTheme } from './theme.js';
import { hexKey, hexDistance, getNeighbors } from './hex.js';
import { nodeController, Phase } from './game.js';
import { sightRangeForEntity } from './factions.js';

const BABYLON_CDN = 'https://cdn.jsdelivr.net/npm/@babylonjs/core@7.42.0/+esm';

// ─── Standee constants (Phase 3) ────────────────────────────────────────────
// Width / height of an ordinary unit's billboard plane and the disc beneath it.
// Leader entities scale these up to read as "important" from far out.
export const STANDEE_BASE_WIDTH       = 0.7;
export const STANDEE_BASE_HEIGHT      = 1.0;
export const STANDEE_BASE_DIAMETER    = 0.75;
export const STANDEE_BASE_THICKNESS   = 0.06;
export const STANDEE_LEADER_WIDTH_MUL  = 1.2;
export const STANDEE_LEADER_HEIGHT_MUL = 1.3;
// Y-offset for the plane so the bottom of the sprite rests on the base disc,
// which itself sits just above the tile prism so picking prefers the standee.
export const STANDEE_BASE_Y_OFFSET    = 0.18; // tile prism top is at 0.075; base sits clear of it

// Building world-space offset within its tile — aliased to TILE_SLOTS[1] (the
// "NE" outer slot) so building/tree/standee co-tenancy on the same hex shares
// the unified slot layout. Frozen so callers can't mutate it accidentally.
// Distance from centre comfortably clears the STANDEE_BASE_DIAMETER=0.75 disc.
export const BUILDING_OFFSET = Object.freeze({ x: 0.42, z: -0.42 });


// ─── Pure helpers (exported for tests; no Babylon dependency) ────────────────

/** World-unit radius for a single hex tile. */
export const HEX_RADIUS_WORLD = 1;

/** Duration (in frames at 60fps) of focus-shift animations.
 *  18 frames ≈ 300ms — long enough to read, short enough not to feel slow. */
export const FOCUS_ANIM_FRAMES = 18;

/** Epsilon below which a focus shift is treated as a no-op (skip animation). */
export const FOCUS_EPSILON = 1e-3;

/** Camera radius selection-driven focus zooms IN to (never out past current).
 *  Picked to frame ~3-tile diameter around the unit on a standard map. */
export const SELECTION_FOCUS_RADIUS = 14;

/** Camera tilt (beta) range, expressed as deltas from the locked isometric
 *  anchor (`_lockedBeta = π/3.5 ≈ 0.898 rad ≈ 51.4°`). Round 3 unlocked a
 *  clamped tilt range so the player can dip toward head-on or rise toward a
 *  bird's-eye view; the anchor remains "isometric" and the clamps stay safely
 *  inside (0, π/2) so the camera never points straight down or sees through
 *  the tile prisms horizontally. */
export const CAMERA_BETA_LOWER_DELTA = 0.25; // ~14° toward head-on
export const CAMERA_BETA_UPPER_DELTA = 0.15; // ~8.6° toward bird's-eye

const SQRT3 = Math.sqrt(3);

/**
 * Offset (col,row) → world (x,z) for a pointy-top, odd-r hex grid.
 * Matches the 2D renderer's hexToPixel layout, scaled so radius = 1 world unit.
 * Y is left to the caller (we always render on the XZ plane).
 */
export function hexToWorld(col, row, radius = HEX_RADIUS_WORLD) {
  return {
    x: radius * SQRT3 * (col + 0.5 * (row & 1)),
    z: radius * 1.5 * row,
  };
}

/**
 * Bounding box (in world units) for a set of hex positions.
 * Pads by the hex's footprint so the box covers the whole rendered tiles,
 * not just their centres. Returns null for an empty set.
 */
export function computeMapBounds(hexes, radius = HEX_RADIUS_WORLD) {
  if (!hexes || hexes.length === 0) return null;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const h of hexes) {
    const { x, z } = hexToWorld(h.col, h.row, radius);
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  // Half-width / half-height of a single hex (pointy-top, unit radius).
  const padX = radius * SQRT3 / 2;
  const padZ = radius;
  return {
    minX: minX - padX, maxX: maxX + padX,
    minZ: minZ - padZ, maxZ: maxZ + padZ,
    centerX: (minX + maxX) / 2,
    centerZ: (minZ + maxZ) / 2,
    width:   (maxX - minX) + 2 * padX,
    depth:   (maxZ - minZ) + 2 * padZ,
  };
}

/**
 * Pick a camera radius so a `fitWidth × fitDepth` rectangle on the ground
 * fills the canvas at the locked isometric tilt. Uses the larger of the two
 * dimensions and the vertical FOV (Babylon default ≈ 0.8 rad).
 *
 * `aspect` is renderWidth / renderHeight. `margin` is multiplicative slack
 * around the fit (1.05 = 5% headroom).
 */
export function radiusForFit(fitWidth, fitDepth, aspect, fov = 0.8, margin = 1.05) {
  const safeAspect = Math.max(1e-6, aspect);
  const rForDepth = (fitDepth / 2) / Math.tan(fov / 2);
  const rForWidth = (fitWidth / 2) / (Math.tan(fov / 2) * safeAspect);
  return Math.max(rForDepth, rForWidth) * margin;
}

/**
 * Returns true when a focus shift is large enough to be worth animating.
 * Skips no-op transitions where the camera is already (approximately) at the
 * requested target+radius — animating a no-op wastes a frame and produces a
 * visible micro-stall.
 */
export function shouldAnimateFocus(curTarget, curRadius, newTarget, newRadius, epsilon = FOCUS_EPSILON) {
  if (Math.abs(curRadius - newRadius) > epsilon) return true;
  const dx = (curTarget?.x ?? 0) - (newTarget?.x ?? 0);
  const dy = (curTarget?.y ?? 0) - (newTarget?.y ?? 0);
  const dz = (curTarget?.z ?? 0) - (newTarget?.z ?? 0);
  return (dx * dx + dy * dy + dz * dz) > epsilon * epsilon;
}

/** Parse `#rrggbb` → [r,g,b] in 0..1; returns magenta on parse failure (loud). */
const _RGB_CACHE = new Map();
export function cssHexToRgb01(hex) {
  if (_RGB_CACHE.has(hex)) return _RGB_CACHE.get(hex);
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return [1, 0, 1];
  const n = parseInt(m[1], 16);
  const rgb = [
    ((n >> 16) & 0xff) / 255,
    ((n >>  8) & 0xff) / 255,
    ( n        & 0xff) / 255,
  ];
  _RGB_CACHE.set(hex, rgb);
  return rgb;
}

/**
 * Color a tile by its type. Phase 2 keeps it simple: every TileType maps
 * to its TILE_COLOR directly (so rivers read as blue, roads as brown,
 * bridges as blue under their plank deck) and buildings to BUILDING_COLOR.
 *
 * Note this diverges from the 2D renderer's _drawTile, which draws roads
 * and rivers on a grass base and overlays strips on top. In 3D we already
 * have separate meshes for road decks and bridge planks, so the underlying
 * tile colour can be its honest type colour without losing visual signal.
 */
export function tileColorFor(tile) {
  if (!tile) return TILE_COLOR[TileType.GRASS];
  if (tile.type === TileType.BUILDING) {
    return BUILDING_COLOR[tile.building] || '#8a7a5a';
  }
  // Road / river / bridge tiles now render with a grass base — the network
  // pass draws smooth bezier tubes overlaying the grass, mirroring the 2D
  // renderer's _drawRiverLayer / _drawRoadLayer (which also keep the grass
  // background intact and lay the path on top).
  if (tile.type === TileType.ROAD
      || tile.type === TileType.RIVER
      || tile.type === TileType.BRIDGE) {
    return TILE_COLOR[TileType.GRASS];
  }
  return TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS];
}

// ─── 2D thumbnail helpers (UI portrait + terrain icons) ─────────────────────
// These exist for `getPortraitDataURL` / `getTileDataURL`, which the unit-
// stats bar (and other ui.js portrait callsites) invokes on the renderer
// regardless of mode. The 3D renderer doesn't draw to a 2D canvas at runtime,
// but it still owns the shared sprite atlas, so it's the natural place to
// produce these tiny offscreen-canvas thumbnails.

/** Trace a flat-top hexagon path on a 2D canvas context, centred at (cx, cy)
 *  with radius r. Matches the 2D renderer's `_traceHexPath` so thumbnails
 *  rendered through either renderer look identical. */
function _traceHexPath2D(ctx, cx, cy, r) {
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (Math.PI / 3) * i;
    const x = cx + r * Math.cos(a);
    const y = cy + r * Math.sin(a);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}

/** Pick a hex fill colour for the terrain thumbnail. Roads/rivers/bridges
 *  collapse to grass (their cosmetic strips are layered on top in the 2D
 *  renderer but we don't replicate those for thumbnails). */
function _tileFillColor(tile) {
  if (!tile) return TILE_COLOR[TileType.GRASS];
  if (tile.type === TileType.BUILDING) {
    return BUILDING_COLOR[tile.building] || '#8a7a5a';
  }
  if (tile.type === 'road' || tile.type === 'river' || tile.type === 'bridge') {
    return TILE_COLOR[TileType.GRASS];
  }
  return TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS];
}

/** Choose a representative sprite id (e.g. 'grass_3') for a tile, hashed
 *  deterministically by (col, row) so the same hex always renders the same
 *  variant. Lighter version of the 2D renderer's `_pickVariant` — we only
 *  cover the variant pools that exist in the atlas (grass/forest/dirt). */
export function _terrainThumbSpriteId(tile, col, row) {
  if (!tile) return null;
  let base = tile.type;
  if (tile.type === TileType.BUILDING) base = TileType.DIRT;
  else if (tile.type === 'road' || tile.type === 'river' || tile.type === 'bridge') {
    base = TileType.GRASS;
  }
  const variants = { grass: 5, forest: 5, dirt: 5 };
  const count = variants[base];
  if (!count) return null;
  // Stable hash mirroring the 2D renderer's variant choice.
  const hash = Math.abs((col * 73856093) ^ (row * 19349663)) % count;
  return `${base}_${hash + 1}`;
}

// ─── Renderer class ──────────────────────────────────────────────────────────

export class Renderer3D {
  constructor(canvas, state) {
    this.canvas = canvas;
    this.state  = state;

    // ── Interface property slots (read/written by main.js and ui.js) ────────
    this.onImagesLoaded     = null;
    this.aiDebugOverlay     = null;
    this.insetLeft          = 0;
    this.insetRight         = 0;
    this.hoveredHex         = null;
    this.selectedHex        = null;
    this.selectedEntityId   = null;
    this.highlightHexes     = [];
    this.planGhostSteps     = null;
    this.viewLocked         = false;
    this.zoomLevel          = 1.0;
    this.hexSize            = 30;
    this.useTileImages      = true;
    this._zoomAnim          = null;
    this._panX              = 0;
    this._panY              = 0;
    this.disambigHiddenIds  = new Set();

    // ── Babylon state — populated by _initBabylon() on first draw ───────────
    this._babylon       = null; // module namespace once loaded
    this._engine        = null;
    this._scene         = null;
    this._camera        = null;
    this._light         = null;
    this._mapRoot       = null; // TransformNode parent for all tile meshes
    this._materialCache = new Map(); // hex string → BABYLON.StandardMaterial
    this._tileMeshes    = [];   // for picking + future incremental rebuild
    this._mapBuilt      = false;
    this._babylonInit   = null; // pending init promise (de-dupes draw() calls)

    // Tile top-face textures (see "Tile top-face textures" banner below).
    // Both keyed by sprite id ('grass_3', 'dirt_1', 'road', …) so every tile of
    // one variant shares one Texture + one Material — ~10 unique materials for
    // the textured-terrain set across an entire Campaign-size map.
    this._terrainTextureCache  = new Map();
    this._terrainMaterialCache = new Map();
    // Top-disc meshes per hex, separate from the prop array so we can hide
    // them on fogged tiles alongside the colour cylinder swap.
    this._tileTopDiscByKey     = new Map();
    // One-shot warning gate per failed sprite id, so a missing or broken
    // sprite doesn't spam the console once per redraw.
    this._textureWarnedFor     = new Set();

    // ── Phase 6: atmosphere + fog veil ──────────────────────────────────────
    // Per-hex lookup of the main tile mesh and its props (forest cones, road
    // decks, bridge planks, building boxes/roofs). Populated by _buildTileMesh.
    // Used by _applyFogVeil to swap tile materials and hide props on hexes the
    // observer can't see.
    this._tileMeshByKey   = new Map();   // hexKey → base hex cylinder
    this._tilePropsByKey  = new Map();   // hexKey → Array<Mesh> (forest, road, bridge, bldg, roof)
    // Item 2 — bezier road/river networks, ONE merged mesh per network.
    this._riverNetworkMesh = null;       // merged tube mesh; null when not built
    this._roadNetworkMesh  = null;
    // Item 8 — static (build-time) per-tile occupant registry consumed by the
    // per-draw standee re-slot pass.
    this._staticOccupantsByKey = new Map(); // hexKey → [{id, kind: 'building'|'tree'}]
    // Item 8 — overflow "+N" badges keyed by hexKey; created lazily when a
    // tile has more standees than free slots, disposed when overflow drops to 0.
    this._overflowBadges       = new Map(); // hexKey → { plane, mat, tex, lastN }
    this._fogMaterialCache = new Map();  // base hex color → darker StandardMaterial
    this._fogActiveSet     = new Set();  // hexKeys currently rendered as fogged
    // Power-node glow meshes: { obj, disc, col, row, glowColor } per node hex.
    this._nodeGlowMeshes   = [];
    this._nodeGlowBuilt    = false;
    // Phase-driven lighting state. Pumped by _onBeforeRender each frame; draw()
    // notices state.phase changes and starts a new 3-second eased transition.
    this._lightState = null;            // populated on first draw after init
    this._lastPhase  = null;
    this._phaseTransition = null;       // { from, to, startMs, durMs } or null
    // Babylon GlowLayer shared by the selection halo and the node-glow discs.
    this._glowLayer  = null;
    this._onBeforeRenderObs = null;     // observer handle so we can dispose it

    // ── Phase 6 (night lanterns subsystem — Piper) ─────────────────────────
    // Per-living-entity warm point-light that flickers gently after dusk and
    // through night, fading out at dawn into day. State is self-contained:
    //   • _lanternLights — Map<entityId, { light, phaseOffset }>
    //   • _lanternCurrentIntensity — current eased base intensity (peak)
    //   • _lanternFade — { from, to, startMs, durMs } during a phase change
    //   • _lastLanternPhase — own phase tracker so we don't race the shared one
    //   • _lanternSubsystemInit — flag for one-time material light-cap bump
    this._lanternLights            = new Map();
    this._lanternCurrentIntensity  = 0;
    this._lanternFade              = null;
    this._lastLanternPhase         = null;
    this._lanternSubsystemInit     = false;

    // ── Phase 3: standees + selection ───────────────────────────────────────
    // Map<entityId, { plane, base, assetId, ownerKey, leader }> for incremental diff.
    this._entityStandees   = new Map();
    // Cache: assetId → BABYLON.Texture (built lazily from the loaded tilemap).
    this._portraitTextures = new Map();
    // Cache: BABYLON.StandardMaterial per asset id (sprite-textured plane material).
    this._portraitMaterials = new Map();
    // Cache: base material per "ownerKey" so all standees of one player share a material.
    this._baseMaterialCache = new Map();
    // Selection-highlight material (emissive cyan) shared across all selected bases.
    this._selectedBaseMaterial = null;
    // Last selectedEntityId we acted on, so we only retarget the camera on change.
    this._lastSelectedEntityId = null;
    // Backing image + sprite rects for the tilemap (loaded by loadImages()).
    this._tilemapImg  = null;
    this._spriteRects = null;

    // Locked camera angles (Phase 2). Yaw rotation lands in Phase 4; tilt
    // is permanently the locked-isometric view.
    this._lockedAlpha = -Math.PI / 4;
    this._lockedBeta  =  Math.PI / 3.5;

    // ── Phase 5: animations, plan arrows, HP bars ──────────────────────────
    // In-flight Babylon animations expressed as Promises that resolve when
    // their animation/timeout completes. waitForAnimations() awaits the set;
    // each promise self-removes when it resolves.
    this._animPromises    = new Set();
    // Set of entity ids whose standee is currently being driven by a move or
    // lunge animation; _syncEntityStandees skips _positionStandee for these
    // so the animation isn't snapped back to the state position every frame.
    this._activeMoveIds   = new Set();
    this._activeLungeIds  = new Set();
    // Map<entityId, { mesh, texture, lastHp, lastMax }> — billboarded HP bar
    // parented to the standee base, redrawn only when ratio changes.
    this._hpBars          = new Map();
    // [{ mesh, owner, fromCol, fromRow, toCol, toRow }] — solid ghost-arrow tubes
    // rebuilt every draw() from this.planGhostSteps so the overlay tracks any
    // plan-step edit.
    this._planArrowMeshes = [];
    // Reusable plan-arrow materials, keyed by owner colour.
    this._planArrowMatCache = new Map();
    // Cached material used to highlight a hex on attack flash.
    this._attackHexFlashMat = null;

    // ── Highlight overlay (movement / target hexes from ui.js) ─────────────
    // The 2D path tints valid-move and target hexes via `highlightHexes`
    // (set by ui.js _updateHighlights). We mirror that here by laying flat
    // emissive discs on the tagged hexes, rebuilt each draw so the overlay
    // tracks selection changes without dirty-tracking.
    this._highlightMeshes      = [];                  // disposable hex overlay meshes
    this._highlightMatCache    = new Map();           // rgba-string → cached StandardMaterial
    this._highlightSig         = '';                  // change-detect signature
    // ── Plan ghost (walking previewer) ─────────────────────────────────────
    // For each entity with at least one MOVE step in `planGhostSteps`, a
    // translucent standee clone walks its path on a loop while planning. The
    // plane/material pair is rebuilt only when the path signature changes;
    // per-frame motion happens in `_onBeforeRender` so the animation runs
    // independently of game-state redraws.
    this._planGhostMeshes  = new Map();   // entityId → { plane, mat, path, signature }
    this._planGhostSig     = '';          // joined per-entity signatures
  }

  // ─── Required interface (real implementations) ───────────────────────────

  /** Lazy-init Babylon on first draw. Babylon owns its own render loop; on
   *  later draw() calls we just diff entities and apply selection changes.
   *  Most state writes (selectedEntityId, entity moves) flow through draw()
   *  via main.js's onRedraw, so this is where the standee diff and camera
   *  focus updates happen. */
  draw() {
    if (!this._engine && !this._babylonInit) {
      this._babylonInit = this._initBabylon().catch(err => {
        console.error('[Renderer3D] Babylon init failed:', err);
      });
      return;
    }
    if (!this._scene) return; // init in flight
    this._syncEntityStandees();
    this._applySelectionAndFocus();
    this._syncMovementHighlights();
    this._syncPlanArrows();
    this._syncPlanGhosts();
    // Phase 6: atmosphere updates — phase-driven lighting transitions, node
    // glow recolour, and fog veil. Standees are hidden in fogged hexes after
    // the standee sync above so newly-built standees are tagged correctly.
    this._notePhaseChange();
    this._syncNodeGlowMeshes();
    this._applyFogVeil();
    // Night lanterns subsystem (Piper): warm flickering point-lights around
    // living units after dusk. Sync runs after the fog veil so newly-fogged
    // standees are tagged before the next flicker pump reads their visibility.
    this._syncLanternLights();
  }

  resize() {
    // Size the canvas to its wrapper, same approach as the 2D renderer.
    const wrapper = this.canvas.parentElement;
    if (wrapper) {
      const W = wrapper.clientWidth  || this.canvas.width  || 800;
      const H = wrapper.clientHeight || this.canvas.height || 600;
      if (this.canvas.width  !== W) this.canvas.width  = W;
      if (this.canvas.height !== H) this.canvas.height = H;
    }
    if (this._engine) this._engine.resize();
  }

  /** Load assets/tilemap.png so entity standees can crop portrait sprites out
   *  of it. Falls back gracefully (faceless coloured planes) if the tilemap
   *  is unreachable — the renderer must never block the game on a 404. */
  async loadImages(basePath = 'assets') {
    if (typeof Image === 'undefined') {
      if (this.onImagesLoaded) this.onImagesLoaded();
      return;
    }
    const img = new Image();
    await new Promise(resolve => {
      img.onload  = resolve;
      img.onerror = resolve;
      img.src = `${basePath}/tilemap.png`;
    });
    if (img.naturalWidth) {
      this._tilemapImg  = img;
      // Reuse the 2D renderer's sprite-rect layout — single source of truth.
      const { rects } = Renderer._buildSpriteRects();
      this._spriteRects = rects;
      // If Babylon init beat the tilemap to the punch, the map will already
      // exist with solid-colour tops. Retro-fit textured discs onto every
      // tile that supports one. (When loadImages resolves first — the common
      // case — _mapBuilt is still false here and _buildMap will pick textures
      // up naturally.)
      if (this._mapBuilt && this._mapRoot) this._upgradeTileTextures();
      // Standees built before this point have a textureless fallback material
      // cached in `_portraitMaterials`. Upgrade them in place so already-built
      // entities show their portrait once the tilemap finally arrives.
      this._upgradePortraitMaterials();
    }
    if (this.onImagesLoaded) this.onImagesLoaded();
  }

  /** Walk `_portraitMaterials` and attach a freshly-built texture to any
   *  material that was created before `_tilemapImg` was available. Idempotent
   *  — materials that already have a diffuseTexture are skipped. */
  _upgradePortraitMaterials() {
    if (!this._scene || !this._babylon || !this._tilemapImg) return;
    const BABYLON = this._babylon;
    for (const [key, mat] of this._portraitMaterials) {
      if (mat.diffuseTexture) continue;
      const assetId = key === '__blank__' ? null : key;
      const tex = this._portraitTextureFor(assetId);
      if (!tex) continue;
      mat.diffuseTexture = tex;
      mat.opacityTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
      // Match the textured branch in _planeMaterialFor: drop the flat diffuse
      // fill (the texture is the diffuse now), keep specular off, raise
      // emissive so the portrait reads at any phase / light angle.
      mat.diffuseColor  = new BABYLON.Color3(1, 1, 1);
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.emissiveColor = new BABYLON.Color3(0.4, 0.4, 0.4);
    }
  }

  /** Center and zoom the camera so the given hexes (with a margin) fill the
   *  view. `opts.paddingHexes` widens the bounds; `opts.instant` skips the
   *  focus-shift animation (used on first frame / map load).
   *
   *  `frameHexes([singleHex])` is supported: `computeMapBounds` falls back to
   *  the single hex's footprint, and `radiusForFit` floors at the camera's
   *  `lowerRadiusLimit` so we never end up with a zero or sub-tile radius.
   */
  frameHexes(positions, opts = {}) {
    if (!this._camera || !positions || positions.length === 0) return;
    const padHexes = typeof opts.paddingHexes === 'number' ? opts.paddingHexes : 1.5;
    const bounds = computeMapBounds(positions);
    if (!bounds) return;
    const padding = padHexes * HEX_RADIUS_WORLD * SQRT3;
    const fitWidth  = bounds.width  + 2 * padding;
    const fitDepth  = bounds.depth  + 2 * padding;

    const BABYLON = this._babylon;
    const newTarget = new BABYLON.Vector3(bounds.centerX, 0, bounds.centerZ);
    const newRadius = this._radiusForFit(fitWidth, fitDepth);
    this._focusCamera(newTarget, newRadius, { instant: opts.instant === true });
  }

  /** Project a canvas pixel onto the map by raycasting against tile and
   *  standee meshes — each carries `{col,row}` (plus `kind` and possibly
   *  `entityId`) in `mesh.metadata`. Standees are raised above tiles so the
   *  closest-hit picker prefers them, which means clicking a unit returns
   *  the unit's hex even when its base partially overlaps a neighbour. */
  canvasToHex(x, y) {
    if (!this._scene) return { col: -1, row: -1 };
    const pick = this._scene.pick(x, y, (mesh) => {
      const k = mesh.metadata?.kind;
      return k === 'tile' || k === 'entity';
    });
    if (pick?.hit && pick.pickedMesh?.metadata) {
      const md = pick.pickedMesh.metadata;
      if (typeof md.col === 'number' && typeof md.row === 'number') {
        return { col: md.col, row: md.row };
      }
    }
    return { col: -1, row: -1 };
  }

  /** Project a hex centre to canvas pixel coordinates.
   *
   *  Phase 4 note: we rotate the *camera* (alpha) for yaw, not `mapRoot`, so
   *  the world matrix passed to `Vector3.Project` stays `Matrix.Identity()`.
   *  If a future phase ever yaws `mapRoot` instead, swap this for
   *  `this._mapRoot.computeWorldMatrix(true)` — otherwise projection will
   *  silently desync from picked mesh positions when the map rotates.
   */
  hexToCanvasPos(col, row) {
    if (!this._scene || !this._camera || !this._engine || !this._babylon) {
      return { x: 0, y: 0 };
    }
    const BABYLON = this._babylon;
    const { x, z } = hexToWorld(col, row);
    const world = new BABYLON.Vector3(x, 0, z);
    const projected = BABYLON.Vector3.Project(
      world,
      BABYLON.Matrix.Identity(),
      this._scene.getTransformMatrix(),
      this._camera.viewport.toGlobal(
        this._engine.getRenderWidth(),
        this._engine.getRenderHeight(),
      ),
    );
    return { x: projected.x, y: projected.y };
  }

  setZoom(_newZoom, _focalX, _focalY)                 { /* managed by camera wheel/pinch */ }
  /** Refit the whole map. Animates target+radius via `frameHexes`; deliberately
   *  does NOT reset the user's yaw (alpha) — rotation is user state. */
  resetView() {
    if (!this.state?.tiles) return;
    const all = [];
    for (const tile of this.state.tiles.values()) all.push({ col: tile.col, row: tile.row });
    this.frameHexes(all, { paddingHexes: 1 });
  }
  _clampPan()                                         { /* camera panning is bounded via panning limits in _initBabylon */ }
  // Phase 6: real fog visibility. Sums sight ranges across all alive entities
  // owned by `observerOwner` (same logic as 2D `_buildFogVisibleHexes`).
  // Delegates to the pure `buildFogVisibleSet` helper so the math is testable
  // without a Babylon context.
  _buildFogVisibleHexes(observerOwner)                { return buildFogVisibleSet(this.state, observerOwner); }

  // ─── Stubs (deferred to later phases / out of Phase 5 scope) ─────────────

  addDeathAnim(_col, _row, _color)                                           { /* later phase */ }
  addFadeOutAnim(_entityId, _duration)                                       { /* later phase */ }
  addNodeRevealAnim(_hexes, _color, _opts)                                   { /* Phase 6 — Hana */ }
  addSpawnAnim(_col, _row, _color)                                           { /* later phase */ }

  clearBattleHighlights()                             { /* later phase */ }
  setBattleHighlights(_combatantHexes, _allyHexes)    { /* later phase */ }

  // ─── Phase 5 anim methods (implementations below the class banner) ───────
  // addMoveAnim, addLungeAnim, returnAllLungeAnims, clearAllLungeAnims,
  // addProjectileAnim, clearAllProjectileAnims, addAttackAnim, addFlash,
  // addHpChangeFlash, clearFlashes, clearAnimations, waitForAnimations
  // are defined under the Phase 5 banner near the end of this class.

  getFadeOutOpacity(_entityId)                        { return 1; }
  getEntityScreenPositions(_col, _row, _entities, _rect)                     { return []; }
  getEntityScreenPos(_col, _row, _id, _stackIdx, _stackTotal, _rect)         { return null; }
  /**
   * Round 4: return a small data-URL portrait for the given asset id by
   * cropping the shared tilemap atlas. `ui.js` calls this for the unit-stats
   * bar, the plan-panel portrait map, the disambiguation arc, and the combat
   * dialog. The 2D Renderer has the same method on it — by implementing it
   * here too the UI layer doesn't have to branch on renderer mode.
   *
   * Cached per (assetId, size) — repeat lookups are O(1) after first build.
   * Falls back to null when the tilemap hasn't loaded yet or the id is
   * unknown; ui.js degrades to a glyph fallback in that case.
   */
  getPortraitDataURL(assetId, size = 128) {
    if (!assetId || !this._tilemapImg || !this._spriteRects) return null;
    if (typeof document === 'undefined') return null;
    const rect = this._spriteRects.get(assetId);
    if (!rect) return null;
    if (!this._portraitDataURLCache) this._portraitDataURLCache = new Map();
    const key = `${assetId}@${size}`;
    if (this._portraitDataURLCache.has(key)) {
      return this._portraitDataURLCache.get(key);
    }
    const c = document.createElement('canvas');
    c.width = c.height = size;
    c.getContext('2d').drawImage(
      this._tilemapImg,
      rect.x, rect.y, rect.size, rect.size,
      0, 0, size, size,
    );
    const url = c.toDataURL();
    this._portraitDataURLCache.set(key, url);
    return url;
  }

  /**
   * Round 4: terrain thumbnail used by the unit-stats bar's "current tile"
   * preview. We render a simple hex-cropped tile thumbnail (background colour
   * + sprite if available) — the 2D Renderer adds fortification rings and a
   * border, which we omit here as they were minor cues the 3D scene already
   * conveys at the camera level. Caller's UI degrades to "no terrain image"
   * if this returns null.
   */
  getTileDataURL(tile, col, row, size = 28) {
    if (!tile || typeof document === 'undefined') return null;
    if (!this._tileDataURLCache) this._tileDataURLCache = new Map();
    const cacheKey = `${tile.type}_${tile.building || ''}_${tile.fortifyLevel || 0}@${size}`;
    if (this._tileDataURLCache.has(cacheKey)) {
      return this._tileDataURLCache.get(cacheKey);
    }
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const hs = size / 2;
    _traceHexPath2D(ctx, hs, hs, hs - 0.5);
    const baseColor = _tileFillColor(tile);
    ctx.fillStyle = baseColor;
    ctx.fill();

    if (this._tilemapImg && this._spriteRects) {
      const spriteId = _terrainThumbSpriteId(tile, col, row);
      const rect = spriteId ? this._spriteRects.get(spriteId) : null;
      if (rect) {
        ctx.save();
        _traceHexPath2D(ctx, hs, hs, hs - 0.5);
        ctx.clip();
        ctx.drawImage(this._tilemapImg, rect.x, rect.y, rect.size, rect.size, 0, 0, size, size);
        ctx.restore();
      }
      // Building overlay sprite on top of dirt.
      if (tile.type === TileType.BUILDING && tile.building) {
        const bldgRect = this._spriteRects.get(tile.building);
        if (bldgRect) {
          ctx.save();
          _traceHexPath2D(ctx, hs, hs, hs - 0.5);
          ctx.clip();
          ctx.drawImage(this._tilemapImg, bldgRect.x, bldgRect.y, bldgRect.size, bldgRect.size, 0, 0, size, size);
          ctx.restore();
        }
      }
    }
    // Hex outline for a touch of grid definition.
    _traceHexPath2D(ctx, hs, hs, hs - 0.5);
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth = 0.8;
    ctx.stroke();

    const url = c.toDataURL();
    this._tileDataURLCache.set(cacheKey, url);
    return url;
  }

  // ─── Babylon scene setup ─────────────────────────────────────────────────

  async _initBabylon() {
    // Dynamic import keeps the module importable in node-test without Babylon.
    const BABYLON = await import(/* @vite-ignore */ BABYLON_CDN);
    this._babylon = BABYLON;

    const engine = new BABYLON.Engine(this.canvas, true, { preserveDrawingBuffer: true, stencil: true });
    const scene  = new BABYLON.Scene(engine);
    scene.clearColor = new BABYLON.Color4(0.05, 0.04, 0.07, 1.0); // dark gothic

    // Isometric ArcRotateCamera. Pan + zoom + yaw are user-controlled; tilt
    // (beta) stays locked at the isometric angle so the board always reads
    // top-downish, like a board-game camera.
    const camera = new BABYLON.ArcRotateCamera(
      'cam',
      this._lockedAlpha,
      this._lockedBeta,
      20,
      BABYLON.Vector3.Zero(),
      scene,
    );
    camera.attachControl(this.canvas, true);

    // Yaw (alpha) is unbounded — left-mouse drag rotates around the vertical
    // axis. Tilt (beta) is clamped around the isometric anchor so the player
    // can dip closer to head-on or rise to a more bird's-eye view, but can't
    // flip the board to look up from below or stare straight down. We rotate
    // the *camera*, not `mapRoot`, so world-space stays stable for picking +
    // `hexToCanvasPos` projection (see the note on hexToCanvasPos).
    camera.lowerAlphaLimit = null;
    camera.upperAlphaLimit = null;
    camera.lowerBetaLimit  = this._lockedBeta - CAMERA_BETA_LOWER_DELTA;
    camera.upperBetaLimit  = this._lockedBeta + CAMERA_BETA_UPPER_DELTA;

    // Zoom limits — close enough to see a single tile clearly, far enough to
    // hold a Campaign-size map without flying outside the scene.
    camera.lowerRadiusLimit = 4;
    camera.upperRadiusLimit = 80;
    camera.wheelDeltaPercentage = 0.02; // smoother wheel zoom
    camera.pinchDeltaPercentage = 0.005;

    // Pan controls. Babylon's ArcRotateCamera pans the target on the
    // camera-plane; the lower the panningSensibility the *faster* the pan.
    // 250 is brisk without feeling twitchy on a trackpad.
    camera.panningSensibility = 250;
    camera.panningInertia     = 0.85;
    // RMB drag pans by default; allow LMB to also pan since the renderer
    // doesn't yet wire selection picking.
    camera.useBouncingBehavior = false;

    // Round 4: swap touch gestures so the board feels like a map app —
    // single-finger drag pans, two-finger gestures rotate + pinch-zoom.
    // Babylon's default (single-finger rotate, two-finger pan+zoom) reads as
    // a 3D-viewer convention but tested poorly on mobile where players
    // expected map-style panning.
    //
    // Implementation: we monkey-patch the bound `onTouch` / `onMultiTouch`
    // methods on the camera's pointers input. Desktop mouse behaviour is
    // preserved (we sniff `point.pointerType` and only swap for touch).
    this._installMobileGestureSwap(camera, BABYLON);

    const light = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0.3), scene);
    light.intensity = 0.95;

    this._engine = engine;
    this._scene  = scene;
    this._camera = camera;
    this._light  = light;

    // Phase 6: GlowLayer powers the selection halo and the power-node discs.
    // Round 4: switched to *include-only* mode — meshes have to be explicitly
    // added via `addIncludedOnlyMesh` to contribute to the bloom. Previously
    // any mesh with non-zero emissive (HP bars, waypoint badges, floating
    // text, plan/highlight discs) joined the glow and blew it out at zoomed-
    // out distances. Node discs and the selected standee's base disc are the
    // only meshes that should glow; we register them on creation/selection.
    this._glowLayer = new BABYLON.GlowLayer('glow', scene, { mainTextureFixedSize: 512 });
    this._glowLayer.intensity = GLOW_LAYER_INTENSITY;

    // Apply the starting phase's lighting immediately (no transition) so the
    // very first frame already reads dawn/day/dusk/night correctly.
    this._lastPhase   = this.state?.phase ?? null;
    this._lightState  = { intensity: 0, color: { r: 1, g: 1, b: 1 }, clear: { r: 0, g: 0, b: 0 } };
    this._applyLightConfig(getPhaseLightConfig(this._lastPhase));

    // Per-frame pump: drives phase-light interpolation and selection / node glow pulses.
    this._onBeforeRenderObs = scene.onBeforeRenderObservable.add(() => this._onBeforeRender());

    // Build the map from current state and frame it (instant — no animation
    // on the very first frame, otherwise the camera "slides in" from the
    // arbitrary radius=20 starting point).
    this._buildMap();
    this._frameFullMap({ instant: true });
    // Initial standee population so the first frame already has units.
    this._syncEntityStandees();
    this._applySelectionAndFocus();
    this._syncNodeGlowMeshes();
    this._applyFogVeil();

    engine.runRenderLoop(() => scene.render());
    engine.resize();
  }

  /**
   * Round 4 mobile gesture swap. The default ArcRotateCameraPointersInput
   * does single-finger-rotate / two-finger-pan-and-zoom; we want the inverse
   * for touch (single-finger pan, two-finger rotate, pinch-zoom unchanged).
   * Mouse input is left untouched: we sniff `point.pointerType` in onTouch
   * and only divert when the pointer is a touch.
   *
   * Public-method override is brittle if Babylon changes its internal Math
   * later, but this is the only practical hook — they don't expose a flag
   * for the swap. If a future Babylon upgrade regresses, this method is
   * easy to gut.
   */
  _installMobileGestureSwap(camera, BABYLON) {
    const ptr = camera?.inputs?.attached?.pointers;
    if (!ptr) return;
    const originalOnTouch = ptr.onTouch?.bind(ptr);
    ptr.onTouch = function (point, offsetX, offsetY) {
      // Pointer type unknown OR mouse → keep Babylon's default behaviour.
      if (!point || (point.pointerType && point.pointerType !== 'touch')) {
        if (originalOnTouch) originalOnTouch(point, offsetX, offsetY);
        return;
      }
      // Single-finger touch: pan instead of rotate.
      // The signs here mirror Babylon's internal panning math so the gesture
      // direction matches what the user's finger does.
      this.camera.inertialPanningX += -offsetX / (this.panningSensibility || 1);
      this.camera.inertialPanningY += offsetY / (this.panningSensibility || 1);
    };
    // Two-finger gestures: rotate yaw/pitch instead of panning, keep pinch
    // zoom enabled. We compute rotation from the *average* movement of the
    // two touch points (multiTouchPanPosition tracks the midpoint each frame).
    ptr.multiTouchPanning      = false;
    ptr.multiTouchPanAndZoom   = false;
    ptr.onMultiTouch = function (
      pointA, pointB,
      previousPinchSquaredDistance, pinchSquaredDistance,
      previousMultiTouchPanPosition, multiTouchPanPosition,
    ) {
      // Pinch zoom — same formula Babylon uses internally; lifted directly so
      // the feel matches the default.
      if (previousPinchSquaredDistance !== 0 && pinchSquaredDistance !== 0) {
        const pinchDelta = (pinchSquaredDistance - previousPinchSquaredDistance)
          * (this.pinchPrecision || 12) / (this.angularSensibilityX * 1000);
        this.camera.inertialRadiusOffset -= pinchDelta;
      }
      // Two-finger drag → rotate the camera. dx/dy is the midpoint travel
      // since the previous frame; we feed it into the same alpha/beta
      // accumulators the single-touch path used to feed.
      if (previousMultiTouchPanPosition && multiTouchPanPosition) {
        const dx = multiTouchPanPosition.x - previousMultiTouchPanPosition.x;
        const dy = multiTouchPanPosition.y - previousMultiTouchPanPosition.y;
        this.camera.inertialAlphaOffset -= dx / (this.angularSensibilityX || 1000);
        this.camera.inertialBetaOffset  -= dy / (this.angularSensibilityY || 1000);
      }
    };
  }

  // ─── Map construction ────────────────────────────────────────────────────

  /** Build one cylinder per tile, plus road/bridge decks and building boxes.
   *  Uses individual meshes (not thin instances) for Phase 2 — simpler to
   *  pick and easier to debug. Materials are cached by colour so the GPU
   *  state count stays low (~10 materials regardless of map size). */
  _buildMap() {
    if (this._mapBuilt) return;
    if (!this.state?.tiles || this.state.tiles.size === 0) return;

    const BABYLON = this._babylon;
    const scene   = this._scene;

    const mapRoot = new BABYLON.TransformNode('mapRoot', scene);
    this._mapRoot = mapRoot;

    // Reusable shared geometry — clone for each instance, all parented to mapRoot.
    // (We do not yet use Babylon InstancedMesh; one mesh per tile keeps picking
    // trivially correct and Phase 2 maps are well under 1000 tiles.)
    for (const tile of this.state.tiles.values()) {
      this._buildTileMesh(tile, mapRoot);
    }
    // Item 2: after every per-tile mesh exists, lay down the bezier road and
    // river networks on top of the grass tiles. Built once at map-load and
    // never rebuilt (the map topology is immutable once a game has started).
    this._buildRoadRiverNetworks();
    this._mapBuilt = true;
  }

  _buildTileMesh(tile, parent) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    const { x, z } = hexToWorld(tile.col, tile.row);

    // ── Base hex prism ────────────────────────────────────────────────────
    const baseColor = tileColorFor(tile);
    const hex = BABYLON.MeshBuilder.CreateCylinder(
      `tile_${tile.col}_${tile.row}`,
      { tessellation: 6, height: 0.15, diameter: 2 * HEX_RADIUS_WORLD },
      scene,
    );
    hex.parent     = parent;
    hex.position.x = x;
    hex.position.z = z;
    hex.position.y = 0;
    // Pointy-top alignment: default cylinder has a vertex on +X; rotate 30°
    // so vertices land at ±Z (visually aligns with the odd-row offset).
    hex.rotation.y = Math.PI / 6;
    hex.material   = this._materialFor(baseColor);
    hex.metadata   = { kind: 'tile', col: tile.col, row: tile.row, baseColor };
    this._tileMeshes.push(hex);
    const tkey = hexKey(tile.col, tile.row);
    this._tileMeshByKey.set(tkey, hex);
    const props = [];
    const trackProp = (m) => { props.push(m); };

    // ── Textured top face (when a terrain sprite exists) ─────────────────
    const topDisc = this._buildTileTopDisc(tile, parent);
    if (topDisc) {
      this._tileTopDiscByKey.set(tkey, topDisc);
      trackProp(topDisc);
    }

    // ── Forests: a small cluster of varied cones in the unified tile-slot
    // positions, leaving the centre slot clear for an entity standee.
    // Layout is deterministic per (col, row) so the same hex always shows the
    // same cluster across runs. See forestTreesForHex / TILE_SLOTS.
    if (tile.type === TileType.FOREST) {
      const treeMat = this._materialFor('#234c1f'); // shared green material
      const trees = forestTreesForHex(tile.col, tile.row);
      for (let i = 0; i < trees.length; i++) {
        const t = trees[i];
        const cone = BABYLON.MeshBuilder.CreateCylinder(
          `forest_${tile.col}_${tile.row}_${i}`,
          { diameterTop: 0, diameterBottom: 0.7, height: 0.9, tessellation: 8 },
          scene,
        );
        cone.parent     = parent;
        cone.position.x = x + t.x;
        cone.position.z = z + t.z;
        cone.position.y = 0.45 * t.scale;
        cone.scaling.x  = t.scale;
        cone.scaling.y  = t.scale;
        cone.scaling.z  = t.scale;
        cone.material   = treeMat;
        cone.isPickable = false; // pick the tile underneath, not the prop
        trackProp(cone);
      }
    }

    // Road/river ROAD/RIVER tiles get NO per-tile prop here — the bezier
    // network mesh built in _buildRoadRiverNetworks() (after this loop)
    // carries the visual. The grass-coloured cylinder + textured top disc
    // above is what shows on either side of the path.

    // ── Bridge: wooden planks crossing the river hex ──────────────────────
    // Plank Y raised so the plank bottom sits clear of the river tube's top
    // (RIVER_TUBE_Y + RIVER_TUBE_RADIUS ≈ 0.235). bottom = pos.y − 0.06,
    // so pos.y = 0.30 → bottom 0.24, above the river ribbon.
    if (tile.type === TileType.BRIDGE) {
      const plank = BABYLON.MeshBuilder.CreateBox(
        `bridge_${tile.col}_${tile.row}`,
        { width: 1.7, height: 0.12, depth: 0.7 },
        scene,
      );
      plank.parent     = parent;
      plank.position.x = x;
      plank.position.z = z;
      plank.position.y = 0.30;
      plank.rotation.y = bridgeRotationY(tile, this.state.tiles);
      plank.material   = this._materialFor('#8a6030');
      plank.isPickable = false;
      trackProp(plank);
    }

    // ── Building: simple low-poly box atop the tile, building-coloured ────
    // Positioned via the unified tile-slot system: building lives in slot 1
    // (BUILDING_SLOT_INDEX, the "NE" outer slot). A standee on the same hex
    // takes the centre slot, so silhouettes don't overlap.
    if (tile.type === TileType.BUILDING && tile.building) {
      const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
      const box = BABYLON.MeshBuilder.CreateBox(
        `bldg_${tile.col}_${tile.row}`,
        { width: 0.55, height: 0.7, depth: 0.55 },
        scene,
      );
      box.parent     = parent;
      box.position.x = x + slot.x;
      box.position.z = z + slot.z;
      box.position.y = 0.43; // sit on top of the tile prism
      box.material   = this._materialFor(BUILDING_COLOR[tile.building] || '#8a7a5a');
      box.isPickable = false;
      trackProp(box);

      // Tiny roof block to add silhouette variety.
      const roof = BABYLON.MeshBuilder.CreateBox(
        `roof_${tile.col}_${tile.row}`,
        { width: 0.62, height: 0.15, depth: 0.62 },
        scene,
      );
      roof.parent     = parent;
      roof.position.x = x + slot.x;
      roof.position.z = z + slot.z;
      roof.position.y = 0.85;
      roof.material   = this._materialFor('#2c2520');
      roof.isPickable = false;
      trackProp(roof);
    }

    if (props.length > 0) this._tilePropsByKey.set(tkey, props);

    // Register this tile's static occupants (building + forest trees) so the
    // per-draw standee re-slot pass knows which slots are already consumed.
    // Tile types are mutually exclusive — at most one of {building, trees}
    // exists per tile, never both.
    const staticOcc = [];
    if (tile.type === TileType.BUILDING && tile.building) {
      staticOcc.push({ id: 'building', kind: 'building' });
    } else if (tile.type === TileType.FOREST) {
      const trees = forestTreesForHex(tile.col, tile.row);
      for (const t of trees) staticOcc.push({ id: t.id, kind: 'tree' });
    }
    if (staticOcc.length > 0) this._staticOccupantsByKey.set(tkey, staticOcc);
  }

  // ─── Item 2: bezier road + river networks ────────────────────────────────
  //
  // Build two merged tube meshes — one for the river, one for the road —
  // overlaying the grass-coloured tile cylinders. Geometry comes from the
  // pure helpers `buildRiverNetworkStrokes` / `buildRoadNetworkStrokes`,
  // which mirror the 2D renderer's per-tile bezier construction. Each tile
  // contributes one through-bezier (optionally plus straight spokes at
  // junctions); the per-tile tubes are merged with Mesh.MergeMeshes so the
  // GPU sees ONE draw call per network regardless of map size.
  _buildRoadRiverNetworks() {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    if (!BABYLON || !scene || !this.state?.tiles) return;

    const riverStrokes = buildRiverNetworkStrokes(this.state.tiles);
    const roadStrokes  = buildRoadNetworkStrokes(this.state.tiles);

    if (riverStrokes.length > 0) {
      this._riverNetworkMesh = this._buildNetworkMesh(
        'river', riverStrokes, RIVER_TUBE_RADIUS, RIVER_TUBE_Y,
        TILE_COLOR[TileType.RIVER],
      );
    }
    if (roadStrokes.length > 0) {
      this._roadNetworkMesh = this._buildNetworkMesh(
        'road', roadStrokes, ROAD_TUBE_RADIUS, ROAD_TUBE_Y,
        TILE_COLOR[TileType.ROAD],
      );
    }
  }

  /** Build a single merged tube mesh for one network (river OR road).
   *  Each stroke becomes one CreateTube call; MergeMeshes collapses them all
   *  into one mesh sharing one material. Returns the merged mesh (or null
   *  if MergeMeshes refused — which happens when the source list is empty). */
  _buildNetworkMesh(networkName, segments, radius, yPos, cssColor) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    if (!segments || segments.length === 0) return null;
    const tubes = [];
    for (let s = 0; s < segments.length; s++) {
      const { tile, strokes } = segments[s];
      for (let i = 0; i < strokes.length; i++) {
        const pts = strokes[i];
        if (!pts || pts.length < 2) continue;
        const path = pts.map(p => new BABYLON.Vector3(p.x, yPos, p.z));
        const tube = BABYLON.MeshBuilder.CreateTube(
          `${networkName}_${tile.col}_${tile.row}_${i}`,
          { path, radius, tessellation: 8, cap: BABYLON.Mesh.CAP_ALL, updatable: false },
          scene,
        );
        tube.isPickable = false;
        tubes.push(tube);
      }
    }
    if (tubes.length === 0) return null;
    // MergeMeshes(meshes, disposeSource=true, allow32BitsIndices=true,
    //   meshSubclass=undefined, subdivideWithSubMeshes=false, multiMultiMaterials=false)
    const merged = BABYLON.Mesh.MergeMeshes(tubes, true, true, undefined, false, false);
    if (!merged) return null;
    merged.parent     = this._mapRoot;
    merged.isPickable = false;
    merged.material   = this._materialFor(cssColor);
    merged.name       = `${networkName}Network`;
    return merged;
  }

  /** Cache a StandardMaterial per CSS hex colour so we hand a few materials
   *  to the GPU regardless of tile count. */
  _materialFor(hexColor) {
    if (this._materialCache.has(hexColor)) return this._materialCache.get(hexColor);
    const BABYLON = this._babylon;
    const [r, g, b] = cssHexToRgb01(hexColor);
    const mat = new BABYLON.StandardMaterial(`mat_${hexColor}`, this._scene);
    mat.diffuseColor  = new BABYLON.Color3(r, g, b);
    mat.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04); // matte
    this._materialCache.set(hexColor, mat);
    return mat;
  }

  // ─── Tile top-face textures ──────────────────────────────────────────────
  //
  // Asset layout (mirrors src/renderer.js):
  //   • single texture atlas at assets/tilemap.png (≈7 MB), pre-loaded by
  //     loadImages() into `this._tilemapImg` + `this._spriteRects`.
  //   • terrain sprites in the atlas: grass_1..5, forest_1..5, dirt_1..5,
  //     plus single-variant road / river / bridge.
  //   • per-tile variant is picked by terrainSpriteIdFor(tile, col, row),
  //     a pure function that re-uses the 2D renderer's hash so the same
  //     hex always picks the same sprite across sessions.
  //
  // Which terrains get a texture vs which fall back to solid colour:
  //   GRASS, DIRT, FOREST, BUILDING (uses dirt base) → textured top face.
  //   ROAD, RIVER, BRIDGE → solid colour. They already carry their own
  //   prop meshes (road deck, bridge plank) and a coloured river surface;
  //   layering a grass underlay would muddle that signal.
  //
  // Geometry choice: option (b) from the brief — a flat hexagonal disc on
  // top of the unchanged colour cylinder. Default disc UVs map the sprite
  // into the inscribed circle of the unit square, which covers a regular
  // hex without distortion. Disc lives in the prop array so the fog veil
  // hides it on out-of-sight tiles (the dim colour cylinder then reads as
  // "fogged terrain") and the solid colour cylinder underneath supplies
  // the side walls so the prism still looks thick.

  /** Cached `BABYLON.Texture` for a single terrain sprite id, cropped out
   *  of the shared tilemap into an offscreen canvas. Returns null when the
   *  tilemap hasn't loaded, the sprite id isn't in the rect map, or we're
   *  in a non-DOM environment (node-test). */
  _terrainTextureFor(spriteId) {
    if (!spriteId || !this._tilemapImg || !this._spriteRects) return null;
    if (this._terrainTextureCache.has(spriteId)) return this._terrainTextureCache.get(spriteId);
    const rect = this._spriteRects.get(spriteId);
    if (!rect) {
      if (!this._textureWarnedFor.has(spriteId)) {
        this._textureWarnedFor.add(spriteId);
        console.warn(`[Renderer3D] no atlas rect for terrain sprite '${spriteId}', falling back to solid colour`);
      }
      return null;
    }
    if (typeof document === 'undefined') return null;
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 256;
      c.getContext('2d').drawImage(
        this._tilemapImg,
        rect.x, rect.y, rect.size, rect.size,
        0, 0, c.width, c.height,
      );
      const BABYLON = this._babylon;
      const tex = new BABYLON.Texture(
        c.toDataURL(), this._scene, true, false,
        BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
      );
      this._terrainTextureCache.set(spriteId, tex);
      return tex;
    } catch (err) {
      if (!this._textureWarnedFor.has(spriteId)) {
        this._textureWarnedFor.add(spriteId);
        console.warn(`[Renderer3D] failed to build terrain texture '${spriteId}':`, err);
      }
      return null;
    }
  }

  /** Cached textured StandardMaterial for one terrain sprite id. Returns null
   *  if the texture isn't available — callers fall back to the solid-colour
   *  material returned by `_materialFor` for the tile's colour. */
  _terrainMaterialFor(spriteId) {
    if (!spriteId) return null;
    if (this._terrainMaterialCache.has(spriteId)) return this._terrainMaterialCache.get(spriteId);
    const tex = this._terrainTextureFor(spriteId);
    if (!tex) return null;
    const BABYLON = this._babylon;
    const mat = new BABYLON.StandardMaterial(`terrain_${spriteId}`, this._scene);
    mat.diffuseTexture = tex;
    mat.specularColor  = new BABYLON.Color3(0.04, 0.04, 0.04); // matte, picks up phase light
    this._terrainMaterialCache.set(spriteId, mat);
    return mat;
  }

  /** Build (and return) a thin hex-shaped disc that sits flush with the top of
   *  the tile cylinder, textured with the matching terrain sprite. Returns
   *  null for tile types that have no sprite (road/river/bridge) or when the
   *  tilemap isn't ready — the solid-colour cylinder then carries the look. */
  _buildTileTopDisc(tile, parent) {
    const spriteId = terrainSpriteIdFor(tile, tile.col, tile.row);
    if (!spriteId) return null;
    const mat = this._terrainMaterialFor(spriteId);
    if (!mat) return null;

    const BABYLON = this._babylon;
    const { x, z } = hexToWorld(tile.col, tile.row);
    const disc = BABYLON.MeshBuilder.CreateDisc(
      `tiletop_${tile.col}_${tile.row}`,
      { tessellation: 6, radius: HEX_RADIUS_WORLD * TERRAIN_DISC_RADIUS_MUL },
      this._scene,
    );
    disc.parent     = parent;
    disc.position.x = x;
    disc.position.z = z;
    // Cylinder top is at height/2 = 0.075; lift the disc by a tiny ε so the
    // textured face wins the depth fight against the cylinder's coloured top.
    disc.position.y = TERRAIN_DISC_Y_OFFSET;
    // Lay the disc flat (face up along +Y) and align its pointy-top hex
    // edges with the underlying cylinder.
    disc.rotation.x = -Math.PI / 2;
    disc.rotation.y =  Math.PI / 6;
    disc.material   = mat;
    disc.isPickable = false; // let the cylinder underneath receive clicks
    return disc;
  }

  /** Retro-fit textured discs onto an already-built map. No-op when called
   *  before the map exists; safe to call repeatedly (skips tiles that already
   *  have a disc). Used by `loadImages` when the tilemap finishes loading
   *  after `_initBabylon` has already laid down solid-colour tiles. */
  _upgradeTileTextures() {
    if (!this._mapBuilt || !this._mapRoot || !this._scene || !this._tilemapImg) return;
    if (!this.state?.tiles) return;
    for (const tile of this.state.tiles.values()) {
      const tkey = hexKey(tile.col, tile.row);
      if (this._tileTopDiscByKey.has(tkey)) continue;
      const disc = this._buildTileTopDisc(tile, this._mapRoot);
      if (!disc) continue;
      this._tileTopDiscByKey.set(tkey, disc);
      // Honor existing fog state: _applyFogVeil's diff loop skips already-fogged
      // tiles, so a disc created after fog was applied would stay visible.
      if (this._fogActiveSet.has(tkey)) disc.isVisible = false;
      const props = this._tilePropsByKey.get(tkey);
      if (props) props.push(disc);
      else this._tilePropsByKey.set(tkey, [disc]);
    }
  }

  _frameFullMap(opts = {}) {
    if (!this.state?.tiles || this.state.tiles.size === 0) return;
    const all = [];
    for (const tile of this.state.tiles.values()) all.push({ col: tile.col, row: tile.row });
    this.frameHexes(all, { paddingHexes: 1, instant: opts.instant === true });
  }

  /** Wraps the pure `radiusForFit` helper with this camera's FOV/aspect and
   *  clamps to the camera's radius limits. */
  _radiusForFit(fitWidth, fitDepth) {
    const aspect = this._engine
      ? this._engine.getRenderWidth() / Math.max(1, this._engine.getRenderHeight())
      : 16 / 9;
    const fov = this._camera.fov || 0.8;
    const radius = radiusForFit(fitWidth, fitDepth, aspect, fov);
    return Math.max(
      this._camera.lowerRadiusLimit ?? 1,
      Math.min(this._camera.upperRadiusLimit ?? 200, radius),
    );
  }

  // ─── Phase 3: entities & selection ─────────────────────────────────────────
  //
  // Standees are billboarded textured planes sitting on solid coloured discs,
  // one pair per entity. Selection state lives in `this.selectedEntityId` —
  // written from ui.js _selectEntity() via the renderer-agnostic interface
  // (the 2D path reads the same property in its draw loop). draw() runs the
  // diff every redraw; standees are added/removed/moved incrementally.

  /** Compute a stable "owner key" we can use to colour a standee's base disc.
   *  Prefer the entity's per-player colour (`e.color` is set by the game on
   *  leaders and propagated to summons/recruits); fall back to the faction
   *  primary colour and finally a neutral grey for stray neutrals. */
  _ownerColorFor(entity) {
    if (entity?.color) return entity.color;
    if (entity?.owner) {
      const theme = getFactionTheme(entity.owner);
      if (theme?.primary) return theme.primary;
    }
    return '#888888';
  }

  /** Map an entity to the asset id used by the tilemap sprite atlas. */
  _assetIdFor(entity) {
    if (!entity) return null;
    if (entity.type === EntityType.SURVIVOR) {
      return Renderer.survivorAssetId(entity.title);
    }
    // Non-survivor types map 1:1 onto the asset ids ('paladin', 'witch', ...).
    return entity.type;
  }

  /** Lazy-create (and cache) a Babylon Texture for a given sprite asset id by
   *  cropping it out of the tilemap into an offscreen canvas. Returns null if
   *  the tilemap hasn't loaded or the asset id is unknown — caller falls back
   *  to a plain coloured plane. */
  _portraitTextureFor(assetId) {
    if (!assetId || !this._tilemapImg || !this._spriteRects) return null;
    if (this._portraitTextures.has(assetId)) return this._portraitTextures.get(assetId);
    const rect = this._spriteRects.get(assetId);
    if (!rect) return null;
    if (typeof document === 'undefined') return null;
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    c.getContext('2d').drawImage(
      this._tilemapImg,
      rect.x, rect.y, rect.size, rect.size,
      0, 0, c.width, c.height,
    );
    const BABYLON = this._babylon;
    // Babylon defaults: noMipmap=false, invertY=true (matches HTML image origin).
    // We previously passed `true, false` here which disabled mipmaps AND flipped
    // V — the V-flip rendered the back face of the plane, hiding the portrait
    // behind the standee material when backFaceCulling kicked in. Use defaults.
    const tex = new BABYLON.Texture(c.toDataURL(), this._scene);
    tex.hasAlpha = true;
    this._portraitTextures.set(assetId, tex);
    return tex;
  }

  /** Per-asset plane material, textured with the entity portrait (or a flat
   *  diffuse fallback when the tilemap is unavailable). */
  _planeMaterialFor(assetId) {
    const key = assetId ?? '__blank__';
    if (this._portraitMaterials.has(key)) return this._portraitMaterials.get(key);
    const BABYLON = this._babylon;
    const mat = new BABYLON.StandardMaterial(`standee_${key}`, this._scene);
    const tex = this._portraitTextureFor(assetId);
    if (tex) {
      mat.diffuseTexture     = tex;
      mat.opacityTexture     = tex;
      mat.useAlphaFromDiffuseTexture = true;
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      // Emissive so portraits read at any phase / light angle.
      mat.emissiveColor = new BABYLON.Color3(0.4, 0.4, 0.4);
    } else {
      // Tilemap unavailable — use neutral pale fill so the plane still reads.
      mat.diffuseColor  = new BABYLON.Color3(0.85, 0.85, 0.85);
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
    }
    mat.backFaceCulling = false; // BillboardMode rotates plane — both sides visible
    this._portraitMaterials.set(key, mat);
    return mat;
  }

  /** Per-owner base material (filled with the player's colour). */
  _baseMaterialForOwner(ownerKey) {
    if (this._baseMaterialCache.has(ownerKey)) return this._baseMaterialCache.get(ownerKey);
    const BABYLON = this._babylon;
    const [r, g, b] = cssHexToRgb01(ownerKey);
    const mat = new BABYLON.StandardMaterial(`base_${ownerKey}`, this._scene);
    mat.diffuseColor  = new BABYLON.Color3(r, g, b);
    mat.specularColor = new BABYLON.Color3(0.04, 0.04, 0.04);
    this._baseMaterialCache.set(ownerKey, mat);
    return mat;
  }

  /** Cyan glow material applied to the selected entity's base. */
  _getSelectedBaseMaterial() {
    if (this._selectedBaseMaterial) return this._selectedBaseMaterial;
    const BABYLON = this._babylon;
    const mat = new BABYLON.StandardMaterial('base_selected', this._scene);
    mat.diffuseColor  = new BABYLON.Color3(0.20, 0.85, 0.95);
    mat.emissiveColor = new BABYLON.Color3(0.25, 0.85, 0.95);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    this._selectedBaseMaterial = mat;
    return mat;
  }

  /** Build the {plane, base} mesh pair for a single entity. */
  _buildStandeeMesh(entity) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    const leader  = isLeaderType(entity.type);
    const wMul    = leader ? STANDEE_LEADER_WIDTH_MUL  : 1;
    const hMul    = leader ? STANDEE_LEADER_HEIGHT_MUL : 1;

    const plane = BABYLON.MeshBuilder.CreatePlane(
      `unit_${entity.id}`,
      { width: STANDEE_BASE_WIDTH * wMul, height: STANDEE_BASE_HEIGHT * hMul },
      scene,
    );
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
    plane.material      = this._planeMaterialFor(this._assetIdFor(entity));
    plane.metadata      = { kind: 'entity', entityId: entity.id, col: entity.col, row: entity.row };

    const base = BABYLON.MeshBuilder.CreateCylinder(
      `unitbase_${entity.id}`,
      {
        tessellation: 24,
        height:   STANDEE_BASE_THICKNESS,
        diameter: STANDEE_BASE_DIAMETER * (leader ? 1.15 : 1),
      },
      scene,
    );
    base.material = this._baseMaterialForOwner(this._ownerColorFor(entity));
    // Don't pick on the base — let the camera-facing plane be the click target
    // for a more predictable hit area.
    base.isPickable = false;

    this._positionStandee({ plane, base, leader }, entity);
    return { plane, base, leader };
  }

  /** Place an existing standee on its entity's tile. By default centres on
   *  the hex; `opts.x` / `opts.z` override with an explicit world position
   *  (used by the tile-slot re-pass when a hex hosts more than one occupant). */
  _positionStandee(standee, entity, opts = {}) {
    const base = hexToWorld(entity.col, entity.row);
    const x = typeof opts.x === 'number' ? opts.x : base.x;
    const z = typeof opts.z === 'number' ? opts.z : base.z;
    const hMul = standee.leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
    standee.plane.position.x = x;
    standee.plane.position.z = z;
    // Sprite vertical centre = base disc top + half plane height.
    standee.plane.position.y = STANDEE_BASE_Y_OFFSET
      + STANDEE_BASE_THICKNESS / 2
      + (STANDEE_BASE_HEIGHT * hMul) / 2;
    standee.base.position.x = x;
    standee.base.position.z = z;
    standee.base.position.y = STANDEE_BASE_Y_OFFSET;
    // Keep the metadata's col/row in sync so picking returns the current tile.
    standee.plane.metadata.col = entity.col;
    standee.plane.metadata.row = entity.row;
  }

  /** Diff the state's live entities against the standee map: add new ones,
   *  remove dead/missing ones, move kept ones to their current hex. */
  _syncEntityStandees() {
    if (!this._scene || !this.state?.entities) return;
    const seen = new Set();
    for (const e of this.state.entities) {
      if (!e || !e.alive) continue;
      if (typeof e.col !== 'number' || typeof e.row !== 'number') continue;
      seen.add(e.id);
      let standee = this._entityStandees.get(e.id);
      if (!standee) {
        standee = this._buildStandeeMesh(e);
        this._entityStandees.set(e.id, standee);
      } else if (!this._activeMoveIds.has(e.id) && !this._activeLungeIds.has(e.id)) {
        // Skip snapping while a move/lunge animation is driving this standee —
        // otherwise the per-frame redraw would yank the mesh back to the
        // state's destination and cancel the animation visually.
        this._positionStandee(standee, e);
        // Owner colour can change (e.g. recruit changing sides — defensive).
        const expected = this._baseMaterialForOwner(this._ownerColorFor(e));
        // If the entity is currently selected, _applySelectionAndFocus owns the
        // base material — don't fight it here.
        if (standee.base.material !== this._getSelectedBaseMaterial()
            && standee.base.material !== expected) {
          standee.base.material = expected;
        }
      }
      // Phase 5: keep the HP bar in step with the entity. Cheap when the ratio
      // hasn't changed — the dynamic texture is only redrawn on delta.
      this._syncHpBar(standee, e);
    }
    // Dispose standees for entities that no longer exist or just died.
    for (const [id, standee] of this._entityStandees) {
      if (!seen.has(id)) {
        this._disposeHpBar(id);
        standee.plane.dispose();
        standee.base.dispose();
        this._entityStandees.delete(id);
      }
    }
    // Item 8: after the per-entity position step above, re-slot any hex that
    // has more than one occupant. Cheap walk — typically only a handful of
    // hexes have co-tenants. Also manages the +N overflow badge.
    this._resyncTileSlotsForStandees();
  }

  /** Re-position standees on hexes with multiple occupants (building + standee,
   *  forest + standee, or 2+ standees) so each occupant lives in its own slot.
   *  Trees + buildings stay where _buildTileMesh placed them (their slot
   *  assignment is stable); only standee positions change here. Also keeps
   *  the +N overflow badge in sync per-hex. */
  _resyncTileSlotsForStandees() {
    if (!this._scene || !this._babylon || !this.state?.entities) return;

    // Group live standees by hex. Skip entities whose standee is currently
    // being driven by a move/lunge animation (their position is owned by the
    // animation; let it land first, the next draw re-slots them).
    const byHex = new Map(); // hexKey → [{id, kind:'standee', entity, ...}]
    const hexCenter = new Map(); // hexKey → {col, row}
    for (const e of this.state.entities) {
      if (!e?.alive) continue;
      if (typeof e.col !== 'number' || typeof e.row !== 'number') continue;
      if (this._activeMoveIds.has(e.id) || this._activeLungeIds.has(e.id)) continue;
      if (!this._entityStandees.has(e.id)) continue;
      const k = hexKey(e.col, e.row);
      if (!byHex.has(k)) { byHex.set(k, []); hexCenter.set(k, { col: e.col, row: e.row }); }
      byHex.get(k).push({ id: `standee_${e.id}`, kind: 'standee', entity: e });
    }

    const seenHexes = new Set();
    for (const [k, standeeOccs] of byHex) {
      seenHexes.add(k);
      const staticOcc = this._staticOccupantsByKey.get(k) ?? [];
      // Single standee on an empty hex → nothing to re-slot, the standee
      // already sits at hex centre from _positionStandee's default path.
      if (standeeOccs.length === 1 && staticOcc.length === 0) {
        this._syncOverflowBadge(k, 0);
        continue;
      }
      const { col, row } = hexCenter.get(k);
      const { positionByOccupantId, overflow } = tileSlotWorldPositions(
        col, row, [...staticOcc, ...standeeOccs],
      );
      for (const occ of standeeOccs) {
        const pos = positionByOccupantId.get(occ.id);
        const standee = this._entityStandees.get(occ.entity.id);
        if (!pos || !standee) continue;
        this._positionStandee(standee, occ.entity, { x: pos.x, z: pos.z });
      }
      this._syncOverflowBadge(k, overflow, col, row);
    }
    // Clear badges on hexes that no longer host standees.
    for (const k of [...this._overflowBadges.keys()]) {
      if (!seenHexes.has(k)) this._syncOverflowBadge(k, 0);
    }
  }

  /** Lazily create / update / dispose the "+N" badge plane above a hex.
   *  Reuses the dynamic-texture + billboard-plane pattern from plan-step
   *  badges (see `_syncPlanArrows`). Idempotent — only repaints the texture
   *  when N changes, and disposes the mesh when N drops back to 0. */
  _syncOverflowBadge(k, overflow, col, row) {
    const BABYLON = this._babylon;
    const scene   = this._scene;
    const existing = this._overflowBadges.get(k);

    if (overflow <= 0) {
      if (existing) {
        existing.plane?.dispose();
        existing.mat?.dispose();
        existing.tex?.dispose();
        this._overflowBadges.delete(k);
      }
      return;
    }
    if (!BABYLON || !scene || typeof document === 'undefined') return;

    if (existing && existing.lastN === overflow) return;

    // Repaint texture (existing badge) or build a fresh one.
    let badge = existing;
    if (!badge) {
      const tex = new BABYLON.DynamicTexture(
        `overflowTex_${k}`, { width: 64, height: 64 }, scene, false,
      );
      tex.hasAlpha = true;
      const mat = new BABYLON.StandardMaterial(`overflowMat_${k}`, scene);
      mat.diffuseTexture = tex;
      mat.opacityTexture = tex;
      mat.useAlphaFromDiffuseTexture = true;
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
      mat.backFaceCulling = false;
      const plane = BABYLON.MeshBuilder.CreatePlane(
        `overflow_${k}`, { width: 0.55, height: 0.55 }, scene,
      );
      plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
      plane.isPickable    = false;
      plane.material      = mat;
      // Park position above the hex centre. (col,row) is guaranteed when we
      // arrive with overflow > 0 — calls from the "clear stale" loop pass
      // overflow === 0 and exit above.
      const { x, z } = hexToWorld(col, row);
      plane.position.set(x, 1.4, z);
      badge = { plane, mat, tex, lastN: 0 };
      this._overflowBadges.set(k, badge);
    }

    const ctx = badge.tex.getContext();
    ctx.clearRect(0, 0, 64, 64);
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#ffd060';
    ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 30px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${overflow}`, 32, 34);
    badge.tex.update();
    badge.lastN = overflow;
  }

  /** Restore a standee's owner base material (clearing the selection glow). */
  _restoreBaseColor(standee, entityId) {
    const entity = this.state?.entities?.find?.(e => e.id === entityId);
    if (!entity) return;
    standee.base.material = this._baseMaterialForOwner(this._ownerColorFor(entity));
  }

  /** Apply the renderer's selectedEntityId: swap base materials to highlight
   *  the chosen unit, restore previous selection, and slide the camera target
   *  to the new selection. */
  _applySelectionAndFocus() {
    if (!this._scene) return;
    const newId  = this.selectedEntityId ?? null;
    const prevId = this._lastSelectedEntityId;
    if (newId === prevId) return;

    if (prevId && this._entityStandees.has(prevId)) {
      const prev = this._entityStandees.get(prevId);
      this._restoreBaseColor(prev, prevId);
      // Round 4: drop the previous standee from the GlowLayer's include-only
      // set so its (now non-emissive) base no longer counts toward the layer.
      this._glowLayer?.removeIncludedOnlyMesh?.(prev.base);
    }
    if (newId && this._entityStandees.has(newId)) {
      const standee = this._entityStandees.get(newId);
      standee.base.material = this._getSelectedBaseMaterial();
      // Round 4: include the newly-selected standee's base in the GlowLayer
      // so its cyan pulse blooms. Other emissive meshes stay out of the layer.
      this._glowLayer?.addIncludedOnlyMesh?.(standee.base);
      const BABYLON = this._babylon;
      if (BABYLON && this._camera) {
        const newTarget = new BABYLON.Vector3(
          standee.base.position.x,
          0,
          standee.base.position.z,
        );
        // Selecting a unit should always feel like "the camera moved to it" —
        // skip the no-op-shift early-out that `_focusCamera` applies for
        // generic shifts, otherwise tiny target deltas (or the camera already
        // sitting on the unit because of an earlier pan) leave the player
        // wondering whether the click registered. Also zoom in toward the
        // unit when the camera is currently parked far away.
        const targetRadius = Math.min(
          this._camera.radius,
          Math.max(this._camera.lowerRadiusLimit ?? 4, SELECTION_FOCUS_RADIUS),
        );
        this._focusCamera(newTarget, targetRadius, { forceAnimate: true });
      }
    }
    this._lastSelectedEntityId = newId;
  }

  /** Animate the camera's target + radius to new values with a cubic
   *  ease-in-out over FOCUS_ANIM_FRAMES (≈300ms at 60fps). Skips the
   *  animation if the shift is below FOCUS_EPSILON, or if `opts.instant`
   *  is set (used on first frame). */
  _focusCamera(newTarget, newRadius, opts = {}) {
    const BABYLON = this._babylon;
    const camera  = this._camera;
    if (!BABYLON || !camera) return;

    if (opts.instant) {
      camera.target = newTarget;
      camera.radius = newRadius;
      return;
    }
    // `forceAnimate` overrides the small-shift early-out — callers that drive
    // user-facing focus changes (e.g. unit selection) want the animation even
    // when the delta is tiny, so the player gets a clear visual confirmation.
    if (!opts.forceAnimate
        && !shouldAnimateFocus(camera.target, camera.radius, newTarget, newRadius)) {
      camera.target = newTarget;
      camera.radius = newRadius;
      return;
    }

    const ease = new BABYLON.CubicEase();
    ease.setEasingMode(BABYLON.EasingFunction.EASINGMODE_EASEINOUT);

    const targetAnim = new BABYLON.Animation(
      'focusTarget', 'target', 60,
      BABYLON.Animation.ANIMATIONTYPE_VECTOR3,
      BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT,
    );
    targetAnim.setKeys([
      { frame: 0,                 value: camera.target.clone() },
      { frame: FOCUS_ANIM_FRAMES, value: newTarget },
    ]);
    targetAnim.setEasingFunction(ease);

    const radiusAnim = new BABYLON.Animation(
      'focusRadius', 'radius', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT,
      BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT,
    );
    radiusAnim.setKeys([
      { frame: 0,                 value: camera.radius },
      { frame: FOCUS_ANIM_FRAMES, value: newRadius },
    ]);
    radiusAnim.setEasingFunction(ease);

    this._scene.stopAnimation(camera);
    this._scene.beginDirectAnimation(camera, [targetAnim, radiusAnim], 0, FOCUS_ANIM_FRAMES, false);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ── Phase 5: animations, plan-ghost arrows, HP bars, floating text ────────
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Animation queue
  // ───────────────
  // Babylon's animation API is fire-and-forget per mesh; the resolution loop
  // in src/main.js expects a Promise-based "wait until everything in flight
  // has played out" contract. We track an `_animPromises` Set of pending
  // promises and `waitForAnimations()` awaits the snapshot. Each addX()
  // builds one Promise that resolves when its underlying Babylon animation
  // (or setTimeout for material-only effects) fires its onEnd callback. The
  // promise self-removes from the set on resolve so the set drains cleanly.
  //
  // HP bars (always-on)
  // ───────────────────
  // We render an HP bar above every standee, all the time — *not* only
  // post-damage. Brimstone's signal-density is already low (one or two leaders
  // and a handful of pawns per side); a bar that only shows on damage made it
  // ambiguous whether full-HP units were missing a bar or just at full. The
  // bar is a 1×1 plane scaled to 0.6×0.12, parented to the standee's base
  // disc with billboardMode_ALL, so it follows move animations for free.
  // Colour: red <33%, yellow <66%, green ≥66% — see hpBarColor().
  //
  // Plan arrow geometry
  // ───────────────────
  // We use Babylon's `MeshBuilder.CreateDashedLines` for arrows — Babylon
  // already implements dash spacing in-shader, which avoids manually slicing
  // tubes. Numbered badges are billboarded planes textured with a
  // DynamicTexture rendering the step number. Arrows are rebuilt every draw()
  // from `this.planGhostSteps`; the cost is small (only MOVE steps generate
  // arrows) and avoids tracking dirty state across plan edits.
  //
  // Movement / lunge / projectile / flash
  // ──────────────────────────────────────
  // Move and lunge drive `position.x`/`position.z` of the entity's standee
  // (+ base disc) via beginDirectAnimation. While the entity id is in
  // `_activeMoveIds` / `_activeLungeIds`, `_syncEntityStandees` skips the
  // `_positionStandee` snap that would otherwise yank the mesh back to its
  // state position on the next redraw. Projectiles spawn a small sphere that
  // animates between hex world positions then disposes. Attack flash briefly
  // tints the attacker + target tiles' emissive colour red.

  /** Tail-recursive helper: register a Promise as in-flight; self-remove on settle. */
  _trackAnim(promise) {
    this._animPromises.add(promise);
    promise.finally(() => this._animPromises.delete(promise));
    return promise;
  }

  /** Resolves once all in-flight Phase 5 animations have completed. Safe to
   *  call when nothing is animating — resolves on the microtask queue. */
  async waitForAnimations() {
    if (!this._animPromises || this._animPromises.size === 0) return;
    // Snapshot the set so any animations chained inside callbacks don't
    // extend this particular wait indefinitely.
    await Promise.all([...this._animPromises]);
  }

  /** Hard-clear every Phase 5 animation. Mirrors the 2D path's
   *  clearAnimations(): used between rounds to ensure no half-finished move
   *  or projectile bleeds into the next planning cycle. */
  clearAnimations() {
    this.clearAllLungeAnims(true);
    this.clearAllProjectileAnims();
    this.clearFlashes();
    if (this._scene) {
      for (const standee of this._entityStandees.values()) {
        this._scene.stopAnimation(standee.plane);
        this._scene.stopAnimation(standee.base);
      }
    }
    this._activeMoveIds.clear();
    this._activeLungeIds.clear();
    // Don't manually reject — let Babylon's own onEnd callbacks fire as the
    // stopped animations drain; the Set will empty as their promises resolve.
  }

  // ─── Move animation ──────────────────────────────────────────────────────

  /** Slide an entity's standee from one hex to another over ~250ms (linear).
   *  Skips silently if Babylon hasn't loaded yet or the entity has no live
   *  standee — the next draw() will snap the entity to its destination
   *  position anyway via `_positionStandee`, so resolution can't get stuck
   *  on a missing animation. */
  addMoveAnim(entityId, fromCol, fromRow, toCol, toRow, _type, _owner, _title) {
    if (!this._scene || !this._babylon) return;
    const standee = this._entityStandees.get(entityId);
    if (!standee) return;
    const BABYLON = this._babylon;
    const { x: fromX, z: fromZ } = hexToWorld(fromCol, fromRow);
    const { x: toX,   z: toZ   } = hexToWorld(toCol,   toRow);
    const FRAMES_MOVE = 15; // ≈250ms at 60fps

    // Cancel any in-flight move on this entity so plan-step "A→B→C" hops
    // don't queue up and play simultaneously.
    this._scene.stopAnimation(standee.plane);
    this._scene.stopAnimation(standee.base);
    this._activeMoveIds.add(entityId);

    const animX = new BABYLON.Animation('mvX', 'position.x', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animX.setKeys([{ frame: 0, value: fromX }, { frame: FRAMES_MOVE, value: toX }]);
    const animZ = new BABYLON.Animation('mvZ', 'position.z', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animZ.setKeys([{ frame: 0, value: fromZ }, { frame: FRAMES_MOVE, value: toZ }]);

    // Set start positions immediately so the very first frame is at "from".
    standee.plane.position.x = fromX; standee.plane.position.z = fromZ;
    standee.base.position.x  = fromX; standee.base.position.z  = fromZ;

    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(standee.base, [animX, animZ], 0, FRAMES_MOVE, false);
      this._scene.beginDirectAnimation(standee.plane, [animX, animZ], 0, FRAMES_MOVE, false, 1, () => {
        this._activeMoveIds.delete(entityId);
        resolve();
      });
    });
    this._trackAnim(promise);
  }

  // ─── Lunge animation ─────────────────────────────────────────────────────

  /** Slide the attacker's standee to the midpoint between attacker and target
   *  hexes and hold there until `returnAllLungeAnims()` is called. Mirrors
   *  the 2D contract: an "attack-in-progress" pose, not a one-shot. */
  addLungeAnim(entityId, fromCol, fromRow, toCol, toRow, _type, _owner, _title) {
    if (!this._scene || !this._babylon) return;
    const standee = this._entityStandees.get(entityId);
    if (!standee) return;
    const BABYLON = this._babylon;
    const { x: fromX, z: fromZ } = hexToWorld(fromCol, fromRow);
    const { x: toX,   z: toZ   } = hexToWorld(toCol,   toRow);
    const midX = (fromX + toX) * 0.5;
    const midZ = (fromZ + toZ) * 0.5;
    const FRAMES_LUNGE = 12; // ≈200ms — quick, aggressive

    this._scene.stopAnimation(standee.plane);
    this._scene.stopAnimation(standee.base);
    this._activeLungeIds.add(entityId);

    standee.plane.position.x = fromX; standee.plane.position.z = fromZ;
    standee.base.position.x  = fromX; standee.base.position.z  = fromZ;

    const animX = new BABYLON.Animation('lgX', 'position.x', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animX.setKeys([{ frame: 0, value: fromX }, { frame: FRAMES_LUNGE, value: midX }]);
    const animZ = new BABYLON.Animation('lgZ', 'position.z', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animZ.setKeys([{ frame: 0, value: fromZ }, { frame: FRAMES_LUNGE, value: midZ }]);

    // Stash the "home" position on the standee so returnAllLungeAnims() knows
    // where to slide back to without consulting the state (which may have
    // changed by then — e.g. a follow-up move).
    standee.lungeHome = { fromX, fromZ, midX, midZ };

    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(standee.base,  [animX, animZ], 0, FRAMES_LUNGE, false);
      this._scene.beginDirectAnimation(standee.plane, [animX, animZ], 0, FRAMES_LUNGE, false, 1, resolve);
    });
    this._trackAnim(promise);
  }

  /** Reverse every active lunge: slide each standee back to its home hex.
   *  Releases the entity id from `_activeLungeIds` once the return completes
   *  so `_syncEntityStandees` resumes snapping the standee to state. */
  returnAllLungeAnims() {
    if (!this._scene || !this._babylon) return;
    const BABYLON = this._babylon;
    const FRAMES_RET = 10; // ≈170ms
    for (const [id, standee] of this._entityStandees) {
      if (!standee.lungeHome) continue;
      const { fromX, fromZ, midX, midZ } = standee.lungeHome;
      this._scene.stopAnimation(standee.plane);
      this._scene.stopAnimation(standee.base);
      const animX = new BABYLON.Animation('lrX', 'position.x', 60,
        BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
      animX.setKeys([{ frame: 0, value: midX }, { frame: FRAMES_RET, value: fromX }]);
      const animZ = new BABYLON.Animation('lrZ', 'position.z', 60,
        BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
      animZ.setKeys([{ frame: 0, value: midZ }, { frame: FRAMES_RET, value: fromZ }]);
      const promise = new Promise(resolve => {
        this._scene.beginDirectAnimation(standee.base,  [animX, animZ], 0, FRAMES_RET, false);
        this._scene.beginDirectAnimation(standee.plane, [animX, animZ], 0, FRAMES_RET, false, 1, () => {
          standee.lungeHome = null;
          this._activeLungeIds.delete(id);
          resolve();
        });
      });
      this._trackAnim(promise);
    }
  }

  /** Immediately snap all lunging entities back home and clear lunge state.
   *  Used between rounds when we don't want the return animation to play. */
  clearAllLungeAnims(skipResolve = false) {
    if (!this._scene) {
      this._activeLungeIds.clear();
      return;
    }
    for (const [id, standee] of this._entityStandees) {
      if (!standee.lungeHome) continue;
      this._scene.stopAnimation(standee.plane);
      this._scene.stopAnimation(standee.base);
      const { fromX, fromZ } = standee.lungeHome;
      standee.plane.position.x = fromX; standee.plane.position.z = fromZ;
      standee.base.position.x  = fromX; standee.base.position.z  = fromZ;
      standee.lungeHome = null;
      this._activeLungeIds.delete(id);
    }
    // skipResolve = called from clearAnimations() — promises will drain on
    // their own as the stopped Babylon animations fire their onEnd.
    void skipResolve;
  }

  // ─── Projectile animation ────────────────────────────────────────────────

  /** Spawn a small projectile mesh and animate it from source → target hex
   *  along a low parabolic arc. Mesh disposes when the animation ends. */
  addProjectileAnim(projectileType, fromCol, fromRow, toCol, toRow, opts = {}) {
    if (!this._scene || !this._babylon) return;
    const BABYLON = this._babylon;
    const { x: fromX, z: fromZ } = hexToWorld(fromCol, fromRow);
    const { x: toX,   z: toZ   } = hexToWorld(toCol,   toRow);
    const duration = opts.duration ?? 320;
    const FRAMES   = Math.max(6, Math.round(duration / 1000 * 60));

    const ball = BABYLON.MeshBuilder.CreateSphere(
      `proj_${projectileType ?? 'sparkle'}_${fromCol}_${fromRow}_${Date.now()}`,
      { diameter: 0.25 }, this._scene,
    );
    ball.isPickable = false;
    const mat = new BABYLON.StandardMaterial(`projmat_${ball.uniqueId}`, this._scene);
    const [r, g, b] = projectileColor01(projectileType);
    mat.diffuseColor  = new BABYLON.Color3(r, g, b);
    mat.emissiveColor = new BABYLON.Color3(r, g, b);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    ball.material = mat;

    // Generate a 3-key arc: source, apex (midpoint + bump), target.
    const apexY = 0.6 + Math.hypot(toX - fromX, toZ - fromZ) * 0.12;
    const midX  = (fromX + toX) * 0.5;
    const midZ  = (fromZ + toZ) * 0.5;
    ball.position.set(fromX, 0.5, fromZ);

    const animPos = new BABYLON.Animation('projPos', 'position', 60,
      BABYLON.Animation.ANIMATIONTYPE_VECTOR3, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animPos.setKeys([
      { frame: 0,           value: new BABYLON.Vector3(fromX, 0.5, fromZ) },
      { frame: FRAMES / 2,  value: new BABYLON.Vector3(midX,  apexY, midZ) },
      { frame: FRAMES,      value: new BABYLON.Vector3(toX,   0.5, toZ) },
    ]);

    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(ball, [animPos], 0, FRAMES, false, 1, () => {
        if (typeof opts.onArrive === 'function') {
          try { opts.onArrive(); } catch (_) { /* swallow — playback continues */ }
        }
        ball.dispose();
        mat.dispose();
        resolve();
      });
    });
    this._trackAnim(promise);
  }

  /** No-op for the 3D path — projectile meshes self-dispose when their
   *  animation ends, so there is no detached "in-flight" list to clear. */
  clearAllProjectileAnims() { /* projectiles self-dispose */ }

  // ─── Attack hex flash ────────────────────────────────────────────────────

  /** Briefly tint the attacker and target tiles' emissive colour red.
   *  Restores the original material when the timeout fires so the tiles
   *  return to their normal hue. */
  addAttackAnim(actorCol, actorRow, targetCol, targetRow) {
    if (!this._scene || !this._babylon) return;
    this._flashTile(actorCol,  actorRow,  [0.45, 0.20, 0.05]); // amber actor
    this._flashTile(targetCol, targetRow, [0.55, 0.10, 0.10]); // red target
  }

  _flashTile(col, row, emissive01) {
    if (!this._scene || !this._babylon) return;
    const tileMesh = this._tileMeshes.find(m => m.metadata?.col === col && m.metadata?.row === row);
    if (!tileMesh) return;
    const BABYLON = this._babylon;
    // Clone the current material so per-flash state doesn't leak into the
    // shared per-colour material cache (every grass tile shares one material).
    const original = tileMesh.material;
    const flashMat = new BABYLON.StandardMaterial(`flash_${col}_${row}_${Date.now()}`, this._scene);
    flashMat.diffuseColor  = original.diffuseColor?.clone() ?? new BABYLON.Color3(0.4, 0.4, 0.4);
    flashMat.specularColor = new BABYLON.Color3(0, 0, 0);
    flashMat.emissiveColor = new BABYLON.Color3(emissive01[0], emissive01[1], emissive01[2]);
    tileMesh.material = flashMat;

    const duration = 220;
    const promise = new Promise(resolve => {
      setTimeout(() => {
        // Defensive: tile may have been disposed (map rebuild) — only restore
        // if the tile mesh is still in the scene.
        if (!tileMesh.isDisposed?.()) {
          tileMesh.material = original;
        }
        flashMat.dispose();
        resolve();
      }, duration);
    });
    this._trackAnim(promise);
  }

  // ─── HP-change flash + floating text ─────────────────────────────────────

  /** Floating "-2" / "+1" text above a hex when an entity gains/loses HP. */
  addHpChangeFlash(col, row, delta) {
    if (!this._scene || !this._babylon || !delta) return;
    const label = delta < 0 ? `${delta}` : `+${delta}`;
    const colour = delta < 0 ? '#ff5050' : '#60ff70';
    this._spawnFloatingText(col, row, label, colour, 900);
  }

  /** Generic hex flash — used for combat result text ("HIT 2", "CRUSH 3",
   *  "MISS") and other one-shot floaters. The colour/duration knobs match the
   *  2D `addFlash` signature so callers don't need to know which renderer is
   *  active. Background colour is ignored — 3D floaters don't have a fill. */
  addFlash(col, row, text, _color, durationMs = 900, fontScale = 0.85, textColor = null) {
    if (!this._scene || !this._babylon) return;
    if (!text) return; // 2D used empty-text flashes for hex tints; tint goes through addAttackAnim now
    this._spawnFloatingText(col, row, String(text), textColor ?? '#ffe0a0', durationMs, fontScale);
  }

  clearFlashes() {
    if (!this._scene) return;
    // Floating-text meshes manage their own lifecycle through Babylon
    // animations; if anyone wants to brute-force clear them mid-round, they
    // can iterate the scene's transient floater group. For now, no-op — the
    // floaters expire on their own ~700ms after spawn and they're cosmetic.
  }

  _spawnFloatingText(col, row, text, hexColor = '#ffe0a0', durationMs = 700, fontScale = 1) {
    if (typeof document === 'undefined') return;
    const BABYLON = this._babylon;
    const { x, z } = hexToWorld(col, row);

    // 256×96 dynamic texture, larger than necessary so the text reads sharp
    // at any camera distance up to the upperRadiusLimit.
    const tex = new BABYLON.DynamicTexture(`floatTex_${Date.now()}`, { width: 256, height: 96 }, this._scene, false);
    tex.hasAlpha = true;
    const ctx = tex.getContext();
    ctx.clearRect(0, 0, 256, 96);
    ctx.font = `bold ${Math.round(56 * fontScale)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = 'rgba(0,0,0,0.7)';
    ctx.fillText(text, 130, 50);
    ctx.fillStyle = hexColor;
    ctx.fillText(text, 128, 48);
    tex.update();

    const plane = BABYLON.MeshBuilder.CreatePlane(`float_${col}_${row}_${Date.now()}`,
      { width: 1.6, height: 0.6 }, this._scene);
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable    = false;
    const mat = new BABYLON.StandardMaterial(`floatMat_${plane.uniqueId}`, this._scene);
    mat.diffuseTexture = tex;
    mat.opacityTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.specularColor  = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor  = new BABYLON.Color3(1, 1, 1);
    mat.backFaceCulling = false;
    plane.material = mat;

    const startY = STANDEE_BASE_HEIGHT * STANDEE_LEADER_HEIGHT_MUL + 0.4;
    const endY   = startY + 1.2;
    plane.position.set(x, startY, z);
    plane.visibility = 1;

    const FRAMES_FLOAT = Math.max(6, Math.round(durationMs / 1000 * 60));
    const animPos = new BABYLON.Animation('floatY', 'position.y', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    animPos.setKeys([{ frame: 0, value: startY }, { frame: FRAMES_FLOAT, value: endY }]);

    const animFade = new BABYLON.Animation('floatA', 'visibility', 60,
      BABYLON.Animation.ANIMATIONTYPE_FLOAT, BABYLON.Animation.ANIMATIONLOOPMODE_CONSTANT);
    // Hold full alpha for half the duration then fade — matches the 2D feel.
    animFade.setKeys([
      { frame: 0,                       value: 1 },
      { frame: Math.floor(FRAMES_FLOAT / 2), value: 1 },
      { frame: FRAMES_FLOAT,            value: 0 },
    ]);

    const promise = new Promise(resolve => {
      this._scene.beginDirectAnimation(plane, [animPos, animFade], 0, FRAMES_FLOAT, false, 1, () => {
        plane.dispose();
        mat.dispose();
        tex.dispose();
        resolve();
      });
    });
    this._trackAnim(promise);
  }

  // ─── HP bars ─────────────────────────────────────────────────────────────

  /** Ensure the entity has an HP bar mesh parented to its base disc, and the
   *  texture matches the current HP / maxHP ratio. */
  _syncHpBar(standee, entity) {
    if (!this._scene || !this._babylon || typeof document === 'undefined') return;
    if (entity.hp == null || entity.maxHp == null) return;
    let entry = this._hpBars.get(entity.id);
    if (!entry) entry = this._createHpBar(standee, entity);
    if (!entry) return;
    if (entry.lastHp === entity.hp && entry.lastMax === entity.maxHp) return;
    this._redrawHpBarTexture(entry, entity.hp, entity.maxHp);
    entry.lastHp  = entity.hp;
    entry.lastMax = entity.maxHp;
  }

  _createHpBar(standee, entity) {
    const BABYLON = this._babylon;
    if (typeof document === 'undefined') return null;
    const tex = new BABYLON.DynamicTexture(`hpTex_${entity.id}`, { width: 128, height: 24 }, this._scene, false);
    tex.hasAlpha = true;
    const mat = new BABYLON.StandardMaterial(`hpMat_${entity.id}`, this._scene);
    mat.diffuseTexture = tex;
    mat.opacityTexture = tex;
    mat.useAlphaFromDiffuseTexture = true;
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor = new BABYLON.Color3(1, 1, 1);
    mat.backFaceCulling = false;

    const plane = BABYLON.MeshBuilder.CreatePlane(`hp_${entity.id}`,
      { width: 0.6, height: 0.12 }, this._scene);
    plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
    plane.isPickable    = false;
    plane.material      = mat;
    plane.parent        = standee.base;
    // Local position relative to the base disc (which sits at STANDEE_BASE_Y_OFFSET).
    const hMul = standee.leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
    plane.position.set(0, STANDEE_BASE_HEIGHT * hMul + 0.2, 0);

    const entry = { plane, mat, tex, lastHp: -1, lastMax: -1 };
    this._hpBars.set(entity.id, entry);
    return entry;
  }

  _redrawHpBarTexture(entry, hp, maxHp) {
    const tex = entry.tex;
    const ctx = tex.getContext();
    const W = 128, H = 24;
    const ratio = Math.max(0, Math.min(1, hp / Math.max(1, maxHp)));
    const colour = hpBarColor(hp, maxHp);
    ctx.clearRect(0, 0, W, H);
    // Frame
    ctx.fillStyle = 'rgba(0,0,0,0.85)';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(40,40,40,1)';
    ctx.fillRect(2, 2, W - 4, H - 4);
    // Fill
    ctx.fillStyle = colour;
    ctx.fillRect(2, 2, Math.round((W - 4) * ratio), H - 4);
    // Outline
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth   = 1;
    ctx.strokeRect(0.5, 0.5, W - 1, H - 1);
    tex.update();
  }

  _disposeHpBar(entityId) {
    const entry = this._hpBars.get(entityId);
    if (!entry) return;
    entry.plane.dispose();
    entry.mat.dispose();
    entry.tex.dispose();
    this._hpBars.delete(entityId);
  }

  // ─── Highlight overlay (movement / target hexes) ─────────────────────────
  //
  // ui.js sets `this.highlightHexes = [{col,row,color},...]` whenever a unit
  // is selected (or the user is targeting an action). The 2D renderer reads
  // the same field and tints those hexes. Here we lay a thin flat hex disc
  // on each highlighted tile, materialised with the rgba colour ui.js chose.
  //
  // Rebuild policy: signature-diff each draw. Highlights rarely change frame
  // to frame (only on selection / targeting events), so the cost is near-zero
  // when nothing moved and a handful of disposals + creations when it did.

  /** Mirror `highlightHexes` into a set of flat emissive hex discs. Disposes
   *  previous overlay geometry when the signature changes; idempotent when it
   *  hasn't. Skipped silently if Babylon hasn't loaded yet. */
  _syncMovementHighlights() {
    if (!this._scene || !this._babylon) return;
    const sig = movementHighlightSignature(this.highlightHexes);
    if (sig === this._highlightSig) return;
    this._highlightSig = sig;

    for (const mesh of this._highlightMeshes) mesh.dispose();
    this._highlightMeshes = [];

    const list = Array.isArray(this.highlightHexes) ? this.highlightHexes : [];
    if (list.length === 0) return;

    const BABYLON = this._babylon;
    for (const h of list) {
      if (typeof h?.col !== 'number' || typeof h?.row !== 'number') continue;
      // Round 4: replaced the flat tinted cylinder ("the whole tile lights up
      // a muddy green") with a hex *outline ring*. The underlying terrain stays
      // readable, but the player can still see at a glance which hexes are
      // valid move/attack targets. Built as a ribbon between two concentric
      // hex polygons (outer + inner) so the ring keeps its width regardless of
      // camera distance — line meshes don't reliably scale across browsers.
      const { outer, inner } = hexOutlinePaths(h.col, h.row);
      const toVec = p => new BABYLON.Vector3(p.x, p.y, p.z);
      const ribbon = BABYLON.MeshBuilder.CreateRibbon(
        `highlight_${h.col}_${h.row}`,
        {
          pathArray: [outer.map(toVec), inner.map(toVec)],
          sideOrientation: BABYLON.Mesh.DOUBLESIDE,
        },
        this._scene,
      );
      ribbon.parent = this._mapRoot;
      ribbon.material   = this._highlightMaterialFor(h.color || HIGHLIGHT_DEFAULT_RGBA);
      ribbon.isPickable = false;
      this._highlightMeshes.push(ribbon);
    }
  }

  _highlightMaterialFor(rgbaCss) {
    if (this._highlightMatCache.has(rgbaCss)) return this._highlightMatCache.get(rgbaCss);
    const BABYLON = this._babylon;
    const [r, g, b, a] = parseRgba01(rgbaCss);
    const mat = new BABYLON.StandardMaterial(`highlightMat_${rgbaCss}`, this._scene);
    mat.diffuseColor  = new BABYLON.Color3(r, g, b);
    // Emissive at half the diffuse so highlights read on both day and night
    // phases without saturating the glow layer.
    mat.emissiveColor = new BABYLON.Color3(r * 0.5, g * 0.5, b * 0.5);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.alpha = Math.max(HIGHLIGHT_MIN_ALPHA, a);
    mat.backFaceCulling = false;
    this._highlightMatCache.set(rgbaCss, mat);
    return mat;
  }

  // ─── Plan ghost arrows ───────────────────────────────────────────────────

  /** Rebuild the plan-ghost arrow overlay from `this.planGhostSteps`. We
   *  rebuild from scratch every draw() — the per-call cost is a handful of
   *  meshes (one per MOVE step) and avoids hand-tracking dirty plan state. */
  _syncPlanArrows() {
    // Dispose previous frame's plan marker geometry first. We rebuild every
    // draw — the per-call cost is small (one marker + badge per MOVE step,
    // plus one tube material + N dash tubes per entity) and avoids
    // hand-tracking which plan steps changed.
    for (const arrow of this._planArrowMeshes) {
      arrow.disc?.dispose();
      arrow.discMat?.dispose();
      arrow.badge?.dispose();
      arrow.badgeMat?.dispose();
      arrow.badgeTex?.dispose();
      arrow.line?.dispose();
      if (arrow.dashes) for (const m of arrow.dashes) m.dispose();
      arrow.dashMat?.dispose();
    }
    this._planArrowMeshes = [];

    const steps = this.planGhostSteps;
    if (!steps || !this._babylon || !this._scene) return;

    const BABYLON = this._babylon;

    // Round 4: collect per-entity path so we can draw a dashed line connecting
    // consecutive waypoints (origin → step 1 → step 2 → …). The previous
    // round only laid down tile-sized discs at each destination — the *path*
    // between them was implicit, which read fine for a single hop but got
    // confusing as soon as a plan had two or more chained moves.
    const pathsByEntity = new Map();
    for (const step of steps) {
      if (!step.arrow) continue;
      const { entityId, fromCol, fromRow, toCol, toRow } = step.arrow;
      let arr = pathsByEntity.get(entityId);
      if (!arr) {
        arr = [{ col: fromCol, row: fromRow }];
        pathsByEntity.set(entityId, arr);
      }
      arr.push({ col: toCol, row: toRow });
    }

    // Per-entity dashed path tracing the planned waypoints. We render each
    // dash as a short tube (radius PLAN_LINE_RADIUS) rather than a
    // LinesMesh — native WebGL line width is driver-capped at ~1px, so a
    // dashed-line approach reads as a hair regardless of any width
    // setting. Tubes give us guaranteed visible thickness and let us lift
    // the dashes above tile/marker geometry without z-fight.
    for (const [entityId, path] of pathsByEntity) {
      if (path.length < 2) continue;
      const ent = this.state?.entities?.find?.(e => e.id === entityId);
      const ownerColor = entityBaseColor(ent ?? {});
      const [r, g, b] = cssHexToRgb01(ownerColor);

      const dashMat = new BABYLON.StandardMaterial(
        `planLineMat_${entityId}`, this._scene);
      dashMat.diffuseColor  = new BABYLON.Color3(r, g, b);
      dashMat.emissiveColor = new BABYLON.Color3(r * 0.6, g * 0.6, b * 0.6);
      dashMat.specularColor = new BABYLON.Color3(0, 0, 0);

      const dashes = [];
      for (let i = 0; i < path.length - 1; i++) {
        const a = hexToWorld(path[i].col,     path[i].row);
        const b = hexToWorld(path[i + 1].col, path[i + 1].row);
        const segs = computeDashSegments(
          { x: a.x, z: a.z }, { x: b.x, z: b.z },
          PLAN_LINE_DASH_SIZE, PLAN_LINE_GAP_SIZE, PLAN_LINE_Y,
        );
        for (let s = 0; s < segs.length; s++) {
          const { start, end } = segs[s];
          const tube = BABYLON.MeshBuilder.CreateTube(
            `planDash_${entityId}_${i}_${s}`,
            {
              path: [
                new BABYLON.Vector3(start.x, start.y, start.z),
                new BABYLON.Vector3(end.x,   end.y,   end.z),
              ],
              radius: PLAN_LINE_RADIUS,
              tessellation: 8,
              cap: BABYLON.Mesh.CAP_ALL,
            },
            this._scene,
          );
          tube.parent = this._mapRoot;
          tube.isPickable = false;
          tube.material = dashMat;
          dashes.push(tube);
        }
      }
      this._planArrowMeshes.push({ dashes, dashMat });
    }

    for (const step of steps) {
      if (!step.arrow) continue;
      const { toCol, toRow, entityId } = step.arrow;
      // Owner colour: prefer the entity's per-player colour, fall back to
      // faction theme, then neutral white.
      const ent   = this.state?.entities?.find?.(e => e.id === entityId);
      const ownerColor = entityBaseColor(ent ?? {});
      const [r, g, b] = cssHexToRgb01(ownerColor);

      // Round 4: replaced the large floating disc (radius 0.7, covered most of
      // the tile) with a small ground-puck cylinder under the badge. Reads as
      // a "marker pin" rather than a tinted overlay, so the underlying terrain
      // stays visible — and the numbered badge floating above the puck remains
      // the primary read for waypoint identity.
      const disc = BABYLON.MeshBuilder.CreateCylinder(
        `planMarker_${entityId}_${step.stepNumber ?? 0}`,
        { tessellation: 16, height: PLAN_MARKER_HEIGHT, diameter: PLAN_MARKER_DIAMETER },
        this._scene,
      );
      const { x: tx, z: tz } = hexToWorld(toCol, toRow);
      disc.position.set(tx, PLAN_MARKER_Y, tz);
      disc.isPickable = false;

      const discMat = new BABYLON.StandardMaterial(
        `planMarkerMat_${entityId}_${step.stepNumber ?? 0}`, this._scene);
      discMat.diffuseColor  = new BABYLON.Color3(r, g, b);
      discMat.emissiveColor = new BABYLON.Color3(r * 0.5, g * 0.5, b * 0.5);
      discMat.specularColor = new BABYLON.Color3(0, 0, 0);
      discMat.alpha = PLAN_DISC_ALPHA;
      disc.material = discMat;

      // Numbered badge above the puck — small billboarded plane.
      let badge = null, badgeMat = null, badgeTex = null;
      if (step.stepNumber != null && typeof document !== 'undefined') {
        badgeTex = new BABYLON.DynamicTexture(`badgeTex_${entityId}_${step.stepNumber}`,
          { width: 64, height: 64 }, this._scene, false);
        badgeTex.hasAlpha = true;
        const ctx = badgeTex.getContext();
        ctx.clearRect(0, 0, 64, 64);
        ctx.fillStyle = 'rgba(0,0,0,0.85)';
        ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.fill();
        ctx.strokeStyle = ownerColor;
        ctx.lineWidth = 4;
        ctx.beginPath(); ctx.arc(32, 32, 26, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 36px sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(String(step.stepNumber), 32, 34);
        badgeTex.update();

        badgeMat = new BABYLON.StandardMaterial(`badgeMat_${entityId}_${step.stepNumber}`, this._scene);
        badgeMat.diffuseTexture = badgeTex;
        badgeMat.opacityTexture = badgeTex;
        badgeMat.useAlphaFromDiffuseTexture = true;
        badgeMat.specularColor = new BABYLON.Color3(0, 0, 0);
        badgeMat.emissiveColor = new BABYLON.Color3(1, 1, 1);
        badgeMat.backFaceCulling = false;

        badge = BABYLON.MeshBuilder.CreatePlane(`badge_${entityId}_${step.stepNumber}`,
          { width: 0.45, height: 0.45 }, this._scene);
        badge.billboardMode = BABYLON.Mesh.BILLBOARDMODE_ALL;
        badge.isPickable    = false;
        badge.material      = badgeMat;
        badge.position.set(tx, 0.6, tz);
      }

      this._planArrowMeshes.push({ disc, discMat, badge, badgeMat, badgeTex });
    }
  }

  // ─── Plan ghost (walking previewer) ──────────────────────────────────────
  //
  // Mirrors the 2D path's "ghost walks the plan" preview: a translucent clone
  // of each moving unit's standee plane traces the planned path on a loop.
  // The 2D path uses a shared "heartbeat" cycle across all units; here we use
  // a simpler per-unit loop with a fixed per-step duration — both reads as
  // "this unit is about to walk this path".
  //
  // Implementation notes:
  //   • Path is sourced from `planGhostSteps` (computed in ui.js via
  //     `computeGhostState`). MOVE arrows in step order → [origin, dest1, ...].
  //   • Ghost meshes are rebuilt only when an entity's path *signature*
  //     changes; per-frame motion is pumped from `_onBeforeRender` so the
  //     animation runs independently of `draw()` calls.
  //   • The ghost plane reuses the entity's existing portrait material
  //     (no extra texture allocation) but is rendered at half alpha. We toggle
  //     `mat.alpha` per-frame via a wrapped material clone — cheap, and keeps
  //     the real standee at full opacity.

  /** Refresh ghost meshes from current `planGhostSteps`. Dispose ghosts whose
   *  path no longer exists; build new ghosts for new paths; leave unchanged
   *  paths alone so the walking cycle doesn't snap back to origin every draw. */
  _syncPlanGhosts() {
    if (!this._scene || !this._babylon) return;

    const paths = computePlanGhostPaths(this.planGhostSteps);

    // Compute a combined signature so we can early-out when nothing changed.
    const sig = [...paths.entries()]
      .map(([id, p]) => `${id}:${p.map(s => `${s.col},${s.row}`).join('|')}`)
      .sort()
      .join(';');
    if (sig === this._planGhostSig) return;
    this._planGhostSig = sig;

    // Dispose ghosts whose entity no longer has a path (or has changed path).
    for (const [id, entry] of this._planGhostMeshes) {
      const p = paths.get(id);
      const newKey = p ? p.map(s => `${s.col},${s.row}`).join('|') : null;
      if (newKey !== entry.signature) {
        entry.plane.dispose();
        entry.mat?.dispose();
        this._planGhostMeshes.delete(id);
      }
    }

    // Build ghosts for any entity that now has a path but no live ghost.
    const BABYLON = this._babylon;
    for (const [id, path] of paths) {
      if (this._planGhostMeshes.has(id)) continue;
      const standee = this._entityStandees.get(id);
      if (!standee) continue; // no live standee to clone — skip
      const ent = this.state?.entities?.find?.(e => e.id === id);
      const assetId = this._assetIdFor(ent);
      // Build a fresh material so we can tweak alpha independently of the
      // real standee. We reuse the portrait texture from the cached material.
      const baseMat = this._planeMaterialFor(assetId);
      const mat = new BABYLON.StandardMaterial(`ghost_${id}`, this._scene);
      if (baseMat.diffuseTexture) {
        mat.diffuseTexture = baseMat.diffuseTexture;
        mat.opacityTexture = baseMat.diffuseTexture;
        mat.useAlphaFromDiffuseTexture = true;
      } else {
        mat.diffuseColor = baseMat.diffuseColor?.clone()
          ?? new BABYLON.Color3(0.85, 0.85, 0.85);
      }
      mat.specularColor = new BABYLON.Color3(0, 0, 0);
      mat.emissiveColor = new BABYLON.Color3(0.4, 0.4, 0.4);
      mat.backFaceCulling = false;
      mat.alpha = PLAN_GHOST_ALPHA;

      const leader = standee.leader;
      const wMul = leader ? STANDEE_LEADER_WIDTH_MUL  : 1;
      const hMul = leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
      const plane = BABYLON.MeshBuilder.CreatePlane(
        `planGhost_${id}`,
        { width: STANDEE_BASE_WIDTH * wMul, height: STANDEE_BASE_HEIGHT * hMul },
        this._scene,
      );
      plane.billboardMode = BABYLON.Mesh.BILLBOARDMODE_Y;
      plane.material      = mat;
      plane.isPickable    = false;

      this._planGhostMeshes.set(id, {
        plane, mat, path,
        signature: path.map(s => `${s.col},${s.row}`).join('|'),
        leader,
      });
    }
  }

  /** Per-frame: walk each ghost along its path on a loop. Cheap — runs once
   *  per ghost (a handful) regardless of map size. */
  _pumpPlanGhosts(nowMs) {
    if (this._planGhostMeshes.size === 0) return;
    for (const [, entry] of this._planGhostMeshes) {
      const pose = planGhostPose(nowMs, entry.path.length);
      const from = entry.path[pose.segment];
      const to   = entry.path[Math.min(entry.path.length - 1, pose.segment + 1)];
      const a = hexToWorld(from.col, from.row);
      const b = hexToWorld(to.col,   to.row);
      const lerp = (s, e) => s + (e - s) * pose.segT;
      entry.plane.position.x = lerp(a.x, b.x);
      entry.plane.position.z = lerp(a.z, b.z);
      const hMul = entry.leader ? STANDEE_LEADER_HEIGHT_MUL : 1;
      entry.plane.position.y = STANDEE_BASE_Y_OFFSET
        + STANDEE_BASE_THICKNESS / 2
        + (STANDEE_BASE_HEIGHT * hMul) / 2;
      entry.mat.alpha = PLAN_GHOST_ALPHA * pose.alpha;
    }
  }

  // ─── Phase 6: atmosphere — lighting, node glow, fog veil, selection halo ──
  //
  // Scene-global concerns that make 3D mode feel alive: time-of-day lighting
  // that shifts across the four phases, saturated emissive discs on Power Nodes
  // tinted by current controller, a fog-of-war veil that dims tiles and
  // hides standees outside the observer's sight, and an animated glow halo
  // for the selected unit. Per-entity overlays, plan arrows, HP bars, and
  // combat animations are explicitly Phase 5's domain — leave them alone.

  /** Detect state.phase changes and kick off a 3-second eased transition of
   *  the hemispheric light intensity + colour + scene clear colour. The actual
   *  interpolation is pumped per-frame from `_onBeforeRender`. */
  _notePhaseChange() {
    if (!this._light) return;
    const phase = this.state?.phase ?? null;
    if (phase === this._lastPhase) return;
    const from = this._snapshotLight();
    const to   = getPhaseLightConfig(phase);
    this._phaseTransition = {
      from,
      to,
      startMs: this._nowMs(),
      durMs:   PHASE_TRANSITION_MS,
    };
    this._lastPhase = phase;
  }

  _nowMs() {
    return (typeof performance !== 'undefined' && performance.now)
      ? performance.now()
      : Date.now();
  }

  /** Snapshot the current light/clear values as a Phase-light-config-shaped
   *  object. Used as the "from" anchor for the next transition so we always
   *  ease from wherever we are *right now*, even mid-transition. */
  _snapshotLight() {
    const s = this._lightState;
    return {
      intensity: s.intensity,
      color: { r: s.color.r, g: s.color.g, b: s.color.b },
      clear: { r: s.clear.r, g: s.clear.g, b: s.clear.b },
    };
  }

  /** Slam the light + clear colour to a target config with no animation. */
  _applyLightConfig(cfg) {
    const BABYLON = this._babylon;
    if (!BABYLON || !this._light || !this._scene) return;
    this._light.intensity = cfg.intensity;
    this._light.diffuse   = new BABYLON.Color3(cfg.color.r, cfg.color.g, cfg.color.b);
    this._light.specular  = new BABYLON.Color3(cfg.color.r * 0.3, cfg.color.g * 0.3, cfg.color.b * 0.3);
    this._scene.clearColor = new BABYLON.Color4(cfg.clear.r, cfg.clear.g, cfg.clear.b, 1.0);
    // Mirror into _lightState so transition snapshots see the new anchor.
    this._lightState.intensity = cfg.intensity;
    this._lightState.color = { r: cfg.color.r, g: cfg.color.g, b: cfg.color.b };
    this._lightState.clear = { r: cfg.clear.r, g: cfg.clear.g, b: cfg.clear.b };
  }

  /** Per-frame pump: advance the phase-light transition (if any) and update
   *  the selection halo + node-glow pulses. Cheap — runs every render frame
   *  regardless of whether draw() was called, so the pulses keep cycling
   *  even when game state is idle. */
  _onBeforeRender() {
    const now = this._nowMs();
    // Phase-light interpolation.
    const t = this._phaseTransition;
    if (t) {
      const elapsed = now - t.startMs;
      const u = Math.min(1, Math.max(0, elapsed / t.durMs));
      const eased = easeInOutCubic(u);
      const cur = lerpLightConfig(t.from, t.to, eased);
      this._applyLightConfig(cur);
      if (u >= 1) this._phaseTransition = null;
    }
    // Selection halo pulse.
    if (this.selectedEntityId != null) {
      const standee = this._entityStandees.get(this.selectedEntityId);
      if (standee) {
        const k = pulseFactor(now, SELECTION_PULSE_PERIOD_MS, SELECTION_PULSE_MIN, SELECTION_PULSE_MAX);
        this._setStandeeHaloIntensity(standee, k);
      }
    }
    // Node glow pulse.
    if (this._nodeGlowMeshes.length > 0) {
      const k = pulseFactor(now, NODE_PULSE_PERIOD_MS, NODE_PULSE_MIN, NODE_PULSE_MAX);
      for (const ng of this._nodeGlowMeshes) {
        this._setNodeGlowIntensity(ng, k);
      }
    }
    // Plan ghost walking previewer.
    this._pumpPlanGhosts(now);
    // Night lanterns subsystem (Piper): per-frame flicker + fade pump.
    this._pumpLanternFlicker(now);
  }

  /** Modulate a selected standee's halo. We use the base disc's emissive
   *  colour as the GlowLayer's input — base material was already swapped to
   *  the cyan-emissive `_selectedBaseMaterial` by `_applySelectionAndFocus`. */
  _setStandeeHaloIntensity(standee, k) {
    const mat = standee?.base?.material;
    if (!mat || !mat.emissiveColor) return;
    // Selection emissive base colour is cyan-tinted; scale toward `k` of full.
    mat.emissiveColor.r = SELECTION_EMISSIVE_BASE.r * k;
    mat.emissiveColor.g = SELECTION_EMISSIVE_BASE.g * k;
    mat.emissiveColor.b = SELECTION_EMISSIVE_BASE.b * k;
  }

  _setNodeGlowIntensity(ng, k) {
    if (!ng?.disc?.material?.emissiveColor) return;
    const c = ng.glowColor;
    ng.disc.material.emissiveColor.r = c.r * k * NODE_DISC_EMISSIVE_MUL;
    ng.disc.material.emissiveColor.g = c.g * k * NODE_DISC_EMISSIVE_MUL;
    ng.disc.material.emissiveColor.b = c.b * k * NODE_DISC_EMISSIVE_MUL;
  }

  // ─── Night lanterns subsystem (Piper) ──────────────────────────────────────
  //
  // A separate Phase 6 mini-feature: each living entity emits a warm amber
  // BABYLON.PointLight parented to its standee base, additive to the global
  // hemispheric light. Intensity is keyed off `state.phase` via
  // `lanternIntensityForPhase` and cross-faded over LANTERN_FADE_MS on phase
  // transitions; per-frame it picks up a gentle two-frequency flicker so the
  // group reads as separately-held lanterns, not a strobe.
  //
  // Lifecycle is fully self-contained: own phase tracker (`_lastLanternPhase`)
  // so we never race the shared `_lastPhase` used by the hemispheric transition;
  // own diff (`diffLanternLifecycle`) over `state.entities`; lanterns for
  // fogged-out standees are disabled (not disposed) so reveals snap straight
  // back. Babylon's default per-material light cap is 4 — bumped to
  // LANTERN_MATERIAL_LIGHT_CAP on every StandardMaterial currently in the scene
  // (plus any added later via onNewMaterialAddedObservable) the first time
  // the subsystem fires, so the 10-20 active lanterns on a Standard map don't
  // get silently dropped past slot 4.

  /** Diff lantern lifecycle against the live entity set and mutate Babylon
   *  state to match. Skips entities without a standee (the standee diff in
   *  `_syncEntityStandees` runs earlier in `draw()` so missing-standee should
   *  only happen briefly during late init). */
  _syncLanternLights() {
    if (!this._scene || !this._babylon) return;
    const BABYLON = this._babylon;

    // Phase-change detection: own tracker so we stay decoupled from the
    // hemispheric-light transition pump (which Nora may be re-tuning in
    // parallel). When the phase changes, start an eased fade between the
    // current eased intensity and the new phase's peak.
    const phase = this.state?.phase ?? null;
    if (phase !== this._lastLanternPhase) {
      this._lanternFade = {
        from:    this._lanternCurrentIntensity,
        to:      lanternIntensityForPhase(phase),
        startMs: this._nowMs(),
        durMs:   LANTERN_FADE_MS,
      };
      this._lastLanternPhase = phase;
    }

    // One-time material light-cap bump so the default-4 simultaneous-light
    // shader doesn't drop lanterns past slot 4 on tile/standee meshes.
    if (!this._lanternSubsystemInit) {
      this._lanternSubsystemInit = true;
      const apply = m => {
        if (m && typeof m.maxSimultaneousLights === 'number'
            && m.maxSimultaneousLights < LANTERN_MATERIAL_LIGHT_CAP) {
          m.maxSimultaneousLights = LANTERN_MATERIAL_LIGHT_CAP;
        }
      };
      for (const m of this._scene.materials) apply(m);
      // Any materials minted later (texture upgrades, projectile flashes, …)
      // also need the bump or their meshes will go dim near a lantern cluster.
      this._scene.onNewMaterialAddedObservable?.add(apply);
    }

    const priorIds = new Set(this._lanternLights.keys());
    const { add, remove } = diffLanternLifecycle(priorIds, this.state?.entities ?? []);

    for (const id of remove) {
      const entry = this._lanternLights.get(id);
      entry?.light?.dispose();
      this._lanternLights.delete(id);
    }

    for (const id of add) {
      const standee = this._entityStandees.get(id);
      if (!standee || !standee.base) continue; // try again next sync
      const light = new BABYLON.PointLight(
        `lantern_${id}`,
        new BABYLON.Vector3(0, LANTERN_HEIGHT_OFFSET, 0),
        this._scene,
      );
      const colour = BABYLON.Color3.FromHexString(LANTERN_COLOR_HEX);
      light.diffuse  = colour;
      light.specular = colour;
      light.range    = LANTERN_RANGE;
      light.intensity = 0; // pumped per-frame by _pumpLanternFlicker
      // Parenting to the base means the lantern follows move/lunge animations
      // for free — no per-frame position update needed.
      light.parent   = standee.base;
      this._lanternLights.set(id, {
        light,
        // Per-light phase offset so the flicker doesn't strobe in sync across
        // a cluster of nearby standees.
        phaseOffset: Math.random() * Math.PI * 2,
      });
    }
  }

  /** Per-frame pump: advance the lantern fade, then write per-light intensity
   *  by multiplying the eased base by `flickerScale`. Lanterns whose standee
   *  is hidden by fog (or whose base intensity is zero) are disabled so they
   *  don't contribute to the per-material 4-light cap. */
  _pumpLanternFlicker(now) {
    // Advance the cross-phase fade.
    if (this._lanternFade) {
      const elapsed = now - this._lanternFade.startMs;
      const u = Math.min(1, Math.max(0, elapsed / this._lanternFade.durMs));
      const eased = easeInOutCubic(u);
      this._lanternCurrentIntensity =
        this._lanternFade.from + (this._lanternFade.to - this._lanternFade.from) * eased;
      if (u >= 1) this._lanternFade = null;
    }
    if (this._lanternLights.size === 0) return;

    const base = this._lanternCurrentIntensity;
    const lit  = base > 1e-4;
    for (const [id, entry] of this._lanternLights) {
      const standee = this._entityStandees.get(id);
      const visible = standee && standee.base?.isVisible !== false;
      const enable  = lit && visible;
      if (entry.light.isEnabled() !== enable) entry.light.setEnabled(enable);
      if (!enable) continue;
      const k = flickerScale(now, entry.phaseOffset);
      entry.light.intensity = base * k;
    }
  }

  /** Build one emissive disc per Power Node hex on first call, then on every
   *  draw update the per-disc material colour to reflect the current
   *  controller. Cheap because witchObjectives count rarely exceeds 3. */
  _syncNodeGlowMeshes() {
    if (!this._scene || !this.state?.witchObjectives) return;
    if (!this._nodeGlowBuilt) {
      this._buildNodeGlowMeshes();
      this._nodeGlowBuilt = true;
    }
    // Recolour by controller each draw — controller can flip when entities move.
    for (const ng of this._nodeGlowMeshes) {
      const ctrl = nodeController(ng.obj, this.state.entities);
      const css = getNodeGlowColor(ctrl);
      const [r, g, b] = cssHexToRgb01(css);
      // Pulse intensity is applied per-frame from _onBeforeRender; here we set
      // the *target* colour so the next pulse step picks it up.
      ng.glowColor = { r, g, b };
    }
  }

  _buildNodeGlowMeshes() {
    const BABYLON = this._babylon;
    if (!BABYLON || !this._scene) return;
    for (const obj of this.state.witchObjectives) {
      // The glow visualises the whole cluster — anchor on each cluster hex so
      // multi-hex nodes still read as a unified controlled area.
      for (const h of obj.hexes) {
        const { x, z } = hexToWorld(h.col, h.row);
        // Saturated emissive disc resting just above the tile prism. The
        // upward shaft was dropped (playtest feedback) — controller clarity
        // now comes from a larger, more saturated, opaque-feeling disc.
        const disc = BABYLON.MeshBuilder.CreateCylinder(
          `node_disc_${obj.label.replace(/\W+/g, '_')}_${h.col}_${h.row}`,
          { tessellation: 24, height: 0.04, diameter: NODE_DISC_DIAMETER },
          this._scene,
        );
        disc.parent = this._mapRoot;
        disc.position.x = x;
        disc.position.z = z;
        disc.position.y = 0.10;
        disc.isPickable = false;
        const discMat = new BABYLON.StandardMaterial(`nodeDiscMat_${h.col}_${h.row}`, this._scene);
        discMat.diffuseColor  = new BABYLON.Color3(0.05, 0.05, 0.05);
        discMat.specularColor = new BABYLON.Color3(0, 0, 0);
        discMat.emissiveColor = new BABYLON.Color3(0.8, 0.8, 0.8);
        discMat.alpha = NODE_DISC_ALPHA;
        disc.material = discMat;
        // Round 4: explicitly include the node disc in the GlowLayer's
        // include-only set so it still blooms now that the layer no longer
        // picks up every emissive material in the scene.
        this._glowLayer?.addIncludedOnlyMesh?.(disc);

        this._nodeGlowMeshes.push({
          obj, disc,
          col: h.col, row: h.row,
          glowColor: { r: 1, g: 1, b: 1 },
        });

        // Track in the per-hex prop list so `_applyFogVeil` hides the disc on
        // fogged tiles alongside the rest of the tile's silhouette. A node
        // disc that stayed lit through fog gave the controller away even when
        // every other prop on the hex was hidden.
        const tkey = hexKey(h.col, h.row);
        const props = this._tilePropsByKey.get(tkey);
        if (props) props.push(disc);
        else this._tilePropsByKey.set(tkey, [disc]);
        if (this._fogActiveSet.has(tkey)) disc.isVisible = false;
      }
    }
  }

  /** Apply the fog-of-war veil: swap fogged-tile materials to a darker variant
   *  and hide standees + props on fogged hexes. No-op when fog is inactive or
   *  there's no human observer (AI-vs-AI / spectator). */
  _applyFogVeil() {
    if (!this._scene) return;
    const state = this.state;
    const fogActive = state?.fogOfWar && state.fogOfWar !== 'none';
    const observerOwner = this._observerOwner();

    let target;
    if (!fogActive || !observerOwner) {
      target = null; // nothing fogged — unfog everything
    } else {
      target = this._buildFogVisibleHexes(observerOwner);
    }

    // Diff against the currently-fogged set: clear any previously-fogged tile
    // that is now visible, then fog any tile that should now be dark.
    for (const [k, mesh] of this._tileMeshByKey) {
      const shouldBeFogged = target ? !target.has(k) : false;
      const isFogged = this._fogActiveSet.has(k);
      if (shouldBeFogged && !isFogged) {
        this._setTileFogged(k, mesh, true);
      } else if (!shouldBeFogged && isFogged) {
        this._setTileFogged(k, mesh, false);
      }
    }

    // Hide standees on fogged hexes; reveal them when visible again. HP bars
    // are parented to the standee base but Babylon's `isVisible` does not
    // propagate to children, so we mirror visibility onto the HP bar mesh
    // explicitly — otherwise a hidden standee leaves a floating HP bar.
    if (target) {
      for (const [id, standee] of this._entityStandees) {
        const k = hexKey(standee.plane.metadata.col, standee.plane.metadata.row);
        const visible = shouldRenderEntityAt(target, k);
        if (standee.plane.isVisible !== visible) standee.plane.isVisible = visible;
        if (standee.base.isVisible  !== visible) standee.base.isVisible  = visible;
        const hp = this._hpBars.get(id);
        if (hp && hp.plane.isVisible !== visible) hp.plane.isVisible = visible;
      }
    } else {
      // No fog → make sure everything is visible (covers fog-toggling mid-game).
      for (const [id, standee] of this._entityStandees) {
        if (!standee.plane.isVisible) standee.plane.isVisible = true;
        if (!standee.base.isVisible)  standee.base.isVisible  = true;
        const hp = this._hpBars.get(id);
        if (hp && !hp.plane.isVisible) hp.plane.isVisible = true;
      }
    }
  }

  _setTileFogged(hexK, tileMesh, fogged) {
    const baseColor = tileMesh.metadata?.baseColor;
    if (!baseColor) return;
    tileMesh.material = fogged ? this._fogMaterialFor(baseColor) : this._materialFor(baseColor);
    const props = this._tilePropsByKey.get(hexK);
    if (props) for (const p of props) p.isVisible = !fogged;
    if (fogged) this._fogActiveSet.add(hexK);
    else this._fogActiveSet.delete(hexK);
  }

  _fogMaterialFor(baseHex) {
    if (this._fogMaterialCache.has(baseHex)) return this._fogMaterialCache.get(baseHex);
    const BABYLON = this._babylon;
    const [r, g, b] = cssHexToRgb01(baseHex);
    const mat = new BABYLON.StandardMaterial(`fog_${baseHex}`, this._scene);
    mat.diffuseColor  = new BABYLON.Color3(r * FOG_TILE_DARKEN, g * FOG_TILE_DARKEN, b * FOG_TILE_DARKEN);
    mat.specularColor = new BABYLON.Color3(0, 0, 0);
    mat.emissiveColor = new BABYLON.Color3(0, 0, 0);
    this._fogMaterialCache.set(baseHex, mat);
    return mat;
  }

  /** Determine which faction's perspective drives fog of war. Mirrors the 2D
   *  renderer's logic in src/renderer.js (`myFaction` if set, otherwise
   *  inferred from `witchIsAI`/`heroIsAI`); returns null in AI-vs-AI runs
   *  and spectator mode, which suppresses the veil entirely. */
  _observerOwner() {
    const state = this.state;
    if (!state) return null;
    // Prefer the explicit myFaction (set in online/PvP mode); fall back to
    // the unique human side in local-AI games.
    if (state.myFaction) return state.myFaction;
    if (state.witchIsAI && !state.heroIsAI)  return 'hero';
    if (state.heroIsAI  && !state.witchIsAI) return 'witch';
    return null;
  }
}

// ─── Tile top-face texture constants & pure helpers (exported for tests) ──

/** Disc radius multiplier relative to the cylinder radius. 1.0 lands exactly
 *  on the cylinder's hex edge; the disc and cylinder share matched vertex
 *  positions so the textured face covers the whole top without overhang. */
export const TERRAIN_DISC_RADIUS_MUL = 1.0;

/** Y offset for the textured disc above the cylinder top. Cylinder top sits
 *  at +0.075 (height = 0.15, centred at y=0); a 0.001 lift is enough to win
 *  the depth fight against the cylinder's coloured top face without reading
 *  as a visible gap. */
export const TERRAIN_DISC_Y_OFFSET = 0.076;

/** Variant counts for each terrain type that has multiple sprite variants.
 *  Mirrors the layout in `Renderer._buildSpriteRects()` — keep in step if the
 *  atlas grows new variants. Single-variant types (road / river / bridge) are
 *  intentionally absent here; `terrainSpriteIdFor` covers them separately. */
export const TERRAIN_VARIANT_COUNTS = Object.freeze({
  grass:  5,
  forest: 5,
  dirt:   5,
});

/**
 * Pure function: which terrain sprite (atlas id) should be used for the top
 * face of a given tile? Returns null when the tile type has no terrain sprite
 * we want to use — the renderer then leaves the cylinder's solid colour on
 * display.
 *
 * Mapping (mirrors the 2D `_drawTile` logic where it makes sense):
 *   • GRASS, FOREST, DIRT → matching `<type>_<N>` variant via the same hash
 *     used in the 2D renderer, so a given hex always picks the same variant.
 *   • BUILDING → a dirt variant (the building box/roof props sit on top).
 *   • ROAD, RIVER, BRIDGE → null (these tiles already carry their own prop
 *     mesh and a colour cue; texturing would muddle the read).
 *   • Anything else → null.
 */
export function terrainSpriteIdFor(tile, col, row) {
  if (!tile) return null;
  let baseType;
  if (tile.type === TileType.BUILDING) baseType = TileType.DIRT;
  else if (tile.type === TileType.GRASS || tile.type === TileType.FOREST || tile.type === TileType.DIRT) baseType = tile.type;
  // Road / river / bridge get a grass underlay sprite — the network pass
  // overlays bezier tubes on top of the grass, so the grass texture is what
  // shows on either side of the path.
  else if (tile.type === TileType.ROAD || tile.type === TileType.RIVER || tile.type === TileType.BRIDGE) {
    baseType = TileType.GRASS;
  } else return null;
  const count = TERRAIN_VARIANT_COUNTS[baseType] ?? 0;
  if (count > 1) {
    const v = (((col * 7 + row * 13 + col * row) % count) + count) % count + 1;
    return `${baseType}_${v}`;
  }
  return baseType;
}

// ─── Phase 3 pure helpers (exported for tests) ─────────────────────────────

/** World-space position of an entity's standee base centre. Useful for
 *  asserting expected camera targets and standee positions without touching
 *  Babylon. Y is the height at which the base disc sits on the tile prism. */
export function entityStandeeWorldPosition(col, row, radius = HEX_RADIUS_WORLD) {
  const { x, z } = hexToWorld(col, row, radius);
  return { x, y: STANDEE_BASE_Y_OFFSET, z };
}

/** Choose the base disc colour for an entity. Mirrors `_ownerColorFor` so it
 *  can be unit-tested without instantiating the renderer. */
export function entityBaseColor(entity) {
  if (entity?.color) return entity.color;
  if (entity?.owner) {
    const theme = getFactionTheme(entity.owner);
    if (theme?.primary) return theme.primary;
  }
  return '#888888';
}

// ─── Tile slot system (exported for tests) ──────────────────────────────────
//
// Every hex has 7 fixed "slots" arranged as 1 centre + 6 around the rim.
// Co-tenants on a hex (a building, the forest cluster, multiple standees) are
// assigned to deterministic slots so silhouettes don't pile up at the centre
// when more than one occupant lives on the same tile. Slots are described as
// (x, z) offsets from the hex centre, in world units, on the XZ ground plane.
//
//   slot 0 — centre. Reserved for standees (the common case: one unit per hex).
//   slot 1 — building anchor. Aligns with BUILDING_OFFSET for visual stability;
//            a building always occupies this slot when present.
//   slots 2–6 — outer ring at ~0.6 world units, used by trees and overflow
//            standees in deterministic id order.
//
// Outer-slot distance sits within [FOREST_INNER_RADIUS, FOREST_OUTER_RADIUS]
// so existing forest invariants (trees stay out of the centre) still hold.
export const TILE_SLOTS = Object.freeze([
  Object.freeze({ x:  0.00, z:  0.00 }), // 0 — centre
  Object.freeze({ x:  0.42, z: -0.42 }), // 1 — NE (building anchor, BUILDING_OFFSET)
  Object.freeze({ x: -0.42, z: -0.42 }), // 2 — NW
  Object.freeze({ x: -0.60, z:  0.00 }), // 3 — W
  Object.freeze({ x: -0.42, z:  0.42 }), // 4 — SW
  Object.freeze({ x:  0.42, z:  0.42 }), // 5 — SE
  Object.freeze({ x:  0.60, z:  0.00 }), // 6 — E
]);

/** Index of the centre slot (always preferred for the first standee). */
export const CENTRE_SLOT_INDEX = 0;
/** Index of the slot a building always occupies. */
export const BUILDING_SLOT_INDEX = 1;

/**
 * Pure slot assignment for a hex's occupants.
 *
 * Each occupant must be `{ id, kind: 'building' | 'tree' | 'standee' }`.
 * Returns `{ slotByOccupantId: Map<id, slotIndex>, overflow: number }` where
 * `overflow` is the count of standees beyond the 7-slot capacity (those
 * standees still appear in the map, all assigned to CENTRE_SLOT_INDEX, so the
 * +N badge stacks above the centre).
 *
 * Priority:
 *   • Buildings claim slot 1 (BUILDING_SLOT_INDEX). At most one building
 *     per tile is the normal case; extras spill to centre defensively.
 *   • Trees fill outer slots (1..6 minus the building slot) in id-sorted
 *     order. They never take the centre — the centre is reserved for a
 *     standee even on a fully-treed forest hex.
 *   • Standees take the centre first, then any still-free outer slot, then
 *     overflow stacks on the centre.
 *
 * Sort key is the string form of `id` so the function is stable across
 * runs regardless of insertion order in the caller.
 */
export function assignTileSlotIndices(occupants) {
  const out = new Map();
  if (!Array.isArray(occupants) || occupants.length === 0) {
    return { slotByOccupantId: out, overflow: 0 };
  }
  const buildings = [];
  const trees     = [];
  const standees  = [];
  for (const occ of occupants) {
    if (!occ || typeof occ !== 'object') continue;
    if (occ.kind === 'building') buildings.push(occ);
    else if (occ.kind === 'tree')  trees.push(occ);
    else if (occ.kind === 'standee') standees.push(occ);
  }
  const byId = (a, b) => {
    const ka = String(a.id), kb = String(b.id);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
  buildings.sort(byId); trees.sort(byId); standees.sort(byId);

  const used = new Set();
  // Buildings → slot 1.
  if (buildings.length > 0) {
    out.set(buildings[0].id, BUILDING_SLOT_INDEX);
    used.add(BUILDING_SLOT_INDEX);
    for (let i = 1; i < buildings.length; i++) {
      out.set(buildings[i].id, CENTRE_SLOT_INDEX);
    }
  }
  // Trees → outer slots (skip centre, skip building slot).
  const outerForTrees = [];
  for (let i = 1; i < TILE_SLOTS.length; i++) {
    if (!used.has(i)) outerForTrees.push(i);
  }
  for (let i = 0; i < trees.length && i < outerForTrees.length; i++) {
    out.set(trees[i].id, outerForTrees[i]);
    used.add(outerForTrees[i]);
  }
  // Standees → centre first, then any remaining free slot, then overflow at centre.
  const standeeSlots = [];
  if (!used.has(CENTRE_SLOT_INDEX)) standeeSlots.push(CENTRE_SLOT_INDEX);
  for (let i = 1; i < TILE_SLOTS.length; i++) {
    if (!used.has(i)) standeeSlots.push(i);
  }
  let overflow = 0;
  for (let i = 0; i < standees.length; i++) {
    if (i < standeeSlots.length) out.set(standees[i].id, standeeSlots[i]);
    else { out.set(standees[i].id, CENTRE_SLOT_INDEX); overflow++; }
  }
  return { slotByOccupantId: out, overflow };
}

/**
 * Convenience wrapper: same as `assignTileSlotIndices` but returns absolute
 * world (x, z) positions for each occupant on the named hex. Used by the
 * renderer to place building/tree props at build time and to re-slot standees
 * every draw.
 */
export function tileSlotWorldPositions(col, row, occupants, radius = HEX_RADIUS_WORLD) {
  const { slotByOccupantId, overflow } = assignTileSlotIndices(occupants);
  const { x: cx, z: cz } = hexToWorld(col, row, radius);
  const positionByOccupantId = new Map();
  for (const [id, slotIdx] of slotByOccupantId) {
    const slot = TILE_SLOTS[slotIdx] ?? TILE_SLOTS[CENTRE_SLOT_INDEX];
    positionByOccupantId.set(id, { x: cx + slot.x, z: cz + slot.z });
  }
  return { positionByOccupantId, overflow };
}

// ─── Road / river bezier networks (exported for tests) ─────────────────────
//
// Ports the 2D renderer's _drawRiverLayer / _drawRoadLayer logic to 3D.
// For each river/road/bridge tile we build smooth quadratic-bezier strokes
// between edge midpoints (control point = hex centre), then turn each stroke
// into a thin tube mesh; finally MergeMeshes collapses all tubes per network
// into ONE mesh per network so the GPU sees minimal draw calls.
//
// Tile underneath stays grass (see tileColorFor / terrainSpriteIdFor above).
// Bridges are special: they appear in BOTH networks (a water bezier flows
// through, a road bezier crosses); the bridge plank floats above both.

/** River tube radius in world units (≈ 0.3 wide). */
export const RIVER_TUBE_RADIUS = 0.15;
/** Road tube radius in world units (≈ 0.2 wide). */
export const ROAD_TUBE_RADIUS  = 0.10;
/** Y above tile prism top (0.075) — river sits just above the terrain disc. */
export const RIVER_TUBE_Y      = 0.085;
/** Road sits a touch above the river so over-bridge crossings layer cleanly. */
export const ROAD_TUBE_Y       = 0.095;
/** Number of bezier samples per stroke. 10 is smooth enough at this radius
 *  without bloating the tube vertex count on Campaign-size maps. */
export const NETWORK_BEZIER_SEGMENTS = 10;

/** Apothem (centre-to-edge distance) for a unit-radius pointy-top hex. */
const HEX_APOTHEM = SQRT3 / 2;

/** Sample a quadratic bezier (p0, control p1, p2) at N+1 evenly-spaced t in [0,1].
 *  Pure — used by the network builder and exposed for unit tests. */
export function sampleQuadBezier(p0, p1, p2, segments = NETWORK_BEZIER_SEGMENTS) {
  const out = [];
  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const u = 1 - t;
    out.push({
      x: u * u * p0.x + 2 * u * t * p1.x + t * t * p2.x,
      z: u * u * p0.z + 2 * u * t * p1.z + t * t * p2.z,
    });
  }
  return out;
}

/** Unit vector and edge midpoint from hex centre `here` toward neighbour `there`.
 *  Returns `{ dx, dz, mx, mz }` — dx/dz normalised; mx/mz the point on the
 *  shared hex edge halfway between centres. */
export function _edgeTo(here, there, radius = HEX_RADIUS_WORLD) {
  const dx = there.x - here.x;
  const dz = there.z - here.z;
  const d  = Math.hypot(dx, dz) || 1;
  const apo = HEX_APOTHEM * radius;
  return {
    dx: dx / d, dz: dz / d,
    mx: here.x + (dx / d) * apo,
    mz: here.z + (dz / d) * apo,
  };
}

/**
 * Compute the bezier strokes for a single river OR road tile.
 *
 *   tile         — the source tile (uses tile.col, tile.row)
 *   neighbours   — array of neighbour offset {col,row} objects that count as
 *                  connected (RIVER+BRIDGE for river network; tile.roadDirs
 *                  → ROAD/BRIDGE/BUILDING for road network).
 *   opts.kind    — 'river' (default) or 'road'. Controls 1-neighbour behaviour:
 *                  rivers extend off-tile (water flows off the map edge),
 *                  roads draw a centre→edge stub (dead-end at a building).
 *
 * Returns an array of "strokes" — each stroke is an array of `{x, z}` sample
 * points (≥ 2 entries) suitable for turning into a tube. May return [] for
 * tiles that should not draw (e.g. an isolated river hex with 0 neighbours).
 *
 * Mirrors src/renderer.js's per-tile geometry:
 *   • 1 neighbour  → river: through-bezier from the off-tile extension to the
 *                    edge. Road: straight stub from centre to edge midpoint.
 *   • 2 neighbours → smooth bezier through centre between the two edges.
 *   • 3+ neighbours → through-bezier on the most-opposing pair, straight
 *                     spokes from centre to the remaining edges.
 */
export function networkStrokesForTile(tile, neighbours, opts = {}) {
  if (!tile || !Array.isArray(neighbours) || neighbours.length === 0) return [];
  const radius = opts.radius ?? HEX_RADIUS_WORLD;
  const segments = opts.segments ?? NETWORK_BEZIER_SEGMENTS;
  const kind = opts.kind ?? 'river';
  const here = hexToWorld(tile.col, tile.row, radius);
  const edges = neighbours.map(n => {
    const there = hexToWorld(n.col, n.row, radius);
    return _edgeTo(here, there, radius);
  });
  const strokes = [];

  if (edges.length === 1) {
    const e = edges[0];
    if (kind === 'road') {
      // Dead-end stub: straight line from centre to the edge midpoint facing
      // the lone neighbour (matches the 2D path at building entrances).
      strokes.push([{ x: here.x, z: here.z }, { x: e.mx, z: e.mz }]);
      return strokes;
    }
    // River: extend off-tile in the opposite direction so endpoints fade past
    // the hex border (matches the 2D path's behaviour at map-edge river tiles).
    const apo = HEX_APOTHEM * radius;
    const p0 = { x: here.x - e.dx * apo, z: here.z - e.dz * apo };
    const p1 = here;
    const p2 = { x: e.mx, z: e.mz };
    strokes.push(sampleQuadBezier(p0, p1, p2, segments));
    return strokes;
  }

  // Pick the most-opposing pair (lowest dot product of unit vectors).
  let pA = 0, pB = 1, minDot = Infinity;
  for (let i = 0; i < edges.length; i++) {
    for (let j = i + 1; j < edges.length; j++) {
      const dot = edges[i].dx * edges[j].dx + edges[i].dz * edges[j].dz;
      if (dot < minDot) { minDot = dot; pA = i; pB = j; }
    }
  }
  const p0 = { x: edges[pA].mx, z: edges[pA].mz };
  const p1 = here;
  const p2 = { x: edges[pB].mx, z: edges[pB].mz };
  strokes.push(sampleQuadBezier(p0, p1, p2, segments));

  // Spokes for any extra branches — straight lines from centre to edge.
  for (let i = 0; i < edges.length; i++) {
    if (i === pA || i === pB) continue;
    strokes.push([{ x: here.x, z: here.z }, { x: edges[i].mx, z: edges[i].mz }]);
  }
  return strokes;
}

/**
 * Walk the full map and build every river segment's bezier strokes.
 * Returns an array of `{ tile, strokes }`. Pure — takes the tile map by
 * reference and a hexKey helper so tests can stub them.
 *
 * River network tiles: RIVER and BRIDGE; neighbours: RIVER and BRIDGE.
 */
export function buildRiverNetworkStrokes(tiles, hexKeyFn = hexKey, getNeighborsFn = getNeighbors) {
  if (!tiles || typeof tiles.values !== 'function') return [];
  const isWater = t => t && (t.type === TileType.RIVER || t.type === TileType.BRIDGE);
  const out = [];
  for (const tile of tiles.values()) {
    if (!isWater(tile)) continue;
    const nbrs = getNeighborsFn(tile.col, tile.row)
      .filter(n => isWater(tiles.get(hexKeyFn(n.col, n.row))));
    if (nbrs.length === 0) continue;
    const strokes = networkStrokesForTile(tile, nbrs);
    if (strokes.length > 0) out.push({ tile, strokes });
  }
  return out;
}

/**
 * Walk the full map and build every road segment's bezier strokes.
 * Road network tiles: ROAD and BRIDGE. Neighbours come from
 * `tile.roadDirs` (a Set of hexKeys recorded at generation time) — this is
 * what the 2D renderer uses, so phantom-junction inference is avoided.
 */
export function buildRoadNetworkStrokes(tiles, hexKeyFn = hexKey) {
  if (!tiles || typeof tiles.values !== 'function') return [];
  const out = [];
  for (const tile of tiles.values()) {
    if (!tile || (tile.type !== TileType.ROAD && tile.type !== TileType.BRIDGE)) continue;
    if (!tile.roadDirs || tile.roadDirs.size === 0) continue;
    const nbrs = [];
    for (const k of tile.roadDirs) {
      const nt = tiles.get(k);
      if (nt) nbrs.push({ col: nt.col, row: nt.row });
    }
    if (nbrs.length === 0) continue;
    const strokes = networkStrokesForTile(tile, nbrs, { kind: 'road' });
    if (strokes.length > 0) out.push({ tile, strokes });
  }
  return out;
}

// ─── Forest layout (deterministic per hex, exported for tests) ──────────────

/** Bounds for the forest tree ring around a hex centre. Trees never enter the
 *  inner FOREST_INNER_RADIUS so an entity standee placed on the tile is not
 *  hidden by props. Outer bound stays clear of the hex edge so trees don't
 *  bleed visually into neighbouring tiles at oblique camera angles. */
export const FOREST_INNER_RADIUS = 0.5;
export const FOREST_OUTER_RADIUS = 0.85;
/** Per-tree scale range — picked from a hash so the same hex always looks the
 *  same across runs but the cluster reads as visually varied. */
export const FOREST_SCALE_MIN = 0.5;
export const FOREST_SCALE_MAX = 1.2;
/** Cluster size range (inclusive). */
export const FOREST_TREES_MIN = 3;
export const FOREST_TREES_MAX = 5;

/** Deterministic [0, 1) hash from (col, row, salt). Tiny integer mixer — not
 *  cryptographic, just stable across runs and well-distributed enough for
 *  placement jitter. */
function _forestHash(col, row, salt) {
  let h = ((col | 0) * 73856093) ^ ((row | 0) * 19349663) ^ ((salt | 0) * 83492791);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h = (h ^ (h >>> 16)) >>> 0;
  return h / 0x100000000;
}

/** Deterministic forest layout for a hex. Returns an array of
 *  `{ id, x, z, scale, slotIdx }` entries — N entries where
 *  N ∈ [FOREST_TREES_MIN, FOREST_TREES_MAX]. Positions come from the unified
 *  tile-slot system (outer ring only — the centre is reserved for standees).
 *  Per-tree scale stays varied via a hex-stable hash so the cluster reads as
 *  organic rather than mechanically tiled. Pure: same (col, row) → same trees. */
export function forestTreesForHex(col, row) {
  const span = FOREST_TREES_MAX - FOREST_TREES_MIN + 1;
  const n    = FOREST_TREES_MIN + Math.floor(_forestHash(col, row, 0) * span);
  // _forestHash returns < 1, so floor(<span) ∈ [0, span-1]; n ∈ [MIN, MAX].
  const scaleSpan = FOREST_SCALE_MAX - FOREST_SCALE_MIN;
  // Rotate the slot order per-hex so neighbouring forest hexes don't all
  // start at the same NE slot — keeps the visual variety the ring layout had.
  const rotation = Math.floor(_forestHash(col, row, 99) * 6);
  // Build deterministic occupant ids; assignTileSlotIndices sorts by id, so
  // a rotation embedded in the id is what reorders the slot picks.
  const occupants = [];
  for (let i = 0; i < n; i++) {
    const order = ((i + rotation) % 6).toString().padStart(2, '0');
    occupants.push({ id: `tree_${order}_${i}`, kind: 'tree', _idx: i });
  }
  const { slotByOccupantId } = assignTileSlotIndices(occupants);
  const trees = [];
  for (const occ of occupants) {
    const slotIdx = slotByOccupantId.get(occ.id) ?? CENTRE_SLOT_INDEX;
    const slot = TILE_SLOTS[slotIdx];
    const scale = FOREST_SCALE_MIN + _forestHash(col, row, occ._idx * 3 + 3) * scaleSpan;
    trees.push({ id: occ.id, x: slot.x, z: slot.z, scale, slotIdx });
  }
  return trees;
}

// ─── Phase 6 constants (exported for tests) ─────────────────────────────────

/** Hemispheric-light + clear-colour config per game phase.
 *  intensity → light.intensity; color → light.diffuse (warm at dawn/dusk,
 *  white at day, cool blue at night); clear → scene.clearColor (sky/horizon
 *  tint that shows through gaps and behind transparent props). */
export const PHASE_LIGHT_CONFIG = Object.freeze({
  dawn:  { intensity: 1.00, color: { r: 1.00, g: 0.82, b: 0.62 }, clear: { r: 0.55, g: 0.38, b: 0.36 } },
  day:   { intensity: 1.20, color: { r: 1.00, g: 1.00, b: 0.97 }, clear: { r: 0.55, g: 0.72, b: 0.85 } },
  dusk:  { intensity: 1.00, color: { r: 1.00, g: 0.62, b: 0.48 }, clear: { r: 0.50, g: 0.32, b: 0.36 } },
  night: { intensity: 0.85, color: { r: 0.70, g: 0.78, b: 1.00 }, clear: { r: 0.12, g: 0.18, b: 0.32 } },
});

/** Look up a phase's lighting config. Falls back to DAY if the phase is
 *  unrecognised (defensive — keeps the renderer usable on weird save loads). */
export function getPhaseLightConfig(phase) {
  return PHASE_LIGHT_CONFIG[phase] ?? PHASE_LIGHT_CONFIG.day;
}

/** Power Node glow palette by controller. Playtest feedback: previous values
 *  read as washed out in the lit 3D scene, so each is bumped toward full
 *  saturation. Hero = vivid gold, witch = vivid sickly green, neutral = pale
 *  white, contested = vivid orange (matches the 2D path's contested overlay
 *  family but pushed harder so the disc reads from across the map). */
export const NODE_GLOW_COLORS = Object.freeze({
  hero:      '#ffb800',
  witch:     '#3ee013',
  neutral:   '#e8e8e8',
  contested: '#ff6a00',
});

/** Choose a node's glow colour by current controller. */
export function getNodeGlowColor(controller) {
  return NODE_GLOW_COLORS[controller] ?? NODE_GLOW_COLORS.neutral;
}

/** Duration of phase-to-phase light cross-fade. */
export const PHASE_TRANSITION_MS = 3000;

/** GlowLayer intensity (applied to selection halo + node-glow discs). Round
 *  4: dropped 0.7 → 0.5 because the higher value blew HP bars and waypoint
 *  badges (white emissive ≈ 1.0) into a milky halo at zoomed-out distances.
 *  The glow layer also runs in *include-only* mode now (see `_glowLayer.addIncludedOnlyMesh`
 *  calls in `_buildNodeGlowMeshes` + `_applySelectionAndFocus`) — so only the
 *  selection halo and node discs contribute. Other emissive meshes (HP bars,
 *  waypoint badges, floating text) no longer bloom regardless of intensity. */
export const GLOW_LAYER_INTENSITY = 0.5;

/** Selection halo pulse. Configurable so designers can tune the breathing.
 *  Round 3: dialled MIN/MAX down ~50% — earlier values produced a halo bright
 *  enough to swallow the standee silhouette at zoomed-out distances. */
export const SELECTION_PULSE_PERIOD_MS = 1500;
export const SELECTION_PULSE_MIN       = 0.18;
export const SELECTION_PULSE_MAX       = 0.45;
/** Base cyan emissive that the selection pulse modulates each frame. */
export const SELECTION_EMISSIVE_BASE = Object.freeze({ r: 0.25, g: 0.85, b: 0.95 });

/** Power-node glow pulse — slower than the selection, so the two reads as
 *  distinct visual languages. */
export const NODE_PULSE_PERIOD_MS = 3000;
export const NODE_PULSE_MIN       = 0.45;
export const NODE_PULSE_MAX       = 0.95;
/** The disc now carries the full node-glow read (the shaft was dropped), so
 *  emissive intensity is pinned at 1.0 instead of attenuated. */
export const NODE_DISC_EMISSIVE_MUL = 1.0;
/** Disc footprint in world units. Slightly larger than the historical 1.7 so
 *  the saturated colour fills more of the tile's visible top. */
export const NODE_DISC_DIAMETER = 1.9;
/** Disc material alpha — high enough to read as solid colour, low enough that
 *  the underlying tile colour still bleeds through faintly. */
export const NODE_DISC_ALPHA = 0.88;

/** Multiplier applied to fogged-tile diffuse colour. Round 4: bumped
 *  0.32 → 0.55 after playtest feedback that fogged tiles read as nearly black
 *  on the 3D path — terrain identity was barely legible. 0.55 keeps tiles
 *  visibly dimmed (~half brightness) while preserving "there's grass / dirt
 *  / forest there" reads. Props + standees still hide via `_applyFogVeil`. */
export const FOG_TILE_DARKEN = 0.55;

// ─── Night lanterns subsystem (Piper) — pure constants & helpers ────────────
//
// Phase 6 mini-feature: warm flickering point-lights around living units at
// night. Daytime returns 0 so the lanterns are effectively off — they only
// re-enable themselves on the fade-in into dusk/night. The subsystem is
// intentionally read-only against the rest of Phase 6 (it never touches
// `_glowLayer.intensity`, the selection halo, or the fog-darken constant) so
// it composes cleanly with the existing atmosphere stack.

/** Per-phase peak intensity for each unit's lantern PointLight. Day is exactly
 *  zero — the subsystem fades to "no contribution" at sunrise. Dawn and dusk
 *  are intermediate so dim-out / dim-in feel natural across the cycle. */
export const LANTERN_INTENSITY_BY_PHASE = Object.freeze({
  dawn:  0.3,
  day:   0.0,
  dusk:  0.4,
  night: 0.8,
});

/** Look up a phase's lantern peak intensity. Unknown phases default to 0 so
 *  the renderer stays safe under unexpected save loads. */
export function lanternIntensityForPhase(phase) {
  return LANTERN_INTENSITY_BY_PHASE[phase] ?? 0;
}

/** Warm amber tint applied to both diffuse and specular on each PointLight.
 *  Chosen by eye against the night clear-colour (cool blue ~#1f2e52) so the
 *  warm/cool contrast reads strongly without looking neon. */
export const LANTERN_COLOR_HEX = '#ffb060';

/** Babylon-world units. ~3.5 covers ~3–4 hex radii at the playmat's hex
 *  spacing, so a lantern lights up its immediate hex and the ring around it. */
export const LANTERN_RANGE = 3.5;

/** Vertical offset above the standee base where the PointLight sits — about
 *  chest height on the standee plane, so it shines outward from where a
 *  carried lantern would be held. */
export const LANTERN_HEIGHT_OFFSET = 0.6;

/** Phase-transition fade for the lantern peak intensity. Matches
 *  PHASE_TRANSITION_MS so the hemispheric light and the lanterns cross-fade
 *  in lockstep rather than reading as two separate events. */
export const LANTERN_FADE_MS = PHASE_TRANSITION_MS;

/** Flicker frequencies (Hz). The slow band carries the breathing pulse; the
 *  fast band adds an irregular wobble so the result reads as "candle flame",
 *  not "sine wave". */
export const LANTERN_FLICKER_FREQ_HZ      = 2;
export const LANTERN_FLICKER_FAST_FREQ_HZ = 7;

/** Per-StandardMaterial simultaneous-light cap to override Babylon's default
 *  of 4. On a Standard map there can be 10–20 live entities; without this
 *  bump only the first 4 lanterns added would affect each tile's shader. */
export const LANTERN_MATERIAL_LIGHT_CAP = 16;

/** Flicker scale for one lantern at time `nowMs`. Returns a unit-less
 *  multiplier in [0.7, 1.1] — the per-light intensity is `base * flickerScale`.
 *  The fast-band term is a product of two offset sines (deterministic and
 *  pseudo-noisy without a dependency on `Math.random`). Output is clamped to
 *  the documented band so callers / tests can rely on tight bounds. */
export function flickerScale(
  nowMs,
  phaseOffset = 0,
  freqHz     = LANTERN_FLICKER_FREQ_HZ,
  fastFreqHz = LANTERN_FLICKER_FAST_FREQ_HZ,
) {
  const tSec       = nowMs / 1000;
  const TWO_PI     = Math.PI * 2;
  const slowAngle  = tSec * freqHz * TWO_PI + phaseOffset;
  const slow       = 0.85 + 0.15 * Math.sin(slowAngle);
  // Two-frequency pseudo-noise: product of two offset sines is in [-1, 1].
  const noise      = Math.sin(tSec * fastFreqHz * TWO_PI * 1.31 + 0.7)
                   * Math.cos(tSec * fastFreqHz * TWO_PI * 0.73 + 1.31);
  const fast       = 1 + 0.05 * noise;
  const raw        = slow * fast;
  // Clamp to the documented band — defensive against future tuning that
  // widens slow/fast amplitudes past where the math overlaps.
  if (raw < 0.7) return 0.7;
  if (raw > 1.1) return 1.1;
  return raw;
}

/** Lantern lifecycle diff: classify each live entity as `add` (new lantern
 *  needed), `keep` (already lit, leave the PointLight alone), or, for ids in
 *  `priorIds` that aren't in the live set, `remove` (dispose). Pure — exported
 *  so the lifecycle can be unit-tested without Babylon.
 *
 *  Dead entities and entities missing col/row are filtered out — they're
 *  treated as "not present", so a lantern for a dying unit lands in `remove`
 *  on the same frame the standee disposes. */
export function diffLanternLifecycle(priorIds, currentEntities) {
  const add = [];
  const keep = [];
  const remove = [];
  const seen = new Set();
  for (const e of currentEntities ?? []) {
    if (!e || !e.alive) continue;
    if (typeof e.col !== 'number' || typeof e.row !== 'number') continue;
    seen.add(e.id);
    if (priorIds.has(e.id)) keep.push(e.id);
    else add.push(e.id);
  }
  for (const id of priorIds) {
    if (!seen.has(id)) remove.push(id);
  }
  return { add, keep, remove };
}

/** Cubic ease-in-out — interpolates 0→1 smoothly with no jolt at endpoints. */
export function easeInOutCubic(u) {
  if (u <= 0) return 0;
  if (u >= 1) return 1;
  return u < 0.5
    ? 4 * u * u * u
    : 1 - Math.pow(-2 * u + 2, 3) / 2;
}

/** Lerp two light-config snapshots: intensity (scalar) + diffuse + clear
 *  (each {r,g,b}). Exported so phase-transition math can be unit-tested
 *  without a Babylon scene. */
export function lerpLightConfig(from, to, t) {
  const tt = Math.min(1, Math.max(0, t));
  const lerp = (a, b) => a + (b - a) * tt;
  return {
    intensity: lerp(from.intensity, to.intensity),
    color: {
      r: lerp(from.color.r, to.color.r),
      g: lerp(from.color.g, to.color.g),
      b: lerp(from.color.b, to.color.b),
    },
    clear: {
      r: lerp(from.clear.r, to.clear.r),
      g: lerp(from.clear.g, to.clear.g),
      b: lerp(from.clear.b, to.clear.b),
    },
  };
}

/** Sine-driven pulse mapping `nowMs` into the [min, max] range over `periodMs`. */
export function pulseFactor(nowMs, periodMs, min, max) {
  const phase = (2 * Math.PI * (nowMs % periodMs)) / periodMs;
  const sin01 = (Math.sin(phase) + 1) / 2; // 0..1
  return min + (max - min) * sin01;
}

/**
 * Pure-functional fog-of-war visibility set. Returns the union of all hex
 * keys within sight range of every alive entity owned by `observerOwner`.
 *
 * Iterates `state.entities` and `state.tiles` (cheap — even a Campaign-size
 * map is ~300 tiles); does NOT include attacker-reveal hints (those live in
 * the animation layer and are layered on top by the 3D renderer separately).
 * Always returns a Set, never null — caller decides whether to apply it via
 * the fogOfWar state field gate.
 */
export function buildFogVisibleSet(state, observerOwner) {
  const visible = new Set();
  if (!state?.entities || !state?.tiles || !observerOwner) return visible;
  for (const e of state.entities) {
    if (!e || !e.alive || e.owner !== observerOwner) continue;
    const range = sightRangeForEntity(e, state.phase);
    for (const tile of state.tiles.values()) {
      if (hexDistance(tile.col, tile.row, e.col, e.row) <= range) {
        visible.add(hexKey(tile.col, tile.row));
      }
    }
  }
  return visible;
}

/**
 * Pure visibility predicate for entity-attached props (HP bars, halos) given
 * a fog-visible-set and the entity's hex key. Wrapped as a helper so the
 * HP-bar-follows-fog rule can be unit-tested without instantiating Babylon.
 * `target` may be null (no fog active) — in which case everything is visible.
 */
export function shouldRenderEntityAt(target, hexK) {
  if (!target) return true;
  return target.has(hexK);
}

/**
 * Pure-functional diff of an existing standee map against a list of live
 * entities. Returns the {add, keep, remove} bucket sets so callers can drive
 * the actual mesh creation/disposal separately. Living + on-map = candidate;
 * everything else is filtered out before bucketing.
 */
export function diffStandees(existingIds, entities) {
  const existing = existingIds instanceof Set ? existingIds : new Set(existingIds);
  const liveIds  = new Set();
  for (const e of entities || []) {
    if (!e || e.alive === false) continue;
    if (typeof e.col !== 'number' || typeof e.row !== 'number') continue;
    liveIds.add(e.id);
  }
  const add = new Set(), keep = new Set(), remove = new Set();
  for (const id of liveIds) {
    (existing.has(id) ? keep : add).add(id);
  }
  for (const id of existing) {
    if (!liveIds.has(id)) remove.add(id);
  }
  return { add, keep, remove };
}

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5 pure helpers — exported for tests (no Babylon, no DOM)
// ═══════════════════════════════════════════════════════════════════════════

/** Duration (ms) of a single-hex slide. ~250ms — fast enough to keep pace
 *  with the resolution loop but slow enough to read direction. */
export const MOVE_ANIM_MS = 250;

/** Duration (ms) of an attack-lunge slide to the midpoint. ~200ms — sharper
 *  than a move; sells the lunge as an aggressive, decisive action. */
export const LUNGE_ANIM_MS = 200;

/** Duration (ms) of a projectile arc. ~320ms — matches the 2D path's
 *  default `addProjectileAnim` duration. */
export const PROJECTILE_ANIM_MS = 320;

/** Default lifetime (ms) of a floating combat text label. ~700ms — long
 *  enough to read "CRUSH 3", short enough not to back up the queue. */
export const FLOAT_TEXT_MS = 700;

/** HP-bar height (world units) above the standee's base disc. */
export const HP_BAR_Y_ABOVE_BASE = 0.2;

/** Plan-marker disc — flat owner-tinted circle laid on the destination hex
 *  top. Y just clears the tile prism top (0.075) and the road deck (0.155)
 *  so it reads against both terrain and crossings. (Retained for back-compat
 *  / tests; the round-4 markers now use the smaller PLAN_MARKER_* geometry.) */
export const PLAN_DISC_Y     = 0.16;
export const PLAN_DISC_ALPHA = 0.85;

/** Round 4 waypoint marker — small ground puck under the numbered badge so
 *  the underlying terrain stays visible. Diameter shrunk from 1.4 (a full
 *  hex's worth) → 0.36, height 0.02 (almost flush with the tile top), Y =
 *  0.08 (just above tile top). */
export const PLAN_MARKER_DIAMETER = 0.36;
export const PLAN_MARKER_HEIGHT   = 0.02;
export const PLAN_MARKER_Y        = 0.08;

/** Dashed-line Y for the path-connector tracing the planned waypoints.
 *  Raised well above the marker puck top (0.09) and the highlight disc
 *  layer (0.085) so the tube segments clear ground geometry without any
 *  z-fight. Sits well below the floating badge (0.6) so it still reads
 *  as ground-anchored, not floating. */
export const PLAN_LINE_Y = 0.18;

/** Tube radius for each dash segment. Tuned for "visibly chunky" without
 *  overpowering the waypoint puck (0.36 diameter) — ~33% of the marker's
 *  half-width. Native WebGL `LinesMesh` width is driver-capped at ~1px, so
 *  we render dashes as 3D tubes to get reliable thickness across devices. */
export const PLAN_LINE_RADIUS = 0.06;

/** Dash + gap length in world units. One hex-step is ~sqrt(3) ≈ 1.73 wu,
 *  so a 0.28 dash + 0.16 gap yields ~4 chunky dashes per hop. */
export const PLAN_LINE_DASH_SIZE = 0.28;
export const PLAN_LINE_GAP_SIZE  = 0.16;

/** Plan ghost — translucent standee clone walking the planned path. */
export const PLAN_GHOST_ALPHA          = 0.4;
/** Duration (ms) of a single step of the walking ghost. */
export const PLAN_GHOST_STEP_MS        = 600;
/** Duration (ms) of the post-arrival fade before the ghost teleports back to
 *  the path's origin and starts the next cycle. */
export const PLAN_GHOST_FADE_MS        = 280;

/**
 * Group MOVE arrows from a `planGhostSteps` array into per-entity paths.
 * Returns Map<entityId, [{col,row}, ...]> where each path starts at the move's
 * origin and lists every subsequent destination in plan order. Entities with
 * no MOVE actions don't appear in the map.
 */
export function computePlanGhostPaths(steps) {
  const paths = new Map();
  if (!Array.isArray(steps)) return paths;
  for (const s of steps) {
    if (!s?.arrow) continue;
    const { entityId, fromCol, fromRow, toCol, toRow } = s.arrow;
    let arr = paths.get(entityId);
    if (!arr) {
      arr = [{ col: fromCol, row: fromRow }];
      paths.set(entityId, arr);
    }
    arr.push({ col: toCol, row: toRow });
  }
  return paths;
}

/**
 * Slice a straight 2D segment (XZ plane, fixed Y) into dash-and-gap tube
 * pieces. Returns an array of `{ start: {x,y,z}, end: {x,y,z} }` ready to
 * feed to `MeshBuilder.CreateTube({ path: [start, end], radius })`. Used
 * by the plan-arrow path connector to render thick, z-fight-free dashes
 * (native `LinesMesh` width is driver-capped at ~1px).
 *
 * The dash pattern always *starts with a dash* at `p1` and ends either on
 * a full dash (if the segment length aligns) or truncates the trailing
 * dash if a stub > 25% of `dashSize` remains. Short stubs are dropped to
 * avoid visually awkward fragments.
 */
export function computeDashSegments(p1, p2, dashSize, gapSize, y = 0) {
  const segs = [];
  if (!p1 || !p2 || !(dashSize > 0)) return segs;
  const dx = p2.x - p1.x;
  const dz = p2.z - p1.z;
  const total = Math.hypot(dx, dz);
  if (total === 0) return segs;
  const gap = Math.max(0, gapSize);
  const period = dashSize + gap;
  const ux = dx / total;
  const uz = dz / total;
  const minStub = dashSize * 0.25;
  let offset = 0;
  while (offset < total) {
    const startT = offset;
    const endT = Math.min(offset + dashSize, total);
    if (endT - startT < minStub) break;
    segs.push({
      start: { x: p1.x + ux * startT, y, z: p1.z + uz * startT },
      end:   { x: p1.x + ux * endT,   y, z: p1.z + uz * endT },
    });
    offset += period;
  }
  return segs;
}

/**
 * Lifecycle pose of a plan-ghost at clock `nowMs` for a path of `pathLen`
 * vertices (origin + N destinations). Returns the segment index, the
 * within-segment progress `segT ∈ [0,1]`, and the alpha modulation.
 *
 * Cycle layout (per ghost, looping):
 *   • Walk: pathLen - 1 segments of PLAN_GHOST_STEP_MS each.
 *   • Fade: PLAN_GHOST_FADE_MS of fading-then-snap-back.
 *
 * When pathLen ≤ 1 (no destinations), returns segment 0 / segT 0 / alpha 1 —
 * a still ghost at the origin, which the caller renders harmlessly.
 */
export function planGhostPose(nowMs, pathLen) {
  if (!Number.isFinite(pathLen) || pathLen <= 1) {
    return { segment: 0, segT: 0, alpha: 1 };
  }
  const segCount = pathLen - 1;
  const cycle = segCount * PLAN_GHOST_STEP_MS + PLAN_GHOST_FADE_MS;
  const tInCycle = ((nowMs % cycle) + cycle) % cycle;
  if (tInCycle < segCount * PLAN_GHOST_STEP_MS) {
    const segment = Math.floor(tInCycle / PLAN_GHOST_STEP_MS);
    const segT = (tInCycle - segment * PLAN_GHOST_STEP_MS) / PLAN_GHOST_STEP_MS;
    return { segment, segT, alpha: 1 };
  }
  // Fade phase: hold at last destination, alpha lerps 1 → 0.
  const fadeT = (tInCycle - segCount * PLAN_GHOST_STEP_MS) / PLAN_GHOST_FADE_MS;
  return {
    segment: segCount - 1,
    segT: 1,
    alpha: Math.max(0, 1 - fadeT),
  };
}

/** HP-bar ratio thresholds — kept as constants so the test can assert them
 *  without re-deriving from the rendering function. */
export const HP_RED_BELOW    = 0.33;
export const HP_YELLOW_BELOW = 0.66;

/**
 * Linear interpolation between two hex world positions. At t=0 returns the
 * source, at t=1 the destination, and at t=0.5 the midpoint. Used by the
 * standee move/lunge animations and unit-tested independently of Babylon.
 */
export function interpolatePosition(from, to, t) {
  const clamped = Math.max(0, Math.min(1, t));
  return {
    x: from.x + (to.x - from.x) * clamped,
    z: from.z + (to.z - from.z) * clamped,
  };
}

/**
 * Polyline points for a single ghost-arrow segment, raised slightly above
 * the tile prism so the dashed line reads against the terrain. The arrow is
 * a straight line for now (no curved/arced ghost arrows) — matches the 2D
 * path's straight-line idiom. `height` is the world-Y the arrow floats at.
 */
export function planArrowPolyline(fromCol, fromRow, toCol, toRow, height = 0.85) {
  const a = hexToWorld(fromCol, fromRow);
  const b = hexToWorld(toCol,   toRow);
  return [
    { x: a.x, y: height, z: a.z },
    { x: b.x, y: height, z: b.z },
  ];
}

/**
 * World-space position of the numbered badge for a plan step — sits at the
 * arrow's terminating hex centre, slightly above the tile prism. Exposed
 * separately from `planArrowPolyline` so callers can place the badge label
 * without re-running the line-build math.
 */
export function planArrowBadgePosition(toCol, toRow, height = 1.0) {
  const { x, z } = hexToWorld(toCol, toRow);
  return { x, y: height, z };
}

/**
 * Rotation (radians, around world Y) for a bridge plank so its long axis
 * crosses the river perpendicularly. Mirrors the 2D path's bridge-crossing
 * heuristic in `_drawRoadLayer`: find the two water neighbours most opposed
 * across the bridge hex, use the line between them as the river axis, and
 * orient the plank's long side perpendicular to that axis.
 *
 *   • 0 water neighbours → returns 0 (no rotation; nothing to perpend to).
 *   • 1 water neighbour  → uses the direction *to* that neighbour as the axis.
 *   • 2+ water neighbours → picks the most-opposing pair (dot product closest
 *     to -1) and uses the displacement between them as the axis.
 *
 * The plank's default geometry is `{ width: 1.7, depth: 0.7 }` — wide along X,
 * narrow along Z. Babylon's left-handed Y-up rotation.y rotates the +X axis
 * toward +Z (i.e. rotation.y = θ takes X → (cos θ, 0, sin θ)). We want the
 * plank's +X to land on the perpendicular direction, so:
 *
 *     rotation.y = atan2(axisZ, axisX) + π/2
 *
 * `tilesByKey` is a Map<hexKey, Tile> — typically the state's `tiles` map.
 * Exposed as a pure function so tests can lock down the math without Babylon.
 */
export function bridgeRotationY(tile, tilesByKey) {
  if (!tile || !tilesByKey) return 0;
  const here = hexToWorld(tile.col, tile.row);
  const waterDirs = [];
  for (const n of getNeighbors(tile.col, tile.row)) {
    const nt = tilesByKey.get(hexKey(n.col, n.row));
    if (!nt) continue;
    if (nt.type !== TileType.RIVER && nt.type !== TileType.BRIDGE) continue;
    const there = hexToWorld(n.col, n.row);
    waterDirs.push({ dx: there.x - here.x, dz: there.z - here.z });
  }
  if (waterDirs.length === 0) return 0;

  let axisX, axisZ;
  if (waterDirs.length === 1) {
    axisX = waterDirs[0].dx;
    axisZ = waterDirs[0].dz;
  } else {
    // Pick the pair with the most-opposed unit vectors (lowest dot product).
    let bestDot = Infinity;
    let bestPair = [waterDirs[0], waterDirs[1]];
    for (let i = 0; i < waterDirs.length; i++) {
      for (let j = i + 1; j < waterDirs.length; j++) {
        const a = waterDirs[i], b = waterDirs[j];
        const la = Math.hypot(a.dx, a.dz) || 1;
        const lb = Math.hypot(b.dx, b.dz) || 1;
        const dot = (a.dx * b.dx + a.dz * b.dz) / (la * lb);
        if (dot < bestDot) { bestDot = dot; bestPair = [a, b]; }
      }
    }
    axisX = bestPair[1].dx - bestPair[0].dx;
    axisZ = bestPair[1].dz - bestPair[0].dz;
  }
  return Math.atan2(axisZ, axisX) + Math.PI / 2;
}

/**
 * Choose the HP bar fill colour given current/max HP. Thresholds:
 *   • ratio <  HP_RED_BELOW       → red
 *   • ratio <  HP_YELLOW_BELOW    → yellow
 *   • ratio ≥  HP_YELLOW_BELOW    → green
 *
 * maxHp ≤ 0 is treated as 1 (avoid div-by-zero); negative hp clamps to 0.
 */
export function hpBarColor(hp, maxHp) {
  const safeMax = Math.max(1, maxHp);
  const ratio = Math.max(0, Math.min(1, hp / safeMax));
  if (ratio < HP_RED_BELOW)    return '#d83333';
  if (ratio < HP_YELLOW_BELOW) return '#d8c333';
  return '#46c84a';
}

/**
 * Lifecycle pose of a floating-text label at progress `t ∈ [0,1]`.
 *
 * Returns:
 *   • y     — vertical offset above the spawn position (0 at t=0, 1.2 at t=1).
 *   • alpha — opacity (1 for first half, lerps 1→0 over second half).
 *
 * Mirrors the keyframes set on the Babylon Animation in `_spawnFloatingText`
 * so tests can verify the curve without a scene.
 */
export function floatingTextTransform(t, riseDistance = 1.2) {
  const clamped = Math.max(0, Math.min(1, t));
  const y = clamped * riseDistance;
  // Alpha holds at 1 for the first half, then lerps 1→0 across the second.
  const alpha = clamped < 0.5 ? 1 : Math.max(0, 1 - (clamped - 0.5) * 2);
  return { y, alpha };
}

// ─── Movement highlight overlay (exported for tests) ────────────────────────

/** Y position of the flat highlight ring above the tile prism top (+0.075).
 *  Sits below the plan-marker disc (PLAN_DISC_Y = 0.16) and the road deck top
 *  (~0.155), so highlights read as an outline ON the tile, not floating above
 *  road decks or stacking on top of plan markers when both are active. */
export const HIGHLIGHT_DISC_Y      = 0.085;
/** Minimum alpha applied when the source rgba is too transparent to read in
 *  the lit 3D scene. Round 4: bumped 0.30 → 0.75 because the highlight changed
 *  from a tile-covering disc (which read fine at low alpha) to a thin outline
 *  ring (which disappears at low alpha). ui.js still uses values as low as
 *  0.14 for ally hexes — we clamp up to keep the outline legible. */
export const HIGHLIGHT_MIN_ALPHA   = 0.75;
/** Fallback rgba when an entry lacks `color` — neutral green (movement). */
export const HIGHLIGHT_DEFAULT_RGBA = 'rgba(60,220,80,0.85)';
/** Outer/inner hex polygon radii (world units) for the outline ring. The gap
 *  between the two defines the ring's visual thickness. Outer is just inside
 *  the tile's footprint (1.0 = HEX_RADIUS_WORLD) so adjacent tiles' rings
 *  don't visually touch; inner is far enough in that the ring reads as a
 *  clear band even when the camera is tilted. */
export const HIGHLIGHT_OUTER_R     = 0.95;
export const HIGHLIGHT_INNER_R     = 0.78;

/**
 * Two concentric pointy-top hex polygons (outer + inner) for a single hex,
 * raised to `y` on the world XZ plane. Used to build the movement-highlight
 * outline ribbon — Babylon ribbons need two paths to fill the annulus between
 * them. Each path has 7 points (last == first) so the ribbon closes around
 * the hex without a seam.
 *
 * Pure function — exported so tests can lock down the geometry without a
 * Babylon scene.
 */
export function hexOutlinePaths(
  col, row,
  outerR = HIGHLIGHT_OUTER_R,
  innerR = HIGHLIGHT_INNER_R,
  y = HIGHLIGHT_DISC_Y,
) {
  const { x, z } = hexToWorld(col, row);
  const outer = [];
  const inner = [];
  for (let i = 0; i <= 6; i++) {
    // Pointy-top hex: vertices at 30°, 90°, 150°, 210°, 270°, 330°.
    const a = Math.PI / 6 + (Math.PI / 3) * i;
    const cosA = Math.cos(a);
    const sinA = Math.sin(a);
    outer.push({ x: x + outerR * cosA, y, z: z + outerR * sinA });
    inner.push({ x: x + innerR * cosA, y, z: z + innerR * sinA });
  }
  return { outer, inner };
}

/**
 * Compute a stable signature for a `highlightHexes` array so the renderer can
 * skip rebuilding the overlay when nothing changed. Order-sensitive: ui.js
 * always rebuilds the list deterministically per selection, so two equal
 * selections produce identical signatures.
 */
export function movementHighlightSignature(list) {
  if (!Array.isArray(list) || list.length === 0) return '';
  let out = '';
  for (const h of list) {
    if (!h || typeof h.col !== 'number' || typeof h.row !== 'number') continue;
    out += `${h.col},${h.row},${h.color || ''}|`;
  }
  return out;
}

/**
 * Parse a CSS rgba string ("rgba(r,g,b,a)" or "rgb(r,g,b)") to [r,g,b,a] in
 * 0..1. Returns a sensible default tuple for unparseable inputs so callers
 * never end up with NaN material colours.
 */
export function parseRgba01(css) {
  if (typeof css !== 'string') return [0.4, 0.85, 0.4, 0.35];
  const m = /rgba?\s*\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)/i.exec(css);
  if (!m) return [0.4, 0.85, 0.4, 0.35];
  const r = clamp01(parseFloat(m[1]) / 255);
  const g = clamp01(parseFloat(m[2]) / 255);
  const b = clamp01(parseFloat(m[3]) / 255);
  const a = m[4] != null ? clamp01(parseFloat(m[4])) : 1;
  return [r, g, b, a];
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return n < 0 ? 0 : n > 1 ? 1 : n;
}

/**
 * World-space position of a movement-highlight disc for a given hex. Used by
 * tests to assert the overlay lands on the expected tile centre.
 */
export function movementHighlightPosition(col, row) {
  const { x, z } = hexToWorld(col, row);
  return { x, y: HIGHLIGHT_DISC_Y, z };
}

/**
 * Projectile colour by type (linear-RGB, 0..1). Used by `addProjectileAnim`
 * for the sphere's diffuse/emissive colour. Unknown types fall back to a
 * neutral pale yellow.
 */
export function projectileColor01(projectileType) {
  switch (projectileType) {
    case 'sparkle':  // witch
      return [0.4, 1.0, 0.5];
    case 'arrow':    // hero
    case 'crossbow':
      return [0.85, 0.6, 0.25];
    default:
      return [1.0, 0.95, 0.7];
  }
}
