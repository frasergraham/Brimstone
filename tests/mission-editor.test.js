// Tests for the mission-editor CORE model (src/tools/mission-editor.js) — P5.
// DOM-free per CLAUDE.md: exercises the pure tool functions + the controller's
// edit loop / undo / mode toggle via an injected render callback (no canvas).
//
// Pins the four P1-consistency invariants the editor must mirror:
//   1. Painted tile defs are COMPLETE (every field present, explicit nulls).
//   2. "Mark Road Node" toggles only the authored waypoint set (not structural).
//   3. Regenerate-then-snapshot persists derived roadDirs into handmade tiles.
//   4. Enum fields are emitted in uppercase KEY form.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EditorTool,
  ENEMY_UNIT_TYPES,
  createMissionEditor,
  createDefaultMapDef,
  paintTile,
  setBuilding,
  setResource,
  toggleHiddenSurvivor,
  placeEnemyUnit,
  setHeroStart,
  setWitchStart,
  toggleRoadNode,
  togglePowerNode,
  regenerateHandmadeRoads,
  snapshotTiles,
  setMode,
  createPreviewController,
} from '../src/tools/mission-editor.js';
import { hexKey } from '../src/hex.js';
import { Tile, TileType } from '../src/tiles.js';

// ── Pure tool functions ──────────────────────────────────────────────────────

describe('mission-editor — tile painting (rules #1 & #4)', () => {
  test('paint writes a COMPLETE tile def in uppercase KEY form', () => {
    const map = createDefaultMapDef();
    paintTile(map, { col: 3, row: 4 }, 'FOREST');
    const def = map.tiles.find(t => t.col === 3 && t.row === 4);
    assert.ok(def, 'a tile def was created');
    // Rule #1: every field present, explicit nulls — not a partial.
    assert.deepEqual(Object.keys(def).sort(), [
      'building', 'col', 'fortifyLevel', 'hiddenSurvivor', 'resource', 'roadDirs', 'row', 'type',
    ]);
    assert.equal(def.type, 'FOREST'); // rule #4: KEY form
    assert.equal(def.building, null);
    assert.equal(def.resource, null);
    assert.equal(def.fortifyLevel, 0);
    assert.equal(def.hiddenSurvivor, false);
    assert.deepEqual(def.roadDirs, []);
  });

  test('painting a non-building type clears an existing building', () => {
    const map = createDefaultMapDef();
    setBuilding(map, { col: 1, row: 1 }, 'INN');
    let def = map.tiles.find(t => t.col === 1 && t.row === 1);
    assert.equal(def.type, 'BUILDING');
    assert.equal(def.building, 'INN');
    paintTile(map, { col: 1, row: 1 }, 'GRASS');
    def = map.tiles.find(t => t.col === 1 && t.row === 1);
    assert.equal(def.type, 'GRASS');
    assert.equal(def.building, null);
  });

  test('setBuilding forces BUILDING type; clearing reverts to grass', () => {
    const map = createDefaultMapDef();
    setBuilding(map, { col: 2, row: 2 }, 'CHURCH');
    let def = map.tiles.find(t => t.col === 2 && t.row === 2);
    assert.equal(def.type, 'BUILDING');
    assert.equal(def.building, 'CHURCH');
    setBuilding(map, { col: 2, row: 2 }, null);
    def = map.tiles.find(t => t.col === 2 && t.row === 2);
    assert.equal(def.building, null);
    assert.equal(def.type, 'GRASS');
  });

  test('setResource sets and clears the resource field', () => {
    const map = createDefaultMapDef();
    setResource(map, { col: 0, row: 0 }, 'SILVER');
    assert.equal(map.tiles.find(t => t.col === 0 && t.row === 0).resource, 'SILVER');
    setResource(map, { col: 0, row: 0 }, null);
    assert.equal(map.tiles.find(t => t.col === 0 && t.row === 0).resource, null);
  });

  test('toggleHiddenSurvivor flips the flag', () => {
    const map = createDefaultMapDef();
    toggleHiddenSurvivor(map, { col: 4, row: 4 });
    assert.equal(map.tiles.find(t => t.col === 4 && t.row === 4).hiddenSurvivor, true);
    toggleHiddenSurvivor(map, { col: 4, row: 4 });
    assert.equal(map.tiles.find(t => t.col === 4 && t.row === 4).hiddenSurvivor, false);
  });
});

describe('mission-editor — starts & objectives', () => {
  test('setHeroStart / setWitchStart re-point the single markers', () => {
    const map = createDefaultMapDef();
    setHeroStart(map, { col: 5, row: 5 });
    assert.deepEqual(map.heroStart, { col: 5, row: 5 });
    setHeroStart(map, { col: 1, row: 8 });
    assert.deepEqual(map.heroStart, { col: 1, row: 8 }); // moved, not duplicated
    setWitchStart(map, { col: 7, row: 0 });
    assert.deepEqual(map.witchStart, { col: 7, row: 0 });
  });

  test('togglePowerNode adds then removes a witchObjectives entry', () => {
    const map = createDefaultMapDef();
    togglePowerNode(map, { col: 4, row: 4 });
    assert.equal(map.witchObjectives.length, 1);
    assert.deepEqual(map.witchObjectives[0].hexes, [{ col: 4, row: 4 }]);
    togglePowerNode(map, { col: 4, row: 4 });
    assert.equal(map.witchObjectives.length, 0);
  });
});

describe('mission-editor — road nodes (rule #2)', () => {
  test('toggleRoadNode manages the EXTRA authored waypoint set only', () => {
    const map = createDefaultMapDef();
    toggleRoadNode(map, { col: 3, row: 3 });
    assert.deepEqual(map.roadNodes, [hexKey(3, 3)]);
    toggleRoadNode(map, { col: 3, row: 3 });
    assert.deepEqual(map.roadNodes, []);
  });

  test('road nodes are independent of building/bridge structural nodes', () => {
    // Marking a road node must NOT add the tile as a building, and a building
    // is structural without being in roadNodes.
    const map = createDefaultMapDef();
    setBuilding(map, { col: 2, row: 2 }, 'MILL');
    toggleRoadNode(map, { col: 5, row: 5 });
    assert.deepEqual(map.roadNodes, [hexKey(5, 5)]); // only the authored one
    assert.ok(!map.roadNodes.includes(hexKey(2, 2)));
  });
});

describe('mission-editor — enemy units', () => {
  test('placeEnemyUnit adds, replaces, and toggles off', () => {
    const units = [];
    placeEnemyUnit(units, { col: 3, row: 2 }, 'zombie');
    assert.equal(units.length, 1);
    assert.deepEqual(units[0], { type: 'zombie', col: 3, row: 2, overrides: {} });
    // Different type at same hex → replace.
    placeEnemyUnit(units, { col: 3, row: 2 }, 'minion');
    assert.equal(units.length, 1);
    assert.equal(units[0].type, 'minion');
    // Same type again → toggle off.
    placeEnemyUnit(units, { col: 3, row: 2 }, 'minion');
    assert.equal(units.length, 0);
  });

  test('enemy types are valid runtime values', () => {
    assert.ok(ENEMY_UNIT_TYPES.includes('zombie'));
    assert.ok(ENEMY_UNIT_TYPES.includes('iron_golem'));
  });
});

// ── Regenerate-then-snapshot (rule #3) ───────────────────────────────────────

describe('mission-editor — regenerate roads then snapshot (rule #3)', () => {
  test('handmade road regen persists derived roadDirs into tile defs', () => {
    const map = createDefaultMapDef();
    // Two buildings at opposite corners → MST has one edge → a road is laid.
    setBuilding(map, { col: 1, row: 1 }, 'INN');
    setBuilding(map, { col: 7, row: 7 }, 'GRAVEYARD');
    // No roads exist yet.
    assert.ok(!map.tiles.some(t => t.type === 'ROAD'));

    regenerateHandmadeRoads(map);

    // At least one ROAD tile def now exists and carries roadDirs.
    const roads = map.tiles.filter(t => t.type === 'ROAD');
    assert.ok(roads.length > 0, 'roads were laid between the two buildings');
    assert.ok(roads.every(r => Array.isArray(r.roadDirs)), 'roadDirs persisted as arrays');
    assert.ok(roads.some(r => r.roadDirs.length > 0), 'derived roadDirs are non-empty');

    // The buildings (structural nodes) are connected into the graph.
    const inn = map.tiles.find(t => t.col === 1 && t.row === 1);
    assert.ok(inn.roadDirs.length > 0, 'building got connected roadDirs');
  });

  test('snapshotTiles drops plain grass but keeps non-trivial tiles', () => {
    // snapshotTiles operates on a Tile Map; verify it omits a blank grass tile
    // and emits the building in uppercase KEY form (rule #4).
    const tilesMap = new Map();
    tilesMap.set(hexKey(0, 0), new Tile(0, 0, TileType.GRASS));
    const house = new Tile(1, 1, TileType.BUILDING);
    house.building = 'house'; // stored as raw enum value
    tilesMap.set(hexKey(1, 1), house);
    const snap = snapshotTiles(tilesMap);
    assert.equal(snap.length, 1);
    assert.equal(snap[0].col, 1);
    assert.equal(snap[0].type, 'BUILDING');
    assert.equal(snap[0].building, 'HOUSE');
  });
});

// ── Mode toggle ──────────────────────────────────────────────────────────────

describe('mission-editor — mode toggle keeps a coherent model', () => {
  test('handmade → procedural seeds a coherent procedural def', () => {
    const map = createDefaultMapDef();
    const proc = setMode(map, 'procedural', { seed: 42, mapSize: 'standard', nodeCount: 3 });
    assert.equal(proc.mode, 'procedural');
    assert.equal(proc.seed, 42);
    assert.equal(proc.mapSize, 'standard');
    assert.ok(proc.overlay && Array.isArray(proc.overlay.tiles));
  });

  test('procedural → handmade bakes an explicit tile snapshot', () => {
    const proc = setMode(createDefaultMapDef(), 'procedural', { seed: 7, mapSize: 'skirmish', nodeCount: 3 });
    const hand = setMode(proc, 'handmade');
    assert.equal(hand.mode, 'handmade');
    assert.ok(hand.cols > 0 && hand.rows > 0);
    assert.ok(Array.isArray(hand.tiles) && hand.tiles.length > 0, 'baked explicit tiles');
    assert.ok(hand.heroStart && hand.witchStart);
    // Baked tiles are COMPLETE defs (rule #1).
    const sample = hand.tiles[0];
    for (const f of ['type', 'building', 'resource', 'fortifyLevel', 'hiddenSurvivor', 'roadDirs']) {
      assert.ok(f in sample, `baked tile carries ${f}`);
    }
  });

  test('same-mode setMode returns a clone (no shared refs)', () => {
    const map = createDefaultMapDef();
    paintTile(map, { col: 2, row: 2 }, 'DIRT');
    const clone = setMode(map, 'handmade');
    assert.notEqual(clone, map);
    assert.notEqual(clone.tiles, map.tiles);
    assert.deepEqual(clone.tiles, map.tiles);
  });
});

// ── Controller edit loop + undo ───────────────────────────────────────────────

describe('mission-editor — controller edit loop & undo', () => {
  test('applyAt dispatches the active tool and invokes render', () => {
    let renders = 0;
    const ed = createMissionEditor({ render: () => { renders++; } });
    ed.setActiveTool(EditorTool.PAINT_TILE);
    ed.setPaintValue('tile', 'RIVER');
    ed.applyAt({ col: 3, row: 3 });
    assert.equal(renders, 1);
    const def = ed.getMapDef().tiles.find(t => t.col === 3 && t.row === 3);
    assert.equal(def.type, 'RIVER');
  });

  test('applyAt ignores out-of-bounds clicks', () => {
    let renders = 0;
    const ed = createMissionEditor({ render: () => { renders++; } });
    ed.applyAt({ col: 99, row: 99 }); // outside the 9×9 default
    assert.equal(renders, 0);
    ed.applyAt(null);
    assert.equal(renders, 0);
  });

  test('undo restores the prior mapDef', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.SET_BUILDING);
    ed.setPaintValue('building', 'BLACKSMITH');
    ed.applyAt({ col: 4, row: 4 });
    assert.equal(ed.getMapDef().tiles.find(t => t.col === 4 && t.row === 4).type, 'BUILDING');
    assert.ok(ed.canUndo());
    ed.undo();
    assert.ok(!ed.getMapDef().tiles.some(t => t.col === 4 && t.row === 4));
    assert.ok(!ed.canUndo());
  });

  test('enemy-unit tool routes through the controller', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.ENEMY_UNIT);
    ed.setPaintValue('enemyType', 'zombie');
    ed.applyAt({ col: 2, row: 5 });
    assert.equal(ed.getEnemyUnits().length, 1);
    assert.equal(ed.getEnemyUnits()[0].type, 'zombie');
    ed.undo();
    assert.equal(ed.getEnemyUnits().length, 0);
  });

  test('mode toggle through controller flips mode and is undoable', () => {
    const ed = createMissionEditor();
    assert.equal(ed.getMode(), 'handmade');
    ed.setMode('procedural', { seed: 99 });
    assert.equal(ed.getMode(), 'procedural');
    assert.equal(ed.getSeed(), 99);
    ed.setSeed(123);
    assert.equal(ed.getSeed(), 123);
    ed.undo(); // undo the seed change
    assert.equal(ed.getSeed(), 99);
  });

  test('getMapDef / setMapDef expose the model for P6', () => {
    const ed = createMissionEditor();
    const fresh = createDefaultMapDef();
    fresh.tiles.push({ col: 0, row: 0, type: 'DIRT', building: null, resource: null, fortifyLevel: 0, hiddenSurvivor: false, roadDirs: [] });
    ed.setMapDef(fresh);
    assert.equal(ed.getMapDef().tiles[0].type, 'DIRT');
  });
});

// ── 3D preview lifecycle bookkeeping (P7) ─────────────────────────────────────
// The Renderer3D + Babylon engine are mocked: we only verify the controller's
// lazy-construct + dispose-before-rebuild + idempotent-teardown bookkeeping.

describe('mission-editor — createPreviewController (P7)', () => {
  // A fake renderer + construct/dispose pair that records call order.
  function harness() {
    const events = [];
    let nextId = 0;
    const ctl = createPreviewController({
      construct: () => { const r = { id: nextId++ }; events.push(`construct:${r.id}`); return r; },
      dispose: (r) => { events.push(`dispose:${r.id}`); },
    });
    return { ctl, events };
  }

  test('lazy: nothing is constructed until the first rebuild', () => {
    const { ctl, events } = harness();
    assert.equal(ctl.isActive(), false);
    assert.equal(ctl.current(), null);
    assert.deepEqual(events, []);
  });

  test('rebuild constructs, returns the renderer, and marks active', () => {
    const { ctl, events } = harness();
    const r = ctl.rebuild();
    assert.equal(ctl.isActive(), true);
    assert.equal(ctl.current(), r);
    assert.deepEqual(events, ['construct:0']);
  });

  test('rebuild disposes the previous renderer BEFORE constructing the new one', () => {
    const { ctl, events } = harness();
    ctl.rebuild();
    ctl.rebuild();
    // Dispose of #0 must precede construct of #1 — no leaked engine.
    assert.deepEqual(events, ['construct:0', 'dispose:0', 'construct:1']);
    assert.equal(ctl.current().id, 1);
  });

  test('teardown disposes the live renderer and clears the slot', () => {
    const { ctl, events } = harness();
    ctl.rebuild();
    ctl.teardown();
    assert.deepEqual(events, ['construct:0', 'dispose:0']);
    assert.equal(ctl.isActive(), false);
    assert.equal(ctl.current(), null);
  });

  test('teardown is idempotent — second call disposes nothing', () => {
    const { ctl, events } = harness();
    ctl.rebuild();
    ctl.teardown();
    ctl.teardown();
    assert.deepEqual(events, ['construct:0', 'dispose:0']);
  });

  test('a throwing dispose still clears the slot (no stranded engine)', () => {
    let constructs = 0;
    const ctl = createPreviewController({
      construct: () => ({ n: constructs++ }),
      dispose: () => { throw new Error('boom'); },
    });
    ctl.rebuild();
    assert.doesNotThrow(() => ctl.teardown());
    assert.equal(ctl.isActive(), false);
  });
});
