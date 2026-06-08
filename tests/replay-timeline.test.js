// Tests for buildStepDigest in src/replay-timeline.js — the pure presentation
// model behind the replay timeline overlay. Verifies column/entry shape,
// outcome-kind mapping, summon/guard handling, the online playerEvents format,
// and that the injected isVisible predicate filters fogged actors/targets out.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStepDigest, OutcomeKind } from '../src/replay-timeline.js';
import { ResEventType } from '../server/resolver.js';
import { PlanActionType } from '../src/planner.js';

const DEPS = { PlanActionType, ResEventType };

// ── Helpers ──────────────────────────────────────────────────────────────────

function snap(id, type, owner, col, row, extra = {}) {
  return { id, type, owner, col, row, displayName: type, alive: true, ...extra };
}

function moveEvent(actorId, faction, toCol, toRow) {
  return {
    type: ResEventType.ACTION_OK,
    faction,
    action: { type: PlanActionType.MOVE, entityId: actorId, toCol, toRow },
    result: { success: true },
  };
}

function battleEvent(actorSnap, targetSnap, result) {
  return {
    type: ResEventType.ACTION_OK,
    faction: actorSnap.owner,
    action: { type: PlanActionType.BATTLE_UNIT, entityId: actorSnap.id, targetId: targetSnap.id },
    result: { success: true, ...result },
    battleSnaps: { actorSnap, targetSnap },
  };
}

function step(events, entitySnapshot = []) {
  return {
    heroEvents:  events.filter(e => e.faction === 'hero'),
    witchEvents: events.filter(e => e.faction === 'witch'),
    entitySnapshot,
  };
}

// ── Shape ──────────────────────────────────────────────────────────────────────

describe('buildStepDigest — column shape', () => {
  test('emits one column per step, preserving order and empty columns', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const steps = [
      step([moveEvent('h1', 'hero', 2, 1)], [h]),
      step([], []),                                  // empty (no events) → empty column
    ];
    const digest = buildStepDigest(steps, [], DEPS);
    assert.equal(digest.length, 2);
    assert.equal(digest[0].stepIndex, 0);
    assert.equal(digest[1].stepIndex, 1);
    assert.equal(digest[0].entries.length, 1);
    assert.deepEqual(digest[1].entries, []);
  });

  test('move entry carries actor identity + MOVE label, no outcome', () => {
    const h = snap('h1', 'survivor', 'hero', 1, 1, { name: 'Samuel Cooper', title: 'Blacksmith' });
    const digest = buildStepDigest([step([moveEvent('h1', 'hero', 2, 1)], [h])], [], DEPS);
    const e = digest[0].entries[0];
    assert.equal(e.entityId, 'h1');
    assert.equal(e.label, 'MOVE');
    assert.equal(e.actionType, PlanActionType.MOVE);
    assert.equal(e.actor.name, 'Samuel Cooper');   // survivor uses name
    assert.equal(e.outcomeKind, null);
    assert.equal(e.note, null);
    assert.equal(e.target, null);
  });
});

// ── Outcome mapping ──────────────────────────────────────────────────────────

describe('buildStepDigest — battle outcome kinds', () => {
  const atk = snap('a1', 'hero', 'hero', 1, 1);
  const def = snap('d1', 'witch', 'witch', 2, 1);

  test('hit — damage carried on the target', () => {
    const d = buildStepDigest([step([battleEvent(atk, def, { hit: true, damage: 1 })], [atk, def])], [], DEPS);
    assert.equal(d[0].entries[0].outcomeKind, OutcomeKind.HIT);
    assert.equal(d[0].entries[0].targetDmg, 1);
    assert.equal(d[0].entries[0].label, 'ATTACK');
    assert.equal(d[0].entries[0].target.entityId, 'd1');
  });

  test('crush outranks hit', () => {
    const d = buildStepDigest([step([battleEvent(atk, def, { hit: true, crush: true, damage: 2 })], [atk, def])], [], DEPS);
    assert.equal(d[0].entries[0].outcomeKind, OutcomeKind.CRUSH);
    assert.equal(d[0].entries[0].targetDmg, 2);
  });

  test('kill outranks everything', () => {
    const d = buildStepDigest([step([battleEvent(atk, def, { hit: true, crush: true, killed: true, damage: 2 })], [atk, def])], [], DEPS);
    assert.equal(d[0].entries[0].outcomeKind, OutcomeKind.KILL);
    assert.equal(d[0].entries[0].killed, true);
  });

  test('miss when no hit — carries a deterministic flavour word', () => {
    const d = buildStepDigest([step([battleEvent(atk, def, { hit: false, damage: 0, attackRoll: 3, defenseRoll: 5 })], [atk, def])], [], DEPS);
    assert.equal(d[0].entries[0].outcomeKind, OutcomeKind.MISS);
    // One of the BLOCK_WORD_VARIANTS, upper-cased, and stable across builds.
    assert.match(d[0].entries[0].missWord, /^(MISS|DODGED|BLOCKED|PARRIED|DEFLECTED)$/);
    const d2 = buildStepDigest([step([battleEvent(atk, def, { hit: false, attackRoll: 3, defenseRoll: 5 })], [atk, def])], [], DEPS);
    assert.equal(d2[0].entries[0].missWord, d[0].entries[0].missWord);
  });

  test('carries the final rolls + winner flag', () => {
    const d = buildStepDigest([step([battleEvent(atk, def, { hit: true, damage: 1, attackRoll: 7, defenseRoll: 4 })], [atk, def])], [], DEPS);
    const e = d[0].entries[0];
    assert.equal(e.atkRoll, 7);
    assert.equal(e.defRoll, 4);
    assert.equal(e.attackerWon, true);
    assert.equal(e.label, 'ATTACK');     // melee
  });

  test('ranged attack is labelled "RANGED ATTACK"', () => {
    const d = buildStepDigest([step([battleEvent(atk, def, { hit: true, damage: 1, ranged: true })], [atk, def])], [], DEPS);
    assert.equal(d[0].entries[0].label, 'RANGED ATTACK');
    assert.equal(d[0].entries[0].ranged, true);
  });

  test('gang-up allies are resolved from the breakdown for each side', () => {
    const ally1 = snap('al1', 'survivor', 'hero', 1, 0, { name: 'Ally One' });
    const foe1  = snap('z1', 'zombie', 'witch', 3, 0);
    const ents  = [atk, def, ally1, foe1];
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.BATTLE_UNIT, entityId: 'a1', targetId: 'd1' },
      result: {
        success: true, hit: true, damage: 2, crush: true,
        breakdown: { atkAllyIds: ['al1'], defAllyIds: ['z1'] },
      },
      battleSnaps: { actorSnap: atk, targetSnap: def },
    };
    const d = buildStepDigest([{ ...step([], ents), heroEvents: [ev] }], [], DEPS);
    const e = d[0].entries[0];
    assert.equal(e.actorAllies.length, 1);
    assert.equal(e.actorAllies[0].name, 'Ally One');
    assert.equal(e.targetAllies.length, 1);
    assert.equal(e.targetAllies[0].type, 'zombie');
  });

  test('counter damage carried on the attacker', () => {
    const d = buildStepDigest([step([battleEvent(atk, def, { hit: true, damage: 1, counterDmg: 1 })], [atk, def])], [], DEPS);
    assert.equal(d[0].entries[0].outcomeKind, OutcomeKind.HIT);
    assert.equal(d[0].entries[0].actorDmg, 1);
    assert.equal(d[0].entries[0].targetDmg, 1);
  });
});

// ── Move / explore outcome notes ───────────────────────────────────────────────

describe('buildStepDigest — move/explore notes', () => {
  test('blocked move (ACTION_FAIL) gets a BLOCKED note', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_FAIL, faction: 'hero',
      action: { type: PlanActionType.MOVE, entityId: 'h1', toCol: 2, toRow: 1 },
      blockedBy: { col: 2, row: 1 },
    };
    const d = buildStepDigest([step([ev], [h])], [], DEPS);
    assert.equal(d[0].entries[0].label, 'MOVE');
    assert.deepEqual(d[0].entries[0].note, { text: 'BLOCKED', kind: 'blocked' });
  });

  test('explore reports loot count as "+N RESOURCE"', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.EXPLORE, entityId: 'h1' },
      result: { success: true, lootItems: ['axe', 'nothing', '+🌿'] },  // 'nothing' excluded
    };
    const d = buildStepDigest([step([ev], [h])], [], DEPS);
    assert.deepEqual(d[0].entries[0].note, { text: '+2 RESOURCE', kind: 'gain' });
  });

  test('explore with no loot shows EXPLORED', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.EXPLORE, entityId: 'h1' },
      result: { success: true, lootItems: [] },
    };
    const d = buildStepDigest([step([ev], [h])], [], DEPS);
    assert.equal(d[0].entries[0].note.text, 'EXPLORED');
  });
});

// ── Phase ordering ─────────────────────────────────────────────────────────────

describe('buildStepDigest — entries ordered by animation phase', () => {
  test('a horn queued before a battle is listed after it (battles animate first)', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const atk = snap('a1', 'hero', 'hero', 2, 2);
    const def = snap('d1', 'witch', 'witch', 3, 2);
    const hornEv = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.SOUND_HORN, entityId: 'h1' },
      result: { success: true },
    };
    // Horn is FIRST in the queue, battle second — but the battle (phase 2)
    // animates before the horn (phase 3b), so the cards must read battle→horn.
    const d = buildStepDigest(
      [step([hornEv, battleEvent(atk, def, { hit: true, damage: 1 })], [h, atk, def])],
      [], DEPS,
    );
    assert.deepEqual(d[0].entries.map(e => e.label), ['ATTACK', 'HORN']);
  });
});

// ── Summon + guard ────────────────────────────────────────────────────────────

describe('buildStepDigest — summon + guard strike', () => {
  test('summon shows the conjured unit as the target chip', () => {
    const w = snap('w1', 'witch', 'witch', 3, 3);
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'witch',
      action: { type: PlanActionType.SUMMON, entityId: 'w1', summonType: 'minion' },
      result: { success: true },
    };
    const d = buildStepDigest([step([ev], [w])], [], DEPS);
    assert.equal(d[0].entries[0].label, 'SUMMON');
    assert.equal(d[0].entries[0].target.type, 'minion');
  });

  test('guard strike is treated as a battle row labelled GUARD', () => {
    const guard = snap('g1', 'survivor', 'hero', 1, 1);
    const foe   = snap('z1', 'zombie', 'witch', 1, 2);
    const ev = {
      type: ResEventType.GUARD_STRIKE, faction: 'hero',
      guardianId: 'g1', targetId: 'z1',
      result: { hit: true, damage: 1, killed: false },
      battleSnaps: { actorSnap: guard, targetSnap: foe },
    };
    const d = buildStepDigest([{ ...step([], []), heroEvents: [ev] }], [], DEPS);
    assert.equal(d[0].entries[0].label, 'GUARD');
    assert.equal(d[0].entries[0].outcomeKind, OutcomeKind.HIT);
  });
});

// ── Fog filtering ─────────────────────────────────────────────────────────────

describe('buildStepDigest — fog filtering via injected isVisible', () => {
  test('drops a move whose origin AND destination are both unseen', () => {
    const h = snap('h1', 'hero', 'hero', 5, 5);
    // visible only around (0,0); the move at (5,5)->(6,5) is fully fogged
    const isVisible = (col, row) => col <= 1 && row <= 1;
    const d = buildStepDigest([step([moveEvent('h1', 'hero', 6, 5)], [h])], [], { ...DEPS, isVisible });
    assert.deepEqual(d[0].entries, []);
  });

  test('keeps a move when only the destination is seen', () => {
    const h = snap('h1', 'hero', 'hero', 5, 5);
    const isVisible = (col, row) => col === 6 && row === 5;   // dest only
    const d = buildStepDigest([step([moveEvent('h1', 'hero', 6, 5)], [h])], [], { ...DEPS, isVisible });
    assert.equal(d[0].entries.length, 1);
  });

  test('keeps a battle when only the target is seen', () => {
    const atk = snap('a1', 'witch', 'witch', 9, 9);   // attacker fogged
    const def = snap('d1', 'hero', 'hero', 0, 0);      // target seen
    const isVisible = (col, row) => col === 0 && row === 0;
    const d = buildStepDigest([step([battleEvent(atk, def, { hit: true, damage: 1 })], [atk, def])], [], { ...DEPS, isVisible });
    assert.equal(d[0].entries.length, 1);
  });

  test('no isVisible → everything visible', () => {
    const h = snap('h1', 'hero', 'hero', 5, 5);
    const d = buildStepDigest([step([moveEvent('h1', 'hero', 6, 5)], [h])], [], DEPS);
    assert.equal(d[0].entries.length, 1);
  });
});

// ── Online MP format ──────────────────────────────────────────────────────────

describe('buildStepDigest — playerEvents (online) format', () => {
  test('flattens playerEvents the same as hero/witch events', () => {
    const a = snap('a1', 'hero', 'hero', 1, 1);
    const b = snap('b1', 'witch', 'witch', 2, 1);
    const s = {
      playerEvents: [
        { playerId: 'p1', faction: 'hero',  events: [battleEvent(a, b, { hit: true, damage: 2 })] },
        { playerId: 'p2', faction: 'witch', events: [] },
      ],
      entitySnapshot: [a, b],
    };
    const d = buildStepDigest([s], [], DEPS);
    assert.equal(d[0].entries.length, 1);
    assert.equal(d[0].entries[0].targetDmg, 2);
  });
});
