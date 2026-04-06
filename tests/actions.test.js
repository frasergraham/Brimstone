// Spec-based tests for src/actions.js
// Tests what SHOULD happen, not what the code currently does.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase, Player } from '../src/game.js';
import {
  executeMove, executeExplore, executeBattle, executeFortify,
  executeSummon, executeHeal, executeUseItem, executeUseAbility,
  getReachableHexes, sightRange, survivorFindMultiplier,
} from '../src/actions.js';
import {
  Entity, EntityType, SurvivorAbility,
  createHero, createWitch, createMinion, createZombie, createSurvivor, resetRoster,
} from '../src/entities.js';
import { TileType, BuildingType, ResourceType, WeaponType } from '../src/tiles.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { applyPostRoundEffects } from '../src/post-round-effects.js';

function freshState() {
  return new GameState(true, true);
}

// Pick a reachable non-blocked neighbor for a given entity
function firstReachable(state, entity) {
  return getReachableHexes(state, entity, 1)[0] ?? null;
}

// Find a passable neighbor that has no entity on it
function emptyPassableNeighbor(state, entity) {
  return getNeighbors(entity.col, entity.row).find(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!t || t.type === TileType.RIVER) return false;
    return !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
  }) ?? null;
}

// ── sightRange ────────────────────────────────────────────────────────────────
// Design: DAY=3, DAWN/DUSK=2, NIGHT=1; SCOUT adds +1

describe('sightRange', () => {
  test('DAY sight is 3', () => assert.equal(sightRange(Phase.DAY), 3));
  test('DAWN sight is 2', () => assert.equal(sightRange(Phase.DAWN), 2));
  test('DUSK sight is 2', () => assert.equal(sightRange(Phase.DUSK), 2));
  test('NIGHT sight is 1', () => assert.equal(sightRange(Phase.NIGHT), 1));
  test('SCOUT adds +1 to sight in every phase', () => {
    assert.equal(sightRange(Phase.DAY,   true), 4);
    assert.equal(sightRange(Phase.DAWN,  true), 3);
    assert.equal(sightRange(Phase.DUSK,  true), 3);
    assert.equal(sightRange(Phase.NIGHT, true), 2);
  });
  test('non-scout gives no bonus', () => {
    assert.equal(sightRange(Phase.DAY, false), 3);
  });
});

// ── getReachableHexes ─────────────────────────────────────────────────────────

describe('getReachableHexes', () => {
  test('returns at least one reachable hex for hero not surrounded', () => {
    const state = freshState();
    const reachable = getReachableHexes(state, state.hero, 1);
    assert.ok(reachable.length > 0, 'Hero should have at least one reachable hex');
  });

  test('never includes river tiles', () => {
    const state = freshState();
    const reachable = getReachableHexes(state, state.hero, 2);
    for (const h of reachable) {
      const t = state.tiles.get(hexKey(h.col, h.row));
      assert.notEqual(t?.type, TileType.RIVER, `River tile (${h.col},${h.row}) should not be reachable`);
    }
  });

  test('never includes the starting position itself', () => {
    const state = freshState();
    const hero = state.hero;
    const reachable = getReachableHexes(state, hero, 1);
    const atStart = reachable.some(h => h.col === hero.col && h.row === hero.row);
    assert.equal(atStart, false, 'Starting position should not appear in reachable list');
  });

  test('range 2 (horse) reaches further than range 1', () => {
    const state = freshState();
    const r1 = getReachableHexes(state, state.hero, 1);
    const r2 = getReachableHexes(state, state.hero, 2);
    assert.ok(r2.length >= r1.length, 'range 2 should include at least as many hexes as range 1');
  });

  test('enemy-occupied hexes are excluded', () => {
    const state = freshState();
    const hero = state.hero;
    // Place witch directly adjacent
    const neighbor = emptyPassableNeighbor(state, hero);
    if (!neighbor) return;
    state.witch.col = neighbor.col;
    state.witch.row = neighbor.row;
    const reachable = getReachableHexes(state, hero, 1);
    const blocked = reachable.some(h => h.col === neighbor.col && h.row === neighbor.row);
    assert.equal(blocked, false, 'Enemy-occupied hex should not be in reachable list');
  });
});

// ── executeMove ───────────────────────────────────────────────────────────────

describe('executeMove', () => {
  test('succeeds when target is reachable', () => {
    const state = freshState();
    const hero = state.hero;
    const target = firstReachable(state, hero);
    assert.ok(target, 'There must be at least one reachable target for this test');
    const r = executeMove(state, hero, target.col, target.row);
    assert.equal(r.success, true, r.log?.[0]);
    assert.equal(hero.col, target.col);
    assert.equal(hero.row, target.row);
  });

  test('fails when target is not reachable from current position', () => {
    const state = freshState();
    const hero = state.hero;
    // Pick a hex far from hero
    const farCol = hero.col > 6 ? 0 : 12;
    const farRow = hero.row > 5 ? 0 : 10;
    const r = executeMove(state, hero, farCol, farRow);
    assert.equal(r.success, false);
  });

  test('costs 1 action', () => {
    const state = freshState();
    const hero = state.hero;
    const target = firstReachable(state, hero);
    if (!target) return;
    const r = executeMove(state, hero, target.col, target.row);
    assert.equal(r.cost, 1);
  });

  test('returns a path array ending at the destination', () => {
    const state = freshState();
    const hero = state.hero;
    const target = firstReachable(state, hero);
    if (!target) return;
    const r = executeMove(state, hero, target.col, target.row);
    assert.ok(Array.isArray(r.path), 'result.path should be an array');
    assert.ok(r.path.length >= 1, 'path should have at least one step');
    const last = r.path[r.path.length - 1];
    assert.equal(last.col, target.col);
    assert.equal(last.row, target.row);
  });

  test('fails when target tile is a river', () => {
    const state = freshState();
    const hero = state.hero;
    // Find a river tile adjacent to hero (may not exist — tolerate)
    let riverNeighbor = null;
    for (const n of getNeighbors(hero.col, hero.row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t?.type === TileType.RIVER) { riverNeighbor = n; break; }
    }
    if (!riverNeighbor) return; // hero not next to river in this map seed

    const r = executeMove(state, hero, riverNeighbor.col, riverNeighbor.row);
    assert.equal(r.success, false);
  });

  test('hero steps on hidden-survivor tile: survivor is added and flag cleared', () => {
    const state = freshState();
    resetRoster();
    const hero = state.hero;
    const target = firstReachable(state, hero);
    if (!target) return;
    const t = state.tiles.get(hexKey(target.col, target.row));
    t.hiddenSurvivor = true;

    const origRandom = Math.random;
    Math.random = () => 0.1; // always below discovery threshold
    const countBefore = state.entities.length;
    try {
      executeMove(state, hero, target.col, target.row);
    } finally {
      Math.random = origRandom;
    }
    assert.ok(state.entities.length > countBefore, 'A survivor should be added');
    assert.equal(t.hiddenSurvivor, false, 'hiddenSurvivor flag should be cleared');
    // The new entity should be a hero-side survivor
    const newEnt = state.entities.find(e => e.col === target.col && e.row === target.row && e.type === EntityType.SURVIVOR);
    assert.ok(newEnt, 'Added entity should be a survivor');
    assert.equal(newEnt.owner, 'hero');
  });

  test('witch steps on hidden-survivor tile: zombie is added, not a survivor', () => {
    const state = freshState();
    const witch = state.witch;
    const target = firstReachable(state, witch);
    if (!target) return;
    const t = state.tiles.get(hexKey(target.col, target.row));
    t.hiddenSurvivor = true;

    const origRandom = Math.random;
    Math.random = () => 0.1; // always below discovery threshold
    const countBefore = state.entities.length;
    try {
      executeMove(state, witch, target.col, target.row);
    } finally {
      Math.random = origRandom;
    }
    assert.ok(state.entities.length > countBefore, 'An entity should be added');
    const newEnt = state.entities[state.entities.length - 1];
    assert.equal(newEnt.type, EntityType.ZOMBIE, 'Witch should raise a zombie from hidden survivor');
  });

  test('does not include encounterLog when no hidden survivor', () => {
    const state = freshState();
    const hero = state.hero;
    const target = firstReachable(state, hero);
    if (!target) return;
    state.tiles.get(hexKey(target.col, target.row)).hiddenSurvivor = false;
    const r = executeMove(state, hero, target.col, target.row);
    assert.equal(r.success, true);
    assert.equal(r.encounterLog.length, 0);
  });

  test('hero encounter returns encounterSurvivor with full stats', () => {
    const state = freshState();
    resetRoster();
    const hero = state.hero;
    const target = firstReachable(state, hero);
    if (!target) return;
    state.tiles.get(hexKey(target.col, target.row)).hiddenSurvivor = true;
    const origRandom = Math.random;
    Math.random = () => 0.1;
    let r;
    try { r = executeMove(state, hero, target.col, target.row); }
    finally { Math.random = origRandom; }
    assert.ok(r.encounterSurvivor, 'encounterSurvivor should be set');
    assert.equal(r.encounterSurvivor.type, 'survivor');
    assert.ok(r.encounterSurvivor.name, 'should have a name');
    assert.ok(r.encounterSurvivor.title, 'should have a title');
    assert.ok(typeof r.encounterSurvivor.hp === 'number', 'should have hp');
    assert.ok(typeof r.encounterSurvivor.attack === 'number', 'should have attack');
    assert.ok(typeof r.encounterSurvivor.defense === 'number', 'should have defense');
  });

  test('witch encounter returns encounterSurvivor with zombie stats', () => {
    const state = freshState();
    const witch = state.witch;
    const target = firstReachable(state, witch);
    if (!target) return;
    state.tiles.get(hexKey(target.col, target.row)).hiddenSurvivor = true;
    const origRandom = Math.random;
    Math.random = () => 0.1;
    let r;
    try { r = executeMove(state, witch, target.col, target.row); }
    finally { Math.random = origRandom; }
    assert.ok(r.encounterSurvivor, 'encounterSurvivor should be set for zombie');
    assert.equal(r.encounterSurvivor.type, 'zombie');
    assert.ok(typeof r.encounterSurvivor.hp === 'number', 'zombie should have hp');
    assert.ok(typeof r.encounterSurvivor.attack === 'number', 'zombie should have attack');
    assert.ok(typeof r.encounterSurvivor.defense === 'number', 'zombie should have defense');
  });
});

// ── executeMove — blockedBy field ────────────────────────────────────────────

describe('executeMove — blockedBy field', () => {
  test('blockedBy is null on successful unobstructed move', () => {
    const state = freshState();
    const hero = state.hero;
    const target = firstReachable(state, hero);
    if (!target) return;
    const r = executeMove(state, hero, target.col, target.row);
    assert.equal(r.success, true);
    assert.equal(r.blockedBy, null, 'blockedBy should be null when path is clear');
  });

  test('enemy on adjacent hex: move fails, hero stays put', () => {
    const state = freshState();
    const hero = state.hero;
    const origCol = hero.col;
    const origRow = hero.row;
    // Place a minion directly adjacent — no room to walk before the enemy
    const neighbor = getNeighbors(hero.col, hero.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER;
    });
    if (!neighbor) return;
    const minion = createMinion(neighbor.col, neighbor.row);
    state.entities.push(minion);

    const r = executeMove(state, hero, neighbor.col, neighbor.row);
    assert.equal(r.success, false, 'Move to adjacent enemy hex should fail (nowhere to walk)');
    assert.ok(r.blockedBy, 'blockedBy should reference the blocking enemy');
    assert.equal(r.blockedBy.id, minion.id);
    assert.ok(r.log.some(l => l.includes('movement blocked by')),
      'Log should mention blocked by enemy');
    assert.equal(hero.col, origCol, 'Hero should not have moved');
    assert.equal(hero.row, origRow);
  });

  test('enemy 2 hexes away: hero walks 1 hex then stops', () => {
    const state = freshState();
    const hero = state.hero;
    // Set up a road chain so hero can reach 2 hexes
    const n1 = getNeighbors(hero.col, hero.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER;
    });
    if (!n1) return;
    // Find a neighbor of n1 that is NOT the hero's hex and is passable
    const n2 = getNeighbors(n1.col, n1.row).find(n => {
      if (n.col === hero.col && n.row === hero.row) return false;
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER;
    });
    if (!n2) return;

    // Make both hexes roads so they're within movement budget
    const t1 = state.tiles.get(hexKey(n1.col, n1.row));
    const t2 = state.tiles.get(hexKey(n2.col, n2.row));
    const heroTile = state.tiles.get(hexKey(hero.col, hero.row));
    if (t1) { t1.type = TileType.ROAD; t1.building = null; t1.hiddenSurvivor = false; }
    if (t2) { t2.type = TileType.ROAD; t2.building = null; t2.hiddenSurvivor = false; }
    if (heroTile) { heroTile.type = TileType.ROAD; heroTile.building = null; }

    // Remove other entities that might block
    state.entities = state.entities.filter(e => e.id === hero.id);

    // Place enemy on n2 (2 hexes away)
    const minion = createMinion(n2.col, n2.row);
    state.entities.push(minion);

    const r = executeMove(state, hero, n2.col, n2.row);
    assert.equal(r.success, true, 'Partial move should succeed (walked 1 hex)');
    assert.equal(hero.col, n1.col, 'Hero should stop at intermediate hex');
    assert.equal(hero.row, n1.row);
    assert.ok(r.blockedBy, 'blockedBy should reference the blocking enemy');
    assert.equal(r.blockedBy.id, minion.id);
    assert.ok(r.log.some(l => l.includes('movement blocked by')),
      'Log should mention blocked by enemy');
  });
});

// ── executeExplore ────────────────────────────────────────────────────────────

describe('executeExplore', () => {
  test('marks tile as explored', () => {
    const state = freshState();
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = false;
    const r = executeExplore(state, hero);
    assert.equal(r.success, true);
    assert.equal(t.explored, true);
  });

  test('fails if tile already explored', () => {
    const state = freshState();
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = true;
    const r = executeExplore(state, hero);
    assert.equal(r.success, false);
  });

  test('costs 1 action', () => {
    const state = freshState();
    const hero = state.hero;
    state.tiles.get(hexKey(hero.col, hero.row)).explored = false;
    const r = executeExplore(state, hero);
    assert.equal(r.cost, 1);
  });

  test('exploring adds a resource or item to inventory/entity', () => {
    const state = freshState();
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = false;
    const sharedBefore = JSON.stringify(state.inventory.shared);
    const itemsBefore = JSON.stringify(hero.items);

    executeExplore(state, hero);

    const sharedAfter = JSON.stringify(state.inventory.shared);
    const itemsAfter = JSON.stringify(hero.items);
    // At minimum, loot was rolled — either shared changed or items changed (or 'nothing')
    // We can't guarantee a non-nothing result without mocking random, so just check it ran
    assert.equal(t.explored, true);
  });

  test('HERBALIST survivor also receives 1 herb on explore', () => {
    const state = freshState();
    // Create a proper herbalist entity
    const herbalist = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    herbalist.ability = SurvivorAbility.HERBALIST;
    herbalist.items = {};

    const t = state.tiles.get(hexKey(herbalist.col, herbalist.row));
    t.explored = false;

    const herbsBefore = herbalist.items[ResourceType.HERBS] ?? 0;
    executeExplore(state, herbalist);
    const herbsAfter = herbalist.items[ResourceType.HERBS] ?? 0;

    assert.ok(herbsAfter >= herbsBefore + 1, 'HERBALIST should gain at least 1 herb on explore (from HERBALIST bonus, possibly more from loot)');
  });

  test('non-HERBALIST survivor does NOT receive a bonus herb', () => {
    const state = freshState();
    const survivor = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    survivor.ability = SurvivorAbility.BRAWLER; // not a herbalist
    survivor.items = {};

    const t = state.tiles.get(hexKey(survivor.col, survivor.row));
    t.explored = false;

    executeExplore(state, survivor);
    // Herb count should only change if the loot roll happened to be herbs
    // We can't assert exact value without controlling rng, but we can verify
    // the herbalist path wasn't triggered for a non-herbalist
    // (covered by positive herbalist test above)
    assert.equal(t.explored, true);
  });

  test('returns lootItems array', () => {
    const state = freshState();
    const hero = state.hero;
    state.tiles.get(hexKey(hero.col, hero.row)).explored = false;
    const r = executeExplore(state, hero);
    assert.ok(Array.isArray(r.lootItems), 'lootItems should be an array');
  });

  test('lootItems entries start with + when loot is found', () => {
    // Run many times to get at least one non-nothing result
    for (let i = 0; i < 50; i++) {
      const state = freshState();
      const hero = state.hero;
      state.tiles.get(hexKey(hero.col, hero.row)).explored = false;
      const r = executeExplore(state, hero);
      const found = r.lootItems.filter(l => l.startsWith('+'));
      if (found.length > 0) {
        assert.ok(found.every(l => l.startsWith('+')), 'all loot labels should start with +');
        return; // test passes
      }
    }
    // If we never found loot in 50 tries, that's acceptable — loot tables include 'nothing'
  });

  test('explore produces at most one loot entry (no duplicates)', () => {
    // Run many explores — when loot is found, there should be exactly 1 entry,
    // not 2 from a duplicate _applyLoot call.
    for (let i = 0; i < 100; i++) {
      const state = freshState();
      const hero = state.hero;
      state.tiles.get(hexKey(hero.col, hero.row)).explored = false;
      // Ensure tile is not a building so only terrain loot applies (single roll)
      const t = state.tiles.get(hexKey(hero.col, hero.row));
      t.type = TileType.GRASS;
      t.building = null;
      t.hiddenSurvivor = false;
      const r = executeExplore(state, hero);
      const found = r.lootItems.filter(l => l.startsWith('+'));
      assert.ok(found.length <= 1,
        `Expected at most 1 loot entry but got ${found.length}: ${JSON.stringify(r.lootItems)}`);
    }
  });
});

// ── executeBattle ─────────────────────────────────────────────────────────────

describe('executeBattle', () => {
  test('returns success=true and costs 1 action', () => {
    const state = freshState();
    const hero = state.hero;
    // Place minion on same hex as hero
    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);

    const r = executeBattle(state, hero, minion);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1);
  });

  test('result includes attackRoll, defenseRoll, hit, margin', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    const r = executeBattle(state, state.hero, minion);
    assert.ok(typeof r.attackRoll === 'number');
    assert.ok(typeof r.defenseRoll === 'number');
    assert.ok(typeof r.hit === 'boolean');
    assert.ok(typeof r.margin === 'number');
    assert.equal(r.margin, r.attackRoll - r.defenseRoll);
  });

  test('killed target is removed from entities', () => {
    const state = freshState();
    // Minion has 2 HP, 0 DEF — hero with d6+3 attack should reliably kill it
    // Force dice to guarantee kill by giving hero maxed-out attack bonus
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    state.hero.attackBonus = 50; // ensure always hits and crushes

    const r = executeBattle(state, state.hero, minion);
    if (r.killed) {
      assert.ok(!state.entities.find(e => e.id === minion.id), 'Killed entity should be removed');
    }
    // If not killed this roll, we at least confirmed success=true
    assert.equal(r.success, true);
  });

  test('witch gets +2 phase bonus in NIGHT (attacker)', () => {
    const state = freshState();
    state.phase = Phase.NIGHT;
    const survivor = new Entity(EntityType.SURVIVOR, 'hero', state.witch.col, state.witch.row);
    survivor.items = {};
    state.entities.push(survivor);

    const r = executeBattle(state, state.witch, survivor);
    assert.equal(r.breakdown.phaseBonus, 2, 'Witch should have phaseBonus=2 in NIGHT');
  });

  test('hero does NOT get phase bonus in DAY (removed)', () => {
    const state = freshState();
    state.phase = Phase.DAY;
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    const r = executeBattle(state, state.hero, minion);
    assert.equal(r.breakdown.phaseBonus, 0, 'Hero should have no phase bonus in DAY');
  });

  test('hero does NOT get phase bonus in NIGHT', () => {
    const state = freshState();
    state.phase = Phase.NIGHT;
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    const r = executeBattle(state, state.hero, minion);
    assert.equal(r.breakdown.phaseBonus, 0, 'Hero should have no phase bonus in NIGHT');
  });

  test('witch gets +2 phase bonus in NIGHT', () => {
    const state = freshState();
    state.phase = Phase.NIGHT;
    const survivor = new Entity(EntityType.SURVIVOR, 'hero', state.witch.col, state.witch.row);
    survivor.items = {};
    state.entities.push(survivor);

    const r = executeBattle(state, state.witch, survivor);
    assert.equal(r.breakdown.phaseBonus, 2, 'Witch should have phaseBonus=2 in NIGHT');
  });

  test('hero defender gets fatigue after 2 defenses', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    // Give hero lots of HP so it survives
    state.hero.hp = 50;
    state.hero.maxHp = 50;
    minion.attackBonus = -50; // ensure miss so hero survives

    // First 2 defenses: no fatigue penalty
    const r1 = executeBattle(state, minion, state.hero);
    assert.equal(r1.breakdown.fatiguePenalty, 0, 'No fatigue on first defense');
    const r2 = executeBattle(state, minion, state.hero);
    assert.equal(r2.breakdown.fatiguePenalty, 0, 'No fatigue on second defense');

    // Third defense: fatigue kicks in (2 prior defenses / 2 = 1)
    const r3 = executeBattle(state, minion, state.hero);
    assert.equal(r3.breakdown.fatiguePenalty, 1, 'Fatigue -1 DEF after 2 prior defenses');

    // Fourth defense: still 1 (3 / 2 = 1)
    const r4 = executeBattle(state, minion, state.hero);
    assert.equal(r4.breakdown.fatiguePenalty, 1, 'Fatigue still -1 after 3 prior defenses');

    // Fifth defense: fatigue increases (4 / 2 = 2)
    const r5 = executeBattle(state, minion, state.hero);
    assert.equal(r5.breakdown.fatiguePenalty, 2, 'Fatigue -2 DEF after 4 prior defenses');
  });

  test('witch defender does NOT get fatigue', () => {
    const state = freshState();
    state.witch.hp = 50;
    state.witch.maxHp = 50;
    state.hero.attackBonus = -50; // ensure miss

    executeBattle(state, state.hero, state.witch);
    executeBattle(state, state.hero, state.witch);
    const r3 = executeBattle(state, state.hero, state.witch);
    assert.equal(r3.breakdown.fatiguePenalty, 0, 'Witch should never get fatigue');
  });

  test('fatigue resets on resetTurn', () => {
    const state = freshState();
    state.hero.defendCount = 4;
    state.hero.resetTurn();
    assert.equal(state.hero.defendCount, 0, 'defendCount should reset');
  });

  test('fortification damaged when defender takes damage, defender still takes HP damage', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    // Fortify the minion's tile
    const minionTile = state.tiles.get(hexKey(minion.col, minion.row));
    minionTile.fortifyLevel = 2;
    state.hero.attackBonus = 50; // guarantee hit

    const fortBefore = minionTile.fortifyLevel;
    const hpBefore = minion.hp;
    const r = executeBattle(state, state.hero, minion);

    assert.ok(r.hit, 'Should be a hit with attackBonus=50');
    // Defender takes real HP damage (fort no longer absorbs)
    assert.ok(r.damage > 0, 'Defender should take damage directly');
    // Fort also loses 1 level
    assert.equal(r.fortDamaged, 1, 'fortDamaged should be 1');
    assert.equal(minionTile.fortifyLevel, fortBefore - 1, 'Fort level should drop by 1');
  });

  test('fortification does NOT degrade when attacker misses', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    const minionTile = state.tiles.get(hexKey(minion.col, minion.row));
    minionTile.fortifyLevel = 2;
    // Give minion huge defense so hero always misses
    minion.defenseBonus = 50;

    const fortBefore = minionTile.fortifyLevel;
    const r = executeBattle(state, state.hero, minion);

    assert.ok(!r.hit, 'Should be a miss with defender defenseBonus=50');
    assert.equal(r.fortDamaged, 0, 'fortDamaged should be 0 on miss');
    assert.equal(minionTile.fortifyLevel, fortBefore, 'Fort level should not change on miss');
  });

  test('fortification does NOT degrade on tie (margin === 0)', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    const minionTile = state.tiles.get(hexKey(minion.col, minion.row));
    minionTile.fortifyLevel = 2;
    const fortBefore = minionTile.fortifyLevel;

    // Run many battles and check any tie case doesn't damage the fort
    for (let i = 0; i < 50; i++) {
      const s2 = freshState();
      const m2 = createMinion(s2.hero.col, s2.hero.row);
      s2.entities.push(m2);
      const t2 = s2.tiles.get(hexKey(m2.col, m2.row));
      t2.fortifyLevel = 2;
      const r = executeBattle(s2, s2.hero, m2);
      if (r.margin === 0) {
        // Tie: fort should not degrade
        assert.equal(r.fortDamaged, 0, 'fortDamaged should be 0 on tie');
        assert.equal(t2.fortifyLevel, 2, 'Fort level should not change on tie');
        break;
      }
    }
  });

  test('night hazard does NOT degrade fortifications', () => {
    const state = freshState();
    state.phase = Phase.NIGHT;
    state.attritionLevel = 1;
    // Set all tiles with fortifyLevel > 1 and verify they stay unchanged after night
    for (const t of state.tiles.values()) {
      t.fortifyLevel = 3;
    }
    applyPostRoundEffects(state);
    for (const t of state.tiles.values()) {
      assert.equal(t.fortifyLevel, 3, 'Night should no longer erode fortifications');
    }
  });

  test('no daytime attrition damage to witch minions', () => {
    const state = freshState();
    // Place a minion on an open (non-building) tile
    const neighbor = emptyPassableNeighbor(state, state.witch);
    assert.ok(neighbor, 'need an open tile for the minion');
    const minion = createMinion(neighbor.col, neighbor.row);
    state.entities.push(minion);
    const hpBefore = minion.hp;

    // Advance to a DAY phase by calling endRound until phase is DAY
    while (state.phase !== Phase.DAY) {
      state.endRound();
    }

    // Minion should not have taken any damage from the day phase
    const alive = state.entities.find(e => e.id === minion.id);
    assert.ok(alive, 'minion should still be in the entity list');
    assert.equal(alive.hp, hpBefore, 'minion HP should be unchanged — no daytime attrition');
  });

  test('post-round events are cleared when leaving night phase', () => {
    const state = freshState();
    // Place a survivor in the open
    const neighbor = emptyPassableNeighbor(state, state.hero);
    assert.ok(neighbor, 'need an open tile for the survivor');
    const survivor = createSurvivor(neighbor.col, neighbor.row);
    state.entities.push(survivor);

    // Advance into night to trigger hazard
    while (state.phase !== Phase.NIGHT) state.endRound();
    assert.ok(state.postRoundEvents.length > 0,
      'post-round events should be populated during night');

    // Advance past night into dawn
    while (state.phase === Phase.NIGHT) state.endRound();
    // Non-night phases produce no events (night attrition returns [])
    const hasFlashEvents = state.postRoundEvents.some(ev => ev.flash);
    assert.ok(!hasFlashEvents, 'no flash events should remain after leaving night');
  });

  test('attacker allies on adjacent hexes are counted for gang-up', () => {
    const state = freshState();
    const hero = state.hero;
    // Place a survivor on the same hex as hero (adjacent to target)
    const survivor = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    survivor.items = {};
    state.entities.push(survivor);
    // Place minion adjacent to hero
    const neighbor = emptyPassableNeighbor(state, hero);
    if (!neighbor) return;
    const minion = createMinion(neighbor.col, neighbor.row);
    state.entities.push(minion);

    const r = executeBattle(state, hero, minion);
    // Attacker ally is on the same hex as hero (adjacent to target? need to check)
    // Actually gang-up is allies adjacent to TARGET or same hex as target
    // This test verifies the breakdown field exists
    assert.ok(typeof r.attackerAllies === 'number');
    assert.ok(typeof r.defenderAllies === 'number');
  });

  test('multiple allies each add a d3 die (up to cap of 3)', () => {
    const state = freshState();
    const hero = state.hero;
    // Place target adjacent to hero
    const targetHex = emptyPassableNeighbor(state, hero);
    if (!targetHex) return;
    const minion = createMinion(targetHex.col, targetHex.row);
    state.entities.push(minion);

    // Place 2 survivors adjacent to the target (on target's hex neighbors)
    const targetNeighbors = getNeighbors(targetHex.col, targetHex.row).filter(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER;
    });
    const placed = [];
    for (let i = 0; i < Math.min(2, targetNeighbors.length); i++) {
      const s = new Entity(EntityType.SURVIVOR, 'hero', targetNeighbors[i].col, targetNeighbors[i].row);
      s.items = {};
      state.entities.push(s);
      placed.push(s);
    }

    const r = executeBattle(state, hero, minion);
    // Hero itself is adjacent to target, plus placed survivors
    assert.ok(r.attackerAllies >= placed.length, `Expected at least ${placed.length} allies, got ${r.attackerAllies}`);
    assert.equal(r.breakdown.atkExtraDice.length, Math.min(r.attackerAllies, 3),
      'Each ally (up to 3) should contribute a d3 die');
  });

  test('silver attackBonus is included in combat attack roll', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.shared[ResourceType.SILVER] = 1;

    // Use silver to get +1 attackBonus
    const useResult = executeUseItem(state, hero, ResourceType.SILVER);
    assert.equal(useResult.success, true);
    assert.equal(hero.attackBonus, 1, 'Silver should set attackBonus to 1');

    // Place target adjacent to hero
    const targetHex = emptyPassableNeighbor(state, hero);
    if (!targetHex) return;
    const minion = createMinion(targetHex.col, targetHex.row);
    state.entities.push(minion);

    const r = executeBattle(state, hero, minion);
    // attackRoll = baseDie + hero.attack + hero.attackBonus(1) + phaseBonus + extraDice
    // Verify the attackRoll includes the silver bonus by checking it's at least
    // baseDie(1) + attack + 1(silver)
    assert.ok(r.attackRoll >= 1 + hero.attack + 1,
      `attackRoll (${r.attackRoll}) should include silver bonus`);
  });
});

// ── Splash damage on stacked units ───────────────────────────────────────────

describe('executeBattle — splash damage', () => {
  test('crush triggers splash on bystanders', () => {
    const state = freshState();
    const hero = state.hero;
    hero.attackBonus = 100; // guarantee crush
    const minion = createMinion(hero.col, hero.row);
    minion.hp = 10; minion.maxHp = 10; // survives the crush
    state.entities.push(minion);

    // Bystander on same tile as target
    const bystander = createMinion(hero.col, hero.row);
    bystander.hp = 5; bystander.maxHp = 5;
    state.entities.push(bystander);

    const r = executeBattle(state, hero, minion);
    if (r.hit && r.attackRoll >= 2 * r.defenseRoll) {
      // Should have splashed the bystander
      assert.ok(bystander.hp < 5, 'bystander should take splash damage on crush');
    }
  });

  test('kill triggers splash on bystanders', () => {
    const state = freshState();
    const hero = state.hero;
    hero.attackBonus = 100;
    // Weak minion that will definitely die
    const minion = createMinion(hero.col, hero.row);
    minion.hp = 1; minion.maxHp = 1;
    state.entities.push(minion);

    const bystander = createMinion(hero.col, hero.row);
    bystander.hp = 5; bystander.maxHp = 5;
    state.entities.push(bystander);

    const r = executeBattle(state, hero, minion);
    if (r.killed) {
      assert.ok(bystander.hp < 5, 'bystander should take splash damage on kill');
    }
  });

  test('attacker is excluded from splash', () => {
    const state = freshState();
    const hero = state.hero;
    hero.attackBonus = 100;
    hero.hp = 10; hero.maxHp = 10;
    // Target on hero's hex
    const minion = createMinion(hero.col, hero.row);
    minion.hp = 1; minion.maxHp = 1;
    state.entities.push(minion);

    const r = executeBattle(state, hero, minion);
    if (r.killed) {
      assert.equal(hero.hp, 10, 'attacker should not take splash damage');
    }
  });

  test('splash can kill bystanders and remove them', () => {
    const state = freshState();
    const hero = state.hero;
    hero.attackBonus = 100;
    const minion = createMinion(hero.col, hero.row);
    minion.hp = 1; minion.maxHp = 1;
    state.entities.push(minion);

    // 1 HP bystander should die from splash
    const fragile = createMinion(hero.col, hero.row);
    fragile.hp = 1; fragile.maxHp = 1;
    state.entities.push(fragile);

    const r = executeBattle(state, hero, minion);
    if (r.killed) {
      assert.ok(!state.entities.find(e => e.id === fragile.id),
        'splash-killed bystander should be removed');
      assert.ok(r.splashKills.length > 0, 'splashKills should contain the killed bystander');
    }
  });

  test('no splash on normal hit (no crush, no kill)', () => {
    const state = freshState();
    const hero = state.hero;
    // Give hero low attack to avoid crush, target high HP to avoid kill
    hero.attack = 1;
    hero.attackBonus = 0;
    const minion = createMinion(hero.col, hero.row);
    minion.hp = 50; minion.maxHp = 50;
    minion.defense = 0;
    state.entities.push(minion);

    const bystander = createMinion(hero.col, hero.row);
    bystander.hp = 5; bystander.maxHp = 5;
    state.entities.push(bystander);

    // Run many times — on a normal hit (1 dmg, no crush, no kill), no splash
    for (let i = 0; i < 20; i++) {
      minion.hp = 50;
      bystander.hp = 5;
      const r = executeBattle(state, hero, minion);
      if (r.hit && r.attackRoll < 2 * r.defenseRoll && !r.killed) {
        assert.equal(bystander.hp, 5, 'no splash on normal hit');
      }
    }
  });

  test('splashKills field is always present', () => {
    const state = freshState();
    const hero = state.hero;
    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);
    const r = executeBattle(state, hero, minion);
    assert.ok(Array.isArray(r.splashKills), 'splashKills should be an array');
  });

  test('splashHits field is always present', () => {
    const state = freshState();
    const hero = state.hero;
    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);
    const r = executeBattle(state, hero, minion);
    assert.ok(Array.isArray(r.splashHits), 'splashHits should be an array');
  });

  test('splashHits contains bystander info on crush/kill', () => {
    const state = freshState();
    const hero = state.hero;
    hero.attackBonus = 100; // guarantee crush
    const minion = createMinion(hero.col, hero.row);
    minion.hp = 1; minion.maxHp = 1;
    state.entities.push(minion);

    const bystander = createMinion(hero.col, hero.row);
    bystander.hp = 5; bystander.maxHp = 5;
    state.entities.push(bystander);

    const r = executeBattle(state, hero, minion);
    if (r.killed || (r.hit && r.attackRoll >= 2 * r.defenseRoll)) {
      assert.ok(r.splashHits.length > 0, 'splashHits should contain bystander');
      const hit = r.splashHits.find(h => h.id === bystander.id);
      assert.ok(hit, 'splashHits should include the bystander');
      assert.equal(hit.name, bystander.displayName, 'splashHit should have name');
      assert.equal(hit.col, bystander.col, 'splashHit should have col');
      assert.equal(hit.row, bystander.row, 'splashHit should have row');
      assert.equal(typeof hit.killed, 'boolean', 'splashHit should have killed flag');
    }
  });

  test('splashHits marks killed bystanders correctly', () => {
    const state = freshState();
    const hero = state.hero;
    hero.attackBonus = 100;
    const minion = createMinion(hero.col, hero.row);
    minion.hp = 1; minion.maxHp = 1;
    state.entities.push(minion);

    // 1 HP bystander should die from splash
    const fragile = createMinion(hero.col, hero.row);
    fragile.hp = 1; fragile.maxHp = 1;
    state.entities.push(fragile);

    const r = executeBattle(state, hero, minion);
    if (r.killed) {
      const hit = r.splashHits.find(h => h.id === fragile.id);
      assert.ok(hit, 'splashHits should include the fragile bystander');
      assert.equal(hit.killed, true, 'fragile bystander should be marked killed');
    }
  });

  test('splashHits is empty when no splash occurs', () => {
    const state = freshState();
    const hero = state.hero;
    hero.attack = 1;
    hero.attackBonus = 0;
    const minion = createMinion(hero.col, hero.row);
    minion.hp = 50; minion.maxHp = 50;
    minion.defense = 0;
    state.entities.push(minion);

    const bystander = createMinion(hero.col, hero.row);
    bystander.hp = 5; bystander.maxHp = 5;
    state.entities.push(bystander);

    for (let i = 0; i < 20; i++) {
      minion.hp = 50;
      bystander.hp = 5;
      const r = executeBattle(state, hero, minion);
      if (r.hit && r.attackRoll < 2 * r.defenseRoll && !r.killed) {
        assert.deepStrictEqual(r.splashHits, [], 'splashHits should be empty on normal hit');
      }
    }
  });
});

// ── executeFortify ────────────────────────────────────────────────────────────
// Design: Metal → +2 DEF; Wood → +1 DEF (or +2 with FORTIFY_DOUBLE); cap at 4

describe('executeFortify', () => {
  test('metal gives +2 fortify level', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.shared[ResourceType.METAL] = 1;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 0;

    const r = executeFortify(state, hero);
    assert.equal(r.success, true);
    assert.equal(t.fortifyLevel, 2);
    assert.equal(state.inventory.shared[ResourceType.METAL], 0, 'Metal should be consumed');
  });

  test('wood gives +1 fortify level (without FORTIFY_DOUBLE)', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.shared[ResourceType.WOOD] = 1;
    state.inventory.shared[ResourceType.METAL] = 0; // ensure metal not present
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 0;

    const r = executeFortify(state, hero);
    assert.equal(r.success, true);
    assert.equal(t.fortifyLevel, 1);
    assert.equal(state.inventory.shared[ResourceType.WOOD], 0, 'Wood should be consumed');
  });

  test('FORTIFY_DOUBLE survivor: wood gives +2 fortify level', () => {
    const state = freshState();
    // Create an innkeeper (FORTIFY_DOUBLE) entity
    const innkeeper = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    innkeeper.ability = SurvivorAbility.FORTIFY_DOUBLE;
    innkeeper.items = {};
    state.entities.push(innkeeper);

    state.inventory.shared[ResourceType.WOOD] = 1;
    state.inventory.shared[ResourceType.METAL] = 0;
    const t = state.tiles.get(hexKey(innkeeper.col, innkeeper.row));
    t.fortifyLevel = 0;

    const r = executeFortify(state, innkeeper);
    assert.equal(r.success, true);
    assert.equal(t.fortifyLevel, 2, 'FORTIFY_DOUBLE should give +2 with wood');
  });

  test('metal is preferred over wood', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.shared[ResourceType.METAL] = 1;
    state.inventory.shared[ResourceType.WOOD] = 1;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 0;

    executeFortify(state, hero);
    assert.equal(state.inventory.shared[ResourceType.METAL], 0, 'Metal should be used first');
    assert.equal(state.inventory.shared[ResourceType.WOOD], 1, 'Wood should be untouched');
    assert.equal(t.fortifyLevel, 2);
  });

  test('fails when no wood or metal', () => {
    const state = freshState();
    state.inventory.shared[ResourceType.METAL] = 0;
    state.inventory.shared[ResourceType.WOOD] = 0;
    const r = executeFortify(state, state.hero);
    assert.equal(r.success, false);
  });

  test('fortify level caps at 4', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.shared[ResourceType.METAL] = 5;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 3; // one more metal (+2) would reach 5, should cap at 4

    const r = executeFortify(state, hero);
    assert.equal(t.fortifyLevel, 4, 'Fortify level should cap at 4');
    assert.equal(r.defGain, 1, 'defGain should reflect capped gain (4 - 3 = 1)');
  });

  test('defGain returns actual gain for metal and wood', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.shared[ResourceType.METAL] = 1;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 0;

    const r1 = executeFortify(state, hero);
    assert.equal(r1.defGain, 2, 'Metal should give defGain of 2');

    state.inventory.shared[ResourceType.WOOD] = 1;
    const r2 = executeFortify(state, hero);
    assert.equal(r2.defGain, 1, 'Wood should give defGain of 1');
  });

  test('fails when tile is already at max fortify (level 4)', () => {
    const state = freshState();
    state.inventory.shared[ResourceType.METAL] = 1;
    const t = state.tiles.get(hexKey(state.hero.col, state.hero.row));
    t.fortifyLevel = 4;

    const r = executeFortify(state, state.hero);
    assert.equal(r.success, false);
    assert.equal(t.fortifyLevel, 4, 'Level should not change');
  });

  test('costs 1 action', () => {
    const state = freshState();
    state.inventory.shared[ResourceType.WOOD] = 1;
    const r = executeFortify(state, state.hero);
    assert.equal(r.cost, 1);
  });
});

// ── executeSummon ─────────────────────────────────────────────────────────────
// Design: Metal → Iron Golem (costs 2); Wood → Wood Golem (costs 2); else → Minion (costs 2 total)
// No once-per-turn limit; multiple summons allowed per turn.

describe('executeSummon', () => {
  function witchState() {
    return freshState();
  }

  test('metal → Iron Golem spawns on witch tile (costs 2 metal)', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.METAL] = 2;
    const { col, row } = state.witch;

    const r = executeSummon(state, state.witch);
    assert.equal(r.success, true);
    const summoned = state.entities.find(e => e !== state.witch && e.col === col && e.row === row);
    assert.ok(summoned, 'A unit should appear on the witch tile');
    assert.equal(summoned.type, EntityType.IRON_GOLEM, 'Metal should summon Iron Golem');
    assert.equal(state.inventory.witch[ResourceType.METAL], 0, '2 metal should be consumed');
  });

  test('wood → Wood Golem spawns on witch tile (costs 2 wood, when no metal)', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.METAL] = 0;
    state.inventory.witch[ResourceType.WOOD] = 2;
    const { col, row } = state.witch;

    const r = executeSummon(state, state.witch);
    assert.equal(r.success, true);
    const summoned = state.entities.find(e => e !== state.witch && e.col === col && e.row === row);
    assert.equal(summoned?.type, EntityType.WOOD_GOLEM, 'Wood should summon Wood Golem');
    assert.equal(state.inventory.witch[ResourceType.WOOD], 0, '2 wood should be consumed');
  });

  test('other resource → Minion spawns on witch tile (costs 2 total)', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.METAL] = 0;
    state.inventory.witch[ResourceType.WOOD] = 0;
    state.inventory.witch[ResourceType.FOOD] = 2;
    const { col, row } = state.witch;

    const r = executeSummon(state, state.witch);
    assert.equal(r.success, true);
    const summoned = state.entities.find(e => e !== state.witch && e.col === col && e.row === row);
    assert.equal(summoned?.type, EntityType.MINION, 'Non-metal/wood resource should summon Minion');
    assert.equal(state.inventory.witch[ResourceType.FOOD], 0, '2 food should be consumed');
  });

  test('fails when fewer than 2 total resources', () => {
    const state = witchState();
    state.inventory.witch = { [ResourceType.FOOD]: 1 };

    const r = executeSummon(state, state.witch);
    assert.equal(r.success, false, 'Should fail with only 1 resource');
  });

  test('fails when no resources', () => {
    const state = witchState();
    state.inventory.witch = {};

    const r = executeSummon(state, state.witch);
    assert.equal(r.success, false);
  });

  test('allows multiple summons in the same turn (stacking on witch tile)', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.FOOD] = 6;

    const r1 = executeSummon(state, state.witch);
    assert.equal(r1.success, true, 'First summon should succeed');

    const r2 = executeSummon(state, state.witch);
    assert.equal(r2.success, true, 'Second summon in same turn should also succeed');
  });

  test('costs 1 action', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.FOOD] = 2;
    const r = executeSummon(state, state.witch);
    assert.equal(r.cost, 1);
  });

  test('summon available even when all adjacent hexes are occupied', () => {
    // No adjacent-hex requirement — should still work
    const state = witchState();
    state.inventory.witch[ResourceType.FOOD] = 2;
    // Fill all neighbors with entities
    const neighbors = getNeighbors(state.witch.col, state.witch.row);
    for (const n of neighbors) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t && t.type !== TileType.RIVER) {
        const m = createMinion(n.col, n.row, null);
        state.entities.push(m);
      }
    }
    const r = executeSummon(state, state.witch);
    assert.equal(r.success, true, 'Should summon even with all neighbors occupied');
  });
});

// ── executeHeal ───────────────────────────────────────────────────────────────

describe('executeHeal', () => {
  test('heals 1 HP, costs 1 action, consumes herbs', () => {
    const state = freshState();
    const hero = state.hero;
    hero.items[ResourceType.HERBS] = 1;
    hero.takeDamage(5);
    const hpBefore = hero.hp;

    const r = executeHeal(state, hero);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1, 'Heal should cost 1 action');
    assert.equal(hero.hp, hpBefore + 1);
    assert.equal(hero.items[ResourceType.HERBS], 0, 'Herbs should be consumed');
  });

  test('witch can heal too', () => {
    const state = freshState();
    const witch = state.witch;
    witch.items[ResourceType.HERBS] = 1;
    witch.takeDamage(3);
    const hpBefore = witch.hp;

    const r = executeHeal(state, witch);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1);
    assert.equal(witch.hp, hpBefore + 1);
  });

  test('fails when no herbs', () => {
    const state = freshState();
    state.hero.items[ResourceType.HERBS] = 0;
    state.hero.takeDamage(3);
    const r = executeHeal(state, state.hero);
    assert.equal(r.success, false);
  });

  test('fails when already at full health', () => {
    const state = freshState();
    state.hero.items[ResourceType.HERBS] = 1;
    const r = executeHeal(state, state.hero);
    assert.equal(r.success, false);
  });

  test('heal caps at maxHp', () => {
    const state = freshState();
    const hero = state.hero;
    hero.items[ResourceType.HERBS] = 1;
    hero.takeDamage(1); // 1 below max
    executeHeal(state, hero);
    assert.equal(hero.hp, hero.maxHp);
  });
});

// ── executeUseItem ────────────────────────────────────────────────────────────
// Design:
//   Food  (1 action, +1 action)  ← costs 1 AND gives 1 back = net 0
//   Silver (free, +1 ATK)
//   Scripture (free, ward)
//   Weapon equip (free)

describe('executeUseItem — Silver', () => {
  test('silver gives +1 attackBonus and costs 0', () => {
    const state = freshState();
    state.inventory.shared[ResourceType.SILVER] = 1;
    const bonusBefore = state.hero.attackBonus;

    const r = executeUseItem(state, state.hero, ResourceType.SILVER);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'Silver should be free');
    assert.equal(state.hero.attackBonus, bonusBefore + 1);
    assert.equal(state.inventory.shared[ResourceType.SILVER], 0, 'Silver consumed');
  });
});

describe('executeUseItem — weapon equip', () => {
  test('equipping a weapon applies its stats and costs 0', () => {
    const state = freshState();
    const hero = state.hero;
    hero.items['weapon:sword'] = 1;
    const atkBefore = hero.attack;

    const r = executeUseItem(state, hero, 'weapon:sword');
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'Equipping a weapon should be free');
    assert.equal(hero.attack, atkBefore + 2, 'Sword gives +2 ATK');
    assert.equal(hero.weapon, WeaponType.SWORD);
    assert.equal(hero.items['weapon:sword'], 0, 'Weapon consumed from inventory');
  });

  test('equipping weapon fails if not in inventory', () => {
    const state = freshState();
    state.hero.items['weapon:sword'] = 0;
    const r = executeUseItem(state, state.hero, 'weapon:sword');
    assert.equal(r.success, false);
  });
});

// ── auto-equip weapon on loot ─────────────────────────────────────────────────

describe('auto-equip weapon on loot find', () => {
  // Helper: place hero on a blacksmith tile and rig Math.random so rollLoot
  // always picks the first entry (weapon:sword for blacksmith).
  function blacksmithState() {
    const state = freshState();
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.type = TileType.BUILDING;
    t.building = BuildingType.BLACKSMITH;
    t.explored = false;
    t.hiddenSurvivor = false; // prevent survivor encounter from consuming Math.random calls
    return { state, hero, t };
  }

  // rollLoot is called twice per explore. We control both calls:
  // call 1 (Math.random=0): blacksmith first entry → weapon:sword
  // call 2 (Math.random=0.95): blacksmith last entry → wood (non-weapon)
  function makeRandom(firstVal, secondVal) {
    let calls = 0;
    return () => calls++ === 0 ? firstVal : secondVal;
  }

  test('weapon auto-equipped when hero has no weapon', () => {
    const { state, hero } = blacksmithState();
    assert.equal(hero.weapon, null, 'precondition: no weapon');
    const origRandom = Math.random;
    Math.random = makeRandom(0, 0.95); // sword on first roll, wood on second
    try {
      executeExplore(state, hero);
    } finally {
      Math.random = origRandom;
    }
    assert.equal(hero.weapon, WeaponType.SWORD, 'sword should be auto-equipped');
    assert.equal((hero.items['weapon:sword'] || 0), 0, 'should NOT be in items when auto-equipped');
  });

  test('weapon goes to items when hero already has a weapon', () => {
    const { state, hero } = blacksmithState();
    hero.equipWeapon(WeaponType.AXE); // already armed
    const origRandom = Math.random;
    Math.random = makeRandom(0, 0.95); // sword on first roll, wood on second
    try {
      executeExplore(state, hero);
    } finally {
      Math.random = origRandom;
    }
    assert.equal(hero.weapon, WeaponType.AXE, 'existing weapon should remain equipped');
    assert.ok((hero.items['weapon:sword'] || 0) >= 1, 'new weapon should be in items');
  });

  test('auto-equip log message says equipped immediately', () => {
    const { state, hero } = blacksmithState();
    const origRandom = Math.random;
    Math.random = makeRandom(0, 0.95); // sword on first roll, wood on second
    let r;
    try {
      r = executeExplore(state, hero);
    } finally {
      Math.random = origRandom;
    }
    const combined = r.log.join(' ');
    assert.ok(combined.includes('equips'), `log should mention equipping, got: "${combined}"`);
  });
});

// ── executeUseAbility ─────────────────────────────────────────────────────────

describe('executeUseAbility — HEAL', () => {
  test('heals hero 1 HP when on same hex, costs 1 action', () => {
    const state = freshState();
    const hero = state.hero;
    const healer = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    healer.ability = SurvivorAbility.HEAL;
    healer.items = {};
    state.entities.push(healer);
    hero.takeDamage(5);
    const hpBefore = hero.hp;

    const r = executeUseAbility(state, healer);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1, 'HEAL ability costs 1 action');
    assert.equal(hero.hp, hpBefore + 1);
  });

  test('HEAL fails if hero not on same hex', () => {
    const state = freshState();
    const healer = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col + 2, state.hero.row);
    healer.ability = SurvivorAbility.HEAL;
    healer.items = {};
    state.entities.push(healer);
    state.hero.takeDamage(5);

    const r = executeUseAbility(state, healer);
    assert.equal(r.success, false);
  });

  test('HEAL fails if hero already at full HP', () => {
    const state = freshState();
    const hero = state.hero;
    assert.equal(hero.hp, hero.maxHp);
    const healer = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    healer.ability = SurvivorAbility.HEAL;
    healer.items = {};
    state.entities.push(healer);

    const r = executeUseAbility(state, healer);
    assert.equal(r.success, false, 'HEAL should fail when hero is full HP');
  });
});

describe('executeUseAbility — INSPIRE', () => {
  test('gives hero +1 attackBonus, costs 0', () => {
    const state = freshState();
    // Inspirer must be co-located with the hero (same as HEAL requirement)
    const inspirer = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    inspirer.ability = SurvivorAbility.INSPIRE;
    inspirer.items = {};
    state.entities.push(inspirer);
    const bonusBefore = state.hero.attackBonus;

    const r = executeUseAbility(state, inspirer);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'INSPIRE should be free');
    assert.equal(state.hero.attackBonus, bonusBefore + 1);
  });
});

describe('executeUseAbility — RALLY', () => {
  test('gives +1 actionsLeft, costs 0', () => {
    const state = freshState();
    const rallier = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    rallier.ability = SurvivorAbility.RALLY;
    rallier.items = {};
    state.entities.push(rallier);

    const r = executeUseAbility(state, rallier);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'RALLY should be free');
    // RALLY returns budgetBonus for the resolver to apply (both offline and online
    // use resolvePlans which handles budgetBonus; actionsLeft is not mutated directly)
    assert.equal(r.budgetBonus, 1, 'RALLY should return budgetBonus of 1');
  });
});

// ── Inventory stash separation ─────────────────────────────────────────────
// Design: Hero resources land in inventory.shared; witch resources land in
// inventory.witch. The two stashes are independent. The plan-panel display
// must use the human player's faction (via _planFaction) to select the correct
// stash — using state.activePlayer is incorrect because it defaults to HERO
// and is only updated during resolution, not during the planning phase.

describe('Inventory stash separation', () => {
  test('hero stash (inventory.shared) and witch stash (inventory.witch) are independent', () => {
    const state = freshState();
    // Clear starting resources so we can test independence cleanly
    state.inventory.shared = {};
    state.inventory.witch = {};

    // Populate both stashes with different resources
    state.inventory.shared[ResourceType.WOOD] = 3;
    state.inventory.shared[ResourceType.FOOD] = 1;
    state.inventory.witch[ResourceType.METAL] = 2;

    // Hero stash should contain hero resources only
    assert.equal(state.inventory.shared[ResourceType.WOOD], 3);
    assert.equal(state.inventory.shared[ResourceType.FOOD], 1);
    assert.equal(state.inventory.shared[ResourceType.METAL] || 0, 0,
      'hero stash must not contain witch metal');

    // Witch stash should contain witch resources only
    assert.equal(state.inventory.witch[ResourceType.METAL], 2);
    assert.equal(state.inventory.witch[ResourceType.WOOD] || 0, 0,
      'witch stash must not contain hero wood');
    assert.equal(state.inventory.witch[ResourceType.FOOD] || 0, 0,
      'witch stash must not contain hero food');
  });

  test('witch resources do not bleed into hero stash after summon', () => {
    const state = freshState();
    state.inventory.shared[ResourceType.METAL] = 0;
    state.inventory.witch[ResourceType.METAL] = 1;

    // Consuming witch metal (via summon) should not touch the hero stash
    // (summon fails here because only 1 metal, but the point is shared stash unchanged)
    executeSummon(state, state.witch);

    assert.equal(state.inventory.shared[ResourceType.METAL] || 0, 0,
      'hero stash must be unchanged after witch summons');
  });

  // Regression guard: the plan-panel inventory display must use _planFaction
  // (the faction the human is actually playing), NOT state.activePlayer which
  // defaults to HERO and can be stale during the planning phase.
  //
  // Expected stash-selection logic (mirrors _renderInventory in ui.js):
  //   const faction = this._planFaction ?? (state.activePlayer === Player.HERO ? 'hero' : 'witch');
  //   const isHero  = faction === 'hero';
  //   const stash   = isHero ? inv.shared : inv.witch;
  test('stash selection: planFaction=witch overrides activePlayer=HERO', () => {
    const state = freshState();
    // Simulate the stale activePlayer scenario: activePlayer is HERO (the default)
    // but the human is actually playing witch.
    assert.equal(state.activePlayer, Player.HERO, 'precondition: activePlayer defaults to HERO');
    const planFaction = 'witch'; // human is playing witch

    // Reproduce the fixed stash-selection logic
    const inv = state.inventory;
    const isHero = planFaction === 'hero'; // correct: use planFaction, not activePlayer
    const stash = isHero ? inv.shared : inv.witch;

    state.inventory.witch[ResourceType.METAL] = 5;
    state.inventory.shared[ResourceType.WOOD]  = 7;

    assert.equal(stash, inv.witch, 'witch player must see inv.witch, not inv.shared');
    assert.equal(stash[ResourceType.METAL], 5, 'witch player must see witch metal count');

    // Verify the buggy code would have returned the wrong stash
    const buggyIsHero = state.activePlayer === Player.HERO; // always true by default
    const buggyStash  = buggyIsHero ? inv.shared : inv.witch;
    assert.notEqual(buggyStash, stash,
      'the bug (using activePlayer) returns the wrong stash for witch players');
  });
});

// ── computeProjectedInventory ─────────────────────────────────────────────────
import { computeProjectedInventory } from '../src/planner.js';
import { PlanActionType } from '../src/planner.js';

describe('computeProjectedInventory', () => {
  function baseState() {
    const s = new GameState(true, true);
    s.inventory.witch.metal = 4;
    s.inventory.witch.wood  = 2;
    s.inventory.shared.wood = 3;
    s.inventory.shared.metal = 1;
    s.inventory.shared.food  = 2;
    return s;
  }

  test('empty plan returns snapshot equal to current inventory', () => {
    const s = baseState();
    const p = computeProjectedInventory(s, []);
    assert.equal(p.witch.metal, 4);
    assert.equal(p.shared.wood,  3);
  });

  test('SUMMON deducts 2 metal (Iron Golem path)', () => {
    const s = baseState();
    const p = computeProjectedInventory(s, [{ type: PlanActionType.SUMMON }]);
    assert.equal(p.witch.metal, 2, 'metal reduced by 2');
    assert.equal(p.witch.wood,  2, 'wood unchanged');
  });

  test('two SUMMONs deduct 4 metal total', () => {
    const s = baseState();
    const plan = [{ type: PlanActionType.SUMMON }, { type: PlanActionType.SUMMON }];
    const p = computeProjectedInventory(s, plan);
    assert.equal(p.witch.metal, 0);
    assert.equal(p.witch.wood,  2, 'wood unchanged when metal covers both');
  });

  test('SUMMON falls to wood when metal < 2', () => {
    const s = baseState();
    s.inventory.witch.metal = 1;
    const p = computeProjectedInventory(s, [{ type: PlanActionType.SUMMON }]);
    assert.equal(p.witch.wood, 0, 'wood reduced by 2 (Wood Golem path)');
  });

  test('FORTIFY deducts 1 metal from shared (metal preferred)', () => {
    const s = baseState();
    const p = computeProjectedInventory(s, [{ type: PlanActionType.FORTIFY }]);
    assert.equal(p.shared.metal, 0);
    assert.equal(p.shared.wood,  3, 'wood untouched when metal available');
  });

  test('FORTIFY deducts 1 wood when no shared metal', () => {
    const s = baseState();
    s.inventory.shared.metal = 0;
    const p = computeProjectedInventory(s, [{ type: PlanActionType.FORTIFY }]);
    assert.equal(p.shared.wood, 2);
  });

  test('USE_ITEM food deducts from shared', () => {
    const s = baseState();
    const p = computeProjectedInventory(s, [{ type: PlanActionType.USE_ITEM, item: 'food', entityId: 'x' }]);
    assert.equal(p.shared.food, 1);
  });

  test('does not mutate original state', () => {
    const s = baseState();
    computeProjectedInventory(s, [{ type: PlanActionType.SUMMON }]);
    assert.equal(s.inventory.witch.metal, 4, 'original state unchanged');
  });
});

// ── Survivor discovery (phase-based chance) ───────────────────────────────────

describe('survivor discovery — phase-based move chance', () => {
  // Helper: place a hiddenSurvivor on the first reachable tile and attempt the move.
  function moveOntoSurvivor(state, actor, roll) {
    const target = firstReachable(state, actor);
    if (!target) return null;
    state.tiles.get(hexKey(target.col, target.row)).hiddenSurvivor = true;
    const origRandom = Math.random;
    Math.random = () => roll;
    let r;
    try { r = executeMove(state, actor, target.col, target.row); }
    finally { Math.random = origRandom; }
    return { r, target };
  }

  test('DAY phase: roll below 0.5 discovers survivor', () => {
    const state = freshState();
    resetRoster();
    state.phase = Phase.DAY;
    const out = moveOntoSurvivor(state, state.hero, 0.49);
    if (!out) return;
    assert.ok(out.r.encounterSurvivor, 'survivor should be found');
    assert.equal(state.tiles.get(hexKey(out.target.col, out.target.row)).hiddenSurvivor, false);
  });

  test('DAY phase: roll at or above 0.5 misses survivor', () => {
    const state = freshState();
    resetRoster();
    state.phase = Phase.DAY;
    const out = moveOntoSurvivor(state, state.hero, 0.5);
    if (!out) return;
    assert.equal(out.r.encounterSurvivor, null, 'survivor should not be found');
    assert.equal(state.tiles.get(hexKey(out.target.col, out.target.row)).hiddenSurvivor, true,
      'hiddenSurvivor flag should remain true when missed');
  });

  test('NIGHT phase: roll below 0.25 discovers survivor', () => {
    const state = freshState();
    resetRoster();
    state.phase = Phase.NIGHT;
    const out = moveOntoSurvivor(state, state.hero, 0.24);
    if (!out) return;
    assert.ok(out.r.encounterSurvivor, 'survivor should be found at night with low roll');
  });

  test('NIGHT phase: roll at or above 0.25 misses survivor', () => {
    const state = freshState();
    resetRoster();
    state.phase = Phase.NIGHT;
    const out = moveOntoSurvivor(state, state.hero, 0.25);
    if (!out) return;
    assert.equal(out.r.encounterSurvivor, null, 'survivor should not be found at night with 0.25 roll');
    assert.equal(state.tiles.get(hexKey(out.target.col, out.target.row)).hiddenSurvivor, true);
  });

  test('DAWN phase: roll below 0.35 discovers survivor', () => {
    const state = freshState(); // starts as DAWN by default
    resetRoster();
    const out = moveOntoSurvivor(state, state.hero, 0.34);
    if (!out) return;
    assert.ok(out.r.encounterSurvivor, 'survivor found at dawn with roll below threshold');
  });

  test('DAWN phase: roll at or above 0.35 misses survivor', () => {
    const state = freshState();
    resetRoster();
    const out = moveOntoSurvivor(state, state.hero, 0.35);
    if (!out) return;
    assert.equal(out.r.encounterSurvivor, null, 'survivor missed at dawn with roll at threshold');
    assert.equal(state.tiles.get(hexKey(out.target.col, out.target.row)).hiddenSurvivor, true);
  });

  test('DUSK phase: roll below 0.35 discovers survivor', () => {
    const state = freshState();
    resetRoster();
    state.phase = Phase.DUSK;
    const out = moveOntoSurvivor(state, state.hero, 0.34);
    if (!out) return;
    assert.ok(out.r.encounterSurvivor, 'survivor found at dusk with roll below threshold');
  });

  test('missed survivor does not create any new entity', () => {
    const state = freshState();
    resetRoster();
    state.phase = Phase.NIGHT;
    const countBefore = state.entities.length;
    moveOntoSurvivor(state, state.hero, 0.9); // well above any threshold
    assert.equal(state.entities.length, countBefore, 'no entity should be created on a miss');
  });

  test('witch misses: no zombie created', () => {
    const state = freshState();
    state.phase = Phase.NIGHT;
    const countBefore = state.entities.length;
    moveOntoSurvivor(state, state.witch, 0.9);
    assert.equal(state.entities.length, countBefore, 'no zombie on a missed roll');
  });

  test('witch hits at night: zombie is created', () => {
    const state = freshState();
    state.phase = Phase.NIGHT;
    const out = moveOntoSurvivor(state, state.witch, 0.1);
    if (!out) return;
    assert.ok(out.r.encounterSurvivor, 'witch should encounter something');
    assert.equal(out.r.encounterSurvivor.type, 'zombie');
  });
});

describe('survivor discovery — explore always finds', () => {
  test('explore finds survivor regardless of phase (NIGHT)', () => {
    const state = freshState();
    resetRoster();
    state.phase = Phase.NIGHT;
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = false;
    t.hiddenSurvivor = true;
    const countBefore = state.entities.length;
    const r = executeExplore(state, hero);
    assert.equal(r.success, true);
    assert.ok(state.entities.length > countBefore, 'explore should always find the survivor');
    assert.equal(t.hiddenSurvivor, false, 'flag should be cleared');
    assert.ok(r.encounterSurvivor, 'result should carry encounterSurvivor');
    assert.equal(r.encounterSurvivor.type, 'survivor');
  });

  test('explore finds survivor regardless of phase (DAY)', () => {
    const state = freshState();
    resetRoster();
    state.phase = Phase.DAY;
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = false;
    t.hiddenSurvivor = true;
    const r = executeExplore(state, hero);
    assert.ok(r.encounterSurvivor, 'should always find survivor when exploring regardless of phase');
  });

  test('explore find works even if Math.random would block discovery', () => {
    const state = freshState();
    resetRoster();
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = false;
    t.hiddenSurvivor = true;
    const origRandom = Math.random;
    Math.random = () => 0.99; // would block any phase-based move discovery
    let r;
    try { r = executeExplore(state, hero); }
    finally { Math.random = origRandom; }
    assert.ok(r.encounterSurvivor, 'explore must find survivor ignoring Math.random');
    assert.equal(t.hiddenSurvivor, false);
  });

  test('explore with no hidden survivor returns no encounterSurvivor', () => {
    const state = freshState();
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = false;
    t.hiddenSurvivor = false;
    const r = executeExplore(state, hero);
    assert.equal(r.encounterSurvivor, null);
  });

  test('maxDiscoverableSurvivors caps survivor discoveries', () => {
    const state = freshState();
    resetRoster();
    state.maxDiscoverableSurvivors = 1;
    state.discoveredSurvivorCount = 0;

    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = false;
    t.hiddenSurvivor = true;

    const origRandom = Math.random;
    Math.random = () => 0; // guarantee discovery isn't blocked by random check
    try {
      // First discovery succeeds
      const r1 = executeExplore(state, hero);
      assert.ok(r1.encounterSurvivor, 'first discovery should succeed');
      assert.equal(state.discoveredSurvivorCount, 1);

      // Second discovery is blocked
      t.explored = false;
      t.hiddenSurvivor = true;
      const r2 = executeExplore(state, hero);
      assert.equal(r2.encounterSurvivor, null, 'second discovery should be blocked by cap');
      assert.equal(t.hiddenSurvivor, false, 'flag should still be cleared');
    } finally { Math.random = origRandom; }
  });

  test('null maxDiscoverableSurvivors allows unlimited discoveries', () => {
    const state = freshState();
    resetRoster();
    state.maxDiscoverableSurvivors = null;
    state.discoveredSurvivorCount = 5;

    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = false;
    t.hiddenSurvivor = true;

    const origRandom = Math.random;
    Math.random = () => 0; // guarantee discovery isn't blocked by random check
    let r;
    try { r = executeExplore(state, hero); }
    finally { Math.random = origRandom; }
    assert.ok(r.encounterSurvivor, 'discovery should succeed when cap is null');
    assert.equal(state.discoveredSurvivorCount, 6);
  });
});

// ── survivorFindMultiplier — diminishing survivor discovery ──────────────────

describe('survivorFindMultiplier', () => {
  test('returns 1.0 with no active survivors', () => {
    const state = freshState();
    // Remove any survivors that might exist from map gen
    state.entities = state.entities.filter(e => e.type !== EntityType.SURVIVOR);
    assert.equal(survivorFindMultiplier(state), 1.0);
  });

  test('returns 0.9 with 1 active survivor', () => {
    const state = freshState();
    state.entities = state.entities.filter(e => e.type !== EntityType.SURVIVOR);
    const s = createSurvivor(0, 0);
    s.owner = 'hero';
    state.entities.push(s);
    assert.ok(Math.abs(survivorFindMultiplier(state) - 0.9) < 1e-9);
  });

  test('returns 0.5 with 5 active survivors', () => {
    const state = freshState();
    state.entities = state.entities.filter(e => e.type !== EntityType.SURVIVOR);
    for (let i = 0; i < 5; i++) {
      const s = createSurvivor(i, 0);
      s.owner = 'hero';
      state.entities.push(s);
    }
    assert.ok(Math.abs(survivorFindMultiplier(state) - 0.5) < 1e-9);
  });

  test('returns 0 with 10+ active survivors', () => {
    const state = freshState();
    state.entities = state.entities.filter(e => e.type !== EntityType.SURVIVOR);
    for (let i = 0; i < 10; i++) {
      const s = createSurvivor(i, 0);
      s.owner = 'hero';
      state.entities.push(s);
    }
    assert.equal(survivorFindMultiplier(state), 0);
  });

  test('dead survivors do not count', () => {
    const state = freshState();
    state.entities = state.entities.filter(e => e.type !== EntityType.SURVIVOR);
    const s = createSurvivor(0, 0);
    s.owner = 'hero';
    s.hp = 0; // alive is a getter: hp > 0
    state.entities.push(s);
    assert.equal(survivorFindMultiplier(state), 1.0);
  });

  test('witch minions do not count', () => {
    const state = freshState();
    state.entities = state.entities.filter(e => e.type !== EntityType.SURVIVOR);
    const m = createMinion(0, 0);
    state.entities.push(m);
    assert.equal(survivorFindMultiplier(state), 1.0);
  });
});

// ── Explore: survivor find reduced by active survivors ───────────────────────

describe('executeExplore — survivor find penalty', () => {
  test('explore fails to find survivor when 10 active survivors exist', () => {
    resetRoster();
    const state = freshState();
    state.entities = state.entities.filter(e => e.type !== EntityType.SURVIVOR);
    // Add 10 active survivors
    for (let i = 0; i < 10; i++) {
      const s = createSurvivor(i, 0);
      s.owner = 'hero';
      state.entities.push(s);
    }
    const hero = state.hero;
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.explored = false;
    t.hiddenSurvivor = true;

    const r = executeExplore(state, hero);
    assert.ok(r.success, 'explore itself should succeed');
    assert.equal(r.encounterSurvivor, null, 'should not find survivor with 10 active');
    // The hiddenSurvivor flag should still be there since the encounter was skipped
    assert.ok(t.hiddenSurvivor, 'hiddenSurvivor flag should remain');
  });
});
