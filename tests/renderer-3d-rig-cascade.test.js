// Rig-cascade tests — the convention by which every non-paladin unit resolves
// a 3D rig: first `<type>-idle.glb`, else the shared mannequin, else the
// cone+sphere pawn. Covers the pure resolver helpers and the per-owner tint
// applied to the blank mannequin by _buildRigClone.
//
// Babylon can't run under node-test (no WebGL), so the clone path is exercised
// against a minimal stub namespace — same approach as renderer-3d-paladin-glb.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  entityTypeRigFile,
  fallbackRigCandidates,
  stripRootBoneTranslation,
  rebaseRootBoneY,
  MANNEQUIN_RIG_FILE,
} from '../src/renderer-3d.js';

function makeHipsGroup() {
  const keys = [{ value: { x: 5, y: 90, z: 3 } }, { value: { x: 7, y: 92, z: 1 } }];
  return {
    targetedAnimations: [{
      target: { name: 'mixamorig:Hips' },
      animation: { targetProperty: 'position', getKeys: () => keys },
    }],
    _keys: keys,
  };
}

describe('rebaseRootBoneY', () => {
  test('scales the hip trajectory so its average lands on restY, strips x/z', () => {
    // keys y 80 & 120 → mean 100; scaling by restY/mean (10/100) lands the
    // average on restY=10 and scales the bob with it (8 / 12).
    const keys = [{ value: { x: 5, y: 80, z: 3 } }, { value: { x: 7, y: 120, z: 1 } }];
    const g = { targetedAnimations: [{ target: { name: 'mixamorig:Hips' },
      animation: { targetProperty: 'position', getKeys: () => keys } }], _keys: keys };
    rebaseRootBoneY(g, 10);
    assert.equal(g._keys[0].value.y, 8);
    assert.equal(g._keys[1].value.y, 12);
    for (const k of g._keys) { assert.equal(k.value.x, 0); assert.equal(k.value.z, 0); }
  });

  test('leaves Y untouched when restY is null (still strips x/z)', () => {
    const g = makeHipsGroup();
    rebaseRootBoneY(g, null);
    assert.equal(g._keys[0].value.y, 90, 'Y unchanged');
    assert.equal(g._keys[0].value.x, 0);
    assert.equal(g._keys[0].value.z, 0);
  });
});

describe('stripRootBoneTranslation keepY', () => {
  test('default strips all three axes (hip-centred paladin rig)', () => {
    const g = makeHipsGroup();
    stripRootBoneTranslation(g);
    for (const k of g._keys) { assert.equal(k.value.x, 0); assert.equal(k.value.y, 0); assert.equal(k.value.z, 0); }
  });

  test('keepY preserves the vertical baseline (feet-origin mannequin/zombie)', () => {
    const g = makeHipsGroup();
    stripRootBoneTranslation(g, 'mixamorig:Hips', { keepY: true });
    assert.equal(g._keys[0].value.x, 0);
    assert.equal(g._keys[0].value.z, 0);
    assert.equal(g._keys[0].value.y, 90, 'standing height kept');
    assert.equal(g._keys[1].value.y, 92);
  });
});

describe('entityTypeRigFile', () => {
  test('derives <type>-idle.glb from the entity type', () => {
    assert.equal(entityTypeRigFile({ type: 'zombie' }), 'zombie-idle.glb');
    assert.equal(entityTypeRigFile({ type: 'witch' }), 'witch-idle.glb');
    // Underscored multi-word types pass through verbatim (already slug-safe).
    assert.equal(entityTypeRigFile({ type: 'wood_golem' }), 'wood_golem-idle.glb');
  });

  test('returns null for a missing / non-string type', () => {
    assert.equal(entityTypeRigFile(null), null);
    assert.equal(entityTypeRigFile({}), null);
    assert.equal(entityTypeRigFile({ type: 42 }), null);
  });
});

describe('fallbackRigCandidates', () => {
  test('orders the type-specific rig before the shared mannequin', () => {
    assert.deepEqual(fallbackRigCandidates({ type: 'zombie' }),
      ['zombie-idle.glb', MANNEQUIN_RIG_FILE]);
    assert.deepEqual(fallbackRigCandidates({ type: 'survivor' }),
      ['survivor-idle.glb', MANNEQUIN_RIG_FILE]);
  });

  test('falls back to mannequin-only when there is no usable type', () => {
    assert.deepEqual(fallbackRigCandidates(null), [MANNEQUIN_RIG_FILE]);
    assert.deepEqual(fallbackRigCandidates({}), [MANNEQUIN_RIG_FILE]);
  });

  test('does not list the mannequin twice if the type IS the mannequin', () => {
    assert.deepEqual(fallbackRigCandidates({ type: 'mannequin' }), [MANNEQUIN_RIG_FILE]);
  });
});

// ── _buildRigClone per-owner tint ───────────────────────────────────────────

function fakeColor3(r, g, b) { this.r = r; this.g = g; this.b = b; }
function fakeVector3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }

function makeFakeMaterial(name = 'mat') {
  return {
    name,
    albedoColor: null,
    diffuseColor: null,
    clone(n) { return makeFakeMaterial(n); },
  };
}

function makeClonedMesh(name) {
  return {
    name, isPickable: true, isEnabled: true, parent: null,
    material: makeFakeMaterial(`${name}_srcmat`),
    setEnabled(b) { this.isEnabled = b; },
    dispose() { this._disposed = true; },
  };
}

function makeRigSource(cloneTag, { tintable }) {
  const mesh = {
    name: `${cloneTag}_src`,
    clone(n) { return makeClonedMesh(n); },
    setEnabled() {},
  };
  return {
    mesh, meshes: [mesh], skeleton: null, idleGroup: null, transformNodes: [],
    scale: 1, feetOffset: 0, cloneTag, tintable,
  };
}

function newRenderer() {
  const r = new Renderer3D({ parentElement: null, width: 800, height: 600, addEventListener() {} }, {});
  r._babylon = {
    Vector3: fakeVector3,
    Color3: fakeColor3,
    TransformNode: function (name) { this.name = name; this.parent = null; this.dispose = () => {}; },
  };
  r._scene = {};
  return r;
}

describe('_ensureFallbackRig cascade', () => {
  test('advances to the mannequin after the type-specific rig 404s', () => {
    const r = newRenderer();
    const calls = [];
    r._loadFallbackRig = (file) => { calls.push(file); return Promise.resolve(null); };
    // Reproduce the stuck state: witch-idle.glb was attempted and 404'd, so it
    // sits in BOTH _rigFileMissing and (staler) _rigLoadPromises.
    r._rigFileMissing.add('witch-idle.glb');
    r._rigLoadPromises.set('witch-idle.glb', Promise.resolve(null));
    r._ensureFallbackRig({ type: 'witch' });
    // Must skip the dead type rig and kick the mannequin — not get blocked on
    // the stale in-flight promise.
    assert.deepEqual(calls, [MANNEQUIN_RIG_FILE]);
  });

  test('kicks the type-specific rig first when nothing is loaded yet', () => {
    const r = newRenderer();
    const calls = [];
    r._loadFallbackRig = (file) => { calls.push(file); return Promise.resolve(null); };
    r._ensureFallbackRig({ type: 'zombie' });
    assert.deepEqual(calls, ['zombie-idle.glb']);
  });

  test('still kicks the type-specific rig when the mannequin is ALREADY loaded', () => {
    // Regression: a zombie in a game where the mannequin loaded first (survivors
    // before the witch's summons) must still load its own rig — not glom onto
    // the mannequin. Previously _ensureFallbackRig bailed because
    // _loadedFallbackRigFor returned the already-loaded mannequin.
    const r = newRenderer();
    r._rigSources.set(MANNEQUIN_RIG_FILE, makeRigSource('mannequin', { tintable: true }));
    const calls = [];
    r._loadFallbackRig = (file) => { calls.push(file); return Promise.resolve(null); };
    r._ensureFallbackRig({ type: 'zombie' });
    assert.deepEqual(calls, ['zombie-idle.glb']);
  });
});

describe('_loadedFallbackRigFor — cascade preference', () => {
  test('returns the type-specific rig once it is loaded', () => {
    const r = newRenderer();
    const zsrc = makeRigSource('zombie', { tintable: false });
    r._rigSources.set('zombie-idle.glb', zsrc);
    assert.equal(r._loadedFallbackRigFor({ type: 'zombie' }), zsrc);
  });

  test('returns null (waits) when the preferred rig is still loading, even if the mannequin is loaded', () => {
    const r = newRenderer();
    r._rigSources.set(MANNEQUIN_RIG_FILE, makeRigSource('mannequin', { tintable: true }));
    // zombie-idle.glb not loaded and not missing → still loadable → wait.
    assert.equal(r._loadedFallbackRigFor({ type: 'zombie' }), null);
  });

  test('falls through to the mannequin only after the preferred rig is confirmed missing', () => {
    const r = newRenderer();
    const msrc = makeRigSource('mannequin', { tintable: true });
    r._rigSources.set(MANNEQUIN_RIG_FILE, msrc);
    r._rigFileMissing.add('zombie-idle.glb');
    assert.equal(r._loadedFallbackRigFor({ type: 'zombie' }), msrc);
  });
});

function makeAnimGroup() {
  return {
    calls: [],
    play(loop) { this.calls.push(['play', loop]); },
    start(loop, r) { this.calls.push(['start', loop, r]); },
    stop() { this.calls.push(['stop']); },
  };
}

// Per-INSTANCE animation: each standee owns its own clip groups
// (idle/walk/run/punch/…) and plays them on its own skeleton — the toggle
// drives each clone's own groups, never a shared skeleton, so a moving unit
// walks while idle siblings keep idling.
function makeCloneStandee(keys = ['idle', 'walk', 'run']) {
  const groups = {};
  for (const k of keys) groups[k] = makeAnimGroup();
  return { paladinClone: { groups, activeGroup: null, oneShotPlaying: false } };
}
const played = (g) => g.calls.some(c => c[0] === 'play' || c[0] === 'start');
const stopped = (g) => g.calls.some(c => c[0] === 'stop');

describe('_maybeToggleFallbackRigAnimation — per-instance clip groups', () => {
  function setup(moveIds = []) {
    const r = newRenderer();
    r._activeMoveIds = new Set(moveIds);
    r._activeLungeIds = new Set();
    r._activeRunMoveIds = new Set();
    return r;
  }

  test('only the MOVING unit walks; idle siblings keep idling', () => {
    const r = setup(['z1']);
    const mover = makeCloneStandee();
    const sitter = makeCloneStandee();
    r._entityStandees = new Map([['z1', mover], ['z2', sitter]]);
    r._maybeToggleFallbackRigAnimation();
    assert.equal(mover.paladinClone.activeGroup, 'walk', 'mover plays walk');
    assert.ok(played(mover.paladinClone.groups.walk), 'mover walk started');
    assert.equal(sitter.paladinClone.activeGroup, 'idle', 'sitter plays idle');
    assert.ok(played(sitter.paladinClone.groups.idle), 'sitter idle started');
    assert.ok(!played(sitter.paladinClone.groups.walk), 'sitter never walks');
  });

  test('a moving unit reverts to idle when it stops', () => {
    const r = setup([]); // nothing moving
    const standee = makeCloneStandee();
    standee.paladinClone.activeGroup = 'walk'; // was walking
    r._entityStandees = new Map([['z1', standee]]);
    r._maybeToggleFallbackRigAnimation();
    assert.equal(standee.paladinClone.activeGroup, 'idle');
    assert.ok(played(standee.paladinClone.groups.idle), 'idle restarted');
    assert.ok(stopped(standee.paladinClone.groups.walk), 'walk stopped');
  });

  test('a lunging (combat) unit does NOT walk — lunge is not a move', () => {
    const r = setup([]); // not in _activeMoveIds
    r._activeLungeIds = new Set(['z1']);
    const standee = makeCloneStandee();
    r._entityStandees = new Map([['z1', standee]]);
    r._maybeToggleFallbackRigAnimation();
    assert.equal(standee.paladinClone.activeGroup, 'idle', 'idles, does not walk');
  });

  test('a one-shot (punch/reaction) in flight locks the unit out of locomotion', () => {
    const r = setup(['z1']); // would otherwise walk
    const standee = makeCloneStandee();
    standee.paladinClone.oneShotPlaying = true;
    standee.paladinClone.activeGroup = 'punch';
    r._entityStandees = new Map([['z1', standee]]);
    r._maybeToggleFallbackRigAnimation();
    assert.equal(standee.paladinClone.activeGroup, 'punch', 'punch keeps the skeleton');
    assert.ok(!played(standee.paladinClone.groups.walk), 'walk did not start');
  });
});

describe('_startClonePunch — per-instance strike', () => {
  test('plays the clone\'s own punch and silences its locomotion', () => {
    const r = newRenderer();
    const punch = makeAnimGroup();
    const clone = { groups: { idle: makeAnimGroup(), walk: makeAnimGroup(), run: makeAnimGroup(), punch },
      activeGroup: 'idle', oneShotPlaying: false, punchDurationSec: 1 };
    const ok = r._startClonePunch(clone);
    assert.equal(ok, true);
    assert.equal(clone.oneShotPlaying, true);
    assert.equal(clone.activeGroup, 'punch');
    assert.ok(played(punch), 'punch started');
    assert.ok(stopped(clone.groups.idle), 'idle stopped');
    assert.ok(stopped(clone.groups.walk), 'walk stopped');
  });

  test('no-ops when the clone has no punch clip cloned in yet', () => {
    const r = newRenderer();
    const clone = { groups: { idle: makeAnimGroup() }, activeGroup: 'idle', oneShotPlaying: false };
    assert.equal(r._startClonePunch(clone), false);
    assert.equal(clone.oneShotPlaying, false);
  });
});

describe('_buildRigClone tint', () => {
  test('tints each clone to the owner colour when tintColor is given', () => {
    const r = newRenderer();
    const src = makeRigSource('mannequin', { tintable: true });
    const clone = r._buildRigClone({ id: 'u1', type: 'survivor' }, null, src,
      { tintColor: '#ff0000' });
    assert.ok(clone, 'clone built');
    const child = clone.childMeshes[0];
    // Material was cloned (per-standee instance) and set to red.
    assert.notEqual(child.material.name, 'mannequin_u1_src_srcmat',
      'a fresh per-standee material instance was assigned');
    assert.equal(child.material.albedoColor.r, 1);
    assert.equal(child.material.albedoColor.g, 0);
    assert.equal(child.material.albedoColor.b, 0);
  });

  test('leaves the shared material untouched when no tint is given', () => {
    const r = newRenderer();
    const src = makeRigSource('zombie', { tintable: false });
    const clone = r._buildRigClone({ id: 'z1', type: 'zombie' }, null, src, {});
    assert.ok(clone, 'clone built');
    const child = clone.childMeshes[0];
    assert.equal(child.material.albedoColor, null, 'no tint applied');
  });
});
