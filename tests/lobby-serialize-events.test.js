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

describe('_serializeEvents — fortification HP fields preservation', () => {
  // The fort-HP rework surfaces new combat-result fields that the client's
  // playback fort-ring rewind reads. _serializeEvents is a strict allowlist —
  // any of these dropped on the wire desyncs the online fort ring.
  test('battle fort-HP fields survive the allowlist', () => {
    const ev = {
      type:    ResEventType.ACTION_OK,
      faction: 'hero',
      action:  { type: PlanActionType.BATTLE_UNIT, entityId: 'h1' },
      result:  {
        success: true, log: [], hit: true, damage: 14,
        fortDamaged: 1, fortHpDamage: 14, fortHpBefore: 60, fortHpAfter: 46,
      },
    };
    const [out] = serializeEventsForTest([ev]);
    assert.equal(out.result.fortDamaged, 1);
    assert.equal(out.result.fortHpDamage, 14);
    assert.equal(out.result.fortHpBefore, 60);
    assert.equal(out.result.fortHpAfter, 46);
  });

  test('fortify and assault fort fields survive the allowlist', () => {
    const fortify = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.FORTIFY, entityId: 'h1' },
      result: { success: true, log: [], defGain: 2, defHpGain: 40 },
    };
    const assault = {
      type: ResEventType.ACTION_OK, faction: 'witch',
      action: { type: PlanActionType.BATTLE_HEX, entityId: 'w1' },
      result: {
        success: true, log: [], fortAssault: true, crush: true,
        targetCol: 5, targetRow: 4, fortLevelBefore: 3, fortLevelAfter: 2,
        fortHpBefore: 60, fortHpAfter: 40, fortHpDamage: 20,
      },
    };
    const [f, a] = serializeEventsForTest([fortify, assault]);
    assert.equal(f.result.defGain, 2);
    assert.equal(f.result.defHpGain, 40);
    assert.equal(a.result.fortAssault, true);
    assert.equal(a.result.targetCol, 5);
    assert.equal(a.result.targetRow, 4);
    assert.equal(a.result.fortHpBefore, 60);
    assert.equal(a.result.fortHpAfter, 40);
    assert.equal(a.result.fortHpDamage, 20);
  });
});

describe('_serializeEvents — replay-order + whiff fields preservation', () => {
  // resOrder drives the replay's move-deferral (true cross-faction order);
  // whiffTarget / targetFled drive the fled-attack whiff animation + card. All
  // are top-level event fields — _serializeEvents is a strict allowlist, so
  // they'd silently vanish online without an explicit copy.
  test('resOrder survives the allowlist on an ACTION_OK', () => {
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero', resOrder: 3,
      action: { type: PlanActionType.MOVE, entityId: 'h1', toCol: 2, toRow: 2 },
      result: { success: true, log: [], path: [{ col: 2, row: 2 }] },
    };
    const [out] = serializeEventsForTest([ev]);
    assert.equal(out.resOrder, 3);
  });

  test('whiffTarget + targetFled survive on a fled-attack ACTION_SKIP', () => {
    const ev = {
      type: ResEventType.ACTION_SKIP, faction: 'witch', resOrder: 5,
      action: { type: PlanActionType.BATTLE_UNIT, entityId: 'w1', targetId: 'h1' },
      reason: 'Hero slipped away — out of reach.',
      targetFled: true,
      whiffTarget: { col: 4, row: 5 },
      battleSnaps: { actorSnap: { id: 'w1', col: 3, row: 5 }, ranged: false },
    };
    const [out] = serializeEventsForTest([ev]);
    assert.equal(out.targetFled, true);
    assert.deepEqual(out.whiffTarget, { col: 4, row: 5 });
    assert.equal(out.resOrder, 5);
    assert.ok(out.battleSnaps?.actorSnap, 'battleSnaps still ride along');
  });

  test('absent resOrder / whiff fields are simply omitted (no undefined keys)', () => {
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.GUARD, entityId: 'h1' },
      result: { success: true, log: [] },
    };
    const [out] = serializeEventsForTest([ev]);
    assert.ok(!('resOrder' in out));
    assert.ok(!('whiffTarget' in out));
    assert.ok(!('targetFled' in out));
  });
});

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
