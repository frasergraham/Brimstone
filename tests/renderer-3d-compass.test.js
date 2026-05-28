// Unit tests for `compassRotationDegFromCameraAlpha` — the pure helper that
// maps Babylon ArcRotateCamera azimuth (alpha, radians) to the CSS-CW degrees
// the compass-rose needle must rotate so its red tip continues pointing at MAP
// NORTH (world -Z).
//
// The math is anchored against `alphaForAxis(1, 0) === -π/2`, which places the
// +X axis horizontally across the screen with attacker (origin) on the left and
// the +X point on the right — i.e. +X is screen-RIGHT at alpha = -π/2. From
// that pin the rest of the projection (screen_right_XZ = (-sin α, cos α),
// screen_up_XZ = (-cos α, -sin α)) and north's projection onto that frame
// follow directly.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { compassRotationDegFromCameraAlpha } from '../src/renderer-3d.js';

const TAU = Math.PI * 2;

/** Normalise an angle to (-180, 180] so we can compare across the wrap. */
function normDeg(d) {
  let v = d % 360;
  if (v <= -180) v += 360;
  if (v > 180) v -= 360;
  return v;
}

describe('compassRotationDegFromCameraAlpha', () => {
  test('non-finite / null alpha → 0 (neutral north-up)', () => {
    assert.equal(compassRotationDegFromCameraAlpha(null), 0);
    assert.equal(compassRotationDegFromCameraAlpha(undefined), 0);
    assert.equal(compassRotationDegFromCameraAlpha(NaN), 0);
    assert.equal(compassRotationDegFromCameraAlpha(Infinity), 0);
    assert.equal(compassRotationDegFromCameraAlpha(-Infinity), 0);
  });

  test('alpha = π/2 → needle up (0°): camera sits south of target looking north', () => {
    // cam pos XZ = (cos(π/2), sin(π/2)) = (0, +1) → south of target.
    // view direction (XZ) = (0, -1) → looking toward map north → north at top.
    const deg = compassRotationDegFromCameraAlpha(Math.PI / 2);
    assert.ok(Math.abs(deg) < 1e-9, `expected ≈0, got ${deg}`);
  });

  test('alpha = -π/2 → 180°: camera north of target looking south, north points DOWN on screen', () => {
    // cam pos XZ = (0, -1) → north of target; view dir = (0, +1) = south.
    // The needle must rotate to point down (CSS rotate ±180° are equivalent).
    const deg = compassRotationDegFromCameraAlpha(-Math.PI / 2);
    assert.equal(Math.abs(normDeg(deg)) > 179.999, true);
  });

  test('alpha = 0 → -90°: needle left (camera east, looking west)', () => {
    // cam pos XZ = (+1, 0). View dir (XZ) = (-1, 0). screen_right_XZ at α=0 is
    // (0, +1) = +Z = south. So north (-Z) lies purely along screen-LEFT.
    const deg = compassRotationDegFromCameraAlpha(0);
    assert.ok(Math.abs(deg - (-90)) < 1e-9, `expected -90, got ${deg}`);
  });

  test('alpha = π → +90°: needle right (camera west, looking east)', () => {
    // cam pos XZ = (-1, 0). View dir = (+1, 0). screen_right_XZ = (0, -1) = -Z
    // = north. So north (-Z) lies purely along screen-RIGHT.
    const deg = compassRotationDegFromCameraAlpha(Math.PI);
    assert.ok(Math.abs(deg - 90) < 1e-9, `expected 90, got ${deg}`);
  });

  test('initial camera (α = -π/4) → -135°: north appears at lower-LEFT', () => {
    // Camera sits at NE quadrant looking SW. With Babylon left-handed coords,
    // north (-Z) projects to lower-left of screen; needle rotates -135° CW
    // from up = 135° CCW from up = lower-left.
    const deg = compassRotationDegFromCameraAlpha(-Math.PI / 4);
    assert.ok(Math.abs(deg - (-135)) < 1e-9, `expected -135, got ${deg}`);
  });

  test('rotation is monotonic in α (modulo 2π) — each +π/8 step rotates the needle by the same Δ in the same direction', () => {
    // The mapping α → θ_deg should be a continuous rotation around the circle,
    // so equal alpha steps yield equal needle-rotation steps. We sample over a
    // full revolution and verify the (wrap-normalised) deltas are equal.
    const STEP = Math.PI / 8;
    let prev = compassRotationDegFromCameraAlpha(0);
    let firstDelta = null;
    for (let i = 1; i <= 16; i++) {
      const cur = compassRotationDegFromCameraAlpha(i * STEP);
      const d = normDeg(cur - prev);
      if (firstDelta == null) firstDelta = d;
      else assert.ok(Math.abs(d - firstDelta) < 1e-9, `step ${i}: Δ=${d} vs first=${firstDelta}`);
      prev = cur;
    }
  });

  test('periodic in α with period 2π', () => {
    for (const a of [0, 0.7, -1.3, Math.PI / 3, -Math.PI / 5]) {
      const base = compassRotationDegFromCameraAlpha(a);
      const wrapped = compassRotationDegFromCameraAlpha(a + TAU);
      assert.ok(Math.abs(normDeg(base - wrapped)) < 1e-9,
        `α=${a}: base=${base} wrapped=${wrapped}`);
    }
  });
});
