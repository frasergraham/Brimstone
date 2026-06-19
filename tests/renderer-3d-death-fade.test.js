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
import { Renderer3D } from '../src/renderer-3d.js';

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
