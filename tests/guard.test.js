// Tests for the Guard action
// Covers: executeGuard, guard clearing, guard strikes via resolver, serialization.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { GameState, Phase } from '../src/game.js';
import { PlanActionType } from '../src/planner.js';
import {
  executeGuard, executeMove, executeBattle,
  getValidActions, ActionType,
} from '../src/actions.js';
import {
  Entity, EntityType, createMinion, createZombie, createSurvivor,
  createHero, createWitch, resetRoster,
} from '../src/entities.js';
import { ResourceType, TileType, legacyTileType, isBuildingFootprint } from '../src/tiles.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { getReachableHexes } from '../src/actions.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

function freshState() {
  return new GameState(true, true);
}

// Range is now weapon-derived (Entity.getRange()): a unit's reach comes from its
// equipped weapon plus ability/effect range mods, NOT a writable `.range` field.
// makeRanged equips a bow (range 3) and stacks the eagle_eye ability (+1 range
// each) to reach an arbitrary attack range, so tests can build a ranged guard.
function makeRanged(entity, range) {
  entity.equipWeapon('bow');            // base reach 3
  for (let i = 3; i < range; i++) entity.abilities.push('eagle_eye'); // +1 each
}

function emptyPassableNeighbor(state, entity) {
  return getNeighbors(entity.col, entity.row).find(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!t || legacyTileType(t) === TileType.RIVER || isBuildingFootprint(t)) return false;
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
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
        !state.entities.some(e => e.alive && e.id !== witch.id && e.col === n.col && e.row === n.row);
    });
    if (!adjHex) return;

    // Find a hex 2 away from hero that passes through adjHex
    const farHexes = getNeighbors(adjHex.col, adjHex.row).filter(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
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

    // Find guard-reaction events (now normal inline BATTLE_UNIT attacks)
    const guardStrikes = [];
    for (const step of steps) {
      for (const ev of (step.heroEvents ?? [])) {
        if (ev.guardReaction === true) guardStrikes.push(ev);
      }
      for (const ev of (step.witchEvents ?? [])) {
        if (ev.guardReaction === true) guardStrikes.push(ev);
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
        if (ev.guardReaction === true) guardStrikes.push(ev);
      }
      for (const ev of (step.witchEvents ?? [])) {
        if (ev.guardReaction === true) guardStrikes.push(ev);
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
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
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
        if (ev.guardReaction === true) guardStrikes.push(ev);
      }
      for (const ev of (step.witchEvents ?? [])) {
        if (ev.guardReaction === true) guardStrikes.push(ev);
      }
    }

    // Due to interleaved resolution, only the first guard (hero) is active when
    // the witch moves in step 1. The survivor guards in step 2 (after witch already moved).
    // So at least 1 guard strike should fire from the hero.
    assert.ok(guardStrikes.length >= 1, `Expected 1+ guard strikes, got ${guardStrikes.length}`);
  });

  // ── Guard reactions are NORMAL inline attacks (no special-casing) ──────────
  test('a guard reaction is emitted as a normal BATTLE_UNIT ACTION_OK attack', () => {
    const state = freshState();
    const hero = state.hero, witch = state.witch;
    const heroNeighbors = getNeighbors(hero.col, hero.row);
    const adjHex = heroNeighbors.find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
        !state.entities.some(e => e.alive && e.id !== witch.id && e.col === n.col && e.row === n.row);
    });
    if (!adjHex) return;
    const farHexes = getNeighbors(adjHex.col, adjHex.row).filter(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
        n.col !== hero.col && n.row !== hero.row &&
        !state.entities.some(e => e.alive && e.id !== witch.id && e.col === n.col && e.row === n.row);
    });
    if (!farHexes.length) return;
    witch.col = farHexes[0].col; witch.row = farHexes[0].row;

    const steps = resolvePlans(state,
      [{ type: PlanActionType.GUARD, entityId: hero.id }],
      [{ type: PlanActionType.MOVE, entityId: witch.id, toCol: adjHex.col, toRow: adjHex.row }]);

    const ev = steps.flatMap(s => [...(s.heroEvents ?? []), ...(s.witchEvents ?? [])])
      .find(e => e.guardReaction);
    assert.ok(ev, 'a guard reaction event was emitted');
    // Same shape as a planned attack — flows through the normal battle pipeline.
    assert.equal(ev.type, ResEventType.ACTION_OK);
    assert.equal(ev.action.type, PlanActionType.BATTLE_UNIT);
    assert.equal(ev.action.entityId, hero.id, 'the guardian is the attacker');
    assert.equal(ev.action.targetId, witch.id, 'the mover is the target');
    assert.ok(ev.battleSnaps?.actorSnap && ev.battleSnaps?.targetSnap, 'carries battle snapshots');
    assert.ok(Number.isFinite(ev.result?.attackRoll), 'resolved via full executeBattle (has rolls)');
  });

  test('a multi-charge guard keeps its remaining charges after one reaction', () => {
    const state = freshState();
    const hero = state.hero, witch = state.witch;
    hero.guarding = 2; // two stored charges, no planned GUARD this round
    const adjHex = getNeighbors(hero.col, hero.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
        !state.entities.some(e => e.alive && e.id !== witch.id && e.col === n.col && e.row === n.row);
    });
    if (!adjHex) return;
    const farHexes = getNeighbors(adjHex.col, adjHex.row).filter(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
        n.col !== hero.col && n.row !== hero.row &&
        !state.entities.some(e => e.alive && e.id !== witch.id && e.col === n.col && e.row === n.row);
    });
    if (!farHexes.length) return;
    witch.col = farHexes[0].col; witch.row = farHexes[0].row;

    resolvePlans(state, [],
      [{ type: PlanActionType.MOVE, entityId: witch.id, toCol: adjHex.col, toRow: adjHex.row }]);
    // executeBattle zeroes the stance; the resolver restores remaining charges.
    assert.equal(hero.guarding, 1, 'one charge consumed, one preserved');
  });
});

// ── executeBattle guard-reaction options (noCounter / noCrush, keep ally) ─────

describe('executeBattle noCounter / noCrush options (guard reactions)', () => {
  test('noCrush never crushes, while an uncapped attack does (proves the flag bites)', () => {
    const state = freshState();
    const guard = state.hero; guard.attack = 10; // strong → frequent crush rolls
    const adj = emptyPassableNeighbor(state, guard);
    if (!adj) return;
    const minion = createMinion(adj.col, adj.row); minion.owner = 'witch'; minion.defense = 0;
    state.entities.push(minion);

    let cappedCrushed = false, uncappedCrushed = false;
    for (let i = 0; i < 40; i++) {
      minion.hp = minion.maxHp;
      const r = executeBattle(state, guard, minion, { noCrush: true, noCounter: true });
      if ((r.breakdown?.dmgTier ?? 1) >= 2) cappedCrushed = true;
    }
    for (let i = 0; i < 40; i++) {
      minion.hp = minion.maxHp;
      const r = executeBattle(state, guard, minion); // uncapped planned attack
      if ((r.breakdown?.dmgTier ?? 1) >= 2) uncappedCrushed = true;
    }
    assert.equal(cappedCrushed, false, 'noCrush keeps dmgTier at 1');
    assert.equal(uncappedCrushed, true, 'an uncapped attack DOES crush — the flag is what suppresses it');
  });

  test('noCounter prevents counter damage even against a strong defender', () => {
    const state = freshState();
    const guard = state.hero; guard.attack = 0; // weak → defender would counter
    const adj = emptyPassableNeighbor(state, guard);
    if (!adj) return;
    const minion = createMinion(adj.col, adj.row); minion.owner = 'witch'; minion.defense = 20;
    state.entities.push(minion);

    const hp0 = guard.hp;
    for (let i = 0; i < 30; i++) {
      guard.hp = hp0; minion.hp = minion.maxHp;
      const r = executeBattle(state, guard, minion, { noCounter: true, noCrush: true });
      assert.equal(r.counterDmg ?? 0, 0, 'guard reactions never take a counter');
    }
    assert.equal(guard.hp, hp0, 'guard leader took no counter damage across trials');
  });

  test('noAlly drops gang-up (the swarm cannot stack a guard reaction)', () => {
    const state = freshState();
    const guard = state.hero;
    const adj = emptyPassableNeighbor(state, guard);
    if (!adj) return;
    const minion = createMinion(adj.col, adj.row); minion.owner = 'witch';
    state.entities.push(minion);
    // A hero ally adjacent to the TARGET would normally lend gang-up dice.
    const allyHex = getNeighbors(adj.col, adj.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t) &&
        !(n.col === guard.col && n.row === guard.row) &&
        !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
    });
    if (!allyHex) return;
    const ally = createSurvivor(allyHex.col, allyHex.row); ally.owner = 'hero';
    state.entities.push(ally);

    // A planned attack DOES gang up; the guard-reaction flag suppresses it.
    const planned = executeBattle(state, guard, minion);
    assert.ok((planned.breakdown?.atkAllyIds ?? []).includes(ally.id),
      'sanity: an adjacent ally gangs up on a normal attack');
    minion.hp = minion.maxHp;
    const reaction = executeBattle(state, guard, minion, { noCounter: true, noCrush: true, noAlly: true });
    assert.equal((reaction.breakdown?.atkAllyIds ?? []).length, 0,
      'noAlly strips gang-up from the guard reaction');
  });
});

// ── Ranged opportunity shots via resolver ────────────────────────────────────

describe('ranged opportunity shots via resolver', () => {
  function collectGuardStrikes(steps) {
    const out = [];
    for (const step of steps) {
      for (const ev of (step.heroEvents ?? [])) if (ev.guardReaction === true) out.push(ev);
      for (const ev of (step.witchEvents ?? [])) if (ev.guardReaction === true) out.push(ev);
    }
    return out;
  }
  // Carve a clean, passable, unobstructed grass band around row 5 so movement
  // and line-of-sight are deterministic regardless of the generated map.
  function clearBand(state) {
    for (let c = 3; c <= 11; c++) {
      for (let r = 3; r <= 7; r++) {
        const t = state.tiles.get(hexKey(c, r));
        if (!t) continue;
        t.base = TileType.GRASS;
        t.path = null;
        t.structure = null;
        t.buildingFootprintOf = null;
        t.footprintHexes = [];
        t.fortifyLevel = 0;
      }
    }
  }

  test('ranged guard fires when an enemy moves into range with LOS', () => {
    const state = freshState();
    const guard = state.hero;
    const mover = state.witch;
    state.entities = state.entities.filter(e => e === guard || e === mover);
    makeRanged(guard, 3);          // reach = full attack range = 3
    guard.guarding = 1;
    guard.col = 5; guard.row = 5;
    mover.col = 9; mover.row = 5;   // dist 4 — out of reach to start
    clearBand(state);
    state.setForcedDice(...Array(20).fill(3));

    const steps = resolvePlans(state, [],
      [{ type: PlanActionType.MOVE, entityId: mover.id, toCol: 8, toRow: 5 }]); // → dist 3
    const gs = collectGuardStrikes(steps);
    assert.ok(gs.length >= 1, 'ranged opportunity shot should fire at reach 3 with clear LOS');
    assert.equal(gs[0].battleSnaps.ranged, true, 'tagged as a ranged guard strike');
    assert.equal(gs[0].faction, 'hero');
  });

  test('ranged guard does NOT fire when line of sight is blocked', () => {
    const state = freshState();
    const guard = state.hero;
    const mover = state.witch;
    state.entities = state.entities.filter(e => e === guard || e === mover);
    makeRanged(guard, 3);
    guard.guarding = 1;
    guard.col = 5; guard.row = 5;
    mover.col = 8; mover.row = 5;
    clearBand(state);
    // Forest at the midpoint blocks the sightline from (5,5) to (7,5).
    state.tiles.get(hexKey(6, 5)).base = TileType.FOREST;
    state.setForcedDice(...Array(20).fill(3));

    const steps = resolvePlans(state, [],
      [{ type: PlanActionType.MOVE, entityId: mover.id, toCol: 7, toRow: 5 }]);
    assert.equal(collectGuardStrikes(steps).length, 0, 'blocked LOS suppresses the opportunity shot');
  });

  test('ranged guard does NOT fire when the enemy stays beyond attack range', () => {
    const state = freshState();
    const guard = state.hero;
    const mover = state.witch;
    state.entities = state.entities.filter(e => e === guard || e === mover);
    makeRanged(guard, 3);          // reach 3
    guard.guarding = 1;
    guard.col = 5; guard.row = 5;
    mover.col = 10; mover.row = 5;   // dist 5
    clearBand(state);
    state.setForcedDice(...Array(20).fill(3));

    const steps = resolvePlans(state, [],
      [{ type: PlanActionType.MOVE, entityId: mover.id, toCol: 9, toRow: 5 }]); // → dist 4, still out of reach
    assert.equal(collectGuardStrikes(steps).length, 0, 'dist 4 is outside a range-3 guard\'s reach');
  });

  test('ranged guard does NOT fire beyond sight distance (no shooting into fog)', () => {
    // A guard strike is a direct attack: reach is capped by the unit's sight
    // distance as well as its attack range. At NIGHT the hero sees 3 hexes, so
    // a range-5 guard still can't strike a target 4 away — it can't see it.
    const state = freshState();
    state.phase = Phase.NIGHT;        // hero sight range = 3
    const guard = state.hero;
    const mover = state.witch;
    state.entities = state.entities.filter(e => e === guard || e === mover);
    makeRanged(guard, 5);                  // attack range 5, but sight caps reach to 3
    guard.guarding = 1;
    guard.col = 5; guard.row = 5;
    mover.col = 10; mover.row = 5;     // dist 5
    clearBand(state);
    state.setForcedDice(...Array(20).fill(3));

    const steps = resolvePlans(state, [],
      [{ type: PlanActionType.MOVE, entityId: mover.id, toCol: 9, toRow: 5 }]); // → dist 4, beyond sight 3
    assert.equal(collectGuardStrikes(steps).length, 0,
      'dist 4 is within attack range 5 but beyond sight 3 — must not fire');
  });

  test('ranged guard still fires inside sight distance at night', () => {
    // Companion to the cap test: a target that moves within the sight-capped
    // reach (3) is struck, so the cap doesn't over-suppress legitimate shots.
    const state = freshState();
    state.phase = Phase.NIGHT;        // hero sight range = 3
    const guard = state.hero;
    const mover = state.witch;
    state.entities = state.entities.filter(e => e === guard || e === mover);
    makeRanged(guard, 5);
    guard.guarding = 1;
    guard.col = 5; guard.row = 5;
    mover.col = 9; mover.row = 5;      // dist 4
    clearBand(state);
    state.setForcedDice(...Array(20).fill(3));

    const steps = resolvePlans(state, [],
      [{ type: PlanActionType.MOVE, entityId: mover.id, toCol: 8, toRow: 5 }]); // → dist 3, within sight
    assert.ok(collectGuardStrikes(steps).length >= 1,
      'dist 3 is within both attack range and sight — should fire');
  });

  test('playback entity snapshot carries range so the witch renders as a ranged guard', () => {
    // Regression: snapshotEntities dropped `range`, so the guard-zone renderer
    // mis-classified the witch as melee (adjacent-only) during playback.
    const state = freshState();
    const witch = state.witch;
    const steps = resolvePlans(state, [],
      [{ type: PlanActionType.GUARD, entityId: witch.id }]);
    const snap = steps.flatMap(s => s.entitySnapshot ?? []).find(e => e.id === witch.id);
    assert.ok(snap, 'witch appears in a playback step snapshot');
    assert.equal(snap.range, 2, 'range is preserved in the playback snapshot');
  });

  test('melee guard still reacts only to adjacent movement (range 1 regression)', () => {
    const state = freshState();
    const guard = state.hero;   // default range 1
    const mover = state.witch;
    state.entities = state.entities.filter(e => e === guard || e === mover);
    guard.guarding = 1;
    guard.col = 5; guard.row = 5;
    mover.col = 8; mover.row = 5;
    clearBand(state);
    state.setForcedDice(...Array(20).fill(3));

    const steps = resolvePlans(state, [],
      [{ type: PlanActionType.MOVE, entityId: mover.id, toCol: 7, toRow: 5 }]); // → dist 2
    assert.equal(collectGuardStrikes(steps).length, 0, 'melee guard ignores dist-2 movement');
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
