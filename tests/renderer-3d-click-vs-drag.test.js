// Drag-vs-click predicate for the 3D renderer's custom pointer input.
//
// Background: in 3D mode the custom pointer handler calls preventDefault on
// pointermove, which suppresses compat mousemove events. That means ui.js's
// own _didDragPan tracker (which listens to mousemove) never trips during a
// 3D pan, and the synthetic `click` that fires on pointerup runs the empty-
// hex deselect path. The renderer therefore owns its own drag verdict via
// `_lastGestureWasDrag`, which ui.js consults in _onClick. These tests
// exercise both the pure helper and the integrated pointer-handler flow.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CLICK_DRAG_THRESHOLD_PX,
  wasClick,
  Renderer3D,
} from '../src/renderer-3d.js';

/** Minimal canvas double — records listeners so tests can dispatch synthetic
 *  pointer events through them. Implements the subset of the DOM canvas API
 *  that _installCustomCameraInput touches. */
function makeFakeCanvas() {
  const listeners = new Map();
  return {
    parentElement: null,
    width: 800,
    height: 600,
    style: {},
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    setPointerCapture() {},
    releasePointerCapture() {},
    _fire(type, ev) {
      const arr = listeners.get(type) || [];
      for (const fn of arr) fn(ev);
    },
  };
}

function makeFakeCamera() {
  return {
    alpha: 0, beta: Math.PI / 4,
    inertialPanningX: 0, inertialPanningY: 0,
    inertialAlphaOffset: 0, inertialBetaOffset: 0, inertialRadiusOffset: 0,
    panningSensibility: 1000,
    lowerRadiusLimit: 4, upperRadiusLimit: 80, radius: 12,
    target: { x: 0, y: 0, z: 0 },
  };
}

function pe(pointerId, clientX, clientY, opts = {}) {
  return {
    pointerId,
    clientX,
    clientY,
    pointerType: opts.pointerType ?? 'mouse',
    button: opts.button ?? 0,
    preventDefault: () => {},
  };
}

// ─── Pure helper ──────────────────────────────────────────────────────────

describe('CLICK_DRAG_THRESHOLD_PX — sane default', () => {
  test('threshold is a few pixels, large enough to forgive shake but tight enough to suppress real drags', () => {
    assert.ok(CLICK_DRAG_THRESHOLD_PX >= 3 && CLICK_DRAG_THRESHOLD_PX <= 12,
      `threshold should be in the 3–12 px range, got ${CLICK_DRAG_THRESHOLD_PX}`);
  });
});

describe('wasClick — drag-vs-click predicate', () => {
  test('exact-same down/up coordinates → click', () => {
    assert.equal(wasClick({ x: 100, y: 100 }, { x: 100, y: 100 }), true);
  });

  test('movement under threshold (Euclidean) → click', () => {
    // 4px right, 3px down = 5px hypot, under 6px default
    assert.equal(wasClick({ x: 0, y: 0 }, { x: 4, y: 3 }), true);
  });

  test('movement at the threshold (exactly) → click (inclusive)', () => {
    assert.equal(wasClick({ x: 0, y: 0 }, { x: 6, y: 0 }), true);
  });

  test('movement past threshold → drag', () => {
    assert.equal(wasClick({ x: 0, y: 0 }, { x: 7, y: 0 }), false);
  });

  test('large diagonal drag → drag', () => {
    assert.equal(wasClick({ x: 50, y: 50 }, { x: 200, y: 300 }), false);
  });

  test('custom threshold overrides the default', () => {
    assert.equal(wasClick({ x: 0, y: 0 }, { x: 8, y: 0 }, 10), true);
    assert.equal(wasClick({ x: 0, y: 0 }, { x: 11, y: 0 }, 10), false);
  });

  test('missing down/up positions → not-a-click (defensive)', () => {
    assert.equal(wasClick(null, { x: 0, y: 0 }), false);
    assert.equal(wasClick({ x: 0, y: 0 }, null), false);
    assert.equal(wasClick(null, null), false);
  });
});

// ─── Integrated pointer-handler flow ──────────────────────────────────────

describe('_installCustomCameraInput — drag verdict published to _lastGestureWasDrag', () => {
  test('stationary mouse pointerdown → pointerup classifies as click (not drag)', () => {
    const canvas = makeFakeCanvas();
    const inst = new Renderer3D(canvas, {});
    inst._installCustomCameraInput(makeFakeCamera());

    canvas._fire('pointerdown', pe(1, 200, 200));
    canvas._fire('pointerup',   pe(1, 200, 200));

    assert.equal(inst._lastGestureWasDrag, false,
      'a click without movement must leave _lastGestureWasDrag false');
  });

  test('tiny pointer wobble within threshold still classifies as click', () => {
    const canvas = makeFakeCanvas();
    const inst = new Renderer3D(canvas, {});
    inst._installCustomCameraInput(makeFakeCamera());

    canvas._fire('pointerdown', pe(1, 200, 200));
    canvas._fire('pointermove', pe(1, 203, 202)); // 3.6px from origin
    canvas._fire('pointerup',   pe(1, 203, 202));

    assert.equal(inst._lastGestureWasDrag, false,
      'movement under the threshold must still register as a click');
  });

  test('mouse drag past threshold classifies as drag', () => {
    const canvas = makeFakeCanvas();
    const inst = new Renderer3D(canvas, {});
    inst._installCustomCameraInput(makeFakeCamera());

    canvas._fire('pointerdown', pe(1, 100, 100));
    canvas._fire('pointermove', pe(1, 130, 140)); // 50px away
    canvas._fire('pointerup',   pe(1, 130, 140));

    assert.equal(inst._lastGestureWasDrag, true,
      'a real pan must set _lastGestureWasDrag so the click handler skips');
  });

  test('drag flag is sticky even if pointer returns near origin before pointerup', () => {
    const canvas = makeFakeCanvas();
    const inst = new Renderer3D(canvas, {});
    inst._installCustomCameraInput(makeFakeCamera());

    canvas._fire('pointerdown', pe(1, 100, 100));
    canvas._fire('pointermove', pe(1, 200, 200)); // far away
    canvas._fire('pointermove', pe(1, 100, 100)); // back to origin
    canvas._fire('pointerup',   pe(1, 100, 100));

    assert.equal(inst._lastGestureWasDrag, true,
      'a circular drag still has the user pan the camera — must classify as drag');
  });

  test('second pointer joining mid-gesture forces drag verdict (multi-touch is never a click)', () => {
    const canvas = makeFakeCanvas();
    const inst = new Renderer3D(canvas, {});
    inst._installCustomCameraInput(makeFakeCamera());

    canvas._fire('pointerdown', pe(1, 100, 100, { pointerType: 'touch' }));
    canvas._fire('pointerdown', pe(2, 110, 100, { pointerType: 'touch' })); // second finger lands
    canvas._fire('pointerup',   pe(2, 110, 100, { pointerType: 'touch' }));
    canvas._fire('pointerup',   pe(1, 100, 100, { pointerType: 'touch' }));

    assert.equal(inst._lastGestureWasDrag, true,
      'pinch/twist gestures must never be treated as a click — even if neither finger moved past threshold');
  });

  test('next gesture starts clean — a click after a drag is still a click', () => {
    const canvas = makeFakeCanvas();
    const inst = new Renderer3D(canvas, {});
    inst._installCustomCameraInput(makeFakeCamera());

    // First gesture: drag
    canvas._fire('pointerdown', pe(1, 100, 100));
    canvas._fire('pointermove', pe(1, 200, 200));
    canvas._fire('pointerup',   pe(1, 200, 200));
    assert.equal(inst._lastGestureWasDrag, true);

    // Second gesture: pure click (ui.js will have consumed/cleared the flag by now)
    inst._lastGestureWasDrag = false; // simulate ui.js consume
    canvas._fire('pointerdown', pe(2, 50, 50));
    canvas._fire('pointerup',   pe(2, 50, 50));
    assert.equal(inst._lastGestureWasDrag, false,
      'fresh gesture must reset the down-position so it does not inherit the previous drag');
  });

  test('pointercancel publishes drag verdict the same as pointerup', () => {
    const canvas = makeFakeCanvas();
    const inst = new Renderer3D(canvas, {});
    inst._installCustomCameraInput(makeFakeCamera());

    canvas._fire('pointerdown',   pe(1, 100, 100));
    canvas._fire('pointermove',   pe(1, 200, 200));
    canvas._fire('pointercancel', pe(1, 200, 200));

    assert.equal(inst._lastGestureWasDrag, true,
      'a cancelled-mid-drag gesture must still mark the verdict so the synthetic click is suppressed');
  });

  test('_lastGestureWasDrag is initialised false before any pointer input', () => {
    const canvas = makeFakeCanvas();
    const inst = new Renderer3D(canvas, {});
    inst._installCustomCameraInput(makeFakeCamera());
    assert.equal(inst._lastGestureWasDrag, false,
      'initial state must be false — no gesture has happened yet');
  });
});
