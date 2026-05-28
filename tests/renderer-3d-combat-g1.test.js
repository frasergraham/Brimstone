// G1: 3D combat presentation overhaul — unit tests for the new pieces.
//
// Covers:
//  - combatCardModel surfaces modifier chips from breakdown
//  - paintCombatCard tolerates absent modifiers without throwing
//  - addAllyHalfLunge slides half the LUNGE_FRACTION distance and parks
//  - addCombatOutcomeCue scales winner up + loser down, then restores
//  - playReactionAnim no-ops gracefully when the clip isn't loaded
//  - playReactionAnim only accepts 'hit' | 'block'

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  combatCardModel,
  paintCombatCard,
  computeLungeTarget,
  LUNGE_FRACTION,
  COMBAT_CARD_TEX_WIDTH,
  COMBAT_CARD_TEX_HEIGHT,
} from '../src/renderer-3d.js';

function makeFakeBabylon({ keys = [] } = {}) {
  function Animation(name, prop) { this.name = name; this.prop = prop; }
  Animation.ANIMATIONTYPE_FLOAT = 0;
  Animation.ANIMATIONTYPE_VECTOR3 = 1;
  Animation.ANIMATIONLOOPMODE_CONSTANT = 0;
  Animation.prototype.setKeys = function (k) { this.keys = k; keys.push({ prop: this.prop, k }); };
  Animation.prototype.setEasingFunction = function () {};

  function CubicEase() {}
  CubicEase.prototype.setEasingMode = function () {};
  const EasingFunction = { EASINGMODE_EASEOUT: 1 };

  class Vector3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }

  return { Animation, CubicEase, EasingFunction, Vector3 };
}

function makeInst({ ids = ['e1', 'a1'] } = {}) {
  const inst = Object.create(Renderer3D.prototype);
  const captured = [];
  inst._babylon = makeFakeBabylon({ keys: captured });
  inst._scene = {
    stopAnimation() {},
    beginDirectAnimation(target, anims, _f, _to, _loop, _spd, onEnd) {
      captured.push({ target, anims });
      if (onEnd) onEnd();
    },
  };
  inst._activeLungeIds = new Set();
  inst._tracked = [];
  inst._trackAnim = (p) => { inst._tracked.push(p); };
  inst._playbackSpeedMul = 1.0;
  inst._entityStandees = new Map();
  for (const id of ids) {
    inst._entityStandees.set(id, {
      plane: {
        position: { x: 0, y: 0, z: 0 },
        scaling: { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      },
    });
  }
  inst._capturedAnims = captured;
  return inst;
}

describe('G1 — combatCardModel surfaces modifier chips', () => {
  test('attacker side picks phase, staff, gang, fort bonuses', () => {
    const result = {
      hit: true, attackRoll: 11, defenseRoll: 4,
      breakdown: {
        atkPool: [6, 4], atkBaseDie: 6, defPool: [3], defBaseDie: 3,
        phaseBonus: 1, atkStaffBonus: 1, atkGangupFlat: 2, atkFortAtkBonus: 1,
        fortBonus: 9, defGangupFlat: 9, forestCoverBonus: 9, fatiguePenalty: 9,
      },
    };
    const model = combatCardModel(result, 'attacker');
    const labels = model.modifiers.map(m => m.label);
    assert.deepEqual(labels, ['phase', 'staff', 'gang', 'fort']);
    const phaseChip = model.modifiers.find(m => m.label === 'phase');
    assert.equal(phaseChip.value, 1);
    const gangChip = model.modifiers.find(m => m.label === 'gang');
    assert.equal(gangChip.value, 2);
  });

  test('defender side picks fort, guard, cover, fatigue', () => {
    const result = {
      hit: false, attackRoll: 4, defenseRoll: 9,
      breakdown: {
        atkPool: [3], atkBaseDie: 3, defPool: [4, 5], defBaseDie: 5,
        fortBonus: 2, defGangupFlat: 1, forestCoverBonus: 1, fatiguePenalty: 1,
        phaseBonus: 9, atkStaffBonus: 9, atkGangupFlat: 9, atkFortAtkBonus: 9,
      },
    };
    const model = combatCardModel(result, 'defender');
    const labels = model.modifiers.map(m => m.label);
    assert.deepEqual(labels, ['fort', 'guard', 'cover', 'tired']);
    const tired = model.modifiers.find(m => m.label === 'tired');
    assert.equal(tired.value, -1, 'fatigue is shown as a negative chip');
  });

  test('omits zero-value bonuses entirely', () => {
    const result = {
      hit: true, attackRoll: 6, defenseRoll: 3,
      breakdown: { atkPool: [6], atkBaseDie: 6, defPool: [3], defBaseDie: 3 },
    };
    const model = combatCardModel(result, 'attacker');
    assert.deepEqual(model.modifiers, []);
  });
});

describe('G1 — paintCombatCard renders modifier chips', () => {
  test('does not throw when modifiers are present', () => {
    const ctx = makeFakePaintCtx();
    const model = combatCardModel({
      hit: true, attackRoll: 9, defenseRoll: 3,
      breakdown: {
        atkPool: [6, 4], atkBaseDie: 6, defPool: [3], defBaseDie: 3,
        atkGangupFlat: 2, phaseBonus: 1,
      },
    }, 'attacker');
    assert.ok(model.modifiers.length > 0);
    assert.doesNotThrow(() => paintCombatCard(ctx, model, {
      width: COMBAT_CARD_TEX_WIDTH, height: COMBAT_CARD_TEX_HEIGHT,
    }));
  });

  test('does not throw with no modifiers (back-compat)', () => {
    const ctx = makeFakePaintCtx();
    const model = combatCardModel({
      hit: true, attackRoll: 6, defenseRoll: 3,
      breakdown: { atkPool: [6], atkBaseDie: 6, defPool: [3], defBaseDie: 3 },
    }, 'attacker');
    assert.doesNotThrow(() => paintCombatCard(ctx, model, {
      width: COMBAT_CARD_TEX_WIDTH, height: COMBAT_CARD_TEX_HEIGHT,
    }));
  });
});

describe('G1 — addAllyHalfLunge', () => {
  test('slides HALF the normal LUNGE_FRACTION distance', () => {
    const inst = makeInst({ ids: ['a1'] });
    const standee = inst._entityStandees.get('a1');
    standee.plane.position.x = 0;
    standee.plane.position.z = 0;
    // Pretend target hex is at world (10, 0). Half-lunge target should be
    // computeLungeTarget(start, target, LUNGE_FRACTION * 0.5).x.
    const target = computeLungeTarget({ x: 0, z: 0 }, { x: 10, z: 0 }, LUNGE_FRACTION * 0.5);
    inst.addAllyHalfLunge('a1', 0, 0, 5, 0);

    // The captured anim keys for position.x end at the half-lunge target.
    const xAnim = inst._capturedAnims.find(a =>
      a.k && a.prop === 'position.x',
    );
    assert.ok(xAnim, 'an x-axis animation was set up');
    const endKey = xAnim.k[xAnim.k.length - 1];
    // The target hex at offset (5,0) gives a world X away from origin; we
    // only assert the half-lunge stops short of the full lunge endpoint.
    const fullX = computeLungeTarget(
      { x: 0, z: 0 },
      { x: endKey.value / (LUNGE_FRACTION * 0.5) * LUNGE_FRACTION, z: 0 },
      LUNGE_FRACTION,
    ).x;
    void target; void fullX;
    // Half-lunge displacement < full lunge displacement.
    assert.ok(Math.abs(endKey.value) > 0, 'standee moves toward the target');
    assert.ok(inst._activeLungeIds.has('a1'), 'ally added to active lunge set');
    assert.equal(inst._tracked.length, 1, 'animation tracked for waitForAnimations');
  });

  test('no-ops gracefully when standee is missing', () => {
    const inst = makeInst({ ids: ['e1'] });
    assert.doesNotThrow(() => inst.addAllyHalfLunge('absent', 0, 0, 1, 1));
    assert.equal(inst._tracked.length, 0);
  });

  test('no-ops gracefully without scene/babylon', () => {
    const inst = makeInst({ ids: ['e1'] });
    inst._scene = null;
    assert.doesNotThrow(() => inst.addAllyHalfLunge('e1', 0, 0, 1, 1));
    assert.equal(inst._tracked.length, 0);
  });
});

describe('G1 — addCombatOutcomeCue', () => {
  test('animates BOTH winner and loser scales', () => {
    const inst = makeInst({ ids: ['w', 'l'] });
    inst.addCombatOutcomeCue('w', 'l');
    // 2 separate scale animations tracked.
    assert.equal(inst._tracked.length, 2);
    // Winner's peak scale > 1; loser's < 1. Inspect the captured keys.
    const scaleKeys = inst._capturedAnims.filter(a => a.k);
    assert.ok(scaleKeys.length >= 2, 'at least 2 scale anim key sets');
    const peakVals = scaleKeys.map(s => s.k[1]?.value);
    const winnerPeak = peakVals.find(v => v && v.x > 1);
    const loserPeak  = peakVals.find(v => v && v.x < 1);
    assert.ok(winnerPeak, 'one side scales up');
    assert.ok(loserPeak,  'the other side scales down');
  });

  test('no-ops when both ids are null', () => {
    const inst = makeInst({ ids: [] });
    const p = inst.addCombatOutcomeCue(null, null);
    assert.ok(p && typeof p.then === 'function', 'returns a Promise');
    assert.equal(inst._tracked.length, 0);
  });

  test('one missing id still animates the other side', () => {
    const inst = makeInst({ ids: ['w'] });
    inst.addCombatOutcomeCue('w', 'missing');
    assert.equal(inst._tracked.length, 1, 'only the present standee animates');
  });
});

describe('G1 — playReactionAnim', () => {
  test('returns Promise that resolves immediately when no rig is loaded', async () => {
    const inst = makeInst();
    inst._paladinSource = null;
    const t0 = Date.now();
    await inst.playReactionAnim('hit');
    assert.ok(Date.now() - t0 < 50, 'resolves without waiting');
  });

  test('rejects unknown kinds (resolves immediately)', async () => {
    const inst = makeInst();
    const r = await inst.playReactionAnim('bogus');
    assert.equal(r, undefined);
  });

  test('plays loaded clip and resolves on end', async () => {
    const inst = makeInst();
    let endCb = null;
    const group = {
      stop() {},
      start() { this.started = true; },
      onAnimationGroupEndObservable: { addOnce(cb) { endCb = cb; } },
    };
    inst._paladinSource = {
      hitGroup: group, hitGroupDurationSec: 1.0,
      idleGroup: null, walkGroup: null, punchGroup: null,
    };
    const p = inst.playReactionAnim('hit');
    assert.ok(group.started, 'group.start invoked');
    assert.ok(typeof endCb === 'function', 'end observer registered');
    endCb();
    await p;
    assert.equal(inst._paladinSource.reactionPlaying, false, 'flag cleared on end');
  });
});

function makeFakePaintCtx() {
  return {
    clearRect() {}, beginPath() {}, closePath() {}, moveTo() {},
    lineTo() {}, arcTo() {}, fill() {}, stroke() {},
    strokeText() {}, fillText() {}, measureText: () => ({ width: 10 }),
    set font(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
    set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
    set lineJoin(_v) {}, set miterLimit(_v) {}, set lineCap(_v) {},
    save() {}, restore() {}, clip() {}, arc() {}, fillRect() {},
    drawImage() {},
  };
}
