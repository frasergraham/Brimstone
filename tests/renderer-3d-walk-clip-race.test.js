// Regression: the "zombie slides between hexes with frozen feet" bug.
//
// Fallback-rig clips (walk/run/punch/…) are retargeted onto the shared rig
// source ASYNCHRONOUSLY, then propagated onto each standee. A unit revealed and
// moved in the window BEFORE its per-unit walk clip propagated would enter the
// move toggle, find no `groups.walk`, and silently fall back to `idle` — sliding
// to the next hex with its legs frozen. `_ensureUnitClip` self-heals that race
// by attaching the clip on demand from the rig source the instant it's needed.
//
// Babylon can't run under node-test, so the clone path is exercised against a
// minimal stub — same approach as the other renderer-3d unit tests.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';

const FAKE_CANVAS = { parentElement: null, width: 8, height: 6 };

/** A renderer whose Babylon-dependent clip clone is stubbed so we can observe
 *  attach behaviour. `cloneOK:false` simulates the shared clip not loaded. */
function makeRenderer({ cloneOK = true } = {}) {
  const r = new Renderer3D(FAKE_CANVAS, {});
  let calls = 0;
  r._cloneClipOntoTNs = (group, byName, name, opts) => {
    calls++;
    return cloneOK ? { __name: name, __opts: opts, start() {}, stop() {}, play() {} } : null;
  };
  return { r, calls: () => calls };
}

const rigSrc = (over = {}) => ({ cloneTag: 'zombie', walkGroup: { id: 'walk' }, walkSpeedRatio: 1, ...over });
const unitClone = (over = {}) => ({
  groups: {}, tnByName: { 'mixamorig:Hips': {} }, _unitId: 'e2', rigSrc: rigSrc(), ...over,
});

describe('_ensureUnitClip', () => {
  test('attaches the walk clip when the unit lacks it but the rig source has it', () => {
    const { r } = makeRenderer();
    const clone = unitClone();
    assert.equal(r._ensureUnitClip(clone, 'walk'), true);
    assert.ok(clone.groups.walk, 'walk clip attached on the unit');
  });

  test('no-op true (no re-clone) when the clip is already present', () => {
    const { r, calls } = makeRenderer();
    const clone = unitClone({ groups: { walk: { id: 'existing' } } });
    assert.equal(r._ensureUnitClip(clone, 'walk'), true);
    assert.equal(calls(), 0, 'did not re-clone an existing clip');
  });

  test('false (graceful) when the rig source has not loaded the shared clip yet', () => {
    const { r } = makeRenderer();
    const clone = unitClone({ rigSrc: rigSrc({ walkGroup: null }) });
    assert.equal(r._ensureUnitClip(clone, 'walk'), false);
    assert.ok(!clone.groups.walk);
  });

  test('false when the clone is missing rigSrc or tnByName', () => {
    const { r } = makeRenderer();
    assert.equal(r._ensureUnitClip({ groups: {}, tnByName: { 'mixamorig:Hips': {} } }, 'walk'), false);
    assert.equal(r._ensureUnitClip({ groups: {}, rigSrc: rigSrc() }, 'walk'), false);
  });

  test('false (not crash) when _cloneClipOntoTNs returns null', () => {
    const { r } = makeRenderer({ cloneOK: false });
    const clone = unitClone();
    assert.equal(r._ensureUnitClip(clone, 'walk'), false);
    assert.ok(!clone.groups.walk);
  });
});

describe('_maybeToggleFallbackRigAnimation — race self-heal', () => {
  function moveToggleScenario({ cloneOK = true } = {}) {
    const { r } = makeRenderer({ cloneOK });
    const states = [];
    r._setCloneAnimState = (_clone, want) => states.push(want);
    const clone = unitClone({ rigSrc: rigSrc(cloneOK ? {} : { walkGroup: null }) });
    r._entityStandees = new Map([['e2', { paladinClone: clone }]]);
    r._activeMoveIds = new Set(['e2']);
    return { r, clone, states };
  }

  test('a moving unit lacking its walk clip gets it attached and switches to walk (not idle)', () => {
    const { r, clone, states } = moveToggleScenario();
    r._maybeToggleFallbackRigAnimation();
    assert.ok(clone.groups.walk, 'walk attached on demand');
    assert.deepEqual(states, ['walk'], 'switched to walk, not idle slide');
  });

  test('a moving unit whose rig walk is not loaded yet stays idle (graceful, retries next frame)', () => {
    const { r, clone, states } = moveToggleScenario({ cloneOK: false });
    r._maybeToggleFallbackRigAnimation();
    assert.ok(!clone.groups.walk);
    assert.deepEqual(states, ['idle']);
  });

  test('a stationary unit stays idle (never force-attaches walk)', () => {
    const { r, clone, states } = moveToggleScenario();
    r._activeMoveIds = new Set();           // not moving
    r._maybeToggleFallbackRigAnimation();
    assert.ok(!clone.groups.walk, 'no walk clip attached while idle');
    assert.deepEqual(states, ['idle']);
  });
});
