// G4 Phase 2 — Renderer3D.addCombatCard lifecycle.
//
// Exercises the billboarded combat-card spawn with a fake Babylon + scene so
// we can assert: the plane is parented to the combatant's standee, sits on
// renderingGroupId 2 (on top), billboards, and that the per-spawn texture +
// material + plane are all disposed when the hold+fade animation completes —
// the same own-texture-never-shared contract as _spawnFloatingText.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';

function makeDisposable(extra = {}) {
  return { disposed: 0, dispose() { this.disposed += 1; }, ...extra };
}

function makeFakeBabylon() {
  function Animation() {}
  Animation.ANIMATIONTYPE_FLOAT = 0;
  Animation.ANIMATIONLOOPMODE_CONSTANT = 0;
  Animation.prototype.setKeys = function (keys) { this.keys = keys; };

  class DynamicTexture {
    constructor(name) {
      this.name = name;
      this.hasAlpha = false;
      this.disposed = 0;
      this._ctx = {
        clearRect() {}, beginPath() {}, closePath() {}, moveTo() {},
        lineTo() {}, arcTo() {}, fill() {}, stroke() {},
        strokeText() {}, fillText() {}, measureText: () => ({ width: 10 }),
        set font(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
        set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
        set lineJoin(_v) {},
      };
    }
    getContext() { return this._ctx; }
    update() { this.updated = true; }
    dispose() { this.disposed += 1; }
  }

  const Mesh = { BILLBOARDMODE_ALL: 7 };

  const MeshBuilder = {
    CreatePlane(name) {
      return {
        name,
        billboardMode: 0,
        isPickable: true,
        renderingGroupId: 0,
        visibility: 0,
        parent: null,
        uniqueId: Math.floor(Math.random() * 1e6),
        position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
        material: null,
        disposed: 0,
        dispose() { this.disposed += 1; },
      };
    },
  };

  class StandardMaterial {
    constructor() {
      this.disposed = 0;
      this.diffuseTexture = null;
      this.opacityTexture = null;
    }
    dispose() { this.disposed += 1; }
  }

  class Color3 { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } }

  return { Animation, DynamicTexture, Mesh, MeshBuilder, StandardMaterial, Color3 };
}

function makeInst({ autoFinish = true } = {}) {
  const inst = Object.create(Renderer3D.prototype);
  inst._babylon = makeFakeBabylon();
  inst._endCbs = [];
  inst._scene = {
    beginDirectAnimation: (_t, _a, _f, _to, _loop, _spd, onEnd) => {
      if (autoFinish) { if (onEnd) onEnd(); }
      else if (onEnd) inst._endCbs.push(onEnd);
    },
  };
  inst._tracked = [];
  inst._trackAnim = (p) => { inst._tracked.push(p); };
  const standee = { plane: { position: { x: 1, y: 2, z: 3 } }, leader: false };
  inst._entityStandees = new Map([['e1', standee]]);
  inst._standee = standee;
  return inst;
}

const RESULT = {
  hit: true,
  attackRoll: 9,
  defenseRoll: 4,
  breakdown: {
    atkPool: [2, 6, 4], atkBaseDie: 6,
    defPool: [3], defBaseDie: 3,
  },
};

describe('Renderer3D.addCombatCard', () => {
  let hadDoc;
  beforeEach(() => {
    hadDoc = 'document' in globalThis;
    if (!hadDoc) globalThis.document = {};
  });
  afterEach(() => {
    if (!hadDoc) delete globalThis.document;
  });

  test('no-ops when the standee is missing (e.g. unit already killed)', () => {
    const inst = makeInst();
    assert.doesNotThrow(() => inst.addCombatCard('nope', 'attacker', RESULT));
    assert.equal(inst._tracked.length, 0, 'no animation tracked');
  });

  test('no-ops without a scene / babylon', () => {
    const inst = makeInst();
    inst._scene = null;
    assert.doesNotThrow(() => inst.addCombatCard('e1', 'attacker', RESULT));
    assert.equal(inst._tracked.length, 0);
  });

  test('builds a billboarded plane parented to the standee on group 2', () => {
    const inst = makeInst({ autoFinish: false });
    let captured = null;
    const origCreate = inst._babylon.MeshBuilder.CreatePlane;
    inst._babylon.MeshBuilder.CreatePlane = (...a) => {
      captured = origCreate(...a);
      return captured;
    };
    inst.addCombatCard('e1', 'attacker', RESULT);

    assert.ok(captured, 'a plane was created');
    assert.equal(captured.billboardMode, inst._babylon.Mesh.BILLBOARDMODE_ALL);
    assert.equal(captured.isPickable, false);
    assert.equal(captured.renderingGroupId, 2, 'card renders on top (group 2)');
    assert.equal(captured.parent, inst._standee.plane, 'parented to the standee');
    assert.ok(captured.position.y > 0, 'positioned above the head');
    assert.equal(inst._tracked.length, 1, 'animation tracked for waitForAnimations');
  });

  test('disposes its own texture, material, and plane when the anim ends', () => {
    // autoFinish=false so we can inspect, then fire the end callback ourselves.
    const inst = makeInst({ autoFinish: false });
    const createdTex = [];
    const createdMat = [];
    const createdPlane = [];
    const B = inst._babylon;
    const OrigTex = B.DynamicTexture;
    B.DynamicTexture = class extends OrigTex { constructor(...a) { super(...a); createdTex.push(this); } };
    const OrigMat = B.StandardMaterial;
    B.StandardMaterial = class extends OrigMat { constructor(...a) { super(...a); createdMat.push(this); } };
    const origCreate = B.MeshBuilder.CreatePlane;
    B.MeshBuilder.CreatePlane = (...a) => { const p = origCreate(...a); createdPlane.push(p); return p; };

    inst.addCombatCard('e1', 'defender', RESULT);

    assert.equal(createdTex.length, 1);
    assert.equal(createdMat.length, 1);
    assert.equal(createdPlane.length, 1);
    // Nothing disposed yet — animation in flight.
    assert.equal(createdTex[0].disposed, 0);
    assert.equal(createdMat[0].disposed, 0);
    assert.equal(createdPlane[0].disposed, 0);

    // Fire the queued end callback.
    assert.equal(inst._endCbs.length, 1);
    inst._endCbs[0]();

    assert.equal(createdTex[0].disposed, 1, 'texture disposed on anim end');
    assert.equal(createdMat[0].disposed, 1, 'material disposed on anim end');
    assert.equal(createdPlane[0].disposed, 1, 'plane disposed on anim end');
  });

  test('speedFactor scales the hold (more frames at slower speed)', () => {
    // Capture the visibility animation keyframes to confirm scaling. The fake
    // Animation prototype's setKeys stashes the last keys it received.
    const slow = makeInst();
    let slowKeys = null;
    slow._babylon.Animation.prototype.setKeys = function (k) { slowKeys = k; };
    slow.addCombatCard('e1', 'attacker', RESULT, { speedFactor: 2 });

    const fast = makeInst();
    let fastKeys = null;
    fast._babylon.Animation.prototype.setKeys = function (k) { fastKeys = k; };
    fast.addCombatCard('e1', 'attacker', RESULT, { speedFactor: 1 });

    const slowEnd = slowKeys[slowKeys.length - 1].frame;
    const fastEnd = fastKeys[fastKeys.length - 1].frame;
    assert.ok(slowEnd > fastEnd, 'slower speedFactor yields more total frames');
  });
});
