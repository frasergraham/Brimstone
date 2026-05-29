// Tests for the building-footprint data model (P0) + serialization/auto-migration (P1).
//
// P0: src/tiles.js gains `footprintHexes` (on entrances) + `buildingFootprintOf`
//     (back-pointer on footprint hexes), plus the predicates isBuildingEntrance /
//     isBuildingFootprint / isBuildingTile.
// P1: server/state-sync.js round-trips both fields and auto-migrates legacy
//     buildings (no footprint) to a single deterministically-chosen footprint hex.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { GameState } from '../src/game.js';
import {
  Tile, TileType, BuildingType,
  isBuildingEntrance, isBuildingFootprint, isBuildingTile,
} from '../src/tiles.js';

function freshState() { return new GameState(true, true); }

// Overwrite a state's tiles with a hand-built set so we control the exact map
// under test, then round-trip through state-sync.
function withTiles(state, tiles) {
  state.tiles = new Map();
  for (const t of tiles) state.tiles.set(`${t.col},${t.row}`, t);
  return state;
}

// ── P0: default fields ───────────────────────────────────────────────────────
describe('building-footprint model — defaults', () => {
  test('new Tile has empty footprintHexes array and null buildingFootprintOf', () => {
    const t = new Tile(3, 4);
    assert.deepEqual(t.footprintHexes, []);
    assert.ok(Array.isArray(t.footprintHexes));
    assert.equal(t.buildingFootprintOf, null);
  });

  test('fields are present even on a building tile (constructed bare)', () => {
    const t = new Tile(0, 0, TileType.BUILDING);
    t.building = BuildingType.INN;
    assert.deepEqual(t.footprintHexes, []);
    assert.equal(t.buildingFootprintOf, null);
  });
});

// ── P0: predicates ───────────────────────────────────────────────────────────
describe('building-footprint model — predicates', () => {
  test('bare grass is none of the three', () => {
    const t = new Tile(0, 0, TileType.GRASS);
    assert.equal(isBuildingEntrance(t), false);
    assert.equal(isBuildingFootprint(t), false);
    assert.equal(isBuildingTile(t), false);
  });

  test('building entrance WITH footprint → entrance + building-tile, not footprint', () => {
    const t = new Tile(2, 2, TileType.BUILDING);
    t.building = BuildingType.CHURCH;
    t.footprintHexes = ['2,3'];
    assert.equal(isBuildingEntrance(t), true);
    assert.equal(isBuildingFootprint(t), false);
    assert.equal(isBuildingTile(t), true);
  });

  test('building entrance WITHOUT footprint (legacy) → none of the three', () => {
    const t = new Tile(2, 2, TileType.BUILDING);
    t.building = BuildingType.CHURCH;
    // footprintHexes left empty → not yet an entrance under the predicate
    assert.equal(isBuildingEntrance(t), false);
    assert.equal(isBuildingFootprint(t), false);
    assert.equal(isBuildingTile(t), false);
  });

  test('footprint hex → footprint + building-tile, not entrance', () => {
    const t = new Tile(2, 3, TileType.GRASS); // base/structure stays whatever it was
    t.buildingFootprintOf = '2,2';
    assert.equal(isBuildingEntrance(t), false);
    assert.equal(isBuildingFootprint(t), true);
    assert.equal(isBuildingTile(t), true);
  });

  test('plain grass adjacent to a building is none of the three', () => {
    const t = new Tile(3, 2, TileType.GRASS);
    assert.equal(isBuildingEntrance(t), false);
    assert.equal(isBuildingFootprint(t), false);
    assert.equal(isBuildingTile(t), false);
  });

  test('predicates are null/undefined tolerant', () => {
    assert.equal(isBuildingEntrance(null), false);
    assert.equal(isBuildingFootprint(undefined), false);
    assert.equal(isBuildingTile(null), false);
  });
});

// ── P1: serialize → deserialize round-trip preserves both fields verbatim ─────
describe('building-footprint serialization — round-trip', () => {
  test('explicit footprint wiring survives serialize → deserialize unchanged', () => {
    const state = freshState();
    const entrance = new Tile(1, 1, TileType.BUILDING);
    entrance.building = BuildingType.INN;
    entrance.footprintHexes = ['0,1'];
    const footprint = new Tile(0, 1, TileType.GRASS);
    footprint.buildingFootprintOf = '1,1';
    const other = new Tile(2, 2, TileType.GRASS);
    withTiles(state, [entrance, footprint, other]);

    const restored = deserializeState(serializeState(state));
    const e = restored.tiles.get('1,1');
    const f = restored.tiles.get('0,1');
    const o = restored.tiles.get('2,2');

    assert.deepEqual(e.footprintHexes, ['0,1']);
    assert.equal(e.buildingFootprintOf, null);
    assert.deepEqual(f.footprintHexes, []);
    assert.equal(f.buildingFootprintOf, '1,1');
    assert.deepEqual(o.footprintHexes, []);
    assert.equal(o.buildingFootprintOf, null);

    // Predicates still classify correctly after the round-trip.
    assert.equal(isBuildingEntrance(e), true);
    assert.equal(isBuildingFootprint(f), true);
  });

  test('serialize emits both fields on every tile', () => {
    const snap = serializeState(freshState());
    for (const t of snap.tiles) {
      assert.ok('footprintHexes' in t, `tile ${t.key} must carry footprintHexes`);
      assert.ok('buildingFootprintOf' in t, `tile ${t.key} must carry buildingFootprintOf`);
      assert.ok(Array.isArray(t.footprintHexes));
    }
  });
});

// ── P1: auto-migration of legacy buildings ────────────────────────────────────
describe('building-footprint serialization — auto-migration', () => {
  // Build a controlled snapshot: a single building entrance surrounded by plain
  // grass, with NO footprint fields yet (simulates a pre-v6 save).
  function legacyBuildingSnap() {
    const state = freshState();
    const tiles = [];
    // Building at (1,1). Row 1 is odd → DIRS_ODD neighbours:
    //   (0,1) (1,0) (2,0) (2,1) (2,2) (1,2)  in direction order 0..5.
    const b = new Tile(1, 1, TileType.BUILDING);
    b.building = BuildingType.INN;
    tiles.push(b);
    for (const [c, r] of [[0,1],[1,0],[2,0],[2,1],[2,2],[1,2]]) {
      tiles.push(new Tile(c, r, TileType.GRASS));
    }
    withTiles(state, tiles);
    const snap = serializeState(state);
    // Strip the footprint fields to mimic a save written before P1.
    for (const t of snap.tiles) {
      delete t.footprintHexes;
      delete t.buildingFootprintOf;
    }
    // No power nodes in this controlled map (generated nodes were discarded by
    // withTiles); clear so no stray node hex affects the deterministic pick.
    snap.witchObjectives = [];
    return snap;
  }

  test('legacy building gets a non-empty footprint + back-pointer on load', () => {
    const restored = deserializeState(legacyBuildingSnap());
    const entrance = restored.tiles.get('1,1');
    assert.ok(entrance.footprintHexes.length > 0, 'entrance must gain a footprint');

    const chosenKey = entrance.footprintHexes[0];
    const chosen = restored.tiles.get(chosenKey);
    assert.ok(chosen, 'chosen footprint hex must exist in-bounds');
    assert.equal(chosen.buildingFootprintOf, '1,1', 'footprint points back at entrance');
    assert.equal(chosen.building, null, 'footprint hex is not itself a building');

    // Deterministic pick: direction 0 = (0,1) is the first eligible neighbour.
    assert.equal(chosenKey, '0,1');

    // Predicates classify the migrated pair correctly.
    assert.equal(isBuildingEntrance(entrance), true);
    assert.equal(isBuildingFootprint(chosen), true);
  });

  test('migration is deterministic — same snapshot loaded twice is identical', () => {
    const a = deserializeState(legacyBuildingSnap());
    const b = deserializeState(legacyBuildingSnap());
    assert.deepEqual(a.tiles.get('1,1').footprintHexes, b.tiles.get('1,1').footprintHexes);
    const ka = a.tiles.get('1,1').footprintHexes[0];
    const kb = b.tiles.get('1,1').footprintHexes[0];
    assert.equal(ka, kb);
    assert.equal(a.tiles.get(ka).buildingFootprintOf, b.tiles.get(kb).buildingFootprintOf);
  });

  test('two adjacent buildings never share a footprint hex', () => {
    const state = freshState();
    const tiles = [];
    const b1 = new Tile(1, 1, TileType.BUILDING); b1.building = BuildingType.INN;
    const b2 = new Tile(1, 3, TileType.BUILDING); b2.building = BuildingType.CHURCH;
    tiles.push(b1, b2);
    // Fill a small neighbourhood with grass.
    for (let r = 0; r <= 4; r++) {
      for (let c = 0; c <= 3; c++) {
        if ((c === 1 && r === 1) || (c === 1 && r === 3)) continue;
        tiles.push(new Tile(c, r, TileType.GRASS));
      }
    }
    withTiles(state, tiles);
    const snap = serializeState(state);
    for (const t of snap.tiles) { delete t.footprintHexes; delete t.buildingFootprintOf; }
    snap.witchObjectives = [];

    const restored = deserializeState(snap);
    const f1 = restored.tiles.get('1,1').footprintHexes[0];
    const f2 = restored.tiles.get('1,3').footprintHexes[0];
    assert.ok(f1 && f2, 'both buildings migrated');
    assert.notEqual(f1, f2, 'footprints must be distinct hexes');
  });

  test('non-river / non-building / non-node eligibility is respected', () => {
    const state = freshState();
    const tiles = [];
    const b = new Tile(1, 1, TileType.BUILDING); b.building = BuildingType.INN;
    tiles.push(b);
    // (0,1) river, (1,0) bridge, (2,0) another building → all ineligible.
    tiles.push(new Tile(0, 1, TileType.RIVER));
    tiles.push(new Tile(1, 0, TileType.BRIDGE));
    const b2 = new Tile(2, 0, TileType.BUILDING); b2.building = BuildingType.HOUSE;
    tiles.push(b2);
    // (2,1) grass — first eligible after the three above are skipped.
    tiles.push(new Tile(2, 1, TileType.GRASS));
    tiles.push(new Tile(2, 2, TileType.GRASS));
    tiles.push(new Tile(1, 2, TileType.GRASS));
    withTiles(state, tiles);
    const snap = serializeState(state);
    for (const t of snap.tiles) { delete t.footprintHexes; delete t.buildingFootprintOf; }

    // Power-node hex: mark (2,1) as a node so it's also excluded → next is (2,2).
    snap.witchObjectives = [{ col: 2, row: 1, label: 'Node', hexes: [{ col: 2, row: 1 }] }];

    const restored = deserializeState(snap);
    const chosen = restored.tiles.get('1,1').footprintHexes[0];
    assert.equal(chosen, '2,2', 'skips river/bridge/building/node → picks (2,2)');
  });
});

// ── P1: orphan building (no eligible neighbour) ───────────────────────────────
describe('building-footprint serialization — orphan', () => {
  let warnings;
  const origWarn = console.warn;
  beforeEach(() => { warnings = []; console.warn = (...a) => warnings.push(a.join(' ')); });
  afterEach(() => { console.warn = origWarn; });

  test('building surrounded by rivers stays footprint-less and warns, no crash', () => {
    const state = freshState();
    const tiles = [];
    const b = new Tile(1, 1, TileType.BUILDING); b.building = BuildingType.GRAVEYARD;
    tiles.push(b);
    // Every neighbour is a river → ineligible.
    for (const [c, r] of [[0,1],[1,0],[2,0],[2,1],[2,2],[1,2]]) {
      tiles.push(new Tile(c, r, TileType.RIVER));
    }
    withTiles(state, tiles);
    const snap = serializeState(state);
    for (const t of snap.tiles) { delete t.footprintHexes; delete t.buildingFootprintOf; }
    snap.witchObjectives = [];

    let restored;
    assert.doesNotThrow(() => { restored = deserializeState(snap); });
    assert.deepEqual(restored.tiles.get('1,1').footprintHexes, []);
    assert.ok(warnings.some(w => w.includes('1,1')), 'orphan warning names the building hex');
  });
});
