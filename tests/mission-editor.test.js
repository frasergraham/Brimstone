// Tests for the mission-editor CORE model (src/tools/mission-editor.js) — P6.
// DOM-free per CLAUDE.md: exercises the pure tool functions + the controller's
// edit loop / undo / mode toggle via an injected render callback (no canvas).
//
// P6 tile-model refactor: tile painting is split into THREE independent layer
// tools — PAINT_BASE (base material), PAINT_STRUCTURE (building), PAINT_PATH
// (road/river/bridge). Defs are emitted in the canonical P5 LAYERED shape
// (base/structure/path uppercase KEYS, NO legacy `type`).
//
// Pins the consistency invariants the editor must mirror:
//   1. Painted tile defs are COMPLETE (every field present, explicit nulls).
//   2. Each paint tool mutates ONLY its own layer.
//   3. Placing a building emits an EXPLICIT base=DIRT (building floor).
//   4. "Mark Road Node" toggles only the authored waypoint set (not structural).
//   5. Regenerate-then-snapshot persists derived roadDirs into handmade tiles.
//   6. Enum fields are emitted in uppercase KEY form; snapshots are canonical.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EditorTool,
  ENEMY_UNIT_TYPES,
  createMissionEditor,
  createDefaultMapDef,
  paintBase,
  paintStructure,
  paintPath,
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
  assembleMission,
  populateFromMission,
  createPreviewController,
} from '../src/tools/mission-editor.js';
import { buildMissionMap } from '../src/campaign/mission-map.js';
import { hexKey } from '../src/hex.js';
import { Tile, TileType, PathType, StructureType } from '../src/tiles.js';

// The complete set of fields a canonical layered tile def carries.
const LAYERED_FIELDS = [
  'base', 'building', 'col', 'fortifyLevel', 'hiddenSurvivor',
  'path', 'resource', 'roadDirs', 'row', 'structure',
];

// ── Pure tool functions: layer isolation (rules #1, #2, #3, #6) ───────────────

describe('mission-editor — layered tile painting', () => {
  test('PAINT_BASE writes a COMPLETE layered def in uppercase KEY form (no `type`)', () => {
    const map = createDefaultMapDef();
    paintBase(map, { col: 3, row: 4 }, 'FOREST');
    const def = map.tiles.find(t => t.col === 3 && t.row === 4);
    assert.ok(def, 'a tile def was created');
    // Rule #1: every field present, explicit nulls — and NO legacy `type`.
    assert.deepEqual(Object.keys(def).sort(), LAYERED_FIELDS);
    assert.ok(!('type' in def), 'no legacy type field');
    assert.equal(def.base, 'FOREST'); // rule #6: KEY form
    assert.equal(def.structure, null);
    assert.equal(def.path, null);
    assert.equal(def.building, null);
    assert.equal(def.resource, null);
    assert.equal(def.fortifyLevel, 0);
    assert.equal(def.hiddenSurvivor, false);
    assert.deepEqual(def.roadDirs, []);
  });

  test('PAINT_BASE touches ONLY the base layer (keeps structure + path)', () => {
    const map = createDefaultMapDef();
    paintStructure(map, { col: 1, row: 1 }, 'INN');   // base→DIRT, structure→BUILDING
    paintPath(map, { col: 1, row: 1 }, 'ROAD');        // road over the building tile
    paintBase(map, { col: 1, row: 1 }, 'FOREST');      // re-base only
    const def = map.tiles.find(t => t.col === 1 && t.row === 1);
    assert.equal(def.base, 'FOREST');
    assert.equal(def.structure, 'BUILDING'); // untouched
    assert.equal(def.building, 'INN');       // untouched
    assert.equal(def.path, 'ROAD');          // untouched
  });

  test('PAINT_STRUCTURE places a building with an EXPLICIT base=DIRT (rule #3)', () => {
    const map = createDefaultMapDef();
    paintStructure(map, { col: 2, row: 2 }, 'CHURCH');
    const def = map.tiles.find(t => t.col === 2 && t.row === 2);
    assert.equal(def.structure, 'BUILDING');
    assert.equal(def.building, 'CHURCH');
    assert.equal(def.base, 'DIRT', 'building floor defaults to DIRT, not GRASS');
    assert.equal(def.path, null, 'structure tool leaves path alone');
  });

  test('PAINT_STRUCTURE keeps a user-painted non-default base', () => {
    const map = createDefaultMapDef();
    paintBase(map, { col: 3, row: 3 }, 'FOREST'); // deliberate base
    paintStructure(map, { col: 3, row: 3 }, 'MILL');
    const def = map.tiles.find(t => t.col === 3 && t.row === 3);
    assert.equal(def.base, 'FOREST', 'a deliberate base is preserved under a building');
    assert.equal(def.structure, 'BUILDING');
    assert.equal(def.building, 'MILL');
  });

  test('PAINT_STRUCTURE clearing removes the building but leaves base & path', () => {
    const map = createDefaultMapDef();
    paintStructure(map, { col: 2, row: 2 }, 'CHURCH'); // base→DIRT
    paintPath(map, { col: 2, row: 2 }, 'ROAD');
    paintStructure(map, { col: 2, row: 2 }, null);     // clear building
    const def = map.tiles.find(t => t.col === 2 && t.row === 2);
    assert.equal(def.structure, null);
    assert.equal(def.building, null);
    assert.equal(def.base, 'DIRT', 'base left as-is after clearing');
    assert.equal(def.path, 'ROAD', 'path left as-is after clearing');
  });

  test('PAINT_PATH sets/clears the path layer ONLY (base + structure untouched)', () => {
    const map = createDefaultMapDef();
    paintBase(map, { col: 5, row: 5 }, 'FOREST');
    paintPath(map, { col: 5, row: 5 }, 'RIVER');
    let def = map.tiles.find(t => t.col === 5 && t.row === 5);
    assert.equal(def.path, 'RIVER');
    assert.equal(def.base, 'FOREST', 'path tool does not touch base');
    assert.equal(def.structure, null);
    paintPath(map, { col: 5, row: 5 }, null); // clear
    def = map.tiles.find(t => t.col === 5 && t.row === 5);
    assert.equal(def.path, null);
    assert.equal(def.base, 'FOREST', 'base survives a path clear');
  });

  test('painting a road over a forest base keeps base=FOREST + path=ROAD', () => {
    const map = createDefaultMapDef();
    paintBase(map, { col: 6, row: 6 }, 'FOREST');
    paintPath(map, { col: 6, row: 6 }, 'ROAD');
    const def = map.tiles.find(t => t.col === 6 && t.row === 6);
    assert.equal(def.base, 'FOREST');
    assert.equal(def.path, 'ROAD');
    assert.equal(def.structure, null);
    assert.equal(def.building, null);
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

describe('mission-editor — road nodes (rule #4)', () => {
  test('toggleRoadNode manages the EXTRA authored waypoint set only', () => {
    const map = createDefaultMapDef();
    toggleRoadNode(map, { col: 3, row: 3 });
    assert.deepEqual(map.roadNodes, [hexKey(3, 3)]);
    toggleRoadNode(map, { col: 3, row: 3 });
    assert.deepEqual(map.roadNodes, []);
  });

  test('road nodes are independent of building/bridge structural nodes', () => {
    const map = createDefaultMapDef();
    paintStructure(map, { col: 2, row: 2 }, 'MILL');
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
    placeEnemyUnit(units, { col: 3, row: 2 }, 'minion'); // different → replace
    assert.equal(units.length, 1);
    assert.equal(units[0].type, 'minion');
    placeEnemyUnit(units, { col: 3, row: 2 }, 'minion'); // same → toggle off
    assert.equal(units.length, 0);
  });

  test('enemy types are valid runtime values', () => {
    assert.ok(ENEMY_UNIT_TYPES.includes('zombie'));
    assert.ok(ENEMY_UNIT_TYPES.includes('iron_golem'));
  });
});

// ── snapshotTiles canonical shape + regenerate-then-snapshot (rules #5, #6) ────

describe('mission-editor — snapshotTiles canonical layered shape', () => {
  test('emits base/structure/path uppercase KEYS, NO `type`, complete defs', () => {
    const tilesMap = new Map();
    tilesMap.set(hexKey(0, 0), new Tile(0, 0, TileType.GRASS)); // trivial → dropped
    const house = new Tile(1, 1, TileType.BUILDING);
    house.building = 'house'; // raw enum value
    tilesMap.set(hexKey(1, 1), house);
    const snap = snapshotTiles(tilesMap);
    assert.equal(snap.length, 1, 'plain grass dropped');
    const def = snap[0];
    assert.deepEqual(Object.keys(def).sort(), LAYERED_FIELDS);
    assert.ok(!('type' in def), 'no legacy type field');
    assert.equal(def.col, 1);
    assert.equal(def.base, 'DIRT');           // building floor (set type=BUILDING ⇒ DIRT)
    assert.equal(def.structure, 'BUILDING');
    assert.equal(def.path, null);
    assert.equal(def.building, 'HOUSE');      // rule #6 KEY form
  });

  test('a road over a forest base round-trips through snapshotTiles', () => {
    const tilesMap = new Map();
    const t = new Tile(2, 2, TileType.FOREST);
    t.path = PathType.ROAD; // road overlay on a forest base
    tilesMap.set(hexKey(2, 2), t);
    const [def] = snapshotTiles(tilesMap);
    assert.equal(def.base, 'FOREST');
    assert.equal(def.path, 'ROAD');
    assert.equal(def.structure, null);
  });

  test('handmade road regen persists derived roadDirs into layered tile defs (rule #5)', () => {
    const map = createDefaultMapDef();
    paintStructure(map, { col: 1, row: 1 }, 'INN');
    paintStructure(map, { col: 7, row: 7 }, 'GRAVEYARD');
    assert.ok(!map.tiles.some(t => t.path === 'ROAD'), 'no roads yet');

    regenerateHandmadeRoads(map);

    const roads = map.tiles.filter(t => t.path === 'ROAD');
    assert.ok(roads.length > 0, 'roads were laid between the two buildings');
    assert.ok(roads.every(r => Array.isArray(r.roadDirs)), 'roadDirs persisted as arrays');
    assert.ok(roads.some(r => r.roadDirs.length > 0), 'derived roadDirs are non-empty');
    // Road tiles keep an explicit base (canonical shape) and no `type`.
    assert.ok(roads.every(r => typeof r.base === 'string' && !('type' in r)));
    // The buildings (structural nodes) are connected into the graph.
    const inn = map.tiles.find(t => t.col === 1 && t.row === 1);
    assert.equal(inn.structure, 'BUILDING');
    assert.ok(inn.roadDirs.length > 0, 'building got connected roadDirs');
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

  test('procedural → handmade bakes an explicit layered tile snapshot', () => {
    const proc = setMode(createDefaultMapDef(), 'procedural', { seed: 7, mapSize: 'skirmish', nodeCount: 3 });
    const hand = setMode(proc, 'handmade');
    assert.equal(hand.mode, 'handmade');
    assert.ok(hand.cols > 0 && hand.rows > 0);
    assert.ok(Array.isArray(hand.tiles) && hand.tiles.length > 0, 'baked explicit tiles');
    assert.ok(hand.heroStart && hand.witchStart);
    // Baked tiles are COMPLETE layered defs (rule #1) — no legacy `type`.
    const sample = hand.tiles[0];
    for (const f of ['base', 'structure', 'path', 'building', 'resource', 'fortifyLevel', 'hiddenSurvivor', 'roadDirs']) {
      assert.ok(f in sample, `baked tile carries ${f}`);
    }
    assert.ok(!('type' in sample), 'no legacy type field');
  });

  test('same-mode setMode returns a clone (no shared refs)', () => {
    const map = createDefaultMapDef();
    paintBase(map, { col: 2, row: 2 }, 'DIRT');
    const clone = setMode(map, 'handmade');
    assert.notEqual(clone, map);
    assert.notEqual(clone.tiles, map.tiles);
    assert.deepEqual(clone.tiles, map.tiles);
  });
});

// ── Load → edit → save round-trip (lossless through the canonical shape) ──────

describe('mission-editor — layered mission round-trip', () => {
  test('load → edit → save of a layered mission is lossless + canonical', () => {
    // A small handmade mission authored directly in the canonical layered shape.
    const mission = {
      schema: 1,
      id: 'rt_mission',
      title: 'Round Trip',
      map: {
        mode: 'handmade',
        cols: 5,
        rows: 5,
        heroStart: { col: 0, row: 4 },
        witchStart: { col: 4, row: 0 },
        witchObjectives: [],
        roadNodes: [],
        tiles: [
          { col: 1, row: 1, base: 'DIRT', structure: 'BUILDING', path: null, building: 'INN', fortifyLevel: 0, resource: null, hiddenSurvivor: false, roadDirs: [] },
          { col: 2, row: 2, base: 'FOREST', structure: null, path: 'ROAD', building: null, fortifyLevel: 0, resource: null, hiddenSurvivor: false, roadDirs: [] },
        ],
      },
      enemyUnits: [{ type: 'zombie', col: 3, row: 3, overrides: {} }],
    };

    const ed = createMissionEditor();
    ed.applyMission(populateFromMission(mission));
    // Edit: add a river over grass elsewhere.
    paintPath(ed.getMapDef(), { col: 0, row: 0 }, 'RIVER');

    const out = ed.assemble();
    assert.equal(out.schema, 1);

    // The two authored tiles survive verbatim (layered, canonical).
    const inn = out.map.tiles.find(t => t.col === 1 && t.row === 1);
    assert.deepEqual(inn, mission.map.tiles[0]);
    const roadForest = out.map.tiles.find(t => t.col === 2 && t.row === 2);
    assert.deepEqual(roadForest, mission.map.tiles[1]);

    // The edit landed as a path-only overlay on grass.
    const river = out.map.tiles.find(t => t.col === 0 && t.row === 0);
    assert.equal(river.base, 'GRASS');
    assert.equal(river.path, 'RIVER');
    assert.equal(river.structure, null);

    // And the assembled mission BUILDS — base/structure/path resolve correctly.
    const built = buildMissionMap(out.map);
    const builtInn = built.tiles.get(hexKey(1, 1));
    assert.equal(builtInn.base, TileType.DIRT);
    assert.equal(builtInn.structure, StructureType.BUILDING);
    assert.equal(builtInn.building, 'inn');
    const builtRoadForest = built.tiles.get(hexKey(2, 2));
    assert.equal(builtRoadForest.base, TileType.FOREST);
    assert.equal(builtRoadForest.path, PathType.ROAD);
  });

  test('assembleMission / populateFromMission are inverses for the layered map', () => {
    const ed = createMissionEditor();
    paintStructure(ed.getMapDef(), { col: 1, row: 1 }, 'INN'); // base→DIRT
    paintPath(ed.getMapDef(), { col: 2, row: 2 }, 'BRIDGE');
    const assembled = ed.assemble();
    const split = populateFromMission(assembled);
    const reassembled = assembleMission(split);
    assert.deepEqual(reassembled, assembled);
  });
});

// ── Controller edit loop + undo ───────────────────────────────────────────────

describe('mission-editor — controller edit loop & undo', () => {
  test('default active tool is PAINT_BASE', () => {
    const ed = createMissionEditor();
    assert.equal(ed.activeTool, EditorTool.PAINT_BASE);
  });

  test('applyAt dispatches PAINT_PATH and invokes render', () => {
    let renders = 0;
    const ed = createMissionEditor({ render: () => { renders++; } });
    ed.setActiveTool(EditorTool.PAINT_PATH);
    ed.setPaintValue('path', 'RIVER');
    ed.applyAt({ col: 3, row: 3 });
    assert.equal(renders, 1);
    const def = ed.getMapDef().tiles.find(t => t.col === 3 && t.row === 3);
    assert.equal(def.path, 'RIVER');
    assert.equal(def.base, 'GRASS'); // path-only edit
  });

  test('applyAt ignores out-of-bounds clicks', () => {
    let renders = 0;
    const ed = createMissionEditor({ render: () => { renders++; } });
    ed.applyAt({ col: 99, row: 99 }); // outside the 9×9 default
    assert.equal(renders, 0);
    ed.applyAt(null);
    assert.equal(renders, 0);
  });

  test('PAINT_STRUCTURE through the controller; undo restores the prior mapDef', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'BLACKSMITH');
    ed.applyAt({ col: 4, row: 4 });
    const def = ed.getMapDef().tiles.find(t => t.col === 4 && t.row === 4);
    assert.equal(def.structure, 'BUILDING');
    assert.equal(def.building, 'BLACKSMITH');
    assert.equal(def.base, 'DIRT');
    assert.ok(ed.canUndo());
    ed.undo();
    assert.ok(!ed.getMapDef().tiles.some(t => t.col === 4 && t.row === 4));
    assert.ok(!ed.canUndo());
  });

  test('PAINT_STRUCTURE with the "None" value (null) clears a building', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'INN');
    ed.applyAt({ col: 4, row: 4 });
    ed.setPaintValue('structure', null); // UI "None" → null
    ed.applyAt({ col: 4, row: 4 });
    const def = ed.getMapDef().tiles.find(t => t.col === 4 && t.row === 4);
    assert.equal(def.structure, null);
    assert.equal(def.building, null);
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
    fresh.tiles.push({ col: 0, row: 0, base: 'DIRT', structure: null, path: null, building: null, fortifyLevel: 0, resource: null, hiddenSurvivor: false, roadDirs: [] });
    ed.setMapDef(fresh);
    assert.equal(ed.getMapDef().tiles[0].base, 'DIRT');
  });
});

// ── 3D preview lifecycle bookkeeping (P7) ─────────────────────────────────────
// The Renderer3D + Babylon engine are mocked: we only verify the controller's
// lazy-construct + dispose-before-rebuild + idempotent-teardown bookkeeping.

describe('mission-editor — createPreviewController (P7)', () => {
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
