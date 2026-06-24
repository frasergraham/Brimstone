// deferredMoveEntityIds — when a faster attacker strikes a FLEEING unit, the
// strike resolves on the unit's start hex (agility drains it first), so the
// step animator must defer that unit's move until after the battle instead of
// warping it back to its start hex for the strike and then zipping it forward.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { deferredMoveEntityIds, groupWhiffEvents } from '../src/battle-utils.js';

const PLAN = { MOVE: 'MOVE', BATTLE_UNIT: 'BATTLE_UNIT', BATTLE_HEX: 'BATTLE_HEX' };

const move = (id, fromIgnored, toCol, toRow, resOrder) => ({
  action: { type: PLAN.MOVE, entityId: id, toCol, toRow },
  result: { path: [{ col: toCol, row: toRow }] },
  ...(resOrder != null ? { resOrder } : {}),
});
const battle = (actorId, targetId, actorPos, targetPos, resOrder) => ({
  action: { type: PLAN.BATTLE_UNIT, entityId: actorId },
  battleSnaps: {
    actorSnap:  { id: actorId,  col: actorPos.col,  row: actorPos.row },
    targetSnap: { id: targetId, col: targetPos.col, row: targetPos.row },
  },
  ...(resOrder != null ? { resOrder } : {}),
});

describe('deferredMoveEntityIds', () => {
  test('fleeing target struck on its start hex → its move is deferred', () => {
    const snapshot = [{ id: 'd', col: 3, row: 3 }, { id: 'a', col: 5, row: 3 }];
    const events = [
      move('d', null, 2, 3),                                   // d flees 3,3 → 2,3
      battle('a', 'd', { col: 5, row: 3 }, { col: 3, row: 3 }), // a struck d at 3,3 (pre-move)
    ];
    const ids = deferredMoveEntityIds(events, snapshot, PLAN);
    assert.deepEqual([...ids], ['d']);
  });

  test('move-before-attack (struck at destination) → NOT deferred', () => {
    const snapshot = [{ id: 'd', col: 3, row: 3 }, { id: 'a', col: 5, row: 3 }];
    const events = [
      move('d', null, 4, 3),                                   // d moved 3,3 → 4,3
      battle('a', 'd', { col: 5, row: 3 }, { col: 4, row: 3 }), // struck at 4,3 (post-move)
    ];
    assert.equal(deferredMoveEntityIds(events, snapshot, PLAN).size, 0);
  });

  test('a mover not involved in any battle is never deferred', () => {
    const snapshot = [{ id: 'd', col: 3, row: 3 }];
    assert.equal(deferredMoveEntityIds([move('d', null, 2, 3)], snapshot, PLAN).size, 0);
  });

  test('a stationary unit struck on its hex has no move to defer', () => {
    const snapshot = [{ id: 'd', col: 3, row: 3 }, { id: 'a', col: 4, row: 3 }];
    const events = [battle('a', 'd', { col: 4, row: 3 }, { col: 3, row: 3 })];
    assert.equal(deferredMoveEntityIds(events, snapshot, PLAN).size, 0);
  });

  test('an attacker that strikes from its start hex then moves is also deferred', () => {
    const snapshot = [{ id: 'a', col: 2, row: 2 }, { id: 'd', col: 3, row: 2 }];
    const events = [
      move('a', null, 1, 2),                                   // a strikes then repositions 2,2 → 1,2
      battle('a', 'd', { col: 2, row: 2 }, { col: 3, row: 2 }), // a's snap is its pre-move hex
    ];
    assert.deepEqual([...deferredMoveEntityIds(events, snapshot, PLAN)], ['a']);
  });
});

describe('deferredMoveEntityIds — resOrder (exact resolution order)', () => {
  // The defer decision is now driven by the resolver's `resOrder` (true
  // agility-sorted drain order), not just snapshot positions. These cases pin
  // that the EARLIER-resolved action wins, even when positions are ambiguous.

  test('strike resolved BEFORE the move (lower resOrder) → defer', () => {
    const snapshot = [{ id: 'd', col: 3, row: 3 }, { id: 'a', col: 5, row: 3 }];
    const events = [
      move('d', null, 2, 3, /*resOrder*/ 1),                                  // d's flee resolved 2nd
      battle('a', 'd', { col: 5, row: 3 }, { col: 3, row: 3 }, /*resOrder*/ 0), // a struck d on 3,3 FIRST
    ];
    assert.deepEqual([...deferredMoveEntityIds(events, snapshot, PLAN)], ['d']);
  });

  test('move resolved BEFORE the strike (lower resOrder) → NOT deferred', () => {
    // Even though the battle snapped d on what looks like its pre-move hex, the
    // MOVE drained first (lower resOrder) — so the unit had already left and the
    // strike that follows must NOT re-defer it (that would double-warp). This is
    // the case the position-only heuristic could not disambiguate.
    const snapshot = [{ id: 'd', col: 3, row: 3 }, { id: 'a', col: 4, row: 3 }];
    const events = [
      move('d', null, 2, 3, /*resOrder*/ 0),                                   // d fled FIRST
      battle('a', 'd', { col: 4, row: 3 }, { col: 3, row: 3 }, /*resOrder*/ 1), // a's strike came 2nd
    ];
    assert.equal(deferredMoveEntityIds(events, snapshot, PLAN).size, 0);
  });

  test('missing resOrder on either side → legacy position fallback (defer)', () => {
    const snapshot = [{ id: 'd', col: 3, row: 3 }, { id: 'a', col: 5, row: 3 }];
    const events = [
      move('d', null, 2, 3),                                    // no resOrder
      battle('a', 'd', { col: 5, row: 3 }, { col: 3, row: 3 }), // no resOrder, snapped pre-move
    ];
    assert.deepEqual([...deferredMoveEntityIds(events, snapshot, PLAN)], ['d']);
  });
});

describe('groupWhiffEvents', () => {
  const whiff = (actorId, col, row) => ({
    type: 'action_skip',
    whiffTarget: { col, row },
    battleSnaps: { actorSnap: { id: actorId, col: 0, row: 0 } },
    targetFled: true,
  });

  test('a run of identical whiffs (same actor, same hex) folds to one', () => {
    const evs = [whiff('a', 4, 5), whiff('a', 4, 5), whiff('a', 4, 5)];
    const out = groupWhiffEvents(evs);
    assert.equal(out.length, 1);
    assert.equal(out[0], evs[0]);   // keeps the first
  });

  test('different actors do not fold', () => {
    const evs = [whiff('a', 4, 5), whiff('b', 4, 5)];
    assert.equal(groupWhiffEvents(evs).length, 2);
  });

  test('same actor, different hex does not fold', () => {
    const evs = [whiff('a', 4, 5), whiff('a', 6, 5)];
    assert.equal(groupWhiffEvents(evs).length, 2);
  });

  test('non-consecutive duplicates each survive (a, b, a → 3)', () => {
    const evs = [whiff('a', 4, 5), whiff('b', 4, 5), whiff('a', 4, 5)];
    assert.equal(groupWhiffEvents(evs).length, 3);
  });

  test('empty / nullish input → []', () => {
    assert.deepEqual(groupWhiffEvents([]), []);
    assert.deepEqual(groupWhiffEvents(undefined), []);
  });
});
