// G2 combat positioning — defender re-centres + allies slide to defender-hex
// edges. Covers:
//   - pure planCombatPositions geometry (edge midpoint, ADVANTAGE_CAP)
//   - Renderer3D.applyCombatPositioning lifecycle (anim tracked, lungeHome set)
//   - cap+1 ally does NOT move
//   - addAllyHalfLunge back-compat shim still slides toward target

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  planCombatPositions,
  hexToWorld,
  LUNGE_ANIM_MS,
} from '../src/renderer-3d.js';
import { ADVANTAGE_CAP } from '../src/entities.js';

// ─── Pure geometry ──────────────────────────────────────────────────────────

describe('G2 — planCombatPositions geometry', () => {
  test('defender target is the defender hex centre', () => {
    const plan = planCombatPositions({
      defender: { id: 'd', col: 4, row: 2 },
    });
    const c = hexToWorld(4, 2);
    assert.ok(Math.abs(plan.defender.x - c.x) < 1e-9);
    assert.ok(Math.abs(plan.defender.z - c.z) < 1e-9);
    assert.deepEqual(plan.attackerAllies, []);
    assert.deepEqual(plan.defenderAllies, []);
  });

  test('ally target is the midpoint between ally hex centre and defender hex centre (= shared edge midpoint)', () => {
    const plan = planCombatPositions({
      defender:     { id: 'd', col: 5, row: 5 },
      attackAllies: [{ id: 'a1', col: 4, row: 5 }],
    });
    const def = hexToWorld(5, 5);
    const ally = hexToWorld(4, 5);
    assert.equal(plan.attackerAllies.length, 1);
    const out = plan.attackerAllies[0];
    assert.equal(out.id, 'a1');
    assert.equal(out.moves, true);
    assert.ok(Math.abs(out.toX - (def.x + ally.x) * 0.5) < 1e-9);
    assert.ok(Math.abs(out.toZ - (def.z + ally.z) * 0.5) < 1e-9);
  });

  test('defender-side allies project the same way (toward defender hex centre)', () => {
    const plan = planCombatPositions({
      defender:      { id: 'd', col: 5, row: 5 },
      defenseAllies: [{ id: 'd1', col: 6, row: 5 }],
    });
    const def = hexToWorld(5, 5);
    const ally = hexToWorld(6, 5);
    const out = plan.defenderAllies[0];
    assert.equal(out.moves, true);
    assert.ok(Math.abs(out.toX - (def.x + ally.x) * 0.5) < 1e-9);
    assert.ok(Math.abs(out.toZ - (def.z + ally.z) * 0.5) < 1e-9);
  });

  test('first ADVANTAGE_CAP allies move; the rest stay put (moves=false)', () => {
    assert.equal(ADVANTAGE_CAP, 3, 'ADVANTAGE_CAP guards this test');
    const plan = planCombatPositions({
      defender: { id: 'd', col: 5, row: 5 },
      attackAllies: [
        { id: 'a1', col: 4, row: 5 },
        { id: 'a2', col: 6, row: 5 },
        { id: 'a3', col: 5, row: 4 },
        { id: 'a4', col: 5, row: 6 }, // beyond cap — stays put
      ],
    });
    assert.equal(plan.attackerAllies[0].moves, true);
    assert.equal(plan.attackerAllies[1].moves, true);
    assert.equal(plan.attackerAllies[2].moves, true);
    assert.equal(plan.attackerAllies[3].moves, false);
    // The cap+1 ally's target equals its own hex centre — no movement.
    const a4Centre = hexToWorld(5, 6);
    assert.ok(Math.abs(plan.attackerAllies[3].toX - a4Centre.x) < 1e-9);
    assert.ok(Math.abs(plan.attackerAllies[3].toZ - a4Centre.z) < 1e-9);
  });

  test('advantageCap is respected per side independently (3 atk + 3 def all move; 4th of either stays)', () => {
    const plan = planCombatPositions({
      defender: { id: 'd', col: 5, row: 5 },
      attackAllies:  [
        { id: 'a1', col: 4, row: 5 }, { id: 'a2', col: 6, row: 5 }, { id: 'a3', col: 5, row: 4 },
        { id: 'a4', col: 5, row: 6 },
      ],
      defenseAllies: [
        { id: 'b1', col: 4, row: 4 }, { id: 'b2', col: 6, row: 4 }, { id: 'b3', col: 4, row: 6 },
        { id: 'b4', col: 6, row: 6 },
      ],
    });
    assert.deepEqual(
      plan.attackerAllies.map(a => a.moves),
      [true, true, true, false],
    );
    assert.deepEqual(
      plan.defenderAllies.map(a => a.moves),
      [true, true, true, false],
    );
  });
});

// ─── Renderer3D.applyCombatPositioning lifecycle ────────────────────────────

function makeFakeBabylon() {
  class Animation {
    constructor(name, prop) { this.name = name; this.prop = prop; this.keys = []; this.ease = null; }
    setKeys(k) { this.keys = k; }
    setEasingFunction(e) { this.ease = e; }
  }
  Animation.ANIMATIONTYPE_FLOAT = 0;
  Animation.ANIMATIONLOOPMODE_CONSTANT = 0;
  class CubicEase { setEasingMode() {} }
  const EasingFunction = { EASINGMODE_EASEOUT: 2 };
  class Vector3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
  return { Animation, CubicEase, EasingFunction, Vector3 };
}

function makeInst({ ids = ['d', 'a1', 'a2', 'a3', 'a4'] } = {}) {
  const inst = Object.create(Renderer3D.prototype);
  inst._babylon = makeFakeBabylon();
  const captured = [];
  inst._capturedAnims = captured;
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
        position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
        scaling: { x: 1, y: 1, z: 1, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      },
    });
  }
  return inst;
}

describe('G2 — Renderer3D.applyCombatPositioning lifecycle', () => {
  test('defender re-centres + each in-cap ally tracked; cap+1 ally NOT tracked', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst();
    // Place each standee at its starting hex centre so anim deltas are real.
    const place = (id, col, row) => {
      const { x, z } = hexToWorld(col, row);
      const p = inst._entityStandees.get(id).plane.position;
      p.x = x; p.z = z;
    };
    // Defender will be re-centred from a slightly off-centre spot.
    place('d', 5, 5);
    inst._entityStandees.get('d').plane.position.x += 0.5; // off-centre nudge
    place('a1', 4, 5); place('a2', 6, 5); place('a3', 5, 4); place('a4', 5, 6);

    inst.applyCombatPositioning({
      defender: { id: 'd', col: 5, row: 5 },
      attackAllies: [
        { id: 'a1', col: 4, row: 5 },
        { id: 'a2', col: 6, row: 5 },
        { id: 'a3', col: 5, row: 4 },
        { id: 'a4', col: 5, row: 6 },
      ],
    });

    assert.ok(inst._activeLungeIds.has('d'),  'defender registered (off-centre nudge → moves)');
    assert.ok(inst._activeLungeIds.has('a1'), 'a1 registered');
    assert.ok(inst._activeLungeIds.has('a2'), 'a2 registered');
    assert.ok(inst._activeLungeIds.has('a3'), 'a3 registered');
    assert.ok(!inst._activeLungeIds.has('a4'),
      'cap+1 ally NOT registered — stays in its starting hex');
    // 4 anims tracked (defender + 3 allies; cap+1 skipped).
    assert.equal(inst._tracked.length, 4);
  });

  test('defender already centred → no anim queued for defender', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['d', 'a1'] });
    const place = (id, col, row) => {
      const { x, z } = hexToWorld(col, row);
      const p = inst._entityStandees.get(id).plane.position;
      p.x = x; p.z = z;
    };
    place('d', 5, 5); // exactly centred
    place('a1', 4, 5);
    inst.applyCombatPositioning({
      defender: { id: 'd', col: 5, row: 5 },
      attackAllies: [{ id: 'a1', col: 4, row: 5 }],
    });
    assert.ok(!inst._activeLungeIds.has('d'),
      'defender at its hex centre is a no-op');
    assert.ok(inst._activeLungeIds.has('a1'));
    assert.equal(inst._tracked.length, 1);
  });

  test('ally landing position matches plan target (anim end key matches midpoint)', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['d', 'a1'] });
    const place = (id, col, row) => {
      const { x, z } = hexToWorld(col, row);
      const p = inst._entityStandees.get(id).plane.position;
      p.x = x; p.z = z;
    };
    place('d', 5, 5);
    place('a1', 4, 5);
    inst.applyCombatPositioning({
      defender: { id: 'd', col: 5, row: 5 },
      attackAllies: [{ id: 'a1', col: 4, row: 5 }],
    });
    // Find the anim queued onto a1's plane and inspect the final keyframe.
    const a1Plane = inst._entityStandees.get('a1').plane;
    const cap = inst._capturedAnims.find(c => c.target === a1Plane);
    assert.ok(cap, 'an anim was queued onto the ally standee');
    const xAnim = cap.anims.find(a => a.prop === 'position.x');
    const zAnim = cap.anims.find(a => a.prop === 'position.z');
    const def  = hexToWorld(5, 5);
    const ally = hexToWorld(4, 5);
    const midX = (def.x + ally.x) * 0.5;
    const midZ = (def.z + ally.z) * 0.5;
    assert.ok(Math.abs(xAnim.keys[1].value - midX) < 1e-6);
    assert.ok(Math.abs(zAnim.keys[1].value - midZ) < 1e-6);
  });

  test('lungeHome stashed → returnAllLungeAnims will bring everyone back', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['d', 'a1'] });
    const place = (id, col, row) => {
      const { x, z } = hexToWorld(col, row);
      const p = inst._entityStandees.get(id).plane.position;
      p.x = x; p.z = z;
    };
    place('a1', 4, 5);
    const a1Start = { ...inst._entityStandees.get('a1').plane.position };
    place('d', 5, 5);
    inst._entityStandees.get('d').plane.position.x += 1.0; // off-centre

    inst.applyCombatPositioning({
      defender: { id: 'd', col: 5, row: 5 },
      attackAllies: [{ id: 'a1', col: 4, row: 5 }],
    });

    // lungeHome captures the pre-positioning location for each mover.
    const a1Home = inst._entityStandees.get('a1').lungeHome;
    assert.ok(a1Home, 'ally lungeHome stashed');
    assert.ok(Math.abs(a1Home.homeX - a1Start.x) < 1e-9);
    assert.ok(Math.abs(a1Home.homeZ - a1Start.z) < 1e-9);
  });

  test('no-ops gracefully when standee is missing (defender or ally)', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: [] });
    assert.doesNotThrow(() => inst.applyCombatPositioning({
      defender: { id: 'absent', col: 0, row: 0 },
      attackAllies: [{ id: 'missing', col: 1, row: 0 }],
    }));
    assert.equal(inst._tracked.length, 0);
  });

  test('compressed durMs (vfast) shrinks frame count proportionally', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['d', 'a1'] });
    const place = (id, col, row) => {
      const { x, z } = hexToWorld(col, row);
      const p = inst._entityStandees.get(id).plane.position;
      p.x = x; p.z = z;
    };
    place('d', 5, 5);
    place('a1', 4, 5);
    inst.applyCombatPositioning(
      {
        defender: { id: 'd', col: 5, row: 5 },
        attackAllies: [{ id: 'a1', col: 4, row: 5 }],
      },
      { durMs: 200 },
    );
    const cap = inst._capturedAnims[0];
    const xAnim = cap.anims.find(a => a.prop === 'position.x');
    // 200ms * 60fps / 1000 = 12 frames.
    assert.equal(xAnim.keys[1].frame, 12);
  });

  test('default durMs is LUNGE_ANIM_MS (400ms = 24 frames at 60fps)', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['d', 'a1'] });
    const place = (id, col, row) => {
      const { x, z } = hexToWorld(col, row);
      const p = inst._entityStandees.get(id).plane.position;
      p.x = x; p.z = z;
    };
    place('d', 5, 5);
    place('a1', 4, 5);
    inst.applyCombatPositioning({
      defender: { id: 'd', col: 5, row: 5 },
      attackAllies: [{ id: 'a1', col: 4, row: 5 }],
    });
    const cap = inst._capturedAnims[0];
    const xAnim = cap.anims.find(a => a.prop === 'position.x');
    const expected = Math.round(LUNGE_ANIM_MS * 60 / 1000);
    assert.equal(xAnim.keys[1].frame, expected);
  });
});

// ─── Back-compat: addAllyHalfLunge still wired ──────────────────────────────

describe('G2 — addAllyHalfLunge back-compat shim', () => {
  test('still slides ally and tracks the animation', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: ['a1'] });
    inst.addAllyHalfLunge('a1', 0, 0, 5, 0);
    assert.ok(inst._activeLungeIds.has('a1'));
    assert.equal(inst._tracked.length, 1);
  });

  test('missing standee → no throw, no track', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInst({ ids: [] });
    assert.doesNotThrow(() => inst.addAllyHalfLunge('absent', 0, 0, 5, 0));
    assert.equal(inst._tracked.length, 0);
  });
});
