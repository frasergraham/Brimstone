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
// SEAMS for later phases:
//   • P6 (authoring forms + load/save): `handle.editor` exposes the controller
//     (getMapDef/setMapDef/getEnemyUnits/setEnemyUnits). A `#e-forms` slot is
//     left empty in the palette for the forms to mount into.
//   • P7 (3D preview): `handle.buildState()` returns the live GameState a
//     "Preview in 3D" button can hand to Renderer3D.
// ═══════════════════════════════════════════════════════════════════════════

import { Renderer } from '../renderer.js';
import { GameState } from '../game.js';
import { buildMissionMap } from '../campaign/mission-map.js';
import { TileType, BuildingType, ResourceType } from '../tiles.js';
import {
  createZombie, createMinion, createWoodGolem, createIronGolem,
} from '../entities.js';
import {
  createMissionEditor, EditorTool, ENEMY_UNIT_TYPES,
  addStoryTrigger, removeStoryTrigger, moveStoryTrigger,
  addWave, removeWave, populateFromMission,
} from './mission-editor.js';
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
 *             buildState: () => object }}
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

  // ── Click → hex edit loop ────────────────────────────────────────────────
  canvas.addEventListener('click', (ev) => {
    const rect = canvas.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const cx = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const cy = (ev.clientY - rect.top) * (canvas.height / rect.height);
    const hex = renderer.canvasToHex(cx, cy);
    editor.applyAt(hex);
  });

  buildPalette(doc, palette, editor, rerender);

  // Authoring forms + load/save mount into the #e-forms slot the palette left.
  // `rebuildForms` re-reads the model, so load can refresh the whole form tree.
  function rebuildForms() {
    const slot = doc.getElementById('e-forms');
    if (slot) buildForms(doc, slot, editor, rerender, rebuildForms);
  }
  rebuildForms();

  // First fit once layout settles.
  renderer.resize();
  renderer.draw();

  return {
    editor,
    buildState: () => buildState(editor),
    // 2D Renderer has no render loop — nothing to stop. Resume re-fits in case
    // the panel was hidden (zero-size) while inactive.
    pause() { /* no-op */ },
    resume() { renderer.resize(); renderer.draw(); },
  };
}

// ── Palette DOM ──────────────────────────────────────────────────────────────

function buildPalette(doc, root, editor, rerender) {
  root.innerHTML = '';

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

  // Edit actions.
  const editSection = section(doc, 'Edit');
  editSection.append(actionBtn(doc, 'Undo', () => editor.undo()));
  root.append(editSection);

  // Empty slot for P6 authoring forms to mount into.
  const forms = doc.createElement('div');
  forms.id = 'e-forms';
  root.append(forms);
}

// ══════════════════════════════════════════════════════════════════════════
// Authoring forms + load / save / validate  (P6)
// ─────────────────────────────────────────────────────────────────────────────
// Forms over the existing mission schema. Inputs mutate the LIVE meta object
// (editor.getMeta() returns a reference) for cheap text edits; list add/remove
// and load go through the controller and trigger a full form rebuild. Map-
// affecting edits (enemyUnits, survivor positions) also redraw the canvas.
// ══════════════════════════════════════════════════════════════════════════

function buildForms(doc, root, editor, rerenderCanvas, rebuild) {
  root.innerHTML = '';
  const meta = editor.getMeta();

  // ── File I/O (load / save / validate) ──────────────────────────────────
  const io = section(doc, 'Mission File');
  const status = doc.createElement('div');
  status.className = 'e-status';
  const setStatus = (msg, ok) => {
    status.textContent = msg || '';
    status.classList.toggle('err', !ok);
    status.classList.toggle('ok', !!ok && !!msg);
  };

  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.json,application/json';
  fileInput.className = 'e-file';
  fileInput.addEventListener('change', () => {
    const file = fileInput.files && fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        loadMissionJSON(parsed); // VALIDATE before touching the model
        editor.applyMission(populateFromMission(parsed));
        rebuild();
        rerenderCanvas();
        setStatus(`Loaded "${parsed.id}".`, true);
      } catch (err) {
        // Validation / parse failure: do NOT clobber the current model.
        setStatus(`Load failed: ${err.message}`, false);
      }
      fileInput.value = '';
    };
    reader.readAsText(file);
  });
  io.append(labelFor(doc, 'Load'), fileInput);

  io.append(actionBtn(doc, 'Validate + Download JSON', () => {
    const json = editor.assemble();
    try {
      loadMissionJSON(json); // block the download on any validation error
    } catch (err) {
      setStatus(`Cannot save: ${err.message}`, false);
      return;
    }
    downloadJSON(doc, json, `${json.id || 'mission'}.json`);
    setStatus(`Validated — downloaded ${json.id}.json`, true);
  }));
  io.append(status);
  root.append(io);

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
  root.append(props);

  // ── Briefing / texts ──────────────────────────────────────────────────────
  const text = section(doc, 'Narrative');
  text.append(
    textArea(doc, 'Briefing', meta.briefing, v => { meta.briefing = v; }),
    textArea(doc, 'Victory', meta.victoryText, v => { meta.victoryText = v; }),
    textArea(doc, 'Defeat', meta.defeatText, v => { meta.defeatText = v; }),
  );
  root.append(text);

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
  root.append(phase);

  // ── Resources / rewards / loot (JSON blobs) ─────────────────────────────
  const res = section(doc, 'Resources & Rewards');
  res.append(
    jsonRow(doc, 'Starting', meta.startingResources, v => { meta.startingResources = v; }, setStatus),
    jsonRow(doc, 'Rewards', meta.rewards, v => { meta.rewards = v; }, setStatus),
    jsonRow(doc, 'Loot Ovr', meta.lootOverrides, v => { meta.lootOverrides = v; }, setStatus),
  );
  root.append(res);

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
  root.append(obj);

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
  root.append(story);

  // ── Waves (list editor) ─────────────────────────────────────────────────
  const waves = section(doc, 'Waves');
  (meta.waves ?? []).forEach((w, i) => {
    waves.append(waveCard(doc, w, i, { remove: () => { removeWave(meta, i); rebuild(); } }, setStatus));
  });
  waves.append(actionBtn(doc, '+ Add Wave', () => { addWave(meta); rebuild(); }));
  root.append(waves);

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
  root.append(enemies);

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
  root.append(surv);
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
