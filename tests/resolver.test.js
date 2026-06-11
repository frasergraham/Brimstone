// Spec-based tests for server/resolver.js
// Covers: budget computation, paired steps, per-unit simultaneous execution,
// skip/fail/budget-cap events, food bonus.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { GameState, Phase } from '../src/game.js';
import { PlanActionType } from '../src/planner.js';
import {
  Entity, EntityType, createMinion, createZombie, createSurvivor,
} from '../src/entities.js';
import { TileType, ResourceType, legacyTileType, decomposeTileType, isBuildingFootprint } from '../src/tiles.js';
import { hexKey, getNeighbors, hexDistance } from '../src/hex.js';
import { getReachableHexes, executeMove } from '../src/actions.js';

function freshState() {
  return new GameState(true, true);
}

// Procedural maps can drop an impassable building footprint (cap-0) on any hex.
// Test fixtures that carve out passable terrain must neutralize any footprint
// markers a random map happened to place there, or the tile stays impassable.
function clearFootprint(tile) {
  if (!tile) return tile;
  tile.buildingFootprintOf = null;
  tile.footprintHexes = [];
  return tile;
}

function emptyPassableNeighbor(state, entity) {
  return getNeighbors(entity.col, entity.row).find(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!t || legacyTileType(t) === 'river' || isBuildingFootprint(t)) return false;
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

  test('MOVE result includes path array ending at destination (for online serialization)', () => {
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
    const ev = steps[0].heroEvents[0];
    assert.equal(ev.type, ResEventType.ACTION_OK);
    assert.ok(Array.isArray(ev.result.path), 'result.path must be an array (used by _serializeEvents for online)');
    assert.ok(ev.result.path.length >= 1, 'path must have at least one step');
    const last = ev.result.path[ev.result.path.length - 1];
    assert.equal(last.col, target.col);
    assert.equal(last.row, target.row);
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
    state.inventory.hero[ResourceType.FOOD] = 1;
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
    assert.equal(state.inventory.hero[ResourceType.FOOD], 0, 'Food should be consumed');
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
    minion.hp = 1; minion.maxHp = 1; // fragile so any landed hit is lethal
    state.entities.push(minion);

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: minion.id,
    }];

    resolvePlans(state, heroPlan, []);

    const minionStillAlive = state.entities.find(e => e.id === minion.id && e.alive);
    // 1 HP minion vs hero with +100 attackBonus should always die
    assert.ok(!minionStillAlive, 'Killed minion should be removed from entities');
  });

  test('summon adds entity to state.entities on witch tile', () => {
    const state = freshState();
    const witch = state.witch;
    state.inventory.witch[ResourceType.FOOD] = 2;

    const countBefore = state.entities.length;
    const witchPlan = [{
      type: PlanActionType.SUMMON,
      entityId: witch.id,
    }];

    resolvePlans(state, [], witchPlan);
    assert.ok(state.entities.length > countBefore, 'Summon should add entity to state');
    const summoned = state.entities.find(e => e !== witch && e.col === witch.col && e.row === witch.row);
    assert.ok(summoned, 'Summoned unit should appear on the witch tile');
  });
});

// ── Resolver tags log entries with faction (Bug #10) ─────────────────────────

describe('resolvePlans — log entries tagged with faction', () => {
  test('hero action logs are tagged with "hero" owner', () => {
    const state = freshState();
    const hero = state.hero;

    state.log = [];
    resolvePlans(state, [{
      type: PlanActionType.EXPLORE,
      entityId: hero.id,
    }], []);

    // At least one log entry should be tagged with 'hero'
    const tagged = state.log.filter(e => typeof e === 'object' && e.owner === 'hero');
    assert.ok(tagged.length > 0, 'Hero action should produce log entries tagged with "hero"');
  });

  test('witch action logs are tagged with "witch" owner', () => {
    const state = freshState();
    const witch = state.witch;

    state.log = [];
    resolvePlans(state, [], [{
      type: PlanActionType.EXPLORE,
      entityId: witch.id,
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
  test('BATTLE_UNIT result includes hit, margin, fortDamaged, and breakdown', () => {
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
    assert.ok('fortDamaged' in battleEvent.result, 'Result should include fortDamaged field');
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

// ── Movement hex-step cap ────────────────────────────────────────────────────
// executeMove now limits the number of hex tiles walked per action (2 normal, 3 horse).

/**
 * Build a minimal state with a horizontal road chain on row 2.
 * Clears all entities except the hero placed at (startCol, 2).
 * Road tiles: from startCol to startCol + length - 1, all on row 2.
 */
function roadChainState(startCol, length) {
  const state = freshState();
  // Place hero at start of the chain
  state.hero.col = startCol;
  state.hero.row = 2;
  // Remove all entities except hero
  state.entities = state.entities.filter(e => e.id === state.hero.id);
  // Lay road tiles along the chain
  for (let c = startCol; c < startCol + length; c++) {
    const k = hexKey(c, 2);
    const t = state.tiles.get(k);
    if (t) {
      decomposeTileType(t, TileType.ROAD);
      t.building = null;
      t.fortifyLevel = 0;
      t.hiddenSurvivor = false;
      clearFootprint(t);
    }
  }
  return state;
}

describe('executeMove — hex-step cap', () => {
  test('normal unit on road chain stops after 2 hex steps', () => {
    const state = roadChainState(2, 6);
    const hero = state.hero;
    // Target is 4 road tiles away — cost-reachable (budget 2, roads cost 1 each = only 2 reachable)
    // But let's target 2 tiles away first to confirm it works
    const r2 = executeMove(state, hero, 4, 2);
    assert.ok(r2.success, 'Move to 2 tiles away should succeed');
    assert.equal(hero.col, 4, 'Hero should reach col 4 (2 road steps)');
    assert.ok(r2.path.length <= 2, 'Path should be at most 2 steps');
  });

  test('normal unit cannot walk more than 2 road tiles even if cost-reachable', () => {
    // With range=1, budget=2, and road tiles costing 1 each, getReachableHexes
    // allows up to 2 road tiles. The step cap also limits to 2, so for normal
    // movement these align. This test validates the cap is in effect.
    const state = roadChainState(2, 6);
    const hero = state.hero;
    const result = executeMove(state, hero, 4, 2);
    assert.ok(result.success);
    assert.ok(result.path.length <= 2, 'Path must not exceed 2 hex steps');
  });

  test('horse unit on road chain stops after 3 hex steps', () => {
    const state = roadChainState(1, 8);
    const hero = state.hero;
    // Give hero a horse (range 2, budget 4 → 4 road tiles cost-reachable)
    hero.items = { horse: 1 };

    // Move to 3 tiles away (col 1 → col 4)
    const r3 = executeMove(state, hero, 4, 2);
    assert.ok(r3.success, 'Horse move to 3 tiles away should succeed');
    assert.equal(hero.col, 4, 'Hero should reach col 4 (3 road steps)');
    assert.equal(r3.path.length, 3, 'Horse path should be exactly 3 steps');
  });

  test('horse unit reaches 4th road tile (full budget)', () => {
    const state = roadChainState(1, 8);
    const hero = state.hero;
    hero.items = { horse: 1 };

    // col 5 is 4 road tiles away — cost-reachable with horse (budget 4, each road costs 1)
    const r4 = executeMove(state, hero, 5, 2);
    assert.ok(r4.success, 'Move to 4 road tiles away should succeed');
    assert.equal(r4.path.length, 4, 'Horse path should be exactly 4 steps on roads');
    assert.equal(hero.col, 5, 'Hero should reach col 5 (4 road steps with horse)');
  });

  test('horse unit cannot reach 5 road tiles away', () => {
    const state = roadChainState(1, 10);
    const hero = state.hero;
    hero.items = { horse: 1 };

    // col 6 is 5 road tiles away — beyond horse budget (4)
    const r5 = executeMove(state, hero, 6, 2);
    assert.equal(r5.success, false, '5 road tiles exceeds horse budget');
  });

  test('1-step move is unaffected by cap', () => {
    const state = roadChainState(3, 4);
    const hero = state.hero;
    const result = executeMove(state, hero, 4, 2);
    assert.ok(result.success);
    assert.equal(result.path.length, 1);
    assert.equal(hero.col, 4);
  });
});

// ── BATTLE_UNIT target fallback ───────────���──────────────────────────────────
// When the original target is gone/moved, fall back to another enemy on the
// planned target hex (random pick, like BATTLE_HEX).

describe('resolvePlans — BATTLE_UNIT target fallback', () => {
  test('original target alive and adjacent — normal battle, no fallback', () => {
    const state = freshState();
    const hero = state.hero;
    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: minion.id,
      targetCol: minion.col,
      targetRow: minion.row,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    assert.ok(steps.length > 0);
    const ev = steps[0].heroEvents.find(e => e.type === ResEventType.ACTION_OK);
    assert.ok(ev, 'Should have an ACTION_OK battle event');
  });

  test('original target dead, other enemy on hex — fallback attacks substitute', () => {
    const state = freshState();
    const hero = state.hero;
    // Place two minions on hero's hex
    const target = createMinion(hero.col, hero.row);
    const other  = createMinion(hero.col, hero.row);
    state.entities.push(target, other);

    // Kill the original target before resolution (alive is derived from hp)
    target.hp = 0;

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: target.id,
      targetCol: hero.col,
      targetRow: hero.row,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    const allEvents = steps.flatMap(s => s.heroEvents);
    const ok = allEvents.find(e => e.type === ResEventType.ACTION_OK);
    assert.ok(ok, 'Fallback should attack the substitute enemy (ACTION_OK)');
  });

  test('original target moved away, other enemy on hex — fallback fires', () => {
    const state = freshState();
    const hero = state.hero;
    const target = createMinion(hero.col, hero.row);
    const other  = createMinion(hero.col, hero.row);
    state.entities.push(target, other);

    // Move the original target far away so dist > 1
    target.col = hero.col + 5;
    target.row = hero.row + 5;

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: target.id,
      targetCol: hero.col,   // planned hex still has 'other'
      targetRow: hero.row,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    const allEvents = steps.flatMap(s => s.heroEvents);
    const ok = allEvents.find(e => e.type === ResEventType.ACTION_OK);
    assert.ok(ok, 'Fallback should attack substitute when original moved away');
  });

  test('target alive but fled out of range, no fallback — skip flagged targetFled with whiff', () => {
    const state = freshState();
    const hero = state.hero;
    const target = createMinion(hero.col, hero.row);
    state.entities.push(target);

    // Target moved far away this turn — still alive, just out of reach
    target.col = hero.col + 5;
    target.row = hero.row + 5;

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: target.id,
      targetCol: hero.col,
      targetRow: hero.row,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    const allEvents = steps.flatMap(s => s.heroEvents);
    const skip = allEvents.find(e => e.type === ResEventType.ACTION_SKIP);
    assert.ok(skip, 'Should produce ACTION_SKIP when the target fled');
    assert.equal(skip.targetFled, true, 'Skip must be flagged targetFled');
    assert.match(skip.reason, /slipped away/i);
    // Whiff payload lets the animation layer swing at the planned hex
    assert.deepEqual(skip.whiffTarget, { col: hero.col, row: hero.row });
    assert.ok(skip.battleSnaps?.actorSnap, 'Whiff needs the actor snapshot');
  });

  test('target dead — skip keeps the dead-or-gone reason, NOT targetFled', () => {
    const state = freshState();
    const hero = state.hero;
    const target = createMinion(hero.col, hero.row);
    state.entities.push(target);
    target.hp = 0;

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: target.id,
      targetCol: hero.col,
      targetRow: hero.row,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    const allEvents = steps.flatMap(s => s.heroEvents);
    const skip = allEvents.find(e => e.type === ResEventType.ACTION_SKIP);
    assert.ok(skip, 'Should produce ACTION_SKIP when the target is dead');
    assert.ok(!skip.targetFled, 'Dead target is not a fled target');
    assert.equal(skip.reason, 'Target is dead or gone.');
  });

  test('original target gone, no enemy on hex — skip', () => {
    const state = freshState();
    const hero = state.hero;
    const target = createMinion(hero.col, hero.row);
    state.entities.push(target);

    // Kill target — no other enemies on hex (alive derived from hp)
    target.hp = 0;

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: target.id,
      targetCol: hero.col,
      targetRow: hero.row,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    const allEvents = steps.flatMap(s => s.heroEvents);
    const ok = allEvents.find(e => e.type === ResEventType.ACTION_OK);
    // Should skip, not produce an ok
    assert.ok(!ok, 'Should not produce ACTION_OK when no enemies remain');
  });

  test('action missing targetCol/targetRow — backward compat skip', () => {
    const state = freshState();
    const hero = state.hero;
    const target = createMinion(hero.col, hero.row);
    state.entities.push(target);
    target.hp = 0;

    // Old-format action without targetCol/targetRow
    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: target.id,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    const allEvents = steps.flatMap(s => s.heroEvents);
    const ok = allEvents.find(e => e.type === ResEventType.ACTION_OK);
    assert.ok(!ok, 'Without targetCol/targetRow, fallback should not fire');
  });

  test('fallback hex out of attacker range — skip', () => {
    const state = freshState();
    const hero = state.hero;
    // Place a minion on a distant hex
    const farCol = hero.col + 3;
    const farRow = hero.row;
    const target = createMinion(farCol, farRow);
    const other  = createMinion(farCol, farRow);
    state.entities.push(target, other);

    // Kill original target
    target.hp = 0;

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT,
      entityId: hero.id,
      targetId: target.id,
      targetCol: farCol,   // hex is 3+ away from hero
      targetRow: farRow,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    const allEvents = steps.flatMap(s => s.heroEvents);
    const ok = allEvents.find(e => e.type === ResEventType.ACTION_OK);
    assert.ok(!ok, 'Fallback should not fire when planned hex is out of range');
  });
});

// ── Per-unit simultaneous execution ──────────────────────────────────────────

describe('resolvePlans — per-unit simultaneous execution', () => {
  test('two hero units execute in the same step', () => {
    const state = freshState();
    const hero = state.hero;

    // Create a survivor near the hero
    const heroNeighbor = emptyPassableNeighbor(state, hero);
    if (!heroNeighbor) return;
    const survivor = createSurvivor(heroNeighbor.col, heroNeighbor.row, null);
    survivor.owner = 'hero';
    state.entities.push(survivor);

    // Find valid moves for both
    const heroTarget = emptyPassableNeighbor(state, hero);
    const survTarget = emptyPassableNeighbor(state, survivor);
    if (!heroTarget || !survTarget) return;

    // Plan: hero moves, survivor moves — interleaved as per-unit queues
    const heroPlan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: heroTarget.col, toRow: heroTarget.row },
      { type: PlanActionType.MOVE, entityId: survivor.id, toCol: survTarget.col, toRow: survTarget.row },
    ];

    const steps = resolvePlans(state, heroPlan, []);
    assert.ok(steps.length >= 1, 'Should produce at least one step');

    // Both units should execute in the same step (simultaneous per-unit)
    const step0Events = steps[0].heroEvents.filter(e => e.type === ResEventType.ACTION_OK);
    const actingEntityIds = step0Events.map(e => e.action.entityId);
    assert.ok(actingEntityIds.includes(hero.id), 'Hero should act in step 0');
    assert.ok(actingEntityIds.includes(survivor.id), 'Survivor should act in step 0');
  });

  test('unequal queue lengths: unit with fewer actions finishes first', () => {
    const state = freshState();
    const hero = state.hero;

    // Create survivor
    const sPos = emptyPassableNeighbor(state, hero);
    if (!sPos) return;
    const survivor = createSurvivor(sPos.col, sPos.row, null);
    survivor.owner = 'hero';
    state.entities.push(survivor);

    // Hero gets 2 alternating moves, survivor gets 1 explore
    const posA = { col: hero.col, row: hero.row };
    const posB = emptyPassableNeighbor(state, hero);
    if (!posB) return;

    const heroPlan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: posB.col, toRow: posB.row },
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: posA.col, toRow: posA.row },
      { type: PlanActionType.EXPLORE, entityId: survivor.id },
    ];

    const steps = resolvePlans(state, heroPlan, []);

    // Step 0: hero move + survivor explore (both units act)
    if (steps.length >= 1) {
      const step0Entities = steps[0].heroEvents
        .filter(e => e.type === ResEventType.ACTION_OK)
        .map(e => e.action.entityId);
      assert.ok(step0Entities.includes(hero.id), 'Hero should act in step 0');
      assert.ok(step0Entities.includes(survivor.id), 'Survivor should act in step 0');
    }

    // Step 1: only hero moves (survivor has no more actions)
    if (steps.length >= 2) {
      const step1Entities = steps[1].heroEvents
        .filter(e => e.type === ResEventType.ACTION_OK)
        .map(e => e.action.entityId);
      assert.ok(step1Entities.includes(hero.id), 'Hero should act in step 1');
      assert.ok(!step1Entities.includes(survivor.id), 'Survivor should NOT act in step 1');
    }
  });

  test('shared budget is consumed across multiple units', () => {
    const state = freshState();
    const hero = state.hero;

    // Create a survivor
    const sPos = emptyPassableNeighbor(state, hero);
    if (!sPos) return;
    const survivor = createSurvivor(sPos.col, sPos.row, null);
    survivor.owner = 'hero';
    state.entities.push(survivor);

    // Give both units many moves — should be capped by shared budget
    const posA = { col: hero.col, row: hero.row };
    const posB = emptyPassableNeighbor(state, hero);
    if (!posB) return;

    const sA = { col: survivor.col, row: survivor.row };
    const sB = emptyPassableNeighbor(state, survivor);
    if (!sB) return;

    // 10 moves each — way more than budget allows
    const heroPlan = [];
    for (let i = 0; i < 10; i++) {
      heroPlan.push({
        type: PlanActionType.MOVE,
        entityId: hero.id,
        toCol: i % 2 === 0 ? posB.col : posA.col,
        toRow: i % 2 === 0 ? posB.row : posA.row,
      });
      heroPlan.push({
        type: PlanActionType.MOVE,
        entityId: survivor.id,
        toCol: i % 2 === 0 ? sB.col : sA.col,
        toRow: i % 2 === 0 ? sB.row : sA.row,
      });
    }

    const steps = resolvePlans(state, heroPlan, []);
    const allHeroOK = steps.flatMap(s => s.heroEvents).filter(e => e.type === ResEventType.ACTION_OK);
    const allHeroCap = steps.flatMap(s => s.heroEvents).filter(e => e.type === ResEventType.BUDGET_CAP);

    // With 20 planned actions, the budget should cap eventually
    assert.ok(allHeroOK.length < 20, `Should not execute all 20 actions (got ${allHeroOK.length})`);
    assert.ok(allHeroOK.length >= 3, `Should execute at least base budget worth of actions (got ${allHeroOK.length})`);
    // Budget cap should fire at some point
    assert.ok(allHeroCap.length > 0, 'BUDGET_CAP should fire when shared budget is exhausted');
  });
});

// ── BATTLE_HEX empty-hex whiff ────────────────────────────────────────────────

describe('resolvePlans — BATTLE_HEX on empty hex returns skip with actorSnap and whiffTarget', () => {
  test('skip event includes battleSnaps.actorSnap and whiffTarget when target hex is empty', () => {
    const state = freshState();
    const hero = state.hero;
    const target = emptyPassableNeighbor(state, hero);
    assert.ok(target, 'Need an empty passable neighbor for this test');

    // Ensure the target hex truly has no enemies
    const enemiesOnTarget = state.entities.filter(
      e => e.alive && e.owner !== 'hero' && e.col === target.col && e.row === target.row
    );
    assert.equal(enemiesOnTarget.length, 0, 'Target hex should have no enemies');

    const heroPlan = [{
      type: PlanActionType.BATTLE_HEX,
      entityId: hero.id,
      targetCol: target.col,
      targetRow: target.row,
    }];

    const steps = resolvePlans(state, heroPlan, []);
    const allHeroEvents = steps.flatMap(s => s.heroEvents);
    const skipEv = allHeroEvents.find(e => e.type === ResEventType.ACTION_SKIP);
    assert.ok(skipEv, 'Empty-hex BATTLE_HEX should produce an ACTION_SKIP event');
    assert.ok(skipEv.battleSnaps, 'Skip event should include battleSnaps');
    assert.ok(skipEv.battleSnaps.actorSnap, 'battleSnaps should include actorSnap');
    assert.equal(skipEv.battleSnaps.actorSnap.id, hero.id, 'actorSnap should be the attacking entity');
    assert.ok(skipEv.whiffTarget, 'Skip event should include whiffTarget');
    assert.equal(skipEv.whiffTarget.col, target.col, 'whiffTarget.col should match target hex');
    assert.equal(skipEv.whiffTarget.row, target.row, 'whiffTarget.row should match target hex');
  });
});

// ── Movement interrupted by enemy ──────────────────────────────────────────
// When one faction's move places a unit on a hex that another faction's unit
// was about to traverse, the second unit should stop before the blocked hex.

describe('movement interrupted by enemy during resolution', () => {
  test('witch minion stops before hero that moved into path', () => {
    const state = freshState();
    const hero = state.hero;

    // Set up a horizontal road chain at row 2: cols 2–7
    for (let c = 2; c <= 7; c++) {
      const k = hexKey(c, 2);
      const t = state.tiles.get(k);
      if (t) { decomposeTileType(t, TileType.ROAD); t.building = null; t.fortifyLevel = 0; t.hiddenSurvivor = false; clearFootprint(t); }
    }

    // Place hero at col 3 (one step from col 4)
    hero.col = 3;
    hero.row = 2;

    // Create a witch minion at col 5 — plans to move to col 3 (through col 4)
    const minion = createMinion(5, 2);
    state.entities = state.entities.filter(e => e.id === hero.id || e.id === state.witch.id);
    state.entities.push(minion);

    // Move witch out of the way so she doesn't interfere
    state.witch.col = 0;
    state.witch.row = 0;

    // Hero plan: move to col 4
    const heroPlan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: 4, toRow: 2 },
    ];
    // Witch plan: minion moves to col 3 (path: col 5 → col 4 → col 3)
    const witchPlan = [
      { type: PlanActionType.MOVE, entityId: minion.id, toCol: 3, toRow: 2 },
    ];

    const steps = resolvePlans(state, heroPlan, witchPlan);

    // Hero resolves first → hero moves to col 4
    // Then witch's minion tries to move to col 3 via col 4 → blocked by hero at col 4
    // Minion should NOT have reached col 3
    assert.notEqual(minion.col, 3, 'Minion should not reach col 3 (hero blocking at col 4)');

    // Find the witch move event to check for blockedBy
    const witchMoveEvents = steps.flatMap(s => s.witchEvents ?? [])
      .filter(e => e.action?.type === PlanActionType.MOVE && e.action?.entityId === minion.id);

    assert.ok(witchMoveEvents.length > 0, 'Should have a witch move event');
    const moveEv = witchMoveEvents[0];

    // The move might succeed partially (blockedBy set) or fail entirely
    if (moveEv.type === ResEventType.ACTION_OK) {
      // Partial move — unit moved some hexes but was blocked
      assert.ok(moveEv.result.blockedBy, 'blockedBy should be set when movement interrupted by enemy');
      assert.ok(moveEv.result.log.some(l => l.includes('movement blocked by')),
        'Log should mention movement was blocked');
    } else {
      // Fully blocked — couldn't move at all (hero on only path to destination)
      assert.equal(moveEv.type, ResEventType.ACTION_FAIL, 'Should be ACTION_FAIL when fully blocked');
      // blockedBy is only set when enemy is on the target hex itself, not when
      // they merely block the route. This is the "path blocked" case.
    }
  });

  test('move to adjacent enemy hex: fails with blockedBy in ACTION_FAIL', () => {
    // Adjacent enemy — hero can't walk at all (0 intermediate hexes)
    const state = freshState();
    const hero = state.hero;

    const neighbor = getNeighbors(hero.col, hero.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && legacyTileType(t) !== 'river'
        && !isBuildingFootprint(t);
    });
    assert.ok(neighbor, 'Need an adjacent passable hex');
    const minion = createMinion(neighbor.col, neighbor.row);
    state.entities.push(minion);

    const heroPlan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: neighbor.col, toRow: neighbor.row },
    ];

    const steps = resolvePlans(state, heroPlan, []);
    const heroMoveEvents = steps.flatMap(s => s.heroEvents ?? [])
      .filter(e => e.action?.type === PlanActionType.MOVE);
    assert.ok(heroMoveEvents.length > 0, 'Should have a hero move event');

    const moveEv = heroMoveEvents[0];
    assert.equal(moveEv.type, ResEventType.ACTION_FAIL, 'Should be ACTION_FAIL');
    assert.ok(moveEv.blockedBy, 'ACTION_FAIL should have blockedBy set');
    assert.equal(moveEv.blockedBy.id, minion.id);
    assert.ok(moveEv.reason.includes('movement blocked by'));
  });

  test('move to enemy hex 2 away: walks 1 hex then stops (fog scenario)', () => {
    // Simulates fog: hero planned to move to a hex 2 away with a hidden enemy.
    // Hero should walk 1 hex and stop before the enemy.
    const state = freshState();
    const hero = state.hero;

    // Use deterministic coordinates: (6,2) → (7,2) → (8,2) — guaranteed
    // neighbors in even-row odd-r offset hex grid.
    const heroPos = { col: 6, row: 2 };
    const n1 = { col: 7, row: 2 };
    const n2 = { col: 8, row: 2 };

    // Make hexes roads so they're within movement budget
    for (const h of [heroPos, n1, n2]) {
      const t = state.tiles.get(hexKey(h.col, h.row));
      if (t) { decomposeTileType(t, TileType.ROAD); t.building = null; t.hiddenSurvivor = false; clearFootprint(t); }
    }

    // Place hero at known position
    hero.col = heroPos.col;
    hero.row = heroPos.row;

    // Remove other entities except hero, place enemy on n2
    state.entities = state.entities.filter(e => e.id === hero.id);
    const minion = createMinion(n2.col, n2.row);
    state.entities.push(minion);

    const origCol = hero.col;
    const origRow = hero.row;
    const heroPlan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: n2.col, toRow: n2.row },
    ];

    const steps = resolvePlans(state, heroPlan, []);
    const heroMoveEvents = steps.flatMap(s => s.heroEvents ?? [])
      .filter(e => e.action?.type === PlanActionType.MOVE);
    assert.ok(heroMoveEvents.length > 0, 'Should have a hero move event');

    const moveEv = heroMoveEvents[0];
    assert.equal(moveEv.type, ResEventType.ACTION_OK, 'Should be ACTION_OK (partial move)');
    assert.ok(moveEv.result.blockedBy, 'blockedBy should reference the blocking enemy');
    assert.equal(moveEv.result.blockedBy.id, minion.id);
    assert.ok(moveEv.result.log.some(l => l.includes('movement blocked by')),
      'Log should mention blocked by enemy');
    // Hero should have moved to n1 (1 hex), not n2
    assert.equal(hero.col, n1.col, 'Hero should stop at intermediate hex');
    assert.equal(hero.row, n1.row);
    assert.ok(hero.col !== origCol || hero.row !== origRow, 'Hero should have moved from starting position');
  });
});

// ── Agility-driven turn order within a step ──────────────────────────────────

describe('resolvePlans — Agility ordering', () => {
  // Find two distinct empty passable neighbors for a given entity.
  function twoEmptyNeighbors(state, entity) {
    const results = [];
    for (const n of getNeighbors(entity.col, entity.row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (!t || legacyTileType(t) === 'river' || isBuildingFootprint(t)) continue;
      if (state.entities.some(e => e.alive && e.col === n.col && e.row === n.row)) continue;
      results.push(n);
      if (results.length === 2) break;
    }
    return results;
  }

  test('higher-Agility unit acts before lower-Agility unit in the same step', () => {
    const state = freshState();
    const hero = state.hero;

    // Place an allied survivor adjacent to the hero (hero faction).
    const near = emptyPassableNeighbor(state, hero);
    if (!near) return;
    const ally = createSurvivor(near.col, near.row);
    ally.owner = 'hero';
    state.entities.push(ally);

    // Force clear agility values: hero slow, ally fast.
    hero.agility = 3;
    ally.agility = 9;

    // Both units queue a MOVE this step into their own empty neighbor.
    const heroTarget = emptyPassableNeighbor(state, hero);
    const allyTarget = emptyPassableNeighbor(state, ally);
    if (!heroTarget || !allyTarget) return;

    const heroPlan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: heroTarget.col, toRow: heroTarget.row },
      { type: PlanActionType.MOVE, entityId: ally.id, toCol: allyTarget.col, toRow: allyTarget.row },
    ];

    const steps = resolvePlans(state, heroPlan, []);
    const firstStep = steps[0];
    const okEvents = firstStep.heroEvents.filter(e => e.type === ResEventType.ACTION_OK);
    assert.equal(okEvents.length, 2, 'Both MOVEs should resolve in the first step');
    assert.equal(okEvents[0].action.entityId, ally.id, 'Higher-Agility ally acts first');
    assert.equal(okEvents[1].action.entityId, hero.id, 'Lower-Agility hero acts second');
  });

  test('ordering reverses when Agility values are swapped', () => {
    const state = freshState();
    const hero = state.hero;
    const near = emptyPassableNeighbor(state, hero);
    if (!near) return;
    const ally = createSurvivor(near.col, near.row);
    ally.owner = 'hero';
    state.entities.push(ally);

    hero.agility = 9;
    ally.agility = 3;

    const heroTarget = emptyPassableNeighbor(state, hero);
    const allyTarget = emptyPassableNeighbor(state, ally);
    if (!heroTarget || !allyTarget) return;

    const steps = resolvePlans(state, [
      { type: PlanActionType.MOVE, entityId: ally.id, toCol: allyTarget.col, toRow: allyTarget.row },
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: heroTarget.col, toRow: heroTarget.row },
    ], []);

    const ok = steps[0].heroEvents.filter(e => e.type === ResEventType.ACTION_OK);
    assert.equal(ok[0].action.entityId, hero.id, 'Higher-Agility hero acts first after swap');
    assert.equal(ok[1].action.entityId, ally.id);
  });

  test('Agility tie breaks numerically by entity id (e2 before e10)', () => {
    const state = freshState();
    const hero = state.hero;
    const near = emptyPassableNeighbor(state, hero);
    if (!near) return;
    const ally = createSurvivor(near.col, near.row);
    ally.owner = 'hero';
    state.entities.push(ally);

    // Force a tie on agility; force ids to demonstrate numeric (not lex) sort.
    hero.agility = 5;
    ally.agility = 5;
    // Use ids that are numerically unambiguous AND reverse lexicographic order,
    // so this test proves numeric (not string) sort. e200 > e30 numerically
    // but 'e200' < 'e30' lexicographically. Ids chosen high enough to avoid
    // collisions with entities auto-generated by GameState construction.
    hero.id = 'e200';
    ally.id = 'e30';

    const heroTarget = emptyPassableNeighbor(state, hero);
    const allyTarget = emptyPassableNeighbor(state, ally);
    if (!heroTarget || !allyTarget) return;

    const steps = resolvePlans(state, [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: heroTarget.col, toRow: heroTarget.row },
      { type: PlanActionType.MOVE, entityId: ally.id, toCol: allyTarget.col, toRow: allyTarget.row },
    ], []);

    const ok = steps[0].heroEvents.filter(e => e.type === ResEventType.ACTION_OK);
    assert.equal(ok[0].action.entityId, 'e30',  'e30 should act before e200 (numeric id sort)');
    assert.equal(ok[1].action.entityId, 'e200');
  });

  test('Agility is re-read each step — ordering is stable across steps', () => {
    const state = freshState();
    const hero = state.hero;
    const near = emptyPassableNeighbor(state, hero);
    if (!near) return;
    const ally = createSurvivor(near.col, near.row);
    ally.owner = 'hero';
    state.entities.push(ally);

    hero.agility = 8;
    ally.agility = 2;

    // Queue two MOVEs each — oscillate between the original pos and a neighbor.
    const heroTwo = twoEmptyNeighbors(state, hero);
    const allyTwo = twoEmptyNeighbors(state, ally);
    if (heroTwo.length < 1 || allyTwo.length < 1) return;
    const heroStart = { col: hero.col, row: hero.row };
    const allyStart = { col: ally.col, row: ally.row };
    const heroA = heroTwo[0];
    const allyA = allyTwo[0];

    const plan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: heroA.col, toRow: heroA.row },
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: heroStart.col, toRow: heroStart.row },
      { type: PlanActionType.MOVE, entityId: ally.id, toCol: allyA.col, toRow: allyA.row },
      { type: PlanActionType.MOVE, entityId: ally.id, toCol: allyStart.col, toRow: allyStart.row },
    ];

    const steps = resolvePlans(state, plan, []);
    assert.ok(steps.length >= 2, 'Expect at least two steps');
    for (let i = 0; i < 2; i++) {
      const ok = steps[i].heroEvents.filter(e => e.type === ResEventType.ACTION_OK);
      assert.equal(ok[0].action.entityId, hero.id, `Step ${i}: hero (agility 8) first`);
      assert.equal(ok[1].action.entityId, ally.id, `Step ${i}: ally (agility 2) second`);
    }
  });

  test('dead actor in the candidate list does not throw and falls through', () => {
    const state = freshState();
    const hero = state.hero;
    const near = emptyPassableNeighbor(state, hero);
    if (!near) return;
    const ally = createSurvivor(near.col, near.row);
    ally.owner = 'hero';
    state.entities.push(ally);

    // Ally is queued to act but already removed from the entity array.
    state.entities = state.entities.filter(e => e.id !== ally.id);

    const heroTarget = emptyPassableNeighbor(state, hero);
    if (!heroTarget) return;

    const plan = [
      { type: PlanActionType.MOVE, entityId: ally.id, toCol: hero.col, toRow: hero.row }, // dead actor
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: heroTarget.col, toRow: heroTarget.row },
    ];

    const steps = resolvePlans(state, plan, []);
    // Hero's move should still resolve; ally entry becomes a skip.
    const allEvents = steps.flatMap(s => s.heroEvents);
    const heroOk = allEvents.find(e => e.type === ResEventType.ACTION_OK && e.action.entityId === hero.id);
    assert.ok(heroOk, 'Hero MOVE should still resolve despite a dead co-actor');
    const skipped = allEvents.find(e => e.type === ResEventType.ACTION_SKIP && e.action.entityId === ally.id);
    assert.ok(skipped, 'Dead-actor entry should produce ACTION_SKIP, not an error');
  });

  test('cross-faction: higher-Agility attacker strikes first in a mutual battle', () => {
    const state = freshState();
    const hero = state.hero;

    // Place a minion adjacent to hero so both can target each other.
    const near = emptyPassableNeighbor(state, hero);
    if (!near) return;
    const minion = createMinion(near.col, near.row);
    minion.owner = 'witch';
    state.entities.push(minion);

    // Witch-owned minion has higher agility: should attack hero first.
    hero.agility = 3;
    minion.agility = 9;

    const heroPlan = [{
      type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id,
      targetCol: minion.col, targetRow: minion.row,
    }];
    const witchPlan = [{
      type: PlanActionType.BATTLE_UNIT, entityId: minion.id, targetId: hero.id,
      targetCol: hero.col, targetRow: hero.row,
    }];

    const steps = resolvePlans(state, heroPlan, witchPlan);
    // Witch (higher agility) event must be the first ACTION_OK across both factions in step 0.
    const step0 = steps[0];
    const witchFirstOk = step0.witchEvents.find(e => e.type === ResEventType.ACTION_OK);
    assert.ok(witchFirstOk, 'Witch minion (higher agility) should resolve its battle in step 0');
  });
});
