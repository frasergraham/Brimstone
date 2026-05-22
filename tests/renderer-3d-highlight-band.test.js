// Hex highlight Y band — pins the ordering of every ground-level hex
// highlight (per-unit thin / thick outline, move-range highlight disc, plan
// disc, plan line) so they all sit inside one explicit world-Y band that:
//
//   • renders OVER the hex floor (tile prism top Y = 0.075)
//   • renders OVER the road / river ribbons (apex ≈ 0.09 / 0.005)
//   • stays inside `[HEX_HIGHLIGHT_BAND_MIN_Y, HEX_HIGHLIGHT_BAND_MAX_Y]`
//   • shares renderingGroupId 0 with trees / buildings so the depth buffer
//     occludes highlights fronted by taller geometry — the band's upper
//     bound is well below the tree-canopy / building-top Ys so the
//     highlight never physically pokes through the canopy.
//
// Tasks: t-c7c4aeb7 (unify hex highlight Y stack).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEX_HIGHLIGHT_BAND_MIN_Y,
  HEX_HIGHLIGHT_BAND_MAX_Y,
  UNIT_HEX_OUTLINE_Y,
  HIGHLIGHT_DISC_Y,
  PLAN_DISC_Y,
  PLAN_LINE_Y,
  ROAD_RIBBON_Y,
} from '../src/renderer-3d.js';

// Tile prism top — `_buildTileMesh` computes this as 0.43 - 0.7/2 = 0.08 for
// the building anchor; the cylinder prism top is at 0.075 (height 0.15
// centred at y=0). We test against the lower of the two so the band stays
// above both possible "floor" Ys.
const TILE_PRISM_TOP_Y = 0.075;

// Practical road / river ribbon apex — the ribbon Y plus extrusion thickness
// is bounded by ≈ 0.09 at the seat-of-the-tube. We assert highlights clear
// this with headroom rather than z-fight against the tube.
const NETWORK_APEX_Y = 0.09;

describe('Renderer3D — hex highlight Y band', () => {
  test('band is strictly ordered (min < max)', () => {
    assert.ok(HEX_HIGHLIGHT_BAND_MIN_Y < HEX_HIGHLIGHT_BAND_MAX_Y,
      `band min ${HEX_HIGHLIGHT_BAND_MIN_Y} must be < max ${HEX_HIGHLIGHT_BAND_MAX_Y}`);
  });

  test('band sits strictly above the tile prism top', () => {
    assert.ok(HEX_HIGHLIGHT_BAND_MIN_Y > TILE_PRISM_TOP_Y,
      `band min ${HEX_HIGHLIGHT_BAND_MIN_Y} must clear tile prism top ${TILE_PRISM_TOP_Y}`);
  });

  test('band sits strictly above the road/river network apex', () => {
    assert.ok(HEX_HIGHLIGHT_BAND_MIN_Y > NETWORK_APEX_Y,
      `band min ${HEX_HIGHLIGHT_BAND_MIN_Y} must clear network apex ${NETWORK_APEX_Y}`);
    // The road ribbon's tube floor is well below the band, so the highlight
    // ring never tries to occupy the same vertical band as the tube.
    assert.ok(HEX_HIGHLIGHT_BAND_MIN_Y > ROAD_RIBBON_Y + 0.05,
      `band min ${HEX_HIGHLIGHT_BAND_MIN_Y} must clear road ribbon Y ${ROAD_RIBBON_Y} with headroom`);
  });

  test('band ceiling stays well below the tree canopy / building top Ys', () => {
    // Tree leaves and building boxes sit at Y ≥ ~0.4. Highlights at 0.10 –
    // 0.20 are visually inside the building box's vertical footprint, but
    // because both share renderingGroupId 0 the depth buffer fronts the
    // building geometry — the highlight is occluded rather than poking
    // through. Keeping the ceiling under ~0.3 keeps that contract clean.
    assert.ok(HEX_HIGHLIGHT_BAND_MAX_Y < 0.30,
      `band max ${HEX_HIGHLIGHT_BAND_MAX_Y} must stay well under the canopy`);
  });
});

describe('Renderer3D — every hex highlight Y lives in the band', () => {
  // Locking these one-by-one so a tweak to any single Y can't silently slide
  // it out of the band.
  const cases = [
    ['UNIT_HEX_OUTLINE_Y', UNIT_HEX_OUTLINE_Y],
    ['HIGHLIGHT_DISC_Y',   HIGHLIGHT_DISC_Y],
    ['PLAN_DISC_Y',        PLAN_DISC_Y],
    ['PLAN_LINE_Y',        PLAN_LINE_Y],
  ];

  for (const [name, y] of cases) {
    test(`${name} lies inside [BAND_MIN, BAND_MAX]`, () => {
      assert.ok(y >= HEX_HIGHLIGHT_BAND_MIN_Y,
        `${name} ${y} must be >= ${HEX_HIGHLIGHT_BAND_MIN_Y}`);
      assert.ok(y <= HEX_HIGHLIGHT_BAND_MAX_Y,
        `${name} ${y} must be <= ${HEX_HIGHLIGHT_BAND_MAX_Y}`);
    });

    test(`${name} sits above the tile prism top`, () => {
      assert.ok(y > TILE_PRISM_TOP_Y,
        `${name} ${y} must clear tile prism top ${TILE_PRISM_TOP_Y}`);
    });

    test(`${name} sits above the network ribbon apex`, () => {
      assert.ok(y > NETWORK_APEX_Y,
        `${name} ${y} must clear network apex ${NETWORK_APEX_Y}`);
    });
  }

  test('strict stacking order: outline < disc < plan disc < plan line', () => {
    // Outline ring (lowest) ≺ movement-range highlight ≺ plan ghost disc
    // ≺ plan ghost dashed line. Keeps the per-frame draw deterministic and
    // protects against future drift inside the band.
    assert.ok(UNIT_HEX_OUTLINE_Y < HIGHLIGHT_DISC_Y,
      `UNIT_HEX_OUTLINE_Y ${UNIT_HEX_OUTLINE_Y} must be < HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y}`);
    assert.ok(HIGHLIGHT_DISC_Y < PLAN_DISC_Y,
      `HIGHLIGHT_DISC_Y ${HIGHLIGHT_DISC_Y} must be < PLAN_DISC_Y ${PLAN_DISC_Y}`);
    assert.ok(PLAN_DISC_Y < PLAN_LINE_Y,
      `PLAN_DISC_Y ${PLAN_DISC_Y} must be < PLAN_LINE_Y ${PLAN_LINE_Y}`);
  });
});
