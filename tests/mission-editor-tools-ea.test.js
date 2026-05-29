// Tests for the EA editor chunk (operator items 2, 4, 5, 6):
//   • Item 2 — Paint Path split into TWO single-kind tools: Road (path=ROAD +
//     roadDirs wiring) and River (path=RIVER). Each paints exactly its kind; the
//     combined path-value selector is gone.
//   • Item 4 — River placement is UNCONDITIONAL: no topology gate. A river tile
//     can sit on any hex regardless of connectivity/forking (the old tree-topology
//     check was removed so disjoint river pieces can be connected by hand).
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
  createLayerVisibility,
  areaTriggerLayerVisible,
  areaTriggerHexKeys,
  ToolValueKind,
  valuePanelKind,
} from '../src/tools/mission-editor.js';
import { hexKey } from '../src/hex.js';

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

// ── ITEM 4 — River placement is unconditional (topology gate removed) ─────────

describe('mission-editor — unconditional river placement (item 4)', () => {
  test('an isolated river hex paints fine (no neighbour required)', () => {
    const map = createBlankMapDef(13, 13);
    const res = paintRiver(map, { col: 2, row: 2 });
    assert.deepEqual(res, { ok: true, warning: '' });
    assert.ok(map.tiles.some(t => t.col === 2 && t.row === 2 && t.path === 'RIVER'));
  });

  test('closing a cycle is now ALLOWED — a river can loop back', () => {
    const map = createBlankMapDef(13, 13);
    paintRiver(map, { col: 0, row: 0 });
    paintRiver(map, { col: 1, row: 0 });
    // (0,1) is adjacent to BOTH → would have closed a loop under the old gate.
    const res = paintRiver(map, { col: 0, row: 1 });
    assert.equal(res.ok, true);
    assert.ok(map.tiles.some(t => t.col === 0 && t.row === 1 && t.path === 'RIVER'));
  });

  test('connecting two disjoint river pieces is now ALLOWED', () => {
    const map = createBlankMapDef(13, 13);
    paintRiver(map, { col: 0, row: 0 });
    paintRiver(map, { col: 2, row: 0 });
    // (1,0) bridges two separate rivers → was BLOCKED, now allowed.
    const res = paintRiver(map, { col: 1, row: 0 });
    assert.equal(res.ok, true);
    assert.ok(map.tiles.some(t => t.col === 1 && t.row === 0 && t.path === 'RIVER'));
  });

  test('controller applyAt paints river unconditionally and records history', () => {
    const ed = createMissionEditor({ render: () => {} });
    ed.setActiveTool(EditorTool.PAINT_RIVER);
    ed.applyAt({ col: 0, row: 0 });
    ed.applyAt({ col: 1, row: 0 });
    const res = ed.applyAt({ col: 0, row: 1 }); // cycle → now allowed
    assert.equal(res.ok, true);
    assert.ok(ed.getMapDef().tiles.some(t => t.col === 0 && t.row === 1 && t.path === 'RIVER'));
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
