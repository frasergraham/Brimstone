// P0 of the tile-model refactor — the layered (base/structure/path) model on
// the Tile class plus the derived legacy `type` get/set shim and predicates.
// The whole point of P0 is transparency: the shim must round-trip every legacy
// TileType losslessly so the rest of the codebase keeps working unchanged.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Tile,
  TileType,
  PathType,
  StructureType,
  BuildingType,
  baseOf,
  pathOf,
  structureOf,
  isRiver,
  isBridge,
  hasBuilding,
  isPathRoadLike,
  isForestCover,
} from '../src/tiles.js';

describe('Tile layered model — get/set type shim', () => {
  test('round-trips every legacy TileType value losslessly', () => {
    for (const v of Object.values(TileType)) {
      const t = new Tile(0, 0);
      t.type = v;
      assert.equal(t.type, v, `round-trip failed for ${v}`);
    }
  });

  test('decomposes base materials into (base, none, none)', () => {
    for (const v of [TileType.GRASS, TileType.FOREST, TileType.DIRT]) {
      const t = new Tile(0, 0);
      t.type = v;
      assert.equal(t.base, v);
      assert.equal(t.structure, null);
      assert.equal(t.path, null);
    }
  });

  test('decomposes road onto the path layer, base unchanged', () => {
    const t = new Tile(0, 0); // default base grass
    t.type = TileType.ROAD;
    assert.equal(t.path, PathType.ROAD);
    assert.equal(t.base, TileType.GRASS);
    assert.equal(t.structure, null);
    assert.equal(t.type, TileType.ROAD);
  });

  test('decomposes river and bridge onto the path layer', () => {
    const r = new Tile(0, 0);
    r.type = TileType.RIVER;
    assert.equal(r.path, PathType.RIVER);
    assert.equal(r.type, TileType.RIVER);

    const b = new Tile(0, 0);
    b.type = TileType.BRIDGE;
    assert.equal(b.path, PathType.BRIDGE);
    assert.equal(b.type, TileType.BRIDGE);
  });

  test('decomposes building onto the structure layer (base → dirt)', () => {
    const t = new Tile(0, 0);
    t.type = TileType.BUILDING;
    assert.equal(t.structure, StructureType.BUILDING);
    assert.equal(t.base, TileType.DIRT);
    assert.equal(t.type, TileType.BUILDING);
  });

  test('road over forest: base forest preserved, type reports road', () => {
    const t = new Tile(0, 0);
    t.base = TileType.FOREST;
    t.path = PathType.ROAD;
    assert.equal(t.type, TileType.ROAD);
    assert.equal(baseOf(t), TileType.FOREST);
  });

  test('precedence: river > bridge > road > building > base', () => {
    const t = new Tile(0, 0);
    t.base = TileType.FOREST;
    t.structure = StructureType.BUILDING;
    t.path = PathType.RIVER;
    assert.equal(t.type, TileType.RIVER);
    t.path = PathType.BRIDGE;
    assert.equal(t.type, TileType.BRIDGE);
    t.path = PathType.ROAD;
    assert.equal(t.type, TileType.ROAD);
    t.path = null;
    assert.equal(t.type, TileType.BUILDING);
    t.structure = null;
    assert.equal(t.type, TileType.FOREST);
  });
});

describe('Tile legacy direct-field writes still work', () => {
  test('setting tile.building (legacy) ⇒ type === building', () => {
    const t = new Tile(0, 0); // grass, no structure marker
    assert.equal(t.type, TileType.GRASS);
    t.building = BuildingType.INN;
    assert.equal(t.type, TileType.BUILDING);
    assert.equal(hasBuilding(t), true);
    assert.equal(structureOf(t), StructureType.BUILDING);
  });

  test('a building tile with roadDirs ⇒ type still building & road-like', () => {
    const t = new Tile(0, 0);
    t.type = TileType.BUILDING;
    t.building = BuildingType.MILL;
    t.roadDirs.add('1,0');
    assert.equal(t.type, TileType.BUILDING); // road-through-building preserved
    assert.equal(isPathRoadLike(t), true);
  });

  test('setting type=building over a pre-existing road reports building', () => {
    // Map gen lays a road (path) on a tile, then a later pass turns it into a
    // building. Legacy `type` is single-valued, so it must report building — the
    // road layer must not shadow it via the getter precedence.
    const t = new Tile(0, 0);
    t.type = TileType.ROAD;
    assert.equal(t.type, TileType.ROAD);
    t.roadDirs.add('1,0'); // connectivity carried separately
    t.type = TileType.BUILDING;
    t.building = BuildingType.CHURCH;
    assert.equal(t.type, TileType.BUILDING);
    assert.equal(t.path, null);             // path cleared
    assert.equal(t.roadDirs.has('1,0'), true); // roadDirs preserved (road-through)
    assert.equal(isPathRoadLike(t), true);
  });

  test('constructor with building type, building assigned after', () => {
    const t = new Tile(2, 3, TileType.BUILDING);
    assert.equal(t.type, TileType.BUILDING); // structure marker set by ctor
    t.building = BuildingType.CHURCH;
    assert.equal(t.type, TileType.BUILDING);
  });
});

describe('Tile predicate helpers', () => {
  function tileOfType(v) {
    const t = new Tile(0, 0);
    t.type = v;
    return t;
  }

  test('isRiver true only for river', () => {
    for (const v of Object.values(TileType)) {
      assert.equal(isRiver(tileOfType(v)), v === TileType.RIVER, `isRiver(${v})`);
    }
  });

  test('isBridge true only for bridge', () => {
    for (const v of Object.values(TileType)) {
      assert.equal(isBridge(tileOfType(v)), v === TileType.BRIDGE, `isBridge(${v})`);
    }
  });

  test('hasBuilding true only for building', () => {
    for (const v of Object.values(TileType)) {
      assert.equal(hasBuilding(tileOfType(v)), v === TileType.BUILDING, `hasBuilding(${v})`);
    }
  });

  test('isPathRoadLike matches old ROAD || BRIDGE || BUILDING inline logic', () => {
    for (const v of Object.values(TileType)) {
      const expected = v === TileType.ROAD || v === TileType.BRIDGE || v === TileType.BUILDING;
      assert.equal(isPathRoadLike(tileOfType(v)), expected, `isPathRoadLike(${v})`);
    }
  });

  test('isForestCover true for forest base even when a road is laid on top', () => {
    // New (locked) behaviour: cover follows the BASE material regardless of path.
    const plainForest = tileOfType(TileType.FOREST);
    assert.equal(isForestCover(plainForest), true);

    const roadOnForest = new Tile(0, 0);
    roadOnForest.base = TileType.FOREST;
    roadOnForest.path = PathType.ROAD;
    assert.equal(isForestCover(roadOnForest), true);
    assert.equal(roadOnForest.type, TileType.ROAD); // type reports road, cover still forest

    const buildingOnForest = new Tile(0, 0);
    buildingOnForest.base = TileType.FOREST;
    buildingOnForest.structure = StructureType.BUILDING;
    assert.equal(isForestCover(buildingOnForest), true);

    // Non-forest bases never give cover.
    assert.equal(isForestCover(tileOfType(TileType.GRASS)), false);
    assert.equal(isForestCover(tileOfType(TileType.DIRT)), false);
    assert.equal(isForestCover(tileOfType(TileType.BUILDING)), false); // base→dirt
  });

  test('accessors tolerate plain (non-Tile) serialized tile objects', () => {
    // deserializeState() rebuilds tiles as plain objects with only `.type`.
    const plain = { type: TileType.GRASS, building: BuildingType.INN };
    assert.equal(baseOf(plain), TileType.GRASS); // no .base ⇒ default
    assert.equal(pathOf(plain), null);
    assert.equal(structureOf(plain), StructureType.BUILDING); // derived from building
    assert.equal(baseOf(undefined), TileType.GRASS);
    assert.equal(structureOf(null), null);
  });
});
