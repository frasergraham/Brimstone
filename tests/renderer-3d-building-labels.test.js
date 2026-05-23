// Renderer3D building labels — pure-helper tests for the zoom-fade ramp
// and the label-text resolver. The Babylon mesh wiring (DynamicTexture,
// billboarded plane, _pumpBuildingLabelFade walk) is exercised in-browser;
// this file locks the math + content rules that drive it.
//
// 2D parity: src/renderer.js (~line 1684) fades labels via
//   alpha = clamp((effectiveHex - 40) / (60 - 40), 0, 1)
// where bigger effectiveHex = zoomed in. The 3D renderer uses
// ArcRotateCamera radius (smaller = closer), so the formula inverts to
//   alpha = clamp((fadeEnd - radius) / (fadeEnd - fadeStart), 0, 1).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  labelAlphaForZoom,
  labelTextForTile,
  BUILDING_LABEL_FADE_RADIUS_CLOSE,
  BUILDING_LABEL_FADE_RADIUS_FAR,
  BUILDING_LABEL_Y,
} from '../src/renderer-3d.js';

import { TileType, BuildingType, BUILDING_LABEL } from '../src/tiles.js';

describe('labelAlphaForZoom — zoom-fade ramp', () => {
  test('full alpha when camera is at or below fadeStart (close zoom)', () => {
    assert.equal(labelAlphaForZoom(4,  8, 20), 1, 'far below start → 1');
    assert.equal(labelAlphaForZoom(8,  8, 20), 1, 'exactly at start → 1');
    assert.equal(labelAlphaForZoom(0,  8, 20), 1, 'zero radius → 1');
  });

  test('zero alpha when camera is at or beyond fadeEnd (far zoom)', () => {
    assert.equal(labelAlphaForZoom(20, 8, 20), 0, 'exactly at end → 0');
    assert.equal(labelAlphaForZoom(25, 8, 20), 0, 'past end → 0');
    assert.equal(labelAlphaForZoom(100, 8, 20), 0, 'far past end → 0');
  });

  test('linear interpolation between the two thresholds', () => {
    // halfway between 8 and 20 is 14 — alpha should be 0.5
    assert.equal(labelAlphaForZoom(14, 8, 20), 0.5, 'midpoint → 0.5');
    // 3/4 of the way → 1/4 alpha
    assert.equal(labelAlphaForZoom(17, 8, 20), 0.25, '3/4 along → 0.25');
    // 1/4 of the way → 3/4 alpha
    assert.equal(labelAlphaForZoom(11, 8, 20), 0.75, '1/4 along → 0.75');
  });

  test('returned alpha is always clamped to [0, 1]', () => {
    for (const r of [-100, -1, 0, 8, 14, 20, 50, 1000]) {
      const a = labelAlphaForZoom(r, 8, 20);
      assert.ok(a >= 0 && a <= 1, `radius=${r} → alpha=${a} outside [0,1]`);
    }
  });

  test('degenerate fadeStart === fadeEnd is treated as a hard step', () => {
    assert.equal(labelAlphaForZoom(10, 15, 15), 1, 'below → 1');
    assert.equal(labelAlphaForZoom(15, 15, 15), 1, 'at the threshold → 1');
    assert.equal(labelAlphaForZoom(20, 15, 15), 0, 'above → 0');
  });

  test('default thresholds use the exported BUILDING_LABEL_FADE constants', () => {
    assert.equal(
      labelAlphaForZoom(BUILDING_LABEL_FADE_RADIUS_CLOSE),
      1,
      'at CLOSE → full alpha',
    );
    assert.equal(
      labelAlphaForZoom(BUILDING_LABEL_FADE_RADIUS_FAR),
      0,
      'at FAR → zero alpha',
    );
    const mid = (BUILDING_LABEL_FADE_RADIUS_CLOSE + BUILDING_LABEL_FADE_RADIUS_FAR) / 2;
    assert.equal(labelAlphaForZoom(mid), 0.5, 'midpoint → 0.5');
  });
});

describe('labelTextForTile — only buildings get labels', () => {
  test('returns the BUILDING_LABEL entry for each building type', () => {
    for (const key of Object.keys(BUILDING_LABEL)) {
      const tile = { type: TileType.BUILDING, building: key, col: 0, row: 0 };
      assert.equal(labelTextForTile(tile), BUILDING_LABEL[key]);
    }
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

describe('Building-label geometry constants — sanity', () => {
  test('label Y sits above the building roof (roof top ≈ 0.925)', () => {
    assert.ok(BUILDING_LABEL_Y > 0.93,
      `BUILDING_LABEL_Y ${BUILDING_LABEL_Y} should clear the roof`);
  });

  test('close-fade threshold sits inside the camera radius envelope (lower=4, upper=80)', () => {
    assert.ok(BUILDING_LABEL_FADE_RADIUS_CLOSE > 4,
      'CLOSE should be above lowerRadiusLimit so the band is usable when zoomed all the way in');
    assert.ok(BUILDING_LABEL_FADE_RADIUS_FAR < 80,
      'FAR should be below upperRadiusLimit so labels actually fade in real play');
    assert.ok(BUILDING_LABEL_FADE_RADIUS_CLOSE < BUILDING_LABEL_FADE_RADIUS_FAR,
      'CLOSE must be smaller than FAR or the ramp is inverted');
  });
});
