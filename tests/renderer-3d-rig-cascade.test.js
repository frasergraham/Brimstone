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
  rootBoneTrackAverageY,
  MANNEQUIN_RIG_FILE,
  RIGGED_ENTITY_TYPES,
  LAZY_RIG_TYPES,
} from '../src/renderer-3d.js';
import { EntityType } from '../src/entities.js';

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

describe('rootBoneTrackAverageY — the rig\'s standing anchor', () => {
  test('returns the mean hips Y of the clip', () => {
    const g = makeHipsGroup(); // keys y 90 & 92
    assert.equal(rootBoneTrackAverageY(g), 91);
  });

  test('returns null when there is no hips position track', () => {
    assert.equal(rootBoneTrackAverageY(null), null);
    assert.equal(rootBoneTrackAverageY({ targetedAnimations: [] }), null);
    const rotOnly = { targetedAnimations: [{ target: { name: 'mixamorig:Hips' },
      animation: { targetProperty: 'rotationQuaternion', getKeys: () => [{ value: {} }] } }] };
    assert.equal(rootBoneTrackAverageY(rotOnly), null);
  });

  test('matches names with the .001 dedup suffix', () => {
    const keys = [{ value: { x: 0, y: 10, z: 0 } }];
    const g = { targetedAnimations: [{ target: { name: 'mixamorig:Hips.001' },
      animation: { targetProperty: 'position', getKeys: () => keys } }] };
    assert.equal(rootBoneTrackAverageY(g), 10);
  });

  // The zombie float regression: the zombie's embedded idle is a CROUCHED
  // shamble (hips ~0.93) while its T-pose rest hip height is ~1.05. Anchoring
  // the idle to the rest height scaled the whole crouch up ~13% and lifted the
  // feet off the ground. Anchoring to the idle's own average instead must be
  // an identity on Y — the authored stance is kept, only XZ drift is stripped.
  test('rebasing a clip to its own track average keeps the authored stance', () => {
    const keys = [{ value: { x: 0.05, y: 0.92, z: 0.02 } }, { value: { x: -0.03, y: 0.94, z: -0.01 } }];
    const g = { targetedAnimations: [{ target: { name: 'mixamorig:Hips' },
      animation: { targetProperty: 'position', getKeys: () => keys } }], _keys: keys };
    rebaseRootBoneY(g, rootBoneTrackAverageY(g));
    assert.ok(Math.abs(g._keys[0].value.y - 0.92) < 1e-9, 'crouch kept, not lifted to rest');
    assert.ok(Math.abs(g._keys[1].value.y - 0.94) < 1e-9);
    for (const k of g._keys) { assert.equal(k.value.x, 0); assert.equal(k.value.z, 0); }
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
  test('derives <type>-idle.glb only for a type that ships a rig', () => {
    // zombie & paladin have a committed <type>-idle.glb → probed.
    assert.equal(entityTypeRigFile({ type: 'zombie' }), 'zombie-idle.glb');
    assert.equal(entityTypeRigFile({ type: 'paladin' }), 'paladin-idle.glb');
  });

  test('returns null for a type WITHOUT a shipped rig (no doomed 404 probe)', () => {
    // These types have no <type>-idle.glb on disk; they must skip straight to
    // the mannequin rather than probe-and-404. Pin the no-rig types so a stray
    // missing GLB can never re-introduce the noisy network log.
    assert.equal(entityTypeRigFile({ type: 'witch' }), null);
    assert.equal(entityTypeRigFile({ type: 'minion' }), null);
    assert.equal(entityTypeRigFile({ type: 'wood_golem' }), null);
    assert.equal(entityTypeRigFile({ type: 'iron_golem' }), null);
    assert.equal(entityTypeRigFile({ type: 'survivor' }), null);
  });

  test('every RIGGED_ENTITY_TYPES member maps to a <type>-idle.glb', () => {
    for (const type of RIGGED_ENTITY_TYPES) {
      assert.equal(entityTypeRigFile({ type }), `${type}-idle.glb`);
    }
  });

  test('returns null for a missing / non-string type', () => {
    assert.equal(entityTypeRigFile(null), null);
    assert.equal(entityTypeRigFile({}), null);
    assert.equal(entityTypeRigFile({ type: 42 }), null);
  });
});

describe('fallbackRigCandidates', () => {
  test('orders the type-specific rig before the shared mannequin (rigged type)', () => {
    assert.deepEqual(fallbackRigCandidates({ type: 'zombie' }),
      ['zombie-idle.glb', MANNEQUIN_RIG_FILE]);
    assert.deepEqual(fallbackRigCandidates({ type: 'paladin' }),
      ['paladin-idle.glb', MANNEQUIN_RIG_FILE]);
  });

  test('a no-rig type skips its own probe and goes straight to the mannequin', () => {
    // The fix for the 404 noise: an unknown / un-rigged type must NOT list a
    // <type>-idle.glb candidate at all, so the cascade never sends a doomed
    // request for it. (Visual parity: the unit still ends up on the mannequin.)
    assert.deepEqual(fallbackRigCandidates({ type: 'survivor' }), [MANNEQUIN_RIG_FILE]);
    assert.deepEqual(fallbackRigCandidates({ type: 'witch' }), [MANNEQUIN_RIG_FILE]);
    assert.deepEqual(fallbackRigCandidates({ type: 'a_brand_new_type' }), [MANNEQUIN_RIG_FILE]);
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
    // Reproduce the stuck state for a RIGGED type whose rig 404'd at runtime:
    // zombie-idle.glb was attempted and 404'd, so it sits in BOTH
    // _rigFileMissing and (staler) _rigLoadPromises.
    r._rigFileMissing.add('zombie-idle.glb');
    r._rigLoadPromises.set('zombie-idle.glb', Promise.resolve(null));
    r._ensureFallbackRig({ type: 'zombie' });
    // Must skip the dead type rig and kick the mannequin — not get blocked on
    // the stale in-flight promise.
    assert.deepEqual(calls, [MANNEQUIN_RIG_FILE]);
  });

  test('a no-rig type never probes its own <type>-idle.glb — straight to mannequin', () => {
    // (B) 404-noise fix: an un-rigged type must not even attempt <type>-idle.glb.
    const r = newRenderer();
    const calls = [];
    r._loadFallbackRig = (file) => { calls.push(file); return Promise.resolve(null); };
    r._ensureFallbackRig({ type: 'witch' });
    assert.deepEqual(calls, [MANNEQUIN_RIG_FILE]);
    assert.ok(!calls.includes('witch-idle.glb'),
      'witch-idle.glb must never be requested');
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

describe('preload scope — survivors are lazy', () => {
  test('LAZY_RIG_TYPES contains the survivor type', () => {
    assert.ok(LAZY_RIG_TYPES.has(EntityType.SURVIVOR));
  });

  test('_preloadCharacterRigs loads the mannequin + leaders/summons but NOT survivors', async () => {
    const r = newRenderer();
    const calls = [];
    r._loadFallbackRig      = (file) => { calls.push(file); return Promise.resolve(null); };
    r._loadWalkingAnimation = () => Promise.resolve(null);
    r._retargetWalkOntoRig  = () => null;
    await r._preloadCharacterRigs('assets');
    assert.ok(calls.includes(MANNEQUIN_RIG_FILE), 'mannequin preloaded');
    assert.ok(calls.includes('zombie-idle.glb'),  'summon (zombie) preloaded');
    assert.ok(!calls.includes('survivor-idle.glb'), 'survivor NOT preloaded up front');
  });

  test('preloadEntityRig loads a lazily-revealed RIGGED type on demand', async () => {
    // A type that ships its own rig (zombie) loads it JIT when revealed in a
    // replay, rather than being preloaded up front.
    const r = newRenderer();
    const calls = [];
    r._loadFallbackRig      = (file) => { calls.push(file); return Promise.resolve(null); };
    r._loadWalkingAnimation = () => Promise.resolve(null);
    r._retargetWalkOntoRig  = () => null;
    await r.preloadEntityRig({ type: 'zombie' });
    assert.deepEqual(calls, ['zombie-idle.glb']);
  });

  test('preloadEntityRig is a no-op for a no-rig type (uses preloaded mannequin)', async () => {
    // Survivors ship no rig of their own, so there is nothing to JIT-load — they
    // render on the already-preloaded mannequin and we never probe (no 404).
    const r = newRenderer();
    const calls = [];
    r._loadFallbackRig = (file) => { calls.push(file); return Promise.resolve(null); };
    await r.preloadEntityRig({ type: 'survivor' });
    assert.deepEqual(calls, []);
  });

  test('preloadEntityRig is a no-op for mannequin-backed types', async () => {
    const r = newRenderer();
    const calls = [];
    r._loadFallbackRig = (file) => { calls.push(file); return Promise.resolve(null); };
    await r.preloadEntityRig({ type: 'mannequin' });
    assert.deepEqual(calls, []);
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

// ── _buildRigClone multi-primitive skeleton binding ─────────────────────────
// Regression for the "walk and idle blended / zombie idle-slides" bug. The
// zombie mesh ships as TWO skinned primitives (Ch10_primitive0 + _primitive1).
// mesh.clone() copies the SOURCE skeleton ref onto each clone; the per-unit
// skeleton must be reassigned to ALL skinned primitives, not just the primary —
// otherwise the secondary primitive stays on the source skeleton (which runs the
// source idle) and that half of the unit idles while the other half walks.
describe('_buildRigClone — multi-primitive skeleton binding', () => {
  function makeSkinnedSrcMesh(name, srcSkeleton) {
    return {
      name, skeleton: srcSkeleton, parent: null,
      // Babylon's clone() carries the source skeleton ref onto the clone.
      clone(n) {
        return {
          name: n, skeleton: srcSkeleton, parent: null, isPickable: true,
          material: makeFakeMaterial(`${n}_mat`), setEnabled() {}, dispose() {},
        };
      },
      setEnabled() {},
    };
  }

  test('binds EVERY skinned primitive to the per-unit skeleton, not just the primary', () => {
    const r = newRenderer();
    const srcSkeleton  = { name: 'srcSkel',  bones: [] };
    const unitSkeleton = { name: 'unitSkel', bones: [] };
    const prim0 = makeSkinnedSrcMesh('Ch10_primitive0', srcSkeleton);
    const prim1 = makeSkinnedSrcMesh('Ch10_primitive1', srcSkeleton);
    const src = {
      mesh: prim0, meshes: [prim0, prim1], skeleton: srcSkeleton, idleGroup: null,
      transformNodes: [], scale: 1, feetOffset: 0, cloneTag: 'zombie', tintable: false,
    };
    r._cloneRigSkeleton    = () => ({ skeleton: unitSkeleton, byName: new Map() });
    r._cloneAllClipsOntoUnit = () => {}; // skip clip cloning (needs full Babylon)

    const clone = r._buildRigClone({ id: 'z1', type: 'zombie' }, null, src, {});
    assert.ok(clone, 'clone built');
    const skinned = clone.childMeshes.filter(m => m.skeleton);
    assert.equal(skinned.length, 2, 'both primitives are present and skinned');
    for (const m of skinned) {
      assert.equal(m.skeleton, unitSkeleton,
        `${m.name} must bind to the per-unit skeleton (was the source idle skeleton)`);
      assert.notEqual(m.skeleton, srcSkeleton, `${m.name} must NOT stay on the source skeleton`);
    }
  });
});
