// Parity test: verifies that the UI's food-tagging in buildUnitPlanBlocksHtml
// marks the exact same (entityId, stepIdx) pairs as the server's resolver
// emits FOOD_CONSUMED events for.
//
// Both the UI renderer and the resolver walk per-entity queues in the same
// interleaved order (step 0 of each unit, step 1, etc.), consuming food when
// the running cost exceeds the action budget.  This test catches any drift
// between the two paths.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { buildUnitPlanBlocksHtml } from '../src/ui-render.js';
import { GameState, Phase } from '../src/game.js';
import { PlanActionType, groupPlanByEntity } from '../src/planner.js';
import { createSurvivor, EntityType } from '../src/entities.js';
import { ResourceType } from '../src/tiles.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { getReachableHexes } from '../src/actions.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function freshState() {
  return new GameState(true, true);
}

/** Compute the hero budget the same way the resolver's budgetFor does. */
function heroBudget(state) {
  const extras = state.entities.filter(
    e => e.alive && e.owner === 'hero' && e.type !== 'paladin'
  ).length;
  const timeBonus = (state.phase === Phase.DAY || state.phase === Phase.DAWN) ? 1 : 0;
  return 3 + timeBonus + Math.min(extras, 5);
}

/** Find an empty passable neighbor, optionally excluding certain hex keys. */
function emptyPassableNeighbor(state, col, row, excludeKeys) {
  return getNeighbors(col, row).find(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!t || t.type === 'river') return false;
    if (excludeKeys && excludeKeys.has(hexKey(n.col, n.row))) return false;
    return !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
  }) ?? null;
}

/** Build alternating moves between two hexes. */
function pingPongMoves(entityId, posA, posB, count) {
  return Array.from({ length: count }, (_, i) => ({
    type: PlanActionType.MOVE,
    entityId,
    toCol: i % 2 === 0 ? posB.col : posA.col,
    toRow: i % 2 === 0 ? posB.row : posA.row,
  }));
}

/**
 * Extract food-powered (entityId, stepIdx) pairs from resolver step records.
 * In each resolution step, FOOD_CONSUMED is emitted right before the ACTION_OK
 * it funds within the same drainOneStep call.
 */
function extractServerFoodKeys(steps) {
  const entityActionCount = {};
  const result = [];
  for (const step of steps) {
    let pendingFood = false;
    for (const ev of step.heroEvents) {
      if (ev.type === ResEventType.FOOD_CONSUMED) {
        pendingFood = true;
        continue;
      }
      if (ev.type === ResEventType.ACTION_OK) {
        const eid = ev.action.entityId;
        if (!entityActionCount[eid]) entityActionCount[eid] = 0;
        if (pendingFood) {
          result.push({ entityId: eid, stepIdx: entityActionCount[eid] });
          pendingFood = false;
        }
        entityActionCount[eid]++;
      }
    }
  }
  return result;
}

/**
 * Extract food-powered (entityId, stepIdx) pairs from rendered HTML.
 * Parses per-unit blocks for the 'food-powered' CSS class.
 */
function extractUIFoodKeys(html) {
  const result = [];
  const blockRegex = /data-entity-id="([^"]+)"[\s\S]*?<div class="plan-unit-steps">([\s\S]*?)<\/div><\/div>/g;
  let blockMatch;
  while ((blockMatch = blockRegex.exec(html)) !== null) {
    const entityId = blockMatch[1];
    const stepsHtml = blockMatch[2];
    const stepRegex = /<div class="plan-step([^"]*)">/g;
    let stepMatch;
    let idx = 0;
    while ((stepMatch = stepRegex.exec(stepsHtml)) !== null) {
      if (stepMatch[1].includes('food-powered')) {
        result.push({ entityId, stepIdx: idx });
      }
      idx++;
    }
  }
  return result;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('food-action parity — UI tagging matches server consumption', () => {

  test('single-unit: food-powered action indices match between UI and resolver', () => {
    const state = freshState();
    const hero = state.hero;

    const reachable = getReachableHexes(state, hero, 1);
    if (!reachable.length) return;

    const posA = { col: hero.col, row: hero.row };
    const posB = reachable[0];
    const budget = heroBudget(state);
    const foodCount = 2;
    state.inventory.hero[ResourceType.FOOD] = foodCount;

    // budget + 2 food-powered + 1 over-budget (capped)
    const moves = pingPongMoves(hero.id, posA, posB, budget + foodCount + 1);
    const unitPlans = groupPlanByEntity(moves);

    // UI check (non-mutating)
    const uiKeys = extractUIFoodKeys(
      buildUnitPlanBlocksHtml(unitPlans, budget, foodCount, false, state.entities)
    );

    // Server check (mutating — run after UI)
    const steps = resolvePlans(state, moves, []);
    const serverKeys = extractServerFoodKeys(steps);
    const allHeroEvents = steps.flatMap(s => s.heroEvents);

    // Totals
    assert.equal(uiKeys.length, foodCount, `UI should tag ${foodCount} food-powered actions`);
    assert.equal(serverKeys.length, foodCount, `Server should emit ${foodCount} FOOD_CONSUMED`);
    assert.ok(allHeroEvents.some(e => e.type === ResEventType.BUDGET_CAP),
      'last action should hit BUDGET_CAP');

    // Per-action parity
    assert.deepStrictEqual(serverKeys, uiKeys,
      'Server and UI must agree on which (entityId, stepIdx) pairs are food-powered');
  });

  test('multi-unit: food falls on the correct entity and step index', () => {
    const state = freshState();
    const hero = state.hero;

    // Place a survivor adjacent to the hero
    const survSpot = emptyPassableNeighbor(state, hero.col, hero.row, new Set());
    if (!survSpot) return;

    const survivor = createSurvivor(survSpot.col, survSpot.row);
    survivor.owner = 'hero';
    state.entities.push(survivor);

    const heroTarget = getReachableHexes(state, hero, 1)[0];
    const survTarget = emptyPassableNeighbor(state, survSpot.col, survSpot.row,
      new Set([hexKey(hero.col, hero.row)]));
    if (!heroTarget || !survTarget) return;

    // Budget includes the survivor as an extra.
    const budget = heroBudget(state);
    const foodCount = 1;
    state.inventory.hero[ResourceType.FOOD] = foodCount;

    // Each unit gets slightly more than half the budget worth of moves.
    // Interleave order: hero[0], surv[0], hero[1], surv[1], ...
    // The (budget+1)th non-free action triggers the food-powered step.
    const movesPerUnit = Math.ceil(budget / 2) + 1;
    const heroMoves = pingPongMoves(hero.id,
      { col: hero.col, row: hero.row }, heroTarget, movesPerUnit);
    const survMoves = pingPongMoves(survivor.id,
      { col: survSpot.col, row: survSpot.row }, survTarget, movesPerUnit);

    const unitPlans = new Map();
    unitPlans.set(hero.id, heroMoves);
    unitPlans.set(survivor.id, survMoves);

    const totalActions = heroMoves.length + survMoves.length;
    assert.ok(totalActions > budget, 'plan must exceed budget for food test');

    // UI check (non-mutating)
    const uiKeys = extractUIFoodKeys(
      buildUnitPlanBlocksHtml(unitPlans, budget, foodCount, false, state.entities)
    );

    // Server check — build flat plan in the same interleaved order
    const flatPlan = [];
    const queues = [...unitPlans.values()];
    let step = 0;
    while (true) {
      let any = false;
      for (const q of queues) {
        if (step < q.length) { flatPlan.push(q[step]); any = true; }
      }
      if (!any) break;
      step++;
    }

    const steps = resolvePlans(state, flatPlan, []);
    const serverKeys = extractServerFoodKeys(steps);

    // Totals
    assert.equal(uiKeys.length, foodCount, `UI should tag ${foodCount} food-powered action`);
    assert.equal(serverKeys.length, foodCount, `Server should emit ${foodCount} FOOD_CONSUMED`);

    // Per-action parity — the critical assertion
    assert.deepStrictEqual(serverKeys, uiKeys,
      'Server and UI must agree on which (entityId, stepIdx) pairs are food-powered');
  });

  test('no food: all over-budget actions are over-budget, not food-powered', () => {
    const state = freshState();
    const hero = state.hero;

    const reachable = getReachableHexes(state, hero, 1);
    if (!reachable.length) return;

    const posA = { col: hero.col, row: hero.row };
    const posB = reachable[0];
    const budget = heroBudget(state);
    state.inventory.hero[ResourceType.FOOD] = 0;

    const moves = pingPongMoves(hero.id, posA, posB, budget + 2);
    const unitPlans = groupPlanByEntity(moves);

    // UI: no food-powered, only over-budget
    const html = buildUnitPlanBlocksHtml(unitPlans, budget, 0, false, state.entities);
    assert.ok(!html.includes('food-powered'), 'no actions should be food-powered without food');
    assert.ok(html.includes('over-budget'), 'over-budget actions should exist');

    // Server: BUDGET_CAP, no FOOD_CONSUMED
    const steps = resolvePlans(state, moves, []);
    const allHeroEvents = steps.flatMap(s => s.heroEvents);
    assert.ok(!allHeroEvents.some(e => e.type === ResEventType.FOOD_CONSUMED),
      'no FOOD_CONSUMED without food');
    assert.ok(allHeroEvents.some(e => e.type === ResEventType.BUDGET_CAP),
      'BUDGET_CAP should fire');
  });
});
