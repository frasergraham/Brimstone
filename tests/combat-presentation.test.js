// Tests for src/combat-presentation.js — the pure combat-frame clustering used
// by 3D cinematic mode to hold the camera across a chain of nearby battles.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { planCombatFrames, DEFAULT_CLUSTER_RADIUS, resolveLungeTargetWorld } from '../src/combat-presentation.js';

// Build a battle event with the shape main.js reads: battleSnaps.{actorSnap,targetSnap}.
function battle(actorId, ac, ar, targetId, tc, tr) {
  return {
    battleSnaps: {
      actorSnap:  { id: actorId,  col: ac, row: ar },
      targetSnap: { id: targetId, col: tc, row: tr },
    },
  };
}

describe('planCombatFrames', () => {
  test('empty / missing input → no frames', () => {
    assert.deepEqual(planCombatFrames([]), []);
    assert.deepEqual(planCombatFrames(undefined), []);
    assert.deepEqual(planCombatFrames(null), []);
  });

  test('single combat → one frame with both combatant ids', () => {
    const frames = planCombatFrames([battle('hero', 3, 3, 'zomb', 3, 4)]);
    assert.equal(frames.length, 1);
    assert.deepEqual([...frames[0].ids].sort(), ['hero', 'zomb']);
    assert.deepEqual(frames[0].eventIndices, [0]);
  });

  test('events lacking both snaps are skipped', () => {
    const frames = planCombatFrames([
      { battleSnaps: { actorSnap: { id: 'a', col: 1, row: 1 } } }, // no target
      {},                                                          // no snaps
      battle('h', 5, 5, 'z', 5, 6),
    ]);
    assert.equal(frames.length, 1);
    assert.deepEqual([...frames[0].ids].sort(), ['h', 'z']);
    // eventIndex is into the ORIGINAL array — the valid battle is index 2.
    assert.deepEqual(frames[0].eventIndices, [2]);
  });

  test('two battles sharing a combatant → single union frame', () => {
    // Hero attacks zombie, then the same hero is counter-attacked by a minion.
    const frames = planCombatFrames([
      battle('hero', 4, 4, 'zomb', 4, 5),
      battle('minion', 5, 4, 'hero', 4, 4),
    ]);
    assert.equal(frames.length, 1);
    assert.deepEqual([...frames[0].ids].sort(), ['hero', 'minion', 'zomb']);
    assert.deepEqual(frames[0].eventIndices, [0, 1]);
  });

  test('adjacent battles (within radius) → single union frame', () => {
    // Two separate pairs but the skirmishes are right next to each other.
    const frames = planCombatFrames([
      battle('h1', 2, 2, 'z1', 2, 3),
      battle('h2', 3, 3, 'z2', 3, 4),
    ]);
    assert.equal(frames.length, 1);
    assert.deepEqual([...frames[0].ids].sort(), ['h1', 'h2', 'z1', 'z2']);
  });

  test('distant battles → two separate sub-frames', () => {
    // One fight top-left, one fight far bottom-right (well beyond cluster radius).
    const frames = planCombatFrames([
      battle('h1', 1, 1, 'z1', 1, 2),
      battle('h2', 11, 11, 'z2', 11, 12),
    ]);
    assert.equal(frames.length, 2);
    assert.deepEqual([...frames[0].ids].sort(), ['h1', 'z1']);
    assert.deepEqual([...frames[1].ids].sort(), ['h2', 'z2']);
    assert.deepEqual(frames[0].eventIndices, [0]);
    assert.deepEqual(frames[1].eventIndices, [1]);
  });

  test('three battles: two near + one far → two frames, order preserved', () => {
    const frames = planCombatFrames([
      battle('a', 2, 2, 'b', 2, 3),    // cluster A
      battle('c', 12, 12, 'd', 12, 11), // cluster B (far)
      battle('e', 3, 2, 'f', 3, 3),    // joins cluster A
    ]);
    assert.equal(frames.length, 2);
    // First frame is the first-appearing cluster (A), covering battles 0 and 2.
    assert.deepEqual(frames[0].eventIndices, [0, 2]);
    assert.deepEqual([...frames[0].ids].sort(), ['a', 'b', 'e', 'f']);
    assert.deepEqual(frames[1].eventIndices, [1]);
    assert.deepEqual([...frames[1].ids].sort(), ['c', 'd']);
  });

  test('clusterRadius is configurable — a tiny radius splits adjacent fights', () => {
    const events = [
      battle('h1', 2, 2, 'z1', 2, 3),
      battle('h2', 3, 3, 'z2', 3, 4),
    ];
    // Distance between the two skirmishes is > 0 but < default radius, so
    // default clusters them; radius 0 forces a split.
    assert.equal(planCombatFrames(events).length, 1);
    assert.equal(planCombatFrames(events, { clusterRadius: 0 }).length, 2);
  });

  test('transitive merge: A near B, B near C, A far from C → all one frame', () => {
    // Chain of battles each within radius of the next — union-find links them
    // even though the endpoints exceed the cluster radius from each other.
    const r = DEFAULT_CLUSTER_RADIUS;
    const frames = planCombatFrames([
      battle('a', 0, 0, 'b', 0, 1),
      battle('c', r, 0, 'd', r, 1),
      battle('e', 2 * r, 0, 'f', 2 * r, 1),
    ]);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0].eventIndices, [0, 1, 2]);
  });
});

// ── Regression: replay crash when a unit's attack whiffs (null targetSnap) ────
//
// Repro of the operator-reported crash: a unit's intended target died / fled the
// SAME turn it attacked, so the resolver resolves the attack as a WHIFF
// (ACTION_SKIP with battleSnaps `{ actorSnap, ranged }`, a `whiffTarget` hex,
// and NO targetSnap — see server/resolver.js targetFled / empty-hex BATTLE_HEX).
// The replay layer (_playAttackIntroAnim in src/main.js) then drives the lunge.
// The combat-defender-slot change (commit eb7364b9) made the melee branch read
// `renderer.entityWorldPos(targetSnap.id)` UNCONDITIONALLY, so a whiff's null
// targetSnap threw `TypeError: Cannot read properties of null (reading 'id')`.
//
// resolveLungeTargetWorld is that exact dereference, extracted DOM-free. These
// assertions are RED against the pre-fix unconditional `targetSnap.id` read and
// GREEN with the null guard. The lunge must fall back to the hex centre (null
// world anchor) for a whiff, never throw.
describe('resolveLungeTargetWorld — null-safe whiff aiming', () => {
  // entityWorldPos mirrors renderer-3d.js: resolves a slot for known ids,
  // returns null for an id with no standee/entity.
  const renderer = {
    entityWorldPos(id) {
      return id === 'defender' ? { x: 4.2, z: 1.7 } : null;
    },
  };

  test('null targetSnap (whiff) → null, does NOT throw', () => {
    // This is the operator's crash: the dead/fled-target whiff passes targetSnap=null.
    assert.doesNotThrow(() => resolveLungeTargetWorld(renderer, null));
    assert.equal(resolveLungeTargetWorld(renderer, null), null);
    assert.equal(resolveLungeTargetWorld(renderer, undefined), null);
  });

  test('targetSnap without an id → null, does NOT throw', () => {
    assert.doesNotThrow(() => resolveLungeTargetWorld(renderer, {}));
    assert.equal(resolveLungeTargetWorld(renderer, {}), null);
    assert.equal(resolveLungeTargetWorld(renderer, { id: null }), null);
  });

  test('live defender → aims at its standee slot', () => {
    assert.deepEqual(
      resolveLungeTargetWorld(renderer, { id: 'defender', col: 3, row: 4 }),
      { x: 4.2, z: 1.7 },
    );
  });

  test('defender id with no resolvable standee → null (hex-centre fallback)', () => {
    assert.equal(resolveLungeTargetWorld(renderer, { id: 'ghost' }), null);
  });

  test('renderer without entityWorldPos (2D editor) → null, never throws', () => {
    assert.doesNotThrow(() => resolveLungeTargetWorld({}, { id: 'defender' }));
    assert.equal(resolveLungeTargetWorld({}, { id: 'defender' }), null);
    assert.equal(resolveLungeTargetWorld(null, { id: 'defender' }), null);
  });
});
