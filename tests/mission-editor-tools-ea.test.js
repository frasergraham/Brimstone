// Tests for the EA editor chunk (operator items 2, 4, 5, 6):
//   • Item 2 — Paint Path split into TWO single-kind tools: Road (path=ROAD +
//     roadDirs wiring) and River (path=RIVER). Each paints exactly its kind; the
//     combined path-value selector is gone.
//   • Item 4 — River fork TOPOLOGY: a river must stay a branching TREE. A paint
//     that would close a cycle or merge two separate branches is BLOCKED; a valid
//     fork (only the fork hex has >2 connections) + ordinary 2-entry flow pass.
//   • Item 5 — area-event LAYER: story triggers carrying a `hexes` array light up
//     those hexes; the toggle lives in the layer-visibility model.
//   • Item 6 — the "Base only" layer toggle is removed entirely.
//
// DOM-free per CLAUDE.md: exercises the pure model functions + the controller's
// edit loop / undo via an injected render callback.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EditorTool,
  createMissionEditor,
  createBlankMapDef,
  paintRoad,
  paintRiver,
  validateRiverAddition,
  createLayerVisibility,
  areaTriggerLayerVisible,
  areaTriggerHexKeys,
  ToolValueKind,
  valuePanelKind,
} from '../src/tools/mission-editor.js';
import { hexKey, getNeighbors } from '../src/hex.js';

// ── ITEM 2 — Road / River are two separate single-kind tools ──────────────────

describe('mission-editor — split Road / River tools (item 2)', () => {
  test('paintRoad sets path=ROAD and wires roadDirs to adjacent roads', () => {
    const map = createBlankMapDef(13, 13);
    paintRoad(map, { col: 1, row: 0 });
    paintRoad(map, { col: 2, row: 0 });
    const a = map.tiles.find(t => t.col === 1 && t.row === 0);
    const b = map.tiles.find(t => t.col === 2 && t.row === 0);
    assert.equal(a.path, 'ROAD');
    assert.equal(b.path, 'ROAD');
    assert.deepEqual(a.roadDirs, [hexKey(2, 0)]);
    assert.deepEqual(b.roadDirs, [hexKey(1, 0)]);
  });

  test('paintRiver sets path=RIVER (no road wiring)', () => {
    const map = createBlankMapDef(13, 13);
    const res = paintRiver(map, { col: 5, row: 5 });
    assert.deepEqual(res, { ok: true, warning: '' });
    const def = map.tiles.find(t => t.col === 5 && t.row === 5);
    assert.equal(def.path, 'RIVER');
    assert.deepEqual(def.roadDirs, [], 'rivers never wire roadDirs');
    assert.equal(def.base, 'GRASS', 'path-only edit leaves the base');
  });

  test('neither tool exposes a value selector (combined path picker removed)', () => {
    assert.equal(valuePanelKind(EditorTool.PAINT_ROAD), ToolValueKind.NONE);
    assert.equal(valuePanelKind(EditorTool.PAINT_RIVER), ToolValueKind.NONE);
    assert.ok(!('PATH' in ToolValueKind), 'PATH value kind removed');
    assert.ok(!('PAINT_PATH' in EditorTool), 'combined Paint Path tool removed');
  });

  test('controller dispatches PAINT_ROAD and PAINT_RIVER to the right path', () => {
    const ed = createMissionEditor({ render: () => {} });
    ed.setActiveTool(EditorTool.PAINT_ROAD);
    ed.applyAt({ col: 1, row: 1 });
    ed.setActiveTool(EditorTool.PAINT_RIVER);
    ed.applyAt({ col: 4, row: 4 });
    const road = ed.getMapDef().tiles.find(t => t.col === 1 && t.row === 1);
    const river = ed.getMapDef().tiles.find(t => t.col === 4 && t.row === 4);
    assert.equal(road.path, 'ROAD');
    assert.equal(river.path, 'RIVER');
  });
});

// ── ITEM 4 — River tree topology ──────────────────────────────────────────────

describe('mission-editor — river tree-topology validator (item 4)', () => {
  test('an isolated first hex (no river-neighbours) is allowed', () => {
    assert.deepEqual(validateRiverAddition(new Set(), { col: 2, row: 2 }),
      { ok: true, reason: '' });
  });

  test('extending a branch (1 river-neighbour) is allowed — ordinary flow', () => {
    const rivers = new Set([hexKey(0, 0), hexKey(1, 0)]);
    // (2,0) is adjacent only to (1,0) among the rivers → a 2-entry flow segment.
    const res = validateRiverAddition(rivers, { col: 2, row: 0 });
    assert.equal(res.ok, true);
  });

  test('closing a cycle (2 neighbours in the SAME component) is BLOCKED', () => {
    // (0,0),(1,0) are one river; (0,1) is adjacent to BOTH → would close a loop.
    const rivers = new Set([hexKey(0, 0), hexKey(1, 0)]);
    const res = validateRiverAddition(rivers, { col: 0, row: 1 });
    assert.equal(res.ok, false);
    assert.match(res.reason, /cycle|loop/i);
  });

  test('merging two SEPARATE rivers (neighbours in distinct comps) is BLOCKED', () => {
    // (0,0) and (2,0) are two unconnected rivers; (1,0) bridges them.
    const rivers = new Set([hexKey(0, 0), hexKey(2, 0)]);
    const res = validateRiverAddition(rivers, { col: 1, row: 0 });
    assert.equal(res.ok, false);
    assert.match(res.reason, /merge|rejoin|branch/i);
  });

  test('a valid fork — built one branch at a time — where only the fork hex has 3 entries', () => {
    const map = createBlankMapDef(13, 13);
    // Trunk hub at (2,2); three branch tips each adjacent ONLY to (2,2).
    assert.equal(paintRiver(map, { col: 2, row: 2 }).ok, true);
    assert.equal(paintRiver(map, { col: 2, row: 1 }).ok, true);
    assert.equal(paintRiver(map, { col: 2, row: 3 }).ok, true);
    assert.equal(paintRiver(map, { col: 1, row: 2 }).ok, true);

    // Count each river hex's river-neighbour connections.
    const riverKeys = new Set(map.tiles.filter(t => t.path === 'RIVER')
      .map(t => hexKey(t.col, t.row)));
    const connOf = (col, row) =>
      getNeighbors(col, row).filter(nb => riverKeys.has(hexKey(nb.col, nb.row))).length;
    // The fork hub has 3 river connections; every branch tip has exactly 1.
    assert.equal(connOf(2, 2), 3, 'fork hub has 3 connections');
    for (const [c, r] of [[2, 1], [2, 3], [1, 2]]) {
      assert.ok(connOf(c, r) <= 1, `branch tip (${c},${r}) has ≤1 connection`);
    }
  });

  test('paintRiver blocks a cycle and leaves the model untouched', () => {
    const map = createBlankMapDef(13, 13);
    paintRiver(map, { col: 0, row: 0 });
    paintRiver(map, { col: 1, row: 0 });
    const before = JSON.stringify(map);
    const res = paintRiver(map, { col: 0, row: 1 }); // would close a triangle
    assert.equal(res.ok, false);
    assert.ok(res.warning);
    assert.equal(JSON.stringify(map), before, 'blocked paint mutates nothing');
  });

  test('controller applyAt surfaces a blocked river paint and keeps history clean', () => {
    const ed = createMissionEditor({ render: () => {} });
    ed.setActiveTool(EditorTool.PAINT_RIVER);
    ed.applyAt({ col: 0, row: 0 });
    ed.applyAt({ col: 1, row: 0 });
    const undosBefore = ed.canUndo();
    const tilesBefore = JSON.stringify(ed.getMapDef().tiles);
    const res = ed.applyAt({ col: 0, row: 1 }); // cycle → blocked
    assert.equal(res.ok, false);
    assert.ok(res.warning);
    assert.equal(JSON.stringify(ed.getMapDef().tiles), tilesBefore,
      'a blocked edit leaves the model untouched');
    assert.equal(ed.canUndo(), undosBefore, 'no extra undo step pushed');
  });

  test('re-painting an existing river hex is a no-op-allow (no false cycle)', () => {
    const rivers = new Set([hexKey(0, 0), hexKey(1, 0), hexKey(0, 1)]);
    // (0,1) is already a river — re-validating it must not flag the loop.
    assert.equal(validateRiverAddition(rivers, { col: 0, row: 1 }).ok, true);
  });
});

// ── ITEM 5 — area-event layer ─────────────────────────────────────────────────

describe('mission-editor — area-event layer (item 5)', () => {
  test('areaTriggerHexKeys flags exactly the hexes of triggers with a hexes[] array', () => {
    const meta = {
      storyTriggers: [
        { type: 'round', round: 3, title: 'Dawn' },                       // no hexes
        { type: 'area', hexes: [{ col: 1, row: 1 }, { col: 2, row: 1 }] }, // 2 hexes
        { type: 'area', hexes: [{ col: 5, row: 5 }] },                     // 1 hex
        { type: 'area', hexes: [] },                                        // empty
      ],
    };
    const keys = areaTriggerHexKeys(meta);
    assert.equal(keys.size, 3);
    assert.ok(keys.has(hexKey(1, 1)));
    assert.ok(keys.has(hexKey(2, 1)));
    assert.ok(keys.has(hexKey(5, 5)));
  });

  test('areaTriggerHexKeys is empty for missing / round-only triggers', () => {
    assert.equal(areaTriggerHexKeys(null).size, 0);
    assert.equal(areaTriggerHexKeys({}).size, 0);
    assert.equal(areaTriggerHexKeys({ storyTriggers: [{ type: 'round', round: 1 }] }).size, 0);
  });

  test('the area-event layer toggle defaults off and gates the overlay', () => {
    const layers = createLayerVisibility();
    assert.equal(layers.areaTriggers, false);
    assert.equal(areaTriggerLayerVisible(layers), false);
    layers.areaTriggers = true;
    assert.equal(areaTriggerLayerVisible(layers), true);
  });
});

// ── ITEM 6 — "Base only" toggle removed ───────────────────────────────────────

describe('mission-editor — Base-only toggle removed (item 6)', () => {
  test('createLayerVisibility no longer carries a baseOnly field', () => {
    const layers = createLayerVisibility();
    assert.ok(!('baseOnly' in layers), 'baseOnly removed from the visibility model');
  });
});
