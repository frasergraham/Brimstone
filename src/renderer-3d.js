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
import { hexKey, hexDistance } from './hex.js';
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


// ─── Pure helpers (exported for tests; no Babylon dependency) ────────────────

/** World-unit radius for a single hex tile. */
export const HEX_RADIUS_WORLD = 1;

/** Duration (in frames at 60fps) of focus-shift animations.
 *  18 frames ≈ 300ms — long enough to read, short enough not to feel slow. */
export const FOCUS_ANIM_FRAMES = 18;

/** Epsilon below which a focus shift is treated as a no-op (skip animation). */
export const FOCUS_EPSILON = 1e-3;

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
  return TILE_COLOR[tile.type] || TILE_COLOR[TileType.GRASS];
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
    this._syncPlanArrows();
    // Phase 6: atmosphere updates — phase-driven lighting transitions, node
    // glow recolour, and fog veil. Standees are hidden in fogged hexes after
    // the standee sync above so newly-built standees are tagged correctly.
    this._notePhaseChange();
    this._syncNodeGlowMeshes();
    this._applyFogVeil();
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
    }
    if (this.onImagesLoaded) this.onImagesLoaded();
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
  getPortraitDataURL(_assetId, _size)                 { return null; }
  getTileDataURL(_tile, _col, _row, _size)            { return null; }

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
    // axis. Tilt (beta) is hard-locked so the player can't flip the board.
    // We rotate the *camera*, not `mapRoot`, so world-space stays stable for
    // picking + `hexToCanvasPos` projection (see the note on hexToCanvasPos).
    camera.lowerAlphaLimit = null;
    camera.upperAlphaLimit = null;
    camera.lowerBetaLimit  = camera.upperBetaLimit  = this._lockedBeta;

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

    const light = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0.3), scene);
    light.intensity = 0.95;

    this._engine = engine;
    this._scene  = scene;
    this._camera = camera;
    this._light  = light;

    // Phase 6: GlowLayer powers the selection halo and the power-node discs.
    // Built once at init; meshes opt in by raising their emissive colour.
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

    // ── Forests: a small cluster of varied cones around the rim of the hex,
    // leaving the centre clear so an entity standee placed on the tile is not
    // hidden by tree props. Layout is deterministic per (col, row) so the same
    // hex always shows the same cluster across runs. See forestTreesForHex.
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

    // ── Road deck: brown disc raised slightly above the tile surface ──────
    if (tile.type === TileType.ROAD) {
      const deck = BABYLON.MeshBuilder.CreateCylinder(
        `road_${tile.col}_${tile.row}`,
        { tessellation: 6, height: 0.03, diameter: 1.4 },
        scene,
      );
      deck.parent     = parent;
      deck.position.x = x;
      deck.position.z = z;
      deck.position.y = 0.09;
      deck.rotation.y = Math.PI / 6;
      deck.material   = this._materialFor('#6b5a3e');
      deck.isPickable = false;
      trackProp(deck);
    }

    // ── Bridge: wooden planks crossing the river hex ──────────────────────
    if (tile.type === TileType.BRIDGE) {
      const plank = BABYLON.MeshBuilder.CreateBox(
        `bridge_${tile.col}_${tile.row}`,
        { width: 1.7, height: 0.12, depth: 0.7 },
        scene,
      );
      plank.parent     = parent;
      plank.position.x = x;
      plank.position.z = z;
      plank.position.y = 0.18;
      plank.material   = this._materialFor('#8a6030');
      plank.isPickable = false;
      trackProp(plank);
    }

    // ── Building: simple low-poly box atop the tile, building-coloured ────
    if (tile.type === TileType.BUILDING && tile.building) {
      const box = BABYLON.MeshBuilder.CreateBox(
        `bldg_${tile.col}_${tile.row}`,
        { width: 1.0, height: 0.7, depth: 1.0 },
        scene,
      );
      box.parent     = parent;
      box.position.x = x;
      box.position.z = z;
      box.position.y = 0.43; // sit on top of the tile prism
      box.material   = this._materialFor(BUILDING_COLOR[tile.building] || '#8a7a5a');
      box.isPickable = false;
      trackProp(box);

      // Tiny roof block to add silhouette variety.
      const roof = BABYLON.MeshBuilder.CreateBox(
        `roof_${tile.col}_${tile.row}`,
        { width: 1.1, height: 0.15, depth: 1.1 },
        scene,
      );
      roof.parent     = parent;
      roof.position.x = x;
      roof.position.z = z;
      roof.position.y = 0.85;
      roof.material   = this._materialFor('#2c2520');
      roof.isPickable = false;
      trackProp(roof);
    }

    if (props.length > 0) this._tilePropsByKey.set(tkey, props);
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
    const tex = new BABYLON.Texture(
      c.toDataURL(), this._scene, true, false,
      BABYLON.Texture.TRILINEAR_SAMPLINGMODE,
    );
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

  /** Place an existing standee on its entity's tile. */
  _positionStandee(standee, entity) {
    const { x, z } = hexToWorld(entity.col, entity.row);
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
      this._restoreBaseColor(this._entityStandees.get(prevId), prevId);
    }
    if (newId && this._entityStandees.has(newId)) {
      const standee = this._entityStandees.get(newId);
      standee.base.material = this._getSelectedBaseMaterial();
      const BABYLON = this._babylon;
      if (BABYLON && this._camera) {
        const newTarget = new BABYLON.Vector3(
          standee.base.position.x,
          0,
          standee.base.position.z,
        );
        this._focusCamera(newTarget, this._camera.radius);
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

    if (opts.instant || !shouldAnimateFocus(camera.target, camera.radius, newTarget, newRadius)) {
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

  // ─── Plan ghost arrows ───────────────────────────────────────────────────

  /** Rebuild the plan-ghost arrow overlay from `this.planGhostSteps`. We
   *  rebuild from scratch every draw() — the per-call cost is a handful of
   *  meshes (one per MOVE step) and avoids hand-tracking dirty plan state. */
  _syncPlanArrows() {
    // Dispose previous frame's arrow geometry first.
    for (const arrow of this._planArrowMeshes) {
      arrow.line?.dispose();
      arrow.badge?.dispose();
      arrow.badgeMat?.dispose();
      arrow.badgeTex?.dispose();
    }
    this._planArrowMeshes = [];

    const steps = this.planGhostSteps;
    if (!steps || !this._babylon || !this._scene) return;

    const BABYLON = this._babylon;
    for (const step of steps) {
      if (!step.arrow) continue;
      const { fromCol, fromRow, toCol, toRow, entityId } = step.arrow;
      // Owner colour: prefer the entity's per-player colour, fall back to
      // faction theme, then neutral white.
      const ent   = this.state?.entities?.find?.(e => e.id === entityId);
      const ownerColor = this._ownerColorFor(ent ?? {});

      const polyline = planArrowPolyline(fromCol, fromRow, toCol, toRow, 0.85);
      const points = polyline.map(p => new BABYLON.Vector3(p.x, p.y, p.z));

      const dashed = BABYLON.MeshBuilder.CreateDashedLines(
        `planArrow_${entityId}_${step.stepNumber ?? 0}`,
        { points, dashNb: 12, dashSize: 4, gapSize: 3 }, this._scene,
      );
      const [r, g, b] = cssHexToRgb01(ownerColor);
      dashed.color = new BABYLON.Color3(r, g, b);
      dashed.alpha = 0.85;
      dashed.isPickable = false;

      // Numbered badge at the arrow head — small billboarded plane.
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
        const { x: tx, z: tz } = hexToWorld(toCol, toRow);
        badge.position.set(tx, 1.0, tz);
      }

      this._planArrowMeshes.push({ line: dashed, badge, badgeMat, badgeTex });
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

        this._nodeGlowMeshes.push({
          obj, disc,
          col: h.col, row: h.row,
          glowColor: { r: 1, g: 1, b: 1 },
        });
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

    // Hide standees on fogged hexes; reveal them when visible again.
    if (target) {
      for (const [, standee] of this._entityStandees) {
        const k = hexKey(standee.plane.metadata.col, standee.plane.metadata.row);
        const visible = target.has(k);
        if (standee.plane.isVisible !== visible) standee.plane.isVisible = visible;
        if (standee.base.isVisible  !== visible) standee.base.isVisible  = visible;
      }
    } else {
      // No fog → make sure everything is visible (covers fog-toggling mid-game).
      for (const [, standee] of this._entityStandees) {
        if (!standee.plane.isVisible) standee.plane.isVisible = true;
        if (!standee.base.isVisible)  standee.base.isVisible  = true;
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
  else return null; // road, river, bridge, anything unknown → no top texture
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
 *  `{ x, z, scale }` offsets (relative to the hex centre) — N entries where
 *  N ∈ [FOREST_TREES_MIN, FOREST_TREES_MAX]. All trees sit in the ring
 *  [FOREST_INNER_RADIUS, FOREST_OUTER_RADIUS] so the centre is clear for a
 *  standee. Pure function: same (col, row) → same trees, every run. */
export function forestTreesForHex(col, row) {
  const span = FOREST_TREES_MAX - FOREST_TREES_MIN + 1;
  const n    = FOREST_TREES_MIN + Math.floor(_forestHash(col, row, 0) * span);
  // _forestHash returns < 1, so floor(<span) ∈ [0, span-1]; n ∈ [MIN, MAX].
  const trees = [];
  const ringWidth = FOREST_OUTER_RADIUS - FOREST_INNER_RADIUS;
  const scaleSpan = FOREST_SCALE_MAX - FOREST_SCALE_MIN;
  for (let i = 0; i < n; i++) {
    const angle = _forestHash(col, row, i * 3 + 1) * Math.PI * 2;
    const dist  = FOREST_INNER_RADIUS + _forestHash(col, row, i * 3 + 2) * ringWidth;
    const scale = FOREST_SCALE_MIN    + _forestHash(col, row, i * 3 + 3) * scaleSpan;
    trees.push({ x: Math.cos(angle) * dist, z: Math.sin(angle) * dist, scale });
  }
  return trees;
}

// ─── Phase 6 constants (exported for tests) ─────────────────────────────────

/** Hemispheric-light + clear-colour config per game phase.
 *  intensity → light.intensity; color → light.diffuse (warm at dawn/dusk,
 *  white at day, cool blue at night); clear → scene.clearColor (sky/horizon
 *  tint that shows through gaps and behind transparent props). */
export const PHASE_LIGHT_CONFIG = Object.freeze({
  dawn:  { intensity: 0.90, color: { r: 1.00, g: 0.78, b: 0.55 }, clear: { r: 0.45, g: 0.30, b: 0.30 } },
  day:   { intensity: 1.10, color: { r: 1.00, g: 1.00, b: 0.97 }, clear: { r: 0.55, g: 0.72, b: 0.85 } },
  dusk:  { intensity: 0.85, color: { r: 1.00, g: 0.55, b: 0.40 }, clear: { r: 0.40, g: 0.25, b: 0.30 } },
  night: { intensity: 0.55, color: { r: 0.55, g: 0.65, b: 0.95 }, clear: { r: 0.05, g: 0.08, b: 0.18 } },
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

/** GlowLayer intensity (applied to selection halo + node-glow discs). */
export const GLOW_LAYER_INTENSITY = 0.7;

/** Selection halo pulse. Configurable so designers can tune the breathing. */
export const SELECTION_PULSE_PERIOD_MS = 1500;
export const SELECTION_PULSE_MIN       = 0.40;
export const SELECTION_PULSE_MAX       = 0.95;
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

/** Multiplier applied to fogged-tile diffuse colour. ~0.32 keeps the tile
 *  legible (a player can still see "there's grass there") while clearly
 *  reading as out-of-sight. */
export const FOG_TILE_DARKEN = 0.32;

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
