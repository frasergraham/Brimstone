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

  test('every moving ally gets its OWN edge spot — no two allies share a target', () => {
    // Worst case the operator hit in play: allies whose live positions project
    // to overlapping spots. Each in-cap ally must claim a distinct edge of the
    // defender's hex.
    const plan = planCombatPositions({
      defender: { id: 'd', col: 5, row: 5 },
      attackAllies: [
        { id: 'a1', col: 4, row: 5 },
        { id: 'a2', col: 3, row: 5 }, // not adjacent — projects toward the same west edge as a1
      ],
      defenseAllies: [
        { id: 'b1', col: 6, row: 5 },
      ],
    });
    const movers = [...plan.attackerAllies, ...plan.defenderAllies].filter(a => a.moves);
    assert.equal(movers.length, 3);
    const spots = movers.map(a => `${a.toX.toFixed(6)},${a.toZ.toFixed(6)}`);
    assert.equal(new Set(spots).size, spots.length, 'all edge spots distinct');
    // Every mover stands ON an edge of the defender's hex (midpoint between the
    // defender centre and one of its 6 neighbours) — not on some interior point.
    const def = hexToWorld(5, 5);
    const edgeSpots = [
      [4, 5], [5, 4], [6, 4], [6, 5], [6, 6], [5, 6], // odd-row neighbours of (5,5)
    ].map(([c, r]) => {
      const n = hexToWorld(c, r);
      return { x: (def.x + n.x) * 0.5, z: (def.z + n.z) * 0.5 };
    });
    for (const m of movers) {
      const onEdge = edgeSpots.some(e => Math.hypot(e.x - m.toX, e.z - m.toZ) < 1e-6);
      assert.ok(onEdge, `ally ${m.id} stands on a defender hex edge`);
    }
  });

  test('attacker hex reserves its edge — allies never stand on the attacker’s lunge spot', () => {
    const plan = planCombatPositions({
      defender: { id: 'd', col: 5, row: 5 },
      attacker: { id: 'atk', col: 4, row: 5 },
      // Ally directly behind the attacker would naturally claim the same west
      // edge — it must be pushed to the next-nearest free edge instead.
      attackAllies: [{ id: 'a1', col: 3, row: 5 }],
    });
    const def = hexToWorld(5, 5);
    const atk = hexToWorld(4, 5);
    const attackerEdge = { x: (def.x + atk.x) * 0.5, z: (def.z + atk.z) * 0.5 };
    const out = plan.attackerAllies[0];
    assert.equal(out.moves, true);
    const dist = Math.hypot(out.toX - attackerEdge.x, out.toZ - attackerEdge.z);
    assert.ok(dist > 1e-6, 'ally does not land on the attacker’s reserved edge');
  });

  test('adjacent ally still lands on the shared-edge midpoint when no contention', () => {
    const plan = planCombatPositions({
      defender:     { id: 'd', col: 5, row: 5 },
      attackAllies: [{ id: 'a1', col: 4, row: 5 }],
    });
    const def = hexToWorld(5, 5);
    const ally = hexToWorld(4, 5);
    const out = plan.attackerAllies[0];
    assert.ok(Math.abs(out.toX - (def.x + ally.x) * 0.5) < 1e-9);
    assert.ok(Math.abs(out.toZ - (def.z + ally.z) * 0.5) < 1e-9);
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
  inst._activeMoveIds = new Set();
  inst._activeRunMoveIds = new Set();
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

// ─── Combat slide interrupting an in-flight MOVE ─────────────────────────────
// A guard reaction fires while the defender's move animation is still running.
// The combat slide stops the move mid-path; its "home" must be the move's
// LANDING point (where the entity logically is), not the transient mid-move
// position — otherwise returnAllLungeAnims slides the defender back toward its
// origin hex for a few frames before the next sync snaps it forward again.

function makeInflightInst({ ids = ['d'] } = {}) {
  const inst = Object.create(Renderer3D.prototype);
  inst._babylon = makeFakeBabylon();
  const captured = [];
  inst._capturedAnims = captured;
  inst._scene = {
    stopAnimation() {},
    // In-flight variant: capture the animation but do NOT auto-complete it.
    beginDirectAnimation(target, anims, _f, _to, _loop, _spd, onEnd) {
      captured.push({ target, anims, onEnd });
    },
  };
  inst._activeLungeIds = new Set();
  inst._activeMoveIds = new Set();
  inst._activeRunMoveIds = new Set();
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

describe('G2 — combat slide interrupting an in-flight MOVE', () => {
  test('addMoveAnim stashes the landing point on the standee', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInflightInst();
    inst.addMoveAnim('d', 4, 5, 5, 5, 'zombie', 'witch', null, null, 0, 0);
    const dest = hexToWorld(5, 5);
    assert.ok(inst._entityStandees.get('d').moveDest, 'moveDest stashed');
    assert.ok(Math.abs(inst._entityStandees.get('d').moveDest.x - dest.x) < 1e-9);
    assert.ok(Math.abs(inst._entityStandees.get('d').moveDest.z - dest.z) < 1e-9);
    assert.ok(inst._activeMoveIds.has('d'));
  });

  test('_animateStandeeTo mid-move: lungeHome is the move landing, not the mid-move spot', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInflightInst();
    const standee = inst._entityStandees.get('d');
    const from = hexToWorld(4, 5);
    const dest = hexToWorld(5, 5);
    // Move in flight: standee is halfway along the path.
    inst._activeMoveIds.add('d');
    standee.moveDest = { x: dest.x, z: dest.z };
    standee.plane.position.x = (from.x + dest.x) * 0.5;
    standee.plane.position.z = (from.z + dest.z) * 0.5;

    inst._animateStandeeTo('d', dest.x + 1.0, dest.z); // slide to some cluster spot
    const home = standee.lungeHome;
    assert.ok(home, 'lungeHome stashed');
    assert.ok(Math.abs(home.homeX - dest.x) < 1e-9, 'home X = move landing');
    assert.ok(Math.abs(home.homeZ - dest.z) < 1e-9, 'home Z = move landing');
  });

  test('addLungeAnim mid-move: lungeHome is the move landing, not the mid-move spot', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInflightInst();
    const standee = inst._entityStandees.get('d');
    const from = hexToWorld(4, 5);
    const dest = hexToWorld(5, 5);
    inst._activeMoveIds.add('d');
    standee.moveDest = { x: dest.x, z: dest.z };
    standee.plane.position.x = (from.x + dest.x) * 0.5;
    standee.plane.position.z = (from.z + dest.z) * 0.5;

    inst.addLungeAnim('d', 5, 5, 6, 5, 'zombie', 'witch', null, 0, false);
    const home = standee.lungeHome;
    assert.ok(home, 'lungeHome stashed');
    assert.ok(Math.abs(home.homeX - dest.x) < 1e-9, 'home X = move landing');
    assert.ok(Math.abs(home.homeZ - dest.z) < 1e-9, 'home Z = move landing');
  });

  test('no active move: lungeHome stays the standee\'s current position', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = makeInflightInst();
    const standee = inst._entityStandees.get('d');
    const dest = hexToWorld(5, 5);
    // Stale moveDest from a FINISHED move must not hijack the home.
    standee.moveDest = { x: dest.x + 9, z: dest.z + 9 };
    standee.plane.position.x = dest.x;
    standee.plane.position.z = dest.z;
    inst._animateStandeeTo('d', dest.x + 1.0, dest.z);
    const home = standee.lungeHome;
    assert.ok(Math.abs(home.homeX - dest.x) < 1e-9);
    assert.ok(Math.abs(home.homeZ - dest.z) < 1e-9);
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
