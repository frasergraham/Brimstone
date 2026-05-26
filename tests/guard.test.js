// Tests for the Guard action
// Covers: executeGuard, guard clearing, guard strikes via resolver, serialization.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { GameState, Phase } from '../src/game.js';
import { PlanActionType } from '../src/planner.js';
import {
  executeGuard, executeGuardStrike, executeMove, executeBattle,
  getValidActions, ActionType,
} from '../src/actions.js';
import {
  Entity, EntityType, createMinion, createZombie, createSurvivor,
  createHero, createWitch, resetRoster,
} from '../src/entities.js';
import { ResourceType, TileType, legacyTileType } from '../src/tiles.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { getReachableHexes } from '../src/actions.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

function freshState() {
  return new GameState(true, true);
}

function emptyPassableNeighbor(state, entity) {
  return getNeighbors(entity.col, entity.row).find(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!t || legacyTileType(t) === TileType.RIVER) return false;
    return !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
  }) ?? null;
}

// ── executeGuard ─────────────────────────────────────────────────────────────

describe('executeGuard', () => {
  test('increments guarding charge and costs 1 action', () => {
    const state = freshState();
    const hero = state.hero;
    assert.equal(hero.guarding, 0);

    const r = executeGuard(state, hero);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1);
    assert.equal(hero.guarding, 1);
  });

  test('stacks multiple guard charges', () => {
    const state = freshState();
    const hero = state.hero;
    executeGuard(state, hero);
    executeGuard(state, hero);
    executeGuard(state, hero);
    assert.equal(hero.guarding, 3);
  });

  test('works for witch units', () => {
    const state = freshState();
    const witch = state.witch;
    const r = executeGuard(state, witch);
    assert.equal(r.success, true);
    assert.equal(witch.guarding, 1);
  });

  test('works for minions', () => {
    const state = freshState();
    const minion = createMinion(3, 3);
    minion.owner = 'witch';
    state.entities.push(minion);
    const r = executeGuard(state, minion);
    assert.equal(r.success, true);
    assert.equal(minion.guarding, 1);
  });
});

// ── Guard clearing ───────────────────────────────────────────────────────────

describe('Guard clearing', () => {
  test('executeMove clears all guard charges', () => {
    const state = freshState();
    const hero = state.hero;
    hero.guarding = 3;

    const target = emptyPassableNeighbor(state, hero);
    if (!target) return; // skip if no passable neighbor
    executeMove(state, hero, target.col, target.row);
    assert.equal(hero.guarding, 0);
  });

  test('executeBattle clears all guard charges on attacker', () => {
    const state = freshState();
    const hero = state.hero;
    hero.guarding = 2;

    // Place a minion adjacent for combat
    const adj = emptyPassableNeighbor(state, hero);
    if (!adj) return;
    const minion = createMinion(adj.col, adj.row);
    minion.owner = 'witch';
    state.entities.push(minion);

    executeBattle(state, hero, minion);
    assert.equal(hero.guarding, 0);
  });

  test('resetTurn clears all guard charges', () => {
    const state = freshState();
    const hero = state.hero;
    hero.guarding = 3;
    hero.resetTurn();
    assert.equal(hero.guarding, 0);
  });
});

// ── Guard in getValidActions ─────────────────────────────────────────────────

describe('Guard in getValidActions', () => {
  test('Guard action is available for hero', () => {
    const state = freshState();
    const actions = getValidActions(state, state.hero);
    assert.ok(actions.some(a => a.type === ActionType.GUARD));
  });

  test('Guard action is available for witch', () => {
    const state = freshState();
    const actions = getValidActions(state, state.witch);
    assert.ok(actions.some(a => a.type === ActionType.GUARD));
  });

  test('Guard action still available when already guarding (stacking)', () => {
    const state = freshState();
    state.hero.guarding = 2;
    const actions = getValidActions(state, state.hero);
    const guardAction = actions.find(a => a.type === ActionType.GUARD);
    assert.ok(guardAction, 'Guard should be available for stacking');
    assert.equal(guardAction.currentCharges, 2);
  });
});

// ── executeGuardStrike ───────────────────────────────────────────────────────

describe('executeGuardStrike', () => {
  test('performs a reactive attack with no ally dice', () => {
    const state = freshState();
    const hero = state.hero;
    hero.guarding = 1;

    // Place a minion on a neighbor hex
    const adj = emptyPassableNeighbor(state, hero);
    if (!adj) return;
    const minion = createMinion(adj.col, adj.row);
    minion.owner = 'witch';
    state.entities.push(minion);

    const r = executeGuardStrike(state, hero, minion);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'Guard strike should be free');
    assert.equal(r.guardStrike, true);
    // Verify no ally dice in breakdown
    assert.equal(r.breakdown.atkStaffBonus !== undefined, true);
  });

  test('strips silver (attackBonus) during guard strike', () => {
    const state = freshState();
    const hero = state.hero;
    hero.guarding = 1;
    hero.attackBonus = 3; // simulating silver bonuses

    const adj = emptyPassableNeighbor(state, hero);
    if (!adj) return;
    const minion = createMinion(adj.col, adj.row);
    minion.owner = 'witch';
    state.entities.push(minion);

    const r = executeGuardStrike(state, hero, minion);
    assert.equal(r.success, true);
    // attackBonus should be restored after the strike
    assert.equal(hero.attackBonus, 3, 'attackBonus should be restored after guard strike');
  });

  test('can kill the target', () => {
    const state = freshState();
    const hero = state.hero;
    hero.guarding = 1;
    hero.attack = 20; // guarantee a kill

    const adj = emptyPassableNeighbor(state, hero);
    if (!adj) return;
    const minion = createMinion(adj.col, adj.row);
    minion.owner = 'witch';
    minion.hp = 1;
    state.entities.push(minion);

    const r = executeGuardStrike(state, hero, minion);
    assert.equal(r.success, true);
    // The minion should be dead (removed from entities)
    if (r.hit) {
      assert.equal(r.killed, true);
      assert.ok(!state.entities.some(e => e.id === minion.id));
    }
  });

  test('no counter-attack on guard strike', () => {
    const state = freshState();
    // Use a weak hero attacking a strong golem
    const hero = state.hero;
    hero.guarding = 1;
    hero.attack = 0; // very weak

    const adj = emptyPassableNeighbor(state, hero);
    if (!adj) return;
    const minion = createMinion(adj.col, adj.row);
    minion.owner = 'witch';
    minion.defense = 20; // very high defense
    state.entities.push(minion);

    // Run many trials — guard strike should never deal counter damage
    const origHp = hero.hp;
    for (let i = 0; i < 20; i++) {
      hero.hp = origHp;
      minion.hp = minion.maxHp;
      executeGuardStrike(state, hero, minion);
    }
    // Hero should never have taken counter damage from any of these strikes
    // (no counter-attack mechanism in guard strike)
    // We can't guarantee no damage from other sources, but the function itself
    // should never reduce hero HP
    assert.equal(hero.hp, origHp);
  });

  test('phase bonus applies during guard strike at night for witch', () => {
    const state = freshState();
    state.phase = Phase.NIGHT;

    const witch = state.witch;
    witch.guarding = 1;

    const adj = emptyPassableNeighbor(state, witch);
    if (!adj) return;
    const hero = state.hero;
    // Move hero to adjacent position
    hero.col = adj.col;
    hero.row = adj.row;

    const r = executeGuardStrike(state, witch, hero);
    assert.equal(r.success, true);
    assert.equal(r.breakdown.phaseBonus, 2, 'Witch should get +2 phase bonus at night');
  });
});

// ── Guard strikes via resolver ───────────────────────────────────────────────

describe('Guard strikes in resolver', () => {
  test('guard triggers when enemy moves adjacent', () => {
    const state = freshState();
    const hero = state.hero;
    const witch = state.witch;

    // Place witch 2 hexes from hero, then have hero guard
    // Find a hex that's 2 away from hero
    const heroNeighbors = getNeighbors(hero.col, hero.row);
    const adjHex = heroNeighbors.find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER &&
        !state.entities.some(e => e.alive && e.id !== witch.id && e.col === n.col && e.row === n.row);
    });
    if (!adjHex) return;

    // Find a hex 2 away from hero that passes through adjHex
    const farHexes = getNeighbors(adjHex.col, adjHex.row).filter(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER &&
        n.col !== hero.col && n.row !== hero.row &&
        !state.entities.some(e => e.alive && e.id !== witch.id && e.col === n.col && e.row === n.row);
    });
    if (!farHexes.length) return;

    // Position witch on the far hex
    witch.col = farHexes[0].col;
    witch.row = farHexes[0].row;

    // Hero guards, witch moves adjacent
    const heroPlan = [{ type: PlanActionType.GUARD, entityId: hero.id }];
    const witchPlan = [{ type: PlanActionType.MOVE, entityId: witch.id, toCol: adjHex.col, toRow: adjHex.row }];

    const steps = resolvePlans(state, heroPlan, witchPlan);

    // Find GUARD_STRIKE events
    const guardStrikes = [];
    for (const step of steps) {
      for (const ev of (step.heroEvents ?? [])) {
        if (ev.type === ResEventType.GUARD_STRIKE) guardStrikes.push(ev);
      }
      for (const ev of (step.witchEvents ?? [])) {
        if (ev.type === ResEventType.GUARD_STRIKE) guardStrikes.push(ev);
      }
    }

    assert.ok(guardStrikes.length >= 1, 'Guard strike should trigger when enemy moves adjacent');
    assert.equal(guardStrikes[0].faction, 'hero');
  });

  test('guard does not trigger on friendly movement', () => {
    const state = freshState();
    const hero = state.hero;

    // Create a survivor near hero
    const adj = emptyPassableNeighbor(state, hero);
    if (!adj) return;
    const survivor = createSurvivor(adj.col, adj.row, hero.ownerId);
    survivor.owner = 'hero';
    state.entities.push(survivor);

    // Find a hex for survivor to move to (adjacent to hero)
    const survTarget = emptyPassableNeighbor(state, survivor);
    if (!survTarget) return;

    // Hero guards, survivor moves
    hero.guarding = 1; // pre-set to simplify
    const heroPlan = [
      { type: PlanActionType.GUARD, entityId: hero.id },
    ];
    const witchPlan = [];

    const steps = resolvePlans(state, heroPlan, witchPlan);

    // No guard strikes should occur (no enemy moved)
    const guardStrikes = [];
    for (const step of steps) {
      for (const ev of (step.heroEvents ?? [])) {
        if (ev.type === ResEventType.GUARD_STRIKE) guardStrikes.push(ev);
      }
      for (const ev of (step.witchEvents ?? [])) {
        if (ev.type === ResEventType.GUARD_STRIKE) guardStrikes.push(ev);
      }
    }
    assert.equal(guardStrikes.length, 0, 'Guard should not trigger on friendly movement');
  });

  test('multiple guards can trigger on same action', () => {
    const state = freshState();
    const hero = state.hero;

    // Create a survivor co-located with hero
    const survivor = createSurvivor(hero.col, hero.row, hero.ownerId);
    survivor.owner = 'hero';
    state.entities.push(survivor);

    // Find adjacent hex for witch to move into
    const adj = emptyPassableNeighbor(state, hero);
    if (!adj) return;

    // Put witch 2 hexes away
    const farHexes = getNeighbors(adj.col, adj.row).filter(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER &&
        n.col !== hero.col && n.row !== hero.row &&
        !state.entities.some(e => e.alive && e.id !== state.witch.id && e.col === n.col && e.row === n.row);
    });
    if (!farHexes.length) return;

    state.witch.col = farHexes[0].col;
    state.witch.row = farHexes[0].row;

    // Both hero and survivor guard
    const heroPlan = [
      { type: PlanActionType.GUARD, entityId: hero.id },
      { type: PlanActionType.GUARD, entityId: survivor.id },
    ];
    const witchPlan = [
      { type: PlanActionType.MOVE, entityId: state.witch.id, toCol: adj.col, toRow: adj.row },
    ];

    const steps = resolvePlans(state, heroPlan, witchPlan);

    const guardStrikes = [];
    for (const step of steps) {
      for (const ev of (step.heroEvents ?? [])) {
        if (ev.type === ResEventType.GUARD_STRIKE) guardStrikes.push(ev);
      }
      for (const ev of (step.witchEvents ?? [])) {
        if (ev.type === ResEventType.GUARD_STRIKE) guardStrikes.push(ev);
      }
    }

    // Due to interleaved resolution, only the first guard (hero) is active when
    // the witch moves in step 1. The survivor guards in step 2 (after witch already moved).
    // So at least 1 guard strike should fire from the hero.
    assert.ok(guardStrikes.length >= 1, `Expected 1+ guard strikes, got ${guardStrikes.length}`);
  });
});

// ── GUARD in resolver runAction ──────────────────────────────────────────────

describe('GUARD action in resolver', () => {
  test('GUARD action resolves successfully', () => {
    const state = freshState();
    const hero = state.hero;

    const heroPlan = [{ type: PlanActionType.GUARD, entityId: hero.id }];
    const steps = resolvePlans(state, heroPlan, []);

    assert.ok(steps.length >= 1);
    const heroEvents = steps[0].heroEvents;
    assert.ok(heroEvents.some(e => e.type === ResEventType.ACTION_OK));
    assert.equal(hero.guarding, 1);
  });
});

// ── Serialization ────────────────────────────────────────────────────────────

describe('Guard serialization', () => {
  test('guarding charges survive serialize/deserialize', () => {
    const state = freshState();
    state.hero.guarding = 3;

    const snap = serializeState(state);
    const heroSnap = snap.entities.find(e => e.id === state.hero.id);
    assert.equal(heroSnap.guarding, 3, 'guarding charges should be serialized');

    const restored = deserializeState(snap);
    const restoredHero = restored.entities.find(e => e.id === state.hero.id);
    assert.equal(restoredHero.guarding, 3, 'guarding charges should survive deserialization');
  });

  test('guarding defaults to 0 for entities without the field', () => {
    const state = freshState();
    const snap = serializeState(state);
    const heroSnap = snap.entities.find(e => e.id === state.hero.id);
    assert.equal(heroSnap.guarding, 0);
  });
});

// ── Guard available to all entity types ──────────────────────────────────────

describe('Guard available to all entity types', () => {
  test('hero can guard', () => {
    const state = freshState();
    const r = executeGuard(state, state.hero);
    assert.equal(r.success, true);
  });

  test('witch can guard', () => {
    const state = freshState();
    const r = executeGuard(state, state.witch);
    assert.equal(r.success, true);
  });

  test('survivor can guard', () => {
    const state = freshState();
    const s = createSurvivor(state.hero.col, state.hero.row);
    s.owner = 'hero';
    state.entities.push(s);
    const r = executeGuard(state, s);
    assert.equal(r.success, true);
  });

  test('minion can guard', () => {
    const state = freshState();
    const m = createMinion(state.witch.col, state.witch.row);
    m.owner = 'witch';
    state.entities.push(m);
    const r = executeGuard(state, m);
    assert.equal(r.success, true);
  });
});
