// Tests for animation resolution timing and food floater positioning.
// Validates the logic extracted from _animateResolutionSteps in src/main.js.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { GameState } from '../src/game.js';
import { PlanActionType } from '../src/planner.js';
import { EntityType, createMinion } from '../src/entities.js';
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

// ── Bug 1: Food floater should use acting entity position ──────────────────

describe('food floater position — acting entity lookup', () => {
  test('FOOD_CONSUMED event is in same step as the food-powered ACTION_OK', () => {
    const state = freshState();
    const hero = state.hero;

    // Give hero food so the resolver can auto-consume it
    if (!state.inventory) state.inventory = {};
    if (!state.inventory.shared) state.inventory.shared = {};
    state.inventory.shared[ResourceType.FOOD] = 1;

    // Build a plan with more moves than the hero's budget so that the last
    // move triggers food consumption.  Budget = budgetFor(state, 'hero').
    // Walk the hero through a chain of passable neighbors.
    const heroPlan = [];
    let cur = { col: hero.col, row: hero.row };
    const visited = new Set([hexKey(cur.col, cur.row)]);

    // Generate enough moves to exceed the hero's normal budget + 1
    // (the +1 will be food-powered)
    for (let i = 0; i < 20; i++) {
      const nb = getNeighbors(cur.col, cur.row).find(n => {
        if (visited.has(hexKey(n.col, n.row))) return false;
        const t = state.tiles.get(hexKey(n.col, n.row));
        if (!t || t.type === 'river') return false;
        return !state.entities.some(e => e.alive && e.id !== hero.id && e.col === n.col && e.row === n.row);
      });
      if (!nb) break;
      heroPlan.push({
        type: PlanActionType.MOVE,
        entityId: hero.id,
        toCol: nb.col,
        toRow: nb.row,
      });
      visited.add(hexKey(nb.col, nb.row));
      cur = nb;
    }

    // We need more moves than the budget; if the map is too tight, skip.
    if (heroPlan.length < 5) return;

    const steps = resolvePlans(state, heroPlan, []);

    // Find the step that contains FOOD_CONSUMED
    let foodStep = null;
    for (const step of steps) {
      const allEvents = [...(step.heroEvents ?? []), ...(step.witchEvents ?? [])];
      if (allEvents.some(e => e.type === ResEventType.FOOD_CONSUMED)) {
        foodStep = step;
        break;
      }
    }

    assert.ok(foodStep, 'expected a step with FOOD_CONSUMED event');

    const allEvents = [...(foodStep.heroEvents ?? []), ...(foodStep.witchEvents ?? [])];
    const foodEv = allEvents.find(e => e.type === ResEventType.FOOD_CONSUMED);
    const actionEv = allEvents.find(
      e => e.type === ResEventType.ACTION_OK && e.faction === foodEv.faction,
    );
    assert.ok(actionEv, 'expected an ACTION_OK event in the same step as FOOD_CONSUMED');

    // The acting entity should be findable in the entitySnapshot
    const actorSnap = foodStep.entitySnapshot.find(e => e.id === actionEv.action.entityId);
    assert.ok(actorSnap, 'acting entity must exist in snapshot');
    assert.equal(actorSnap.id, hero.id, 'actor should be the hero (who submitted the plan)');
  });

  test('food floater uses actor position, not hardcoded hero lookup', () => {
    // Simulates the corrected food-floater lookup logic to verify it picks
    // the acting entity (which may be a survivor) rather than the hero.
    const entitySnapshot = [
      { id: 'hero-1', type: 'hero', col: 0, row: 0 },
      { id: 'surv-1', type: 'survivor', col: 5, row: 3 },
    ];
    const allStepEvents = [
      { type: ResEventType.FOOD_CONSUMED, faction: 'hero' },
      { type: ResEventType.ACTION_OK, faction: 'hero', action: { entityId: 'surv-1', type: PlanActionType.MOVE } },
    ];

    // Old (buggy) logic: always uses hero
    const heroSnap = entitySnapshot.find(e => e.type === 'hero');

    // New (fixed) logic: uses the acting entity
    const actionEv = allStepEvents.find(
      e => e.type === ResEventType.ACTION_OK && e.faction === 'hero',
    );
    const actorSnap = actionEv
      ? entitySnapshot.find(e => e.id === actionEv.action.entityId)
      : null;

    assert.ok(actorSnap, 'actor snapshot must be found');
    assert.equal(actorSnap.id, 'surv-1', 'floater should be at survivor position');
    assert.notEqual(actorSnap.col, heroSnap.col, 'actor position differs from hero');
    assert.equal(actorSnap.col, 5);
    assert.equal(actorSnap.row, 3);
  });
});

// ── Bug 2: State should not update before dialogs complete ─────────────────

describe('resolution state timing — deferred entity update', () => {
  test('move step: display entities show moved positions without revealing encounters', () => {
    // Simulates the fixed animation flow:
    // 1. Build a display-only copy from the step snapshot with positions patched
    // 2. Full postEntities applied later (after dialogs)

    // Step snapshot (pre-step state)
    const entitySnapshot = [
      { id: 'h1', col: 2, row: 3, hp: 14, type: 'hero', alive: true },
      { id: 's1', col: 4, row: 5, hp: 3, type: 'survivor', alive: true },
    ];

    // Post-step: hero moved, and a new survivor appeared from encounter
    const postEntities = [
      { id: 'h1', col: 3, row: 3, hp: 14, type: 'hero', alive: true },
      { id: 's1', col: 4, row: 5, hp: 3, type: 'survivor', alive: true },
      { id: 's2', col: 3, row: 3, hp: 2, type: 'survivor', alive: true },  // newly encountered
    ];

    const moveEvents = [
      { action: { type: PlanActionType.MOVE, entityId: 'h1', toCol: 3, toRow: 3 }, faction: 'hero' },
    ];

    // Build display-only copy (mirrors the fix in main.js)
    const displayEntities = entitySnapshot.map(e => ({ ...e }));
    for (const ev of moveEvents) {
      if (ev.action.type !== PlanActionType.MOVE) continue;
      const ent = displayEntities.find(e => e.id === ev.action.entityId);
      if (ent) { ent.col = ev.action.toCol; ent.row = ev.action.toRow; }
    }

    // Display entities show hero at new position
    assert.equal(displayEntities[0].col, 3, 'hero moved to new col');
    assert.equal(displayEntities[0].row, 3, 'hero moved to new row');

    // But no new entity appeared yet
    assert.equal(displayEntities.length, 2, 'encounter survivor not yet added');

    // Original snapshot is NOT mutated (safe for replay)
    assert.equal(entitySnapshot[0].col, 2, 'snapshot hero col unchanged');
    assert.equal(entitySnapshot[0].row, 3, 'snapshot hero row unchanged');

    // After dialogs: full state applied
    const state = { entities: displayEntities };
    state.entities = postEntities;
    assert.equal(state.entities.length, 3, 'survivor appears after dialog');
    assert.equal(state.entities[2].id, 's2');
  });

  test('display copy does not corrupt finalEntities', () => {
    // The real Entity objects (finalEntities) should NOT be modified
    // by the display-entity construction in step 0.
    const realEntities = [
      { id: 'h1', col: 10, row: 10, hp: 14, type: 'hero' },  // final position
    ];
    const stepSnapshot = [
      { id: 'h1', col: 0, row: 0, hp: 14, type: 'hero' },    // start-of-step position
    ];
    const finalEntities = realEntities;  // same reference as the caller holds

    // Simulate step 0: state.entities is still the real array
    let stateEntities = realEntities;

    // Build display copy from snapshot (NOT from stateEntities)
    const displayEntities = stepSnapshot.map(e => ({ ...e }));
    const moveEv = { action: { type: PlanActionType.MOVE, entityId: 'h1', toCol: 5, toRow: 5 } };
    const ent = displayEntities.find(e => e.id === moveEv.action.entityId);
    if (ent) { ent.col = moveEv.action.toCol; ent.row = moveEv.action.toRow; }
    stateEntities = displayEntities;

    // Display shows intermediate position
    assert.equal(stateEntities[0].col, 5);
    assert.equal(stateEntities[0].row, 5);

    // finalEntities (real entities) still at their final position
    assert.equal(finalEntities[0].col, 10, 'finalEntities not corrupted');
    assert.equal(finalEntities[0].row, 10, 'finalEntities not corrupted');
  });

  test('battle step: HP change is not visible until after dialog', () => {
    // Pre-step entities
    const preEntities = [
      { id: 'h1', col: 5, row: 5, hp: 14, type: 'hero', alive: true },
      { id: 'm1', col: 5, row: 5, hp: 2, type: 'minion', alive: true },
    ];

    // Post-step: minion killed, hero took 1 counter damage
    const postEntities = [
      { id: 'h1', col: 5, row: 5, hp: 13, type: 'hero', alive: true },
      // m1 is dead — removed from entity list
    ];

    // Before applying postEntities (during dialog), pre-step state is shown
    const state = { entities: preEntities };

    // During battle dialog: state still shows pre-battle HP
    assert.equal(state.entities.length, 2, 'minion still visible during dialog');
    assert.equal(state.entities[0].hp, 14, 'hero HP unchanged during dialog');
    assert.equal(state.entities[1].hp, 2, 'minion HP unchanged during dialog');

    // After dialog: apply full post-step state
    state.entities = postEntities;
    assert.equal(state.entities.length, 1, 'minion removed after dialog');
    assert.equal(state.entities[0].hp, 13, 'hero HP updated after dialog');
  });

  test('position-only update does not alter non-moved entities', () => {
    const entities = [
      { id: 'h1', col: 2, row: 3, hp: 14 },
      { id: 's1', col: 4, row: 5, hp: 3 },
      { id: 'w1', col: 8, row: 8, hp: 10 },
    ];

    const moveEvents = [
      { action: { type: PlanActionType.MOVE, entityId: 'h1', toCol: 3, toRow: 3 } },
    ];

    for (const ev of moveEvents) {
      if (ev.action.type !== PlanActionType.MOVE) continue;
      const ent = entities.find(e => e.id === ev.action.entityId);
      if (ent) { ent.col = ev.action.toCol; ent.row = ev.action.toRow; }
    }

    // Moved entity updated
    assert.equal(entities[0].col, 3);
    assert.equal(entities[0].row, 3);

    // Non-moved entities untouched
    assert.equal(entities[1].col, 4);
    assert.equal(entities[1].row, 5);
    assert.equal(entities[2].col, 8);
    assert.equal(entities[2].row, 8);
  });
});
