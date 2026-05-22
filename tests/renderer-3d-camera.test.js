// Phase 4 of the 3D renderer — pure camera-helper unit tests.
//
// Covers the new exports added in Phase 4:
//   * radiusForFit       — fit a fitWidth × fitDepth rectangle to the viewport
//   * shouldAnimateFocus — predicate that skips no-op focus shifts
//   * computeMapBounds   — extended to verify the N-hex case Phase 4 relies on
//
// All tests are pure (no Babylon, no DOM, no WebGL).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEX_RADIUS_WORLD,
  FOCUS_ANIM_FRAMES,
  FOCUS_EPSILON,
  hexToWorld,
  computeMapBounds,
  radiusForFit,
  radiusForStandardFit,
  shouldAnimateFocus,
} from '../src/renderer-3d.js';
import { MAP_SIZES } from '../src/map.js';

describe('Renderer3D Phase 4 — constants', () => {
  test('FOCUS_ANIM_FRAMES is ~300ms at 60fps', () => {
    // 18 / 60 = 300ms. Tuned for "noticeable but not slow".
    assert.equal(FOCUS_ANIM_FRAMES, 18);
  });

  test('FOCUS_EPSILON is small enough to round-trip but big enough to skip noise', () => {
    assert.ok(FOCUS_EPSILON > 0);
    assert.ok(FOCUS_EPSILON <= 1e-2);
  });
});

describe('Renderer3D Phase 4 — radiusForFit', () => {
  test('returns positive radius for positive dimensions', () => {
    const r = radiusForFit(10, 8, 16 / 9);
    assert.ok(r > 0);
  });

  test('larger fit → larger radius (monotonic)', () => {
    const small = radiusForFit(5, 5, 1);
    const big   = radiusForFit(20, 20, 1);
    assert.ok(big > small);
  });

  test('wider aspect → smaller radius needed for the same width', () => {
    const square    = radiusForFit(10, 1, 1);    // tall viewport
    const widescreen = radiusForFit(10, 1, 2);    // 2× as wide
    // Wider viewport fits the same width with less pull-back.
    assert.ok(widescreen < square);
  });

  test('tall-and-thin fit is dominated by depth term', () => {
    // depth-driven: width tiny, depth huge → rForDepth wins.
    const r = radiusForFit(0.001, 20, 16 / 9, 0.8, 1.0);
    const expectedFromDepth = (20 / 2) / Math.tan(0.8 / 2);
    assert.ok(Math.abs(r - expectedFromDepth) < 1e-6);
  });

  test('margin parameter scales the result', () => {
    const noMargin = radiusForFit(10, 10, 1, 0.8, 1.0);
    const padded   = radiusForFit(10, 10, 1, 0.8, 1.5);
    assert.ok(Math.abs(padded - noMargin * 1.5) < 1e-6);
  });

  test('zero aspect is clamped (no division by zero)', () => {
    const r = radiusForFit(10, 10, 0);
    assert.ok(Number.isFinite(r));
    assert.ok(r > 0);
  });
});

describe('Renderer3D Phase 4 — shouldAnimateFocus', () => {
  const t = (x, y, z) => ({ x, y, z });

  test('identical target+radius → skip (no-op)', () => {
    assert.equal(shouldAnimateFocus(t(1, 0, 2), 25, t(1, 0, 2), 25), false);
  });

  test('large target move → animate', () => {
    assert.equal(shouldAnimateFocus(t(0, 0, 0), 20, t(5, 0, 0), 20), true);
  });

  test('large radius change → animate', () => {
    assert.equal(shouldAnimateFocus(t(0, 0, 0), 20, t(0, 0, 0), 30), true);
  });

  test('sub-epsilon drift → skip', () => {
    const tiny = FOCUS_EPSILON / 10;
    assert.equal(shouldAnimateFocus(t(0, 0, 0), 20, t(tiny, 0, 0), 20 + tiny), false);
  });

  test('handles missing/null targets defensively (initial frame edge)', () => {
    // No throw, treat as "needs animation if any number differs".
    assert.equal(shouldAnimateFocus(null, 20, t(0, 0, 0), 20), false);
    assert.equal(shouldAnimateFocus(null, 20, t(5, 0, 0), 20), true);
  });

  test('custom epsilon respected', () => {
    assert.equal(shouldAnimateFocus(t(0, 0, 0), 20, t(0.5, 0, 0), 20, 1.0), false);
    assert.equal(shouldAnimateFocus(t(0, 0, 0), 20, t(0.5, 0, 0), 20, 0.1), true);
  });
});

describe('Renderer3D Phase 4 — computeMapBounds for frameHexes', () => {
  test('two distant hexes: bounds enclose both centres with hex-footprint padding', () => {
    const a = hexToWorld(0, 0);
    const b = hexToWorld(10, 10);
    const bounds = computeMapBounds([{ col: 0, row: 0 }, { col: 10, row: 10 }]);
    // Both centres strictly inside.
    assert.ok(a.x > bounds.minX && a.x < bounds.maxX);
    assert.ok(b.x > bounds.minX && b.x < bounds.maxX);
    assert.ok(a.z > bounds.minZ && a.z < bounds.maxZ);
    assert.ok(b.z > bounds.minZ && b.z < bounds.maxZ);
    // Centre is the midpoint of the two hex centres (within float tolerance).
    assert.ok(Math.abs(bounds.centerX - (a.x + b.x) / 2) < 1e-9);
    assert.ok(Math.abs(bounds.centerZ - (a.z + b.z) / 2) < 1e-9);
  });

  test('N hex line: bounds depth grows linearly with span', () => {
    const line = [];
    for (let c = 0; c < 7; c++) line.push({ col: c, row: 0 });
    const bounds = computeMapBounds(line);
    const expectedSpanX = Math.sqrt(3) * 6 * HEX_RADIUS_WORLD; // 7 cols at col-step √3
    assert.ok(Math.abs((bounds.maxX - bounds.minX) - (expectedSpanX + Math.sqrt(3) * HEX_RADIUS_WORLD)) < 1e-9);
  });

  test('single hex bounds give a non-degenerate radius when fed to radiusForFit', () => {
    const bounds = computeMapBounds([{ col: 5, row: 5 }]);
    const r = radiusForFit(bounds.width, bounds.depth, 16 / 9);
    assert.ok(r > 0, 'single-hex framing must not collapse to radius 0');
    assert.ok(Number.isFinite(r));
  });
});

describe('Renderer3D — radiusForStandardFit (max-zoom cap)', () => {
  function rectPositions(cols, rows) {
    const out = [];
    for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
      out.push({ col: c, row: r });
    }
    return out;
  }

  test('returns the radius that would frame a standard 13×13 map', () => {
    const aspect = 16 / 9;
    const fov = 0.8;
    const margin = 1.05;
    const paddingHexes = 1;

    const cfg = MAP_SIZES.standard;
    const bounds = computeMapBounds(rectPositions(cfg.cols, cfg.rows));
    const padding = paddingHexes * HEX_RADIUS_WORLD * Math.sqrt(3);
    const expected = radiusForFit(
      bounds.width + 2 * padding,
      bounds.depth + 2 * padding,
      aspect,
      fov,
      margin,
    );

    const got = radiusForStandardFit(aspect, fov, margin, paddingHexes);
    assert.ok(Math.abs(got - expected) < 1e-9, `${got} vs ${expected}`);
  });

  test('positive for typical aspects', () => {
    for (const aspect of [16 / 9, 4 / 3, 1, 0.75, 0.5]) {
      const r = radiusForStandardFit(aspect);
      assert.ok(Number.isFinite(r) && r > 0, `aspect=${aspect} → ${r}`);
    }
  });

  test('narrower aspect → larger radius (need to pull back further to fit width)', () => {
    const wide = radiusForStandardFit(2);
    const square = radiusForStandardFit(1);
    const portrait = radiusForStandardFit(0.5);
    assert.ok(square > wide);
    assert.ok(portrait > square);
  });

  test('clamps the framing radius of a campaign-size map (regression: cap kicks in)', () => {
    // For a campaign map the unclamped fit radius is bigger than the
    // standard-fit cap, so a renderer that clamps via upperRadiusLimit will
    // end up showing only a standard-sized chunk.
    const aspect = 16 / 9;
    const cfg = MAP_SIZES.campaign;
    const bounds = computeMapBounds(rectPositions(cfg.cols, cfg.rows));
    const padding = 1 * HEX_RADIUS_WORLD * Math.sqrt(3);
    const fullR = radiusForFit(
      bounds.width + 2 * padding,
      bounds.depth + 2 * padding,
      aspect,
    );
    const cap = radiusForStandardFit(aspect);
    assert.ok(fullR > cap, `campaign-fit radius ${fullR} must exceed standard cap ${cap}`);

    // What `_radiusForFit` returns after the upper-limit clamp:
    const clamped = Math.min(fullR, cap);
    assert.equal(clamped, cap);
  });

  test('does NOT clamp the framing radius of a skirmish-size map (smaller fits inside cap)', () => {
    // For skirmish 9×9 the unclamped fit radius is smaller than the cap, so
    // it should pass through untouched — small maps still frame to actual extent.
    const aspect = 16 / 9;
    const cfg = MAP_SIZES.skirmish;
    const bounds = computeMapBounds(rectPositions(cfg.cols, cfg.rows));
    const padding = 1 * HEX_RADIUS_WORLD * Math.sqrt(3);
    const fullR = radiusForFit(
      bounds.width + 2 * padding,
      bounds.depth + 2 * padding,
      aspect,
    );
    const cap = radiusForStandardFit(aspect);
    assert.ok(fullR < cap, `skirmish-fit radius ${fullR} must be below standard cap ${cap}`);
    assert.equal(Math.min(fullR, cap), fullR);
  });
});
