// Tests for the 3D renderer's death fade-out (Task 2). Exercises the REAL
// Renderer3D prototype methods via Object.create — no Babylon context needed,
// since the fade math + standee-opacity walk operate on plain mesh-like stubs.
//
// Behaviour under test: a killed unit's standee (model body + floating icon
// badge, both parented under the cone) ramps to invisible over the killing
// action, and the pump must NOT dispose at opacity 0 (the entity is still
// `alive` in the round's display snapshot, so disposing would let
// _syncEntityStandees rebuild it next frame).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { Renderer3D, stagedDeathOpacity } from '../src/renderer-3d.js';

// A mesh stub that records visibility writes. getChildMeshes returns the
// descendants we want the fade to touch (rig clone body + icon badge).
function mesh() { return { visibility: 1 }; }

function makeStandee() {
  const body1 = mesh();      // rig clone child mesh
  const body2 = mesh();      // rig clone child mesh
  const badge = mesh();      // floating unit-icon plane (parented under cone)
  const sphereHead = mesh(); // sphere descendant
  const cone = { visibility: 0, getChildMeshes: () => [body1, body2, badge] };
  const sphere = { visibility: 0, getChildMeshes: () => [sphereHead] };
  return { standee: { plane: cone, sphere }, meshes: { body1, body2, badge, sphereHead } };
}

function makeInst() {
  const inst = Object.create(Renderer3D.prototype);
  inst._fadeOutAnims = new Map();
  inst._entityStandees = new Map();
  return inst;
}

describe('3D addFadeOutAnim / getFadeOutOpacity', () => {
  test('addFadeOutAnim records an entry with startTime + duration', () => {
    const inst = makeInst();
    const before = Date.now();
    inst.addFadeOutAnim('e1', 500);
    const entry = inst._fadeOutAnims.get('e1');
    assert.ok(entry, 'entry stored');
    assert.ok(entry.startTime >= before);
    assert.equal(entry.duration, 500);
  });

  test('addFadeOutAnim ignores a null entity id', () => {
    const inst = makeInst();
    inst.addFadeOutAnim(null, 500);
    assert.equal(inst._fadeOutAnims.size, 0);
  });

  test('getFadeOutOpacity is 1 for a non-fading entity', () => {
    const inst = makeInst();
    assert.equal(inst.getFadeOutOpacity('nope'), 1);
  });

  test('getFadeOutOpacity ramps 1 → 0 over the duration', () => {
    const inst = makeInst();
    inst.addFadeOutAnim('e1', 1000);
    assert.ok(inst.getFadeOutOpacity('e1') > 0.95, 'near 1 immediately');
    inst._fadeOutAnims.set('e1', { startTime: Date.now() - 500, duration: 1000 });
    const mid = inst.getFadeOutOpacity('e1');
    assert.ok(mid > 0.3 && mid < 0.7, `mid-fade ~0.5, got ${mid}`);
    inst._fadeOutAnims.set('e1', { startTime: Date.now() - 5000, duration: 1000 });
    assert.equal(inst.getFadeOutOpacity('e1'), 0, 'clamped to 0 past the end');
  });
});

describe('3D _setStandeeOpacity', () => {
  test('multiplies every cone + sphere descendant (model AND icon)', () => {
    const inst = makeInst();
    const { standee, meshes } = makeStandee();
    inst._setStandeeOpacity(standee, 0.4);
    assert.equal(meshes.body1.visibility, 0.4);
    assert.equal(meshes.body2.visibility, 0.4);
    assert.equal(meshes.badge.visibility, 0.4, 'icon badge fades with the body');
    assert.equal(meshes.sphereHead.visibility, 0.4);
  });

  test('is a no-op on a null standee', () => {
    const inst = makeInst();
    assert.doesNotThrow(() => inst._setStandeeOpacity(null, 0.5));
  });
});

describe('3D _pumpFadeOuts', () => {
  // _pumpFadeOuts derives opacity from getFadeOutOpacity (Date.now-based), NOT a
  // passed render clock — so anim startTimes are backdated against Date.now().
  test('ramps a fading standee toward invisible mid-fade', () => {
    const inst = makeInst();
    const { standee, meshes } = makeStandee();
    inst._entityStandees.set('e1', standee);
    inst._fadeOutAnims.set('e1', { startTime: Date.now() - 300, duration: 600 }); // halfway
    inst._pumpFadeOuts();
    assert.ok(meshes.body1.visibility > 0.3 && meshes.body1.visibility < 0.7,
      `~0.5 mid-fade, got ${meshes.body1.visibility}`);
  });

  test('at/after the end holds opacity 0 WITHOUT disposing or dropping the entry', () => {
    const inst = makeInst();
    const { standee, meshes } = makeStandee();
    inst._entityStandees.set('e1', standee);
    inst._fadeOutAnims.set('e1', { startTime: Date.now() - 5000, duration: 600 }); // long past
    inst._pumpFadeOuts();
    assert.equal(meshes.body1.visibility, 0, 'fully invisible');
    assert.equal(meshes.badge.visibility, 0, 'icon invisible');
    // Entry + standee are retained — the step-boundary path owns disposal.
    assert.ok(inst._fadeOutAnims.has('e1'), 'fade entry retained at opacity 0');
    assert.ok(inst._entityStandees.has('e1'), 'standee NOT disposed by the pump');
  });

  test('drops the fade entry once the standee is gone (disposed at step boundary)', () => {
    const inst = makeInst();
    inst._fadeOutAnims.set('e1', { startTime: Date.now(), duration: 600 });
    // No standee registered for e1 — simulate post-disposal.
    inst._pumpFadeOuts();
    assert.equal(inst._fadeOutAnims.has('e1'), false, 'stale entry cleaned up');
  });

  test('is a no-op when there are no fades', () => {
    const inst = makeInst();
    assert.doesNotThrow(() => inst._pumpFadeOuts());
  });
});

// ── stagedDeathOpacity (pure) ───────────────────────────────────────────────
// The death fade is two linear phases keyed off the clip's measured length:
//   • Phase A — while the Death (fall) clip plays (0 → clipMs): opacity 1.0 →
//     0.5, so it is EXACTLY 0.5 the instant the fall ends.
//   • Phase B — corpse lying still on the ground (clipMs → clipMs+groundMs):
//     opacity 0.5 → 0.
const CLIP = 1100;   // clip plays across 1100ms of real time
const GROUND = 700;  // then fades 0.5 → 0 over 700ms on the ground
const TOTAL = CLIP + GROUND;

describe('stagedDeathOpacity', () => {
  test('starts fully opaque at t=0 (fade begins as the clip begins)', () => {
    assert.equal(stagedDeathOpacity(0, CLIP, GROUND), 1.0);
  });

  test('is EXACTLY 0.5 when the clip ends', () => {
    assert.equal(stagedDeathOpacity(CLIP, CLIP, GROUND), 0.5);
  });

  test('is EXACTLY 0 at the end of the ground fade', () => {
    assert.equal(stagedDeathOpacity(TOTAL, CLIP, GROUND), 0);
  });

  test('phase A is linear 1.0 → 0.5 across the clip', () => {
    assert.equal(stagedDeathOpacity(CLIP / 2, CLIP, GROUND), 0.75);     // midpoint
    assert.equal(stagedDeathOpacity(CLIP / 4, CLIP, GROUND), 0.875);    // quarter
    assert.equal(stagedDeathOpacity((3 * CLIP) / 4, CLIP, GROUND), 0.625); // 3/4
  });

  test('phase B is linear 0.5 → 0 across the ground window', () => {
    // Midpoint of the ground window → halfway between 0.5 and 0 = 0.25.
    assert.equal(stagedDeathOpacity(CLIP + GROUND / 2, CLIP, GROUND), 0.25);
  });

  test('is monotonically non-increasing across the whole sequence', () => {
    let prev = Infinity;
    for (let t = 0; t <= TOTAL + 200; t += 25) {
      const o = stagedDeathOpacity(t, CLIP, GROUND);
      assert.ok(o <= prev + 1e-9, `opacity rose at t=${t}: ${o} > ${prev}`);
      prev = o;
    }
  });

  test('clamps to [0,1] before t=0 and well past the end', () => {
    assert.equal(stagedDeathOpacity(-500, CLIP, GROUND), 1.0); // negative → t=0
    assert.equal(stagedDeathOpacity(TOTAL + 10_000, CLIP, GROUND), 0);
  });

  test('boundary stays at 0.5 for any clip length (NOT a hardcoded duration)', () => {
    // The phase split MUST follow the actual clip length, so opacity is 0.5 at
    // clip-end regardless of how long the clip is.
    for (const clip of [200, 750, 1100, 3000, 5000]) {
      assert.equal(
        stagedDeathOpacity(clip, clip, GROUND), 0.5,
        `clip=${clip}ms should be 0.5 at its own end`,
      );
    }
  });

  test('degrades to a single 1 → 0 ramp when the clip length is unknown', () => {
    // clipMs <= 0 (clip not measured yet) — the whole fade collapses to a plain
    // 1 → 0 over the ground window so the unit still dissolves.
    assert.equal(stagedDeathOpacity(0, 0, GROUND), 1.0);
    assert.equal(stagedDeathOpacity(GROUND / 2, 0, GROUND), 0.5);
    assert.equal(stagedDeathOpacity(GROUND, 0, GROUND), 0);
    assert.equal(stagedDeathOpacity(GROUND, undefined, GROUND), 0);
  });

  test('guards a zero/garbage ground window without dividing by zero', () => {
    const o = stagedDeathOpacity(CLIP + 5, CLIP, 0); // groundMs floored to >=1
    assert.ok(Number.isFinite(o));
    assert.ok(o >= 0 && o <= 0.5);
  });
});

// ── getFadeOutOpacity death path (real prototype method) ────────────────────
describe('3D getFadeOutOpacity — staged death fade', () => {
  test('an isDeath entry is exactly 0.5 at clip-end and 0 at total-end', () => {
    const inst = makeInst();
    // At clip-end: startTime backdated by exactly clipMs.
    inst._fadeOutAnims.set('d1', {
      startTime: Date.now() - CLIP, duration: TOTAL,
      isDeath: true, clipMs: CLIP, groundMs: GROUND,
    });
    const atClipEnd = inst.getFadeOutOpacity('d1');
    assert.ok(Math.abs(atClipEnd - 0.5) < 0.02, `~0.5 at clip-end, got ${atClipEnd}`);

    // Well past total-end → 0.
    inst._fadeOutAnims.set('d2', {
      startTime: Date.now() - (TOTAL + 5000), duration: TOTAL,
      isDeath: true, clipMs: CLIP, groundMs: GROUND,
    });
    assert.equal(inst.getFadeOutOpacity('d2'), 0, 'fully faded past total-end');
  });

  test('addFadeOutAnim with isDeath opts carries clip + ground onto the entry', () => {
    const inst = makeInst();
    inst.addFadeOutAnim('d3', TOTAL, { isDeath: true, clipMs: CLIP, groundMs: GROUND });
    const entry = inst._fadeOutAnims.get('d3');
    assert.equal(entry.isDeath, true);
    assert.equal(entry.clipMs, CLIP);
    assert.equal(entry.groundMs, GROUND);
  });

  test('a plain (non-death) fade still uses the legacy linear 1 → 0 ramp', () => {
    const inst = makeInst();
    inst._fadeOutAnims.set('p1', { startTime: Date.now() - 500, duration: 1000 });
    const o = inst.getFadeOutOpacity('p1');
    assert.ok(o > 0.4 && o < 0.6, `legacy mid-fade ~0.5, got ${o}`);
  });
});
