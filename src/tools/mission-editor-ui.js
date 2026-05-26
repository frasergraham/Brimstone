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
import { TileType, BuildingType, ResourceType, PathType } from '../tiles.js';
import {
  createZombie, createMinion, createWoodGolem, createIronGolem,
} from '../entities.js';
import {
  createMissionEditor, createPreviewController, EditorTool, ENEMY_UNIT_TYPES,
  addStoryTrigger, removeStoryTrigger, moveStoryTrigger,
  addWave, removeWave, populateFromMission, CreationMode, MAP_EDGES,
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

// Build a live GameState the 2D Renderer can draw from the current model. The
// hero/witch leaders the GameState constructor places double as start markers;
// enemy units are injected as entities for visual feedback. Editor view always
// runs fog-free.
function buildState(editor) {
  const mapDef = editor.getMapDef();
  const built = buildMissionMap(mapDef);
  const state = new GameState(false, false, built.mapSize, null, {
    ...built,
    heroStart: built.heroStart ?? { col: 0, row: 0 },
    witchStart: built.witchStart ?? { col: 0, row: 0 },
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

  // Unsaved-work flag — set on any model change, cleared by load / New / save.
  // Only gates the New… confirm prompt, so a coarse flag is plenty.
  let dirty = false;

  // The controller drives the model; `render()` rebuilds + redraws.
  const editor = createMissionEditor({ render: rerender });

  const renderer = new Renderer(canvas, buildState(editor));
  renderer.loadImages(ASSET_BASE);

  function rerender() {
    dirty = true;
    // Cheap full rebuild — editor maps are small. Reassigning state keeps the
    // Renderer instance, so zoom/pan persist across edits.
    renderer.state = buildState(editor);
    renderer.resize();
    renderer.draw();
  }

  // Recenter + reset zoom, then redraw. Used by the Reset View button and
  // whenever the map dimensions change (mode / map-size switch) so the new map
  // is reframed instead of left half-off-screen under the old pan.
  function resetViewAndDraw() {
    renderer.resize();          // recompute hexSize for the (possibly new) map
    renderer.resetView();       // zoom → 1, pan centered on the visible area
    renderer._clampPan();
    renderer.draw();
  }

  // ── Pan / zoom / paint (reuses the in-game Renderer transform) ────────────
  attachEditorCanvasControls(canvas, renderer, {
    onPaint: (hex) => editor.applyAt(hex),
    onRedraw: () => renderer.draw(),
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
    });
  }
  rebuildMapPalette();
  rebuildForms();

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
    dirty = false; // a freshly-loaded mission starts clean
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
    dirty = false;
    return { ok: true, message: `Validated — downloaded ${json.id}.json` };
  }

  // ── New… — the creation flow (item 4). Pick a LOCKED mode + size, confirm if
  // there's unsaved work, then install the freshly-created map. ──────────────
  function newMission() {
    if (dirty && !(doc.defaultView ?? globalThis).confirm?.('Discard the current mission and start a new one?')) {
      return { ok: false, message: 'New mission cancelled.' };
    }
    openCreationDialog(doc, (opts) => {
      editor.createNew(opts);
      rebuildMapPalette();
      rebuildForms();
      resetViewAndDraw();
      dirty = false; // a fresh mission starts clean
    });
    return { ok: true, message: '' };
  }

  // First fit once layout settles.
  renderer.resize();
  renderer.draw();

  return {
    editor,
    buildState: () => buildState(editor),
    newMission,
    loadMissionFile,
    loadMissionById,
    saveMission,
    // 2D Renderer has no render loop. But the 3D preview owns a live Babylon
    // engine; tear it down (and hide the overlay) when the tab is switched away
    // so a hidden tab never leaves an engine spinning.
    pause() { closePreview(); },
    resume() { renderer.resize(); renderer.draw(); },
  };
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
    // All four panes: `map` (paint/size palette) + the three authoring panes.
    panes: {
      map: paneEls.map,
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

  // Tools.
  const toolSection = section(doc, 'Tools');
  const tools = [
    { id: EditorTool.PAINT_BASE, label: 'Paint Base' },
    { id: EditorTool.PAINT_STRUCTURE, label: 'Paint Structure' },
    { id: EditorTool.PAINT_PATH, label: 'Paint Path' },
    { id: EditorTool.SET_RESOURCE, label: 'Set Resource' },
    { id: EditorTool.HIDDEN_SURVIVOR, label: 'Hidden Survivor' },
    { id: EditorTool.ENEMY_UNIT, label: 'Enemy Unit' },
    { id: EditorTool.HERO_START, label: 'Hero Start' },
    { id: EditorTool.WITCH_START, label: 'Witch Start' },
    { id: EditorTool.ROAD_NODE, label: 'Mark Road Node' },
    { id: EditorTool.POWER_NODE, label: 'Power Node' },
  ];
  const toolBtns = {};
  for (const t of tools) {
    const btn = doc.createElement('button');
    btn.className = 'e-tool';
    btn.textContent = t.label;
    btn.addEventListener('click', () => {
      editor.setActiveTool(t.id);
      for (const b of Object.values(toolBtns)) b.classList.remove('active');
      btn.classList.add('active');
    });
    toolBtns[t.id] = btn;
    toolSection.append(btn);
  }
  // Highlight the controller's current tool (persists across palette rebuilds).
  (toolBtns[editor.activeTool] ?? toolBtns[EditorTool.PAINT_BASE]).classList.add('active');
  root.append(toolSection);

  // Paint-value selectors (which value the painting tools stamp). The three
  // layer tools each have their own selector: Base (grass/forest/dirt),
  // Structure (a building or "None" to clear), Path (none/road/river/bridge).
  // Structure & Path use a "None" sentinel option → stored as null (clear).
  const NONE_OPT = { key: 'None', value: null };
  const denull = (v) => (v === NONE_OPT.key ? null : v);
  const valSection = section(doc, 'Paint Value');
  valSection.append(
    labeledSelect(doc, 'Base', BASE_ENTRIES, editor.getPaintValue('base'),
      (v) => editor.setPaintValue('base', v)),
    labeledSelect(doc, 'Structure', [NONE_OPT, ..._entries(BuildingType)],
      editor.getPaintValue('structure') ?? NONE_OPT.key,
      (v) => editor.setPaintValue('structure', denull(v))),
    labeledSelect(doc, 'Path', [NONE_OPT, ..._entries(PathType)],
      editor.getPaintValue('path') ?? NONE_OPT.key,
      (v) => editor.setPaintValue('path', denull(v))),
    labeledSelect(doc, 'Resource', _entries(ResourceType), editor.getPaintValue('resource'),
      (v) => editor.setPaintValue('resource', v)),
    labeledSelect(doc, 'Enemy', ENEMY_UNIT_TYPES.map(t => ({ key: t, value: t })),
      editor.getPaintValue('enemyType'), (v) => editor.setPaintValue('enemyType', v)),
  );
  root.append(valSection);

  // Edit + view actions.
  const editSection = section(doc, 'Edit');
  editSection.append(actionBtn(doc, 'Undo', () => editor.undo()));
  if (onResetView) editSection.append(actionBtn(doc, 'Reset View', () => onResetView()));
  root.append(editSection);

  // Preview — rebuilds the current mission map in 3D via Renderer3D.
  if (onPreview3D) {
    const previewSection = section(doc, 'Preview');
    previewSection.append(actionBtn(doc, 'Preview in 3D', () => onPreview3D()));
    root.append(previewSection);
  }
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
