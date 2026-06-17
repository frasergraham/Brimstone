// Unit tests for the pure facing math used by conversation/combat orientation
// (src/facing-math.js). DOM-free and Babylon-free — they verify the rotation
// produced points each unit at the other under the renderer's left-handed
// Y-up convention (`rotation.y = atan2(dx, dz)`).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FACE_TURN_MS, FACING_EPSILON, POSITION_EPSILON,
  bearingTo, shortestYawDelta, isWithinFacingEpsilon,
  planFacingTurn, centroidXZ, planConversationOrientation,
} from '../src/facing-math.js';

const TAU = Math.PI * 2;
const close = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;
// Wrap into (-π, π] so 0 == 2π comparisons read cleanly.
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

describe('bearingTo (rotation.y = atan2(dx, dz))', () => {
  test('north (+Z) is yaw 0', () => {
    assert.ok(close(bearingTo(0, 0, 0, 1), 0));
  });

  test('east (+X) is yaw +π/2', () => {
    assert.ok(close(bearingTo(0, 0, 1, 0), Math.PI / 2));
  });

  test('south (-Z) is yaw ±π', () => {
    // atan2(0, -1) = π exactly
    assert.ok(close(bearingTo(0, 0, 0, -1), Math.PI));
  });

  test('west (-X) is yaw -π/2', () => {
    assert.ok(close(bearingTo(0, 0, -1, 0), -Math.PI / 2));
  });

  test('north-east (+X, +Z) is yaw +π/4', () => {
    assert.ok(close(bearingTo(0, 0, 1, 1), Math.PI / 4));
  });

  test('returns null for coincident source + target', () => {
    assert.equal(bearingTo(2.5, 7.0, 2.5, 7.0), null);
    // within POSITION_EPSILON also counts as coincident
    assert.equal(bearingTo(2.5, 7.0, 2.5 + POSITION_EPSILON / 2, 7.0), null);
  });

  test('non-zero source: bearings are world-relative, not local', () => {
    // Both at z=5; target is east of source.
    assert.ok(close(bearingTo(3, 5, 5, 5), Math.PI / 2));
    // Target is north-west of source.
    assert.ok(close(bearingTo(3, 5, 2, 6), Math.atan2(-1, 1)));
  });
});

describe('shortestYawDelta (avoids spinning the long way)', () => {
  test('0 → 0 = 0', () => {
    assert.ok(close(shortestYawDelta(0, 0), 0));
  });

  test('0 → π/2 = +π/2', () => {
    assert.ok(close(shortestYawDelta(0, Math.PI / 2), Math.PI / 2));
  });

  test('π/2 → 0 = -π/2', () => {
    assert.ok(close(shortestYawDelta(Math.PI / 2, 0), -Math.PI / 2));
  });

  test('359° → 1° is +2°, not -358°', () => {
    const from = (359 / 360) * TAU;
    const desired = (1 / 360) * TAU;
    const delta = shortestYawDelta(from, desired);
    assert.ok(close(delta, (2 / 360) * TAU, 1e-9),
      `expected ~+2° (${(2 / 360) * TAU}), got ${delta}`);
  });

  test('1° → 359° is -2°, not +358°', () => {
    const from = (1 / 360) * TAU;
    const desired = (359 / 360) * TAU;
    const delta = shortestYawDelta(from, desired);
    assert.ok(close(delta, -(2 / 360) * TAU, 1e-9),
      `expected ~-2° (${-(2 / 360) * TAU}), got ${delta}`);
  });

  test('exact opposite (Δ = π) is the canonical +π', () => {
    // atan2(sin(π), cos(π)) = atan2(0, -1) = π
    assert.ok(close(shortestYawDelta(0, Math.PI), Math.PI));
  });
});

describe('isWithinFacingEpsilon', () => {
  test('0 is within epsilon', () => {
    assert.equal(isWithinFacingEpsilon(0), true);
  });

  test('just under epsilon counts as within', () => {
    assert.equal(isWithinFacingEpsilon(FACING_EPSILON * 0.99), true);
    assert.equal(isWithinFacingEpsilon(-FACING_EPSILON * 0.99), true);
  });

  test('just over epsilon does NOT count as within', () => {
    assert.equal(isWithinFacingEpsilon(FACING_EPSILON * 1.01), false);
  });

  test('custom epsilon overrides the default', () => {
    assert.equal(isWithinFacingEpsilon(0.5, 0.1), false);
    assert.equal(isWithinFacingEpsilon(0.05, 0.1), true);
  });
});

describe('planFacingTurn — combined bearing + shortest-arc + epsilon', () => {
  test('two units side-by-side: each faces the other', () => {
    // Hero at (0, 0), innkeeper at (2, 0). Hero should face +X (yaw +π/2).
    const hero = { x: 0, z: 0 };
    const inn  = { x: 2, z: 0 };
    const turnHero = planFacingTurn(hero, /*currentYaw*/ 0, inn);
    assert.ok(turnHero);
    assert.ok(close(wrapPi(turnHero.desired), Math.PI / 2));
    // Innkeeper at +X should face -X (yaw -π/2).
    const turnInn = planFacingTurn(inn, 0, hero);
    assert.ok(turnInn);
    assert.ok(close(wrapPi(turnInn.desired), -Math.PI / 2));
  });

  test('hero facing innkeeper from line-1 of Ch1M1: matches live-game probe', () => {
    // From verify-conv-live.mjs probe (recorded yaw values from the running
    // game). Hero standee plane.position = (4.330127, 10.5); innkeeper at
    // (5.196152, 9.0). The renderer measured hero rotY = 2.617993... .
    const hero = { x: 4.330127018922193, z: 10.5 };
    const inn  = { x: 5.196152422706632, z: 9.0 };
    const turn = planFacingTurn(hero, /*currentYaw*/ 0, inn);
    assert.ok(turn);
    assert.ok(close(turn.desired, 2.617993877991494, 1e-9),
      `expected hero yaw 2.617993877991494, got ${turn.desired}`);
    // Reverse: innkeeper → hero matches probed 5.759... (mod 2π = -0.523...).
    const back = planFacingTurn(inn, 0, hero);
    assert.ok(back);
    // The probe reads MOD 2π; we return signed (-π, π].
    assert.ok(close(back.desired, -0.5235987755982987, 1e-9),
      `expected innkeeper yaw -π/6, got ${back.desired}`);
  });

  test('coincident points → null (skip)', () => {
    assert.equal(
      planFacingTurn({ x: 3, z: 4 }, 0, { x: 3, z: 4 }),
      null,
    );
  });

  test('already facing within epsilon → null (skip)', () => {
    const hero = { x: 0, z: 0 };
    const target = { x: 0, z: 5 };          // bearing = 0
    // Current yaw is 0.5 * epsilon — within tolerance.
    assert.equal(planFacingTurn(hero, FACING_EPSILON / 2, target), null);
  });

  test('just-outside epsilon DOES return a turn', () => {
    const hero = { x: 0, z: 0 };
    const target = { x: 0, z: 5 };
    const turn = planFacingTurn(hero, FACING_EPSILON * 2, target);
    assert.ok(turn);
    assert.ok(close(turn.desired, 0));
    // Shortest delta from +ε*2 toward 0 is -ε*2.
    assert.ok(close(turn.delta, -FACING_EPSILON * 2, 1e-9));
  });
});

describe('centroidXZ', () => {
  test('single point → itself', () => {
    const c = centroidXZ([{ x: 3, z: 4 }]);
    assert.deepEqual(c, { x: 3, z: 4 });
  });

  test('two points → midpoint', () => {
    const c = centroidXZ([{ x: 0, z: 0 }, { x: 2, z: 4 }]);
    assert.deepEqual(c, { x: 1, z: 2 });
  });

  test('empty list → null', () => {
    assert.equal(centroidXZ([]), null);
    assert.equal(centroidXZ(null), null);
    assert.equal(centroidXZ(undefined), null);
  });

  test('three points → arithmetic mean', () => {
    const c = centroidXZ([{ x: 0, z: 0 }, { x: 3, z: 0 }, { x: 0, z: 3 }]);
    assert.deepEqual(c, { x: 1, z: 1 });
  });
});

describe('planConversationOrientation — speaker faces centroid; listeners face speaker', () => {
  test('two-participant conversation: each turns to the other', () => {
    const hero = { id: 'hero', pos: { x: 0, z: 0 }, currentYaw: 0 };
    const inn  = { id: 'inn',  pos: { x: 2, z: 0 }, currentYaw: 0 };
    const turns = planConversationOrientation('hero', [hero, inn]);
    // Two non-skip turns: hero faces +X (π/2), innkeeper faces -X (-π/2).
    assert.equal(turns.length, 2);
    const heroTurn = turns.find(t => t.id === 'hero');
    const innTurn  = turns.find(t => t.id === 'inn');
    assert.ok(heroTurn && innTurn);
    assert.ok(close(wrapPi(heroTurn.desired),  Math.PI / 2));
    assert.ok(close(wrapPi(innTurn.desired),  -Math.PI / 2));
  });

  test('three-participant conversation: speaker faces centroid of the other two', () => {
    const speaker = { id: 's', pos: { x: 0, z: 0 }, currentYaw: 0 };
    const a = { id: 'a', pos: { x: 2, z: 0 }, currentYaw: 0 };
    const b = { id: 'b', pos: { x: 0, z: 2 }, currentYaw: 0 };
    const turns = planConversationOrientation('s', [speaker, a, b]);
    // Speaker faces centroid of (a,b) = (1, 1) → atan2(1, 1) = π/4.
    const sTurn = turns.find(t => t.id === 's');
    assert.ok(sTurn);
    assert.ok(close(sTurn.desired, Math.PI / 4));
    // Each listener faces the speaker individually.
    const aTurn = turns.find(t => t.id === 'a');
    const bTurn = turns.find(t => t.id === 'b');
    assert.ok(aTurn && bTurn);
    assert.ok(close(wrapPi(aTurn.desired), -Math.PI / 2));
    assert.ok(close(bTurn.desired, Math.PI));   // facing -Z
  });

  test('lone participant ("the world" / narration beat) is a no-op', () => {
    const speaker = { id: 's', pos: { x: 0, z: 0 }, currentYaw: 0 };
    const turns = planConversationOrientation('s', [speaker]);
    assert.deepEqual(turns, []);
  });

  test('unknown speaker id is a no-op', () => {
    const a = { id: 'a', pos: { x: 0, z: 0 }, currentYaw: 0 };
    const b = { id: 'b', pos: { x: 2, z: 0 }, currentYaw: 0 };
    assert.deepEqual(planConversationOrientation(null, [a, b]), []);
    assert.deepEqual(planConversationOrientation(undefined, [a, b]), []);
  });

  test('participants already in epsilon-correct pose produce no turns', () => {
    const hero = { id: 'hero', pos: { x: 0, z: 0 }, currentYaw: Math.PI / 2 };
    const inn  = { id: 'inn',  pos: { x: 2, z: 0 }, currentYaw: -Math.PI / 2 };
    const turns = planConversationOrientation('hero', [hero, inn]);
    assert.deepEqual(turns, []);
  });

  test('only one participant is already facing → only the other returns a turn', () => {
    const hero = { id: 'hero', pos: { x: 0, z: 0 }, currentYaw: Math.PI / 2 };  // already faces inn
    const inn  = { id: 'inn',  pos: { x: 2, z: 0 }, currentYaw: 0 };
    const turns = planConversationOrientation('hero', [hero, inn]);
    assert.equal(turns.length, 1);
    assert.equal(turns[0].id, 'inn');
    assert.ok(close(wrapPi(turns[0].desired), -Math.PI / 2));
  });

  test('skips a participant with no pos (e.g. model not loaded)', () => {
    const hero = { id: 'hero', pos: { x: 0, z: 0 }, currentYaw: 0 };
    const ghost = { id: 'g', pos: null, currentYaw: 0 };
    const turns = planConversationOrientation('hero', [hero, ghost]);
    // Speaker still gets a turn? No — centroid of "(no positions)" is null.
    // ghost has no pos, others.map → [null] → centroidXZ([null].filter) = []
    // We rely on `.filter(Boolean)` so the speaker turn ALSO skips. Listener
    // already had no pos so was skipped. Result: no turns.
    assert.deepEqual(turns, []);
  });

  test('symmetric: swapping speaker yields each unit facing the other one too', () => {
    const hero = { id: 'hero', pos: { x: 0, z: 0 }, currentYaw: 0 };
    const inn  = { id: 'inn',  pos: { x: 4, z: 3 }, currentYaw: 0 };

    const turnsA = planConversationOrientation('hero', [hero, inn]);
    const turnsB = planConversationOrientation('inn', [hero, inn]);
    const heroA = turnsA.find(t => t.id === 'hero').desired;
    const innA  = turnsA.find(t => t.id === 'inn').desired;
    const heroB = turnsB.find(t => t.id === 'hero').desired;
    const innB  = turnsB.find(t => t.id === 'inn').desired;
    // Speaker swap doesn't change the desired yaws — each unit faces the other
    // either way (in a 2-participant conversation the speaker's centroid IS the
    // other listener).
    assert.ok(close(heroA, heroB, 1e-9));
    assert.ok(close(innA, innB, 1e-9));
  });
});

describe('FACE_TURN_MS / FACING_EPSILON constants', () => {
  test('FACE_TURN_MS is a small positive interval (visual tween budget)', () => {
    assert.ok(Number.isFinite(FACE_TURN_MS));
    assert.ok(FACE_TURN_MS > 0 && FACE_TURN_MS < 2000,
      `FACE_TURN_MS=${FACE_TURN_MS} should be in (0, 2000)`);
  });

  test('FACING_EPSILON is a small positive radian tolerance', () => {
    assert.ok(Number.isFinite(FACING_EPSILON));
    assert.ok(FACING_EPSILON > 0 && FACING_EPSILON < 0.5);
  });
});
