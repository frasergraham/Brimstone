// Building label text — pure-helper tests for `labelTextForTile`, the resolver
// that decides which buildings get a name (painted on the ground in 3D) and
// what that name reads. The Babylon mesh wiring (DynamicTexture plane, disc,
// `_pumpBuildingGroundLabels` walk) is exercised in tests/building-footprint-
// render.test.js + in-browser; this file locks the content rules.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { labelTextForTile } from '../src/renderer-3d.js';

import { TileType, BuildingType, BUILDING_LABEL } from '../src/tiles.js';

describe('labelTextForTile — only buildings get labels', () => {
  test('returns the BUILDING_LABEL entry for each building type (HOUSE included)', () => {
    for (const key of Object.keys(BUILDING_LABEL)) {
      const tile = { type: TileType.BUILDING, building: key, col: 0, row: 0 };
      assert.equal(labelTextForTile(tile), BUILDING_LABEL[key]);
    }
  });

  test('house buildings get the "House" ground label', () => {
    const tile = { type: TileType.BUILDING, building: 'house', col: 0, row: 0 };
    assert.equal(labelTextForTile(tile), 'House');
    assert.equal(labelTextForTile(tile), BUILDING_LABEL[BuildingType.HOUSE]);
  });

  test('falls back to the raw building id if BUILDING_LABEL has no entry', () => {
    const tile = { type: TileType.BUILDING, building: 'mystery_hut' };
    assert.equal(labelTextForTile(tile), 'mystery_hut');
  });

  test('non-building tile types get no label', () => {
    for (const t of [TileType.GRASS, TileType.DIRT, TileType.FOREST, TileType.RIVER, TileType.ROAD, TileType.BRIDGE]) {
      assert.equal(labelTextForTile({ type: t }), null, `${t} → null`);
    }
  });

  test('a BUILDING tile with no building field gets no label', () => {
    assert.equal(labelTextForTile({ type: TileType.BUILDING }), null);
    assert.equal(labelTextForTile({ type: TileType.BUILDING, building: null }), null);
    assert.equal(labelTextForTile({ type: TileType.BUILDING, building: '' }), null);
  });

  test('null / undefined tile → null', () => {
    assert.equal(labelTextForTile(null), null);
    assert.equal(labelTextForTile(undefined), null);
  });

  test('known landmark buildings resolve to human-readable names', () => {
    assert.equal(
      labelTextForTile({ type: TileType.BUILDING, building: BuildingType.INN }),
      'Inn',
    );
    assert.equal(
      labelTextForTile({ type: TileType.BUILDING, building: BuildingType.GRAVEYARD }),
      'Graveyard',
    );
    assert.equal(
      labelTextForTile({ type: TileType.BUILDING, building: BuildingType.CHURCH }),
      'Church',
    );
  });
});
