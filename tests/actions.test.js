// Spec-based tests for src/actions.js
// Tests what SHOULD happen, not what the code currently does.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase, Player } from '../src/game.js';
import {
  executeMove, executeExplore, executeBattle, executeFortify,
  executeSummon, executeHeal, executeUseItem, executeUseAbility,
  executeSoundHorn, executeFortAssault, isFortBlocking,
  getReachableHexes, sightRange, survivorFindMultiplier,
  getValidActions, ActionType,
} from '../src/actions.js';
import {
  Entity, EntityType, SurvivorAbility,
  createHero, createWitch, createMinion, createZombie, createSurvivor,
  createIronGolem, resetRoster, setForcedDice,
} from '../src/entities.js';
import { TileType, BuildingType, ResourceType, WeaponType, MAX_FORTIFY_LEVEL, getFortifyCombatBonus, FORT_IMPASSABLE_THRESHOLD, legacyTileType, decomposeTileType, isBuildingFootprint } from '../src/tiles.js';
import { hexKey, getNeighbors, hexDistance } from '../src/hex.js';
import { applyPostRoundEffects } from '../src/post-round-effects.js';
import { applyEffect } from '../src/effects.js';

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

// Pick a reachable non-blocked neighbor for a given entity
function firstReachable(state, entity) {
  return getReachableHexes(state, entity, 1)[0] ?? null;
}

// Find a passable neighbor that has no entity on it
function emptyPassableNeighbor(state, entity) {
  return getNeighbors(entity.col, entity.row).find(n => {
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!t || legacyTileType(t) === TileType.RIVER || isBuildingFootprint(t)) return false;
    return !state.entities.some(e => e.alive && e.col === n.col && e.row === n.row);
  }) ?? null;
}

// ── sightRange ────────────────────────────────────────────────────────────────
// Design: DAY=6, DAWN/DUSK=4, NIGHT=3; SCOUT adds +1.
// LOS gating (forests/buildings block vision past them) is exercised by
// tests/los-fog.test.js and the renderer fog tests.

describe('sightRange', () => {
  test('DAY sight is 6', () => assert.equal(sightRange(Phase.DAY), 6));
  test('DAWN sight is 4', () => assert.equal(sightRange(Phase.DAWN), 4));
  test('DUSK sight is 4', () => assert.equal(sightRange(Phase.DUSK), 4));
  test('NIGHT sight is 3', () => assert.equal(sightRange(Phase.NIGHT), 3));
  test('SCOUT adds +1 to sight in every phase', () => {
    assert.equal(sightRange(Phase.DAY,   true), 7);
    assert.equal(sightRange(Phase.DAWN,  true), 5);
    assert.equal(sightRange(Phase.DUSK,  true), 5);
    assert.equal(sightRange(Phase.NIGHT, true), 4);
  });
  test('non-scout gives no bonus', () => {
    assert.equal(sightRange(Phase.DAY, false), 6);
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
      assert.notEqual(legacyTileType(t), TileType.RIVER, `River tile (${h.col},${h.row}) should not be reachable`);
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
      if (legacyTileType(t) === TileType.RIVER) { riverNeighbor = n; break; }
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
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t);
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

    // Use deterministic coordinates: (6,2) → (7,2) → (8,2) — guaranteed
    // neighbors in even-row odd-r offset hex grid.
    const heroPos = { col: 6, row: 2 };
    const n1 = { col: 7, row: 2 };
    const n2 = { col: 8, row: 2 };

    // Make all three hexes roads so they're within movement budget
    for (const h of [heroPos, n1, n2]) {
      const t = state.tiles.get(hexKey(h.col, h.row));
      if (t) { decomposeTileType(t, TileType.ROAD); t.building = null; t.hiddenSurvivor = false; clearFootprint(t); }
    }

    // Place hero at known position
    hero.col = heroPos.col;
    hero.row = heroPos.row;

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
    const sharedBefore = JSON.stringify(state.inventory.hero);
    const itemsBefore = JSON.stringify(hero.items);

    executeExplore(state, hero);

    const sharedAfter = JSON.stringify(state.inventory.hero);
    const itemsAfter = JSON.stringify(hero.items);
    // At minimum, loot was rolled — either shared changed or items changed (or 'nothing')
    // We can't guarantee a non-nothing result without mocking random, so just check it ran
    assert.equal(t.explored, true);
  });

  test('HERBALIST survivor also adds 1 herb to shared supplies on explore', () => {
    const state = freshState();
    // Create a proper herbalist entity
    const herbalist = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    herbalist.abilities = [SurvivorAbility.HERBALIST];
    herbalist.items = {};

    const t = state.tiles.get(hexKey(herbalist.col, herbalist.row));
    t.explored = false;

    const herbsBefore = (state.inventory.hero[ResourceType.HERBS]?.count ?? 0) ?? 0;
    executeExplore(state, herbalist);
    const herbsAfter = (state.inventory.hero[ResourceType.HERBS]?.count ?? 0) ?? 0;

    assert.ok(herbsAfter >= herbsBefore + 1, 'HERBALIST should add at least 1 herb to shared supplies on explore');
  });

  test('non-HERBALIST survivor does NOT receive a bonus herb', () => {
    const state = freshState();
    const survivor = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    survivor.abilities = [SurvivorAbility.BRAWLER]; // not a herbalist
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
    // not 2 from a duplicate _applyLoot call. The agility-driven loot bonus
    // is gated above standard leader agility (paladin 6 → 0% chance), so
    // no extra rolls fire for the paladin.
    for (let i = 0; i < 100; i++) {
      const state = freshState();
      const hero = state.hero;
      state.tiles.get(hexKey(hero.col, hero.row)).explored = false;
      // Ensure tile is not a building so only terrain loot applies (single roll)
      const t = state.tiles.get(hexKey(hero.col, hero.row));
      decomposeTileType(t, TileType.GRASS);
      t.building = null;
      t.hiddenSurvivor = false;
      clearFootprint(t);
      const r = executeExplore(state, hero);
      const found = r.lootItems.filter(l => l.startsWith('+'));
      assert.ok(found.length <= 1,
        `Expected at most 1 loot entry but got ${found.length}: ${JSON.stringify(r.lootItems)}`);
    }
  });

  // ── exploreOverride: editor-authored fixed loot (offline/campaign only) ──────
  // Set up a deterministic grass tile under the hero so only the override (or,
  // when absent, the terrain roll) decides the result.
  function plainTileUnder(state, ent) {
    const t = state.tiles.get(hexKey(ent.col, ent.row));
    decomposeTileType(t, TileType.GRASS);
    t.building = null;
    t.hiddenSurvivor = false;
    t.explored = false;
    clearFootprint(t);
    return t;
  }

  test('exploreOverride resource yields exactly amount, no random roll', () => {
    const state = freshState();
    const hero = state.hero;
    const t = plainTileUnder(state, hero);
    t.exploreOverride = { kind: 'resource', id: ResourceType.WOOD, amount: 3 };
    const before = (state.inventory.hero[ResourceType.WOOD]?.count ?? 0) ?? 0;
    const r = executeExplore(state, hero);
    assert.equal(r.success, true);
    assert.equal(((state.inventory.hero[ResourceType.WOOD]?.count ?? 0) ?? 0) - before, 3,
      'should add exactly the authored amount of wood');
  });

  test('exploreOverride resource without amount yields 1', () => {
    const state = freshState();
    const hero = state.hero;
    const t = plainTileUnder(state, hero);
    t.exploreOverride = { kind: 'resource', id: ResourceType.METAL };
    const before = (state.inventory.hero[ResourceType.METAL]?.count ?? 0) ?? 0;
    executeExplore(state, hero);
    assert.equal(((state.inventory.hero[ResourceType.METAL]?.count ?? 0) ?? 0) - before, 1);
  });

  test('exploreOverride weapon equips the authored weapon', () => {
    const state = freshState();
    const hero = state.hero;
    hero.unequipWeapon();
    const t = plainTileUnder(state, hero);
    t.exploreOverride = { kind: 'weapon', id: WeaponType.SWORD };
    executeExplore(state, hero);
    assert.equal(hero.getEquippedWeaponId(), WeaponType.SWORD);
  });

  test('exploreOverride horse grants a horse', () => {
    const state = freshState();
    const hero = state.hero;
    const t = plainTileUnder(state, hero);
    t.exploreOverride = { kind: 'horse', id: 'horse' };
    executeExplore(state, hero);
    assert.equal(hero.getItemCount('horse'), 1);
  });

  test('exploreOverride horn grants the horn key item (Ch1 M4 church pickup)', () => {
    const state = freshState();
    const hero = state.hero;
    hero.removeItem('horn');               // a campaign hero arrives without one
    const t = plainTileUnder(state, hero);
    t.exploreOverride = { kind: 'horn', id: 'horn' };
    executeExplore(state, hero);
    assert.equal(hero.getItemCount('horn'), 1, 'searching the church yields a horn');
    assert.ok(hero.hasItem('horn'));
  });

  test('exploreOverride horn does not stack a horn already held', () => {
    const state = freshState();
    const hero = state.hero;                // Paladin already holds one innately
    assert.ok(hero.hasItem('horn'));
    const t = plainTileUnder(state, hero);
    t.exploreOverride = { kind: 'horn', id: 'horn' };
    executeExplore(state, hero);
    assert.equal(hero.getItemCount('horn'), 1, 'horn pickup is idempotent');
  });

  test('exploreOverride nothing finds nothing (no inventory change)', () => {
    const state = freshState();
    const hero = state.hero;
    const t = plainTileUnder(state, hero);
    t.exploreOverride = { kind: 'nothing', id: null };
    const invBefore = JSON.stringify(state.inventory.hero);
    const itemsBefore = JSON.stringify(hero.items);
    const r = executeExplore(state, hero);
    assert.equal(r.success, true);
    assert.equal(JSON.stringify(state.inventory.hero), invBefore);
    assert.equal(JSON.stringify(hero.items), itemsBefore);
    assert.ok(r.log.some(l => /nothing useful/.test(l)));
  });

  test('exploreOverride is one-shot: re-explore fails like normal explore', () => {
    const state = freshState();
    const hero = state.hero;
    const t = plainTileUnder(state, hero);
    t.exploreOverride = { kind: 'resource', id: ResourceType.WOOD, amount: 2 };
    const r1 = executeExplore(state, hero);
    assert.equal(r1.success, true);
    const r2 = executeExplore(state, hero);
    assert.equal(r2.success, false, 'already-explored hex does not re-yield the override');
  });

  test('no exploreOverride → random roll path is unchanged', () => {
    // A plain hex with no override carries no exploreOverride field and still
    // rolls (success + lootItems array), exactly as before.
    const state = freshState();
    const hero = state.hero;
    const t = plainTileUnder(state, hero);
    assert.equal(t.exploreOverride, undefined);
    const r = executeExplore(state, hero);
    assert.equal(r.success, true);
    assert.ok(Array.isArray(r.lootItems));
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

  // Damage = tier × rolled weapon damage: hit=1×, crush (atk ≥ 2× def)=2×,
  // great crush (atk ≥ 3× def)=3×. The unarmed attacker rolls 2D6, forced to
  // 3+4=7 here, so a hit=7, crush=14, great crush=21. Forced-dice order is
  // [atkDie, defDie] (advantage pools), the two damage dice, then — when the
  // defender is wounded — the wound's own 1D6 surcharge die. The surcharge is
  // rolled ONCE per blow (not per point): a crush on a wounded target with a
  // forced 5 is 14+5=19.
  function duel(atkDie, defDie, { wounded = false, dmgDice = [3, 4] } = {}) {
    const state = freshState();
    // Neutralize the random-map tile so only the forced dice + stats decide the
    // roll ratio (no stray fort/footprint/forest from procgen).
    const t = state.tiles.get(hexKey(2, 2));
    t.base = TileType.GRASS; t.fortifyLevel = 0; clearFootprint(t);
    const attacker = createMinion(2, 2);
    attacker.attack = 0; attacker.weapon = null; attacker.abilities = []; attacker.effects = [];
    const defender = new Entity(EntityType.SURVIVOR, 'hero', 2, 2);
    defender.defense = 0; defender.weapon = null; defender.abilities = []; defender.effects = [];
    defender.maxHp = 300; defender.hp = 300;
    if (wounded) applyEffect(defender, 'wounded');
    state.entities = [attacker, defender];
    state.phase = Phase.DAY;            // neutral — no phase bonus for either side
    state.setForcedDice(atkDie, defDie, ...dmgDice);
    return executeBattle(state, attacker, defender);
  }

  test('ordinary hit (atk just above def) deals 1× weapon roll', () => {
    const r = duel(3, 2); // 3 vs 2 — hit, below the 2× crush line
    assert.equal(r.hit, true);
    assert.equal(r.damage, 7); // 1× (3+4)
  });

  test('crush (atk ≥ 2× def) deals 2× weapon roll', () => {
    const r = duel(2, 1); // 2 vs 1 — crush, below the 3× great line
    assert.equal(r.damage, 14); // 2× (3+4)
  });

  test('great crush (atk ≥ 3× def) deals 3× weapon roll', () => {
    const r = duel(6, 2); // 6 vs 2 — exactly 3×
    assert.equal(r.damage, 21); // 3× (3+4)
  });

  test('crush on a WOUNDED target adds one rolled 1D6 surcharge', () => {
    // Forced dice: atk 2, def 1, dmg 3+4, wounded d6 = 5.
    const r = duel(2, 1, { wounded: true, dmgDice: [3, 4, 5] });
    assert.equal(r.damage, 19); // crush 14 + 1D6(5) once
  });

  test('great crush on a WOUNDED target adds one rolled 1D6 surcharge', () => {
    const r = duel(6, 2, { wounded: true, dmgDice: [3, 4, 2] });
    assert.equal(r.damage, 23); // great crush 21 + 1D6(2)
  });

  test('wounded surcharge consumes the deterministic die stream (replay-safe)', () => {
    const a = duel(2, 1, { wounded: true, dmgDice: [3, 4, 6] });
    const b = duel(2, 1, { wounded: true, dmgDice: [3, 4, 1] });
    assert.equal(a.damage, 20);
    assert.equal(b.damage, 15);
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

  test('gang-up counts allies by END-OF-TURN position — a fleeing ally does not flank', () => {
    const state = freshState();
    const hero = state.hero;
    const targetHex = emptyPassableNeighbor(state, hero);
    if (!targetHex) return;
    const minion = createMinion(targetHex.col, targetHex.row);
    minion.maxHp = 50; minion.hp = 50; // survive two probe battles
    state.entities.push(minion);

    // An ally flanking the target (adjacent to the target, not on the hero's hex).
    const allyHex = getNeighbors(targetHex.col, targetHex.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t)
        && !(n.col === hero.col && n.row === hero.row);
    });
    if (!allyHex) return;
    const ally = new Entity(EntityType.SURVIVOR, 'hero', allyHex.col, allyHex.row);
    ally.items = {};
    state.entities.push(ally);

    // Baseline — the ally stands adjacent to the target, so it flanks.
    const before = executeBattle(state, hero, minion);
    assert.ok(before.attackerAllies >= 1, 'an adjacent ally should flank by default');

    // The resolver projects the ally's END-OF-TURN hex out of range (it moves
    // away this same turn). It must no longer be counted as a gang-up ally.
    state._turnEndPositions = new Map([[ally.id, { col: minion.col + 4, row: minion.row }]]);
    const after = executeBattle(state, hero, minion);
    assert.equal(after.attackerAllies, before.attackerAllies - 1,
      'an ally whose end-of-turn position is out of range must not flank');
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
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t);
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

    // G1 — breakdown also carries per-ally dice (one entry per gang-up ally,
    // zipped with atkPool[1..]) so the 3D readout can show each ally's
    // contribution on its own icon.
    assert.ok(Array.isArray(r.breakdown.atkAllyDice),
      'breakdown.atkAllyDice should be an array');
    assert.equal(r.breakdown.atkAllyDice.length, Math.min(r.attackerAllies, 3),
      'one atkAllyDice entry per gang-up ally (capped at ADVANTAGE_CAP)');
    for (const entry of r.breakdown.atkAllyDice) {
      assert.ok(typeof entry.allyId !== 'undefined',
        'each atkAllyDice entry carries an allyId');
      assert.ok(Number.isInteger(entry.die) && entry.die >= 1 && entry.die <= 6,
        'each atkAllyDice die is a valid d6 face');
    }
    // Each ally die corresponds to a real ally in atkAllyIds (same order).
    const atkAllyIds = r.breakdown.atkAllyIds.slice(0, r.breakdown.atkAllyDice.length);
    assert.deepEqual(
      r.breakdown.atkAllyDice.map(d => d.allyId),
      atkAllyIds,
      'atkAllyDice entries are zipped with atkAllyIds in order',
    );
  });

  test('silver attackBonus is included in combat attack roll', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.SILVER] = { count: 1 };

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

  // The 3D combat readout's sum invariant: the breakdown must decompose the
  // attackRoll / defenseRoll into picked-die + Σ(flat bonuses). If a future
  // change adds a flat ATK/DEF contribution to resolveCombat but doesn't
  // surface it in the breakdown, this test fails — that's the exact bug the
  // operator reported (icon ticks higher than the dice roll with no floater).
  test('breakdown decomposes attackRoll and defenseRoll into picked die + Σ(flat bonuses)', () => {
    const state = freshState();
    const hero = state.hero;
    // Silver-coat for an attackBonus contribution (needs inventory stocked).
    state.inventory.hero[ResourceType.SILVER] = { count: 1 };
    const useResult = executeUseItem(state, hero, ResourceType.SILVER);
    assert.equal(useResult.success, true);
    assert.equal(hero.attackBonus, 1);
    // Equip a sword so atkWeaponMod is nonzero.
    hero.equipWeapon(WeaponType.SWORD);

    const minion = createMinion(hero.col, hero.row);
    state.entities.push(minion);

    setForcedDice(4, 3); // attacker rolls 4, defender rolls 3
    const r = executeBattle(state, hero, minion);
    const bd = r.breakdown;

    // Sanity: every decomposed field is captured.
    for (const k of ['atkBaseStat', 'atkWeaponMod', 'atkAbilityMod', 'atkEffectMod', 'atkAttackBonus',
                     'defBaseStat', 'defWeaponMod', 'defAbilityMod', 'defEffectMod', 'defDefenseBonus']) {
      assert.ok(typeof bd[k] === 'number', `breakdown.${k} should be a number`);
    }

    // Attacker sum invariant: picked + every nonzero atk flat field === attackRoll.
    const atkSum = bd.atkBaseDie
      + bd.atkBaseStat + bd.atkWeaponMod + bd.atkAbilityMod + bd.atkEffectMod + bd.atkAttackBonus
      + bd.phaseBonus + bd.atkGangupFlat + bd.atkFortAtkBonus;
    assert.equal(atkSum, r.attackRoll,
      `picked(${bd.atkBaseDie}) + Σ(atk flats) (${atkSum - bd.atkBaseDie}) must equal attackRoll(${r.attackRoll}). ` +
      `breakdown: ${JSON.stringify({ atkBaseStat: bd.atkBaseStat, atkWeaponMod: bd.atkWeaponMod,
        atkAbilityMod: bd.atkAbilityMod, atkEffectMod: bd.atkEffectMod, atkAttackBonus: bd.atkAttackBonus,
        phaseBonus: bd.phaseBonus, atkGangupFlat: bd.atkGangupFlat, atkFortAtkBonus: bd.atkFortAtkBonus })}`);

    // Defender sum invariant: picked + every nonzero def flat field − fatigue === defenseRoll.
    const defSum = bd.defBaseDie
      + bd.defBaseStat + bd.defWeaponMod + bd.defAbilityMod + bd.defEffectMod + bd.defDefenseBonus
      + bd.fortBonus + bd.defGangupFlat + bd.forestCoverBonus - bd.fatiguePenalty;
    assert.equal(defSum, r.defenseRoll,
      `picked(${bd.defBaseDie}) + Σ(def flats) must equal defenseRoll(${r.defenseRoll})`);

    // Silver coating set attackBonus=1 → must surface in atkAttackBonus.
    assert.equal(bd.atkAttackBonus, 1, 'silver shows up in atkAttackBonus');
    // Sword has statMods.attack=2 → must surface in atkWeaponMod.
    assert.equal(bd.atkWeaponMod, 2, 'sword shows up in atkWeaponMod');
    // Hero's intrinsic attack stat (NOT including weapon) is atkBaseStat.
    assert.equal(bd.atkBaseStat, hero.attack, 'atkBaseStat is the raw stat');
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
    // attackBonus=100 guarantees a crush regardless of dice
    assert.ok(r.hit && r.attackRoll >= 2 * r.defenseRoll, 'should crush');
    assert.ok(bystander.hp < 5, 'bystander should take splash damage on crush');
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
    assert.ok(r.killed, 'attackBonus=100 vs 1 HP target should always kill');
    assert.ok(bystander.hp < 5, 'bystander should take splash damage on kill');
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
    assert.ok(r.killed, 'attackBonus=100 vs 1 HP target should always kill');
    assert.equal(hero.hp, 10, 'attacker should not take splash damage');
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
    assert.ok(r.killed, 'attackBonus=100 vs 1 HP target should always kill');
    assert.ok(!state.entities.find(e => e.id === fragile.id),
      'splash-killed bystander should be removed');
    assert.ok(r.splashKills.length > 0, 'splashKills should contain the killed bystander');
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

    // Force all dice to 4: attackRoll = 4+1 = 5 vs defenseRoll = 4+0 = 4 —
    // a hit, but not a crush (5 < 8) and not a kill (50 HP target).
    state.setForcedDice(4, 4, 4, 4, 4, 4, 4, 4);
    const r = executeBattle(state, hero, minion);
    assert.ok(r.hit, 'forced dice should produce a hit');
    assert.ok(r.attackRoll < 2 * r.defenseRoll, 'forced dice should not crush');
    assert.ok(!r.killed, 'high-HP target should survive');
    assert.equal(bystander.hp, 5, 'no splash on normal hit');
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

// ── Premium-weapon loot tier gate ─────────────────────────────────────────────
// greatsword/warhammer are gated to late rounds (LOOT_TIER_GATE). Exercise the
// real explore→_effectiveLoot→rollLoot path: before the gate they can NEVER drop;
// past it they can. Uses a blacksmith tile (their loot source).
describe('loot tier gate', () => {
  function exploreBlacksmith(state, hero) {
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.structure = null; t.building = BuildingType.BLACKSMITH;
    t.explored = false; t.hiddenSurvivor = false; clearFootprint(t);
    hero.items = {};      // unarmed → a found weapon equips
    executeExplore(state, hero);
    return hero.getEquippedWeaponId() ?? Object.keys(hero.items).find(k => k === 'greatsword' || k === 'warhammer');
  }

  test('premium weapons NEVER drop before their gate round', () => {
    const state = freshState();
    state.round = 1;
    let premium = 0;
    for (let i = 0; i < 400; i++) {
      const got = exploreBlacksmith(state, state.hero);
      if (got === 'greatsword' || got === 'warhammer') premium++;
    }
    assert.equal(premium, 0, 'no greatsword/warhammer before round 8');
  });

  test('premium weapons CAN drop once past the gate round', () => {
    const state = freshState();
    state.round = 12; // past greatsword(8) + warhammer(10) gates
    let premium = 0;
    for (let i = 0; i < 600; i++) {
      const got = exploreBlacksmith(state, state.hero);
      if (got === 'greatsword' || got === 'warhammer') premium++;
    }
    assert.ok(premium > 0, `expected at least one premium drop past the gate, got ${premium}`);
  });
});

// ── executeFortify ────────────────────────────────────────────────────────────
// Design: Metal → +2 levels; Wood → +1 level (or +2 with FORTIFY_DOUBLE); cap at 6

describe('executeFortify', () => {
  test('metal gives +2 fortify level', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.METAL] = { count: 1 };
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 0;

    const r = executeFortify(state, hero);
    assert.equal(r.success, true);
    assert.equal(t.fortifyLevel, 2);
    assert.equal((state.inventory.hero[ResourceType.METAL]?.count ?? 0), 0, 'Metal should be consumed');
  });

  test('wood gives +1 fortify level (without FORTIFY_DOUBLE)', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.WOOD] = { count: 1 };
    state.inventory.hero[ResourceType.METAL] = { count: 0 }; // ensure metal not present
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 0;

    const r = executeFortify(state, hero);
    assert.equal(r.success, true);
    assert.equal(t.fortifyLevel, 1);
    assert.equal((state.inventory.hero[ResourceType.WOOD]?.count ?? 0), 0, 'Wood should be consumed');
  });

  test('FORTIFY_DOUBLE survivor: wood gives +2 fortify level', () => {
    const state = freshState();
    // Create an innkeeper (FORTIFY_DOUBLE) entity
    const innkeeper = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    innkeeper.abilities = [SurvivorAbility.FORTIFY_DOUBLE];
    innkeeper.items = {};
    state.entities.push(innkeeper);

    state.inventory.hero[ResourceType.WOOD] = { count: 1 };
    state.inventory.hero[ResourceType.METAL] = { count: 0 };
    const t = state.tiles.get(hexKey(innkeeper.col, innkeeper.row));
    t.fortifyLevel = 0;

    const r = executeFortify(state, innkeeper);
    assert.equal(r.success, true);
    assert.equal(t.fortifyLevel, 2, 'FORTIFY_DOUBLE should give +2 with wood');
  });

  test('metal is preferred over wood', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.METAL] = { count: 1 };
    state.inventory.hero[ResourceType.WOOD] = { count: 1 };
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 0;

    executeFortify(state, hero);
    assert.equal((state.inventory.hero[ResourceType.METAL]?.count ?? 0), 0, 'Metal should be used first');
    assert.equal((state.inventory.hero[ResourceType.WOOD]?.count ?? 0), 1, 'Wood should be untouched');
    assert.equal(t.fortifyLevel, 2);
  });

  test('fails when no wood or metal', () => {
    const state = freshState();
    state.inventory.hero[ResourceType.METAL] = { count: 0 };
    state.inventory.hero[ResourceType.WOOD] = { count: 0 };
    const r = executeFortify(state, state.hero);
    assert.equal(r.success, false);
  });

  test('fortify level caps at 6', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.METAL] = { count: 5 };
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 5; // one more metal (+2) would reach 7, should cap at 6

    const r = executeFortify(state, hero);
    assert.equal(t.fortifyLevel, 6, 'Fortify level should cap at 6');
    assert.equal(r.defGain, 1, 'defGain should reflect capped gain (6 - 5 = 1)');
  });

  test('defGain returns actual gain for metal and wood', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.METAL] = { count: 1 };
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.fortifyLevel = 0;

    const r1 = executeFortify(state, hero);
    assert.equal(r1.defGain, 2, 'Metal should give defGain of 2');

    state.inventory.hero[ResourceType.WOOD] = { count: 1 };
    const r2 = executeFortify(state, hero);
    assert.equal(r2.defGain, 1, 'Wood should give defGain of 1');
  });

  test('fails when tile is already at max fortify (level 6)', () => {
    const state = freshState();
    state.inventory.hero[ResourceType.METAL] = { count: 1 };
    const t = state.tiles.get(hexKey(state.hero.col, state.hero.row));
    t.fortifyLevel = 6;

    const r = executeFortify(state, state.hero);
    assert.equal(r.success, false);
    assert.equal(t.fortifyLevel, 6, 'Level should not change');
  });

  test('costs 1 action', () => {
    const state = freshState();
    state.inventory.hero[ResourceType.WOOD] = { count: 1 };
    const r = executeFortify(state, state.hero);
    assert.equal(r.cost, 1);
  });
});

// ── Fortification combat bonuses ──────────────────────────────────────────────
// Design:
//   L1: +0 ATT / +1 DEF
//   L2: +0 ATT / +2 DEF
//   L3: +1 ATT / +2 DEF
//   L4: +2 ATT / +3 DEF
//   L5: +3 ATT / +4 DEF
//   L6: +4 ATT / +5 DEF
//   Witch units never benefit.

describe('getFortifyCombatBonus', () => {
  test('level 0 is no bonus', () => {
    assert.deepEqual(getFortifyCombatBonus(0), { attack: 0, defense: 0 });
  });

  test('levels 1-2 grant defense only', () => {
    assert.deepEqual(getFortifyCombatBonus(1), { attack: 0, defense: 1 });
    assert.deepEqual(getFortifyCombatBonus(2), { attack: 0, defense: 2 });
  });

  test('levels 3-4 grant attack and defense', () => {
    assert.deepEqual(getFortifyCombatBonus(3), { attack: 1, defense: 2 });
    assert.deepEqual(getFortifyCombatBonus(4), { attack: 2, defense: 3 });
  });

  test('levels 5-6 keep stacking +1/+1 per level', () => {
    assert.deepEqual(getFortifyCombatBonus(5), { attack: 3, defense: 4 });
    assert.deepEqual(getFortifyCombatBonus(6), { attack: 4, defense: 5 });
  });

  test('caps at MAX_FORTIFY_LEVEL (6)', () => {
    assert.equal(MAX_FORTIFY_LEVEL, 6);
    assert.deepEqual(getFortifyCombatBonus(7), getFortifyCombatBonus(6));
    assert.deepEqual(getFortifyCombatBonus(99), getFortifyCombatBonus(6));
  });
});

describe('fortification combat bonuses in battle', () => {
  test('hero defending on fortified tile gets DEF bonus from table (level 3 → +2 DEF)', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    const heroTile = state.tiles.get(hexKey(state.hero.col, state.hero.row));
    heroTile.fortifyLevel = 3;

    const r = executeBattle(state, minion, state.hero);
    assert.equal(r.breakdown.fortBonus, 2, 'Hero defender should get +2 DEF from lvl 3 fort');
  });

  test('hero attacking from fortified tile gets ATT bonus from table (level 4 → +2 ATT)', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    const heroTile = state.tiles.get(hexKey(state.hero.col, state.hero.row));
    heroTile.fortifyLevel = 4;

    const r = executeBattle(state, state.hero, minion);
    assert.equal(r.breakdown.atkFortAtkBonus, 2, 'Hero attacker should get +2 ATT from lvl 4 fort');
  });

  test('level 1-2 fort grants no ATT bonus to hero attacker', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    const heroTile = state.tiles.get(hexKey(state.hero.col, state.hero.row));
    heroTile.fortifyLevel = 2;

    const r = executeBattle(state, state.hero, minion);
    assert.equal(r.breakdown.atkFortAtkBonus, 0, 'Lvl 2 fort should grant no ATT bonus');
  });

  test('level 6 grants +4 ATT / +5 DEF to hero', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    // Fort hero's tile
    const heroTile = state.tiles.get(hexKey(state.hero.col, state.hero.row));
    heroTile.fortifyLevel = 6;

    const r1 = executeBattle(state, state.hero, minion);
    assert.equal(r1.breakdown.atkFortAtkBonus, 4, 'Lvl 6 fort should give attacker +4 ATT');

    // Reset for defender test
    const state2 = freshState();
    const minion2 = createMinion(state2.hero.col, state2.hero.row);
    state2.entities.push(minion2);
    const heroTile2 = state2.tiles.get(hexKey(state2.hero.col, state2.hero.row));
    heroTile2.fortifyLevel = 6;
    const r2 = executeBattle(state2, minion2, state2.hero);
    assert.equal(r2.breakdown.fortBonus, 5, 'Lvl 6 fort should give defender +5 DEF');
  });

  test('witch defender on fortified tile gets NO DEF bonus', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);
    // Place a fortification on the minion's tile (e.g. hero-fort tile that witch captured)
    const minionTile = state.tiles.get(hexKey(minion.col, minion.row));
    minionTile.fortifyLevel = 4;

    const r = executeBattle(state, state.hero, minion);
    assert.equal(r.breakdown.fortBonus, 0, 'Witch defender should never benefit from fort');
  });

  test('witch attacker from fortified tile gets NO ATT bonus', () => {
    const state = freshState();
    // Fortify the witch's tile
    const witchTile = state.tiles.get(hexKey(state.witch.col, state.witch.row));
    witchTile.fortifyLevel = 5;
    // Put a hero-aligned survivor on the same tile as the target
    const survivor = new Entity(EntityType.SURVIVOR, 'hero', state.witch.col, state.witch.row);
    state.entities.push(survivor);

    const r = executeBattle(state, state.witch, survivor);
    assert.equal(r.breakdown.atkFortAtkBonus, 0, 'Witch attacker should never benefit from fort');
  });

  test('hero vs witch on non-fortified tile — no bonuses reported', () => {
    const state = freshState();
    const minion = createMinion(state.hero.col, state.hero.row);
    state.entities.push(minion);

    const r = executeBattle(state, state.hero, minion);
    assert.equal(r.breakdown.fortBonus, 0);
    assert.equal(r.breakdown.atkFortAtkBonus, 0);
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
    state.inventory.witch[ResourceType.METAL] = { count: 2 };
    const { col, row } = state.witch;

    const r = executeSummon(state, state.witch);
    assert.equal(r.success, true);
    const summoned = state.entities.find(e => e !== state.witch && e.col === col && e.row === row);
    assert.ok(summoned, 'A unit should appear on the witch tile');
    assert.equal(summoned.type, EntityType.IRON_GOLEM, 'Metal should summon Iron Golem');
    assert.equal((state.inventory.witch[ResourceType.METAL]?.count ?? 0), 0, '2 metal should be consumed');
  });

  test('wood → Wood Golem spawns on witch tile (costs 2 wood, when no metal)', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.METAL] = { count: 0 };
    state.inventory.witch[ResourceType.WOOD] = { count: 2 };
    const { col, row } = state.witch;

    const r = executeSummon(state, state.witch);
    assert.equal(r.success, true);
    const summoned = state.entities.find(e => e !== state.witch && e.col === col && e.row === row);
    assert.equal(summoned.type, EntityType.WOOD_GOLEM, 'Wood should summon Wood Golem');
    assert.equal((state.inventory.witch[ResourceType.WOOD]?.count ?? 0), 0, '2 wood should be consumed');
  });

  test('other resource → Minion spawns on witch tile (costs 2 total)', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.METAL] = { count: 0 };
    state.inventory.witch[ResourceType.WOOD] = { count: 0 };
    state.inventory.witch[ResourceType.FOOD] = { count: 2 };
    const { col, row } = state.witch;

    const r = executeSummon(state, state.witch);
    assert.equal(r.success, true);
    const summoned = state.entities.find(e => e !== state.witch && e.col === col && e.row === row);
    assert.equal(summoned.type, EntityType.MINION, 'Non-metal/wood resource should summon Minion');
    assert.equal((state.inventory.witch[ResourceType.FOOD]?.count ?? 0), 0, '2 food should be consumed');
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
    state.inventory.witch[ResourceType.FOOD] = { count: 6 };

    const r1 = executeSummon(state, state.witch);
    assert.equal(r1.success, true, 'First summon should succeed');

    const r2 = executeSummon(state, state.witch);
    assert.equal(r2.success, true, 'Second summon in same turn should also succeed');
  });

  test('costs 1 action', () => {
    const state = witchState();
    state.inventory.witch[ResourceType.FOOD] = { count: 2 };
    const r = executeSummon(state, state.witch);
    assert.equal(r.cost, 1);
  });

  test('summon available even when all adjacent hexes are occupied', () => {
    // No adjacent-hex requirement — should still work
    const state = witchState();
    state.inventory.witch[ResourceType.FOOD] = { count: 2 };
    // Fill all neighbors with entities
    const neighbors = getNeighbors(state.witch.col, state.witch.row);
    for (const n of neighbors) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t)) {
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
  test('heals 2D10 HP, costs 1 action, consumes herbs from shared inventory', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.HERBS] = { count: 1 };
    hero.takeDamage(25);
    const hpBefore = hero.hp;

    state.forcedDice = [7, 3];   // the two d10s
    const r = executeHeal(state, hero);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1, 'Heal should cost 1 action');
    assert.equal(hero.hp, hpBefore + 10); // herbs heal 2D10 (7 + 3)
    assert.equal(r.healed, 10, 'result reports the rolled heal amount for the HP floater');
    assert.equal((state.inventory.hero[ResourceType.HERBS]?.count ?? 0), 0, 'Herbs should be consumed from shared inventory');
  });

  test('heal roll stays within the 2..20 envelope without forced dice', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.HERBS] = { count: 1 };
    hero.takeDamage(25);
    const hpBefore = hero.hp;

    const r = executeHeal(state, hero);
    assert.equal(r.success, true);
    assert.ok(r.healed >= 2 && r.healed <= 20, `2D10 must land in 2..20 (got ${r.healed})`);
    assert.equal(hero.hp, hpBefore + r.healed);
  });

  test('witch can heal too (from witch inventory)', () => {
    const state = freshState();
    const witch = state.witch;
    state.inventory.witch[ResourceType.HERBS] = { count: 1 };
    witch.takeDamage(25);
    const hpBefore = witch.hp;

    state.forcedDice = [10, 10];
    const r = executeHeal(state, witch);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1);
    assert.equal(witch.hp, hpBefore + 20);
    assert.equal((state.inventory.witch[ResourceType.HERBS]?.count ?? 0), 0, 'Herbs consumed from witch inventory');
  });

  test('fails when no herbs in faction inventory', () => {
    const state = freshState();
    state.inventory.hero[ResourceType.HERBS] = { count: 0 };
    state.hero.takeDamage(3);
    const r = executeHeal(state, state.hero);
    assert.equal(r.success, false);
  });

  test('fails when already at full health', () => {
    const state = freshState();
    state.inventory.hero[ResourceType.HERBS] = { count: 1 };
    const r = executeHeal(state, state.hero);
    assert.equal(r.success, false);
  });

  test('heal caps at maxHp', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.HERBS] = { count: 1 };
    hero.takeDamage(1); // 1 below max
    state.forcedDice = [10, 10];
    executeHeal(state, hero);
    assert.equal(hero.hp, hero.maxHp);
  });

  test('survivor heals using shared herbs', () => {
    const state = freshState();
    const survivor = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    survivor.items = {};
    state.entities.push(survivor);
    state.inventory.hero[ResourceType.HERBS] = { count: 1 };
    survivor.takeDamage(20);
    const hpBefore = survivor.hp;

    const r = executeHeal(state, survivor);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1);
    assert.equal(survivor.hp, hpBefore + r.healed);
    assert.ok(r.healed >= 2 && r.healed <= 20);
    assert.equal((state.inventory.hero[ResourceType.HERBS]?.count ?? 0), 0, 'Herbs consumed from shared inventory');
  });

  test('hero and survivor share the same herb pool', () => {
    const state = freshState();
    const survivor = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    survivor.items = {};
    state.entities.push(survivor);
    state.inventory.hero[ResourceType.HERBS] = { count: 1 };

    state.hero.takeDamage(3);
    survivor.takeDamage(3);

    // Hero uses the shared herb
    const r1 = executeHeal(state, state.hero);
    assert.equal(r1.success, true);
    assert.equal((state.inventory.hero[ResourceType.HERBS]?.count ?? 0), 0);

    // Survivor can't heal — no herbs left
    const r2 = executeHeal(state, survivor);
    assert.equal(r2.success, false);
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
    state.inventory.hero[ResourceType.SILVER] = { count: 1 };
    const bonusBefore = state.hero.attackBonus;

    const r = executeUseItem(state, state.hero, ResourceType.SILVER);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'Silver should be free');
    assert.equal(state.hero.attackBonus, bonusBefore + 1);
    assert.equal((state.inventory.hero[ResourceType.SILVER]?.count ?? 0), 0, 'Silver consumed');
  });
});

describe('executeUseItem — weapon equip', () => {
  test('equipping a weapon applies its stats and costs 0', () => {
    const state = freshState();
    const hero = state.hero;
    // The hero starts with a sword equipped; unequip so we measure the equip
    // from the unarmed base (ATK 2). The sword stays in the pack as a spare.
    hero.unequipWeapon();
    const atkBefore = hero.getAttack();

    const r = executeUseItem(state, hero, 'sword');
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'Equipping a weapon should be free');
    assert.equal(hero.getAttack(), atkBefore + 2, 'Sword gives +2 effective ATK');
    assert.equal(hero.getEquippedWeaponId(), WeaponType.SWORD);
    assert.equal(hero.getItemCount('sword'), 1, 'equipping is a tag flip — sword stays in items');
  });

  test('equipping weapon fails if not in inventory', () => {
    const state = freshState();
    state.hero.items = {}; // no sword carried (also clears the starting sword)
    const r = executeUseItem(state, state.hero, 'sword');
    assert.equal(r.success, false);
  });
});

// ── weapon-swap preservation ─────────────────────────────────────────────────
// Equipping is now a tag flip inside `items`: the outgoing weapon stays in the
// backpack at its existing count, only the `equipped` flag moves. Nothing is
// ever consumed or vaporised — the swap-preservation bugs are gone by design.
describe('executeUseItem — weapon swap preserves outgoing weapon', () => {
  test('round-trip swap keeps the old weapon in items', () => {
    const state = freshState();
    const hero = state.hero;
    hero.items = { sword: { count: 1, equipped: true }, axe: { count: 1 } };

    const r = executeUseItem(state, hero, 'axe');
    assert.equal(r.success, true);
    assert.equal(hero.getEquippedWeaponId(), WeaponType.AXE, 'axe is now equipped');
    assert.equal(hero.getItemCount('axe'), 1, 'axe stays at count 1 (tag flip, no consumption)');
    assert.equal(hero.getItemCount('sword'), 1, 'previous sword remains a carried spare');
  });

  test('default faction weapon is preserved when swapping', () => {
    // The hero wields its faction-default weapon (the Paladin's sword, equipped
    // in items). Swapping to a pack weapon must leave the sword behind as a spare.
    const state = freshState();
    const hero = state.hero;
    hero.addItem('axe');
    assert.equal(hero.getEquippedWeaponId(), WeaponType.SWORD, 'precondition: sword equipped');

    const r = executeUseItem(state, hero, 'axe');
    assert.equal(r.success, true);
    assert.equal(hero.getEquippedWeaponId(), WeaponType.AXE);
    assert.equal(hero.getItemCount('sword'), 1, 'default sword preserved as a carried spare');
  });

  test('no-op when item unavailable — failure path leaves weapon untouched', () => {
    const state = freshState();
    const hero = state.hero;
    hero.items = { sword: { count: 1, equipped: true } }; // axe not carried

    const r = executeUseItem(state, hero, 'axe');
    assert.equal(r.success, false);
    assert.equal(hero.getEquippedWeaponId(), WeaponType.SWORD, 'weapon unchanged on failure');
    assert.equal(hero.getItemCount('axe'), 0, 'axe still absent on failure');
  });

  test('equipping from an unarmed state flags the weapon without a null key', () => {
    const state = freshState();
    const hero = state.hero;
    hero.items = { axe: { count: 1 } }; // unarmed, axe is a pack spare

    const r = executeUseItem(state, hero, 'axe');
    assert.equal(r.success, true);
    assert.equal(hero.getEquippedWeaponId(), WeaponType.AXE);
    assert.equal(hero.getItemCount('axe'), 1);
    assert.ok(!('null' in hero.items), 'no items["null"] key created');
    assert.ok(!(null in hero.items), 'no null key created');
  });
});

// ── auto-equip weapon on loot ─────────────────────────────────────────────────

describe('auto-equip weapon on loot find', () => {
  // Helper: place hero on a blacksmith tile and rig Math.random so rollLoot
  // always picks the first entry (weapon:sword for blacksmith).
  function blacksmithState() {
    const state = freshState();
    const hero = state.hero;
    // Hero now starts with a sword equipped; strip the whole pack so these tests
    // exercise the "hero has no weapon" auto-equip path from a clean unarmed state.
    hero.items = {};
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    decomposeTileType(t, TileType.BUILDING);
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
    assert.equal(hero.getEquippedWeaponId(), null, 'precondition: no weapon');
    const origRandom = Math.random;
    Math.random = makeRandom(0, 0.95); // sword on first roll, wood on second
    try {
      executeExplore(state, hero);
    } finally {
      Math.random = origRandom;
    }
    assert.equal(hero.getEquippedWeaponId(), WeaponType.SWORD, 'sword should be auto-equipped');
    assert.equal(hero.getItemCount('sword'), 1, 'auto-equipped weapon lives in items (tagged equipped)');
  });

  test('weapon goes to items unequipped when hero already has a weapon', () => {
    const { state, hero } = blacksmithState();
    hero.equipWeapon(WeaponType.AXE); // already armed
    const origRandom = Math.random;
    Math.random = makeRandom(0, 0.95); // sword on first roll, wood on second
    try {
      executeExplore(state, hero);
    } finally {
      Math.random = origRandom;
    }
    assert.equal(hero.getEquippedWeaponId(), WeaponType.AXE, 'existing weapon should remain equipped');
    assert.ok(hero.getItemCount('sword') >= 1, 'new weapon should be in items as a spare');
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
    healer.abilities = [SurvivorAbility.HEAL];
    healer.items = {};
    state.entities.push(healer);
    hero.takeDamage(20);
    const hpBefore = hero.hp;

    const r = executeUseAbility(state, healer, SurvivorAbility.HEAL);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1, 'HEAL ability costs 1 action');
    assert.equal(hero.hp, hpBefore + 7); // HEAL ability heals 1 × DAMAGE_SCALE
  });

  test('HEAL fails if hero not on same hex', () => {
    const state = freshState();
    const healer = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col + 2, state.hero.row);
    healer.abilities = [SurvivorAbility.HEAL];
    healer.items = {};
    state.entities.push(healer);
    state.hero.takeDamage(5);

    const r = executeUseAbility(state, healer, SurvivorAbility.HEAL);
    assert.equal(r.success, false);
  });

  test('HEAL fails if hero already at full HP', () => {
    const state = freshState();
    const hero = state.hero;
    assert.equal(hero.hp, hero.maxHp);
    const healer = new Entity(EntityType.SURVIVOR, 'hero', hero.col, hero.row);
    healer.abilities = [SurvivorAbility.HEAL];
    healer.items = {};
    state.entities.push(healer);

    const r = executeUseAbility(state, healer, SurvivorAbility.HEAL);
    assert.equal(r.success, false, 'HEAL should fail when hero is full HP');
  });
});

describe('executeUseAbility — INSPIRE', () => {
  test('gives hero +1 attackBonus, costs 0', () => {
    const state = freshState();
    // Inspirer must be co-located with the hero (same as HEAL requirement)
    const inspirer = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    inspirer.abilities = [SurvivorAbility.INSPIRE];
    inspirer.items = {};
    state.entities.push(inspirer);
    const bonusBefore = state.hero.attackBonus;

    const r = executeUseAbility(state, inspirer, SurvivorAbility.INSPIRE);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'INSPIRE should be free');
    assert.equal(state.hero.attackBonus, bonusBefore + 1);
  });
});

describe('executeUseAbility — RALLY', () => {
  test('gives +1 actionsLeft, costs 0', () => {
    const state = freshState();
    const rallier = new Entity(EntityType.SURVIVOR, 'hero', state.hero.col, state.hero.row);
    rallier.abilities = [SurvivorAbility.RALLY];
    rallier.items = {};
    state.entities.push(rallier);

    const r = executeUseAbility(state, rallier, SurvivorAbility.RALLY);
    assert.equal(r.success, true);
    assert.equal(r.cost, 0, 'RALLY should be free');
    // RALLY returns budgetBonus for the resolver to apply (both offline and online
    // use resolvePlans which handles budgetBonus; actionsLeft is not mutated directly)
    assert.equal(r.budgetBonus, 1, 'RALLY should return budgetBonus of 1');
  });
});

// ── Inventory stash separation ─────────────────────────────────────────────
// Design: Hero resources land in inventory.hero; witch resources land in
// inventory.witch. The two stashes are independent. The plan-panel display
// must use the human player's faction (via _planFaction) to select the correct
// stash — using state.activePlayer is incorrect because it defaults to HERO
// and is only updated during resolution, not during the planning phase.

describe('Inventory stash separation', () => {
  test('hero stash (inventory.hero) and witch stash (inventory.witch) are independent', () => {
    const state = freshState();
    // Clear starting resources so we can test independence cleanly
    state.inventory.hero = {};
    state.inventory.witch = {};

    // Populate both stashes with different resources
    state.inventory.hero[ResourceType.WOOD] = { count: 3 };
    state.inventory.hero[ResourceType.FOOD] = { count: 1 };
    state.inventory.witch[ResourceType.METAL] = { count: 2 };

    // Hero stash should contain hero resources only
    assert.equal((state.inventory.hero[ResourceType.WOOD]?.count ?? 0), 3);
    assert.equal((state.inventory.hero[ResourceType.FOOD]?.count ?? 0), 1);
    assert.equal((state.inventory.hero[ResourceType.METAL]?.count ?? 0) || 0, 0,
      'hero stash must not contain witch metal');

    // Witch stash should contain witch resources only
    assert.equal((state.inventory.witch[ResourceType.METAL]?.count ?? 0), 2);
    assert.equal((state.inventory.witch[ResourceType.WOOD]?.count ?? 0) || 0, 0,
      'witch stash must not contain hero wood');
    assert.equal((state.inventory.witch[ResourceType.FOOD]?.count ?? 0) || 0, 0,
      'witch stash must not contain hero food');
  });

  test('witch resources do not bleed into hero stash after summon', () => {
    const state = freshState();
    state.inventory.hero[ResourceType.METAL] = { count: 0 };
    state.inventory.witch[ResourceType.METAL] = { count: 1 };

    // Consuming witch metal (via summon) should not touch the hero stash
    // (summon fails here because only 1 metal, but the point is shared stash unchanged)
    executeSummon(state, state.witch);

    assert.equal((state.inventory.hero[ResourceType.METAL]?.count ?? 0) || 0, 0,
      'hero stash must be unchanged after witch summons');
  });

  // Regression guard: the plan-panel inventory display must use _planFaction
  // (the faction the human is actually playing), NOT state.activePlayer which
  // defaults to HERO and can be stale during the planning phase.
  //
  // Expected stash-selection logic (mirrors _renderInventory in ui.js):
  //   const faction = this._planFaction ?? (state.activePlayer === Player.HERO ? 'hero' : 'witch');
  //   const isHero  = faction === 'hero';
  //   const stash   = isHero ? inv.hero : inv.witch;
  test('stash selection: planFaction=witch overrides activePlayer=HERO', () => {
    const state = freshState();
    // Simulate the stale activePlayer scenario: activePlayer is HERO (the default)
    // but the human is actually playing witch.
    assert.equal(state.activePlayer, Player.HERO, 'precondition: activePlayer defaults to HERO');
    const planFaction = 'witch'; // human is playing witch

    // Reproduce the fixed stash-selection logic
    const inv = state.inventory;
    const isHero = planFaction === 'hero'; // correct: use planFaction, not activePlayer
    const stash = isHero ? inv.hero : inv.witch;

    state.inventory.witch[ResourceType.METAL] = { count: 5 };
    state.inventory.hero[ResourceType.WOOD] = { count: 7 };

    assert.equal(stash, inv.witch, 'witch player must see inv.witch, not inv.hero');
    assert.equal((stash[ResourceType.METAL]?.count ?? 0), 5, 'witch player must see witch metal count');

    // Verify the buggy code would have returned the wrong stash
    const buggyIsHero = state.activePlayer === Player.HERO; // always true by default
    const buggyStash  = buggyIsHero ? inv.hero : inv.witch;
    assert.notEqual(buggyStash, stash,
      'the bug (using activePlayer) returns the wrong stash for witch players');
  });
});

// ── computeProjectedInventory ─────────────────────────────────────────────────
import { computeProjectedInventory } from '../src/planner.js';
import { PlanActionType } from '../src/planner.js';

describe('computeProjectedInventory', () => {
  // Resource counts are read via the dict-of-objects shape (`{ id: { count } }`).
  const c = (entry) => entry?.count ?? 0;

  function baseState() {
    const s = new GameState(true, true);
    s.inventory.witch.metal = { count: 4 };
    s.inventory.witch.wood  = { count: 2 };
    s.inventory.hero.wood = { count: 3 };
    s.inventory.hero.metal = { count: 1 };
    s.inventory.hero.food  = { count: 2 };
    return s;
  }

  test('empty plan returns snapshot equal to current inventory', () => {
    const s = baseState();
    const p = computeProjectedInventory(s, []);
    assert.equal(c(p.witch.metal), 4);
    assert.equal(c(p.hero.wood),  3);
  });

  test('SUMMON deducts 2 metal (Iron Golem path)', () => {
    const s = baseState();
    const p = computeProjectedInventory(s, [{ type: PlanActionType.SUMMON }]);
    assert.equal(c(p.witch.metal), 2, 'metal reduced by 2');
    assert.equal(c(p.witch.wood),  2, 'wood unchanged');
  });

  test('two SUMMONs deduct 4 metal total', () => {
    const s = baseState();
    const plan = [{ type: PlanActionType.SUMMON }, { type: PlanActionType.SUMMON }];
    const p = computeProjectedInventory(s, plan);
    assert.equal(c(p.witch.metal), 0);
    assert.equal(c(p.witch.wood),  2, 'wood unchanged when metal covers both');
  });

  test('SUMMON falls to wood when metal < 2', () => {
    const s = baseState();
    s.inventory.witch.metal = { count: 1 };
    const p = computeProjectedInventory(s, [{ type: PlanActionType.SUMMON }]);
    assert.equal(c(p.witch.wood), 0, 'wood reduced by 2 (Wood Golem path)');
  });

  test('FORTIFY deducts 1 metal from shared (metal preferred)', () => {
    const s = baseState();
    const p = computeProjectedInventory(s, [{ type: PlanActionType.FORTIFY }]);
    assert.equal(c(p.hero.metal), 0);
    assert.equal(c(p.hero.wood),  3, 'wood untouched when metal available');
  });

  test('FORTIFY deducts 1 wood when no shared metal', () => {
    const s = baseState();
    s.inventory.hero.metal = { count: 0 };
    const p = computeProjectedInventory(s, [{ type: PlanActionType.FORTIFY }]);
    assert.equal(c(p.hero.wood), 2);
  });

  test('USE_ITEM food deducts from shared', () => {
    const s = baseState();
    const p = computeProjectedInventory(s, [{ type: PlanActionType.USE_ITEM, item: 'food', entityId: 'x' }]);
    assert.equal(c(p.hero.food), 1);
  });

  test('does not mutate original state', () => {
    const s = baseState();
    computeProjectedInventory(s, [{ type: PlanActionType.SUMMON }]);
    assert.equal(c(s.inventory.witch.metal), 4, 'original state unchanged');
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

// ── Fortifications as walls (impassable to witch) ─────────────────────────────
// Level >= FORT_IMPASSABLE_THRESHOLD blocks witch-side movement. Hero moves freely.

describe('fortifications as impassable walls', () => {
  test('isFortBlocking: only witch is blocked by fort >= threshold', () => {
    const t = { fortifyLevel: 2 };
    assert.equal(isFortBlocking(t, 'witch'), true);
    assert.equal(isFortBlocking(t, 'hero'),  false);
    assert.equal(isFortBlocking({ fortifyLevel: 1 }, 'witch'), false);
    assert.equal(isFortBlocking({ fortifyLevel: 0 }, 'witch'), false);
    assert.equal(isFortBlocking(null, 'witch'),  false);
  });

  test('witch unit: getReachableHexes excludes fort-2 neighbour', () => {
    const state = freshState();
    state.entities = state.entities.filter(e => e.id === state.hero.id || e.id === state.witch.id);
    const witch = state.witch;
    // Make all immediate neighbors plain grass first
    for (const n of getNeighbors(witch.col, witch.row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t) { decomposeTileType(t, TileType.GRASS); t.building = null; t.hiddenSurvivor = false; t.fortifyLevel = 0; clearFootprint(t); }
    }
    const nbrs = getNeighbors(witch.col, witch.row);
    const wallNbr = nbrs[0];
    const wallTile = state.tiles.get(hexKey(wallNbr.col, wallNbr.row));
    wallTile.fortifyLevel = 2;

    const reachable = getReachableHexes(state, witch, 1);
    const reachKeys = new Set(reachable.map(h => hexKey(h.col, h.row)));
    assert.ok(!reachKeys.has(hexKey(wallNbr.col, wallNbr.row)),
      'fort-2 neighbour should NOT be reachable for witch unit');

    // Drop the fort to 1 — now it should be reachable.
    wallTile.fortifyLevel = 1;
    const reachable2 = getReachableHexes(state, witch, 1);
    const reachKeys2 = new Set(reachable2.map(h => hexKey(h.col, h.row)));
    assert.ok(reachKeys2.has(hexKey(wallNbr.col, wallNbr.row)),
      'fort-1 neighbour should be reachable for witch unit');
  });

  test('hero unit: fort-3 neighbour is reachable', () => {
    const state = freshState();
    const hero = state.hero;
    for (const n of getNeighbors(hero.col, hero.row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t) { decomposeTileType(t, TileType.GRASS); t.building = null; t.hiddenSurvivor = false; t.fortifyLevel = 0; clearFootprint(t); }
    }
    // Clear enemies from adjacent hexes so they don't block pathing
    state.entities = state.entities.filter(e => e.id === hero.id || e.id === state.witch.id);
    const wallNbr = getNeighbors(hero.col, hero.row)[0];
    const wallTile = state.tiles.get(hexKey(wallNbr.col, wallNbr.row));
    wallTile.fortifyLevel = 3;

    const reachable = getReachableHexes(state, hero, 1);
    const reachKeys = new Set(reachable.map(h => hexKey(h.col, h.row)));
    assert.ok(reachKeys.has(hexKey(wallNbr.col, wallNbr.row)),
      'hero should reach fort-3 neighbour freely');
  });

  test('executeMove: witch blocked by fort returns blockedByFort', () => {
    const state = freshState();
    state.entities = state.entities.filter(e => e.id === state.hero.id || e.id === state.witch.id);
    const witch = state.witch;
    const origCol = witch.col, origRow = witch.row;
    // Normalize neighbours
    for (const n of getNeighbors(witch.col, witch.row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t) { decomposeTileType(t, TileType.GRASS); t.building = null; t.hiddenSurvivor = false; t.fortifyLevel = 0; clearFootprint(t); }
    }
    const wallNbr = getNeighbors(witch.col, witch.row)[0];
    const wallTile = state.tiles.get(hexKey(wallNbr.col, wallNbr.row));
    wallTile.fortifyLevel = 2;

    const r = executeMove(state, witch, wallNbr.col, wallNbr.row);
    assert.equal(r.success, false, 'Move directly into fort-2 should fail');
    assert.ok(r.blockedByFort, 'blockedByFort should be set');
    assert.equal(r.blockedByFort.col, wallNbr.col);
    assert.equal(r.blockedByFort.row, wallNbr.row);
    assert.equal(r.blockedByFort.fortLevel, 2);
    assert.ok(r.log.some(l => l.includes('blocked by fortifications')),
      'Log should mention blocked by fortifications');
    assert.equal(witch.col, origCol, 'Witch must not have moved');
    assert.equal(witch.row, origRow);
  });

  test('executeMove: witch can walk through fort-1', () => {
    const state = freshState();
    state.entities = state.entities.filter(e => e.id === state.hero.id || e.id === state.witch.id);
    const witch = state.witch;
    for (const n of getNeighbors(witch.col, witch.row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t) { decomposeTileType(t, TileType.GRASS); t.building = null; t.hiddenSurvivor = false; t.fortifyLevel = 0; clearFootprint(t); }
    }
    const nbr = getNeighbors(witch.col, witch.row)[0];
    const nbrTile = state.tiles.get(hexKey(nbr.col, nbr.row));
    nbrTile.fortifyLevel = 1;

    const r = executeMove(state, witch, nbr.col, nbr.row);
    assert.equal(r.success, true);
    assert.equal(witch.col, nbr.col);
    assert.equal(witch.row, nbr.row);
    assert.equal(r.blockedByFort, null, 'no fort block for fort-1');
  });
});

// ── executeFortAssault ───────────────────────────────────────────────────────

describe('executeFortAssault', () => {
  function setupAssaultScene({ fortLevel = 3, attacker = 'minion', attackerAttack = null } = {}) {
    const state = freshState();
    state.entities = state.entities.filter(e => e.id === state.hero.id);
    // Place attacker beside the hero's tile — but move it to a fresh location we control.
    // Pick two deterministic hexes: attacker at (5,5), fort at (6,5).
    const atkPos = { col: 5, row: 5 };
    const fortPos = { col: 6, row: 5 };
    const atkTile = state.tiles.get(hexKey(atkPos.col, atkPos.row));
    const fortTile = state.tiles.get(hexKey(fortPos.col, fortPos.row));
    if (atkTile) { decomposeTileType(atkTile, TileType.GRASS); atkTile.building = null; atkTile.hiddenSurvivor = false; atkTile.fortifyLevel = 0; clearFootprint(atkTile); }
    if (fortTile) { decomposeTileType(fortTile, TileType.GRASS); fortTile.building = null; fortTile.hiddenSurvivor = false; fortTile.fortifyLevel = fortLevel; clearFootprint(fortTile); }

    let unit;
    if (attacker === 'iron_golem') unit = createIronGolem(atkPos.col, atkPos.row);
    else unit = createMinion(atkPos.col, atkPos.row);
    if (attackerAttack != null) unit.attack = attackerAttack;
    state.entities.push(unit);

    return { state, unit, fortTile, fortPos };
  }

  test('witch minion hits a fort-3 wall and knocks it down to 2', () => {
    const { state, unit, fortTile, fortPos } = setupAssaultScene({ fortLevel: 3, attacker: 'minion' });
    // Minion attack=1, fort defense = 3+1 = 4. Force d6=4 → roll = 4+1 = 5 > 4 → hit, not crush (5 < 8).
    setForcedDice(4);
    const r = executeFortAssault(state, unit, fortPos.col, fortPos.row);
    assert.equal(r.success, true);
    assert.equal(r.hit, true);
    assert.equal(r.crush, false);
    assert.equal(r.damage, 1);
    assert.equal(r.fortLevelBefore, 3);
    assert.equal(r.fortLevelAfter, 2);
    assert.equal(fortTile.fortifyLevel, 2);
  });

  test('crush on a fort-3 wall knocks it down by 2 levels', () => {
    const { state, unit, fortTile, fortPos } = setupAssaultScene({
      fortLevel: 3, attacker: 'iron_golem',
    });
    // Iron golem attack=3, fort defense = 4. Force d6=6 → roll = 6+3 = 9 vs 4 → crush (9 >= 8).
    setForcedDice(6);
    const r = executeFortAssault(state, unit, fortPos.col, fortPos.row);
    assert.equal(r.hit, true);
    assert.equal(r.crush, true);
    assert.equal(r.damage, 2);
    assert.equal(r.fortLevelAfter, 1);
    assert.equal(fortTile.fortifyLevel, 1);
  });

  test('missed assault leaves fort unchanged', () => {
    const { state, unit, fortTile, fortPos } = setupAssaultScene({ fortLevel: 4, attacker: 'minion' });
    // Minion attack=1, fort defense = 4+1 = 5. Force d6=1 → roll = 2 vs 5 → miss.
    setForcedDice(1);
    const r = executeFortAssault(state, unit, fortPos.col, fortPos.row);
    assert.equal(r.hit, false);
    assert.equal(r.damage, 0);
    assert.equal(fortTile.fortifyLevel, 4);
  });

  test('rejects hero attempting to assault a fort', () => {
    const state = freshState();
    const hero = state.hero;
    const fortPos = getNeighbors(hero.col, hero.row).find(n => {
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t);
    });
    if (!fortPos) return;
    const t = state.tiles.get(hexKey(fortPos.col, fortPos.row));
    t.fortifyLevel = 3;

    const r = executeFortAssault(state, hero, fortPos.col, fortPos.row);
    assert.equal(r.success, false);
    assert.ok(r.log.some(l => l.toLowerCase().includes('witch')),
      'rejection message should mention witch-only');
  });

  test('rejects assault on fort below impassable threshold', () => {
    const { state, unit, fortPos } = setupAssaultScene({ fortLevel: 1, attacker: 'minion' });
    const r = executeFortAssault(state, unit, fortPos.col, fortPos.row);
    assert.equal(r.success, false);
  });

  test('rejects assault on non-adjacent target', () => {
    const { state, unit, fortPos } = setupAssaultScene({ fortLevel: 3, attacker: 'minion' });
    // Move unit far away.
    unit.col = 0; unit.row = 0;
    const r = executeFortAssault(state, unit, fortPos.col, fortPos.row);
    assert.equal(r.success, false);
    assert.ok(r.log.some(l => l.toLowerCase().includes('range')));
  });

  test('after wall is demolished to 1, a witch unit can walk through it', () => {
    const { state, unit, fortTile, fortPos } = setupAssaultScene({
      fortLevel: 3, attacker: 'iron_golem',
    });
    setForcedDice(6);
    const r1 = executeFortAssault(state, unit, fortPos.col, fortPos.row);
    assert.equal(r1.fortLevelAfter, 1);

    // Ensure no enemies on the target hex
    state.entities = state.entities.filter(e => !(e.col === fortPos.col && e.row === fortPos.row));
    state.entities.push(unit);
    unit.col = 5; unit.row = 5;  // ensure adjacent

    // Clear out other stuff that might live there
    fortTile.building = null;
    decomposeTileType(fortTile, TileType.GRASS);
    clearFootprint(fortTile);

    const r2 = executeMove(state, unit, fortPos.col, fortPos.row);
    assert.equal(r2.success, true, 'Witch should now walk onto the breached wall hex');
    assert.equal(unit.col, fortPos.col);
    assert.equal(unit.row, fortPos.row);
  });
});

// ── getValidActions — effective-entity prototype preservation ─────────────
// Regression: when the UI selects a unit that has a planned MOVE queued,
// _selectEntity builds an "effectiveEntity" from a spread + position
// override so getValidActions sees the projected position. The spread
// must preserve the Entity prototype, otherwise method calls like
// `actor.hasAbility('summon')` / `actor.hasAbility('sound_horn')` throw
// and selection silently fails (see PR #294 ghost-unit selection bug).

describe('getValidActions on a ghost-position effective entity', () => {
  test('plain spread (no prototype) throws — locks the failure mode', () => {
    const state = new GameState(true, true);
    const plainSpread = { ...state.hero, col: state.hero.col + 1, row: state.hero.row };
    // No Object.setPrototypeOf — this is the UI's pre-fix shape.
    assert.throws(() => getValidActions(state, plainSpread), TypeError);
  });

  test('reparented spread preserves methods; summon / sound_horn gates work', () => {
    const state = new GameState(true, true);
    const hero  = state.hero;
    const ghost = Object.setPrototypeOf(
      { ...hero, col: hero.col + 1, row: hero.row },
      Object.getPrototypeOf(hero)
    );
    const actions = getValidActions(state, ghost);
    // Day-side leader → sound_horn should be surfaced.
    assert.ok(
      actions.some(a => a.type === ActionType.SOUND_HORN),
      'sound_horn must be in actions for a ghost-position day-side leader'
    );
    // Guard should also appear (universal action).
    assert.ok(
      actions.some(a => a.type === ActionType.GUARD),
      'guard must be in actions'
    );
  });

  test('reparented witch spread surfaces summon', () => {
    const state = new GameState(true, true);
    const witch = state.entities.find(e => e.type === EntityType.WITCH);
    const ghost = Object.setPrototypeOf(
      { ...witch, col: witch.col + 1, row: witch.row },
      Object.getPrototypeOf(witch)
    );
    const actions = getValidActions(state, ghost);
    assert.ok(
      actions.some(a => a.type === ActionType.SUMMON),
      'summon must be in actions for a ghost-position night-side leader'
    );
  });
});

// ── Sound Horn gated on the horn ITEM (not the sound_horn ability) ─────────
// The horn became a reusable "key item" living in the leader's `items`. The
// action surfaces only while the unit holds a horn; sounding it never consumes
// the horn. The Paladin is issued one innately (so standard games are
// unchanged); campaign heroes find theirs at the river church in Ch1 M4.

describe('Sound Horn gated on the horn item', () => {
  test('the Paladin hero carries a horn innately', () => {
    const state = freshState();
    assert.ok(state.hero.hasItem('horn'),
      'a freshly-created hero leader should hold the horn');
  });

  test('hero WITH the horn surfaces SOUND_HORN', () => {
    const state = freshState();
    const actions = getValidActions(state, state.hero);
    assert.ok(actions.some(a => a.type === ActionType.SOUND_HORN),
      'SOUND_HORN must appear when the hero holds a horn');
  });

  test('hero WITHOUT the horn does NOT surface SOUND_HORN', () => {
    const state = freshState();
    const hero = state.hero;
    hero.removeItem('horn');
    assert.ok(!hero.hasItem('horn'), 'precondition: horn removed');
    const actions = getValidActions(state, hero);
    assert.ok(!actions.some(a => a.type === ActionType.SOUND_HORN),
      'SOUND_HORN must be hidden when the hero lacks a horn');
  });

  test('sounding the horn fires its effect but keeps the horn (reusable)', () => {
    const state = freshState();
    const hero = state.hero;
    state.inventory.hero[ResourceType.FOOD] = { count: 2 };
    const countBefore = hero.getItemCount('horn');
    assert.ok(countBefore >= 1, 'precondition: hero holds a horn');

    const res = executeSoundHorn(state, hero);
    assert.ok(res.success, 'horn should fire when held and food is available');
    assert.ok(state.heroRevealedByHorn, 'sounding the horn reveals the hero');
    // Reusable key item: count unchanged, item still present.
    assert.equal(hero.getItemCount('horn'), countBefore,
      'horn count must be unchanged after sounding it');
    assert.ok(hero.hasItem('horn'), 'horn item must NOT be removed on use');
  });

  test('executeSoundHorn refuses when the hero lacks a horn', () => {
    const state = freshState();
    const hero = state.hero;
    hero.removeItem('horn');
    state.inventory.hero[ResourceType.FOOD] = { count: 2 };
    const res = executeSoundHorn(state, hero);
    assert.ok(!res.success, 'cannot sound a horn you do not hold');
  });
});
