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
import { TileType, BuildingType, ResourceType } from '../tiles.js';
import {
  createZombie, createMinion, createWoodGolem, createIronGolem,
} from '../entities.js';
import {
  createMissionEditor, createPreviewController, EditorTool, ENEMY_UNIT_TYPES,
  addStoryTrigger, removeStoryTrigger, moveStoryTrigger,
  addWave, removeWave, populateFromMission,
} from './mission-editor.js';
import { createTabController } from './tab-controller.js';
import { attachEditorCanvasControls } from './editor-canvas-input.js';
import { loadMissionJSON, KNOWN_OBJECTIVE_TYPES } from '../campaign/json-mission.js';
import { CONDITIONS } from '../campaign/condition-registry.js';

// Enum VALUE → KEY pairs for select option lists (KEY is what the model stores).
const _entries = (enumObj) => Object.keys(enumObj).map(k => ({ key: k, value: enumObj[k] }));

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

  // The controller drives the model; `render()` rebuilds + redraws.
  const editor = createMissionEditor({ render: rerender });

  const renderer = new Renderer(canvas, buildState(editor));
  renderer.loadImages('/assets');

  function rerender() {
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
      r.beginLoad();
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

  // Build the tabbed sidebar (Map / Mission / Events / Units). The Map tab is
  // static; the other three are (re)populated by rebuildForms() so a load can
  // refresh the whole authoring tree at once.
  const formStatus = (msg, ok) => sidebar.setStatus(msg, ok);
  const sidebar = buildSidebar(doc, palette, editor, rerender, openPreview, resetViewAndDraw);

  function rebuildForms() {
    buildForms(doc, sidebar.panes, editor, rerender, rebuildForms, formStatus);
  }
  rebuildForms();

  // ── Load / Save — relocated to the top File menu; flow is unchanged. ──────
  // Validate-before-populate on load; validate + block-download on save.
  function loadMissionFile(file) {
    return new Promise((resolve) => {
      if (!file) { resolve({ ok: false, message: 'No file selected.' }); return; }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(String(reader.result));
          loadMissionJSON(parsed); // VALIDATE before touching the model
          editor.applyMission(populateFromMission(parsed));
          rebuildForms();
          resetViewAndDraw();
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

  function saveMission() {
    const json = editor.assemble();
    try {
      loadMissionJSON(json); // block the download on any validation error
    } catch (err) {
      return { ok: false, message: `Cannot save: ${err.message}` };
    }
    downloadJSON(doc, json, `${json.id || 'mission'}.json`);
    return { ok: true, message: `Validated — downloaded ${json.id}.json` };
  }

  // First fit once layout settles.
  renderer.resize();
  renderer.draw();

  return {
    editor,
    buildState: () => buildState(editor),
    loadMissionFile,
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
// three form-pane containers (mission / events / units) that buildForms fills,
// and `setStatus` writes to the shared form-validation status line.
function buildSidebar(doc, root, editor, rerender, onPreview3D, onResetView) {
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

  // ── Map tab: paint/placement palette + view controls ────────────────────
  buildMapPalette(doc, paneEls.map, editor, rerender, onPreview3D, onResetView);

  stabs.activate('map');

  return {
    // The three authoring-form panes buildForms mounts into.
    panes: { mission: paneEls.mission, events: paneEls.events, units: paneEls.units },
    setStatus,
  };
}

// ── Map-tab palette DOM ───────────────────────────────────────────────────────

function buildMapPalette(doc, root, editor, rerender, onPreview3D, onResetView) {
  // Mode + seed.
  const modeSection = section(doc, 'Map');
  const modeRow = doc.createElement('div');
  modeRow.className = 'e-row';
  const modeSel = select(doc, [
    { key: 'handmade', value: 'handmade' },
    { key: 'procedural', value: 'procedural' },
  ], 'handmade', (v) => {
    editor.setMode(v, { seed: parseInt(seedInput.value, 10) || 12345 });
    seedRow.style.display = v === 'procedural' ? '' : 'none';
    regenBtn.textContent = v === 'procedural' ? 'Rebuild Map' : 'Regenerate Roads';
    onResetView?.(); // reframe — a mode switch can change map dimensions
  });
  modeRow.append(labelFor(doc, 'Mode'), modeSel);
  modeSection.append(modeRow);

  const seedRow = doc.createElement('div');
  seedRow.className = 'e-row';
  seedRow.style.display = 'none';
  const seedInput = doc.createElement('input');
  seedInput.type = 'number';
  seedInput.value = '12345';
  seedInput.addEventListener('change', () => editor.setSeed(parseInt(seedInput.value, 10) || 0));
  seedRow.append(labelFor(doc, 'Seed'), seedInput);
  modeSection.append(seedRow);

  const regenBtn = actionBtn(doc, 'Regenerate Roads', () => editor.regenerateRoads());
  modeSection.append(regenBtn);
  root.append(modeSection);

  // Tools.
  const toolSection = section(doc, 'Tools');
  const tools = [
    { id: EditorTool.PAINT_TILE, label: 'Paint Tile' },
    { id: EditorTool.SET_BUILDING, label: 'Set Building' },
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
  toolBtns[EditorTool.PAINT_TILE].classList.add('active');
  root.append(toolSection);

  // Paint-value selectors (which value the painting tools stamp).
  const valSection = section(doc, 'Paint Value');
  valSection.append(
    labeledSelect(doc, 'Tile', _entries(TileType), editor.getPaintValue('tile'),
      (v) => editor.setPaintValue('tile', v)),
    labeledSelect(doc, 'Building', _entries(BuildingType), editor.getPaintValue('building'),
      (v) => editor.setPaintValue('building', v)),
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
