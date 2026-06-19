// Building label text — pure-helper tests for `labelTextForTile`, the resolver
// that decides which buildings get a name (painted on the ground in 3D) and
// what that name reads. The Babylon mesh wiring (DynamicTexture plane, disc,
// `_pumpBuildingGroundLabels` walk) is exercised in tests/building-footprint-
// render.test.js + in-browser; this file locks the content rules.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { labelTextForTile, labelCrossFade } from '../src/renderer-3d.js';

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

describe('labelCrossFade — V-shaped fade-off-old-face/fade-onto-new-face', () => {
  test('first half ramps from → 0, not yet repositioned', () => {
    // from=1, 200ms: alpha 1 at t=0, 0.5 at t=50, ~0 at the midpoint.
    assert.deepEqual(
      labelCrossFade({ from: 1, startMs: 0, durMs: 200, now: 0 }),
      { alpha: 1, repositioned: false },
    );
    assert.deepEqual(
      labelCrossFade({ from: 1, startMs: 0, durMs: 200, now: 50 }),
      { alpha: 0.5, repositioned: false },
    );
    // Just shy of the midpoint: alpha near 0, still on the OLD face.
    const nearMid = labelCrossFade({ from: 1, startMs: 0, durMs: 200, now: 99 });
    assert.ok(nearMid.alpha > 0 && nearMid.alpha < 0.05);
    assert.equal(nearMid.repositioned, false);
  });

  test('at/after the midpoint the plane is repositioned and alpha ramps 0 → 1', () => {
    // Midpoint exactly: alpha 0, now on the NEW face.
    assert.deepEqual(
      labelCrossFade({ from: 1, startMs: 0, durMs: 200, now: 100 }),
      { alpha: 0, repositioned: true },
    );
    assert.deepEqual(
      labelCrossFade({ from: 1, startMs: 0, durMs: 200, now: 150 }),
      { alpha: 0.5, repositioned: true },
    );
    assert.deepEqual(
      labelCrossFade({ from: 1, startMs: 0, durMs: 200, now: 200 }),
      { alpha: 1, repositioned: true },
    );
  });

  test('a fast spin re-targets from a partial alpha without snapping to full', () => {
    // A reversal that starts at alpha 0.5 (label was mid-fade) glides down from
    // 0.5, never popping back to 1 first.
    const start = labelCrossFade({ from: 0.5, startMs: 0, durMs: 200, now: 0 });
    assert.equal(start.alpha, 0.5);
    assert.equal(start.repositioned, false);
    // Quarter into the first half from 0.5 → ~0.25.
    const quarter = labelCrossFade({ from: 0.5, startMs: 0, durMs: 200, now: 50 });
    assert.equal(quarter.alpha, 0.25);
    assert.equal(quarter.repositioned, false);
  });

  test('alpha never strands at 0 — past the end it settles at full', () => {
    assert.deepEqual(
      labelCrossFade({ from: 1, startMs: 0, durMs: 200, now: 9999 }),
      { alpha: 1, repositioned: true },
    );
  });

  test('zero / negative duration snaps to the settled state (alpha 1, repositioned)', () => {
    assert.deepEqual(
      labelCrossFade({ from: 1, startMs: 0, durMs: 0, now: 0 }),
      { alpha: 1, repositioned: true },
    );
    assert.deepEqual(
      labelCrossFade({ from: 0.3, startMs: 0, durMs: -5, now: 10 }),
      { alpha: 1, repositioned: true },
    );
  });
});
