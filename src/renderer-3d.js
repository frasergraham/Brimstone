// ============================================================================
// Renderer3D — Babylon.js (WebGL) renderer, Phase 1 scaffolding
// ============================================================================
//
// This is Phase 1 of the 3D renderer initiative. Goal: stand up the toggle
// plumbing and prove a hex prism can be drawn in a locked isometric scene.
// Map, entities, animations, camera controls are intentionally not implemented
// yet — those land in later phases.
//
// Babylon is loaded lazily on first draw() via a dynamic import() from a
// pinned CDN URL. That keeps src/renderer-3d.js importable in node-test
// (no DOM, no Babylon) so the interface-conformance test can run, and
// keeps page load free of Babylon when the user is on the 2D path.
//
// Babylon CDN pin: @babylonjs/core 7.42.0 (ESM build via jsdelivr +esm).
//
// Renderer interface surface this class must conform to (discovered by
// inspecting src/renderer.js, src/main.js, src/ui.js):
//   methods:
//     constructor(canvas, state)
//     draw()
//     resize()
//     loadImages()                     — resolves immediately (no images yet)
//     frameHexes(positions, opts)      — no-op stub
//     canvasToHex(x, y)                — returns { col: -1, row: -1 }
//     hexToCanvasPos(col, row)         — returns { x: 0, y: 0 }
//     setZoom(z, fx, fy)               — no-op stub
//     resetView()                      — no-op stub
//     addAttackAnim, addLungeAnim, addProjectileAnim, addMoveAnim,
//     addFlash, addDeathAnim, addFadeOutAnim, addNodeRevealAnim,
//     addSpawnAnim, addHpChangeFlash   — no-op stubs
//     clearAllLungeAnims, clearAllProjectileAnims, clearAnimations,
//     clearBattleHighlights, clearFlashes, returnAllLungeAnims,
//     setBattleHighlights              — no-op stubs
//     waitForAnimations()              — resolves immediately
//     getFadeOutOpacity(id)            — returns 1
//     getEntityScreenPositions, getEntityScreenPos,
//     getPortraitDataURL, getTileDataURL — return null/empty for now
//     _clampPan()                      — no-op (touched by ui.js)
//   properties (assigned externally — slots only need to exist):
//     onImagesLoaded, aiDebugOverlay, insetLeft, insetRight,
//     hoveredHex, selectedHex, selectedEntityId, highlightHexes,
//     planGhostSteps, viewLocked, zoomLevel, hexSize, useTileImages,
//     _zoomAnim, _panX, _panY, disambigHiddenIds
//
// Subsequent phases will replace stubs with real 3D rendering of tiles,
// entities, and animations.

const BABYLON_CDN = 'https://cdn.jsdelivr.net/npm/@babylonjs/core@7.42.0/+esm';

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
    this._babylonInit   = null; // pending init promise (de-dupes draw() calls)
  }

  // ─── Required interface (real implementations) ───────────────────────────

  /** Lazy-init Babylon on first draw. Babylon owns its own render loop, so
   *  subsequent draw() calls become a no-op. */
  draw() {
    if (this._engine) return;          // Babylon already running its own loop
    if (this._babylonInit) return;     // init in flight
    this._babylonInit = this._initBabylon().catch(err => {
      console.error('[Renderer3D] Babylon init failed:', err);
    });
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

  /** No images needed in Phase 1 — resolve immediately and fire the
   *  onImagesLoaded callback so callers depending on the signal proceed. */
  async loadImages() {
    if (this.onImagesLoaded) this.onImagesLoaded();
  }

  // ─── Stubs (to be implemented in later phases) ───────────────────────────

  frameHexes(_positions, _opts)                       { /* phase 2+ */ }
  canvasToHex(_x, _y)                                 { return { col: -1, row: -1 }; }
  hexToCanvasPos(_col, _row)                          { return { x: 0, y: 0 }; }
  setZoom(_newZoom, _focalX, _focalY)                 { /* phase 2+ */ }
  resetView()                                         { /* phase 2+ */ }
  _clampPan()                                         { /* phase 2+ */ }
  // Empty set = "nothing fog-visible"; callers fall back to other checks.
  // Stubbed until 3D fog of war lands.
  _buildFogVisibleHexes(_observerOwner)               { return new Set(); }

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

    // ArcRotateCamera positioned for a roughly isometric view.
    // alpha = horizontal angle, beta = vertical angle (smaller = higher up).
    const camera = new BABYLON.ArcRotateCamera(
      'cam',
      -Math.PI / 4,
      Math.PI / 3.5,
      8,
      BABYLON.Vector3.Zero(),
      scene,
    );
    camera.attachControl(this.canvas, true);
    camera.lowerRadiusLimit = 3;
    camera.upperRadiusLimit = 30;

    const light = new BABYLON.HemisphericLight('hemi', new BABYLON.Vector3(0, 1, 0.3), scene);
    light.intensity = 0.95;

    // Single test hex prism — a 6-sided cylinder is a regular hex extrusion.
    const hex = BABYLON.MeshBuilder.CreateCylinder(
      'hex-test',
      { tessellation: 6, height: 0.2, diameter: 2 },
      scene,
    );
    const mat = new BABYLON.StandardMaterial('hex-mat', scene);
    mat.diffuseColor  = new BABYLON.Color3(0.45, 0.40, 0.30);
    mat.specularColor = new BABYLON.Color3(0.05, 0.05, 0.05);
    hex.material = mat;

    this._engine = engine;
    this._scene  = scene;
    this._camera = camera;
    this._light  = light;

    engine.runRenderLoop(() => scene.render());

    // Ensure the engine sees the current canvas dimensions.
    engine.resize();
  }
}
