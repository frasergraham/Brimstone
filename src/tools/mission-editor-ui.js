// ═══════════════════════════════════════════════════════════════════════════
// Mission editor — DOM + 2D-Renderer wiring (P5)
// ─────────────────────────────────────────────────────────────────────────────
// The thin half of the editor: builds the tool palette into #e-palette, spins
// up the SAME 2D Renderer the game uses on #e-render-canvas, and connects the
// click→hex edit loop to the DOM-free controller in `mission-editor.js`.
//
// Booted lazily by the admin-tools tab shell on first activation of the Mission
// Editor tab (never at module top level — the Renderer touches the DOM only
// inside `initEditor`). Returns a { pause, resume } handle matching the Assets /
// Lighting tabs; the 2D Renderer has no render loop, so pause is a no-op and
// resume just re-fits + redraws.
//
// UX restructure:
//   • Canvas pan + zoom — wired to the SAME Renderer the game uses via
//     attachEditorCanvasControls (src/tools/editor-canvas-input.js). Wheel /
//     pinch zoom, drag-to-pan, click-to-paint with drag-vs-paint discrimination.
//   • Tabbed sidebar — the palette + authoring forms are grouped into four
//     sidebar tabs (Map / Mission / Events / Units) reusing the lazy
//     tab-controller pattern; only one group shows at a time.
//   • Load / Save relocated — the editor exposes loadMissionFile() / saveMission()
//     so the top File menu in admin-tools.html can drive them. The flow is
//     unchanged (validate-before-populate on load; validate + block-download on
//     save) — only the controls moved out of the side panel.
//
// SEAMS:
//   • `handle.editor` exposes the controller (getMapDef/setMapDef/…).
//   • 3D preview: a "Preview in 3D" button (Map tab) shows the #e-preview-3d
//     overlay and hands `buildState()` to a lazily-constructed Renderer3D
//     (beginLoad → whenReady → draw). The engine is built on first press and
//     disposed on close / tab-switch — see the `preview` controller below.
// ═══════════════════════════════════════════════════════════════════════════

import { Renderer } from '../renderer.js';
import { Renderer3D } from '../renderer-3d.js';
import { GameState } from '../game.js';
import { buildMissionMap } from '../campaign/mission-map.js';
import {
  TileType, BuildingType, ResourceType, PathType,
  TILE_COLOR, BUILDING_COLOR, BUILDING_ICON, hasBuilding, isBridge,
} from '../tiles.js';
import { hexKey } from '../hex.js';
import {
  createZombie, createMinion, createWoodGolem, createIronGolem,
} from '../entities.js';
import {
  createMissionEditor, createPreviewController, EditorTool, ENEMY_UNIT_TYPES,
  addStoryTrigger, removeStoryTrigger, moveStoryTrigger,
  addWave, removeWave, populateFromMission, CreationMode, MAP_EDGES,
  valuePanelKind, ToolValueKind, createLayerVisibility, showStructures,
  roadNodeMarkersVisible, stripTileOverlays,
} from './mission-editor.js';
import { MAP_SIZES } from '../map.js';
import { createTabController } from './tab-controller.js';
import { attachEditorCanvasControls } from './editor-canvas-input.js';
import { loadMissionJSON, KNOWN_OBJECTIVE_TYPES } from '../campaign/json-mission.js';
import { missionJSONUrl } from '../campaign/mission-catalog.js';
import { CONDITIONS } from '../campaign/condition-registry.js';

// Absolute asset root for both the 2D editor renderer AND the 3D preview.
// MUST be absolute ('/assets', not 'assets'): admin-tools.html is served at the
// sub-path URL `/admin/tools`, so a relative base resolves against `/admin/`
// (→ `/admin/assets/...` → 404 for the tilemap atlas and every GLB). The 3D
// preview's Renderer3D.beginLoad() falls back to the relative 'assets' default
// unless loadImages() pins this first — that fallback is what blanked the
// preview's textures + models. See `resolveAssetBase` below (exported for tests).
export const ASSET_BASE = '/assets';

// Resolve the asset base a Renderer should load from. Pure; exported for tests.
// Guards the one rule that matters: never hand a renderer a relative base under
// the /admin/tools sub-path. Falls back to ASSET_BASE for empty/relative input.
export function resolveAssetBase(base) {
  return (typeof base === 'string' && base.startsWith('/')) ? base : ASSET_BASE;
}

// Enum VALUE → KEY pairs for select option lists (KEY is what the model stores).
const _entries = (enumObj) => Object.keys(enumObj).map(k => ({ key: k, value: enumObj[k] }));

// The base layer is exactly {GRASS, FOREST, DIRT} — a strict subset of TileType
// (road/river/bridge/building are NOT base materials; they live in path/structure).
const BASE_ENTRIES = [
  { key: 'GRASS', value: TileType.GRASS },
  { key: 'FOREST', value: TileType.FOREST },
  { key: 'DIRT', value: TileType.DIRT },
];

const ENEMY_FACTORIES = {
  zombie: createZombie,
  minion: createMinion,
  wood_golem: createWoodGolem,
  iron_golem: createIronGolem,
};

// The icon tool palette (item 7) — emoji glyph + tooltip label per tool, in a
// stable display order. Glyphs are plain emoji so they need no asset loading.
const TOOL_PALETTE = [
  { id: EditorTool.PAINT_BASE,      icon: '🌿', label: 'Paint Base' },
  { id: EditorTool.PAINT_STRUCTURE, icon: '🏠', label: 'Paint Structure' },
  { id: EditorTool.PAINT_PATH,      icon: '🛤', label: 'Paint Path' },
  { id: EditorTool.SET_RESOURCE,    icon: '💎', label: 'Set Resource' },
  { id: EditorTool.HIDDEN_SURVIVOR, icon: '🙋', label: 'Hidden Survivor' },
  { id: EditorTool.ENEMY_UNIT,      icon: '🧟', label: 'Enemy Unit' },
  { id: EditorTool.HERO_START,      icon: '🛡', label: 'Hero Start' },
  { id: EditorTool.WITCH_START,     icon: '🧙', label: 'Witch Start' },
  { id: EditorTool.ROAD_NODE,       icon: '📍', label: 'Road Node' },
  { id: EditorTool.POWER_NODE,      icon: '🔮', label: 'Power Node' },
];

// Short hints shown in the VALUE panel for the value-less tools.
const TOOL_HINTS = {
  [EditorTool.HIDDEN_SURVIVOR]: 'Click a tile to toggle a hidden survivor.',
  [EditorTool.HERO_START]: 'Click a tile to move the hero start.',
  [EditorTool.WITCH_START]: 'Click a tile to move the witch start.',
  [EditorTool.ROAD_NODE]: 'Click tiles to toggle road-network waypoints, then Regenerate Roads.',
  [EditorTool.POWER_NODE]: 'Click a tile to toggle a Power Node.',
};

// Build a live GameState the 2D Renderer can draw from the current model. The
// hero/witch leaders the GameState constructor places double as start markers;
// enemy units are injected as entities for visual feedback. Editor view always
// runs fog-free.
//
// `layers` (item 6) applies EDITOR-SIDE visibility filtering — renderer.js is
// untouched. When the structure/path layers are hidden we strip them off a
// throwaway display build (stripTileOverlays); Power-Node and Player-Start
// visibility is applied by omitting them from the rendered state. Passing no
// `layers` (3D preview / external buildState) renders the full, unfiltered map.
function buildState(editor, layers = null) {
  const mapDef = editor.getMapDef();
  const built = buildMissionMap(mapDef);
  if (layers && !showStructures(layers)) stripTileOverlays(built.tiles);
  const showNodes = !layers || layers.powerNodes;
  const state = new GameState(false, false, built.mapSize, null, {
    ...built,
    heroStart: built.heroStart ?? { col: 0, row: 0 },
    witchStart: built.witchStart ?? { col: 0, row: 0 },
    witchObjectives: showNodes ? (built.witchObjectives ?? []) : [],
  });
  state.fogOfWar = 'none';

  // Inject enemy units for preview (best-effort — skip unknown types).
  for (const u of editor.getEnemyUnits()) {
    const factory = ENEMY_FACTORIES[u.type];
    if (!factory) continue;
    try {
      state.entities.push(factory(u.col, u.row, 'witch', state));
    } catch { /* malformed placement — ignore in preview */ }
  }

  // Player-Start visibility: drop the hero / witch leader markers (enemy units,
  // which are distinct entities, stay).
  if (layers && !layers.playerStarts) {
    state.entities = state.entities.filter(e => e !== state.hero && e !== state.witch);
  }
  return state;
}

/**
 * Boot the Mission Editor tab. Expects the static shell (#e-render-canvas,
 * #e-palette) already present in the page.
 *
 * @param {Document} [doc] - document root (defaults to global document).
 * @returns {{ pause: () => void, resume: () => void, editor: object,
 *             buildState: () => object,
 *             loadMissionFile: (file:File) => Promise<{ok:boolean,message:string}>,
 *             saveMission: () => {ok:boolean,message:string} }}
 */
export function initEditor(doc = document) {
  const canvas = doc.getElementById('e-render-canvas');
  const palette = doc.getElementById('e-palette');

  // Editor canvas layer visibility (item 6). Applied EDITOR-SIDE in buildState
  // (filtered display build) + the post-draw overlay pass — renderer.js stays
  // a pure game renderer.
  const layers = createLayerVisibility();

  // Notifies the top-bar Undo/Redo buttons after every history change. Wired by
  // the host page via the returned handle's onHistoryChange().
  let historyListener = null;
  const notifyHistory = () => {
    historyListener?.({ canUndo: editor.canUndo(), canRedo: editor.canRedo() });
  };

  // The controller drives the model; `render()` rebuilds + redraws. (Dirty
  // tracking now lives on the controller — a fresh editor starts clean.)
  const editor = createMissionEditor({ render: rerender });

  const renderer = new Renderer(canvas, buildState(editor, layers));
  renderer.loadImages(ASSET_BASE);

  // Draw the map then the editor overlays (road-network node markers). Used in
  // place of bare renderer.draw() everywhere so overlays survive pan/zoom.
  function draw() {
    renderer.draw();
    drawEditorOverlays();
  }

  function rerender() {
    // Cheap full rebuild — editor maps are small. Reassigning state keeps the
    // Renderer instance, so zoom/pan persist across edits.
    renderer.state = buildState(editor, layers);
    renderer.resize();
    draw();
    notifyHistory();
  }

  // Recenter + reset zoom, then redraw. Used by the Reset View button and
  // whenever the map dimensions change (mode / map-size switch) so the new map
  // is reframed instead of left half-off-screen under the old pan.
  function resetViewAndDraw() {
    renderer.resize();          // recompute hexSize for the (possibly new) map
    renderer.resetView();       // zoom → 1, pan centered on the visible area
    renderer._clampPan();
    draw();
  }

  // ── Editor overlays (item 6) ──────────────────────────────────────────────
  // Road-network node markers are an EDITOR concept the game renderer never
  // draws, so they're painted directly on the 2D context after renderer.draw().
  // Structural nodes (buildings + bridges) come from the built tiles; authored
  // waypoints from the road-node set. Auto-shown while the Road Node tool is
  // active (so authoring is always visible), else gated on the Layers toggle.
  function drawEditorOverlays() {
    if (!roadNodeMarkersVisible(layers, editor.activeTool)) return;
    const ctx = renderer.ctx;
    if (!ctx) return;
    const mapDef = editor.getMapDef();
    const nodes = new Map(); // hexKey → { col, row, structural }
    // Structural nodes: rebuild a throwaway map so base-only filtering can't hide
    // them (we want graph nodes visible regardless of the terrain filter).
    try {
      const built = buildMissionMap(mapDef);
      for (const t of built.tiles.values()) {
        if (hasBuilding(t) || isBridge(t)) {
          nodes.set(hexKey(t.col, t.row), { col: t.col, row: t.row, structural: true });
        }
      }
    } catch { /* malformed map — skip structural markers */ }
    // Authored road-node waypoints.
    for (const key of authoredRoadNodeKeys(mapDef)) {
      const [c, r] = String(key).split(',').map(Number);
      nodes.set(key, { col: c, row: r, structural: false });
    }
    const radius = Math.max(3, renderer.hexSize * renderer.zoomLevel * 0.22);
    ctx.save();
    ctx.lineWidth = 1.5;
    for (const n of nodes.values()) {
      const { x, y } = renderer.hexToCanvasPos(n.col, n.row);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      ctx.fillStyle = n.structural ? 'rgba(120,180,255,0.55)' : 'rgba(255,210,120,0.9)';
      ctx.strokeStyle = '#0a0805';
      ctx.fill();
      ctx.stroke();
    }
    ctx.restore();
  }

  // ── Pan / zoom / paint (reuses the in-game Renderer transform) ────────────
  attachEditorCanvasControls(canvas, renderer, {
    onPaint: (hex) => editor.applyAt(hex),
    onRedraw: () => draw(),
  });

  // ── 3D preview (lazy Renderer3D over the #e-preview-3d overlay) ───────────
  // Dispose helper: tear down a preview Renderer3D's scene + engine. Mirrors the
  // Lighting tab's regen-map teardown so we never leak a running Babylon engine.
  const dispose3dPreview = (r) => {
    try { r?._scene?.dispose(); } catch { /* already gone */ }
    try { r?._engine?.dispose(); } catch { /* already gone */ }
  };
  const previewCanvas = doc.getElementById('e-preview-canvas');
  const previewOverlay = doc.getElementById('e-preview-3d');
  // The controller owns the single-live-renderer + dispose-before-rebuild rule;
  // `construct` follows Renderer3D's beginLoad → whenReady → draw contract.
  const preview = createPreviewController({
    construct: () => {
      const r = new Renderer3D(previewCanvas, buildState(editor));
      // Pass the ABSOLUTE asset base to beginLoad(): its relative 'assets'
      // default 404s under the /admin/tools sub-path, leaving the preview scene
      // textureless + GLB-less (houses/paladin/trees fall back to procedural).
      // beginLoad() loads the atlas + GLBs from this base, so no separate
      // loadImages() call is needed.
      r.beginLoad(resolveAssetBase(ASSET_BASE));
      // Reveal the fully-loaded scene once assets settle (draw() is a no-op
      // before whenReady resolves, harmless if the overlay was closed meanwhile).
      r.whenReady().then(() => { try { r.draw(); } catch { /* disposed */ } });
      return r;
    },
    dispose: dispose3dPreview,
  });

  function openPreview() {
    if (previewOverlay) previewOverlay.hidden = false;
    // Rebuild from the CURRENT editor state every press (author edits in 2D,
    // hits Preview to see 3D). rebuild() disposes any prior engine first.
    preview.rebuild();
  }
  function closePreview() {
    preview.teardown();
    if (previewOverlay) previewOverlay.hidden = true;
  }
  doc.getElementById('e-preview-close')?.addEventListener('click', closePreview);
  // Keep the preview engine sized to its pane while it's live.
  const onResize = () => { try { preview.current()?._engine?.resize(); } catch { /* ignore */ } };
  (doc.defaultView ?? globalThis).addEventListener?.('resize', onResize);

  // Build the tabbed sidebar shell (Map / Mission / Events / Units). Both the
  // Map palette and the three authoring panes are (re)built on demand so a
  // load / New / resize can refresh whatever changed (the Map tab depends on
  // the LOCKED mode + current dims; the forms depend on meta).
  const sidebar = buildSidebar(doc, palette);
  const formStatus = (msg, ok) => sidebar.setStatus(msg, ok);

  function rebuildForms() {
    buildForms(doc, sidebar.panes, editor, rerender, rebuildForms, formStatus);
  }
  // The Map palette reflects the locked mode + live dims; rebuild it whenever
  // those can change (creation, resize, load) and reframe the canvas.
  function rebuildMapPalette() {
    buildMapPalette(doc, sidebar.panes.map, editor, rerender, openPreview, resetViewAndDraw, {
      onSizeChange: () => { rebuildMapPalette(); resetViewAndDraw(); },
      setStatus: formStatus,
      // Tool change can flip the road-node-marker auto-show, so redraw overlays.
      onToolChange: () => draw(),
    });
  }
  // The Layers (visibility) pane toggles the editor-side display filters.
  function rebuildLayers() {
    buildLayersPanel(doc, sidebar.panes.layers, layers, () => rerender());
  }
  rebuildMapPalette();
  rebuildForms();
  rebuildLayers();

  // ── Load / Save — relocated to the top File menu; flow is unchanged. ──────
  // Validate-before-populate on load; validate + block-download on save.

  // Shared convergence point for BOTH load sources (external file picker and
  // bundled "Load existing mission"). Takes RAW parsed JSON — validate first,
  // then populate. Throws on validation failure so the caller can leave the
  // current model untouched. Note: we route the raw parsed object (not the
  // transformed def from fetchMissionJSON, which deletes schema/conductor and
  // swaps map → mapBuilderFn / condition strings → fns) so a load→edit→download
  // round-trip stays byte-faithful.
  function applyParsedMission(parsed) {
    loadMissionJSON(parsed); // VALIDATE before touching the model
    editor.applyMission(populateFromMission(parsed));
    rebuildMapPalette(); // mode + dims may have changed
    rebuildForms();
    resetViewAndDraw();
    editor.markClean(); // a freshly-loaded mission starts clean
    notifyHistory();
  }

  function loadMissionFile(file) {
    return new Promise((resolve) => {
      if (!file) { resolve({ ok: false, message: 'No file selected.' }); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          applyParsedMission(parsed);
          resolve({ ok: true, message: `Loaded "${parsed.id}".` });
        } catch (err) {
          // Validation / parse failure: do NOT clobber the current model.
          resolve({ ok: false, message: `Load failed: ${err.message}` });
        }
      };
      reader.onerror = () => resolve({ ok: false, message: 'Could not read file.' });
      reader.readAsText(file);
    });
  }

  // Load one of the bundled in-repo missions by id. Same validate→populate path
  // as the file picker; only the JSON source differs (same-origin fetch vs
  // FileReader). The URL is resolved by mission-catalog.js relative to its own
  // module location, so it matches campaign-registry.js's loader exactly.
  async function loadMissionById(id) {
    try {
      const res = await fetch(missionJSONUrl(id));
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const parsed = await res.json();
      applyParsedMission(parsed);
      return { ok: true, message: `Loaded "${parsed.id}".` };
    } catch (err) {
      // Fetch / parse / validation failure: do NOT clobber the current model.
      return { ok: false, message: `Load failed: ${err.message}` };
    }
  }

  function saveMission() {
    const json = editor.assemble();
    try {
      loadMissionJSON(json); // block the download on any validation error
    } catch (err) {
      return { ok: false, message: `Cannot save: ${err.message}` };
    }
    downloadJSON(doc, json, `${json.id || 'mission'}.json`);
    editor.markClean();
    return { ok: true, message: `Validated — downloaded ${json.id}.json` };
  }

  // ── New… — the creation flow (item 4). Pick a LOCKED mode + size, confirm if
  // there's unsaved work, then install the freshly-created map. ──────────────
  function newMission() {
    if (editor.isDirty() && !(doc.defaultView ?? globalThis).confirm?.('Discard the current mission and start a new one?')) {
      return { ok: false, message: 'New mission cancelled.' };
    }
    openCreationDialog(doc, (opts) => {
      editor.createNew(opts);
      rebuildMapPalette();
      rebuildForms();
      resetViewAndDraw();
      editor.markClean(); // a fresh mission starts clean
      notifyHistory();
    });
    return { ok: true, message: '' };
  }

  // ── Undo / Redo (item 5) — driven from the host page's top bar. editor.undo /
  // .redo already trigger rerender() (via the controller's emit→render); we just
  // rebuild the palette + forms in case the model's mode / dims / meta changed,
  // and refresh the button enabled-state.
  function undo() {
    if (editor.undo()) { rebuildMapPalette(); rebuildForms(); rebuildLayers(); }
    notifyHistory();
  }
  function redo() {
    if (editor.redo()) { rebuildMapPalette(); rebuildForms(); rebuildLayers(); }
    notifyHistory();
  }

  // First fit once layout settles, then mark clean so a freshly-opened editor
  // doesn't prompt "discard unsaved work?" on the first File ▸ New.
  renderer.resize();
  draw();
  editor.markClean();

  return {
    editor,
    buildState: () => buildState(editor),
    newMission,
    loadMissionFile,
    loadMissionById,
    saveMission,
    // Undo / redo wiring for the top-bar buttons + keyboard shortcuts.
    undo,
    redo,
    canUndo: () => editor.canUndo(),
    canRedo: () => editor.canRedo(),
    isDirty: () => editor.isDirty(),
    /** Register a listener fired on every history change with { canUndo, canRedo }. */
    onHistoryChange(fn) { historyListener = fn; notifyHistory(); },
    // 2D Renderer has no render loop. But the 3D preview owns a live Babylon
    // engine; tear it down (and hide the overlay) when the tab is switched away
    // so a hidden tab never leaves an engine spinning.
    pause() { closePreview(); },
    resume() { renderer.resize(); draw(); },
  };
}

// Authored road-node waypoint keys for the current map (mode-aware). Structural
// building/bridge nodes are NOT included here — they're derived from the built
// tiles by the overlay pass.
function authoredRoadNodeKeys(mapDef) {
  if (mapDef.mode === 'procedural') return mapDef.overlay?.roadNodes?.add ?? [];
  return mapDef.roadNodes ?? [];
}

// ── Tabbed sidebar ────────────────────────────────────────────────────────────
// Splits the old single-scroll palette into four tabs so only one group of
// controls shows at a time. Returns { panes, setStatus } where `panes` holds the
// four pane containers (map / mission / events / units) — `map` is (re)built by
// rebuildMapPalette and the other three by buildForms — and `setStatus` writes
// to the shared form-validation status line.
function buildSidebar(doc, root) {
  root.innerHTML = '';

  const SIDEBAR_TABS = [
    { id: 'map', label: 'Map' },
    { id: 'layers', label: 'Layers' },
    { id: 'mission', label: 'Mission' },
    { id: 'events', label: 'Events' },
    { id: 'units', label: 'Units' },
  ];

  // Tab buttons.
  const tabbar = doc.createElement('div');
  tabbar.className = 'e-tabbar';
  const tabBtns = {};
  for (const t of SIDEBAR_TABS) {
    const b = doc.createElement('button');
    b.className = 'e-stab';
    b.textContent = t.label;
    b.dataset.stab = t.id;
    b.addEventListener('click', () => stabs.activate(t.id));
    tabBtns[t.id] = b;
    tabbar.append(b);
  }
  root.append(tabbar);

  // Tab panes.
  const paneEls = {};
  for (const t of SIDEBAR_TABS) {
    const p = doc.createElement('div');
    p.className = 'e-spane';
    p.dataset.spane = t.id;
    paneEls[t.id] = p;
    root.append(p);
  }

  // Shared form-validation status line (JSON parse errors etc.).
  const status = doc.createElement('div');
  status.className = 'e-status';
  root.append(status);
  const setStatus = (msg, ok) => {
    status.textContent = msg || '';
    status.classList.toggle('err', !ok);
    status.classList.toggle('ok', !!ok && !!msg);
  };

  // Lazy tab-switch via the shared controller — DOM-free + already unit-tested.
  const stabs = createTabController(SIDEBAR_TABS.map(t => t.id), {
    onActivate: (id) => {
      for (const t of SIDEBAR_TABS) {
        paneEls[t.id].classList.toggle('active', t.id === id);
        tabBtns[t.id].classList.toggle('active', t.id === id);
      }
    },
  });

  stabs.activate('map');

  return {
    // `map` (paint/size palette) + `layers` (visibility) + the three authoring panes.
    panes: {
      map: paneEls.map,
      layers: paneEls.layers,
      mission: paneEls.mission,
      events: paneEls.events,
      units: paneEls.units,
    },
    setStatus,
  };
}

// ── Map-tab palette DOM ───────────────────────────────────────────────────────

function buildMapPalette(doc, root, editor, rerender, onPreview3D, onResetView, hooks = {}) {
  root.innerHTML = '';
  const onSizeChange = hooks.onSizeChange ?? (() => {});
  const setStatus = hooks.setStatus ?? (() => {});

  const mapDef = editor.getMapDef();
  const isProcedural = mapDef.mode === 'procedural';
  const dims = editor.getDims();

  // ── Map properties: LOCKED mode (read-only) + live size ──────────────────
  // The map mode is chosen once at creation (File ▸ New…) and cannot be toggled
  // here — only displayed. Size is editable via the per-edge buttons (handmade)
  // or the size selector (overlay).
  const mapSection = section(doc, 'Map');
  mapSection.append(readonlyRow(doc, 'Mode', editor.getMapModeLabel()));
  const sizeRow = readonlyRow(doc, 'Size', `${dims.cols} × ${dims.rows}`);
  mapSection.append(sizeRow);

  if (isProcedural) {
    // Overlay: seed + named size selector (generateMap is discrete, so resizing
    // an overlay map means switching its generation size — out-of-bounds edits
    // are then dropped). Changing size reframes + rebuilds the palette.
    const seedRow = doc.createElement('div');
    seedRow.className = 'e-row';
    const seedInput = doc.createElement('input');
    seedInput.type = 'number';
    seedInput.value = String(mapDef.seed ?? 12345);
    seedInput.addEventListener('change', () => editor.setSeed(parseInt(seedInput.value, 10) || 0));
    seedRow.append(labelFor(doc, 'Seed'), seedInput);
    mapSection.append(seedRow);

    mapSection.append(labeledSelect(doc, 'Gen Size',
      Object.keys(MAP_SIZES).map(k => ({ key: k, value: k })), mapDef.mapSize ?? 'standard',
      (v) => {
        const res = editor.setOverlaySize(v);
        if (res.warning) setStatus(res.warning, res.ok);
        onSizeChange();
      }));
    mapSection.append(actionBtn(doc, 'Rebuild Map', () => editor.regenerateRoads()));
  } else {
    // Handmade (blank/baked): per-edge add/remove. Top/left shift remaps every
    // coordinate; bottom/right extend or truncate. A blocked remove (start /
    // node on the edge) surfaces a warning instead of orphaning it.
    mapSection.append(buildEdgeControls(doc, editor, setStatus, onSizeChange));
    mapSection.append(actionBtn(doc, 'Regenerate Roads', () => editor.regenerateRoads()));
  }
  root.append(mapSection);

  const onToolChange = hooks.onToolChange ?? (() => {});

  // ── Tools (item 7) — a compact icon palette. Each button carries an emoji
  // glyph + a tooltip; the active tool is highlighted. The Road Node entry pairs
  // with a "Regenerate Roads" action surfaced in the Map section above. ─────────
  const toolSection = section(doc, 'Tools');
  const toolGrid = doc.createElement('div');
  toolGrid.className = 'e-toolgrid';
  const toolBtns = {};
  for (const t of TOOL_PALETTE) {
    const btn = doc.createElement('button');
    btn.className = 'e-toolbtn';
    btn.textContent = t.icon;
    btn.title = t.label;
    btn.setAttribute('aria-label', t.label);
    btn.dataset.tool = t.id;
    btn.addEventListener('click', () => {
      editor.setActiveTool(t.id);
      for (const b of Object.values(toolBtns)) b.classList.remove('active');
      btn.classList.add('active');
      renderValuePanel();   // VALUE section adapts to the new tool (item 7)
      onToolChange();       // road-node markers may auto-show/hide
    });
    toolBtns[t.id] = btn;
    toolGrid.append(btn);
  }
  toolSection.append(toolGrid);
  // Highlight the controller's current tool (persists across palette rebuilds).
  (toolBtns[editor.activeTool] ?? toolBtns[EditorTool.PAINT_BASE]).classList.add('active');
  root.append(toolSection);

  // ── VALUE section (item 7) — context-sensitive to the active tool. The host
  // div is rebuilt by renderValuePanel() whenever the tool changes. ────────────
  const valSection = section(doc, 'Value');
  const valHost = doc.createElement('div');
  valSection.append(valHost);
  root.append(valSection);

  function renderValuePanel() {
    valHost.innerHTML = '';
    buildValuePanel(doc, valHost, valuePanelKind(editor.activeTool), editor, renderValuePanel);
  }
  renderValuePanel();

  // Edit + view actions. (Undo / Redo moved to the top bar — item 5.)
  if (onResetView) {
    const editSection = section(doc, 'View');
    editSection.append(actionBtn(doc, 'Reset View', () => onResetView()));
    root.append(editSection);
  }

  // Preview — rebuilds the current mission map in 3D via Renderer3D.
  if (onPreview3D) {
    const previewSection = section(doc, 'Preview');
    previewSection.append(actionBtn(doc, 'Preview in 3D', () => onPreview3D()));
    root.append(previewSection);
  }
}

// ── Context-sensitive VALUE panel (item 7) ──────────────────────────────────
// Renders the value selector for the active tool's kind into `host`. Picking a
// value updates the controller's paint value and re-renders the panel so the
// active swatch highlight tracks the selection. Value-less tools show a hint.
function buildValuePanel(doc, host, kind, editor, rerenderPanel) {
  switch (kind) {
    case ToolValueKind.BASE:
      host.append(swatchGrid(doc, BASE_ENTRIES.map(e => ({
        key: e.key, label: e.key, color: TILE_COLOR[e.value] || '#444',
      })), editor.getPaintValue('base'), (key) => {
        editor.setPaintValue('base', key); rerenderPanel();
      }));
      break;
    case ToolValueKind.STRUCTURE: {
      const items = [{ key: null, label: 'None', color: 'transparent', glyph: '∅' }];
      for (const e of _entries(BuildingType)) {
        items.push({ key: e.key, label: e.key, color: BUILDING_COLOR[e.value] || '#4a3c2c', glyph: BUILDING_ICON[e.value] || '' });
      }
      host.append(swatchGrid(doc, items, editor.getPaintValue('structure'), (key) => {
        editor.setPaintValue('structure', key); rerenderPanel();
      }));
      break;
    }
    case ToolValueKind.PATH: {
      const items = [
        { key: null, label: 'None' },
        ..._entries(PathType).map(e => ({ key: e.key, label: titleCase(e.key) })),
      ];
      host.append(chipRow(doc, items, editor.getPaintValue('path'), (key) => {
        editor.setPaintValue('path', key); rerenderPanel();
      }));
      break;
    }
    case ToolValueKind.RESOURCE:
      host.append(labeledSelect(doc, 'Resource', _entries(ResourceType),
        editor.getPaintValue('resource'), (v) => editor.setPaintValue('resource', v)));
      break;
    case ToolValueKind.ENEMY:
      host.append(labeledSelect(doc, 'Enemy', ENEMY_UNIT_TYPES.map(t => ({ key: t, value: t })),
        editor.getPaintValue('enemyType'), (v) => editor.setPaintValue('enemyType', v)));
      break;
    default:
      host.append(hint(doc, TOOL_HINTS[editor.activeTool] || 'This tool has no value.'));
  }
}

// A grid of colour swatches. `items` are { key, label, color, glyph? }; the one
// whose key === selected gets the .active highlight. `selected===null` matches
// the "None" item (key null).
function swatchGrid(doc, items, selected, onPick) {
  const grid = doc.createElement('div');
  grid.className = 'e-swatches';
  for (const it of items) {
    const btn = doc.createElement('button');
    btn.className = 'e-swatch';
    btn.title = it.label;
    btn.dataset.value = it.key == null ? '' : it.key;
    if (it.key === selected) btn.classList.add('active');
    const chip = doc.createElement('span');
    chip.className = 'e-swatch-chip';
    chip.style.background = it.color ?? 'transparent';
    if (it.glyph) chip.textContent = it.glyph;
    const lbl = doc.createElement('span');
    lbl.className = 'e-swatch-label';
    lbl.textContent = it.label;
    btn.append(chip, lbl);
    btn.addEventListener('click', () => onPick(it.key));
    grid.append(btn);
  }
  return grid;
}

// A row of text chips (None / Road / River / Bridge). Active = key === selected.
function chipRow(doc, items, selected, onPick) {
  const row = doc.createElement('div');
  row.className = 'e-chips';
  for (const it of items) {
    const btn = doc.createElement('button');
    btn.className = 'e-chip';
    btn.textContent = it.label;
    btn.dataset.value = it.key == null ? '' : it.key;
    if (it.key === selected) btn.classList.add('active');
    btn.addEventListener('click', () => onPick(it.key));
    row.append(btn);
  }
  return row;
}

function titleCase(s) {
  return String(s).charAt(0) + String(s).slice(1).toLowerCase();
}

// ── Layers (visibility) panel (item 6) ──────────────────────────────────────
// Checkbox toggles over the editor-side display filters. Mutates the shared
// `layers` object in place; `onChange` triggers a rerender (filter + overlay).
function buildLayersPanel(doc, root, layers, onChange) {
  root.innerHTML = '';
  const sec = section(doc, 'Visibility');
  const toggles = [
    { key: 'baseOnly', label: 'Base only' },
    { key: 'roadsBuildings', label: 'Roads + Buildings' },
    { key: 'powerNodes', label: 'Power Nodes' },
    { key: 'playerStarts', label: 'Player Start points' },
    { key: 'roadNodeMarkers', label: 'Road-network nodes' },
  ];
  for (const t of toggles) {
    sec.append(boolRow(doc, t.label, layers[t.key], (v) => { layers[t.key] = v; onChange(); }));
  }
  sec.append(hint(doc, 'Road-network nodes also auto-show while the Road Node tool is active.'));
  root.append(sec);
}

// ══════════════════════════════════════════════════════════════════════════
// Authoring forms  (P6)
// ─────────────────────────────────────────────────────────────────────────────
// Forms over the existing mission schema, distributed across the Mission /
// Events / Units sidebar panes. Inputs mutate the LIVE meta object
// (editor.getMeta() returns a reference) for cheap text edits; list add/remove
// and load go through the controller and trigger a full form rebuild. Map-
// affecting edits (enemyUnits, survivor positions) also redraw the canvas.
// Load/Save live in the top File menu (see initEditor) — not here.
// ══════════════════════════════════════════════════════════════════════════

function buildForms(doc, panes, editor, rerenderCanvas, rebuild, setStatus) {
  panes.mission.innerHTML = '';
  panes.events.innerHTML = '';
  panes.units.innerHTML = '';
  const meta = editor.getMeta();

  // ── Scalar properties ───────────────────────────────────────────────────
  const props = section(doc, 'Properties');
  props.append(
    textRow(doc, 'ID', meta.id, v => { meta.id = v; }),
    textRow(doc, 'Title', meta.title, v => { meta.title = v; }),
    numRow(doc, 'Chapter', meta.chapter, v => { meta.chapter = v; }),
    textRow(doc, 'Campaign', meta.campaignId ?? '', v => { meta.campaignId = v || null; }),
    textRow(doc, 'Requires', csv(meta.requires), v => { meta.requires = parseCsvOrNull(v); }),
    selRow(doc, 'Map Size', ['skirmish', 'standard', 'regional', 'campaign'], meta.mapSize,
      v => { meta.mapSize = v; }),
    boolRow(doc, 'Has Witch', meta.hasWitch, v => { meta.hasWitch = v; }),
    boolRow(doc, 'No Scoring', meta.disableScoring, v => { meta.disableScoring = v; }),
    textRow(doc, 'AI Persona', meta.aiPersonality ?? '', v => { meta.aiPersonality = v || null; }),
    numRow(doc, 'AI Budget+', meta.aiBudgetBonus, v => { meta.aiBudgetBonus = v; }),
    numRow(doc, 'Roster Max', meta.maxSurvivorsFromRoster, v => { meta.maxSurvivorsFromRoster = v; }),
    numRow(doc, 'Mission Surv', meta.missionSurvivors, v => { meta.missionSurvivors = v; }),
    numRow(doc, 'Discoverable', meta.maxDiscoverableSurvivors, v => { meta.maxDiscoverableSurvivors = v; }),
    numRow(doc, 'Heal Bonus', meta.healBonus, v => { meta.healBonus = v; }),
  );
  panes.mission.append(props);

  // ── Briefing / texts ──────────────────────────────────────────────────────
  const text = section(doc, 'Narrative');
  text.append(
    textArea(doc, 'Briefing', meta.briefing, v => { meta.briefing = v; }),
    textArea(doc, 'Victory', meta.victoryText, v => { meta.victoryText = v; }),
    textArea(doc, 'Defeat', meta.defeatText, v => { meta.defeatText = v; }),
  );
  panes.mission.append(text);

  // ── Phase cycle ─────────────────────────────────────────────────────────
  const phase = section(doc, 'Phase Cycle');
  phase.append(
    textRow(doc, 'Phases', (meta.phaseCycle?.phases ?? []).join(','), v => {
      if (!meta.phaseCycle) meta.phaseCycle = { phases: [], loop: true };
      meta.phaseCycle.phases = v.split(',').map(s => s.trim()).filter(Boolean);
    }),
    boolRow(doc, 'Loop', meta.phaseCycle?.loop ?? true, v => {
      if (!meta.phaseCycle) meta.phaseCycle = { phases: [], loop: true };
      meta.phaseCycle.loop = v;
    }),
  );
  panes.mission.append(phase);

  // ── Resources / rewards / loot (JSON blobs) ─────────────────────────────
  const res = section(doc, 'Resources & Rewards');
  res.append(
    jsonRow(doc, 'Starting', meta.startingResources, v => { meta.startingResources = v; }, setStatus),
    jsonRow(doc, 'Rewards', meta.rewards, v => { meta.rewards = v; }, setStatus),
    jsonRow(doc, 'Loot Ovr', meta.lootOverrides, v => { meta.lootOverrides = v; }, setStatus),
  );
  panes.mission.append(res);

  // ── Objectives ──────────────────────────────────────────────────────────
  const obj = section(doc, 'Objectives');
  obj.append(objectiveEditor(doc, 'Win', meta.objectives?.win, def => {
    if (!meta.objectives) meta.objectives = {};
    meta.objectives.win = def;
  }, setStatus));
  obj.append(objectiveEditor(doc, 'Lose', meta.objectives?.lose, def => {
    if (!meta.objectives) meta.objectives = {};
    meta.objectives.lose = def;
  }, setStatus));
  panes.events.append(obj);

  // ── Story triggers (list editor) ─────────────────────────────────────────
  const story = section(doc, 'Story Triggers');
  (meta.storyTriggers ?? []).forEach((tr, i) => {
    story.append(storyTriggerCard(doc, tr, i, {
      remove: () => { removeStoryTrigger(meta, i); rebuild(); },
      up: () => { moveStoryTrigger(meta, i, -1); rebuild(); },
      down: () => { moveStoryTrigger(meta, i, 1); rebuild(); },
    }, setStatus));
  });
  story.append(actionBtn(doc, '+ Add Trigger', () => { addStoryTrigger(meta); rebuild(); }));
  panes.events.append(story);

  // ── Waves (list editor) ─────────────────────────────────────────────────
  const waves = section(doc, 'Waves');
  (meta.waves ?? []).forEach((w, i) => {
    waves.append(waveCard(doc, w, i, { remove: () => { removeWave(meta, i); rebuild(); } }, setStatus));
  });
  waves.append(actionBtn(doc, '+ Add Wave', () => { addWave(meta); rebuild(); }));
  panes.events.append(waves);

  // ── Enemy units (placed on map; list-view for delete / override edit) ─────
  const enemies = section(doc, 'Enemy Units');
  const units = editor.getEnemyUnits();
  if (units.length === 0) enemies.append(hint(doc, 'Place via the Enemy Unit map tool.'));
  units.forEach((u, i) => {
    enemies.append(placedCard(doc, `${u.type} @ ${u.col},${u.row}`,
      u.overrides ?? {}, ov => { u.overrides = ov; }, () => {
        units.splice(i, 1);
        editor.setEnemyUnits(units);
        rebuild();
        rerenderCanvas();
      }, setStatus));
  });
  panes.units.append(enemies);

  // ── Survivor start positions (list-view) ─────────────────────────────────
  const surv = section(doc, 'Survivor Starts');
  if (!Array.isArray(meta.survivorStartPositions)) meta.survivorStartPositions = [];
  if (meta.survivorStartPositions.length === 0) surv.append(hint(doc, 'No survivor start positions.'));
  meta.survivorStartPositions.forEach((s, i) => {
    surv.append(placedCard(doc, `survivor @ ${s.col},${s.row}`, null, null, () => {
      meta.survivorStartPositions.splice(i, 1);
      rebuild();
    }, setStatus));
  });
  panes.units.append(surv);
}

// ── Size controls (item 3) ────────────────────────────────────────────────────

// A read-only "label: value" row for surfacing the locked mode / live size.
function readonlyRow(doc, label, value) {
  const row = doc.createElement('div');
  row.className = 'e-row e-readonly';
  const val = doc.createElement('span');
  val.className = 'e-readonly-val';
  val.textContent = value;
  row.append(labelFor(doc, label), val);
  return row;
}

// Per-edge add/remove controls: one row per edge (top/bottom/left/right) with
// − and + buttons. Each click routes through the controller's resizeEdge; a
// blocked resize (start/node on the edge) surfaces its warning via setStatus.
function buildEdgeControls(doc, editor, setStatus, onSizeChange) {
  const wrap = doc.createElement('div');
  wrap.className = 'e-edges';
  const hdr = doc.createElement('div');
  hdr.className = 'e-edges-hdr';
  hdr.textContent = 'Resize edges';
  wrap.append(hdr);

  for (const edge of MAP_EDGES) {
    const row = doc.createElement('div');
    row.className = 'e-edge-row';
    const lbl = doc.createElement('span');
    lbl.className = 'e-edge-label';
    lbl.textContent = edge;
    const minus = smallBtn(doc, '−', () => applyEdge(edge, -1));
    const plus = smallBtn(doc, '+', () => applyEdge(edge, 1));
    row.append(lbl, minus, plus);
    wrap.append(row);
  }
  return wrap;

  function applyEdge(edge, delta) {
    const res = editor.resizeEdge(edge, delta);
    if (!res.ok) { setStatus(res.warning || 'Resize blocked.', false); return; }
    setStatus(res.warning || '', true);
    onSizeChange(); // rebuild the palette (new dims) + reframe the canvas
  }
}

// ── New-mission creation dialog (item 4) ───────────────────────────────────────
// A small modal overlay over the editor panel: pick a LOCKED map mode (Blank /
// Baked Generated / Overlay) + size (and seed for the generated modes), then
// Create. `onCreate(opts)` receives the buildCreationMapDef options. The mode is
// fixed by this choice — there is no mid-edit toggle afterwards.
function openCreationDialog(doc, onCreate) {
  const panel = doc.getElementById('editor-panel') ?? doc.body;
  const overlay = doc.createElement('div');
  overlay.className = 'e-modal';

  const dlg = doc.createElement('div');
  dlg.className = 'e-modal-box';
  const h = doc.createElement('h3');
  h.textContent = 'New Mission Map';
  dlg.append(h);

  // Mode picker.
  let mode = CreationMode.BLANK;
  const modeRow = doc.createElement('div');
  modeRow.className = 'e-row';
  const modeSel = select(doc, [
    { key: 'Blank (custom)', value: CreationMode.BLANK },
    { key: 'Baked Generated', value: CreationMode.BAKED },
    { key: 'Overlay (procedural)', value: CreationMode.OVERLAY },
  ], 'Blank (custom)', () => {}); // value read via selectedOptions below
  // The `select` helper keys options by display text; map back to the mode value.
  const MODE_BY_LABEL = {
    'Blank (custom)': CreationMode.BLANK,
    'Baked Generated': CreationMode.BAKED,
    'Overlay (procedural)': CreationMode.OVERLAY,
  };
  modeSel.addEventListener('change', () => {
    mode = MODE_BY_LABEL[modeSel.value] ?? CreationMode.BLANK;
    syncFields();
  });
  modeRow.append(labelFor(doc, 'Mode'), modeSel);
  dlg.append(modeRow);

  // Blank dims.
  const colsInput = numInput(doc, 13);
  const rowsInput = numInput(doc, 13);
  const blankWrap = doc.createElement('div');
  blankWrap.append(twoCol(doc, 'Cols', colsInput), twoCol(doc, 'Rows', rowsInput));
  dlg.append(blankWrap);

  // Generated (baked + overlay): named size + seed (+ node count).
  const sizeSel = select(doc, Object.keys(MAP_SIZES).map(k => ({ key: k, value: k })), 'standard', () => {});
  const seedInput = numInput(doc, 12345);
  const nodeInput = numInput(doc, 3);
  const genWrap = doc.createElement('div');
  genWrap.append(twoCol(doc, 'Gen Size', sizeSel), twoCol(doc, 'Seed', seedInput), twoCol(doc, 'Nodes', nodeInput));
  dlg.append(genWrap);

  function syncFields() {
    blankWrap.style.display = mode === CreationMode.BLANK ? '' : 'none';
    genWrap.style.display = mode === CreationMode.BLANK ? 'none' : '';
  }
  syncFields();

  // Buttons.
  const btns = doc.createElement('div');
  btns.className = 'e-modal-btns';
  const cancel = actionBtn(doc, 'Cancel', () => close());
  const create = actionBtn(doc, 'Create', () => {
    const opts = { mode };
    if (mode === CreationMode.BLANK) {
      opts.cols = parseInt(colsInput.value, 10) || 9;
      opts.rows = parseInt(rowsInput.value, 10) || 9;
    } else {
      opts.mapSize = sizeSel.value;
      opts.seed = parseInt(seedInput.value, 10) || 0;
      opts.nodeCount = parseInt(nodeInput.value, 10) || null;
    }
    close();
    onCreate(opts);
  });
  btns.append(cancel, create);
  dlg.append(btns);

  overlay.append(dlg);
  // Click on the dim backdrop (not the box) cancels.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  panel.append(overlay);

  function close() { overlay.remove(); }
}

function numInput(doc, value) {
  const i = doc.createElement('input');
  i.type = 'number';
  i.value = String(value);
  return i;
}

function twoCol(doc, label, input) {
  const row = doc.createElement('div');
  row.className = 'e-row';
  row.append(labelFor(doc, label), input);
  return row;
}

// ── Browser file download (Blob + transient anchor) ─────────────────────────

function downloadJSON(doc, obj, filename) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = doc.createElement('a');
  a.href = url;
  a.download = filename;
  doc.body.appendChild(a);
  a.click();
  doc.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ── Form-widget helpers ──────────────────────────────────────────────────────

function csv(arr) { return Array.isArray(arr) ? arr.join(',') : ''; }
function parseCsvOrNull(v) {
  const out = v.split(',').map(s => s.trim()).filter(Boolean);
  return out.length ? out : null;
}

function textRow(doc, label, value, onChange) {
  const row = doc.createElement('div');
  row.className = 'e-row';
  const input = doc.createElement('input');
  input.type = 'text';
  input.value = value ?? '';
  input.addEventListener('change', () => onChange(input.value));
  row.append(labelFor(doc, label), input);
  return row;
}

function numRow(doc, label, value, onChange) {
  const row = doc.createElement('div');
  row.className = 'e-row';
  const input = doc.createElement('input');
  input.type = 'number';
  input.value = value ?? 0;
  input.addEventListener('change', () => onChange(parseFloat(input.value) || 0));
  row.append(labelFor(doc, label), input);
  return row;
}

function boolRow(doc, label, value, onChange) {
  const row = doc.createElement('div');
  row.className = 'e-row';
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.checked = !!value;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(labelFor(doc, label), input);
  return row;
}

function selRow(doc, label, options, initial, onChange) {
  return labeledSelect(doc, label, options.map(o => ({ key: o, value: o })), initial, onChange);
}

function textArea(doc, label, value, onChange) {
  const wrap = doc.createElement('div');
  wrap.className = 'e-textarea';
  const ta = doc.createElement('textarea');
  ta.value = value ?? '';
  ta.rows = 3;
  ta.addEventListener('change', () => onChange(ta.value));
  wrap.append(labelFor(doc, label), ta);
  return wrap;
}

// A JSON-editing row: parses on change, surfaces parse errors via setStatus and
// reverts visually on failure (the model is left untouched).
function jsonRow(doc, label, value, onChange, setStatus) {
  const wrap = doc.createElement('div');
  wrap.className = 'e-textarea';
  const ta = doc.createElement('textarea');
  ta.value = value == null ? '' : JSON.stringify(value);
  ta.rows = 2;
  ta.addEventListener('change', () => {
    const raw = ta.value.trim();
    if (raw === '') { onChange(null); return; }
    try {
      onChange(JSON.parse(raw));
      setStatus('', true);
    } catch (err) {
      setStatus(`${label}: invalid JSON (${err.message})`, false);
    }
  });
  wrap.append(labelFor(doc, label), ta);
  return wrap;
}

// Objective editor: a type <select> over the known types + a params JSON blob
// (merged with the chosen type). Arrays (multi-lose) are edited as JSON.
function objectiveEditor(doc, label, current, onChange, setStatus) {
  const card = doc.createElement('div');
  card.className = 'e-card';
  card.append(labelFor(doc, label));

  if (Array.isArray(current)) {
    // Multi-objective side — edit as raw JSON array to keep full fidelity.
    card.append(jsonRow(doc, 'list', current, v => onChange(v), setStatus));
    return card;
  }

  const cur = current ?? { type: 'eliminate_all' };
  const typeSel = select(doc, [...KNOWN_OBJECTIVE_TYPES].map(t => ({ key: t, value: t })), cur.type,
    v => {
      const { type, ...params } = cur; // eslint-disable-line no-unused-vars
      onChange({ type: v, ...params });
      cur.type = v;
    });
  const typeRow = doc.createElement('div');
  typeRow.className = 'e-row';
  typeRow.append(labelFor(doc, 'type'), typeSel);
  card.append(typeRow);

  // Params = everything except `type`.
  const { type, ...params } = cur; // eslint-disable-line no-unused-vars
  card.append(jsonRow(doc, 'params', params, p => {
    onChange({ type: cur.type, ...(p || {}) });
  }, setStatus));
  return card;
}

function storyTriggerCard(doc, tr, idx, actions, setStatus) {
  const card = doc.createElement('div');
  card.className = 'e-card';

  card.append(selRow(doc, 'Type', ['round', 'area'], tr.type ?? 'round', v => { tr.type = v; }));
  if (tr.type === 'area') {
    card.append(jsonRow(doc, 'Hexes', tr.hexes ?? [], v => { tr.hexes = v ?? []; }, setStatus));
  } else {
    card.append(numRow(doc, 'Round', tr.round ?? 1, v => { tr.round = v; }));
  }
  card.append(
    textRow(doc, 'Title', tr.title ?? '', v => { tr.title = v; }),
    textArea(doc, 'Text', tr.text ?? '', v => { tr.text = v; }),
    textRow(doc, 'Flag', tr.flag ?? '', v => { tr.flag = v || undefined; }),
    selRow(doc, 'Condition', ['', ...conditionKeys()], tr.condition ?? '', v => {
      if (v) tr.condition = v; else delete tr.condition;
    }),
  );
  card.append(cardButtons(doc, actions));
  return card;
}

function waveCard(doc, w, idx, actions, setStatus) {
  const card = doc.createElement('div');
  card.className = 'e-card';
  card.append(
    selRow(doc, 'Trigger', ['round', 'hero_kills', 'area'], w.trigger ?? 'round', v => { w.trigger = v; }),
    numRow(doc, 'Round', w.round ?? 1, v => { w.round = v; }),
    numRow(doc, 'Count', w.count ?? 1, v => { w.count = v; }),
    jsonRow(doc, 'Units', w.units ?? [], v => { w.units = v ?? []; }, setStatus),
    textRow(doc, 'Spawn At', w.spawnAt ?? '', v => { if (v) w.spawnAt = v; else delete w.spawnAt; }),
  );
  card.append(cardButtons(doc, actions));
  return card;
}

// A placed entity row: label + optional overrides JSON + delete.
function placedCard(doc, label, overrides, onOverrides, onDelete, setStatus) {
  const card = doc.createElement('div');
  card.className = 'e-card';
  const head = doc.createElement('div');
  head.className = 'e-card-head';
  const name = doc.createElement('span');
  name.textContent = label;
  const del = smallBtn(doc, '✕', onDelete);
  head.append(name, del);
  card.append(head);
  if (overrides && onOverrides) {
    card.append(jsonRow(doc, 'Overrides', overrides, onOverrides, setStatus));
  }
  return card;
}

function cardButtons(doc, { remove, up, down }) {
  const row = doc.createElement('div');
  row.className = 'e-card-btns';
  if (up) row.append(smallBtn(doc, '▲', up));
  if (down) row.append(smallBtn(doc, '▼', down));
  if (remove) row.append(smallBtn(doc, '✕', remove));
  return row;
}

function smallBtn(doc, text, onClick) {
  const b = doc.createElement('button');
  b.className = 'e-small';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

function hint(doc, text) {
  const p = doc.createElement('p');
  p.className = 'e-hint';
  p.textContent = text;
  return p;
}

function conditionKeys() {
  return Object.keys(CONDITIONS);
}

// ── Small DOM helpers (scoped to #editor-panel styles) ───────────────────────

function section(doc, title) {
  const s = doc.createElement('div');
  s.className = 'e-section';
  const h = doc.createElement('h3');
  h.textContent = title;
  s.append(h);
  return s;
}

function labelFor(doc, text) {
  const l = doc.createElement('label');
  l.textContent = text;
  return l;
}

function select(doc, options, initial, onChange) {
  const sel = doc.createElement('select');
  for (const o of options) {
    const opt = doc.createElement('option');
    opt.value = o.key;
    opt.textContent = o.key;
    if (o.key === initial) opt.selected = true;
    sel.append(opt);
  }
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

function labeledSelect(doc, label, options, initial, onChange) {
  const row = doc.createElement('div');
  row.className = 'e-row';
  row.append(labelFor(doc, label), select(doc, options, initial, onChange));
  return row;
}

function actionBtn(doc, text, onClick) {
  const b = doc.createElement('button');
  b.className = 'e-action';
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}
