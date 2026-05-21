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
  // Empty set = "nothing fog-visible"; callers fall back to other checks.
  // Stubbed until 3D fog of war lands.
  _buildFogVisibleHexes(_observerOwner)               { return new Set(); }

  // ─── Stubs (entity / animation work — land in Phase 3+) ──────────────────

  addAttackAnim(_aCol, _aRow, _tCol, _tRow)                                 { /* phase 3+ */ }
  addLungeAnim(_id, _fCol, _fRow, _tCol, _tRow, _type, _owner, _title)       { /* phase 3+ */ }
  addProjectileAnim(_kind, _fCol, _fRow, _tCol, _tRow, _opts)                { /* phase 3+ */ }
  addMoveAnim(_id, _fCol, _fRow, _tCol, _tRow, _type, _owner, _title)        { /* phase 3+ */ }
  addFlash(_col, _row, _text, _color, _dur, _fontScale, _textColor)          { /* phase 3+ */ }
  addDeathAnim(_col, _row, _color)                                           { /* phase 3+ */ }
  addFadeOutAnim(_entityId, _duration)                                       { /* phase 3+ */ }
  addNodeRevealAnim(_hexes, _color, _opts)                                   { /* phase 3+ */ }
  addSpawnAnim(_col, _row, _color)                                           { /* phase 3+ */ }
  addHpChangeFlash(_col, _row, _delta)                                       { /* phase 3+ */ }

  clearAllLungeAnims()                                { /* phase 3+ */ }
  clearAllProjectileAnims()                           { /* phase 3+ */ }
  clearAnimations()                                   { /* phase 3+ */ }
  clearBattleHighlights()                             { /* phase 3+ */ }
  clearFlashes()                                      { /* phase 3+ */ }
  returnAllLungeAnims()                               { /* phase 3+ */ }
  setBattleHighlights(_combatantHexes, _allyHexes)    { /* phase 3+ */ }

  async waitForAnimations()                           { /* phase 3+ */ }

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

    // Build the map from current state and frame it (instant — no animation
    // on the very first frame, otherwise the camera "slides in" from the
    // arbitrary radius=20 starting point).
    this._buildMap();
    this._frameFullMap({ instant: true });
    // Initial standee population so the first frame already has units.
    this._syncEntityStandees();
    this._applySelectionAndFocus();

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
    hex.metadata   = { kind: 'tile', col: tile.col, row: tile.row };
    this._tileMeshes.push(hex);

    // ── Forests: small dark cone on top to read at any zoom ───────────────
    if (tile.type === TileType.FOREST) {
      const cone = BABYLON.MeshBuilder.CreateCylinder(
        `forest_${tile.col}_${tile.row}`,
        { diameterTop: 0, diameterBottom: 0.7, height: 0.9, tessellation: 8 },
        scene,
      );
      cone.parent     = parent;
      cone.position.x = x;
      cone.position.z = z;
      cone.position.y = 0.45;
      cone.material   = this._materialFor('#234c1f'); // tree green
      cone.isPickable = false; // pick the tile underneath, not the prop
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
    }
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
      } else {
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
    }
    // Dispose standees for entities that no longer exist or just died.
    for (const [id, standee] of this._entityStandees) {
      if (!seen.has(id)) {
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
