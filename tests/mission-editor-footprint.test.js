// Tests for P6 of the building-footprint rework — the Mission Editor's
// place / rotate / delete / validate / serialize handling of building footprints.
//
// A footprinted building is a compound object: a passable ENTRANCE tile (carries
// `building` + a non-empty `footprintHexes` list) plus one impassable FOOTPRINT
// hex adjacent to it (carries `buildingFootprintOf` pointing back at the entrance).
// These exercise the DOM-free editor core + the standalone footprint validator.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EditorTool,
  createMissionEditor,
  createBlankMapDef,
  paintPath,
  paintStructure,
  placeBuildingFootprint,
  rotateFootprint,
  footprintCandidate,
  clearFootprintPair,
  deleteTile,
  snapshotTiles,
  assembleMission,
  populateFromMission,
  saveWip,
  loadWip,
} from '../src/tools/mission-editor.js';
import { getNeighbors, hexKey } from '../src/hex.js';
import { Tile, TileType, BuildingType, StructureType } from '../src/tiles.js';
import {
  validateBuildingFootprints,
  MissionValidationError,
} from '../src/campaign/json-mission.js';

const findDef = (mapDef, col, row) => mapDef.tiles.find(t => t.col === col && t.row === row);
const memStore = () => {
  const m = {};
  return {
    setItem: (k, v) => { m[k] = String(v); },
    getItem: (k) => (k in m ? m[k] : null),
    removeItem: (k) => { delete m[k]; },
    key: (i) => Object.keys(m)[i] ?? null,
    get length() { return Object.keys(m).length; },
  };
};

describe('mission-editor footprint — placement (item 1)', () => {
  test('placing a building auto-claims an eligible adjacent footprint, mutually back-pointing', () => {
    const map = createBlankMapDef(9, 9);
    const res = placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    assert.equal(res.ok, true);

    const entrance = findDef(map, 4, 4);
    assert.equal(entrance.building, 'INN');
    assert.equal(entrance.structure, 'BUILDING');
    assert.equal(entrance.base, 'DIRT', 'building floor defaults to DIRT');
    assert.equal(entrance.footprintHexes.length, 1, 'entrance carries exactly one footprint key');

    const fpKey = entrance.footprintHexes[0];
    // The footprint hex is a real odd-r neighbour of the entrance.
    const nbKeys = getNeighbors(4, 4).map(n => hexKey(n.col, n.row));
    assert.ok(nbKeys.includes(fpKey), 'footprint is an adjacent hex');

    const [fc, fr] = fpKey.split(',').map(Number);
    const fpDef = findDef(map, fc, fr);
    assert.equal(fpDef.buildingFootprintOf, hexKey(4, 4), 'footprint back-points to its entrance');
  });

  test('footprintCandidate is deterministic (first eligible neighbour, dir 0..5)', () => {
    const map = createBlankMapDef(9, 9);
    const a = footprintCandidate(map, { col: 4, row: 4 });
    const b = footprintCandidate(map, { col: 4, row: 4 });
    assert.deepEqual(a, b, 'same map → same candidate');
    // Matches what placement actually claims.
    placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    assert.equal(findDef(map, 4, 4).footprintHexes[0], hexKey(a.col, a.row));
  });

  test('no eligible neighbour (surrounded by river) → no-op, model untouched', () => {
    const map = createBlankMapDef(9, 9);
    for (const n of getNeighbors(4, 4)) paintPath(map, n, 'RIVER');
    const before = JSON.stringify(map.tiles);
    const res = placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    assert.equal(res.ok, false);
    assert.match(res.warning, /no eligible/i);
    assert.ok(!findDef(map, 4, 4), 'no entrance def created');
    assert.equal(JSON.stringify(map.tiles), before, 'tile list unchanged');
  });

  test('re-painting a building TYPE keeps the existing footprint (no new claim)', () => {
    const map = createBlankMapDef(9, 9);
    placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    const fpKey = findDef(map, 4, 4).footprintHexes[0];
    const res = placeBuildingFootprint(map, { col: 4, row: 4 }, 'CHURCH');
    assert.equal(res.ok, true);
    const entrance = findDef(map, 4, 4);
    assert.equal(entrance.building, 'CHURCH');
    assert.deepEqual(entrance.footprintHexes, [fpKey], 'footprint preserved');
  });
});

describe('mission-editor footprint — controller no-op leaves history untouched', () => {
  test('blocked placement adds zero undo steps', () => {
    const ed = createMissionEditor();
    const nbs = getNeighbors(4, 4);
    ed.setActiveTool(EditorTool.PAINT_RIVER);
    for (const n of nbs) ed.applyAt(n); // nbs.length undo steps
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'INN');
    const res = ed.applyAt({ col: 4, row: 4 });
    assert.equal(res.ok, false, 'placement blocked — no eligible footprint');
    assert.ok(!ed.getMapDef().tiles.some(t => t.col === 4 && t.row === 4 && t.building));
    let steps = 0;
    while (ed.canUndo()) { ed.undo(); steps += 1; }
    assert.equal(steps, nbs.length, 'blocked placement added no undo step');
  });

  test('successful placement + undo restores both fields atomically', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'INN');
    ed.applyAt({ col: 4, row: 4 });
    const fpKey = ed.getMapDef().tiles.find(t => t.col === 4 && t.row === 4).footprintHexes[0];
    const [fc, fr] = fpKey.split(',').map(Number);
    // Both entrance + footprint exist after placement.
    assert.ok(ed.getMapDef().tiles.some(t => t.col === fc && t.row === fr && t.buildingFootprintOf));
    ed.undo();
    const after = ed.getMapDef().tiles;
    assert.ok(!after.some(t => t.col === 4 && t.row === 4), 'entrance gone after undo');
    assert.ok(!after.some(t => t.col === fc && t.row === fr && t.buildingFootprintOf),
      'footprint back-pointer gone after undo');
  });
});

describe('mission-editor footprint — rotate (item 2)', () => {
  test('rotate cycles through eligible hexes in direction order; old cleared, new set', () => {
    const map = createBlankMapDef(9, 9);
    placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    const ring = getNeighbors(4, 4).map(n => hexKey(n.col, n.row)); // all eligible on a blank map
    const seen = new Set();
    let cur = findDef(map, 4, 4).footprintHexes[0];
    seen.add(cur);
    for (let i = 0; i < ring.length - 1; i++) {
      const res = rotateFootprint(map, { col: 4, row: 4 });
      assert.equal(res.ok, true);
      const next = findDef(map, 4, 4).footprintHexes[0];
      assert.notEqual(next, cur, 'footprint moved');
      // Old footprint hex no longer back-points.
      const [oc, orow] = cur.split(',').map(Number);
      assert.equal(findDef(map, oc, orow).buildingFootprintOf, null, 'old footprint cleared');
      // New one does.
      const [nc, nr] = next.split(',').map(Number);
      assert.equal(findDef(map, nc, nr).buildingFootprintOf, hexKey(4, 4), 'new footprint set');
      seen.add(next);
      cur = next;
    }
    assert.equal(seen.size, ring.length, 'rotation visited every eligible direction');
  });

  test('rotate with only one eligible hex is a no-op', () => {
    const map = createBlankMapDef(9, 9);
    const nbs = getNeighbors(4, 4);
    // Leave exactly one neighbour open (the rest become impassable river).
    placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    const open = findDef(map, 4, 4).footprintHexes[0];
    for (const n of nbs) {
      const k = hexKey(n.col, n.row);
      if (k !== open) paintPath(map, n, 'RIVER');
    }
    const res = rotateFootprint(map, { col: 4, row: 4 });
    assert.equal(res.ok, false);
    assert.equal(findDef(map, 4, 4).footprintHexes[0], open, 'footprint unchanged');
  });

  test('rotate on a non-building hex is a no-op', () => {
    const map = createBlankMapDef(9, 9);
    const res = rotateFootprint(map, { col: 4, row: 4 });
    assert.equal(res.ok, false);
  });

  test('controller rotateFootprintAt is one undo step', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'INN');
    ed.applyAt({ col: 4, row: 4 });
    const before = ed.getMapDef().tiles.find(t => t.col === 4 && t.row === 4).footprintHexes[0];
    const res = ed.rotateFootprintAt({ col: 4, row: 4 });
    assert.equal(res.ok, true);
    const after = ed.getMapDef().tiles.find(t => t.col === 4 && t.row === 4).footprintHexes[0];
    assert.notEqual(after, before);
    ed.undo(); // undo the rotate only
    assert.equal(ed.getMapDef().tiles.find(t => t.col === 4 && t.row === 4).footprintHexes[0], before);
  });
});

describe('mission-editor footprint — delete / clear (item 4)', () => {
  test('deleting a building entrance clears the footprint hex back-pointer atomically', () => {
    const map = createBlankMapDef(9, 9);
    placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    const fpKey = findDef(map, 4, 4).footprintHexes[0];
    const [fc, fr] = fpKey.split(',').map(Number);
    deleteTile(map, { col: 4, row: 4 });
    assert.equal(findDef(map, 4, 4).building, null, 'entrance cleared');
    assert.deepEqual(findDef(map, 4, 4).footprintHexes, [], 'entrance footprint list emptied');
    assert.equal(findDef(map, fc, fr).buildingFootprintOf, null, 'footprint back-pointer cleared');
  });

  test('clearing a building via paintStructure(null) dissolves the footprint pair', () => {
    const map = createBlankMapDef(9, 9);
    placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    const fpKey = findDef(map, 4, 4).footprintHexes[0];
    const [fc, fr] = fpKey.split(',').map(Number);
    paintStructure(map, { col: 4, row: 4 }, null);
    assert.equal(findDef(map, 4, 4).building, null);
    assert.deepEqual(findDef(map, 4, 4).footprintHexes, []);
    assert.equal(findDef(map, fc, fr).buildingFootprintOf, null);
  });

  test('clearFootprintPair on a footprint hex drops it from its entrance list', () => {
    const map = createBlankMapDef(9, 9);
    placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    const fpKey = findDef(map, 4, 4).footprintHexes[0];
    const [fc, fr] = fpKey.split(',').map(Number);
    clearFootprintPair(map, fc, fr);
    assert.equal(findDef(map, fc, fr).buildingFootprintOf, null);
    assert.deepEqual(findDef(map, 4, 4).footprintHexes, [], 'entrance no longer references it');
  });
});

describe('mission-editor footprint — validation (item 5)', () => {
  const wrap = (tiles) => ({ map: { mode: 'handmade', cols: 9, rows: 9, tiles } });

  test('a valid building+footprint pair passes', () => {
    const map = createBlankMapDef(9, 9);
    placeBuildingFootprint(map, { col: 4, row: 4 }, 'INN');
    assert.doesNotThrow(() => validateBuildingFootprints(wrap(map.tiles)));
  });

  test('a building with empty footprintHexes is rejected', () => {
    const tiles = [{
      col: 1, row: 1, base: 'DIRT', structure: 'BUILDING', path: null,
      building: 'HOUSE', footprintHexes: [], buildingFootprintOf: null, roadDirs: [],
    }];
    assert.throws(() => validateBuildingFootprints(wrap(tiles)),
      (e) => e instanceof MissionValidationError && /no footprintHexes/.test(e.message));
  });

  test('a building whose footprint target lacks the back-pointer is rejected', () => {
    const tiles = [
      {
        col: 1, row: 1, base: 'DIRT', structure: 'BUILDING', path: null,
        building: 'HOUSE', footprintHexes: ['2,1'], buildingFootprintOf: null, roadDirs: [],
      },
      // The footprint target exists but does NOT back-point (broken pair).
      {
        col: 2, row: 1, base: 'GRASS', structure: null, path: null,
        building: null, footprintHexes: [], buildingFootprintOf: null, roadDirs: [],
      },
    ];
    assert.throws(() => validateBuildingFootprints(wrap(tiles)),
      (e) => e instanceof MissionValidationError && /back-point/.test(e.message));
  });

  test('a footprint pointing at a non-existent tile is rejected', () => {
    const tiles = [{
      col: 1, row: 1, base: 'DIRT', structure: 'BUILDING', path: null,
      building: 'HOUSE', footprintHexes: ['7,7'], buildingFootprintOf: null, roadDirs: [],
    }];
    assert.throws(() => validateBuildingFootprints(wrap(tiles)),
      (e) => e instanceof MissionValidationError && /no tile/.test(e.message));
  });
});

describe('mission-editor footprint — serialization (items 6 + 7)', () => {
  test('snapshotTiles round-trips footprintHexes + buildingFootprintOf', () => {
    const tiles = new Map();
    const entrance = new Tile(1, 1, TileType.DIRT);
    entrance.structure = StructureType.BUILDING;
    entrance.building = BuildingType.HOUSE;
    entrance.footprintHexes = ['2,1'];
    tiles.set('1,1', entrance);
    const fp = new Tile(2, 1, TileType.GRASS);
    fp.buildingFootprintOf = '1,1';
    tiles.set('2,1', fp);

    const out = snapshotTiles(tiles);
    const eDef = out.find(t => t.col === 1 && t.row === 1);
    const fDef = out.find(t => t.col === 2 && t.row === 1);
    assert.deepEqual(eDef.footprintHexes, ['2,1']);
    assert.equal(eDef.buildingFootprintOf, null);
    assert.ok(fDef, 'footprint-only hex is NOT dropped as trivial');
    assert.equal(fDef.buildingFootprintOf, '1,1');
    assert.deepEqual(fDef.footprintHexes, []);
  });

  test('download → load round-trip preserves the footprint pair (assemble/populate)', () => {
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'INN');
    ed.applyAt({ col: 4, row: 4 });
    const json = assembleMission({ meta: ed.getMeta(), mapDef: ed.getMapDef(), enemyUnits: [] });
    const round = JSON.parse(JSON.stringify(json)); // simulate download → reload
    const { mapDef } = populateFromMission(round);
    const entrance = mapDef.tiles.find(t => t.col === 4 && t.row === 4);
    const fpKey = entrance.footprintHexes[0];
    const [fc, fr] = fpKey.split(',').map(Number);
    assert.equal(mapDef.tiles.find(t => t.col === fc && t.row === fr).buildingFootprintOf, hexKey(4, 4));
  });

  test('WIP autosave round-trips both footprint fields', () => {
    const store = memStore();
    const ed = createMissionEditor();
    ed.setActiveTool(EditorTool.PAINT_STRUCTURE);
    ed.setPaintValue('structure', 'INN');
    ed.applyAt({ col: 4, row: 4 });
    const entry = saveWip(store, ed.assemble());
    const restored = loadWip(store, entry.id);
    const { mapDef } = populateFromMission(restored.mission);
    const entrance = mapDef.tiles.find(t => t.col === 4 && t.row === 4);
    assert.equal(entrance.footprintHexes.length, 1);
    const [fc, fr] = entrance.footprintHexes[0].split(',').map(Number);
    assert.equal(mapDef.tiles.find(t => t.col === fc && t.row === fr).buildingFootprintOf, hexKey(4, 4));
  });
});
