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
  setHiddenSurvivor,
  hiddenSurvivorPlacements,
  survivorPickerOptions,
  survivorLabelForId,
  HIDDEN_SURVIVOR_ANY,
  setExploreOverride,
  exploreOverridePlacements,
  exploreOverridePickerOptions,
  exploreOverrideKeyFor,
  parseExploreOverrideKey,
  exploreOverrideLabel,
  ExploreOverrideKind,
  saveWip,
  loadWip,
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
  CreationMode,
  buildCreationMapDef,
  createBlankMapDef,
  createBakedMapDef,
  createOverlayMapDef,
  mapModeLabel,
  resizeHandmadeMap,
  setOverlayMapSize,
  MAP_EDGES,
  valuePanelKind,
  ToolValueKind,
  createLayerVisibility,
  showStructures,
  roadNodeMarkersVisible,
  stripTileOverlays,
} from '../src/tools/mission-editor.js';
import { loadMissionJSON } from '../src/campaign/json-mission.js';
import { MAP_SIZES } from '../src/map.js';
import { buildMissionMap } from '../src/campaign/mission-map.js';
import { hexKey } from '../src/hex.js';
import { Tile, TileType, PathType, StructureType, BuildingType } from '../src/tiles.js';

// The complete set of fields a canonical layered tile def carries.
const LAYERED_FIELDS = [
  'base', 'building', 'buildingFootprintOf', 'col', 'exploreOverride',
  'footprintHexes', 'fortifyLevel', 'hiddenSurvivor', 'hiddenSurvivorId',
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

describe('mission-editor — hidden-survivor picker (specific roster char)', () => {
  const findDef = (map, col, row) => map.tiles.find(t => t.col === col && t.row === row);

  test('survivorPickerOptions leads with "Any" then every roster character', () => {
    const opts = survivorPickerOptions();
    assert.equal(opts[0].id, HIDDEN_SURVIVOR_ANY); // null = Any
    assert.match(opts[0].label, /Any/i);
    // First roster entry is John O'Connor — Innkeeper; option carries name+title.
    assert.ok(opts.some(o => o.id === "John O'Connor" && /Innkeeper/.test(o.label)));
    // No null ids past the leading "Any" — every other option pins a real name.
    assert.ok(opts.slice(1).every(o => typeof o.id === 'string' && o.id.length));
  });

  test('survivorLabelForId resolves a name, falls back to Any for null', () => {
    assert.equal(survivorLabelForId(null), 'Any');
    assert.equal(survivorLabelForId("John O'Connor"), "John O'Connor");
  });

  test('setHiddenSurvivor places a SPECIFIC survivor (id stored on the def)', () => {
    const map = createDefaultMapDef();
    setHiddenSurvivor(map, { col: 2, row: 3 }, 'Mary Quinn');
    const def = findDef(map, 2, 3);
    assert.equal(def.hiddenSurvivor, true);
    assert.equal(def.hiddenSurvivorId, 'Mary Quinn');
  });

  test('"Any" placement stores a null id (runtime random pick)', () => {
    const map = createDefaultMapDef();
    setHiddenSurvivor(map, { col: 1, row: 1 }, HIDDEN_SURVIVOR_ANY);
    const def = findDef(map, 1, 1);
    assert.equal(def.hiddenSurvivor, true);
    assert.equal(def.hiddenSurvivorId, null);
  });

  test('re-clicking the SAME survivor removes it (toggle off)', () => {
    const map = createDefaultMapDef();
    setHiddenSurvivor(map, { col: 5, row: 5 }, 'Mary Quinn');
    setHiddenSurvivor(map, { col: 5, row: 5 }, 'Mary Quinn');
    const def = findDef(map, 5, 5);
    assert.equal(def.hiddenSurvivor, false);
    assert.equal(def.hiddenSurvivorId, null);
  });

  test('clicking a DIFFERENT survivor re-pins (overwrites) without clearing', () => {
    const map = createDefaultMapDef();
    setHiddenSurvivor(map, { col: 6, row: 6 }, 'Mary Quinn');
    setHiddenSurvivor(map, { col: 6, row: 6 }, "John O'Connor");
    const def = findDef(map, 6, 6);
    assert.equal(def.hiddenSurvivor, true);
    assert.equal(def.hiddenSurvivorId, "John O'Connor");
  });

  test('hiddenSurvivorPlacements lists every placed survivor with its id', () => {
    const map = createDefaultMapDef();
    setHiddenSurvivor(map, { col: 2, row: 3 }, 'Mary Quinn');
    setHiddenSurvivor(map, { col: 4, row: 4 }, HIDDEN_SURVIVOR_ANY);
    const places = hiddenSurvivorPlacements(map).sort((a, b) => a.col - b.col);
    assert.deepEqual(places, [
      { col: 2, row: 3, id: 'Mary Quinn' },
      { col: 4, row: 4, id: null },
    ]);
  });

  test('a specific survivor round-trips through assemble → populateFromMission', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.HIDDEN_SURVIVOR);
    ed.setPaintValue('survivor', 'Mary Quinn');
    ed.applyAt({ col: 3, row: 3 });
    // Download (assemble) then reload (populateFromMission) must preserve the id.
    const mission = ed.assemble();
    const { mapDef } = populateFromMission(JSON.parse(JSON.stringify(mission)));
    const def = mapDef.tiles.find(t => t.col === 3 && t.row === 3);
    assert.equal(def.hiddenSurvivor, true);
    assert.equal(def.hiddenSurvivorId, 'Mary Quinn');
  });

  test('a specific survivor round-trips through the M2 WIP autosave', () => {
    const store = (() => {
      const m = {};
      return {
        setItem: (k, v) => { m[k] = String(v); },
        getItem: (k) => (k in m ? m[k] : null),
        removeItem: (k) => { delete m[k]; },
        key: (i) => Object.keys(m)[i] ?? null,
        get length() { return Object.keys(m).length; },
      };
    })();
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.HIDDEN_SURVIVOR);
    ed.setPaintValue('survivor', 'Mary Quinn');
    ed.applyAt({ col: 7, row: 2 });
    const entry = saveWip(store, ed.assemble());
    const restored = loadWip(store, entry.id);
    const { mapDef } = populateFromMission(restored.mission);
    const def = mapDef.tiles.find(t => t.col === 7 && t.row === 2);
    assert.equal(def.hiddenSurvivorId, 'Mary Quinn');
  });
});

describe('mission-editor — exploration override picker (M4)', () => {
  const findDef = (map, col, row) => map.tiles.find(t => t.col === col && t.row === row);

  test('picker offers nothing + every resource + every weapon + horse', () => {
    const opts = exploreOverridePickerOptions();
    const values = opts.map(o => o.value);
    assert.equal(values[0], 'nothing');           // leads with the empty result
    assert.ok(values.includes('resource:wood'));
    assert.ok(values.includes('resource:scripture'));
    assert.ok(values.includes('weapon:sword'));
    assert.ok(values.includes('weapon:staff'));
    assert.ok(values.includes('horse'));
    // Every option carries a human label.
    assert.ok(opts.every(o => typeof o.label === 'string' && o.label.length));
  });

  test('parseExploreOverrideKey round-trips with exploreOverrideKeyFor', () => {
    for (const key of ['nothing', 'horse', 'resource:metal', 'weapon:axe']) {
      const ov = parseExploreOverrideKey(key);
      assert.equal(exploreOverrideKeyFor(ov), key);
    }
    // Unknown keys decode to null (ignored by setExploreOverride).
    assert.equal(parseExploreOverrideKey('bogus:thing'), null);
  });

  test('setExploreOverride pins a fixed resource result on the def', () => {
    const map = createDefaultMapDef();
    setExploreOverride(map, { col: 2, row: 3 }, 'resource:metal');
    const def = findDef(map, 2, 3);
    assert.deepEqual(def.exploreOverride, { kind: ExploreOverrideKind.RESOURCE, id: 'metal' });
  });

  test('a weapon, horse, and nothing each store their kind + id', () => {
    const map = createDefaultMapDef();
    setExploreOverride(map, { col: 1, row: 1 }, 'weapon:sword');
    setExploreOverride(map, { col: 2, row: 2 }, 'horse');
    setExploreOverride(map, { col: 3, row: 3 }, 'nothing');
    assert.deepEqual(findDef(map, 1, 1).exploreOverride, { kind: 'weapon', id: 'sword' });
    assert.deepEqual(findDef(map, 2, 2).exploreOverride, { kind: 'horse', id: 'horse' });
    assert.deepEqual(findDef(map, 3, 3).exploreOverride, { kind: 'nothing', id: null });
  });

  test('amount > 1 is recorded; default 1 is omitted from the def', () => {
    const map = createDefaultMapDef();
    setExploreOverride(map, { col: 4, row: 4 }, 'resource:food', 3);
    assert.deepEqual(findDef(map, 4, 4).exploreOverride, { kind: 'resource', id: 'food', amount: 3 });
    setExploreOverride(map, { col: 5, row: 5 }, 'resource:food', 1);
    assert.ok(!('amount' in findDef(map, 5, 5).exploreOverride));
  });

  test('re-clicking the SAME result removes it (toggle off)', () => {
    const map = createDefaultMapDef();
    setExploreOverride(map, { col: 6, row: 6 }, 'resource:wood');
    setExploreOverride(map, { col: 6, row: 6 }, 'resource:wood');
    assert.equal(findDef(map, 6, 6).exploreOverride, null);
  });

  test('clicking a DIFFERENT result re-pins (overwrites) without clearing', () => {
    const map = createDefaultMapDef();
    setExploreOverride(map, { col: 7, row: 7 }, 'resource:wood');
    setExploreOverride(map, { col: 7, row: 7 }, 'weapon:axe');
    assert.deepEqual(findDef(map, 7, 7).exploreOverride, { kind: 'weapon', id: 'axe' });
  });

  test('an unknown key leaves the def untouched', () => {
    const map = createDefaultMapDef();
    setExploreOverride(map, { col: 8, row: 8 }, 'resource:wood');
    setExploreOverride(map, { col: 8, row: 8 }, 'bogus:thing');
    assert.deepEqual(findDef(map, 8, 8).exploreOverride, { kind: 'resource', id: 'wood' });
  });

  test('exploreOverridePlacements lists every override with its value', () => {
    const map = createDefaultMapDef();
    setExploreOverride(map, { col: 2, row: 3 }, 'resource:metal');
    setExploreOverride(map, { col: 4, row: 4 }, 'horse');
    const places = exploreOverridePlacements(map).sort((a, b) => a.col - b.col);
    assert.deepEqual(places, [
      { col: 2, row: 3, override: { kind: 'resource', id: 'metal' } },
      { col: 4, row: 4, override: { kind: 'horse', id: 'horse' } },
    ]);
  });

  test('exploreOverrideLabel reads cleanly (null → None, amount suffix)', () => {
    assert.equal(exploreOverrideLabel(null), 'None');
    assert.match(exploreOverrideLabel({ kind: 'resource', id: 'wood' }), /Wood/);
    assert.match(exploreOverrideLabel({ kind: 'resource', id: 'food', amount: 3 }), /×3/);
  });

  test('an override round-trips through assemble → populateFromMission', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.EXPLORE_OVERRIDE);
    ed.setPaintValue('exploreOverride', 'weapon:staff');
    ed.applyAt({ col: 3, row: 3 });
    const mission = ed.assemble();
    const { mapDef } = populateFromMission(JSON.parse(JSON.stringify(mission)));
    const def = mapDef.tiles.find(t => t.col === 3 && t.row === 3);
    assert.deepEqual(def.exploreOverride, { kind: 'weapon', id: 'staff' });
  });

  test('an override round-trips through the M2 WIP autosave', () => {
    const store = (() => {
      const m = {};
      return {
        setItem: (k, v) => { m[k] = String(v); },
        getItem: (k) => (k in m ? m[k] : null),
        removeItem: (k) => { delete m[k]; },
        key: (i) => Object.keys(m)[i] ?? null,
        get length() { return Object.keys(m).length; },
      };
    })();
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.EXPLORE_OVERRIDE);
    ed.setPaintValue('exploreOverride', 'resource:silver');
    ed.applyAt({ col: 7, row: 2 });
    const entry = saveWip(store, ed.assemble());
    const restored = loadWip(store, entry.id);
    const { mapDef } = populateFromMission(restored.mission);
    const def = mapDef.tiles.find(t => t.col === 7 && t.row === 2);
    assert.deepEqual(def.exploreOverride, { kind: 'resource', id: 'silver' });
  });

  test('valuePanelKind maps the tool to the EXPLORE_OVERRIDE value kind', () => {
    assert.equal(valuePanelKind(EditorTool.EXPLORE_OVERRIDE), ToolValueKind.EXPLORE_OVERRIDE);
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

  test('applyAt dispatches PAINT_RIVER and invokes render', () => {
    let renders = 0;
    const ed = createMissionEditor({ render: () => { renders++; } });
    ed.setActiveTool(EditorTool.PAINT_RIVER);
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

// ── Map creation: three LOCKED modes (item 4) ─────────────────────────────────

describe('mission-editor — map creation modes (item 4)', () => {
  test('BLANK → an all-grass handmade grid at the chosen size, starts in-bounds', () => {
    const md = buildCreationMapDef({ mode: CreationMode.BLANK, cols: 11, rows: 7 });
    assert.equal(md.mode, 'handmade');
    assert.ok(!md.baked, 'blank is not marked baked');
    assert.equal(md.cols, 11);
    assert.equal(md.rows, 7);
    assert.deepEqual(md.tiles, [], 'no explicit tiles — grass fills implicitly');
    for (const start of [md.heroStart, md.witchStart]) {
      assert.ok(start.col >= 0 && start.col < 11 && start.row >= 0 && start.row < 7,
        'start clamped into the grid');
    }
    assert.equal(mapModeLabel(md), 'handmade');
  });

  test('BAKED → handmade snapshot of generateMap, every tile explicit + canonical', () => {
    const md = buildCreationMapDef({ mode: CreationMode.BAKED, seed: 7, mapSize: 'skirmish' });
    assert.equal(md.mode, 'handmade');
    assert.equal(md.baked, true);
    const cfg = MAP_SIZES.skirmish;
    assert.equal(md.cols, cfg.cols);
    assert.equal(md.rows, cfg.rows);
    assert.ok(Array.isArray(md.tiles) && md.tiles.length > 0, 'baked explicit tiles');
    assert.ok(md.heroStart && md.witchStart, 'baked carries starts');
    // No overlay — it's a true handmade snapshot.
    assert.ok(!('overlay' in md), 'baked has no overlay');
    // Canonical layered tile defs (rule #1): NO legacy `type`.
    const sample = md.tiles[0];
    for (const f of ['base', 'structure', 'path', 'building', 'resource', 'fortifyLevel', 'hiddenSurvivor', 'roadDirs']) {
      assert.ok(f in sample, `baked tile carries ${f}`);
    }
    assert.ok(!('type' in sample), 'no legacy type field');
    assert.equal(mapModeLabel(md), 'handmade (baked)');
  });

  test('BAKED is deterministic for a fixed seed + size', () => {
    const a = createBakedMapDef({ seed: 99, mapSize: 'skirmish' });
    const b = createBakedMapDef({ seed: 99, mapSize: 'skirmish' });
    assert.deepEqual(a.tiles, b.tiles);
    assert.deepEqual(a.heroStart, b.heroStart);
  });

  test('OVERLAY → procedural base + overlay, explicit dims tracked', () => {
    const md = buildCreationMapDef({ mode: CreationMode.OVERLAY, seed: 42, mapSize: 'standard', nodeCount: 3 });
    assert.equal(md.mode, 'procedural');
    assert.equal(md.seed, 42);
    assert.equal(md.mapSize, 'standard');
    assert.equal(md.nodeCount, 3);
    assert.equal(md.cols, MAP_SIZES.standard.cols);
    assert.equal(md.rows, MAP_SIZES.standard.rows);
    assert.ok(md.overlay && Array.isArray(md.overlay.tiles), 'overlay edits container present');
    assert.equal(mapModeLabel(md), 'overlay');
  });

  test('buildCreationMapDef rejects an unknown creation mode', () => {
    assert.throws(() => buildCreationMapDef({ mode: 'nope' }), /unknown creation mode/);
  });

  test('controller.createNew installs the chosen mode and resets the model', () => {
    const ed = createMissionEditor();
    // Dirty the current model first.
    paintBase(ed.getMapDef(), { col: 1, row: 1 }, 'DIRT');
    ed.createNew({ mode: CreationMode.OVERLAY, seed: 5, mapSize: 'skirmish' });
    assert.equal(ed.getMode(), 'procedural');
    assert.equal(ed.getMapModeLabel(), 'overlay');
    assert.equal(ed.getEnemyUnits().length, 0, 'enemy units reset');
    assert.equal(ed.getMeta().mapSize, 'skirmish', 'meta size synced to the new map');
    // The mode is fixed by creation — only a fresh createNew changes it.
    assert.ok(ed.canUndo());
  });

  test('mode is LOCKED across edits — painting/resizing never changes it', () => {
    const ed = createMissionEditor();
    ed.createNew({ mode: CreationMode.BLANK, cols: 8, rows: 8 });
    assert.equal(ed.getMode(), 'handmade');
    ed.setActiveTool(EditorTool.PAINT_ROAD);
    ed.applyAt({ col: 2, row: 2 });
    ed.resizeEdge('right', 1);
    assert.equal(ed.getMode(), 'handmade', 'still handmade after edits + resize');
  });
});

// ── Map sizing: explicit dims + per-edge add/remove with remap (item 3) ────────

// A coordinate-rich handmade model for round-trip remap tests.
function richModel() {
  return {
    mapDef: {
      mode: 'handmade',
      cols: 5,
      rows: 5,
      heroStart: { col: 1, row: 3 },
      witchStart: { col: 3, row: 1 },
      witchObjectives: [
        { col: 2, row: 2, hexes: [{ col: 2, row: 2 }, { col: 3, row: 2 }], label: 'Node 1' },
      ],
      roadNodes: [hexKey(1, 1), hexKey(3, 3)],
      tiles: [
        { col: 1, row: 1, base: 'DIRT', structure: 'BUILDING', path: null, building: 'INN', fortifyLevel: 0, resource: null, hiddenSurvivor: false, roadDirs: [hexKey(1, 2)] },
        { col: 1, row: 2, base: 'GRASS', structure: null, path: 'ROAD', building: null, fortifyLevel: 0, resource: null, hiddenSurvivor: false, roadDirs: [hexKey(1, 1)] },
      ],
    },
    enemyUnits: [{ type: 'zombie', col: 4, row: 4, overrides: {} }],
    meta: { survivorStartPositions: [{ col: 0, row: 2 }] },
  };
}

describe('mission-editor — edge resize: bottom/right extend & truncate (item 3)', () => {
  test('add on RIGHT grows cols without shifting any coordinate', () => {
    const before = richModel();
    const { ok, model } = resizeHandmadeMap(before, 'right', 1);
    assert.ok(ok);
    assert.equal(model.mapDef.cols, 6);
    assert.equal(model.mapDef.rows, 5);
    // Coordinates are untouched (no shift on right/bottom).
    assert.deepEqual(model.mapDef.heroStart, before.mapDef.heroStart);
    assert.deepEqual(model.mapDef.tiles[0], before.mapDef.tiles[0]);
    assert.deepEqual(model.enemyUnits[0], before.enemyUnits[0]);
  });

  test('add on BOTTOM grows rows without shifting', () => {
    const { ok, model } = resizeHandmadeMap(richModel(), 'bottom', 1);
    assert.ok(ok);
    assert.equal(model.mapDef.rows, 6);
    assert.deepEqual(model.mapDef.witchStart, { col: 3, row: 1 });
  });

  test('remove on RIGHT drops the last column data', () => {
    const m = richModel();
    m.mapDef.tiles.push({ col: 4, row: 0, base: 'FOREST', structure: null, path: null, building: null, fortifyLevel: 0, resource: null, hiddenSurvivor: false, roadDirs: [] });
    const { ok, model, warning } = resizeHandmadeMap(m, 'right', -1);
    assert.ok(ok);
    assert.equal(model.mapDef.cols, 4);
    // The col-4 tile AND the col-4 enemy unit are dropped.
    assert.ok(!model.mapDef.tiles.some(t => t.col === 4));
    assert.equal(model.enemyUnits.length, 0, 'enemy at col 4 dropped');
    assert.match(warning, /dropped/i);
  });

  test('remove on BOTTOM drops the last row data', () => {
    const m = richModel();
    m.enemyUnits = [{ type: 'minion', col: 0, row: 4, overrides: {} }];
    const { ok, model } = resizeHandmadeMap(m, 'bottom', -1);
    assert.ok(ok);
    assert.equal(model.mapDef.rows, 4);
    assert.equal(model.enemyUnits.length, 0, 'row-4 enemy dropped');
  });
});

describe('mission-editor — edge resize: top/left SHIFT + remap (item 3)', () => {
  test('add on LEFT shifts every coordinate by +1 col (incl roadDirs keys)', () => {
    const before = richModel();
    const { ok, model } = resizeHandmadeMap(before, 'left', 1);
    assert.ok(ok);
    assert.equal(model.mapDef.cols, 6);
    assert.deepEqual(model.mapDef.heroStart, { col: 2, row: 3 });
    assert.deepEqual(model.mapDef.witchStart, { col: 4, row: 1 });
    const inn = model.mapDef.tiles.find(t => t.building === 'INN');
    assert.equal(inn.col, 2); // was 1
    assert.equal(inn.row, 1);
    assert.deepEqual(inn.roadDirs, [hexKey(2, 2)]); // was 1,2
    assert.deepEqual(model.mapDef.roadNodes, [hexKey(2, 1), hexKey(4, 3)]);
    const obj = model.mapDef.witchObjectives[0];
    assert.equal(obj.col, 3);
    assert.deepEqual(obj.hexes, [{ col: 3, row: 2 }, { col: 4, row: 2 }]);
    assert.deepEqual(model.enemyUnits[0], { type: 'zombie', col: 5, row: 4, overrides: {} });
    assert.deepEqual(model.meta.survivorStartPositions, [{ col: 1, row: 2 }]);
  });

  test('add on TOP shifts every coordinate by +1 row', () => {
    const { ok, model } = resizeHandmadeMap(richModel(), 'top', 1);
    assert.ok(ok);
    assert.equal(model.mapDef.rows, 6);
    assert.deepEqual(model.mapDef.heroStart, { col: 1, row: 4 });
    const inn = model.mapDef.tiles.find(t => t.building === 'INN');
    assert.deepEqual(inn.roadDirs, [hexKey(1, 3)]); // 1,2 → 1,3
  });

  test('LEFT add then LEFT remove is an identity round-trip (full remap)', () => {
    const before = richModel();
    const added = resizeHandmadeMap(before, 'left', 1);
    assert.ok(added.ok);
    const back = resizeHandmadeMap(added.model, 'left', -1);
    assert.ok(back.ok, back.warning);
    assert.deepEqual(back.model, before, 'round-trip restores the exact model');
  });

  test('TOP add then TOP remove is an identity round-trip', () => {
    const before = richModel();
    const added = resizeHandmadeMap(before, 'top', 1);
    const back = resizeHandmadeMap(added.model, 'top', -1);
    assert.ok(back.ok);
    assert.deepEqual(back.model, before);
  });
});

describe('mission-editor — edge resize guards & purity (item 3)', () => {
  test('removing an edge that holds the hero start is BLOCKED', () => {
    const m = createBlankMapDef(5, 5);
    m.heroStart = { col: 0, row: 2 }; // on the LEFT edge
    const res = resizeHandmadeMap({ mapDef: m, enemyUnits: [], meta: {} }, 'left', -1);
    assert.equal(res.ok, false);
    assert.match(res.warning, /hero start/);
    assert.equal(res.model.mapDef.cols, 5, 'input untouched');
  });

  test('removing an edge that holds a power node is BLOCKED', () => {
    const m = createBlankMapDef(5, 5);
    m.heroStart = { col: 2, row: 2 };
    m.witchStart = { col: 3, row: 3 };
    m.witchObjectives = [{ col: 1, row: 4, hexes: [{ col: 1, row: 4 }], label: 'N' }]; // bottom edge
    const res = resizeHandmadeMap({ mapDef: m, enemyUnits: [], meta: {} }, 'bottom', -1);
    assert.equal(res.ok, false);
    assert.match(res.warning, /power node/);
  });

  test('cannot shrink below 1×1', () => {
    const m = createBlankMapDef(1, 1);
    m.heroStart = { col: 0, row: 0 };
    m.witchStart = { col: 0, row: 0 };
    const res = resizeHandmadeMap({ mapDef: m, enemyUnits: [], meta: {} }, 'right', -1);
    assert.equal(res.ok, false);
    assert.match(res.warning, /1×1/);
  });

  test('resize is PURE — the input model is never mutated', () => {
    const before = richModel();
    const snapshot = JSON.parse(JSON.stringify(before));
    resizeHandmadeMap(before, 'left', 1);
    assert.deepEqual(before, snapshot, 'input untouched after resize');
  });

  test('resize rejects non-handmade maps', () => {
    const md = createOverlayMapDef({ seed: 1, mapSize: 'skirmish' });
    const res = resizeHandmadeMap({ mapDef: md, enemyUnits: [], meta: {} }, 'right', 1);
    assert.equal(res.ok, false);
    assert.match(res.warning, /handmade/);
  });

  test('MAP_EDGES enumerates the four edges', () => {
    assert.deepEqual([...MAP_EDGES].sort(), ['bottom', 'left', 'right', 'top']);
  });
});

describe('mission-editor — overlay map sizing (item 3)', () => {
  test('switching size updates dims and drops out-of-bounds overlay edits', () => {
    const md = createOverlayMapDef({ seed: 1, mapSize: 'standard' }); // 14×14
    // An overlay tile + enemy + survivor near the far corner — in-bounds on the
    // 14×14 standard map but past the edge of the 10×10 skirmish map.
    md.overlay.tiles.push({ col: 12, row: 12, base: 'DIRT', structure: null, path: null, building: null, fortifyLevel: 0, resource: null, hiddenSurvivor: false, roadDirs: [] });
    md.overlay.witchObjectives.push({ col: 13, row: 1, hexes: [{ col: 13, row: 1 }], label: 'N' });
    const model = {
      mapDef: md,
      enemyUnits: [{ type: 'zombie', col: 11, row: 11, overrides: {} }],
      meta: { survivorStartPositions: [{ col: 13, row: 13 }] },
    };
    const res = setOverlayMapSize(model, 'skirmish'); // 10×10
    assert.ok(res.ok);
    assert.equal(res.model.mapDef.mapSize, 'skirmish');
    assert.equal(res.model.mapDef.cols, MAP_SIZES.skirmish.cols);
    assert.equal(res.model.mapDef.overlay.tiles.length, 0, 'col-12 tile dropped');
    assert.equal(res.model.mapDef.overlay.witchObjectives.length, 0, 'col-13 node dropped');
    assert.equal(res.model.enemyUnits.length, 0, 'col-11 enemy dropped');
    assert.equal(res.model.meta.survivorStartPositions.length, 0);
    assert.match(res.warning, /dropped/i);
  });

  test('switching size keeps in-bounds edits and reports no drops', () => {
    const md = createOverlayMapDef({ seed: 1, mapSize: 'standard' });
    md.overlay.tiles.push({ col: 2, row: 2, base: 'FOREST', structure: null, path: null, building: null, fortifyLevel: 0, resource: null, hiddenSurvivor: false, roadDirs: [] });
    const res = setOverlayMapSize({ mapDef: md, enemyUnits: [], meta: {} }, 'regional'); // bigger
    assert.ok(res.ok);
    assert.equal(res.model.mapDef.overlay.tiles.length, 1, 'in-bounds tile kept');
    assert.equal(res.warning, '');
  });

  test('controller.setOverlaySize is undoable', () => {
    const ed = createMissionEditor();
    ed.createNew({ mode: CreationMode.OVERLAY, seed: 1, mapSize: 'standard' });
    const { ok } = ed.setOverlaySize('skirmish');
    assert.ok(ok);
    assert.equal(ed.getDims().cols, MAP_SIZES.skirmish.cols);
    ed.undo();
    assert.equal(ed.getDims().cols, MAP_SIZES.standard.cols);
  });

  test('controller.resizeEdge applies and is undoable; blocked resize is a no-op', () => {
    const ed = createMissionEditor();
    ed.createNew({ mode: CreationMode.BLANK, cols: 6, rows: 6 });
    const grow = ed.resizeEdge('right', 1);
    assert.ok(grow.ok);
    assert.equal(ed.getDims().cols, 7);
    ed.undo();
    assert.equal(ed.getDims().cols, 6);
    // Put a start on the left edge, then a left-remove must be blocked.
    ed.getMapDef().heroStart = { col: 0, row: 3 };
    const blocked = ed.resizeEdge('left', -1);
    assert.equal(blocked.ok, false);
    assert.equal(ed.getDims().cols, 6, 'blocked resize left dims unchanged');
  });
});

// ── Undo / Redo stack semantics (item 5) ──────────────────────────────────────

describe('mission-editor — undo / redo (item 5)', () => {
  test('redo is empty until an undo; undo then redo restores the edit', () => {
    const ed = createMissionEditor();
    assert.equal(ed.canUndo(), false);
    assert.equal(ed.canRedo(), false);
    ed.setActiveTool(EditorTool.PAINT_BASE);
    ed.setPaintValue('base', 'FOREST');
    ed.applyAt({ col: 2, row: 2 });
    assert.ok(ed.canUndo());
    assert.equal(ed.canRedo(), false);
    ed.undo();
    assert.ok(!ed.getMapDef().tiles.some(t => t.col === 2 && t.row === 2), 'edit undone');
    assert.equal(ed.canUndo(), false);
    assert.ok(ed.canRedo(), 'redo now available');
    ed.redo();
    const def = ed.getMapDef().tiles.find(t => t.col === 2 && t.row === 2);
    assert.equal(def.base, 'FOREST', 'edit restored by redo');
    assert.equal(ed.canRedo(), false);
    assert.ok(ed.canUndo());
  });

  test('a NEW action after undo clears the redo stack (standard semantics)', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.PAINT_BASE);
    ed.applyAt({ col: 1, row: 1 });
    ed.applyAt({ col: 2, row: 2 });
    ed.undo();                       // undo the (2,2) edit → redo holds it
    assert.ok(ed.canRedo());
    ed.applyAt({ col: 3, row: 3 });  // new branch
    assert.equal(ed.canRedo(), false, 'new action wiped the redo stack');
    assert.equal(ed.redo(), false, 'redo is a no-op on an empty stack');
  });

  test('undo / redo on empty stacks are no-ops returning false', () => {
    const ed = createMissionEditor();
    assert.equal(ed.undo(), false);
    assert.equal(ed.redo(), false);
  });

  test('redo restores a multi-step sequence in order', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.PAINT_BASE);
    ed.setPaintValue('base', 'DIRT');
    ed.applyAt({ col: 0, row: 0 });
    ed.applyAt({ col: 1, row: 0 });
    ed.undo();
    ed.undo();
    assert.equal(ed.canUndo(), false);
    ed.redo();
    assert.ok(ed.getMapDef().tiles.some(t => t.col === 0 && t.row === 0));
    assert.ok(!ed.getMapDef().tiles.some(t => t.col === 1 && t.row === 0));
    ed.redo();
    assert.ok(ed.getMapDef().tiles.some(t => t.col === 1 && t.row === 0));
  });
});

// ── Dirty tracking — fresh editor is clean (carried-over nit) ──────────────────

describe('mission-editor — dirty flag', () => {
  test('a fresh editor is NOT dirty; an edit dirties it; markClean resets', () => {
    const ed = createMissionEditor();
    assert.equal(ed.isDirty(), false, 'fresh editor starts clean (no spurious New prompt)');
    ed.applyAt({ col: 1, row: 1 });
    assert.equal(ed.isDirty(), true);
    ed.markClean();
    assert.equal(ed.isDirty(), false);
  });

  test('undo / redo mark the model dirty again', () => {
    const ed = createMissionEditor();
    ed.applyAt({ col: 1, row: 1 });
    ed.markClean();
    ed.undo();
    assert.equal(ed.isDirty(), true);
  });
});

// ── Active-tool → VALUE-panel mapping (item 7) ─────────────────────────────────

describe('mission-editor — valuePanelKind (item 7)', () => {
  test('paint tools expose their own value kind', () => {
    assert.equal(valuePanelKind(EditorTool.PAINT_BASE), ToolValueKind.BASE);
    assert.equal(valuePanelKind(EditorTool.PAINT_STRUCTURE), ToolValueKind.STRUCTURE);
    assert.equal(valuePanelKind(EditorTool.SET_RESOURCE), ToolValueKind.RESOURCE);
    assert.equal(valuePanelKind(EditorTool.ENEMY_UNIT), ToolValueKind.ENEMY);
    assert.equal(valuePanelKind(EditorTool.HIDDEN_SURVIVOR), ToolValueKind.SURVIVOR);
  });

  test('value-less tools map to NONE (incl. the split Road / River tools)', () => {
    for (const t of [EditorTool.PAINT_ROAD, EditorTool.PAINT_RIVER,
      EditorTool.HERO_START,
      EditorTool.WITCH_START, EditorTool.ROAD_NODE, EditorTool.POWER_NODE]) {
      assert.equal(valuePanelKind(t), ToolValueKind.NONE);
    }
  });

  test('an unknown tool falls back to NONE', () => {
    assert.equal(valuePanelKind('not-a-tool'), ToolValueKind.NONE);
  });
});

// ── Layer visibility (item 6) ──────────────────────────────────────────────────

describe('mission-editor — layer visibility (item 6)', () => {
  test('default visibility draws structures + nodes + starts, hides marker overlays', () => {
    const layers = createLayerVisibility();
    assert.equal(showStructures(layers), true);
    assert.equal(layers.powerNodes, true);
    assert.equal(layers.playerStarts, true);
    assert.equal(layers.roadNodeMarkers, false);
    assert.equal(layers.areaTriggers, false);
    // item 6 — the "Base only" toggle was removed entirely.
    assert.ok(!('baseOnly' in layers), 'baseOnly toggle removed');
  });

  test('un-checking "Roads + Buildings" hides the structure layer', () => {
    const b = createLayerVisibility(); b.roadsBuildings = false;
    assert.equal(showStructures(b), false);
  });

  test('road-node markers AUTO-SHOW when the Road Node tool is active', () => {
    const layers = createLayerVisibility(); // roadNodeMarkers: false
    assert.equal(roadNodeMarkersVisible(layers, EditorTool.ROAD_NODE), true,
      'auto-shown while authoring road nodes');
    assert.equal(roadNodeMarkersVisible(layers, EditorTool.PAINT_BASE), false,
      'hidden for other tools when the toggle is off');
    layers.roadNodeMarkers = true;
    assert.equal(roadNodeMarkersVisible(layers, EditorTool.PAINT_BASE), true,
      'shown for any tool once the toggle is on');
  });

  test('stripTileOverlays clears structure / path / building / roadDirs, keeps base', () => {
    const tiles = new Map();
    const building = new Tile(1, 1, TileType.DIRT);
    building.structure = StructureType.BUILDING;
    building.building = BuildingType.INN;
    building.roadDirs = new Set([hexKey(1, 2)]);
    const road = new Tile(2, 2, TileType.FOREST);
    road.path = PathType.ROAD;
    road.roadDirs = new Set([hexKey(1, 2)]);
    tiles.set(hexKey(1, 1), building);
    tiles.set(hexKey(2, 2), road);

    stripTileOverlays(tiles);

    const b = tiles.get(hexKey(1, 1));
    assert.equal(b.base, TileType.DIRT, 'base terrain preserved');
    assert.equal(b.structure, null);
    assert.equal(b.building, null);
    assert.equal(b.roadDirs.size, 0);
    const r = tiles.get(hexKey(2, 2));
    assert.equal(r.base, TileType.FOREST, 'base terrain preserved');
    assert.equal(r.path, null);
    assert.equal(r.roadDirs.size, 0);
  });
});

// ── Baked-generated map → assemble → validate → round-trip (carried-over nit) ──

describe('mission-editor — baked map assembles + validates + round-trips', () => {
  test('a Baked-Generated map validates cleanly and survives a load round-trip', () => {
    const ed = createMissionEditor();
    ed.createNew({ mode: CreationMode.BAKED, seed: 7, mapSize: 'skirmish' });
    const mission = ed.assemble();
    assert.equal(mission.map.baked, true, 'baked marker rides along (harmless)');

    // Validates against the schema:1 contract (no throw).
    assert.doesNotThrow(() => loadMissionJSON(mission));

    // Lossless split → reassemble round-trip.
    const reassembled = assembleMission(populateFromMission(mission));
    assert.deepEqual(reassembled, mission);
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
