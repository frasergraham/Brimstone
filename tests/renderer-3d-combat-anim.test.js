// Combat-animation polish coverage — locks down the pure logic from the 3D
// combat-animation stopgap pass:
//   1. camera frames the combat midpoint  (visual — verified in headless Chrome)
//   2. lunge starts from the standee's CURRENT position and slides ~75% toward
//      the target (NO pre-snap pop to hex centre)
//   3. result floaters fire                (visual — verified in headless Chrome)
//   4. addAttackAnim is a no-op (no hex tint)
//
// The Babylon-touching bits (camera animation, floater meshes, tile flash)
// aren't runnable under node-test, so we cover the extractable math + the
// no-op contract here and lean on the headless-Chrome evidence for the rest.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  computeLungeTarget,
  LUNGE_FRACTION,
  LUNGE_MAX_WORLD,
  HEX_RADIUS_WORLD,
  COMBAT_FOCUS_RADIUS,
  SELECTION_FOCUS_RADIUS,
} from '../src/renderer-3d.js';

// ── Lunge geometry (fix #2) ─────────────────────────────────────────────────

describe('Renderer3D combat — computeLungeTarget', () => {
  test('slides LUNGE_FRACTION of the way from current toward target', () => {
    const current = { x: 0, z: 0 };
    const target  = { x: 4, z: 8 };
    const out = computeLungeTarget(current, target, 0.75, Infinity);
    assert.equal(out.x, 3);   // 0 + 0.75*4
    assert.equal(out.z, 6);   // 0 + 0.75*8
  });

  test('starts from the CURRENT position, not a hex centre (no pre-snap pop)', () => {
    // Attacker is mid-slide / off-centre at (1.3, -0.4); the lunge must begin
    // there, NOT jump to some hex centre first.
    const current = { x: 1.3, z: -0.4 };
    const target  = { x: 5.3, z: 3.6 };
    const out = computeLungeTarget(current, target, LUNGE_FRACTION, Infinity);
    // At fraction 0 the endpoint would equal current; here we confirm the
    // endpoint is offset from current by exactly fraction*delta (no snap term).
    assert.ok(Math.abs(out.x - (1.3 + LUNGE_FRACTION * 4)) < 1e-9);
    assert.ok(Math.abs(out.z - (-0.4 + LUNGE_FRACTION * 4)) < 1e-9);
  });

  test('stops SHORT of the target (does not overlap the token)', () => {
    const current = { x: 0, z: 0 };
    const target  = { x: 1, z: 0 };
    const out = computeLungeTarget(current, target);
    assert.ok(out.x < target.x, 'lunge endpoint must stop short of target x');
    assert.ok(out.x > current.x, 'lunge must move toward target');
    // Default fraction is the operator-chosen 0.75.
    assert.equal(out.x, 0.75);
  });

  test('caps a distant lunge at LUNGE_MAX_WORLD — no multi-hex slides', () => {
    // Target 10 world units away (~6 hexes) — the lunge must travel no further
    // than an adjacent-hex strike would, so the attacker never crosses the map.
    const out = computeLungeTarget({ x: 0, z: 0 }, { x: 10, z: 0 });
    assert.ok(Math.abs(out.x - LUNGE_MAX_WORLD) < 1e-9, 'capped at one-hex lunge distance');
    assert.equal(out.z, 0);
  });

  test('cap preserves the lunge direction', () => {
    const out = computeLungeTarget({ x: 0, z: 0 }, { x: 6, z: 8 }); // dist 10
    const d = Math.hypot(out.x, out.z);
    assert.ok(Math.abs(d - LUNGE_MAX_WORLD) < 1e-9, 'displacement length equals the cap');
    assert.ok(Math.abs(out.x / out.z - 6 / 8) < 1e-9, 'direction unchanged');
  });

  test('adjacent-hex lunge is unaffected by the cap', () => {
    // One hex of separation is SQRT3 * HEX_RADIUS_WORLD; 75% of that is
    // exactly the cap, so a normal adjacent strike keeps its full slide.
    const oneHex = Math.sqrt(3) * HEX_RADIUS_WORLD;
    const out = computeLungeTarget({ x: 0, z: 0 }, { x: oneHex, z: 0 });
    assert.ok(Math.abs(out.x - LUNGE_FRACTION * oneHex) < 1e-9);
  });

  test('LUNGE_MAX_WORLD is LUNGE_FRACTION of one hex of separation', () => {
    assert.ok(Math.abs(LUNGE_MAX_WORLD - LUNGE_FRACTION * Math.sqrt(3) * HEX_RADIUS_WORLD) < 1e-12);
  });

  test('defaults to LUNGE_FRACTION when fraction omitted / non-finite', () => {
    const current = { x: 0, z: 0 };
    const target  = { x: 1, z: 1 };
    assert.deepEqual(computeLungeTarget(current, target), computeLungeTarget(current, target, LUNGE_FRACTION));
    assert.deepEqual(computeLungeTarget(current, target, NaN), computeLungeTarget(current, target, LUNGE_FRACTION));
  });

  test('LUNGE_FRACTION is the operator-chosen 0.75', () => {
    assert.equal(LUNGE_FRACTION, 0.75);
  });
});

// ── Combat-focus radius (fix #1) ────────────────────────────────────────────

describe('Renderer3D combat — COMBAT_FOCUS_RADIUS', () => {
  test('is tighter than the selection-focus radius (reads as a lean-in)', () => {
    assert.ok(COMBAT_FOCUS_RADIUS < SELECTION_FOCUS_RADIUS,
      `COMBAT_FOCUS_RADIUS ${COMBAT_FOCUS_RADIUS} should zoom in past SELECTION_FOCUS_RADIUS ${SELECTION_FOCUS_RADIUS}`);
  });

  test('sits within the camera radius limits [4, 80]', () => {
    assert.ok(COMBAT_FOCUS_RADIUS >= 4 && COMBAT_FOCUS_RADIUS <= 80);
  });
});

// ── addAttackAnim no-op (fix #4) ────────────────────────────────────────────

describe('Renderer3D combat — addAttackAnim is a no-op', () => {
  test('does not throw and touches nothing without a scene', () => {
    const inst = Object.create(Renderer3D.prototype);
    inst._scene = null;
    inst._babylon = null;
    assert.doesNotThrow(() => inst.addAttackAnim(0, 0, 1, 1));
  });

  test('does NOT call _flashTile even when a scene is present', () => {
    const inst = Object.create(Renderer3D.prototype);
    inst._scene = {};
    inst._babylon = {};
    let flashed = 0;
    inst._flashTile = () => { flashed += 1; };
    inst.addAttackAnim(2, 2, 3, 3);
    assert.equal(flashed, 0, 'addAttackAnim must not tint tiles in 3D');
  });
});
