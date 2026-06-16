// deferredMoveEntityIds — when a faster attacker strikes a FLEEING unit, the
// strike resolves on the unit's start hex (agility drains it first), so the
// step animator must defer that unit's move until after the battle instead of
// warping it back to its start hex for the strike and then zipping it forward.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { deferredMoveEntityIds } from '../src/battle-utils.js';

const PLAN = { MOVE: 'MOVE', BATTLE_UNIT: 'BATTLE_UNIT', BATTLE_HEX: 'BATTLE_HEX' };

const move = (id, fromIgnored, toCol, toRow) => ({
  action: { type: PLAN.MOVE, entityId: id, toCol, toRow },
  result: { path: [{ col: toCol, row: toRow }] },
});
const battle = (actorId, targetId, actorPos, targetPos) => ({
  action: { type: PLAN.BATTLE_UNIT, entityId: actorId },
  battleSnaps: {
    actorSnap:  { id: actorId,  col: actorPos.col,  row: actorPos.row },
    targetSnap: { id: targetId, col: targetPos.col, row: targetPos.row },
  },
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
