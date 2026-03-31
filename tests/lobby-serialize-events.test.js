// Tests that _serializeEvents preserves lootItems so the online multiplayer
// end-of-turn dialog can show collected resources.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeEventsForTest } from '../server/lobby.js';
import { ResEventType } from '../server/resolver.js';
import { PlanActionType } from '../src/planner.js';

function makeExploreEvent(lootItems) {
  return {
    type:    ResEventType.ACTION_OK,
    faction: 'hero',
    action:  { type: PlanActionType.EXPLORE, entityId: 'h1' },
    result:  {
      success:  true,
      log:      ['Explored.'],
      cost:     1,
      lootItems,
    },
  };
}

describe('_serializeEvents — lootItems preservation', () => {
  test('lootItems array is preserved when resources were found', () => {
    const ev = makeExploreEvent(['+🪵', '+⚙']);
    const [out] = serializeEventsForTest([ev]);
    assert.deepEqual(out.result.lootItems, ['+🪵', '+⚙']);
  });

  test('lootItems defaults to empty array when undefined on result', () => {
    const ev = makeExploreEvent(undefined);
    const [out] = serializeEventsForTest([ev]);
    assert.deepEqual(out.result.lootItems, []);
  });

  test('lootItems defaults to empty array when empty', () => {
    const ev = makeExploreEvent([]);
    const [out] = serializeEventsForTest([ev]);
    assert.deepEqual(out.result.lootItems, []);
  });
});
