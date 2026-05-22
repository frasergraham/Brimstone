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
