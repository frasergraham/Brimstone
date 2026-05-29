// Tests for the second wave of 3D-renderer playtest polish:
// - Power-node disc: shaft removed; disc saturated and enlarged.
// - Forest tiles: 3..5 trees per tile, deterministic layout, centre clear.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  // Forest helper
  forestTreesForHex,
  FOREST_INNER_RADIUS,
  FOREST_OUTER_RADIUS,
  FOREST_SCALE_MIN,
  FOREST_SCALE_MAX,
  FOREST_TREES_MIN,
  FOREST_TREES_MAX,
  FOREST_DENSITY_SCALE,
  scaledForestTreeCount,
  // Power-node constants
  NODE_GLOW_COLORS,
  NODE_DISC_EMISSIVE_MUL,
  NODE_DISC_DIAMETER,
  NODE_DISC_ALPHA,
} from '../src/renderer-3d.js';

describe('Renderer3D — forestTreesForHex layout', () => {
  test('returns density-scaled FOREST_TREES_MIN..MAX trees for every probed hex', () => {
    // Raw 3–5 range is scaled by FOREST_DENSITY_SCALE (40% fewer trees).
    const lo = scaledForestTreeCount(FOREST_TREES_MIN, FOREST_DENSITY_SCALE);
    const hi = scaledForestTreeCount(FOREST_TREES_MAX, FOREST_DENSITY_SCALE);
    for (let col = -5; col <= 5; col++) {
      for (let row = -5; row <= 5; row++) {
        const t = forestTreesForHex(col, row);
        assert.ok(
          t.length >= lo && t.length <= hi,
          `(${col},${row}) got ${t.length} trees, expected ${lo}..${hi}`,
        );
      }
    }
  });

  test('is stable: same (col, row) returns equal layouts on repeated calls', () => {
    const a = forestTreesForHex(3, 7);
    const b = forestTreesForHex(3, 7);
    assert.deepEqual(a, b);
  });

  test('different hexes produce different layouts (sample of pairs)', () => {
    const a = forestTreesForHex(0, 0);
    const b = forestTreesForHex(1, 0);
    const c = forestTreesForHex(0, 1);
    // Length OR positions must differ — at least one pair must disagree.
    const same = (x, y) =>
      x.length === y.length &&
      x.every((t, i) => t.x === y[i].x && t.z === y[i].z && t.scale === y[i].scale);
    assert.ok(!same(a, b) || !same(a, c), 'expected layout variety across hexes');
  });

  test('all trees sit in the ring [FOREST_INNER_RADIUS, FOREST_OUTER_RADIUS]', () => {
    for (let col = -4; col <= 4; col++) {
      for (let row = -4; row <= 4; row++) {
        for (const t of forestTreesForHex(col, row)) {
          const d = Math.hypot(t.x, t.z);
          assert.ok(
            d >= FOREST_INNER_RADIUS - 1e-9 && d <= FOREST_OUTER_RADIUS + 1e-9,
            `tree at distance ${d} outside [${FOREST_INNER_RADIUS}, ${FOREST_OUTER_RADIUS}]`,
          );
        }
      }
    }
  });

  test('centre region (< FOREST_INNER_RADIUS) is empty across many hexes', () => {
    // Spot-check that no tree ever sits in the standee area.
    let centreHits = 0;
    for (let col = -10; col <= 10; col++) {
      for (let row = -10; row <= 10; row++) {
        for (const t of forestTreesForHex(col, row)) {
          if (Math.hypot(t.x, t.z) < FOREST_INNER_RADIUS - 1e-9) centreHits++;
        }
      }
    }
    assert.equal(centreHits, 0);
  });

  test('per-tree scale stays in [FOREST_SCALE_MIN, FOREST_SCALE_MAX]', () => {
    for (let col = -3; col <= 3; col++) {
      for (let row = -3; row <= 3; row++) {
        for (const t of forestTreesForHex(col, row)) {
          assert.ok(
            t.scale >= FOREST_SCALE_MIN - 1e-9 && t.scale <= FOREST_SCALE_MAX + 1e-9,
            `scale ${t.scale} out of band`,
          );
        }
      }
    }
  });

  test('size variety: across many hexes we see a range of scales (not all equal)', () => {
    const scales = [];
    for (let col = -8; col <= 8; col++) {
      for (let row = -8; row <= 8; row++) {
        for (const t of forestTreesForHex(col, row)) scales.push(t.scale);
      }
    }
    const min = Math.min(...scales);
    const max = Math.max(...scales);
    // We expect a healthy spread, not collapse to a single scale.
    assert.ok(max - min > 0.4, `scale spread too narrow: ${min}..${max}`);
  });
});

describe('Renderer3D — node disc constants (saturated, shaft-free)', () => {
  test('disc emissive multiplier is attenuated so GlowLayer bloom stays tinted', () => {
    // At 1.0 the bright controller hexes (#ffb800, #e8e8e8, #ff6a00) clipped
    // through the GlowLayer's bloom and washed every node to white. Held in
    // [0.2, 0.6] so peak emissive (k ≤ 0.95) stays well below clipping.
    assert.ok(NODE_DISC_EMISSIVE_MUL >= 0.2 && NODE_DISC_EMISSIVE_MUL <= 0.6,
      `expected attenuated multiplier in [0.2, 0.6], got ${NODE_DISC_EMISSIVE_MUL}`);
  });

  test('disc is larger than the historical 1.7 so colour fills the tile', () => {
    assert.ok(NODE_DISC_DIAMETER > 1.7);
  });

  test('disc alpha is high enough to read as solid colour', () => {
    assert.ok(NODE_DISC_ALPHA >= 0.8);
  });

  test('every NODE_GLOW_COLORS entry is a saturated 6-digit hex', () => {
    for (const [key, css] of Object.entries(NODE_GLOW_COLORS)) {
      assert.match(css, /^#[0-9a-f]{6}$/i, `${key} → ${css} not a hex code`);
    }
  });

  test('hero and witch colours are non-grey (saturated)', () => {
    // Saturated means at least one RGB channel differs from another by ≥ 0.3.
    const channels = (css) => [
      parseInt(css.slice(1, 3), 16) / 255,
      parseInt(css.slice(3, 5), 16) / 255,
      parseInt(css.slice(5, 7), 16) / 255,
    ];
    const spread = (rgb) => Math.max(...rgb) - Math.min(...rgb);
    assert.ok(spread(channels(NODE_GLOW_COLORS.hero))      >= 0.3);
    assert.ok(spread(channels(NODE_GLOW_COLORS.witch))     >= 0.3);
    assert.ok(spread(channels(NODE_GLOW_COLORS.contested)) >= 0.3);
  });

  test('NODE_SHAFT_HEIGHT is no longer exported (shaft removed)', async () => {
    const mod = await import('../src/renderer-3d.js');
    assert.equal(mod.NODE_SHAFT_HEIGHT, undefined);
  });
});
