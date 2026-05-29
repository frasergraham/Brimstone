// Tilt-on-zoom ramp — pure-helper unit tests for `betaForRadius`.
//
// The 3D camera "rises" toward top-down as it zooms out: it holds the locked
// isometric tilt (CAMERA_BETA_LOCKED) through the near part of the zoom range,
// then eases (smoothstep) up to CAMERA_BETA_TOPDOWN at max zoom-out. These
// tests pin the ramp shape without a Babylon context.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  betaForRadius,
  CAMERA_BETA_LOCKED,
  CAMERA_BETA_TOPDOWN,
  CAMERA_TILT_RAMP_START,
  CAMERA_MIN_ZOOM_RADIUS,
  CAMERA_MAX_ZOOM_RADIUS,
} from '../src/renderer-3d.js';

const BASE = CAMERA_BETA_LOCKED;
const TOP  = CAMERA_BETA_TOPDOWN;
const MIN  = 5;
const MAX  = 25;
const RAMP = CAMERA_TILT_RAMP_START; // 0.4

// radius for a given normalized fraction t of [MIN, MAX]
const rAt = (t) => MIN + t * (MAX - MIN);

describe('betaForRadius — constants sanity', () => {
  test('topdown tilt is closer to overhead than locked, both above 0', () => {
    // ArcRotate beta is measured FROM +Y: 0 = directly overhead, π/2 = horizon.
    // Top-down view means a SMALLER beta than the isometric base.
    assert.ok(TOP < BASE, 'topdown should be a smaller beta than locked');
    assert.ok(TOP > 0, 'topdown should stay off the +Y pole singularity');
    assert.ok(BASE < Math.PI / 2, 'locked should stay short of pure horizon');
  });

  test('ramp start fraction is in [0, 1)', () => {
    // 0 = smoothstep covers the whole zoom range with no flat hold.
    assert.ok(RAMP >= 0 && RAMP < 1);
  });
});

describe('betaForRadius — anchors', () => {
  test('r = min → betaBase', () => {
    assert.equal(betaForRadius(MIN, MIN, MAX, BASE, TOP), BASE);
  });

  test('r = max → betaTopDown', () => {
    assert.ok(Math.abs(betaForRadius(MAX, MIN, MAX, BASE, TOP) - TOP) < 1e-12);
  });
});

describe('betaForRadius — curve shape (not linear)', () => {
  test('r at 0.7 frac → strictly between base and topdown', () => {
    const b = betaForRadius(rAt(0.7), MIN, MAX, BASE, TOP);
    // TOPDOWN < BASE: beta descends from BASE toward TOPDOWN as radius grows.
    assert.ok(b < BASE, 'should have started descending');
    assert.ok(b > TOP, 'should not yet have reached topdown');
  });

  test('r at 0.7 frac → NOT the naive full-range linear value', () => {
    // A wrong implementation — lerp(base, top, t) across the whole range —
    // would give base + 0.7*(top-base). The flat-hold + smoothstep ramp must
    // differ from that, proving it is not a plain linear map.
    const b = betaForRadius(rAt(0.7), MIN, MAX, BASE, TOP);
    const naiveLinear = BASE + 0.7 * (TOP - BASE);
    assert.ok(Math.abs(b - naiveLinear) > 1e-6, 'ramped beta must differ from full-range linear');
  });

  test('logarithmic curve: closer to TOPDOWN than the linear value early in the ramp', () => {
    // With rampStart=0 (default) the ramp spans the entire zoom range, so the
    // renormalized fraction equals t. At t=0.2 the log curve evaluates to
    // ln(1 + 0.2·(e−1)) ≈ 0.295 > 0.2, so beta has progressed FURTHER from
    // BASE toward TOPDOWN than a linear interpolant at the same t —
    // an unmistakable signature of the log curve (steep early, gentle late).
    // Because TOPDOWN < BASE, "further toward TOPDOWN" means a SMALLER beta
    // than the straight-line value at the same t.
    const b = betaForRadius(rAt(0.2), MIN, MAX, BASE, TOP);
    const linear = BASE + 0.2 * (TOP - BASE);
    assert.ok(b < linear && b > TOP, 'log curve should overshoot the linear ramp toward TOPDOWN');
  });

  test('monotonic non-increasing across the zoom range', () => {
    // beta DESCENDS (toward overhead) as the radius grows.
    let prev = Infinity;
    for (let t = 0; t <= 1.0001; t += 0.05) {
      const b = betaForRadius(rAt(Math.min(t, 1)), MIN, MAX, BASE, TOP);
      assert.ok(b <= prev + 1e-12, `beta should not increase as radius grows (t=${t})`);
      prev = b;
    }
  });
});

describe('betaForRadius — clamping & edge cases', () => {
  test('radius below min clamps to betaBase', () => {
    assert.equal(betaForRadius(MIN - 50, MIN, MAX, BASE, TOP), BASE);
  });

  test('radius above max clamps to betaTopDown', () => {
    assert.ok(Math.abs(betaForRadius(MAX + 50, MIN, MAX, BASE, TOP) - TOP) < 1e-12);
  });

  test('degenerate maxR <= minR → betaBase', () => {
    assert.equal(betaForRadius(10, 20, 20, BASE, TOP), BASE, 'maxR === minR');
    assert.equal(betaForRadius(10, 20, 5, BASE, TOP), BASE, 'maxR < minR');
  });

  test('custom rampStart shifts where the rise begins', () => {
    // With rampStart 0.6, t=0.5 is still flat; with default 0.4 it has risen.
    const flat = betaForRadius(rAt(0.5), MIN, MAX, BASE, TOP, 0.6);
    assert.equal(flat, BASE);
    const moved = betaForRadius(rAt(0.5), MIN, MAX, BASE, TOP, 0.4);
    assert.ok(moved < BASE, 'with explicit rampStart=0.4, beta has descended toward topdown');
  });

  test('works with the real camera radius bounds', () => {
    const atMin = betaForRadius(CAMERA_MIN_ZOOM_RADIUS, CAMERA_MIN_ZOOM_RADIUS, CAMERA_MAX_ZOOM_RADIUS, BASE, TOP);
    const atMax = betaForRadius(CAMERA_MAX_ZOOM_RADIUS, CAMERA_MIN_ZOOM_RADIUS, CAMERA_MAX_ZOOM_RADIUS, BASE, TOP);
    assert.equal(atMin, BASE);
    assert.ok(Math.abs(atMax - TOP) < 1e-12);
  });
});
