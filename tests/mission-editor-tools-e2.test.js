// Tests for the E2 editor tool/model additions (operator items 5–9):
//   • DELETE tool: handmade clears a tile back to blank base; overlay REVERTS to
//     the generated tile (drops the overlay entry); one undo step.
//   • Power-Node CLUSTERING: contiguous hexes group into one objective, a 5-hex
//     cap blocks a 6th, each cluster gets a name + palette colour, clusters map
//     to the runtime witchObjectives shape, clusters recompute on add/remove,
//     rename works.
//   • Paint-Path ROAD wires up roadDirs so the road renders; BRIDGE removed from
//     the authorable path options.
//   • Road-node toggle AUTO-regenerates the handmade road network (no manual
//     "Regenerate Roads" click).
//   • Overlay "darken auto-generated" layer flags non-overlay (generated) tiles
//     and is hidden for handmade maps.
//
// DOM-free per CLAUDE.md: exercises the pure model functions + the controller's
// edit loop / undo via an injected render callback.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EditorTool,
  createMissionEditor,
  createBlankMapDef,
  createOverlayMapDef,
  paintBase,
  paintStructure,
  paintPath,
  toggleHiddenSurvivor,
  setResource,
  deleteTile,
  togglePowerNode,
  renamePowerNode,
  toggleRoadNode,
  MAX_NODE_CLUSTER,
  PATH_TOOL_OPTIONS,
  createLayerVisibility,
  overlayDarkenVisible,
  overlayEditedKeys,
} from '../src/tools/mission-editor.js';
import { buildMissionMap } from '../src/campaign/mission-map.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { NODE_COLORS } from '../src/map.js';
import { pathOf, PathType } from '../src/tiles.js';

// ── ITEM 5 — DELETE tool ──────────────────────────────────────────────────────

describe('mission-editor — DELETE tool (item 5)', () => {
  test('clears every authored layer back to a blank base def', () => {
    const map = createBlankMapDef();
    paintStructure(map, { col: 2, row: 2 }, 'INN');   // base→DIRT + building
    paintPath(map, { col: 2, row: 2 }, 'ROAD');
    setResource(map, { col: 2, row: 2 }, 'SILVER');
    toggleHiddenSurvivor(map, { col: 2, row: 2 });
    deleteTile(map, { col: 2, row: 2 });
    const def = map.tiles.find(t => t.col === 2 && t.row === 2);
    assert.equal(def.base, 'GRASS');
    assert.equal(def.structure, null);
    assert.equal(def.path, null);
    assert.equal(def.building, null);
    assert.equal(def.resource, null);
    assert.equal(def.hiddenSurvivor, false);
    assert.equal(def.fortifyLevel, 0);
    assert.deepEqual(def.roadDirs, []);
  });

  test('OVERLAY mode REVERTS an edited tile to the generated base (drops the overlay entry)', () => {
    const map = createOverlayMapDef({ seed: 7, mapSize: 'skirmish' });
    // First make an explicit overlay edit, then delete it.
    paintBase(map, { col: 3, row: 3 }, 'DIRT');
    assert.ok(overlayEditedKeys(map).has(hexKey(3, 3)), 'edit recorded in overlay.tiles');
    deleteTile(map, { col: 3, row: 3 });
    assert.ok(!map.overlay.tiles.some(t => t.col === 3 && t.row === 3),
      'overlay entry removed → buildMissionMap falls back to the generated tile');
    assert.ok(!overlayEditedKeys(map).has(hexKey(3, 3)), 'no longer in the overlay-edited set');
  });

  test('OVERLAY mode delete on a NON-edited hex never writes a blank overlay entry', () => {
    const map = createOverlayMapDef({ seed: 7, mapSize: 'skirmish' });
    deleteTile(map, { col: 4, row: 4 });
    assert.ok(!map.overlay.tiles.some(t => t.col === 4 && t.row === 4),
      'no blank def written — the generated base is preserved');
  });

  test('DELETE unwires a painted-road neighbour so no segment dangles in', () => {
    const map = createBlankMapDef();
    paintPath(map, { col: 1, row: 0 }, 'ROAD');
    paintPath(map, { col: 2, row: 0 }, 'ROAD'); // adjacent → mutual roadDirs
    const a = () => map.tiles.find(t => t.col === 1 && t.row === 0);
    assert.deepEqual(a().roadDirs, [hexKey(2, 0)]);
    deleteTile(map, { col: 2, row: 0 });
    assert.deepEqual(a().roadDirs, [], 'neighbour no longer points at the deleted road');
  });

  test('DELETE via the controller is one undo step', () => {
    let renders = 0;
    const ed = createMissionEditor({ render: () => { renders++; } });
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'CHURCH');
    ed.applyAt({ col: 1, row: 1 });
    ed.setActiveTool(EditorTool.DELETE);
    ed.applyAt({ col: 1, row: 1 });
    let def = ed.getMapDef().tiles.find(t => t.col === 1 && t.row === 1);
    assert.equal(def.building, null);
    assert.ok(ed.undo(), 'one undo reverses the delete');
    def = ed.getMapDef().tiles.find(t => t.col === 1 && t.row === 1);
    assert.equal(def.building, 'CHURCH', 'building restored by a single undo');
  });
});

// ── ITEM 6 — Power-Node clustering ────────────────────────────────────────────

describe('mission-editor — Power-Node clustering (item 6)', () => {
  test('contiguous hexes group into ONE objective; non-contiguous stay separate', () => {
    const map = createBlankMapDef(13, 13);
    // (0,0) and (1,0) are hex-adjacent (same row); (5,5) is far away.
    assert.ok(getNeighbors(0, 0).some(n => n.col === 1 && n.row === 0));
    togglePowerNode(map, { col: 0, row: 0 });
    togglePowerNode(map, { col: 1, row: 0 });
    assert.equal(map.witchObjectives.length, 1, 'two adjacent hexes = one node');
    assert.equal(map.witchObjectives[0].hexes.length, 2);
    togglePowerNode(map, { col: 5, row: 5 });
    assert.equal(map.witchObjectives.length, 2, 'a detached hex = a second node');
  });

  test('5-hex cap BLOCKS adding a 6th hex to a cluster', () => {
    const map = createBlankMapDef(13, 13);
    for (let c = 0; c < MAX_NODE_CLUSTER; c++) {
      const res = togglePowerNode(map, { col: c, row: 0 });
      assert.equal(res.ok, true);
    }
    assert.equal(map.witchObjectives.length, 1);
    assert.equal(map.witchObjectives[0].hexes.length, MAX_NODE_CLUSTER);
    const res = togglePowerNode(map, { col: MAX_NODE_CLUSTER, row: 0 });
    assert.equal(res.ok, false, '6th contiguous hex is blocked');
    assert.match(res.warning, /capped at 5/);
    assert.equal(map.witchObjectives[0].hexes.length, MAX_NODE_CLUSTER, 'model unchanged');
  });

  test('cap also blocks a bridging hex that would MERGE two clusters past 5', () => {
    const map = createBlankMapDef(13, 13);
    // Two 3-hex rows that a single hex would join into 7.
    togglePowerNode(map, { col: 0, row: 0 });
    togglePowerNode(map, { col: 1, row: 0 });
    togglePowerNode(map, { col: 2, row: 0 });
    togglePowerNode(map, { col: 4, row: 0 });
    togglePowerNode(map, { col: 5, row: 0 });
    togglePowerNode(map, { col: 6, row: 0 });
    assert.equal(map.witchObjectives.length, 2);
    const res = togglePowerNode(map, { col: 3, row: 0 }); // bridges → 7 hexes
    assert.equal(res.ok, false);
    assert.equal(map.witchObjectives.length, 2, 'merge blocked, still two nodes');
  });

  test('each cluster gets a name + a distinct palette colour', () => {
    const map = createBlankMapDef(13, 13);
    togglePowerNode(map, { col: 0, row: 0 });
    togglePowerNode(map, { col: 5, row: 5 });
    const [a, b] = map.witchObjectives;
    assert.ok(/Power Node/.test(a.label) && /Power Node/.test(b.label));
    assert.notEqual(a.label, b.label, 'unique names');
    assert.ok(NODE_COLORS.includes(a.color) && NODE_COLORS.includes(b.color));
    assert.notEqual(a.color, b.color, 'distinct palette colours');
  });

  test('cluster maps to the runtime witchObjectives shape (anchor + hexes)', () => {
    const map = createBlankMapDef(13, 13);
    togglePowerNode(map, { col: 4, row: 4 });
    togglePowerNode(map, { col: 5, row: 4 });
    const o = map.witchObjectives[0];
    assert.deepEqual(Object.keys(o).sort(), ['color', 'hexes', 'label', 'row', 'col'].sort());
    // anchor is the cluster's first hex; hexes are bare {col,row} objects.
    assert.deepEqual(o.hexes[0], { col: o.col, row: o.row });
    for (const h of o.hexes) assert.deepEqual(Object.keys(h).sort(), ['col', 'row']);
    // It builds into a usable GameState objective.
    const built = buildMissionMap(map);
    assert.equal(built.witchObjectives.length, 1);
    assert.equal(built.witchObjectives[0].hexes.length, 2);
  });

  test('removing the middle hex SPLITS one node into two on recompute', () => {
    const map = createBlankMapDef(13, 13);
    togglePowerNode(map, { col: 0, row: 0 });
    togglePowerNode(map, { col: 1, row: 0 });
    togglePowerNode(map, { col: 2, row: 0 });
    assert.equal(map.witchObjectives.length, 1);
    togglePowerNode(map, { col: 1, row: 0 }); // remove the middle
    assert.equal(map.witchObjectives.length, 2, '0,0 and 2,0 are now disconnected');
  });

  test('an existing cluster keeps its name + colour when GROWN', () => {
    const map = createBlankMapDef(13, 13);
    togglePowerNode(map, { col: 0, row: 0 });
    const { label, color } = map.witchObjectives[0];
    togglePowerNode(map, { col: 1, row: 0 }); // grow the same cluster
    assert.equal(map.witchObjectives.length, 1);
    assert.equal(map.witchObjectives[0].label, label, 'name preserved across growth');
    assert.equal(map.witchObjectives[0].color, color, 'colour preserved across growth');
  });

  test('renamePowerNode updates the cluster label', () => {
    const map = createBlankMapDef(13, 13);
    togglePowerNode(map, { col: 2, row: 2 });
    renamePowerNode(map, 0, 'The Old Well');
    assert.equal(map.witchObjectives[0].label, 'The Old Well');
    renamePowerNode(map, 9, 'nope'); // out of range — no throw, no change
    assert.equal(map.witchObjectives[0].label, 'The Old Well');
  });

  test('controller: a blocked cap toggle leaves undo/redo history intact', () => {
    const ed = createMissionEditor({ render: () => {} });
    ed.setActiveTool(EditorTool.POWER_NODE);
    for (let c = 0; c < MAX_NODE_CLUSTER; c++) ed.applyAt({ col: c, row: 0 });
    // Make a redoable branch: undo once, leaving a redo entry.
    ed.undo();
    assert.equal(ed.canRedo(), true);
    ed.redo(); // back to 5-hex cluster, redo now empty
    const blocked = ed.applyAt({ col: MAX_NODE_CLUSTER, row: 0 });
    assert.equal(blocked.ok, false);
    assert.equal(ed.getMapDef().witchObjectives[0].hexes.length, MAX_NODE_CLUSTER,
      'blocked edit did not mutate the model');
  });
});

// ── ITEM 7 — Paint Path road + roadDirs; bridge removed ───────────────────────

describe('mission-editor — Paint Path road wiring (item 7)', () => {
  test('painting adjacent ROAD tiles wires roadDirs both ways (renders)', () => {
    const map = createBlankMapDef(13, 13);
    paintPath(map, { col: 1, row: 0 }, 'ROAD');
    paintPath(map, { col: 2, row: 0 }, 'ROAD');
    const a = map.tiles.find(t => t.col === 1 && t.row === 0);
    const b = map.tiles.find(t => t.col === 2 && t.row === 0);
    assert.deepEqual(a.roadDirs, [hexKey(2, 0)]);
    assert.deepEqual(b.roadDirs, [hexKey(1, 0)]);
    // The built handmade tile carries the connectivity the renderer draws from.
    const built = buildMissionMap(map);
    const bt = built.tiles.get(hexKey(1, 0));
    assert.equal(pathOf(bt), PathType.ROAD);
    assert.ok(bt.roadDirs.has(hexKey(2, 0)), 'roadDirs survive the build → road renders');
  });

  test('a lone painted road has no connectivity but still carries path=ROAD', () => {
    const map = createBlankMapDef(13, 13);
    paintPath(map, { col: 6, row: 6 }, 'ROAD');
    const def = map.tiles.find(t => t.col === 6 && t.row === 6);
    assert.equal(def.path, 'ROAD');
    assert.deepEqual(def.roadDirs, []);
  });

  test('clearing / switching a road off unwires the neighbour link', () => {
    const map = createBlankMapDef(13, 13);
    paintPath(map, { col: 1, row: 0 }, 'ROAD');
    paintPath(map, { col: 2, row: 0 }, 'ROAD');
    paintPath(map, { col: 2, row: 0 }, 'RIVER'); // no longer a road
    const a = map.tiles.find(t => t.col === 1 && t.row === 0);
    const b = map.tiles.find(t => t.col === 2 && t.row === 0);
    assert.deepEqual(a.roadDirs, [], 'former neighbour link removed');
    assert.deepEqual(b.roadDirs, []);
    assert.equal(b.path, 'RIVER');
  });

  test('BRIDGE is not an authorable path option', () => {
    assert.ok(PATH_TOOL_OPTIONS.includes('ROAD'));
    assert.ok(PATH_TOOL_OPTIONS.includes('RIVER'));
    assert.ok(!PATH_TOOL_OPTIONS.includes('BRIDGE'), 'bridges are implied, never painted');
  });
});

// ── ITEM 8 — Road-node toggle auto-regenerates roads ──────────────────────────

describe('mission-editor — road-node toggle auto-regenerates (item 8)', () => {
  test('toggling road nodes lays roads WITHOUT a manual Regenerate Roads call', () => {
    const ed = createMissionEditor({ render: () => {} });
    // Two buildings give the road graph endpoints; structural nodes are implicit.
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'INN');
    ed.applyAt({ col: 1, row: 1 });
    ed.setPaintValue('structure', 'CHURCH');
    ed.applyAt({ col: 8, row: 8 });
    // Add a road-node waypoint — this alone should trigger regeneration.
    ed.setActiveTool(EditorTool.ROAD_NODE);
    ed.applyAt({ col: 4, row: 4 });
    const roads = ed.getMapDef().tiles.filter(t => t.path === 'ROAD');
    assert.ok(roads.length > 0, 'roads were auto-derived on the node toggle');
    assert.ok(roads.some(r => Array.isArray(r.roadDirs) && r.roadDirs.length > 0),
      'derived roads carry connectivity');
  });

  test('the auto-regen on a road-node toggle is a single undo step', () => {
    const ed = createMissionEditor({ render: () => {} });
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'INN');
    ed.applyAt({ col: 1, row: 1 });
    ed.setPaintValue('structure', 'CHURCH');
    ed.applyAt({ col: 8, row: 8 });
    ed.setActiveTool(EditorTool.ROAD_NODE);
    ed.applyAt({ col: 4, row: 4 });
    assert.deepEqual(ed.getMapDef().roadNodes, [hexKey(4, 4)]);
    assert.ok(ed.undo(), 'one undo reverses BOTH the node toggle and the regen');
    assert.deepEqual(ed.getMapDef().roadNodes, []);
  });
});

// ── ITEM 9 — Overlay "darken auto-generated" layer ────────────────────────────

describe('mission-editor — darken-auto-generated layer (item 9)', () => {
  test('overlayDarkenVisible is gated on BOTH the toggle and overlay mode', () => {
    const layers = createLayerVisibility();
    const overlay = createOverlayMapDef({ seed: 1, mapSize: 'skirmish' });
    const handmade = createBlankMapDef();
    assert.equal(overlayDarkenVisible(layers, overlay), false, 'off by default');
    layers.darkenGenerated = true;
    assert.equal(overlayDarkenVisible(layers, overlay), true, 'on for overlay');
    assert.equal(overlayDarkenVisible(layers, handmade), false, 'never for handmade');
  });

  test('overlayEditedKeys returns only explicit overlay-edited hexes', () => {
    const map = createOverlayMapDef({ seed: 1, mapSize: 'skirmish' });
    assert.equal(overlayEditedKeys(map).size, 0, 'fresh overlay has no edits');
    paintBase(map, { col: 2, row: 2 }, 'FOREST');
    paintStructure(map, { col: 3, row: 3 }, 'INN');
    const keys = overlayEditedKeys(map);
    assert.ok(keys.has(hexKey(2, 2)) && keys.has(hexKey(3, 3)));
    assert.equal(keys.size, 2, 'only the two edited tiles are flagged as preserved');
  });

  test('handmade maps report no generated (edited) keys', () => {
    const map = createBlankMapDef();
    paintBase(map, { col: 1, row: 1 }, 'DIRT');
    assert.equal(overlayEditedKeys(map).size, 0, 'handmade has no generated base to partition');
  });
});
