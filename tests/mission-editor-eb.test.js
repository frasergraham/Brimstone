// Tests for the mission-editor FORMS + delete chunk (EB): items 3, 8, 9 plus the
// overlay-delete-revert fix.
//
//   • item 8 — Resources & Rewards picker: resource-map ↔ rows round-trip, and the
//     lootOverrides add/remove picker (preserving richer `rest` keys verbatim).
//   • item 9 — Phase-cycle icon ops: add / remove / reorder / loop ↔ phaseCycle shape.
//   • DELETE — overlay mode REVERTS (drops the overlay entry); handmade BLANKS.
//   • item 3 — help helper: FIELD_HELP coverage + labelWithInfo applies title + (i).
//
// DOM-free per CLAUDE.md, except the labelWithInfo help-helper check which uses a
// tiny fake `document` (no jsdom).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  // item 8
  resourceMapToRows, rowsToResourceMap,
  lootOverridesToPicker, pickerToLootOverrides,
  // item 9
  PHASE_KINDS, addPhase, removePhaseAt, movePhase, setPhaseLoop,
  // delete + round-trip
  deleteTile, paintBase, paintRoad,
  createMissionEditor, EditorTool,
  createDefaultMeta, assembleMission, populateFromMission,
} from '../src/tools/mission-editor.js';
import { labelWithInfo, FIELD_HELP } from '../src/tools/mission-editor-ui.js';

// ── item 8: resource-map picker round-trip ──────────────────────────────────
describe('resource map ↔ picker rows', () => {
  test('map → rows → map is lossless', () => {
    const obj = { food: 1, herbs: 2, silver: 3 };
    const rows = resourceMapToRows(obj);
    assert.deepEqual(rows, [
      { type: 'food', amount: 1 },
      { type: 'herbs', amount: 2 },
      { type: 'silver', amount: 3 },
    ]);
    assert.deepEqual(rowsToResourceMap(rows), obj);
  });

  test('empty map ↔ empty rows', () => {
    assert.deepEqual(resourceMapToRows({}), []);
    assert.deepEqual(resourceMapToRows(null), []);
    assert.deepEqual(rowsToResourceMap([]), {});
    assert.deepEqual(rowsToResourceMap(null), {});
  });

  test('rows assemble: skips typeless rows, coerces amounts, last-write wins', () => {
    const rows = [
      { type: '', amount: 9 },          // dropped (no type)
      { type: 'wood', amount: '4' },    // coerced to number
      { type: 'wood', amount: 7 },      // duplicate — later wins
    ];
    assert.deepEqual(rowsToResourceMap(rows), { wood: 7 });
  });

  test('survives a full assemble/populate round-trip on meta', () => {
    const meta = createDefaultMeta();
    meta.startingResources = rowsToResourceMap([{ type: 'food', amount: 2 }]);
    meta.rewards = rowsToResourceMap([{ type: 'metal', amount: 1 }]);
    const mission = assembleMission({ meta, mapDef: { mode: 'handmade', cols: 5, rows: 5, tiles: [] }, enemyUnits: [] });
    const back = populateFromMission(mission);
    assert.deepEqual(back.meta.startingResources, { food: 2 });
    assert.deepEqual(back.meta.rewards, { metal: 1 });
  });
});

// ── item 8: lootOverrides picker round-trip ─────────────────────────────────
describe('lootOverrides ↔ picker model', () => {
  test('remove-only shape round-trips without gaining an empty add', () => {
    const lo = { remove: ['horse'] };
    const model = lootOverridesToPicker(lo);
    assert.deepEqual(model, { add: [], remove: ['horse'], rest: {} });
    assert.deepEqual(pickerToLootOverrides(model), { remove: ['horse'] });
  });

  test('preserves richer rest keys (per-building tables) verbatim', () => {
    const lo = { remove: ['horse'], buildings: { barn: [{ type: 'wood', weight: 60 }] } };
    const model = lootOverridesToPicker(lo);
    assert.deepEqual(model.rest, { buildings: { barn: [{ type: 'wood', weight: 60 }] } });
    assert.deepEqual(pickerToLootOverrides(model), lo);
  });

  test('add + remove both populated', () => {
    const lo = { add: ['silver'], remove: ['horse', 'nothing'] };
    assert.deepEqual(pickerToLootOverrides(lootOverridesToPicker(lo)), lo);
  });

  test('null ↔ empty picker model', () => {
    assert.deepEqual(lootOverridesToPicker(null), { add: [], remove: [], rest: {} });
    assert.equal(pickerToLootOverrides({ add: [], remove: [], rest: {} }), null);
    assert.equal(pickerToLootOverrides(), null);
  });
});

// ── item 9: phase-cycle icon ops ────────────────────────────────────────────
describe('phase-cycle ops ↔ phaseCycle shape', () => {
  test('PHASE_KINDS are the four canonical phases', () => {
    assert.deepEqual([...PHASE_KINDS], ['dawn', 'day', 'dusk', 'night']);
  });

  test('add appends valid phases and ignores unknown keys', () => {
    const meta = { phaseCycle: { phases: [], loop: true } };
    addPhase(meta, 'dawn');
    addPhase(meta, 'night');
    addPhase(meta, 'noon'); // not a canonical phase — ignored
    assert.deepEqual(meta.phaseCycle.phases, ['dawn', 'night']);
  });

  test('add lazily creates a phaseCycle when missing', () => {
    const meta = {};
    addPhase(meta, 'day');
    assert.deepEqual(meta.phaseCycle, { phases: ['day'], loop: true });
  });

  test('remove drops the chip at index; out-of-range is a no-op', () => {
    const meta = { phaseCycle: { phases: ['dawn', 'day', 'dusk'], loop: true } };
    removePhaseAt(meta, 1);
    assert.deepEqual(meta.phaseCycle.phases, ['dawn', 'dusk']);
    removePhaseAt(meta, 9);
    assert.deepEqual(meta.phaseCycle.phases, ['dawn', 'dusk']);
  });

  test('move reorders by direction; edges are no-ops', () => {
    const meta = { phaseCycle: { phases: ['dawn', 'day', 'dusk'], loop: true } };
    movePhase(meta, 0, 1); // dawn → right
    assert.deepEqual(meta.phaseCycle.phases, ['day', 'dawn', 'dusk']);
    movePhase(meta, 0, -1); // already first — no-op
    assert.deepEqual(meta.phaseCycle.phases, ['day', 'dawn', 'dusk']);
    movePhase(meta, 2, 1); // already last — no-op
    assert.deepEqual(meta.phaseCycle.phases, ['day', 'dawn', 'dusk']);
  });

  test('setPhaseLoop toggles the loop flag', () => {
    const meta = { phaseCycle: { phases: ['dawn'], loop: true } };
    setPhaseLoop(meta, false);
    assert.equal(meta.phaseCycle.loop, false);
    setPhaseLoop(meta, true);
    assert.equal(meta.phaseCycle.loop, true);
  });
});

// ── DELETE: overlay reverts, handmade blanks ────────────────────────────────
describe('deleteTile mode-aware semantics', () => {
  test('OVERLAY: deleting an overlay-edited hex removes it from overlay.tiles (reverts to generated)', () => {
    const mapDef = { mode: 'procedural', seed: 1, mapSize: 'standard', overlay: { tiles: [] } };
    paintBase(mapDef, { col: 3, row: 4 }, 'DIRT'); // creates an explicit overlay edit
    assert.equal(mapDef.overlay.tiles.length, 1);
    deleteTile(mapDef, { col: 3, row: 4 });
    assert.equal(mapDef.overlay.tiles.length, 0, 'overlay entry removed → falls back to generated base');
  });

  test('OVERLAY: deleting a NON-edited hex leaves no overlay entry (no-op)', () => {
    const mapDef = { mode: 'procedural', seed: 1, mapSize: 'standard', overlay: { tiles: [] } };
    deleteTile(mapDef, { col: 1, row: 1 });
    assert.equal(mapDef.overlay.tiles.length, 0, 'never writes a blank def into overlay.tiles');
  });

  test('OVERLAY: deleting unwires the reverted hex from painted-road neighbours', () => {
    const mapDef = { mode: 'procedural', seed: 1, mapSize: 'standard', overlay: { tiles: [] } };
    paintRoad(mapDef, { col: 2, row: 2 });
    paintRoad(mapDef, { col: 3, row: 2 }); // adjacent — wires to (2,2)
    const before = mapDef.overlay.tiles.find(t => t.col === 3 && t.row === 2);
    assert.ok(before.roadDirs.includes('2,2'), 'neighbour wired to the soon-deleted hex');
    deleteTile(mapDef, { col: 2, row: 2 });
    const after = mapDef.overlay.tiles.find(t => t.col === 3 && t.row === 2);
    assert.ok(!after.roadDirs.includes('2,2'), 'neighbour unwired from the reverted hex');
    assert.ok(!mapDef.overlay.tiles.some(t => t.col === 2 && t.row === 2), 'deleted hex dropped from overlay');
  });

  test('HANDMADE: delete blanks the tile def (no generated base to revert to)', () => {
    const mapDef = { mode: 'handmade', cols: 9, rows: 9, tiles: [] };
    paintBase(mapDef, { col: 4, row: 4 }, 'FOREST');
    deleteTile(mapDef, { col: 4, row: 4 });
    const def = mapDef.tiles.find(t => t.col === 4 && t.row === 4);
    assert.ok(def, 'handmade keeps an explicit blank def');
    assert.equal(def.base, 'GRASS');
    assert.equal(def.structure, null);
    assert.deepEqual(def.roadDirs, []);
  });

  test('DELETE via the controller is a single undo step', () => {
    const editor = createMissionEditor();
    // Force overlay mode with an edited hex.
    editor.setMapDef({ mode: 'procedural', seed: 1, mapSize: 'standard',
      overlay: { tiles: [{ col: 2, row: 2, base: 'DIRT', structure: null, path: null,
        building: null, fortifyLevel: 0, resource: null, hiddenSurvivor: false, roadDirs: [] }] } });
    editor.setActiveTool(EditorTool.DELETE);
    editor.applyAt({ col: 2, row: 2 });
    assert.equal(editor.getMapDef().overlay.tiles.length, 0, 'delete reverted the hex');
    editor.undo();
    assert.equal(editor.getMapDef().overlay.tiles.length, 1, 'one undo restores the overlay edit');
  });
});

// ── item 3: help helper ─────────────────────────────────────────────────────
function makeEl(tag) {
  const el = {
    tag, children: [], className: '', title: '', textContent: '', _attrs: {},
    setAttribute(k, v) { el._attrs[k] = v; },
    append(...kids) { el.children.push(...kids); },
  };
  return el;
}
const fakeDoc = { createElement: (tag) => makeEl(tag) };

describe('field help helper (item 3)', () => {
  test('labelWithInfo with a tip sets title + appends a tooltipped (i) span', () => {
    const lbl = labelWithInfo(fakeDoc, 'Chapter', FIELD_HELP['Chapter']);
    assert.equal(lbl.textContent, 'Chapter');
    assert.equal(lbl.title, FIELD_HELP['Chapter']);
    const info = lbl.children.find(c => c.className === 'e-info');
    assert.ok(info, 'an (i) affordance is appended');
    assert.equal(info.title, FIELD_HELP['Chapter']);
    assert.equal(info._attrs['aria-label'], FIELD_HELP['Chapter']);
  });

  test('labelWithInfo without a tip omits the (i) span and title', () => {
    const lbl = labelWithInfo(fakeDoc, 'Bare', null);
    assert.equal(lbl.title, '');
    assert.equal(lbl.children.length, 0);
  });

  test('FIELD_HELP covers the logic-bearing Properties / Events fields', () => {
    for (const key of ['ID', 'Title', 'Chapter', 'Has Witch', 'No Scoring',
      'AI Persona', 'AI Budget+', 'Heal Bonus', 'Loop', 'Briefing', 'Victory',
      'Defeat', 'Win', 'Lose', 'Condition', 'Trigger']) {
      assert.ok(FIELD_HELP[key] && FIELD_HELP[key].length > 0, `help for "${key}"`);
    }
  });
});
