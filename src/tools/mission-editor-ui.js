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
  TileType, BuildingType, ResourceType,
  TILE_COLOR, BUILDING_COLOR, BUILDING_ICON, hasBuilding, isBridge,
} from '../tiles.js';
import { hexKey } from '../hex.js';
import {
  createZombie, createMinion, createWoodGolem, createIronGolem,
} from '../entities.js';
import {
  createMissionEditor, createPreviewController, EditorTool, ENEMY_UNIT_TYPES,
  addStoryTrigger, removeStoryTrigger,
  addWave, removeWave, populateFromMission, CreationMode, MAP_EDGES,
  valuePanelKind, ToolValueKind, createLayerVisibility, showStructures,
  roadNodeMarkersVisible, stripTileOverlays, mapSizePreset,
  overlayDarkenVisible, overlayEditedKeys,
  areaTriggerLayerVisible, areaTriggerHexKeys,
  PHASE_KINDS, addPhase, removePhaseAt, movePhase, setPhaseLoop,
  buildTimelineModel,
  resourceMapToRows, rowsToResourceMap,
  lootOverridesToPicker, pickerToLootOverrides,
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
  { id: EditorTool.PAINT_BASE,      icon: '🌿', label: 'Paint Base',      tip: 'Paint base terrain (grass / forest / dirt) on clicked tiles' },
  { id: EditorTool.PAINT_STRUCTURE, icon: '🏠', label: 'Paint Structure', tip: 'Place or clear a building on clicked tiles' },
  { id: EditorTool.PAINT_ROAD,      icon: '🛤', label: 'Road',           tip: 'Paint a road over the base + wire it to adjacent roads' },
  { id: EditorTool.PAINT_RIVER,     icon: '🌊', label: 'River',          tip: 'Paint a river — must stay a branching tree (no loops or merges)' },
  { id: EditorTool.SET_RESOURCE,    icon: '💎', label: 'Set Resource',    tip: 'Set or clear a harvestable resource on clicked tiles' },
  { id: EditorTool.HIDDEN_SURVIVOR, icon: '🙋', label: 'Hidden Survivor', tip: 'Toggle a hidden survivor to be discovered on a tile' },
  { id: EditorTool.ENEMY_UNIT,      icon: '🧟', label: 'Enemy Unit',      tip: 'Place / remove a pre-placed enemy unit on a tile' },
  { id: EditorTool.HERO_START,      icon: '🛡', label: 'Hero Start',      tip: 'Move the hero starting position to the clicked tile' },
  { id: EditorTool.WITCH_START,     icon: '🧙', label: 'Witch Start',     tip: 'Move the witch starting position to the clicked tile' },
  { id: EditorTool.ROAD_NODE,       icon: '📍', label: 'Road Node',       tip: 'Toggle a road-network waypoint — roads re-generate automatically' },
  { id: EditorTool.POWER_NODE,      icon: '🔮', label: 'Power Node',      tip: 'Toggle a Power Node hex — contiguous hexes group into one node (max 5)' },
  { id: EditorTool.DELETE,          icon: '🧹', label: 'Delete',          tip: 'Clear a tile back to blank base (terrain, structure, path, resource, survivor)' },
];

// Short hints shown in the VALUE panel for the value-less tools.
const TOOL_HINTS = {
  [EditorTool.PAINT_ROAD]: 'Click tiles to paint roads — they auto-wire to adjacent roads.',
  [EditorTool.PAINT_RIVER]: 'Click tiles to paint a river. Rivers must stay a branching tree — a paint that would loop or merge two branches is blocked.',
  [EditorTool.HIDDEN_SURVIVOR]: 'Click a tile to toggle a hidden survivor.',
  [EditorTool.HERO_START]: 'Click a tile to move the hero start.',
  [EditorTool.WITCH_START]: 'Click a tile to move the witch start.',
  [EditorTool.ROAD_NODE]: 'Click tiles to toggle road-network waypoints — roads regenerate automatically.',
  [EditorTool.POWER_NODE]: 'Click tiles to toggle Power Node hexes. Contiguous hexes group into one node (max 5).',
  [EditorTool.DELETE]: 'Click a tile to clear it back to blank base.',
};

// ── Field help text (item 3) ────────────────────────────────────────────────
// A one-line explanation for EVERY logic-bearing sidebar field, keyed by the
// label the form helper renders. Surfaced via labelWithInfo() as both a `title=`
// tooltip AND a small "(i)" affordance so no control is left unexplained.
// Exported so a test can assert coverage of the key fields.
export const FIELD_HELP = Object.freeze({
  // Properties
  'ID': 'Unique mission id — referenced by the campaign registry and save files.',
  'Title': 'Human-readable mission name shown in menus and the briefing.',
  'Chapter': 'Ordering index within its campaign (lower chapters come first).',
  'Campaign': 'Campaign id this mission belongs to (blank = standalone).',
  'Requires': 'Comma-separated mission ids that must be completed before this unlocks.',
  'Has Witch': 'Whether the Witch faction is present (AI-controlled antagonist).',
  'No Scoring': 'Disable Power-Node dawn/dusk scoring — win purely by objectives.',
  'AI Persona': 'AI personality key driving the enemy (e.g. berserker, balanced).',
  'AI Budget+': 'Extra action budget granted to the AI each round (difficulty knob).',
  'Roster Max': 'Max survivors the player may bring in from their recruited roster.',
  'Mission Surv': 'Survivors pre-granted to the player at mission start.',
  'Discoverable': 'Cap on survivors that can be found by exploring buildings.',
  'Heal Bonus': 'Extra HP healed by herbs/rest in this mission.',
  // Phase cycle
  'Loop': 'Whether the phase sequence repeats after its last phase.',
  // Narrative
  'Briefing': 'Intro text shown before the mission starts.',
  'Victory': 'Text shown when the player wins.',
  'Defeat': 'Text shown when the player loses.',
  // Objectives
  'Win': 'Condition the player must meet to win the mission.',
  'Lose': 'Condition that ends the mission in defeat.',
  // Story trigger fields
  'Type': 'Trigger kind — "round" fires on a turn number, "area" when a hex is entered.',
  'Round': 'Round number on which this fires (1 = first turn).',
  'Hexes': 'Hexes (["col,row", …]) that fire this area trigger when entered.',
  'Text': 'Body narrative shown when this beat fires.',
  'Flag': 'Optional story flag set when this fires (gates later conditions).',
  'Condition': 'Optional named predicate (condition registry) gating this trigger.',
  // Wave fields
  'Trigger': 'What launches this wave — a round, a hero-kill count, or an area entry.',
  'Count': 'How many units this wave spawns.',
  'Units': 'Unit specs spawned by this wave (["zombie", …] or typed entries).',
  'Spawn At': 'Optional spawn anchor hex ("col,row") for this wave.',
  // Overrides / placements
  'Overrides': 'Per-placement stat overrides (e.g. {"maxHp":5}) merged onto the unit.',
});

// ── Phase chip metadata (item 9) ────────────────────────────────────────────
// Icon + tooltip per canonical phase, for the icon-based phase-cycle editor.
const PHASE_META = {
  dawn:  { icon: '🌅', label: 'Dawn',  tip: 'Dawn — node scoring checkpoint; transition into day.' },
  day:   { icon: '☀️', label: 'Day',   tip: 'Day — favours the Hero (better sight, bonuses).' },
  dusk:  { icon: '🌇', label: 'Dusk',  tip: 'Dusk — node scoring checkpoint; transition into night.' },
  night: { icon: '🌙', label: 'Night', tip: 'Night — favours the Witch (combat bonus, attrition).' },
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
  // EC: the main-area timeline tab. The canvas pane and this pane are the two
  // main-area views; #e-main-tabs (built below) toggles between them.
  const timelinePane = doc.getElementById('e-timeline-pane');
  const mainTabbar = doc.getElementById('e-main-tabs');
  // The map-area frame (#e-canvas-pane) is position:relative — both the toast
  // host (item 4) and the in-map controls (items 1 + 3) are anchored to it so
  // they ride above the canvas and stay put across pan / zoom / refit.
  const pane = doc.getElementById('e-canvas-pane') ?? canvas?.parentElement ?? doc.body;

  // Toast host (item 4): load/save/validate errors + resize guards pop over the
  // map instead of cluttering the sidebar. Auto-fade, [x] to dismiss now.
  const toast = createToastHost(doc, pane);

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

  // Refreshes the Map-tab "Power Nodes" list after a node toggle / rename. The
  // Map palette registers the real implementation; default is a no-op until then.
  let refreshPowerNodes = () => {};

  function rerender() {
    // Cheap full rebuild — editor maps are small. Reassigning state keeps the
    // Renderer instance, so zoom/pan persist across edits.
    renderer.state = buildState(editor, layers);
    renderer.resize();
    draw();
    refreshPowerNodes(); // node toggles change the cluster list
    rebuildTimeline();   // events / phaseCycle may have changed
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
    const ctx = renderer.ctx;
    if (!ctx) return;
    drawDarkenGeneratedOverlay(ctx);
    drawAreaTriggerMarkers(ctx);
    drawRoadNodeMarkers(ctx);
  }

  // ── Area-event trigger layer (item 5) ──────────────────────────────────────
  // Draw a distinct marker on every hex covered by an AREA story trigger (a
  // trigger carrying a `hexes` array) — a "something happens when the player
  // enters here" cue. Editor-only: painted on the 2D context after
  // renderer.draw(), so renderer.js stays untouched. Gated on the Layers toggle.
  function drawAreaTriggerMarkers(ctx) {
    if (!areaTriggerLayerVisible(layers)) return;
    const keys = areaTriggerHexKeys(editor.getMeta());
    if (!keys.size) return;
    const r = renderer.hexSize * renderer.zoomLevel;
    ctx.save();
    ctx.lineWidth = 2;
    ctx.font = `${Math.max(10, r * 0.85)}px serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const key of keys) {
      const [c, rr] = String(key).split(',').map(Number);
      const { x, y } = renderer.hexToCanvasPos(c, rr);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 30);
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(150,90,230,0.28)'; // translucent event tint
      ctx.fill();
      ctx.strokeStyle = 'rgba(200,150,255,0.85)';
      ctx.stroke();
      ctx.fillStyle = '#f0e0ff';
      ctx.fillText('⚑', x, y); // "event fires when the player enters"
    }
    ctx.restore();
  }

  // ── Darken auto-generated tiles (item 9) ───────────────────────────────────
  // OVERLAY-mode only: dim every hex that came from the generated base (i.e. is
  // NOT in the explicit overlay-edit set) so the author can see at a glance which
  // hexes are their preserved edits vs the regenerable base. Drawn as a flat dark
  // hex fill over each non-edited tile — renderer.js is untouched.
  function drawDarkenGeneratedOverlay(ctx) {
    const mapDef = editor.getMapDef();
    if (!overlayDarkenVisible(layers, mapDef)) return;
    const edited = overlayEditedKeys(mapDef);
    let built;
    try { built = buildMissionMap(mapDef); } catch { return; }
    const r = renderer.hexSize * renderer.zoomLevel;
    ctx.save();
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    for (const t of built.tiles.values()) {
      if (edited.has(hexKey(t.col, t.row))) continue; // a preserved edit — keep bright
      const { x, y } = renderer.hexToCanvasPos(t.col, t.row);
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 180 * (60 * i - 30);
        const px = x + r * Math.cos(a);
        const py = y + r * Math.sin(a);
        if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();
  }

  function drawRoadNodeMarkers(ctx) {
    if (!roadNodeMarkersVisible(layers, editor.activeTool)) return;
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
    onPaint: (hex) => {
      const res = editor.applyAt(hex);
      // A blocked edit (e.g. the Power-Node 5-hex cap) surfaces its reason.
      if (res && res.ok === false && res.warning) toast.show(res.warning, { type: 'err' });
    },
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
  // Status now routes to a toast over the map (item 4) instead of a sidebar line.
  const formStatus = (msg, ok) => { if (msg) toast.show(msg, { type: ok ? 'ok' : 'err' }); };

  // In-map controls (items 1 + 3): the per-edge circular resize buttons, the
  // fit-map control, and the N×N size badge. Created once over the pane; refresh()
  // re-reads the mode (edge buttons are handmade-only) + live dims after any
  // structural change. mapArea is assigned below; rebuildMapPalette calls
  // mapArea.refresh() so the badge / edge visibility track every rebuild.
  let mapArea = null;

  function rebuildForms() {
    buildForms(doc, sidebar.panes, editor, rerender, rebuildForms, formStatus);
    rebuildTimeline(); // phaseCycle edits (sidebar Mission tab) reshape the track
  }
  // The Map palette reflects the locked mode + live dims; rebuild it whenever
  // those can change (creation, resize, load) and reframe the canvas.
  function rebuildMapPalette() {
    buildMapPalette(doc, sidebar.panes.map, editor, rerender, openPreview, {
      onSizeChange: () => { rebuildMapPalette(); resetViewAndDraw(); },
      setStatus: formStatus,
      // Tool change can flip the road-node-marker auto-show, so redraw overlays.
      onToolChange: () => draw(),
      // The Map palette owns the Power-Node list; capture its refresh so a node
      // toggle/rename (which goes through rerender) re-renders just that list.
      registerPowerNodeRefresh: (fn) => { refreshPowerNodes = fn; },
    });
    mapArea?.refresh();
  }

  mapArea = buildMapAreaControls(doc, pane, editor, {
    onFit: () => resetViewAndDraw(),
    // A successful edge resize changes dims → rebuild the palette + reframe.
    onResize: (res) => { if (res.ok) { rebuildMapPalette(); resetViewAndDraw(); } },
    toast,
  });
  // The Layers (visibility) pane toggles the editor-side display filters.
  function rebuildLayers() {
    buildLayersPanel(doc, sidebar.panes.layers, layers, () => rerender(),
      editor.getMode() === 'procedural');
  }
  // ── Timeline tab (EC) ─────────────────────────────────────────────────────
  // Rebuilds the main-area timeline pane from the current meta (phaseCycle +
  // round events). Authoring routes through editor.editMeta (one undo step each)
  // → rerender → rebuildTimeline, so the pane reflects every change live.
  function rebuildTimeline() {
    if (!timelinePane) return;
    buildTimelinePane(doc, timelinePane, editor, formStatus);
  }

  // Main-area tabs (Map ⇄ Timeline). Switching to Map re-fits the canvas (it was
  // display:none with zero size while Timeline showed); switching to Timeline
  // rebuilds it from the latest model.
  const mainTabs = buildMainTabs(doc, mainTabbar, {
    onMap: () => {
      if (timelinePane) timelinePane.classList.remove('active');
      if (pane) pane.classList.add('active');
      resetViewAndDraw();
    },
    onTimeline: () => {
      if (pane) pane.classList.remove('active');
      if (timelinePane) timelinePane.classList.add('active');
      rebuildTimeline();
    },
  });
  mainTabs?.activate('map');

  // In-place field edits inside timeline event cards (title / round / type / …)
  // fire bubbling `change`; a full rerender relocates a re-rounded card and
  // refreshes the canvas area-trigger overlay. Add/remove go through editMeta
  // (their own undo step). Attached once — rebuildTimeline only clears children.
  timelinePane?.addEventListener('change', () => rerender());

  rebuildMapPalette();
  rebuildForms();
  rebuildLayers();
  rebuildTimeline();

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
    toast.dismissAll(); // clear any stale validation/resize toasts (carried nit)
    rebuildMapPalette(); // mode + dims may have changed
    rebuildForms();
    rebuildLayers();     // the darken toggle is overlay-only — mode may have changed
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
      toast.dismissAll(); // clear stale toasts when starting fresh (carried nit)
      rebuildMapPalette();
      rebuildForms();
      rebuildLayers();    // the darken toggle is overlay-only — mode may have changed
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
// Splits the old single-scroll palette into five tabs so only one group of
// controls shows at a time. Returns { panes } where `panes` holds the five pane
// containers (map / layers / mission / events / units) — `map` is (re)built by
// rebuildMapPalette, `layers` by buildLayersPanel, and the other three by
// buildForms. Status now surfaces as a toast over the map (item 4), not a
// sidebar line.
function buildSidebar(doc, root) {
  root.innerHTML = '';

  const SIDEBAR_TABS = [
    { id: 'map', label: 'Map', tip: 'Terrain, structures, paths, starts, nodes + sizing tools' },
    { id: 'layers', label: 'Layers', tip: 'Toggle which map layers are drawn in the editor view' },
    { id: 'mission', label: 'Mission', tip: 'Mission properties, narrative, phase cycle, resources' },
    { id: 'events', label: 'Objectives', tip: 'Win / lose objectives (story triggers & waves live in the Timeline tab)' },
    { id: 'units', label: 'Units', tip: 'Placed enemy units + survivor start positions' },
  ];

  // Tab buttons.
  const tabbar = doc.createElement('div');
  tabbar.className = 'e-tabbar';
  const tabBtns = {};
  for (const t of SIDEBAR_TABS) {
    const b = doc.createElement('button');
    b.className = 'e-stab';
    b.textContent = t.label;
    b.title = t.tip; // item 2 — tooltip on every control
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
  };
}

// ── Main-area tabs (EC) ───────────────────────────────────────────────────────
// The Map (canvas) and Timeline views are the two main-area panes; this bar
// toggles between them via the shared (unit-tested) tab controller. Returns the
// controller so the caller can `activate('map')` on boot.
function buildMainTabs(doc, container, { onMap, onTimeline } = {}) {
  if (!container) return null;
  container.innerHTML = '';
  const DEFS = [
    { id: 'map', label: 'Map', tip: 'Paint terrain, structures, paths, starts, nodes + place units' },
    { id: 'timeline', label: 'Timeline', tip: 'Round-by-round day/night cycle with story triggers & enemy waves' },
  ];
  const btns = {};
  for (const d of DEFS) {
    const b = doc.createElement('button');
    b.className = 'e-stab';
    b.textContent = d.label;
    b.title = d.tip;
    b.dataset.mtab = d.id;
    b.addEventListener('click', () => tabs.activate(d.id));
    btns[d.id] = b;
    container.append(b);
  }
  const tabs = createTabController(DEFS.map(d => d.id), {
    onActivate: (id) => {
      for (const d of DEFS) btns[d.id].classList.toggle('active', d.id === id);
      if (id === 'timeline') onTimeline?.(); else onMap?.();
    },
  });
  return tabs;
}

// ── Timeline pane (EC) ──────────────────────────────────────────────────────
// The main-area Timeline tab: a vertical round track whose left rail shows each
// round's phase (the day/night cycle, derived from phaseCycle), and whose body
// carries that round's story triggers + enemy waves. Below the track, separate
// lanes hold area / on-enter triggers and non-round (kill / area) waves — these
// aren't tied to a round so they're never forced onto one.
//
// Authoring REUSES the storyTrigger/wave model + cards: add/remove route through
// editor.editMeta (one undo step each) → rerender → rebuild; in-place field
// edits fire `change`, refreshed by the pane-level listener in initEditor.
function buildTimelinePane(doc, host, editor, setStatus) {
  host.innerHTML = '';
  const meta = editor.getMeta();
  const model = buildTimelineModel(meta);

  const head = doc.createElement('div');
  head.className = 'e-tl-intro e-section';
  const h = doc.createElement('h3');
  h.textContent = 'Mission Timeline';
  head.append(h);
  const looping = meta.phaseCycle?.loop ?? true;
  head.append(hint(doc,
    `Phases come from the Mission tab's Phase Cycle${looping ? ' (looping past its end)' : ' (last phase holds past its end)'}. ` +
    'Click a round’s + to add a story trigger or wave there.'));
  host.append(head);

  const track = doc.createElement('div');
  track.className = 'e-tl-track';
  for (const rd of model.rounds) track.append(timelineRoundRow(doc, rd, editor, setStatus));
  host.append(track);

  host.append(timelineAreaLane(doc, model.areaTriggers, editor, setStatus));
  if (model.offRoundWaves.length) {
    host.append(timelineOffWavesLane(doc, model.offRoundWaves, editor, setStatus));
  }
}

// One round row: phase rail (left) + that round's event cards & add buttons.
function timelineRoundRow(doc, rd, editor, setStatus) {
  const row = doc.createElement('div');
  row.className = 'e-tl-row';

  const rail = doc.createElement('div');
  rail.className = `e-tl-rail e-tl-phase-${rd.phase ?? 'none'}`;
  const num = doc.createElement('div');
  num.className = 'e-tl-round';
  num.textContent = `R${rd.round}`;
  const meta = PHASE_META[rd.phase] ?? { icon: '·', label: rd.phase ?? '—', tip: 'No phase mapped for this round.' };
  const badge = doc.createElement('div');
  badge.className = 'e-tl-phase';
  badge.textContent = `${meta.icon} ${meta.label}`;
  badge.title = meta.tip;
  rail.append(num, badge);
  row.append(rail);

  const body = doc.createElement('div');
  body.className = 'e-tl-events';
  if (!rd.story.length && !rd.waves.length) body.append(hint(doc, 'No events this round.'));
  for (const { index, trigger } of rd.story) {
    body.append(storyTriggerCard(doc, trigger, index,
      { remove: () => editor.editMeta(m => removeStoryTrigger(m, index)) }, setStatus));
  }
  for (const { index, wave } of rd.waves) {
    body.append(waveCard(doc, wave, index,
      { remove: () => editor.editMeta(m => removeWave(m, index)) }, setStatus));
  }
  const adds = doc.createElement('div');
  adds.className = 'e-tl-adds';
  adds.append(
    actionBtn(doc, '+ Trigger',
      () => editor.editMeta(m => addStoryTrigger(m, { type: 'round', round: rd.round })),
      `Add a story trigger that fires on round ${rd.round}`),
    actionBtn(doc, '+ Wave',
      () => editor.editMeta(m => addWave(m, { trigger: 'round', round: rd.round })),
      `Add an enemy wave that spawns on round ${rd.round}`),
  );
  body.append(adds);
  row.append(body);
  return row;
}

// Area / on-enter triggers — fire on hex entry, not a round (their own lane).
function timelineAreaLane(doc, areaTriggers, editor, setStatus) {
  const sec = section(doc, 'On-Enter / Area Triggers');
  sec.classList.add('e-tl-lane');
  sec.append(hint(doc, 'Fire when the player enters the listed hexes — not tied to a round.'));
  for (const { index, trigger } of areaTriggers) {
    sec.append(storyTriggerCard(doc, trigger, index,
      { remove: () => editor.editMeta(m => removeStoryTrigger(m, index)) }, setStatus));
  }
  sec.append(actionBtn(doc, '+ Area Trigger',
    () => editor.editMeta(m => addStoryTrigger(m, { type: 'area', hexes: [] })),
    'Add an area trigger (fires when the player enters its hexes)'));
  return sec;
}

// Non-round waves (hero_kills / area triggered) — also off the round track.
function timelineOffWavesLane(doc, offWaves, editor, setStatus) {
  const sec = section(doc, 'Other Waves (kill / area triggered)');
  sec.classList.add('e-tl-lane');
  sec.append(hint(doc, 'Spawn on a kill-count or area trigger rather than a fixed round.'));
  for (const { index, wave } of offWaves) {
    sec.append(waveCard(doc, wave, index,
      { remove: () => editor.editMeta(m => removeWave(m, index)) }, setStatus));
  }
  return sec;
}

// ── Toast host (item 4) ─────────────────────────────────────────────────────────
// A reusable toast stack anchored over the map area. show(msg, opts) pops a toast
// that auto-fades after `timeout` ms (0 = sticky) and carries an [✕] to dismiss
// immediately; it returns a { dismiss } handle. dismissAll() clears the stack.
// Pure DOM (createElement / append / remove / addEventListener) so it unit-tests
// against a lightweight fake document.
export function createToastHost(doc, container) {
  const host = doc.createElement('div');
  host.className = 'e-toast-host';
  container.append(host);
  const live = new Set();

  function show(msg, { type = 'info', timeout = 4500 } = {}) {
    if (!msg) return { dismiss() {} };
    const el = doc.createElement('div');
    el.className = `e-toast e-toast-${type}`;
    const text = doc.createElement('span');
    text.className = 'e-toast-msg';
    text.textContent = msg;
    const close = doc.createElement('button');
    close.type = 'button';
    close.className = 'e-toast-x';
    close.textContent = '✕';
    close.title = 'Dismiss';
    el.append(text, close);
    host.append(el);
    live.add(el);

    let timer = null;
    const dismiss = () => {
      if (!live.has(el)) return;
      live.delete(el);
      if (timer) { clearTimeout(timer); timer = null; }
      el.remove();
    };
    close.addEventListener('click', dismiss);
    if (timeout > 0) timer = setTimeout(dismiss, timeout);
    return { dismiss };
  }

  function dismissAll() {
    for (const el of [...live]) { live.delete(el); el.remove(); }
  }

  return { show, dismissAll, _host: host };
}

// ── In-map controls (items 1 + 3) ───────────────────────────────────────────────
// Three overlays anchored to the map-area frame: the per-edge circular resize
// buttons (handmade only), the fit-map control cluster, and the N×N size badge.
// refresh() re-reads mode + dims after any structural change.
function buildMapAreaControls(doc, pane, editor, { onFit, onResize, toast }) {
  const edges = buildEdgeButtons(doc, editor, { onResize, toast });
  const controls = buildMapControls(doc, { onFit });
  const badge = doc.createElement('div');
  badge.className = 'e-size-badge';
  badge.title = 'Current map size (columns × rows)';
  pane.append(edges, controls, badge);

  function refresh() {
    edges.style.display = editor.getMode() === 'handmade' ? '' : 'none';
    const dims = editor.getDims();
    badge.textContent = `${dims.cols} × ${dims.rows}`;
  }
  refresh();
  return { refresh };
}

/**
 * Build the in-map circular per-edge resize controls (item 1). One round −/+ pair
 * anchored to each map-frame edge (top/bottom/left/right). Each click routes
 * through editor.resizeEdge(edge, ±1) — the SAME coordinate-remap logic the old
 * sidebar rows used (relocated, not reimplemented). A blocked / lossy resize
 * surfaces its warning via `toast`, and the result is handed to `onResize`.
 * Returns the overlay container; exported for unit-testing the relocation wiring.
 */
export function buildEdgeButtons(doc, editor, { onResize = () => {}, toast } = {}) {
  const wrap = doc.createElement('div');
  wrap.className = 'e-edge-overlay';
  for (const edge of MAP_EDGES) {
    const group = doc.createElement('div');
    group.className = `e-edge-group e-edge-${edge}`;
    group.append(edgeBtn('−', edge, -1), edgeBtn('+', edge, 1));
    wrap.append(group);
  }
  return wrap;

  function edgeBtn(glyph, edge, delta) {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'e-edge-btn';
    b.textContent = glyph;
    b.dataset.edge = edge;
    b.dataset.delta = String(delta);
    const unit = (edge === 'left' || edge === 'right') ? 'column' : 'row';
    b.title = delta > 0 ? `Add a ${edge} ${unit}` : `Remove the ${edge} ${unit}`;
    b.addEventListener('click', () => {
      const res = editor.resizeEdge(edge, delta);
      if (toast) {
        if (!res.ok) toast.show(res.warning || 'Resize blocked.', { type: 'err' });
        else if (res.warning) toast.show(res.warning, { type: 'info' });
      }
      onResize(res);
    });
    return b;
  }
}

/**
 * Build the in-map control cluster (item 3). Currently a single "fit map" button
 * (⛶) matching the in-game zoom-fit control: pressing it reframes the map via the
 * injected `onFit` (which resize()s + resetView()s the SAME Renderer the game
 * uses, exactly like ui.js's zoom-fit handler). Returns the cluster element so the
 * next chunk can append more map controls to it (clean seam). Exported for tests.
 */
export function buildMapControls(doc, { onFit = () => {} } = {}) {
  const cluster = doc.createElement('div');
  cluster.className = 'e-mapctl';
  const fit = doc.createElement('button');
  fit.type = 'button';
  fit.className = 'e-mapctl-btn';
  fit.textContent = '⛶';
  fit.title = 'Fit map to view';
  fit.setAttribute('aria-label', 'Fit map to view');
  fit.addEventListener('click', () => onFit());
  cluster.append(fit);
  return cluster;
}

// ── Map-tab palette DOM ───────────────────────────────────────────────────────

function buildMapPalette(doc, root, editor, rerender, onPreview3D, hooks = {}) {
  root.innerHTML = '';
  const onSizeChange = hooks.onSizeChange ?? (() => {});
  const setStatus = hooks.setStatus ?? (() => {});

  const mapDef = editor.getMapDef();
  const isProcedural = mapDef.mode === 'procedural';

  // ── Map properties: LOCKED mode (read-only) ──────────────────────────────
  // The map mode is chosen once at creation (File ▸ New…) and cannot be toggled
  // here — only displayed. Size is editable via the in-map per-edge buttons
  // (handmade) or the Gen Size selector (overlay); the live N×N is shown by the
  // in-map size badge (item 12), so no Size field is duplicated here.
  const mapSection = section(doc, 'Map');
  mapSection.append(readonlyRow(doc, 'Mode', editor.getMapModeLabel()));

  if (isProcedural) {
    // Overlay: seed + named size selector (generateMap is discrete, so resizing
    // an overlay map means switching its generation size — out-of-bounds edits
    // are then dropped). Changing size reframes + rebuilds the palette.
    const seedRow = doc.createElement('div');
    seedRow.className = 'e-row';
    const seedInput = doc.createElement('input');
    seedInput.type = 'number';
    seedInput.value = String(mapDef.seed ?? 12345);
    seedInput.title = 'Procedural generation seed — same seed reproduces the same base map';
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
    mapSection.append(actionBtn(doc, 'Rebuild Map',
      () => editor.regenerateRoads(),
      'Regenerate the procedural base + roads from the current seed'));
  } else {
    // Handmade (blank/baked): resize via the IN-MAP per-edge circular buttons
    // (item 1) — relocated out of the sidebar. Only the road-derivation action
    // stays here.
    mapSection.append(actionBtn(doc, 'Regenerate Roads',
      () => editor.regenerateRoads(),
      'Re-derive the road network from buildings, bridges + authored road nodes'));
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
    btn.title = t.tip ?? t.label; // item 2 — descriptive tooltip, not just the label
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

  // ── Power Nodes (item 6) — list each cluster with its colour, editable name,
  // and hex count. Re-rendered on every node toggle/rename via the registered
  // refresh hook so the list tracks contiguity grouping live. ──────────────────
  const pnSection = section(doc, 'Power Nodes');
  const pnHost = doc.createElement('div');
  pnSection.append(pnHost);
  root.append(pnSection);
  function renderPowerNodes() {
    pnHost.innerHTML = '';
    const nodes = editor.getPowerNodes();
    if (!nodes.length) {
      pnHost.append(hint(doc, 'Use the Power Node tool to mark hexes. Contiguous hexes group into one node (max 5).'));
      return;
    }
    nodes.forEach((n, i) => pnHost.append(powerNodeRow(doc, n, i, editor)));
  }
  renderPowerNodes();
  (hooks.registerPowerNodeRefresh ?? (() => {}))(renderPowerNodes);

  // View / Reset moved to the in-map fit-map control (item 3). Undo / Redo live
  // on the top bar (item 5). Only the 3D preview action remains in the sidebar.
  if (onPreview3D) {
    const previewSection = section(doc, 'Preview');
    previewSection.append(actionBtn(doc, 'Preview in 3D', () => onPreview3D(),
      'Open a live 3D preview of the current map (Babylon renderer)'));
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
    btn.title = `Select ${it.label}`;
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

// A single Power-Node cluster row: a colour swatch, an editable name field, and
// the hex count. Renaming goes through editor.renamePowerNode (one undo step).
function powerNodeRow(doc, node, idx, editor) {
  const row = doc.createElement('div');
  row.className = 'e-pn-row';
  const dot = doc.createElement('span');
  dot.className = 'e-pn-dot';
  dot.style.background = node.color || '#8800cc';
  dot.title = `Node colour ${node.color || ''}`;
  const name = doc.createElement('input');
  name.type = 'text';
  name.className = 'e-pn-name';
  name.value = node.label ?? `Power Node ${idx + 1}`;
  name.title = 'Rename this Power Node';
  name.addEventListener('change', () => editor.renamePowerNode(idx, name.value));
  const size = doc.createElement('span');
  size.className = 'e-pn-size';
  const n = (node.hexes ?? []).length;
  size.textContent = `×${n}`;
  size.title = `${n} hex${n === 1 ? '' : 'es'} in this cluster`;
  row.append(dot, name, size);
  return row;
}

// ── Layers (visibility) panel (item 6) ──────────────────────────────────────
// Checkbox toggles over the editor-side display filters. Mutates the shared
// `layers` object in place; `onChange` triggers a rerender (filter + overlay).
function buildLayersPanel(doc, root, layers, onChange, isOverlay = false) {
  root.innerHTML = '';
  const sec = section(doc, 'Visibility');
  // item 11 — each toggle carries a tooltip explaining exactly what it shows.
  const toggles = [
    { key: 'roadsBuildings', label: 'Roads + Buildings',
      tip: 'Draw the structure + path layers (buildings, roads, rivers, bridges)' },
    { key: 'powerNodes', label: 'Power Nodes',
      tip: 'Draw the Power Node objective markers' },
    { key: 'playerStarts', label: 'Player Start points',
      tip: 'Draw the hero + witch start markers' },
    { key: 'roadNodeMarkers', label: 'Road-network nodes',
      tip: 'Draw the road-graph node overlay (structural + authored waypoints)' },
    { key: 'areaTriggers', label: 'Area events',
      tip: 'Mark hexes where an area story trigger fires when the player enters' },
    // item 9 — overlay maps only: there's no generated base to darken on a
    // handmade map, so this toggle is omitted there.
    ...(isOverlay ? [{ key: 'darkenGenerated', label: 'Darken auto-generated',
      tip: 'Dim hexes that came from the generated base, so your explicit edits stand out' }] : []),
  ];
  for (const t of toggles) {
    sec.append(layerToggleRow(doc, t.label, t.tip, layers[t.key],
      (v) => { layers[t.key] = v; onChange(); }));
  }
  sec.append(hint(doc, 'Road-network nodes also auto-show while the Road Node tool is active.'));
  root.append(sec);
}

// A full-width layer toggle row (item 11): the label fills the row, the checkbox
// sits at the right edge, and the whole row carries the explanatory tooltip.
function layerToggleRow(doc, label, tip, value, onChange) {
  const row = doc.createElement('label');
  row.className = 'e-layer-row';
  if (tip) row.title = tip;
  const txt = doc.createElement('span');
  txt.className = 'e-layer-label';
  txt.textContent = label;
  const input = doc.createElement('input');
  input.type = 'checkbox';
  input.checked = !!value;
  if (tip) input.title = tip;
  input.addEventListener('change', () => onChange(input.checked));
  row.append(txt, input);
  return row;
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
    // Map Size field removed (item 12) — size is set explicitly via the New-map
    // dialog + in-map edge buttons, and shown by the in-map N×N badge. meta.mapSize
    // still rides along in the model (set at creation) so the round-trip is lossless.
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

  // ── Phase cycle (item 9) — icon-chip sequence editor ─────────────────────
  const phase = section(doc, 'Phase Cycle');
  phase.append(phaseCycleEditor(doc, meta, rebuild));
  panes.mission.append(phase);

  // ── Resources / rewards / loot — picker UIs (item 8) ────────────────────
  const res = section(doc, 'Resources & Rewards');
  res.append(
    resourcePicker(doc, 'Starting', meta.startingResources,
      m => { meta.startingResources = m; },
      'Resources the player begins the mission holding.'),
    resourcePicker(doc, 'Rewards', meta.rewards,
      m => { meta.rewards = m; },
      'Resources granted to the player on victory.'),
    lootOverridePicker(doc, meta.lootOverrides, lo => { meta.lootOverrides = lo; }),
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

  // Story triggers + waves moved OUT of this cramped sidebar tab and into the
  // main-area Timeline tab (EC) — round events live on the round track, area /
  // on-enter triggers + non-round waves in the Timeline's side lanes. A pointer
  // keeps the relocation discoverable.
  panes.events.append(hint(doc,
    'Story triggers & enemy waves are authored in the Timeline tab (top-left).'));

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
  modeSel.title = 'Blank = empty editable grid · Baked = generated then fully editable · Overlay = regenerable seeded base + edits';
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

  // Blank dims: a standard-size preset dropdown that prefills Cols/Rows (item 12),
  // plus a "Custom" option that re-enables the explicit X/Y inputs.
  const colsInput = numInput(doc, 13);
  const rowsInput = numInput(doc, 13);
  colsInput.title = 'Number of columns (X)';
  rowsInput.title = 'Number of rows (Y)';
  const CUSTOM = 'Custom';
  const presetOpts = [
    ...Object.keys(MAP_SIZES).map(k => ({ key: k, value: k })),
    { key: CUSTOM, value: CUSTOM },
  ];
  // Default to "standard" (13×13) — matches the previous hard-coded default.
  const presetSel = select(doc, presetOpts, 'standard', applyPreset);
  presetSel.title = 'Pick a standard map size to prefill Cols/Rows, or Custom to set them by hand';
  const blankWrap = doc.createElement('div');
  blankWrap.append(twoCol(doc, 'Size', presetSel), twoCol(doc, 'Cols', colsInput), twoCol(doc, 'Rows', rowsInput));
  dlg.append(blankWrap);
  applyPreset('standard'); // prefill + lock the inputs for the default preset

  // A preset name prefills + locks Cols/Rows; "Custom" re-enables manual entry.
  function applyPreset(name) {
    const dims = mapSizePreset(name);
    if (dims) {
      colsInput.value = String(dims.cols);
      rowsInput.value = String(dims.rows);
      colsInput.disabled = true;
      rowsInput.disabled = true;
    } else {
      colsInput.disabled = false;
      rowsInput.disabled = false;
    }
  }

  // Generated (baked + overlay): named size + seed (+ node count).
  const sizeSel = select(doc, Object.keys(MAP_SIZES).map(k => ({ key: k, value: k })), 'standard', () => {});
  sizeSel.title = 'Standard generation size for the procedural base';
  const seedInput = numInput(doc, 12345);
  seedInput.title = 'Generation seed — the same seed reproduces the same map';
  const nodeInput = numInput(doc, 3);
  nodeInput.title = 'Number of Power Nodes to place';
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
  const cancel = actionBtn(doc, 'Cancel', () => close(), 'Discard and close without creating a map');
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
  }, 'Create the new map with these settings');
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

// ── Phase-cycle icon editor (item 9) ────────────────────────────────────────
// A friendly chip-sequence editor over phaseCycle { phases:[…], loop }. The
// current sequence renders as ordered icon chips (◀ move-earlier · glyph · ▶
// move-later · ✕ remove); an "add phase" palette of the four canonical phases
// appends a chip; a loop checkbox toggles repeat. All edits route through the
// pure ops (addPhase / removePhaseAt / movePhase / setPhaseLoop) then `rebuild`
// re-renders the forms — EC's timeline tab reads the same clean phases[] array.
function phaseCycleEditor(doc, meta, rebuild) {
  const wrap = doc.createElement('div');
  wrap.className = 'e-phase-editor';

  const phases = meta.phaseCycle?.phases ?? [];
  const seq = doc.createElement('div');
  seq.className = 'e-phase-seq';
  if (!phases.length) {
    seq.append(hint(doc, 'No phases — add dawn / day / dusk / night chips below.'));
  }
  phases.forEach((p, i) => seq.append(phaseChip(doc, p, i, phases.length, {
    left:   () => { movePhase(meta, i, -1); rebuild(); },
    right:  () => { movePhase(meta, i, 1); rebuild(); },
    remove: () => { removePhaseAt(meta, i); rebuild(); },
  })));
  wrap.append(seq);

  const add = doc.createElement('div');
  add.className = 'e-phase-add';
  add.append(labelWithInfo(doc, 'Add phase', 'Append a phase to the cycle sequence.'));
  for (const key of PHASE_KINDS) {
    const m = PHASE_META[key];
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = 'e-phase-addbtn';
    b.textContent = `${m.icon} ${m.label}`;
    b.title = m.tip;
    b.setAttribute('aria-label', `Add ${m.label} phase`);
    b.addEventListener('click', () => { addPhase(meta, key); rebuild(); });
    add.append(b);
  }
  wrap.append(add);

  wrap.append(boolRow(doc, 'Loop', meta.phaseCycle?.loop ?? true, v => setPhaseLoop(meta, v)));
  return wrap;
}

function phaseChip(doc, phase, idx, count, { left, right, remove }) {
  const m = PHASE_META[phase] ?? { icon: '❔', label: phase, tip: `Unknown phase "${phase}".` };
  const chip = doc.createElement('span');
  chip.className = 'e-phase-chip';
  chip.title = m.tip;
  if (idx > 0) chip.append(smallBtn(doc, '◀', left, 'Move this phase earlier'));
  const glyph = doc.createElement('span');
  glyph.className = 'e-phase-glyph';
  glyph.textContent = `${m.icon} ${m.label}`;
  chip.append(glyph);
  if (idx < count - 1) chip.append(smallBtn(doc, '▶', right, 'Move this phase later'));
  chip.append(smallBtn(doc, '✕', remove, 'Remove this phase'));
  return chip;
}

// ── Resource map picker (item 8) ────────────────────────────────────────────
// Replaces the raw-JSON textarea for startingResources / rewards with rows of
// {ResourceType dropdown + amount}. Self-rerendering host: every edit reassembles
// the rows into a { [type]: amount } map via the pure helpers and pushes it back
// through `onChange`. Round-trips losslessly (resourceMapToRows ↔ rowsToResourceMap).
function resourcePicker(doc, label, obj, onChange, tip) {
  const wrap = doc.createElement('div');
  wrap.className = 'e-res-picker';
  wrap.append(labelWithInfo(doc, label, tip ?? null));
  const host = doc.createElement('div');
  host.className = 'e-res-rows';
  wrap.append(host);

  const rows = resourceMapToRows(obj);
  const commit = () => onChange(rowsToResourceMap(rows));
  const RES_ENTRIES = _entries(ResourceType); // { key:'HERBS', value:'herbs' }

  function render() {
    host.innerHTML = '';
    if (!rows.length) host.append(hint(doc, 'No resources — use “+ Add”.'));
    rows.forEach((r, i) => host.append(resourceRow(doc, r, RES_ENTRIES, {
      onType:   (v) => { r.type = v; commit(); },
      onAmount: (v) => { r.amount = v; commit(); },
      onRemove: () => { rows.splice(i, 1); commit(); render(); },
    })));
    host.append(actionBtn(doc, '+ Add', () => {
      rows.push({ type: RES_ENTRIES[0].value, amount: 1 });
      commit(); render();
    }, `Add a ${label.toLowerCase()} resource row`));
  }
  render();
  return wrap;
}

function resourceRow(doc, row, entries, { onType, onAmount, onRemove }) {
  const r = doc.createElement('div');
  r.className = 'e-row e-res-row';
  // select() keys options by display text === stored value, so use the runtime
  // value ('herbs') for both — that's what the resource map stores.
  const sel = select(doc, entries.map(e => ({ key: e.value, value: e.value })), row.type, onType);
  sel.title = 'Resource type';
  const amt = doc.createElement('input');
  amt.type = 'number';
  amt.className = 'e-res-amt';
  amt.value = String(row.amount ?? 0);
  amt.title = 'Amount';
  amt.addEventListener('change', () => onAmount(parseInt(amt.value, 10) || 0));
  r.append(sel, amt, smallBtn(doc, '✕', onRemove, 'Remove this resource'));
  return r;
}

// Loot ids the add/remove pickers offer (weapons + resource drops + the special
// 'horse' / 'nothing' outcomes). A value already present in the model but absent
// here is still offered, so a legacy/unknown id round-trips without being dropped.
const LOOT_ITEM_IDS = [
  'sword', 'axe', 'bow', 'crossbow', 'shield', 'staff', 'dagger',
  'herbs', 'silver', 'wood', 'metal', 'food', 'scripture',
  'horse', 'nothing',
];

// ── lootOverrides picker (item 8) ───────────────────────────────────────────
// Edits the add / remove id lists as dropdown rows; richer keys (e.g. per-building
// weighted tables) ride along untouched via the picker model's `rest`. Assembles
// back through pickerToLootOverrides (null when fully empty). Round-trips lossless.
function lootOverridePicker(doc, lo, onChange) {
  const model = lootOverridesToPicker(lo);
  const wrap = doc.createElement('div');
  wrap.className = 'e-loot-picker';
  wrap.append(labelWithInfo(doc, 'Loot Overrides',
    'Force-add or remove loot ids from drop tables. Other override keys (e.g. per-building tables) are preserved.'));
  const commit = () => onChange(pickerToLootOverrides(model));
  wrap.append(lootIdList(doc, 'Add', model.add, commit));
  wrap.append(lootIdList(doc, 'Remove', model.remove, commit));
  if (model.rest && Object.keys(model.rest).length) {
    wrap.append(hint(doc, `Preserving ${Object.keys(model.rest).length} other loot-override field(s) verbatim.`));
  }
  return wrap;
}

function lootIdList(doc, label, arr, commit) {
  const wrap = doc.createElement('div');
  wrap.className = 'e-loot-list';
  wrap.append(labelWithInfo(doc, label, label === 'Add'
    ? 'Loot ids force-added to drop tables.'
    : 'Loot ids removed from drop tables.'));
  const host = doc.createElement('div');
  const optsFor = (current) => {
    const ids = [...LOOT_ITEM_IDS];
    if (current && !ids.includes(current)) ids.unshift(current);
    return ids.map(id => ({ key: id, value: id }));
  };
  function render() {
    host.innerHTML = '';
    arr.forEach((id, i) => {
      const r = doc.createElement('div');
      r.className = 'e-row e-loot-row';
      const sel = select(doc, optsFor(id), id, v => { arr[i] = v; commit(); });
      sel.title = `Loot id to ${label.toLowerCase()}`;
      r.append(sel, smallBtn(doc, '✕', () => { arr.splice(i, 1); commit(); render(); }, 'Remove'));
      host.append(r);
    });
    host.append(actionBtn(doc, `+ ${label}`, () => {
      arr.push(LOOT_ITEM_IDS[0]); commit(); render();
    }, `${label} a loot id`));
  }
  wrap.append(host);
  render();
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
  const del = smallBtn(doc, '✕', onDelete, 'Remove this placement');
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
  if (up) row.append(smallBtn(doc, '▲', up, 'Move up'));
  if (down) row.append(smallBtn(doc, '▼', down, 'Move down'));
  if (remove) row.append(smallBtn(doc, '✕', remove, 'Delete'));
  return row;
}

function smallBtn(doc, text, onClick, title) {
  const b = doc.createElement('button');
  b.className = 'e-small';
  b.textContent = text;
  if (title) b.title = title; // item 2 — optional descriptive tooltip
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

// A form label. When a `tip` is supplied (explicitly, or auto-looked-up from
// FIELD_HELP by label text) the label gains both a `title=` tooltip AND a small
// "(i)" info affordance carrying the same text — so every field is discoverable
// (item 3). Pass `tip === false` to opt out of the auto-lookup (e.g. structural
// sub-labels like "type"/"params"/"list" that aren't user-facing fields).
function labelFor(doc, text, tip) {
  const resolved = tip === false ? null : (tip ?? FIELD_HELP[text] ?? null);
  return labelWithInfo(doc, text, resolved);
}

/**
 * Build a `<label>` carrying `text` plus, when `tip` is non-empty, a `title=`
 * tooltip on the label AND a trailing "(i)" info span (also tooltipped). Pure
 * DOM — exported so the help-helper coverage is unit-testable.
 */
export function labelWithInfo(doc, text, tip) {
  const l = doc.createElement('label');
  l.textContent = text;
  if (tip) {
    l.title = tip;
    const info = doc.createElement('span');
    info.className = 'e-info';
    info.textContent = 'ⓘ';
    info.title = tip;
    info.setAttribute('aria-label', tip);
    l.append(info);
  }
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

function actionBtn(doc, text, onClick, title) {
  const b = doc.createElement('button');
  b.className = 'e-action';
  b.textContent = text;
  if (title) b.title = title; // item 2 — optional descriptive tooltip
  b.addEventListener('click', onClick);
  return b;
}
