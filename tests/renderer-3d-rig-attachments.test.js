// Bone-attachment coverage for G5 (horse / mount) + G6 (weapon-in-hand).
//
// Babylon can't run under node-test (no WebGL), so the runtime attach paths
// are exercised against a stubbed `_babylon` + skeleton. The pure geometry /
// classification helpers are verified directly. The shared-skeleton per-unit
// trick (attachToBone with a per-standee affector mesh) is asserted by
// capturing the affector passed into the weapon mesh's attachToBone.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  findBoneByName,
  entityHasWeapon,
  entityIsMounted,
  weaponStandInTransform,
  classifyLegBone,
  ridingLegPose,
  WEAPON_BONE_NAME_RE,
  WEAPON_STANDIN_WORLD_LENGTH,
  WEAPON_STANDIN_WORLD_DIAMETER,
  HORSE_ITEM_KEY,
  MOUNTED_RIDER_LIFT,
} from '../src/renderer-3d.js';

// ── pure helpers ─────────────────────────────────────────────────────────────

describe('findBoneByName', () => {
  const skel = { bones: [
    { name: 'mixamorig:Hips' },
    { name: 'mixamorig:RightHand' },
    { name: 'mixamorig:LeftHand' },
  ] };
  test('matches the right-hand bone by the weapon regex', () => {
    assert.equal(findBoneByName(skel, WEAPON_BONE_NAME_RE).name, 'mixamorig:RightHand');
  });
  test('matches a .NNN-deduped bone name', () => {
    const s = { bones: [{ name: 'mixamorig:RightHand.001' }] };
    assert.equal(findBoneByName(s, WEAPON_BONE_NAME_RE).name, 'mixamorig:RightHand.001');
  });
  test('null-safe against a missing skeleton / bones', () => {
    assert.equal(findBoneByName(null, WEAPON_BONE_NAME_RE), null);
    assert.equal(findBoneByName({}, WEAPON_BONE_NAME_RE), null);
    assert.equal(findBoneByName(skel, null), null);
  });
  test('returns null when no bone matches', () => {
    assert.equal(findBoneByName({ bones: [{ name: 'foo' }] }, WEAPON_BONE_NAME_RE), null);
  });
});

describe('entityHasWeapon', () => {
  test('true when an items entry is tagged equipped', () => {
    assert.equal(entityHasWeapon({ items: { sword: { count: 1, equipped: true } } }), true);
  });
  test('false for no equipped entry / empty / missing', () => {
    assert.equal(entityHasWeapon({ items: { sword: { count: 1 } } }), false);
    assert.equal(entityHasWeapon({ items: {} }), false);
    assert.equal(entityHasWeapon({}), false);
    assert.equal(entityHasWeapon(null), false);
  });
});

describe('entityIsMounted', () => {
  test('true when items.horse count > 0', () => {
    assert.equal(entityIsMounted({ items: { [HORSE_ITEM_KEY]: { count: 1 } } }), true);
  });
  test('false when horse count is 0 / absent', () => {
    assert.equal(entityIsMounted({ items: { horse: { count: 0 } } }), false);
    assert.equal(entityIsMounted({ items: {} }), false);
    assert.equal(entityIsMounted({}), false);
    assert.equal(entityIsMounted(null), false);
  });
});

describe('weaponStandInTransform', () => {
  test('grip-offset is half the length so the fist holds the hilt', () => {
    const t = weaponStandInTransform();
    assert.equal(t.offset.y, t.height / 2);
    assert.ok(t.height > t.diameter, 'blade is long and skinny');
  });
  test('tilts the blade forward (negative X rotation)', () => {
    assert.ok(weaponStandInTransform().rotation.x < 0);
  });
  test('no scale → world dims are used verbatim (fallback)', () => {
    const t = weaponStandInTransform();
    assert.equal(t.height, WEAPON_STANDIN_WORLD_LENGTH);
    assert.equal(t.diameter, WEAPON_STANDIN_WORLD_DIAMETER);
  });
  test('divides world size by the per-standee scale so attachToBone restores it', () => {
    // attachToBone composes blade.world ≈ localDim × paladinScale (hand bone
    // final matrix is ~unit-scale). Dividing here means the on-screen blade
    // lands back at the WORLD_LENGTH regardless of how small the rig is scaled.
    const scale = 0.34928; // real paladin-idle.glb: 0.69 / naturalHeight(1.975)
    const t = weaponStandInTransform(scale);
    assert.ok(Math.abs(t.height * scale - WEAPON_STANDIN_WORLD_LENGTH) < 1e-9,
      'local height × scale recovers the world length');
    assert.ok(Math.abs(t.diameter * scale - WEAPON_STANDIN_WORLD_DIAMETER) < 1e-9,
      'local diameter × scale recovers the world diameter');
    assert.equal(t.offset.y, t.height / 2, 'grip stays at the fist after rescale');
  });
  test('world blade stays smaller than the paladin (no giant-sword regression)', () => {
    // The bug: a 32-unit local cylinder × 0.349 scale ≈ 11 world units ≈ 16×
    // the 0.69-tall paladin. The world length must stay under the paladin's
    // height so it reads as a held sword, not a flagpole at the origin.
    const TARGET_PALADIN_WORLD_HEIGHT = 0.69;
    assert.ok(WEAPON_STANDIN_WORLD_LENGTH < TARGET_PALADIN_WORLD_HEIGHT,
      'stand-in blade is shorter than the paladin is tall');
  });
  test('larger scale → smaller local cylinder (inverse relationship)', () => {
    assert.ok(weaponStandInTransform(0.5).height < weaponStandInTransform(0.25).height);
  });
});

describe('classifyLegBone', () => {
  test('classifies Mixamo leg bones', () => {
    assert.equal(classifyLegBone('mixamorig:LeftUpLeg'), 'thigh');
    assert.equal(classifyLegBone('mixamorig:RightUpLeg'), 'thigh');
    assert.equal(classifyLegBone('mixamorig:LeftLeg'), 'shin');
    assert.equal(classifyLegBone('mixamorig:RightLeg'), 'shin');
    assert.equal(classifyLegBone('mixamorig:LeftFoot'), 'foot');
  });
  test('UpLeg is a thigh, not a shin (suffix priority)', () => {
    assert.notEqual(classifyLegBone('mixamorig:LeftUpLeg'), 'shin');
  });
  test('non-leg / junk → null', () => {
    assert.equal(classifyLegBone('mixamorig:Spine'), null);
    assert.equal(classifyLegBone('mixamorig:RightHand'), null);
    assert.equal(classifyLegBone(null), null);
  });
});

describe('ridingLegPose', () => {
  test('thigh splay mirrors by side', () => {
    const left  = ridingLegPose('mixamorig:LeftUpLeg');
    const right = ridingLegPose('mixamorig:RightUpLeg');
    assert.equal(Math.sign(left.z), -Math.sign(right.z));
    assert.ok(left.x < 0, 'thighs rotate forward');
  });
  test('shins bend back at the knee', () => {
    assert.ok(ridingLegPose('mixamorig:LeftLeg').x > 0);
  });
  test('null for non-leg bones', () => {
    assert.equal(ridingLegPose('mixamorig:Spine'), null);
  });
});

// ── runtime attach paths (stubbed Babylon) ──────────────────────────────────

function fakeVec3(x = 0, y = 0, z = 0) { return { x, y, z }; }

function makeFakeMesh(name) {
  return {
    name,
    isPickable: true,
    renderingGroupId: 7,
    alwaysSelectAsActiveMesh: false,
    material: null,
    position: fakeVec3(),
    rotation: fakeVec3(),
    parent: null,
    _disposed: false,
    _attachedBone: null,
    _affector: null,
    _enabled: true,
    attachToBone(bone, affector) { this._attachedBone = bone; this._affector = affector; },
    detachFromBone() { this._attachedBone = null; },
    setEnabled(v) { this._enabled = !!v; },
    isEnabled() { return this._enabled; },
    dispose() { this._disposed = true; },
  };
}

function makeFakeBabylon() {
  function Vector3(x, y, z) { this.x = x; this.y = y; this.z = z; }
  function Color3(r, g, b) { this.r = r; this.g = g; this.b = b; }
  function StandardMaterial(name) { this.name = name; this._disposed = false;
    this.dispose = () => { this._disposed = true; }; }
  function TransformNode(name) { this.name = name; this.parent = null;
    this.position = new Vector3(0, 0, 0); this._disposed = false;
    this.dispose = () => { this._disposed = true; }; }
  const created = [];
  const MeshBuilder = {
    CreateCylinder(name) { const m = makeFakeMesh(name); created.push(m); return m; },
    CreateBox(name)      { const m = makeFakeMesh(name); created.push(m); return m; },
  };
  return { Vector3, Color3, StandardMaterial, TransformNode, MeshBuilder, _created: created };
}

function makeInst() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  const inst = new Renderer3D(fakeCanvas, {});
  inst._babylon = makeFakeBabylon();
  inst._scene = {};
  inst._paladinSource = {
    skeleton: { bones: [
      { name: 'mixamorig:RightHand' },
      { name: 'mixamorig:LeftUpLeg' },
      { name: 'mixamorig:LeftLeg' },
      { name: 'mixamorig:RightUpLeg' },
      { name: 'mixamorig:RightLeg' },
      { name: 'mixamorig:Spine' },
    ] },
  };
  inst._shadowGenerator = null; // _addShadowCaster is a no-op
  return inst;
}

function paladinCloneStub() {
  const root = makeFakeMesh('clone_root');
  const skinned = makeFakeMesh('clone_skinned');
  return { mesh: root, skinnedMesh: skinned, childMeshes: [skinned] };
}

describe('_syncStandeeWeapon (G6)', () => {
  test('attaches a blade to the right-hand bone using the per-standee affector', () => {
    const inst = makeInst();
    const standee = { paladinClone: paladinCloneStub() };
    inst._syncStandeeWeapon(standee, { id: 7, items: { sword: { count: 1, equipped: true } } });
    assert.ok(standee.weaponMesh, 'weapon mesh created');
    assert.equal(standee.weaponMesh._attachedBone.name, 'mixamorig:RightHand');
    // The affector is THIS standee's clone, not the shared skeleton — that's
    // what makes the attachment per-unit on a shared skeleton.
    assert.equal(standee.weaponMesh._affector, standee.paladinClone.skinnedMesh);
  });

  test('two standees get distinct blades bound to distinct affectors', () => {
    const inst = makeInst();
    const a = { paladinClone: paladinCloneStub() };
    const b = { paladinClone: paladinCloneStub() };
    inst._syncStandeeWeapon(a, { id: 1, items: { sword: { count: 1, equipped: true } } });
    inst._syncStandeeWeapon(b, { id: 2, items: { sword: { count: 1, equipped: true } } });
    assert.notEqual(a.weaponMesh, b.weaponMesh);
    assert.notEqual(a.weaponMesh._affector, b.weaponMesh._affector);
  });

  test('idempotent — a second call with the same weapon does not rebuild', () => {
    const inst = makeInst();
    const standee = { paladinClone: paladinCloneStub() };
    inst._syncStandeeWeapon(standee, { id: 7, items: { sword: { count: 1, equipped: true } } });
    const first = standee.weaponMesh;
    inst._syncStandeeWeapon(standee, { id: 7, items: { sword: { count: 1, equipped: true } } });
    assert.equal(standee.weaponMesh, first);
  });

  test('dropping the weapon disposes the blade + its material', () => {
    const inst = makeInst();
    const standee = { paladinClone: paladinCloneStub() };
    inst._syncStandeeWeapon(standee, { id: 7, items: { sword: { count: 1, equipped: true } } });
    const blade = standee.weaponMesh;
    const mat = standee.weaponMat;
    inst._syncStandeeWeapon(standee, { id: 7, items: {} });
    assert.equal(standee.weaponMesh, null);
    assert.equal(blade._disposed, true);
    assert.equal(mat._disposed, true);
  });

  test('no clone yet → no weapon (waits for the GLB)', () => {
    const inst = makeInst();
    const standee = { paladinClone: null };
    inst._syncStandeeWeapon(standee, { id: 7, items: { sword: { count: 1, equipped: true } } });
    assert.equal(standee.weaponMesh, undefined);
  });

  test('weapon equipped onto a fog-hidden standee starts disabled (no floating sword)', () => {
    // Regression: the blade is a scene-root mesh driven by attachToBone, so it
    // does NOT inherit the standee plane's setEnabled(false). Equipping a
    // weapon while the unit is fogged must not flash a floating sword over the
    // hidden hex — the blade must inherit the hidden state at creation.
    const inst = makeInst();
    const hiddenPlane = makeFakeMesh('cone');
    hiddenPlane.setEnabled(false);
    const standee = { paladinClone: paladinCloneStub(), plane: hiddenPlane };
    inst._syncStandeeWeapon(standee, { id: 7, items: { sword: { count: 1, equipped: true } } });
    assert.ok(standee.weaponMesh, 'weapon mesh created');
    assert.equal(standee.weaponMesh.isEnabled(), false,
      'blade inherits the fog-hidden standee plane state');
  });

  test('weapon equipped onto a visible standee starts enabled', () => {
    const inst = makeInst();
    const visiblePlane = makeFakeMesh('cone'); // _enabled defaults true
    const standee = { paladinClone: paladinCloneStub(), plane: visiblePlane };
    inst._syncStandeeWeapon(standee, { id: 7, items: { sword: { count: 1, equipped: true } } });
    assert.equal(standee.weaponMesh.isEnabled(), true);
  });
});

describe('_syncStandeeHorse (G5)', () => {
  test('mounting builds a placeholder and lifts the rider', () => {
    const inst = makeInst();
    const clone = paladinCloneStub();
    const baseY = clone.mesh.position.y;
    const standee = { paladinClone: clone };
    inst._syncStandeeHorse(standee, { id: 9, items: { horse: { count: 1 } } });
    assert.ok(standee.horseMesh, 'horse placeholder created');
    assert.ok(Array.isArray(standee.horseMesh._horseParts), 'horse has parts');
    assert.ok(standee.horseMesh._horseParts.length >= 6, 'body + 4 legs + neck/head');
    assert.equal(clone.mesh.position.y, baseY + MOUNTED_RIDER_LIFT);
  });

  test('dismounting disposes the horse and lowers the rider back', () => {
    const inst = makeInst();
    const clone = paladinCloneStub();
    const baseY = clone.mesh.position.y;
    const standee = { paladinClone: clone };
    inst._syncStandeeHorse(standee, { id: 9, items: { horse: { count: 1 } } });
    const parts = standee.horseMesh._horseParts.slice();
    inst._syncStandeeHorse(standee, { id: 9, items: { horse: { count: 0 } } });
    assert.equal(standee.horseMesh, null);
    assert.ok(parts.every(p => p._disposed), 'all horse parts disposed');
    assert.equal(clone.mesh.position.y, baseY);
  });

  test('idempotent while mounted', () => {
    const inst = makeInst();
    const standee = { paladinClone: paladinCloneStub() };
    inst._syncStandeeHorse(standee, { id: 9, items: { horse: { count: 1 } } });
    const horse = standee.horseMesh;
    inst._syncStandeeHorse(standee, { id: 9, items: { horse: { count: 1 } } });
    assert.equal(standee.horseMesh, horse);
  });
});

describe('_applyRidingPose (shared-skeleton global pose)', () => {
  test('poses every leg bone and leaves non-leg bones alone', () => {
    const inst = makeInst();
    const skel = inst._paladinSource.skeleton;
    const posed = inst._applyRidingPose(skel);
    // stub legs: LeftUpLeg, LeftLeg, RightUpLeg, RightLeg = 4; Hand + Spine untouched.
    assert.equal(posed, 4);
  });
  test('returns 0 for a skeleton with no leg bones', () => {
    const inst = makeInst();
    assert.equal(inst._applyRidingPose({ bones: [{ name: 'mixamorig:Spine' }] }), 0);
    assert.equal(inst._applyRidingPose(null), 0);
  });
});
