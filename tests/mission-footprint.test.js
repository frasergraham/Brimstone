// Tests for building-footprint support in the JSON mission loader (P5 of the
// building-footprint rework).
//
// Covers:
//   • mission-map's _applyTileDef (via loadMissionJSON → buildMissionMap) stores
//     `footprintHexes` on the entrance and `buildingFootprintOf` on the footprint
//     hex, materialising a real footprinted building.
//   • a mission JSON WITH footprints round-trips through loadMissionJSON → game
//     state with footprintHexes / buildingFootprintOf preserved verbatim.
//   • a legacy mission JSON (building, no footprintHexes) loads without crashing
//     and the building stays a 1-hex — the loader does NOT auto-derive footprints
//     (that is the migration script's job, not the loader's).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { loadMissionJSON } from '../src/campaign/json-mission.js';
import { hexKey } from '../src/hex.js';
import {
  TileType, BuildingType, legacyTileType,
  isBuildingEntrance, isBuildingFootprint, tileTotalCapacity,
} from '../src/tiles.js';

// A minimal handmade mission with one INN entrance at (2,2). `footprintTiles`
// controls whether the footprint linkage is authored into the JSON. Returns a
// fresh object each call so tests may mutate freely.
function fixture({ withFootprint }) {
  const innTile = {
    col: 2, row: 2, base: 'DIRT', structure: 'BUILDING', path: null,
    building: 'INN', fortifyLevel: 0, resource: null, hiddenSurvivor: false,
    roadDirs: [],
  };
  const tiles = [innTile];
  if (withFootprint) {
    innTile.footprintHexes = ['2,3'];
    tiles.push({
      col: 2, row: 3, base: 'GRASS', structure: null, path: null,
      building: null, fortifyLevel: 0, resource: null, hiddenSurvivor: false,
      roadDirs: [], buildingFootprintOf: '2,2',
    });
  }
  return {
    schema: 1,
    id: 'fp_fixture',
    title: 'Footprint Fixture',
    chapter: 1,
    campaignId: 'calebs_hollow_prologue',
    requires: null,
    briefing: 'b', victoryText: 'v', defeatText: 'd',
    phaseCycle: { phases: ['dawn', 'day'], loop: true },
    mapSize: 'skirmish',
    hasWitch: false,
    disableScoring: true,
    map: {
      mode: 'handmade',
      cols: 5,
      rows: 5,
      heroStart: { col: 0, row: 0 },
      witchStart: { col: 4, row: 4 },
      witchObjectives: [],
      tiles,
    },
    objectives: {
      win: { type: 'eliminate_all', reason: 'Cleared.' },
      lose: { type: 'hero_killed' },
    },
  };
}

describe('mission loader — building footprints', () => {
  test('_applyTileDef stores footprintHexes and buildingFootprintOf', () => {
    const def = loadMissionJSON(fixture({ withFootprint: true }));
    const map = def.mapBuilderFn();

    const inn = map.tiles.get(hexKey(2, 2));
    assert.equal(legacyTileType(inn), TileType.BUILDING);
    assert.equal(inn.building, BuildingType.INN);
    assert.deepEqual(inn.footprintHexes, ['2,3']);
    assert.equal(inn.buildingFootprintOf, null);
    assert.ok(isBuildingEntrance(inn), 'entrance recognised as a building entrance');

    const fp = map.tiles.get(hexKey(2, 3));
    assert.equal(fp.buildingFootprintOf, '2,2');
    assert.deepEqual(fp.footprintHexes, []);
    assert.ok(isBuildingFootprint(fp), 'neighbour recognised as a footprint hex');
    assert.equal(tileTotalCapacity(fp), 0, 'footprint hex is impassable (0 capacity)');
  });

  test('a footprinted mission round-trips with footprint data preserved', () => {
    // Build twice from the same authored JSON — the resolved footprint linkage
    // must be identical both times (no loss, no auto-mutation).
    const json = fixture({ withFootprint: true });
    const a = loadMissionJSON(json).mapBuilderFn();
    const b = loadMissionJSON(fixture({ withFootprint: true })).mapBuilderFn();

    for (const map of [a, b]) {
      assert.deepEqual(map.tiles.get(hexKey(2, 2)).footprintHexes, ['2,3']);
      assert.equal(map.tiles.get(hexKey(2, 3)).buildingFootprintOf, '2,2');
    }
    // The loader did not mutate the authored JSON's footprintHexes.
    assert.deepEqual(json.map.tiles[0].footprintHexes, ['2,3']);
  });

  test('a legacy building (no footprintHexes) loads as a 1-hex; loader never auto-derives', () => {
    const def = loadMissionJSON(fixture({ withFootprint: false }));
    const map = def.mapBuilderFn();

    const inn = map.tiles.get(hexKey(2, 2));
    assert.equal(inn.building, BuildingType.INN);
    // Constructor defaults survive — the loader leaves a legacy building 1-hex.
    assert.deepEqual(inn.footprintHexes, []);
    assert.equal(inn.buildingFootprintOf, null);
    assert.equal(isBuildingEntrance(inn), false, '1-hex building is not an entrance');

    // No neighbour tile was turned into a footprint by the loader.
    for (const [, t] of map.tiles) {
      assert.equal(isBuildingFootprint(t), false);
    }
  });
});
