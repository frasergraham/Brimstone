// Tests for the attack-highlight system:
// - getValidActions returns BATTLE targets with col/row (needed for red highlights)
// - Multiple BATTLE_UNIT steps in a plan resolve correctly (natural stacking)
// - Both MOVE and BATTLE valid simultaneously (green+red highlights at once)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase, Player } from '../src/game.js';
import { getValidActions, ActionType } from '../src/actions.js';
import { createMinion, EntityType } from '../src/entities.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { PlanActionType } from '../src/planner.js';

function freshState() {
  return new GameState(true, true);
}

// Find a passable neighbor with no entity on it
function emptyPassableNeighbor(state, entity) {
  return getNeighbors(entity.col, entity.row).find(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!t || t.type === 'river') return false;
    return !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
  }) ?? null;
}

// ── BATTLE targets include col/row ─────────────────────────────────────────────
// The red-highlight system reads target.col / target.row from BATTLE action targets.
// Verify getValidActions provides these fields so _updateHighlights can map them.

describe('BATTLE targets expose col and row for highlight rendering', () => {
  test('adjacent enemy produces BATTLE target with col and row', () => {
    const state = freshState();
    const hero  = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);

    // Place hero and witch adjacent to each other
    hero.col = 3; hero.row = 3;
    witch.col = 4; witch.row = 3;

    const actions = getValidActions(state, hero);
    const battle  = actions.find(a => a.type === ActionType.BATTLE);
    assert.ok(battle, 'BATTLE action should exist');
    assert.ok(battle.targets.length > 0, 'should have at least one target');
    for (const t of battle.targets) {
      assert.ok(typeof t.col === 'number', `target.col must be a number (got ${t.col})`);
      assert.ok(typeof t.row === 'number', `target.row must be a number (got ${t.row})`);
    }
  });

  test('BATTLE targets include same-hex enemies', () => {
    const state = freshState();
    const hero  = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);

    hero.col = 5; hero.row = 5;
    witch.col = 5; witch.row = 5;  // same hex

    const actions = getValidActions(state, hero);
    const battle  = actions.find(a => a.type === ActionType.BATTLE);
    assert.ok(battle, 'BATTLE action should exist for same-hex enemy');
    const target = battle.targets.find(t => t.col === 5 && t.row === 5);
    assert.ok(target, 'target at same hex should appear in BATTLE targets');
  });

  test('no BATTLE action when no enemies in range', () => {
    const state = freshState();
    const hero  = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);

    // Put hero at 0,0 and witch far away
    hero.col  = 0; hero.row  = 0;
    witch.col = 10; witch.row = 10;

    // Remove any minions that might be adjacent
    state.entities = state.entities.filter(
      e => e.owner !== 'witch' || e.type === EntityType.WITCH
    );

    const actions = getValidActions(state, hero);
    const battle  = actions.find(a => a.type === ActionType.BATTLE);
    assert.ok(!battle, 'should have no BATTLE action when no enemies adjacent');
  });
});

// ── Both MOVE and BATTLE valid simultaneously ──────────────────────────────────
// The new _updateHighlights shows both green (move) and red (battle) highlights at
// once. Verify getValidActions can return both in a single call.

describe('getValidActions returns both MOVE and BATTLE simultaneously', () => {
  test('hero adjacent to enemy has both move and battle actions', () => {
    const state = freshState();
    const hero  = state.hero;
    const witch = state.entities.find(e => e.type === EntityType.WITCH);

    hero.col  = 3; hero.row  = 3;
    witch.col = 4; witch.row = 3;

    const actions = getValidActions(state, hero);
    const hasBattle = actions.some(a => a.type === ActionType.BATTLE);
    const hasMove   = actions.some(a => a.type === ActionType.MOVE);
    assert.ok(hasBattle, 'should have BATTLE action');
    assert.ok(hasMove,   'should have MOVE action simultaneously');
  });
});

// ── Multiple BATTLE_UNIT steps in a plan resolve correctly ─────────────────────
// After the UX change, stacking attacks is done by clicking the red hex multiple
// times. Each click adds a BATTLE_UNIT step. The resolver must handle multiple
// BATTLE_UNIT steps against the same target in a single plan.

describe('multiple BATTLE_UNIT steps in a plan (natural stacking)', () => {
  test('two BATTLE_UNIT steps resolve without throwing', () => {
    const state = freshState();
    const hero  = state.hero;

    // Place a fresh minion adjacent to the hero
    const minion = createMinion();
    const adj    = emptyPassableNeighbor(state, hero);
    assert.ok(adj, 'need an adjacent passable hex for the minion');
    minion.col = adj.col;
    minion.row = adj.row;
    state.entities.push(minion);

    const heroPlan = [
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id },
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id },
    ];

    // Should not throw
    let steps;
    assert.doesNotThrow(() => {
      steps = resolvePlans(state, heroPlan, []);
    });
    assert.ok(Array.isArray(steps), 'resolvePlans should return an array');
  });

  test('first BATTLE_UNIT step produces action_ok or action_fail, never undefined', () => {
    const state = freshState();
    const hero  = state.hero;

    const minion = createMinion();
    const adj    = emptyPassableNeighbor(state, hero);
    assert.ok(adj, 'need adjacent passable hex');
    minion.col = adj.col;
    minion.row = adj.row;
    state.entities.push(minion);

    const heroPlan = [
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id },
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id },
    ];

    const steps = resolvePlans(state, heroPlan, []);
    assert.ok(steps.length >= 1, 'should have at least one step');

    // First step's hero events should contain a valid event type
    const firstHeroEvents = steps[0].heroEvents;
    assert.ok(firstHeroEvents.length > 0, 'first step should have hero events');
    const validTypes = Object.values(ResEventType);
    for (const ev of firstHeroEvents) {
      assert.ok(validTypes.includes(ev.type), `unexpected event type: ${ev.type}`);
    }
  });

  test('second BATTLE_UNIT step is action_skip when target dies on first hit', () => {
    const state = freshState();
    const hero  = state.hero;

    // Give hero max attack so it always crushes
    hero.attack = 20;

    const minion = createMinion();
    minion.hp = 1; // guaranteed to die on first hit
    const adj = emptyPassableNeighbor(state, hero);
    assert.ok(adj, 'need adjacent passable hex');
    minion.col = adj.col;
    minion.row = adj.row;
    state.entities.push(minion);

    const heroPlan = [
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id },
      { type: PlanActionType.BATTLE_UNIT, entityId: hero.id, targetId: minion.id },
    ];

    const steps = resolvePlans(state, heroPlan, []);

    // Collect all hero event types across all steps
    const allHeroEventTypes = steps.flatMap(s => s.heroEvents.map(e => e.type));

    // There must be an action_ok (first hit) and an action_skip (second hit, target dead)
    // or budget_cap if only 1 action budget (but hero has 3+ base budget).
    assert.ok(
      allHeroEventTypes.includes(ResEventType.ACTION_OK),
      'should have at least one action_ok (first attack lands)',
    );
    // After minion dies, second attempt should be skipped
    const hasSkipOrCap = allHeroEventTypes.includes(ResEventType.ACTION_SKIP) ||
                         allHeroEventTypes.includes(ResEventType.BUDGET_CAP);
    assert.ok(hasSkipOrCap, 'second attack on dead target should produce action_skip or budget_cap');
  });
});
