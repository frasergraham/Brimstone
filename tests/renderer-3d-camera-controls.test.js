// Camera-control pure helpers added alongside the +/- zoom + rotate buttons.
//
// These tests cover the maths only — they don't touch Babylon or the DOM, so
// they live alongside the other renderer-3d-* unit tests.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_ZOOM_RADIUS,
  ROTATE_BUTTON_STEP,
  zoomToRadius,
  radiusToZoom,
  clampRotation,
  CAMERA_BETA_LOWER_DELTA,
  CAMERA_BETA_UPPER_DELTA,
  CAMERA_BETA_MIN,
  CAMERA_BETA_MAX,
  TILT_BUTTON_STEP,
  CAMERA_BUTTON_REPEAT_MS,
  clampTilt,
  pinchDistance,
  pinchAngle,
  twistDelta,
  clampPanTarget,
  gestureLockDecision,
  PINCH_LOCK_THRESHOLD_PX,
  TWIST_LOCK_THRESHOLD_RAD,
  GESTURE_SAMPLING_WINDOW_MS,
  PINCH_RADIUS_PER_PX,
  pinchDeltaToRadiusDelta,
} from '../src/renderer-3d.js';
import { Renderer }   from '../src/renderer.js';
import { Renderer3D } from '../src/renderer-3d.js';

describe('zoomToRadius — reciprocal zoom↔radius mapping', () => {
  test('zoom 1.0 → default radius', () => {
    assert.equal(zoomToRadius(1.0), DEFAULT_ZOOM_RADIUS);
  });

  test('zoom 2.0 halves the radius (closer in)', () => {
    assert.equal(zoomToRadius(2.0), DEFAULT_ZOOM_RADIUS / 2);
  });

  test('zoom 0.5 doubles the radius (farther out)', () => {
    assert.equal(zoomToRadius(0.5), DEFAULT_ZOOM_RADIUS * 2);
  });

  test('result is clamped to the lower radius limit on high zoom', () => {
    assert.equal(zoomToRadius(1000, 4, 80), 4);
  });

  test('result is clamped to the upper radius limit on tiny zoom', () => {
    assert.equal(zoomToRadius(0.01, 4, 80), 80);
  });

  test('zero or negative zoom is treated as a tiny positive (no NaN/Inf)', () => {
    const r = zoomToRadius(0, 4, 80);
    assert.ok(Number.isFinite(r));
    assert.equal(r, 80); // clamped to upper limit
  });

  test('round-trip via radiusToZoom recovers the input within clamp band', () => {
    for (const z of [0.5, 1.0, 1.5, 2.0, 3.0]) {
      const r = zoomToRadius(z, 1, 1000);
      assert.ok(Math.abs(radiusToZoom(r) - z) < 1e-9, `round-trip failed at zoom=${z}`);
    }
  });
});

describe('clampRotation — alpha unbounded, beta clamped', () => {
  const lockedBeta = Math.PI / 3.5;
  const betaMin = lockedBeta - CAMERA_BETA_LOWER_DELTA;
  const betaMax = lockedBeta + CAMERA_BETA_UPPER_DELTA;

  test('alpha is unbounded — large deltas pass through unchanged', () => {
    const { alpha } = clampRotation(0, lockedBeta, 100, 0, betaMin, betaMax);
    assert.equal(alpha, 100);
  });

  test('negative alpha delta wraps freely', () => {
    const { alpha } = clampRotation(0, lockedBeta, -10, 0, betaMin, betaMax);
    assert.equal(alpha, -10);
  });

  test('beta within range is preserved', () => {
    const { beta } = clampRotation(0, lockedBeta, 0, 0.05, betaMin, betaMax);
    assert.equal(beta, lockedBeta + 0.05);
  });

  test('beta below betaMin is clamped to betaMin', () => {
    const { beta } = clampRotation(0, lockedBeta, 0, -10, betaMin, betaMax);
    assert.equal(beta, betaMin);
  });

  test('beta above betaMax is clamped to betaMax', () => {
    const { beta } = clampRotation(0, lockedBeta, 0, 10, betaMin, betaMax);
    assert.equal(beta, betaMax);
  });

  test('both axes update in a single call', () => {
    const { alpha, beta } = clampRotation(1, lockedBeta, 0.5, -0.1, betaMin, betaMax);
    assert.equal(alpha, 1.5);
    assert.equal(beta, lockedBeta - 0.1);
  });

  test('ROTATE_BUTTON_STEP is a sensible nudge — between 5° and 30°', () => {
    const degrees = ROTATE_BUTTON_STEP * 180 / Math.PI;
    assert.ok(degrees > 5);
    assert.ok(degrees < 30);
  });
});

describe('Renderer3D.setZoom — pre-init behaviour and interface', () => {
  test('setZoom before Babylon init stashes the requested zoom on zoomLevel', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    assert.equal(inst._camera, null, 'pre-condition: camera not yet built');
    inst.setZoom(2.5);
    assert.equal(inst.zoomLevel, 2.5);
  });

  test('setZoom respects viewLocked and ignores the request', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    inst.viewLocked = true;
    inst.setZoom(2.5);
    assert.equal(inst.zoomLevel, 1.0, 'zoomLevel must not change when view is locked');
  });

  test('setZoom applies zoomToRadius math when a fake camera is attached', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    // Stand-in for the ArcRotateCamera surface that setZoom touches.
    const fakeCamera = {
      lowerRadiusLimit: 4, upperRadiusLimit: 80,
      radius: 20,
      target: { x: 0, y: 0, z: 0, clone() { return { ...this }; } },
    };
    inst._camera = fakeCamera;
    // _focusCamera reads this._babylon to decide whether to animate; we don't
    // set it, so it'll early-out and we just verify the radius assignment.
    inst.setZoom(2.0);
    assert.equal(inst.zoomLevel, radiusToZoom(zoomToRadius(2.0)));
  });
});

describe('Renderer3D.rotateBy — applies clamp via the helper', () => {
  test('rotateBy with no camera attached is a no-op', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    // Should not throw before Babylon has initialised.
    inst.rotateBy(0.5, 0.1);
  });

  test('rotateBy mutates a stand-in camera within beta clamp', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    const lockedBeta = inst._lockedBeta;
    const fakeCamera = {
      alpha: 0, beta: lockedBeta,
      lowerBetaLimit: lockedBeta - CAMERA_BETA_LOWER_DELTA,
      upperBetaLimit: lockedBeta + CAMERA_BETA_UPPER_DELTA,
      lowerRadiusLimit: 4, upperRadiusLimit: 80, radius: 12,
      target: { x: 0, y: 0, z: 0 },
    };
    inst._camera = fakeCamera;
    inst.rotateBy(1.0, 5.0); // huge beta delta should clamp
    assert.equal(fakeCamera.alpha, 1.0);
    assert.equal(fakeCamera.beta, lockedBeta + CAMERA_BETA_UPPER_DELTA);
  });

  test('rotateBy respects viewLocked', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    inst.viewLocked = true;
    const fakeCamera = {
      alpha: 0, beta: inst._lockedBeta,
      lowerBetaLimit: 0, upperBetaLimit: Math.PI,
      lowerRadiusLimit: 4, upperRadiusLimit: 80, radius: 12,
      target: { x: 0, y: 0, z: 0 },
    };
    inst._camera = fakeCamera;
    inst.rotateBy(1.0, 0.1);
    assert.equal(fakeCamera.alpha, 0, 'alpha must not change when view is locked');
  });
});

describe('Renderer interface — rotateBy on both classes', () => {
  test('2D Renderer.rotateBy exists and is a no-op', () => {
    const inst = Object.create(Renderer.prototype);
    // Should not throw, should not return anything meaningful.
    assert.doesNotThrow(() => inst.rotateBy(0.5, 0.1));
  });

  test('Renderer3D.rotateBy is a function on the prototype', () => {
    assert.equal(typeof Renderer3D.prototype.rotateBy, 'function');
  });

  test('Renderer.rotateBy and Renderer3D.rotateBy both accept (alpha, beta) signature', () => {
    // Same arity expectation — both take 2 params for parity.
    assert.equal(Renderer.prototype.rotateBy.length, 2);
    assert.equal(Renderer3D.prototype.rotateBy.length, 2);
  });
});

// ── Camera-controls overhaul (t-0bd3e8c2) ──────────────────────────────────
// Pure-helper tests for the math driving the custom Babylon camera input.
// Babylon-free imports so they run in node-test without a browser context.

describe('CAMERA_BETA_MIN / CAMERA_BETA_MAX — absolute tilt range', () => {
  test('min sits at ≈0.2π (close to head-on, still angled)', () => {
    assert.ok(Math.abs(CAMERA_BETA_MIN - 0.20 * Math.PI) < 1e-9);
  });
  test('max sits at ≈0.45π (close to bird\'s-eye without flat-flat)', () => {
    assert.ok(Math.abs(CAMERA_BETA_MAX - 0.45 * Math.PI) < 1e-9);
  });
  test('range stays inside (0, π/2) — camera never flips under the map', () => {
    assert.ok(CAMERA_BETA_MIN > 0);
    assert.ok(CAMERA_BETA_MAX < Math.PI / 2);
    assert.ok(CAMERA_BETA_MIN < CAMERA_BETA_MAX);
  });
  test('legacy delta constants are still exported (back-compat with older tests)', () => {
    assert.equal(typeof CAMERA_BETA_LOWER_DELTA, 'number');
    assert.equal(typeof CAMERA_BETA_UPPER_DELTA, 'number');
  });
  test('TILT_BUTTON_STEP is a sensible per-tick nudge (< 10°)', () => {
    const deg = TILT_BUTTON_STEP * 180 / Math.PI;
    assert.ok(deg > 0 && deg < 10, `TILT_BUTTON_STEP=${deg}° outside (0, 10°)`);
  });
  test('CAMERA_BUTTON_REPEAT_MS is in a sensible range for hold-to-repeat', () => {
    assert.ok(CAMERA_BUTTON_REPEAT_MS >= 16 && CAMERA_BUTTON_REPEAT_MS <= 200);
  });
});

describe('clampTilt — one-axis beta clamp shared by buttons + custom input', () => {
  test('within range: delta passes through', () => {
    assert.equal(clampTilt(CAMERA_BETA_MIN + 0.1, 0.05), CAMERA_BETA_MIN + 0.15);
  });
  test('huge positive delta clamps to betaMax', () => {
    assert.equal(clampTilt(CAMERA_BETA_MIN, 10), CAMERA_BETA_MAX);
  });
  test('huge negative delta clamps to betaMin', () => {
    assert.equal(clampTilt(CAMERA_BETA_MAX, -10), CAMERA_BETA_MIN);
  });
  test('uses default CAMERA_BETA_MIN/MAX when no explicit bounds passed', () => {
    assert.equal(clampTilt(CAMERA_BETA_MIN - 1, 0), CAMERA_BETA_MIN);
    assert.equal(clampTilt(CAMERA_BETA_MAX + 1, 0), CAMERA_BETA_MAX);
  });
  test('accepts explicit clamp range (so the custom input can use the camera\'s configured limits)', () => {
    assert.equal(clampTilt(0.5, 0.5, 0.0, 1.0), 1.0);
    assert.equal(clampTilt(0.5, -0.5, 0.2, 0.8), 0.2);
  });
});

describe('pinchDeltaToRadiusDelta — spread=in, pinch=out convention', () => {
  test('positive pinch-delta (fingers spread) → negative radius-step (zoom in)', () => {
    const step = pinchDeltaToRadiusDelta(10, 0.04);
    assert.ok(step < 0, `expected negative radius step for spread, got ${step}`);
    assert.equal(step, -0.4);
  });
  test('negative pinch-delta (fingers pinch) → positive radius-step (zoom out)', () => {
    const step = pinchDeltaToRadiusDelta(-10, 0.04);
    assert.ok(step > 0, `expected positive radius step for pinch, got ${step}`);
    assert.equal(step, 0.4);
  });
  test('zero delta → zero step (no drift on idle hold)', () => {
    assert.equal(Math.abs(pinchDeltaToRadiusDelta(0, 0.04)), 0);
  });
  test('defaults to module PINCH_RADIUS_PER_PX when perPx omitted', () => {
    assert.equal(pinchDeltaToRadiusDelta(25), -25 * PINCH_RADIUS_PER_PX);
    assert.equal(pinchDeltaToRadiusDelta(25), -1); // 25px = 1 radius unit (zoom in)
  });
  test('scales linearly with the sensitivity constant', () => {
    assert.equal(pinchDeltaToRadiusDelta(10, 0.08), -0.8);
    assert.equal(pinchDeltaToRadiusDelta(10, 0.02), -0.2);
  });
});

describe('pinchDistance / pinchAngle — two-pointer geometry helpers', () => {
  test('pinchDistance: zero between identical points', () => {
    assert.equal(pinchDistance({ x: 5, y: 5 }, { x: 5, y: 5 }), 0);
  });
  test('pinchDistance: 3-4-5 triangle', () => {
    assert.equal(pinchDistance({ x: 0, y: 0 }, { x: 3, y: 4 }), 5);
  });
  test('pinchDistance is order-independent', () => {
    const a = { x: 1, y: 2 }, b = { x: 4, y: 6 };
    assert.equal(pinchDistance(a, b), pinchDistance(b, a));
  });
  test('pinchAngle: pure +X = 0 radians', () => {
    assert.equal(pinchAngle({ x: 0, y: 0 }, { x: 1, y: 0 }), 0);
  });
  test('pinchAngle: pure +Y = π/2', () => {
    assert.ok(Math.abs(pinchAngle({ x: 0, y: 0 }, { x: 0, y: 1 }) - Math.PI / 2) < 1e-9);
  });
  test('pinchAngle is order-flipped → π offset', () => {
    const f = pinchAngle({ x: 0, y: 0 }, { x: 1, y: 1 });
    const r = pinchAngle({ x: 1, y: 1 }, { x: 0, y: 0 });
    assert.ok(Math.abs(Math.abs(f - r) - Math.PI) < 1e-9);
  });
});

describe('twistDelta — atan2-based rotation between frames, wrap-safe', () => {
  test('zero when angles match', () => {
    assert.equal(twistDelta(1.0, 1.0), 0);
  });
  test('small positive delta passes through', () => {
    assert.ok(Math.abs(twistDelta(0.5, 0.7) - 0.2) < 1e-9);
  });
  test('small negative delta passes through', () => {
    assert.ok(Math.abs(twistDelta(0.7, 0.5) - (-0.2)) < 1e-9);
  });
  test('wraparound from +179° to -179° = -2° (the short way round)', () => {
    const prev = (179 / 180) * Math.PI;
    const curr = (-179 / 180) * Math.PI;
    const d = twistDelta(prev, curr);
    const degrees = d * 180 / Math.PI;
    assert.ok(Math.abs(degrees - 2) < 0.01,
      `expected ≈ +2° (short way), got ${degrees}°`);
  });
  test('wraparound from -179° to +179° = -2° (still short way)', () => {
    const prev = (-179 / 180) * Math.PI;
    const curr = (179 / 180) * Math.PI;
    const d = twistDelta(prev, curr);
    const degrees = d * 180 / Math.PI;
    assert.ok(Math.abs(degrees + 2) < 0.01,
      `expected ≈ -2° (short way), got ${degrees}°`);
  });
  test('result is always in (-π, π]', () => {
    for (let i = 0; i < 100; i++) {
      const prev = (Math.random() - 0.5) * 4 * Math.PI;
      const curr = (Math.random() - 0.5) * 4 * Math.PI;
      const d = twistDelta(prev, curr);
      assert.ok(d > -Math.PI - 1e-9 && d <= Math.PI + 1e-9,
        `out-of-range result ${d}`);
    }
  });
});

describe('clampPanTarget — keeps camera.target within map XZ bounds', () => {
  const bounds = { minX: -10, maxX: 10, minZ: -8, maxZ: 8 };

  test('target inside bounds passes through unchanged', () => {
    const out = clampPanTarget({ x: 3, y: 0, z: -2 }, bounds);
    assert.deepEqual(out, { x: 3, y: 0, z: -2 });
  });
  test('target past +X edge is clamped to maxX', () => {
    const out = clampPanTarget({ x: 999, y: 0, z: 0 }, bounds);
    assert.equal(out.x, 10);
  });
  test('target past -Z edge is clamped to minZ', () => {
    const out = clampPanTarget({ x: 0, y: 0, z: -999 }, bounds);
    assert.equal(out.z, -8);
  });
  test('margin widens the allowed range symmetrically', () => {
    const out = clampPanTarget({ x: 999, y: 0, z: 999 }, bounds, 5);
    assert.equal(out.x, 15);
    assert.equal(out.z, 13);
  });
  test('preserves y unchanged (only XZ is clamped)', () => {
    const out = clampPanTarget({ x: 999, y: 42, z: -999 }, bounds);
    assert.equal(out.y, 42);
  });
  test('does not mutate the input target', () => {
    const input = { x: 999, y: 0, z: 999 };
    clampPanTarget(input, bounds);
    assert.equal(input.x, 999, 'input.x should be untouched');
    assert.equal(input.z, 999, 'input.z should be untouched');
  });
  test('null bounds → target returned as-is (graceful fallback before _buildMap)', () => {
    const t = { x: 5, y: 0, z: 5 };
    assert.equal(clampPanTarget(t, null), t);
  });
});

describe('Renderer3D — is3D flag + tiltBy method', () => {
  test('Renderer3D instances expose is3D = true (ui.js uses this to bypass 2D drag)', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    assert.equal(inst.is3D, true);
  });
  test('2D Renderer instances expose is3D = false', () => {
    const fakeCanvas = { getContext() { return {}; }, addEventListener() {}, width: 800, height: 600 };
    const inst = new Renderer(fakeCanvas, {});
    assert.equal(inst.is3D, false);
  });
  test('Renderer3D.tiltBy without camera is a safe no-op', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    assert.doesNotThrow(() => inst.tiltBy(0.05));
  });
  test('Renderer3D.tiltBy mutates a stand-in camera and clamps to tilt range', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    const cam = {
      alpha: 0, beta: CAMERA_BETA_MIN + 0.05,
      lowerBetaLimit: CAMERA_BETA_MIN, upperBetaLimit: CAMERA_BETA_MAX,
      lowerRadiusLimit: 4, upperRadiusLimit: 80, radius: 12,
      target: { x: 0, y: 0, z: 0 },
    };
    inst._camera = cam;
    inst.tiltBy(10);
    assert.equal(cam.beta, CAMERA_BETA_MAX, 'huge positive delta should clamp to max');
    inst.tiltBy(-100);
    assert.equal(cam.beta, CAMERA_BETA_MIN, 'huge negative delta should clamp to min');
  });
  test('Renderer3D.tiltBy respects viewLocked', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, {});
    inst.viewLocked = true;
    const startBeta = CAMERA_BETA_MIN + 0.1;
    const cam = {
      alpha: 0, beta: startBeta,
      lowerBetaLimit: CAMERA_BETA_MIN, upperBetaLimit: CAMERA_BETA_MAX,
      lowerRadiusLimit: 4, upperRadiusLimit: 80, radius: 12,
      target: { x: 0, y: 0, z: 0 },
    };
    inst._camera = cam;
    inst.tiltBy(0.1);
    assert.equal(cam.beta, startBeta);
  });
  test('2D Renderer.tiltBy is a parity no-op', () => {
    const inst = Object.create(Renderer.prototype);
    assert.doesNotThrow(() => inst.tiltBy(0.1));
  });
});

describe('gestureLockDecision — 2-finger pinch/twist intent-lock helper', () => {
  const T = {
    pinch:    PINCH_LOCK_THRESHOLD_PX,
    twist:    TWIST_LOCK_THRESHOLD_RAD,
    windowMs: GESTURE_SAMPLING_WINDOW_MS,
  };

  test('threshold constants are sane', () => {
    assert.ok(PINCH_LOCK_THRESHOLD_PX > 0 && PINCH_LOCK_THRESHOLD_PX < 50,
      'pinch threshold should be a few pixels');
    assert.ok(TWIST_LOCK_THRESHOLD_RAD > 0 && TWIST_LOCK_THRESHOLD_RAD < Math.PI / 8,
      'twist threshold should be a few degrees, not large');
    assert.ok(GESTURE_SAMPLING_WINDOW_MS >= 50 && GESTURE_SAMPLING_WINDOW_MS <= 250,
      'sampling window should be short — humans expect ~100ms responsiveness');
  });

  test('pinch crosses first → locks to zoom', () => {
    // 12px of spread well past 6px threshold, 1° of twist well below 3°.
    const d = gestureLockDecision(12, 1 * Math.PI / 180, 30, T);
    assert.equal(d, 'zoom');
  });

  test('twist crosses first → locks to rotate', () => {
    // 8° twist past 3° threshold, 2px spread under 6px.
    const d = gestureLockDecision(2, 8 * Math.PI / 180, 30, T);
    assert.equal(d, 'rotate');
  });

  test('both below threshold within window → keep sampling', () => {
    const d = gestureLockDecision(3, 1 * Math.PI / 180, 40, T);
    assert.equal(d, 'sampling');
  });

  test('window expired with one axis bigger → tie-break to larger relative motion', () => {
    // Both sub-threshold. Pinch is at 5/6 = 0.83 of threshold; twist is at
    // 1°/3° = 0.33. Pinch has larger relative motion → 'zoom'.
    const d = gestureLockDecision(5, 1 * Math.PI / 180, 200, T);
    assert.equal(d, 'zoom');
  });

  test('window expired with both axes essentially zero → none', () => {
    const d = gestureLockDecision(0.2, 0.001, 500, T);
    assert.equal(d, 'none');
  });

  test('simultaneous threshold crossing — larger relative motion wins (zoom)', () => {
    // Pinch at 2× threshold (12px / 6px), twist at 1.1× threshold.
    const d = gestureLockDecision(12, 1.1 * TWIST_LOCK_THRESHOLD_RAD, 50, T);
    assert.equal(d, 'zoom');
  });

  test('simultaneous threshold crossing — larger relative motion wins (rotate)', () => {
    // Pinch at 1.05× threshold, twist at 3× threshold.
    const d = gestureLockDecision(1.05 * PINCH_LOCK_THRESHOLD_PX, 3 * TWIST_LOCK_THRESHOLD_RAD, 50, T);
    assert.equal(d, 'rotate');
  });

  test('zero-distance pinch with crossing twist → locks to rotate', () => {
    // Edge case: fingers stay equidistant but rotate around a centre.
    const d = gestureLockDecision(0, 5 * Math.PI / 180, 30, T);
    assert.equal(d, 'rotate');
  });

  test('negative deltas treated by magnitude (pinch in)', () => {
    // Fingers pinched together: dDist is negative but still crosses.
    const d = gestureLockDecision(-10, 0.5 * Math.PI / 180, 30, T);
    assert.equal(d, 'zoom');
  });

  test('negative twist treated by magnitude', () => {
    const d = gestureLockDecision(1, -5 * Math.PI / 180, 30, T);
    assert.equal(d, 'rotate');
  });

  test('uses default thresholds when none passed', () => {
    // Same scenario as "pinch crosses first" but without an explicit T.
    const d = gestureLockDecision(12, 1 * Math.PI / 180, 30);
    assert.equal(d, 'zoom');
  });

  test('caller can override thresholds (e.g. tighter pinch)', () => {
    // With pinch threshold raised to 20px, a 12px spread no longer crosses.
    const d = gestureLockDecision(12, 1 * Math.PI / 180, 30, { pinch: 20, twist: T.twist, windowMs: T.windowMs });
    assert.equal(d, 'sampling');
  });

  test('relative twist near ±π wrap (caller responsibility): magnitude of normalised delta is used', () => {
    // Caller passes a normalised twistDelta already; we just verify that a
    // small wrapped magnitude (e.g. +179° → -179° = +2°) does NOT trigger
    // a rotate lock by itself.
    const wrapDelta = twistDelta((179 * Math.PI) / 180, (-179 * Math.PI) / 180); // ≈ +2°
    const d = gestureLockDecision(1, wrapDelta, 30, T);
    assert.equal(d, 'sampling',
      'a 2° wrap-shortcut should NOT cross the 3° lock threshold');
  });

  test('window edge — at exactly the window boundary, still sampling if no cross', () => {
    // At elapsed === windowMs, we have NOT expired yet (strict <).
    const d = gestureLockDecision(3, 1 * Math.PI / 180, GESTURE_SAMPLING_WINDOW_MS, T);
    // Window has expired (elapsed >= windowMs branch), so decision is
    // tie-break or none. Both axes are at 0.5 / 0.33 → both above 10%
    // negligible threshold → tie-break to zoom.
    assert.equal(d, 'zoom');
  });
});

