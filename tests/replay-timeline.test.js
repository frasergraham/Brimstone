// Tests for buildStepDigest in src/replay-timeline.js — the pure presentation
// model behind the replay timeline overlay. Verifies column/entry shape,
// outcome-kind mapping, summon/guard handling, the online playerEvents format,
// and that the injected isVisible predicate filters fogged actors/targets out.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStepDigest, buildConversationDigest, buildRollTip, buildRollRows, buildOutcomeSummary, isEventVisible, OutcomeKind, buildTurnCardHoverOverlays, TURN_CARD_HOVER_COLOR } from '../src/replay-timeline.js';
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

  test('whiffed hex attack (ACTION_SKIP, no enemy) still gets a "NO TARGET" card', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_SKIP, faction: 'hero',
      action: { type: PlanActionType.BATTLE_HEX, entityId: 'h1' },
      reason: 'No enemy on target hex.',
      battleSnaps: { actorSnap: { id: 'h1', type: 'hero', owner: 'hero', col: 1, row: 1 }, ranged: true },
      whiffTarget: { col: 3, row: 1 },
    };
    const d = buildStepDigest([step([ev], [h])], [], DEPS);
    const e = d[0].entries[0];
    assert.equal(e.label, 'RANGED ATTACK');
    assert.equal(e.target, null);
    assert.equal(e.outcomeKind, null);
    assert.deepEqual(e.note, { text: 'NO TARGET', kind: 'info' });
  });

  test('fled target (ACTION_SKIP with targetFled) gets a "TARGET FLED" card', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_SKIP, faction: 'hero',
      action: { type: PlanActionType.BATTLE_UNIT, entityId: 'h1', targetId: 'm1' },
      reason: 'Zombie slipped away — out of reach.',
      targetFled: true,
      battleSnaps: { actorSnap: { id: 'h1', type: 'hero', owner: 'hero', col: 1, row: 1 }, ranged: false },
      whiffTarget: { col: 2, row: 1 },
    };
    const d = buildStepDigest([step([ev], [h])], [], DEPS);
    const e = d[0].entries[0];
    assert.equal(e.label, 'ATTACK');
    assert.equal(e.target, null);
    assert.deepEqual(e.note, { text: 'TARGET FLED', kind: 'info' });
  });

  test('explore lists the actual loot icons (not "+N RESOURCE")', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.EXPLORE, entityId: 'h1' },
      result: { success: true, lootItems: ['+🪵', 'nothing', '+🌿'] },  // 'nothing' excluded
    };
    const d = buildStepDigest([step([ev], [h])], [], DEPS);
    assert.deepEqual(d[0].entries[0].note, { text: '+🪵 +🌿', kind: 'gain' });
  });

  test('discovery: explore that finds a survivor shows the unit + "FOUND SURVIVOR"', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.EXPLORE, entityId: 'h1' },
      result: { success: true, lootItems: [], encounterSurvivor: { id: 's9', type: 'survivor', name: 'Mara' } },
    };
    const d = buildStepDigest([step([ev], [h])], [], DEPS);
    const e = d[0].entries[0];
    assert.equal(e.discovered.length, 1);
    assert.equal(e.discovered[0].name, 'Mara');
    assert.deepEqual(e.note, { text: 'FOUND SURVIVOR', kind: 'gain' });
  });

  test('discovery: a raised zombie shows "FOUND ZOMBIE"', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.EXPLORE, entityId: 'h1' },
      result: { success: true, encounterSurvivor: { id: 'z9', type: 'zombie' } },
    };
    const d = buildStepDigest([step([ev], [h])], [], DEPS);
    assert.equal(d[0].entries[0].note.text, 'FOUND ZOMBIE');
    assert.equal(d[0].entries[0].discovered[0].type, 'zombie');
  });

  test('discovery: a horn that finds several survivors lists them all', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.SOUND_HORN, entityId: 'h1' },
      result: { success: true, encounterSurvivors: [
        { id: 's1', type: 'survivor', name: 'A' },
        { id: 's2', type: 'survivor', name: 'B' },
        { id: 's3', type: 'survivor', name: 'C' },
      ] },
    };
    const d = buildStepDigest([step([ev], [h])], [], DEPS);
    assert.equal(d[0].entries[0].discovered.length, 3);
    assert.equal(d[0].entries[0].note.text, 'FOUND 3 SURVIVORS');
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

// ── Shared visibility predicate (cards ⟷ animation) ───────────────────────────

describe('isEventVisible — union of source/target + public actions', () => {
  // Sight only around (0,0).
  const near = (col, row) => col <= 1 && row <= 1;

  test('move: visible if origin OR destination is seen, hidden if neither', () => {
    const h = snap('h1', 'hero', 'hero', 5, 5);
    const ev = moveEvent('h1', 'hero', 6, 5);                 // origin & dest fogged
    assert.equal(isEventVisible(ev, [h], near, DEPS), false);
    const destSeen = (col, row) => col === 6 && row === 5;
    assert.equal(isEventVisible(ev, [h], destSeen, DEPS), true);
  });

  test('battle: an attack out of an unseen hex still shows (target visible)', () => {
    const atk = snap('a1', 'witch', 'witch', 9, 9);           // attacker fogged
    const def = snap('d1', 'hero', 'hero', 0, 0);             // target seen
    const ev = battleEvent(atk, def, { hit: true, damage: 1 });
    assert.equal(isEventVisible(ev, [atk, def], near, DEPS), true);
  });

  test('battle: hidden when neither combatant hex is seen', () => {
    const atk = snap('a1', 'witch', 'witch', 9, 9);
    const def = snap('d1', 'hero', 'hero', 8, 8);
    const ev = battleEvent(atk, def, { hit: true, damage: 1 });
    assert.equal(isEventVisible(ev, [atk, def], near, DEPS), false);
  });

  test('summon happens on the summoner hex — gated by that hex', () => {
    const w = snap('w1', 'witch', 'witch', 5, 5);
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'witch',
      action: { type: PlanActionType.SUMMON, entityId: 'w1', summonType: 'minion' },
      result: { success: true },
    };
    assert.equal(isEventVisible(ev, [w], near, DEPS), false);
    assert.equal(isEventVisible(ev, [w], () => true, DEPS), true);
  });

  test('sound-horn is public — visible even when the blower is fogged', () => {
    const h = snap('h1', 'hero', 'hero', 9, 9);               // blower fogged
    const ev = {
      type: ResEventType.ACTION_OK, faction: 'hero',
      action: { type: PlanActionType.SOUND_HORN, entityId: 'h1' },
      result: { success: true },
    };
    assert.equal(isEventVisible(ev, [h], near, DEPS), true);
  });

  test('no isVisible / missing deps ⇒ visible (fog off)', () => {
    const h = snap('h1', 'hero', 'hero', 9, 9);
    assert.equal(isEventVisible(moveEvent('h1', 'hero', 9, 8), [h], null, DEPS), true);
    assert.equal(isEventVisible(moveEvent('h1', 'hero', 9, 8), [h], near, {}), true);
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

// ── buildRollTip — the turn card's roll-breakdown tooltip ────────────────────

describe('buildRollTip', () => {
  const fullResult = {
    attackRoll: 9, defenseRoll: 5, hit: true,
    breakdown: {
      atkPool: [4, 2, 1], atkBaseDie: 4, defPool: [3], defBaseDie: 3,
      atkAdvantageDice: 2, atkDisadvantageDice: 0, defAdvantageDice: 0,
      atkGangupFlat: 2, defGangupFlat: 0,
      phaseBonus: 0, fortBonus: 1, atkFortAtkBonus: 0,
      fatiguePenalty: 1, forestCoverBonus: 0, rangeDistancePenalty: 0,
      atkStaffBonus: 0,
      atkBaseStat: 3, atkWeaponMod: 0, atkAbilityMod: 0, atkEffectMod: 0, atkAttackBonus: 0,
      defBaseStat: 2, defWeaponMod: 0, defAbilityMod: 0, defEffectMod: 0, defDefenseBonus: 0,
    },
  };

  test('reconstructs both rolls with their modifiers', () => {
    const tip = buildRollTip(fullResult, false);
    assert.match(tip, /Attack 9 = die 4 \(rolled 4·2·1, kept best of 3\)/);
    assert.match(tip, /\+3 ATK/);
    assert.match(tip, /\+2 gang-up/);
    assert.match(tip, /Defense 5 = die 3/);
    assert.match(tip, /\+1 fort/);
    assert.match(tip, /−1 fatigue/);
  });

  test('explains gang-up only when it applied; rules line always present', () => {
    const tip = buildRollTip(fullResult, false);
    assert.match(tip, /Gang-up: each ally beside the target adds \+1 advantage die and \+1 flat/);
    assert.match(tip, /×2 on a crush/);

    const solo = JSON.parse(JSON.stringify(fullResult));
    solo.breakdown.atkGangupFlat = 0;
    solo.breakdown.atkAdvantageDice = 0;
    solo.breakdown.atkPool = [4];
    assert.doesNotMatch(buildRollTip(solo, false), /Gang-up:/);
  });

  test('ranged rules line replaces crush/counter text', () => {
    const tip = buildRollTip(fullResult, true);
    assert.match(tip, /never crush and are never countered/);
    assert.doesNotMatch(tip, /counter when defense/);
  });

  test('returns empty string without breakdown data (legacy replays)', () => {
    assert.equal(buildRollTip({ attackRoll: 5, defenseRoll: 3 }), '');
    assert.equal(buildRollTip(null), '');
  });

  test('battle entries from buildStepDigest carry the tooltip', () => {
    const a = snap('h1', 'hero', 'hero', 1, 1);
    const t = snap('m1', 'minion', 'witch', 1, 2);
    const ev = battleEvent(a, t, fullResult);
    const cols = buildStepDigest([step([ev], [a, t])], [], DEPS);
    const entry = cols[0].entries[0];
    assert.match(entry.rollTip, /Attack 9/);
  });
});

// ── buildRollRows — structured model behind the turn-card breakdown panel ───

describe('buildRollRows', () => {
  const result = {
    attackRoll: 9, defenseRoll: 5, hit: true,
    breakdown: {
      atkPool: [4, 2, 1], atkBaseDie: 4, defPool: [3], defBaseDie: 3,
      atkAdvantageDice: 2, atkDisadvantageDice: 0, defAdvantageDice: 0,
      atkGangupFlat: 2, defGangupFlat: 0,
      phaseBonus: 0, fortBonus: 1, atkFortAtkBonus: 0,
      fatiguePenalty: 1, forestCoverBonus: 0, rangeDistancePenalty: 0,
      atkStaffBonus: 0,
      atkBaseStat: 3, atkWeaponMod: 0, atkAbilityMod: 0, atkEffectMod: 0, atkAttackBonus: 0,
      defBaseStat: 2, defWeaponMod: 0, defAbilityMod: 0, defEffectMod: 0, defDefenseBonus: 0,
    },
  };

  test('structures both sides with dice and signed terms', () => {
    const rows = buildRollRows(result, false);
    assert.equal(rows.atk.roll, 9);
    assert.deepEqual(rows.atk.dice, { pool: [4, 2, 1], picked: 4, advantage: 2 });
    assert.deepEqual(rows.atk.terms, [{ label: 'ATK', val: 3 }, { label: 'gang-up', val: 2 }]);
    assert.equal(rows.def.roll, 5);
    assert.deepEqual(rows.def.terms, [{ label: 'DEF', val: 2 }, { label: 'fort', val: 1 }, { label: 'fatigue', val: -1 }]);
    assert.equal(rows.notes.length, 1);
    assert.match(rows.rule, /crush/);
  });

  test('matches the plain-text tip (both derive from the same model)', () => {
    const tip = buildRollTip(result, false);
    assert.match(tip, /Attack 9 = die 4 \(rolled 4·2·1, kept best of 3\) \+3 ATK \+2 gang-up/);
  });

  test('weapon contribution is a named term, not folded into the stat sum', () => {
    const armed = JSON.parse(JSON.stringify(result));
    armed.breakdown.atkWeaponMod = 2;
    armed.breakdown.atkWeaponId = 'sword';
    armed.breakdown.defWeaponMod = 1;
    armed.breakdown.defWeaponId = 'axe';
    const rows = buildRollRows(armed, false);
    assert.deepEqual(rows.atk.terms[1], { label: 'sword', val: 2 });
    assert.equal(rows.atk.terms[0].val, 3); // base stat stays unfolded
    assert.deepEqual(rows.def.terms[1], { label: 'axe', val: 1 });
    // Legacy replays without the weapon id still label the row.
    delete armed.breakdown.atkWeaponId;
    assert.deepEqual(buildRollRows(armed, false).atk.terms[1], { label: 'weapon', val: 2 });
  });

  test('returns null without breakdown data', () => {
    assert.equal(buildRollRows({ attackRoll: 5, defenseRoll: 3 }), null);
    assert.equal(buildRollRows(null), null);
  });

  test('entries from buildStepDigest carry the model', () => {
    const a = snap('h1', 'hero', 'hero', 1, 1);
    const t = snap('m1', 'minion', 'witch', 1, 2);
    const cols = buildStepDigest([step([battleEvent(a, t, result)], [a, t])], [], DEPS);
    assert.equal(cols[0].entries[0].rollRows.atk.roll, 9);
  });
});

// ── buildOutcomeSummary — what happened, why, and the damage dealt ───────────

describe('buildOutcomeSummary', () => {
  const base = {
    actor: { name: 'Ishmael' }, target: { name: 'Zombie' },
    ranged: false, missWord: 'blocked',
  };

  test('hit: states the roll comparison and the damage', () => {
    const o = buildOutcomeSummary({ ...base, outcomeKind: 'hit', atkRoll: 7, defRoll: 5, targetDmg: 1, actorDmg: 0, killed: false });
    assert.equal(o.kind, 'hit');
    assert.equal(o.headline, 'HIT — 1 damage');
    assert.match(o.reason, /Attack 7 beats defense 5/);
    assert.deepEqual(o.lines, ['Zombie takes 1.']);
  });

  test('crush: explains the double-defense threshold', () => {
    const o = buildOutcomeSummary({ ...base, outcomeKind: 'crush', atkRoll: 10, defRoll: 4, targetDmg: 2, actorDmg: 0, killed: false });
    assert.equal(o.kind, 'crush');
    assert.match(o.reason, /≥ 2× defense 4/);
    assert.match(o.headline, /CRUSH — 2 damage/);
  });

  test('great crush (≥3×) is called out and multiplies ×3', () => {
    const o = buildOutcomeSummary({
      ...base, outcomeKind: 'crush', atkRoll: 12, defRoll: 4,
      atkWeapon: 'sword', dmgRoll: 6, dmgTier: 3, targetDmg: 18, actorDmg: 0, killed: false,
    });
    assert.match(o.headline, /GREAT CRUSH — 18 damage/);
    assert.match(o.reason, /great crush/);
    assert.match(o.reason, /Sword 2D6 rolled 6 ×3 = 18/);
  });

  test('kill re-derives the strike type from the rolls', () => {
    const crushKill = buildOutcomeSummary({ ...base, outcomeKind: 'kill', atkRoll: 10, defRoll: 4, targetDmg: 2, actorDmg: 0, killed: true });
    assert.equal(crushKill.kind, 'kill');
    assert.equal(crushKill.headline, 'CRUSH — SLAIN');
    assert.match(crushKill.lines[0], /slain!/);

    const plainKill = buildOutcomeSummary({ ...base, outcomeKind: 'kill', atkRoll: 7, defRoll: 5, targetDmg: 1, actorDmg: 0, killed: true });
    assert.equal(plainKill.headline, 'HIT — SLAIN');
  });

  test('counter: defender strikes back with attacker damage line', () => {
    const o = buildOutcomeSummary({ ...base, outcomeKind: 'miss', atkRoll: 3, defRoll: 8, targetDmg: 0, actorDmg: 1, killed: false });
    assert.equal(o.kind, 'counter');
    assert.match(o.reason, /≥ 2× attack 3/);
    assert.deepEqual(o.lines, ['Ishmael takes 1 from the counter.']);
  });

  test('plain miss uses the flavour word and explains no damage', () => {
    const o = buildOutcomeSummary({ ...base, outcomeKind: 'miss', atkRoll: 4, defRoll: 5, targetDmg: 0, actorDmg: 0, killed: false });
    assert.equal(o.kind, 'miss');
    assert.equal(o.headline, 'BLOCKED');
    assert.match(o.reason, /fails to beat defense 5/);
  });

  test('ranged kills never read as crush', () => {
    const rangedKill = buildOutcomeSummary({ ...base, ranged: true, outcomeKind: 'kill', atkRoll: 10, defRoll: 4, dmgTier: 1, targetDmg: 1, actorDmg: 0, killed: true });
    assert.equal(rangedKill.headline, 'HIT — SLAIN');
  });

  test('explains the weapon damage roll, and surfaces a wounded surcharge', () => {
    // Plain hit with a known weapon roll → reason names the weapon, dice and roll.
    const o = buildOutcomeSummary({
      ...base, outcomeKind: 'hit', atkRoll: 7, defRoll: 5,
      atkWeapon: 'greatsword', dmgRoll: 9, dmgTier: 1, targetDmg: 9, actorDmg: 0, killed: false,
    });
    assert.match(o.reason, /Great Sword 3D6 rolled 9 = 9/);
    assert.deepEqual(o.lines, ['Zombie takes 9.']);

    // Final damage above roll×tier is reported as the wounded surcharge.
    const w = buildOutcomeSummary({
      ...base, outcomeKind: 'hit', atkRoll: 7, defRoll: 5,
      atkWeapon: 'sword', dmgRoll: 5, dmgTier: 1, targetDmg: 12, actorDmg: 0, killed: false,
    });
    assert.match(w.lines[0], /\(incl\. \+7 wounded\)/);
  });

  test('returns null without rolls or outcome', () => {
    assert.equal(buildOutcomeSummary(null), null);
    assert.equal(buildOutcomeSummary({ outcomeKind: 'hit' }), null);
  });
});

// ── buildConversationDigest (campaign conversation turn card) ────────────────

describe('buildConversationDigest', () => {
  const convo = {
    id: 'intro',
    title: 'A Voice at the Inn Door',
    lines: [{ role: 'a', text: 'x' }, { role: 'b', text: 'y' }],
  };
  const hero = { id: 'e1', type: 'paladin', title: 'Paladin', color: '#d4a72c' };
  const npc  = { id: 'e2', type: 'survivor', name: "John O'Connor", title: 'Innkeeper', color: '#8cf' };

  test('builds a single conversation column from a participants Map', () => {
    const digest = buildConversationDigest(convo, new Map([['a', hero], ['b', npc]]));
    assert.equal(digest.length, 1);
    const col = digest[0];
    assert.equal(col.kind, 'conversation');
    assert.equal(col.stepIndex, 'conv:intro');
    assert.equal(col.title, 'A Voice at the Inn Door');
    assert.equal(col.entries.length, 1);
    const entry = col.entries[0];
    assert.equal(entry.actionType, 'conversation');
    assert.equal(entry.label, 'TALK');
    assert.equal(entry.lineCount, 2);
    assert.equal(entry.actor.entityId, 'e1');
    assert.equal(entry.target.name, "John O'Connor");
  });

  test('accepts a plain entity array and tolerates a single participant', () => {
    const digest = buildConversationDigest(convo, [hero]);
    assert.equal(digest[0].entries[0].actor.entityId, 'e1');
    assert.equal(digest[0].entries[0].target, null);
  });
});

// ── Hover coordinates + overlay builder (turn-card hover highlights) ─────────

describe('buildStepDigest — hover coordinates', () => {
  test('successful move carries hexes + movePath (origin → waypoints)', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = moveEvent('h1', 'hero', 3, 1);
    ev.result.path = [{ col: 2, row: 1 }, { col: 3, row: 1 }];
    const e = buildStepDigest([step([ev], [h])], [], DEPS)[0].entries[0];
    assert.deepEqual(e.movePath, [{ col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }]);
    assert.deepEqual(e.hexes, [{ col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }]);
  });

  test('move without result.path falls back to the action target hex', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const e = buildStepDigest([step([moveEvent('h1', 'hero', 2, 1)], [h])], [], DEPS)[0].entries[0];
    assert.deepEqual(e.movePath, [{ col: 1, row: 1 }, { col: 2, row: 1 }]);
  });

  test('battle carries both combatant hexes and no movePath', () => {
    const atk = snap('h1', 'hero', 'hero', 1, 1);
    const def = snap('z1', 'zombie', 'witch', 2, 1);
    const d = buildStepDigest([step([battleEvent(atk, def, { hit: true, damage: 1 })], [atk, def])], [], DEPS);
    const e = d[0].entries[0];
    assert.deepEqual(e.hexes, [{ col: 1, row: 1 }, { col: 2, row: 1 }]);
    assert.equal(e.movePath, null);
  });

  test('blocked move highlights actor + blocker hexes, no movePath', () => {
    const h = snap('h1', 'hero', 'hero', 1, 1);
    const ev = {
      type: ResEventType.ACTION_FAIL,
      faction: 'hero',
      action: { type: PlanActionType.MOVE, entityId: 'h1', toCol: 2, toRow: 1 },
      blockedBy: { col: 2, row: 1 },
    };
    const e = buildStepDigest([step([ev], [h])], [], DEPS)[0].entries[0];
    assert.deepEqual(e.hexes, [{ col: 1, row: 1 }, { col: 2, row: 1 }]);
    assert.equal(e.movePath, null);
  });

  test('non-move action highlights the actor hex', () => {
    const h = snap('h1', 'hero', 'hero', 4, 5);
    const ev = {
      type: ResEventType.ACTION_OK,
      faction: 'hero',
      action: { type: PlanActionType.FORTIFY, entityId: 'h1' },
      result: { success: true },
    };
    const e = buildStepDigest([step([ev], [h])], [], DEPS)[0].entries[0];
    assert.deepEqual(e.hexes, [{ col: 4, row: 5 }]);
    assert.equal(e.movePath, null);
  });
});

describe('buildTurnCardHoverOverlays', () => {
  test('fill overlay: 15% blue flat fill over the involved hexes', () => {
    const { fill } = buildTurnCardHoverOverlays({
      hexes: [{ col: 1, row: 1 }, { col: 2, row: 1 }], movePath: null,
    });
    assert.equal(fill.kind, 'fill');
    assert.equal(fill.layer, 'fill');
    assert.equal(fill.style.alpha, 0.15);
    assert.equal(fill.style.color, TURN_CARD_HOVER_COLOR);
    assert.deepEqual(Array.from(fill.hexes).sort(), ['1,1', '2,1']);
  });

  test('successful move adds ghost arrow segments along the path', () => {
    const { arrows } = buildTurnCardHoverOverlays({
      hexes: [], movePath: [{ col: 1, row: 1 }, { col: 2, row: 1 }, { col: 3, row: 1 }],
    });
    assert.equal(arrows.length, 2);
    assert.deepEqual(arrows[0].path, ['1,1', '2,1']);
    assert.deepEqual(arrows[1].path, ['2,1', '3,1']);
    for (const [i, a] of arrows.entries()) {
      assert.equal(a.kind, 'plan-arrow');
      assert.equal(a.meta.variant, 'ghost');
      assert.equal(a.meta.stepIndex, i);
      assert.equal(a.meta.entityId, '__turn-card-hover__');
      assert.ok(a.style.alpha < 1, 'ghost arrows are translucent');
    }
  });

  test('battle entry (no movePath) yields fill only; empty entry yields nothing', () => {
    const battle = buildTurnCardHoverOverlays({ hexes: [{ col: 1, row: 1 }], movePath: null });
    assert.ok(battle.fill);
    assert.deepEqual(battle.arrows, []);
    const none = buildTurnCardHoverOverlays(null);
    assert.equal(none.fill, null);
    assert.deepEqual(none.arrows, []);
  });
});
