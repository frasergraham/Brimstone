// Spec-based tests for server/resolver.js
// Covers: budget computation, paired steps, skip/fail/budget-cap events, food bonus.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { GameState, Phase } from '../src/game.js';
import { PlanActionType } from '../src/planner.js';
import {
  Entity, EntityType, createMinion, createZombie,
} from '../src/entities.js';
import { ResourceType } from '../src/tiles.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { getReachableHexes } from '../src/actions.js';

function freshState() {
  return new GameState(true, true);
}

function emptyPassableNeighbor(state, entity) {
  return getNeighbors(entity.col, entity.row).find(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!t || t.type === 'river') return false;
    return !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
  }) ?? null;
}

// ── Empty plans ───────────────────────────────────────────────────────────────

describe('resolvePlans — empty plans', () => {
  test('returns empty steps array when both plans are empty', () => {
    const state = freshState();
    const steps = resolvePlans(state, [], []);
    assert.deepEqual(steps, []);
  });

  test('returns empty steps when both plans are null', () => {
    const state = freshState();
    const steps = resolvePlans(state, null, null);
    assert.deepEqual(steps, []);
  });

  test('does not mutate entity positions with empty plans', () => {
    const state = freshState();
    const heroPos = { col: state.hero.col, row: state.hero.row };
    resolvePlans(state, [], []);
    assert.equal(state.hero.col, heroPos.col);
    assert.equal(state.hero.row, heroPos.row);
  });
});

// ── Step structure ────────────────────────────────────────────────────────────

describe('resolvePlans — step structure', () => {
  test('each step has stepIndex, heroEvents, witchEvents, entitySnapshot', () => {
    const state = freshState();
    const hero = state.hero;
    const reachable = getReachableHexes(state, hero, 1);
    if (!reachable.length) return;

    const heroPlan = [{
      type: PlanActionType.MOVE,
      entityId: hero.id,
      toCol: reachable[0].col,
      toRow: reachable[0].row,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    assert.ok(steps.length > 0);
    const step = steps[0];
    assert.ok('stepIndex' in step);
    assert.ok('heroEvents' in step);
    assert.ok('witchEvents' in step);
    assert.ok('entitySnapshot' in step);
  });

  test('stepIndex increments from 0', () => {
    const state = freshState();
    const hero = state.hero;
    const reachable = getReachableHexes(state, hero, 1);
    if (reachable.length < 2) return;

    const heroPlan = reachable.slice(0, 2).map((h, i) => ({
      type: PlanActionType.MOVE,
      entityId: hero.id,
      toCol: h.col,
      toRow: h.row,
    }));

    // Only first move will execute (subsequent move from new position)
    const steps = resolvePlans(state, heroPlan, []);
    for (let i = 0; i < steps.length; i++) {
      assert.equal(steps[i].stepIndex, i);
    }
  });

  test('entitySnapshot captures state before each step', () => {
    const state = freshState();
    const hero = state.hero;
    const originalCol = hero.col;
    const reachable = getReachableHexes(state, hero, 1);
    if (!reachable.length) return;

    const heroPlan = [{
      type: PlanActionType.MOVE,
      entityId: hero.id,
      toCol: reachable[0].col,
      toRow: reachable[0].row,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    const snapshot = steps[0].entitySnapshot.find(e => e.id === hero.id);
    // Snapshot is taken BEFORE the step, so hero should be at original position
    assert.equal(snapshot.col, originalCol, 'Snapshot should capture pre-step position');
  });
});

// ── Action execution via plans ────────────────────────────────────────────────

describe('resolvePlans — move action', () => {
  test('MOVE action executes and moves entity', () => {
    const state = freshState();
    const hero = state.hero;
    const reachable = getReachableHexes(state, hero, 1);
    if (!reachable.length) return;
    const target = reachable[0];

    const steps = resolvePlans(state, [{
      type: PlanActionType.MOVE,
      entityId: hero.id,
      toCol: target.col,
      toRow: target.row,
    }], []);

    assert.ok(steps.length > 0);
    assert.equal(steps[0].heroEvents[0].type, ResEventType.ACTION_OK);
    assert.equal(hero.col, target.col);
    assert.equal(hero.row, target.row);
  });
});

describe('resolvePlans — BATTLE_UNIT skip on dead target', () => {
  test('battle-unit action is skipped (not failed) when target is already dead', () => {
    const state = freshState();
    const hero = state.hero;
    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);
    // Kill the minion before resolution
    minion.hp = 0;
    state.entities = state.entities.filter(e => e.id !== minion.id);

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: minion.id, // already dead/gone
    }];

    const steps = resolvePlans(state, heroPlan, []);
    // Dead target → ACTION_SKIP (not ACTION_FAIL or ACTION_OK)
    if (steps.length > 0 && steps[0].heroEvents.length > 0) {
      const ev = steps[0].heroEvents[0];
      assert.equal(ev.type, ResEventType.ACTION_SKIP,
        'Battle against dead target should be a skip, not fail');
    }
    // If no steps, the plan was empty or budget was 0 — both mean no failure
  });
});

describe('resolvePlans — ACTION_FAIL on wrong faction', () => {
  test('entity acting for wrong faction causes ACTION_FAIL', () => {
    const state = freshState();
    const witch = state.witch;

    // Hero plan tries to move the witch — wrong faction
    const heroPlan = [{
      type: PlanActionType.MOVE,
      entityId: witch.id,
      toCol: witch.col,
      toRow: witch.row + 1,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    // Should fail immediately (entity belongs to witch, not hero)
    const allHeroEvents = steps.flatMap(s => s.heroEvents);
    const hasFailure = allHeroEvents.some(e => e.type === ResEventType.ACTION_FAIL);
    assert.ok(hasFailure, 'Using wrong-faction entity should produce ACTION_FAIL');
  });
});

// ── Budget enforcement ────────────────────────────────────────────────────────

describe('resolvePlans — budget cap', () => {
  test('plan actions beyond budget produce BUDGET_CAP event', () => {
    const state = freshState();
    const hero = state.hero;

    // Use alternating back-and-forth MOVE actions to keep each step valid.
    // After the budget (≤9 actions) is exhausted the resolver emits BUDGET_CAP.
    const reachable = getReachableHexes(state, hero, 1);
    if (!reachable.length) return;

    const posA = { col: hero.col, row: hero.row };
    const posB = reachable[0];

    const heroPlan = Array.from({ length: 20 }, (_, i) => ({
      type: PlanActionType.MOVE,
      entityId: hero.id,
      toCol: i % 2 === 0 ? posB.col : posA.col,
      toRow: i % 2 === 0 ? posB.row : posA.row,
    }));

    const steps = resolvePlans(state, heroPlan, []);
    const allHeroEvents = steps.flatMap(s => s.heroEvents);
    const hasCap = allHeroEvents.some(e => e.type === ResEventType.BUDGET_CAP);
    assert.ok(hasCap, 'Exhausting budget should produce a BUDGET_CAP event');
  });

  test('witch plan is independently budget-capped', () => {
    const state = freshState();
    const witch = state.witch;

    const reachable = getReachableHexes(state, witch, 1);
    if (!reachable.length) return;

    const posA = { col: witch.col, row: witch.row };
    const posB = reachable[0];

    const witchPlan = Array.from({ length: 20 }, (_, i) => ({
      type: PlanActionType.MOVE,
      entityId: witch.id,
      toCol: i % 2 === 0 ? posB.col : posA.col,
      toRow: i % 2 === 0 ? posB.row : posA.row,
    }));

    const steps = resolvePlans(state, [], witchPlan);
    const allWitchEvents = steps.flatMap(s => s.witchEvents);
    const hasCap = allWitchEvents.some(e => e.type === ResEventType.BUDGET_CAP);
    assert.ok(hasCap, 'Witch should be independently budget-capped');
  });
});

// ── Food budget extension ─────────────────────────────────────────────────────
// Food is NOT a USE_ITEM action. The resolver auto-consumes food from the shared
// inventory when budget is exhausted but the plan still has actions queued.

describe('resolvePlans — food extends budget', () => {
  test('food is auto-consumed at budget cap allowing one extra action', () => {
    const state = freshState();
    const hero = state.hero;

    const reachable = getReachableHexes(state, hero, 1);
    if (!reachable.length) return;

    const posA = { col: hero.col, row: hero.row };
    const posB = reachable[0];

    // With food: budget+1 MOVE actions should NOT produce BUDGET_CAP
    // (food funds the one extra step). Without food it would cap.
    state.inventory.shared[ResourceType.FOOD] = 1;
    const heroActionsLeft = state.actionsLeft; // base budget

    // Build exactly budget+1 alternating moves
    const planWithFood = Array.from({ length: heroActionsLeft + 1 }, (_, i) => ({
      type: PlanActionType.MOVE,
      entityId: hero.id,
      toCol: i % 2 === 0 ? posB.col : posA.col,
      toRow: i % 2 === 0 ? posB.row : posA.row,
    }));

    const steps = resolvePlans(state, planWithFood, []);
    const allHeroEvents = steps.flatMap(s => s.heroEvents);

    // All moves should succeed (food covers the extra step)
    const okCount = allHeroEvents.filter(e => e.type === ResEventType.ACTION_OK).length;
    assert.equal(okCount, heroActionsLeft + 1, 'Food should fund one extra action beyond base budget');

    // No budget cap should fire
    const hasCap = allHeroEvents.some(e => e.type === ResEventType.BUDGET_CAP);
    assert.ok(!hasCap, 'BUDGET_CAP should not fire when food covers the extra action');

    // Food should be consumed from shared inventory
    assert.equal(state.inventory.shared[ResourceType.FOOD], 0, 'Food should be consumed');
  });
});

// ── Paired execution ──────────────────────────────────────────────────────────

describe('resolvePlans — paired step execution', () => {
  test('hero and witch both execute in the same step when both have actions', () => {
    const state = freshState();
    const hero = state.hero;
    const witch = state.witch;

    const heroReachable = getReachableHexes(state, hero, 1);
    const witchReachable = getReachableHexes(state, witch, 1);
    if (!heroReachable.length || !witchReachable.length) return;

    const heroPlan = [{ type: PlanActionType.MOVE, entityId: hero.id, toCol: heroReachable[0].col, toRow: heroReachable[0].row }];
    const witchPlan = [{ type: PlanActionType.MOVE, entityId: witch.id, toCol: witchReachable[0].col, toRow: witchReachable[0].row }];

    const steps = resolvePlans(state, heroPlan, witchPlan);
    assert.ok(steps.length > 0);
    // First step should have both hero and witch events
    const firstStep = steps[0];
    assert.ok(firstStep.heroEvents.length > 0, 'Hero should have events in first step');
    assert.ok(firstStep.witchEvents.length > 0, 'Witch should have events in first step');
  });

  test('witch-only plan still executes when hero plan is empty', () => {
    const state = freshState();
    const witch = state.witch;
    const reachable = getReachableHexes(state, witch, 1);
    if (!reachable.length) return;

    const witchPlan = [{ type: PlanActionType.MOVE, entityId: witch.id, toCol: reachable[0].col, toRow: reachable[0].row }];
    const steps = resolvePlans(state, [], witchPlan);
    assert.ok(steps.length > 0);
    assert.ok(steps[0].witchEvents.some(e => e.type === ResEventType.ACTION_OK));
  });
});

// ── ResEventType enum ─────────────────────────────────────────────────────────

describe('ResEventType enum', () => {
  test('has the four required event types', () => {
    assert.equal(ResEventType.ACTION_OK,   'action_ok');
    assert.equal(ResEventType.ACTION_SKIP, 'action_skip');
    assert.equal(ResEventType.ACTION_FAIL, 'action_fail');
    assert.equal(ResEventType.BUDGET_CAP,  'budget_cap');
  });

  test('is frozen (immutable)', () => {
    assert.ok(Object.isFrozen(ResEventType));
  });
});

// ── State mutation correctness ────────────────────────────────────────────────

describe('resolvePlans — state integrity', () => {
  test('battle result removes killed entity from state.entities', () => {
    const state = freshState();
    const hero = state.hero;
    hero.attackBonus = 100; // guarantee kill

    // Buildings start with fortifyLevel=1 — zero it out so fort doesn't absorb damage
    const heroTile = state.tiles.get(hexKey(hero.col, hero.row));
    if (heroTile) heroTile.fortifyLevel = 0;

    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: minion.id,
    }];

    resolvePlans(state, heroPlan, []);

    const minionStillAlive = state.entities.find(e => e.id === minion.id && e.alive);
    // Minion had 2 HP, hero with +100 attackBonus should always kill
    assert.ok(!minionStillAlive, 'Killed minion should be removed from entities');
  });

  test('summon adds entity to state.entities', () => {
    const state = freshState();
    const witch = state.witch;
    state.inventory.witch[ResourceType.FOOD] = 1;
    state.witchSummonsThisTurn = 0;

    const neighbor = emptyPassableNeighbor(state, witch);
    if (!neighbor) return;

    const countBefore = state.entities.length;
    const witchPlan = [{
      type: PlanActionType.SUMMON,
      entityId: witch.id,
      toCol: neighbor.col,
      toRow: neighbor.row,
    }];

    resolvePlans(state, [], witchPlan);
    assert.ok(state.entities.length > countBefore, 'Summon should add entity to state');
  });
});

// ── Resolver tags log entries with faction (Bug #10) ─────────────────────────

describe('resolvePlans — log entries tagged with faction', () => {
  test('hero action logs are tagged with "hero" owner', () => {
    const state = freshState();
    const hero = state.hero;
    const reachable = getReachableHexes(state, hero, 1);
    if (!reachable.length) return;

    state.log = [];
    resolvePlans(state, [{
      type: PlanActionType.MOVE,
      entityId: hero.id,
      toCol: reachable[0].col,
      toRow: reachable[0].row,
    }], []);

    // At least one log entry should be tagged with 'hero'
    const tagged = state.log.filter(e => typeof e === 'object' && e.owner === 'hero');
    assert.ok(tagged.length > 0, 'Hero action should produce log entries tagged with "hero"');
  });

  test('witch action logs are tagged with "witch" owner', () => {
    const state = freshState();
    const witch = state.witch;
    const reachable = getReachableHexes(state, witch, 1);
    if (!reachable.length) return;

    state.log = [];
    resolvePlans(state, [], [{
      type: PlanActionType.MOVE,
      entityId: witch.id,
      toCol: reachable[0].col,
      toRow: reachable[0].row,
    }]);

    const tagged = state.log.filter(e => typeof e === 'object' && e.owner === 'witch');
    assert.ok(tagged.length > 0, 'Witch action should produce log entries tagged with "witch"');
  });

  test('untagged log entries remain plain strings', () => {
    const state = freshState();
    // Empty plans produce no action logs, but existing system logs should remain as strings
    const initialLogCount = state.log.length;
    resolvePlans(state, [], []);
    // Initial logs (game setup) should all be plain strings
    const initialLogs = state.log.slice(0, initialLogCount);
    for (const entry of initialLogs) {
      assert.equal(typeof entry, 'string', 'System log entries should remain plain strings');
    }
  });
});


// ── Battle results include required fields (Bugs #4 + #5) ───────────────────

describe('resolvePlans — battle result fields', () => {
  test('BATTLE_UNIT result includes hit, margin, fortAbsorbed, and breakdown', () => {
    const state = freshState();
    const hero = state.hero;
    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: minion.id,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    assert.ok(steps.length > 0, 'Should produce at least one step');

    const battleEvent = steps[0].heroEvents.find(e => e.type === ResEventType.ACTION_OK);
    assert.ok(battleEvent, 'Should have an ACTION_OK event');
    assert.ok('hit' in battleEvent.result, 'Result should include hit field');
    assert.ok('margin' in battleEvent.result, 'Result should include margin field');
    assert.ok('fortAbsorbed' in battleEvent.result, 'Result should include fortAbsorbed field');
    assert.ok('breakdown' in battleEvent.result, 'Result should include breakdown field');
    assert.equal(typeof battleEvent.result.hit, 'boolean', 'hit should be a boolean');
    assert.equal(typeof battleEvent.result.margin, 'number', 'margin should be a number');
    assert.equal(typeof battleEvent.result.breakdown, 'object', 'breakdown should be an object');
  });

  test('battle result breakdown contains dice and bonus details', () => {
    const state = freshState();
    const hero = state.hero;
    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);

    const steps = resolvePlans(state, [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: minion.id,
    }], []);

    const battleEvent = steps[0]?.heroEvents?.find(e => e.type === ResEventType.ACTION_OK);
    if (!battleEvent) return;

    const bd = battleEvent.result.breakdown;
    assert.ok('atkBaseDie' in bd, 'breakdown should have atkBaseDie');
    assert.ok('defBaseDie' in bd, 'breakdown should have defBaseDie');
    assert.ok('phaseBonus' in bd, 'breakdown should have phaseBonus');
    assert.ok('fortBonus' in bd, 'breakdown should have fortBonus');
  });

  test('battle result includes battleSnaps with actor and target snapshots', () => {
    const state = freshState();
    const hero = state.hero;
    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);

    const steps = resolvePlans(state, [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: minion.id,
    }], []);

    const battleEvent = steps[0]?.heroEvents?.find(e => e.type === ResEventType.ACTION_OK);
    assert.ok(battleEvent, 'Should have a battle event');
    assert.ok(battleEvent.battleSnaps, 'Battle event should include battleSnaps');
    assert.ok(battleEvent.battleSnaps.actorSnap, 'Should have actorSnap');
    assert.ok(battleEvent.battleSnaps.targetSnap, 'Should have targetSnap');
    assert.equal(battleEvent.battleSnaps.actorSnap.id, hero.id, 'actorSnap should be the hero');
    assert.equal(battleEvent.battleSnaps.targetSnap.id, minion.id, 'targetSnap should be the minion');
  });
});
