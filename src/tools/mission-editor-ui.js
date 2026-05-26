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
} from './mission-editor.js';

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
