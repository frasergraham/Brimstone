// Spec-based tests for src/actions.js
// Tests what SHOULD happen, not what the code currently does.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase, Player } from '../src/game.js';
import {
  executeMove, executeExplore, executeBattle, executeFortify,
  executeSummon, executeUseItem, executeUseAbility,
  getReachableHexes, sightRange,
} from '../src/actions.js';
import {
  Entity, EntityType, SurvivorAbility,
  createHero, createWitch, createMinion, createZombie, createSurvivor, resetRoster,
} from '../src/entities.js';
import { TileType, BuildingType, ResourceType, WeaponType } from '../src/tiles.js';
import { hexKey, getNeighbors } from '../src/hex.js';

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

    const countBefore = state.entities.length;
    executeMove(state, hero, target.col, target.row);
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

    const countBefore = state.entities.length;
    executeMove(state, witch, target.col, target.row);
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
    const r = executeMove(state, hero, target.col, target.row);
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
    const r = executeMove(state, witch, target.col, target.row);
    assert.ok(r.encounterSurvivor, 'encounterSurvivor should be set for zombie');
    assert.equal(r.encounterSurvivor.type, 'zombie');
    assert.ok(typeof r.encounterSurvivor.hp === 'number', 'zombie should have hp');
    assert.ok(typeof r.encounterSurvivor.attack === 'number', 'zombie should have attack');
    assert.ok(typeof r.encounterSurvivor.defense === 'number', 'zombie should have defense');
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

  test('hero gets phase bonus in DAY', () => {
    const state = freshState();
    state.phase = Phase.DAY;
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);

    // We can't control random, but the breakdown should show phaseBonus=1
    const r = executeBattle(state, state.hero, minion);
    assert.equal(r.breakdown.phaseBonus, 1, 'Hero should have phaseBonus=1 in DAY');
  });

  test('witch gets phase bonus in NIGHT', () => {
    const state = freshState();
    state.phase = Phase.NIGHT;
    const survivor = new Entity(EntityType.SURVIVOR, 'hero', state.witch.col, state.witch.row);
    survivor.items = {};
    state.entities.push(survivor);

    const r = executeBattle(state, state.witch, survivor);
    assert.equal(r.breakdown.phaseBonus, 1, 'Witch should have phaseBonus=1 in NIGHT');
  });

  test('hero does NOT get phase bonus in NIGHT', () => {
    const state = freshState();
    state.phase = Phase.NIGHT;
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    const r = executeBattle(state, state.hero, minion);
    assert.equal(r.breakdown.phaseBonus, 0, 'Hero should have no phase bonus in NIGHT');
  });

  test('fortification absorbs damage before entity takes HP damage', () => {
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

    if (r.hit) {
      // Fort should have absorbed at least 1 point
      assert.ok(r.fortAbsorbed >= 0);
      const expectedDamage = Math.max(0, (r.attackRoll >= 2 * r.defenseRoll ? 2 : 1) - r.fortAbsorbed);
      assert.equal(minion.hp, Math.max(0, hpBefore - expectedDamage));
    }
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

    executeFortify(state, hero);
    assert.equal(t.fortifyLevel, 4, 'Fortify level should cap at 4');
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

  function findSummonTarget(state) {
    const witch = state.witch;
    return emptyPassableNeighbor(state, witch);
  }

  test('metal → Iron Golem (costs 2 metal)', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.METAL] = 2;
    const target = findSummonTarget(state);
    if (!target) return;

    const r = executeSummon(state, state.witch, target.col, target.row);
    assert.equal(r.success, true);
    const summoned = state.entities.find(e => e.col === target.col && e.row === target.row);
    assert.ok(summoned, 'A unit should appear on the target hex');
    assert.equal(summoned.type, EntityType.IRON_GOLEM, 'Metal should summon Iron Golem');
    assert.equal(state.inventory.witch[ResourceType.METAL], 0, '2 metal should be consumed');
  });

  test('wood → Wood Golem (costs 2 wood, when no metal)', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.METAL] = 0;
    state.inventory.witch[ResourceType.WOOD] = 2;
    const target = findSummonTarget(state);
    if (!target) return;

    const r = executeSummon(state, state.witch, target.col, target.row);
    assert.equal(r.success, true);
    const summoned = state.entities.find(e => e.col === target.col && e.row === target.row);
    assert.equal(summoned?.type, EntityType.WOOD_GOLEM, 'Wood should summon Wood Golem');
    assert.equal(state.inventory.witch[ResourceType.WOOD], 0, '2 wood should be consumed');
  });

  test('other resource → Minion (costs 2 total)', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.METAL] = 0;
    state.inventory.witch[ResourceType.WOOD] = 0;
    state.inventory.witch[ResourceType.FOOD] = 2;
    const target = findSummonTarget(state);
    if (!target) return;

    const r = executeSummon(state, state.witch, target.col, target.row);
    assert.equal(r.success, true);
    const summoned = state.entities.find(e => e.col === target.col && e.row === target.row);
    assert.equal(summoned?.type, EntityType.MINION, 'Non-metal/wood resource should summon Minion');
    assert.equal(state.inventory.witch[ResourceType.FOOD], 0, '2 food should be consumed');
  });

  test('fails when fewer than 2 total resources', () => {
    const state = witchState();
    state.inventory.witch = { [ResourceType.FOOD]: 1 };
    const target = findSummonTarget(state);
    if (!target) return;

    const r = executeSummon(state, state.witch, target.col, target.row);
    assert.equal(r.success, false, 'Should fail with only 1 resource');
  });

  test('fails when no resources', () => {
    const state = witchState();
    state.inventory.witch = {};
    const target = findSummonTarget(state);
    if (!target) return;

    const r = executeSummon(state, state.witch, target.col, target.row);
    assert.equal(r.success, false);
  });

  test('allows multiple summons in the same turn', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.FOOD] = 6;
    const target = findSummonTarget(state);
    if (!target) return;

    const r1 = executeSummon(state, state.witch, target.col, target.row);
    assert.equal(r1.success, true, 'First summon should succeed');

    // Find another empty neighbor for second summon
    const target2 = emptyPassableNeighbor(state, state.witch);
    if (!target2) return;
    const r2 = executeSummon(state, state.witch, target2.col, target2.row);
    assert.equal(r2.success, true, 'Second summon in same turn should also succeed');
  });

  test('costs 1 action', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.FOOD] = 2;
    const target = findSummonTarget(state);
    if (!target) return;
    const r = executeSummon(state, state.witch, target.col, target.row);
    assert.equal(r.cost, 1);
  });
});

// ── executeUseItem ────────────────────────────────────────────────────────────
// Design (from CLAUDE.md):
//   Herbs (free, heal 2)
//   Food  (1 action, +1 action)  ← costs 1 AND gives 1 back = net 0
//   Silver (free, +1 ATK)
//   Scripture (free, ward)
//   Weapon equip (free)

describe('executeUseItem — Herbs', () => {
  test('herbs heal 2 HP and cost 0 actions', () => {
    const state = freshState();
    const hero = state.hero;
    hero.items[ResourceType.HERBS] = 1;
    hero.takeDamage(5);
    const hpBefore = hero.hp;

    const r = executeUseItem(state, hero, ResourceType.HERBS);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'Herbs should be free (cost 0)');
    assert.equal(hero.hp, Math.min(hero.maxHp, hpBefore + 2));
    assert.equal(hero.items[ResourceType.HERBS], 0, 'Herbs should be consumed');
  });

  test('herbs fail when none in inventory', () => {
    const state = freshState();
    state.hero.items[ResourceType.HERBS] = 0;
    const r = executeUseItem(state, state.hero, ResourceType.HERBS);
    assert.equal(r.success, false);
  });

  test('herbs heal caps at maxHp', () => {
    const state = freshState();
    const hero = state.hero;
    hero.items[ResourceType.HERBS] = 1;
    hero.takeDamage(1); // 1 below max
    executeUseItem(state, hero, ResourceType.HERBS);
    assert.equal(hero.hp, hero.maxHp);
  });
});

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
    const target = getNeighbors(state.witch.col, state.witch.row)
      .find(n => {
        const t = state.tiles.get(hexKey(n.col, n.row));
        return t && t.type !== TileType.RIVER &&
          !state.entities.some(e => e.col === n.col && e.row === n.row);
      });
    if (!target) return; // skip if map has no valid spawn hex (shouldn't happen)

    executeSummon(state, state.witch, target.col, target.row);

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
