// Tests for gameplay balance tweaks:
// 1. Witch minions cannot explore or summon
// 2. Witch action cap is 8
// 3. Witch vision is always 2 (including night)
// 4. Iron Golem defense nerfed to 2
// 5. Hero Sound Horn action

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase, Player } from '../src/game.js';
import {
  ActionType, getValidActions, executeSoundHorn,
  getVisiblePositions,
} from '../src/actions.js';
import {
  EntityType,
  createHero, createWitch, createMinion, createIronGolem, createWoodGolem, createZombie,
} from '../src/entities.js';
import { ResourceType, TileType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import { getFaction } from '../src/factions.js';

function freshState() {
  return new GameState(true, true);
}

// ── Change 1: Witch minions cannot explore or summon ────────────────────────

describe('Witch minions cannot explore or summon', () => {
  test('Minion gets no EXPLORE action on unexplored tile', () => {
    const state = freshState();
    const minion = createMinion(3, 3);
    minion.owner = 'witch';
    state.entities.push(minion);
    const t = state.tiles.get(hexKey(3, 3));
    if (t) t.explored = false;

    const actions = getValidActions(state, minion);
    assert.ok(!actions.some(a => a.type === ActionType.EXPLORE),
      'Minion should not have EXPLORE action');
  });

  test('Iron Golem gets no EXPLORE action', () => {
    const state = freshState();
    const golem = createIronGolem(3, 3);
    golem.owner = 'witch';
    state.entities.push(golem);
    const t = state.tiles.get(hexKey(3, 3));
    if (t) t.explored = false;

    const actions = getValidActions(state, golem);
    assert.ok(!actions.some(a => a.type === ActionType.EXPLORE));
  });

  test('Wood Golem gets no EXPLORE action', () => {
    const state = freshState();
    const golem = createWoodGolem(3, 3);
    golem.owner = 'witch';
    state.entities.push(golem);
    const t = state.tiles.get(hexKey(3, 3));
    if (t) t.explored = false;

    const actions = getValidActions(state, golem);
    assert.ok(!actions.some(a => a.type === ActionType.EXPLORE));
  });

  test('Zombie gets no EXPLORE action', () => {
    const state = freshState();
    const z = createZombie(3, 3);
    z.owner = 'witch';
    state.entities.push(z);
    const t = state.tiles.get(hexKey(3, 3));
    if (t) t.explored = false;

    const actions = getValidActions(state, z);
    assert.ok(!actions.some(a => a.type === ActionType.EXPLORE));
  });

  test('Witch leader CAN still explore', () => {
    const state = freshState();
    const witch = createWitch(3, 3);
    state.entities.push(witch);
    const t = state.tiles.get(hexKey(3, 3));
    if (t) t.explored = false;

    const actions = getValidActions(state, witch);
    assert.ok(actions.some(a => a.type === ActionType.EXPLORE),
      'Witch leader should still have EXPLORE');
  });

  test('Minion gets no SUMMON action', () => {
    const state = freshState();
    const minion = createMinion(3, 3);
    minion.owner = 'witch';
    state.entities.push(minion);
    state.inventory.witch[ResourceType.WOOD] = 5;

    const actions = getValidActions(state, minion);
    assert.ok(!actions.some(a => a.type === ActionType.SUMMON),
      'Minion should not have SUMMON action');
  });

  test('Witch leader CAN still summon', () => {
    const state = freshState();
    const witch = getFaction('witch').createLeader(3, 3, 'witch');
    state.entities.push(witch);
    state.inventory.witch[ResourceType.WOOD] = 5;

    const actions = getValidActions(state, witch);
    assert.ok(actions.some(a => a.type === ActionType.SUMMON),
      'Witch leader should still have SUMMON');
  });

  test('Hero units can still explore', () => {
    const state = freshState();
    const hero = createHero(3, 3);
    state.entities.push(hero);
    const t = state.tiles.get(hexKey(3, 3));
    if (t) t.explored = false;

    const actions = getValidActions(state, hero);
    assert.ok(actions.some(a => a.type === ActionType.EXPLORE),
      'Hero should still have EXPLORE');
  });
});

// ── Change 2: Witch action cap is 8 ────────────────────────────────────────

describe('Witch action cap', () => {
  test('Witch budget caps at 8, not 10', () => {
    // 3 + 1 (NIGHT) + 3 (unit cap) + 3 (nodes) = 10 → capped at 8
    const result = getFaction('witch').computeBudget(Phase.NIGHT, 5, 3);
    assert.equal(result, 8);
  });

  test('Witch budget under cap is unaffected', () => {
    // 3 + 1 (NIGHT) + 2 (units) = 6
    const result = getFaction('witch').computeBudget(Phase.NIGHT, 2, 0);
    assert.equal(result, 6);
  });
});

// ── Change 3: Witch vision at night ─────────────────────────────────────────

describe('Witch vision distance', () => {
  test('Witch faction sight range is 2 in all phases', () => {
    const witch = getFaction('witch');
    assert.equal(witch.getSightRange(Phase.DAY), 2);
    assert.equal(witch.getSightRange(Phase.DAWN), 2);
    assert.equal(witch.getSightRange(Phase.DUSK), 2);
    assert.equal(witch.getSightRange(Phase.NIGHT), 2);
  });
});

// ── Change 4: Iron Golem defense nerf ───────────────────────────────────────

describe('Iron Golem stats', () => {
  test('Iron Golem has attack 3, defense 2, HP 5', () => {
    const golem = createIronGolem(0, 0);
    assert.equal(golem.attack, 3);
    assert.equal(golem.defense, 2);
    assert.equal(golem.maxHp, 5);
  });
});

// ── Change 5: Hero Sound Horn action ────────────────────────────────────────

describe('Sound Horn action', () => {
  test('Sound Horn appears in valid actions for hero', () => {
    const state = freshState();
    const hero = getFaction('hero').createLeader(3, 3, 'hero');
    state.entities.push(hero);
    state.inventory.hero.food = 5;

    const actions = getValidActions(state, hero);
    const horn = actions.find(a => a.type === ActionType.SOUND_HORN);
    assert.ok(horn, 'Hero should have SOUND_HORN action');
    assert.equal(horn.affordable, true);
  });

  test('Sound Horn not available to non-hero units', () => {
    const state = freshState();
    const witch = createWitch(3, 3);
    state.entities.push(witch);

    const actions = getValidActions(state, witch);
    assert.ok(!actions.some(a => a.type === ActionType.SOUND_HORN),
      'Witch should not have SOUND_HORN');
  });

  test('Sound Horn shows as unaffordable with 0 food', () => {
    const state = freshState();
    const hero = getFaction('hero').createLeader(3, 3, 'hero');
    state.entities.push(hero);
    state.inventory.hero.food = 0;

    const actions = getValidActions(state, hero);
    const horn = actions.find(a => a.type === ActionType.SOUND_HORN);
    assert.ok(horn, 'Hero should have SOUND_HORN action');
    assert.equal(horn.affordable, false);
  });

  test('executeSoundHorn succeeds and deducts 1 food', () => {
    const state = freshState();
    state.log = [];
    state.addLog = (msg, faction) => state.log.push({ msg, faction });
    const hero = getFaction('hero').createLeader(3, 3, 'hero');
    hero.owner = 'hero';
    state.entities.push(hero);
    state.inventory.hero.food = 5;

    const result = executeSoundHorn(state, hero);
    assert.equal(result.success, true);
    assert.equal(result.cost, 1);
    assert.equal(state.inventory.hero.food, 4);
  });

  test('executeSoundHorn fails with insufficient food', () => {
    const state = freshState();
    state.addLog = () => {};
    const hero = getFaction('hero').createLeader(3, 3, 'hero');
    hero.owner = 'hero';
    state.entities.push(hero);
    state.inventory.hero.food = 0;

    const result = executeSoundHorn(state, hero);
    assert.equal(result.success, false);
  });

  test('executeSoundHorn sets heroRevealedByHorn flag', () => {
    const state = freshState();
    state.log = [];
    state.addLog = (msg, faction) => state.log.push({ msg, faction });
    const hero = getFaction('hero').createLeader(3, 3, 'hero');
    hero.owner = 'hero';
    state.entities.push(hero);
    state.inventory.hero.food = 5;

    assert.equal(state.heroRevealedByHorn, false);
    executeSoundHorn(state, hero);
    assert.equal(state.heroRevealedByHorn, true);
  });

  test('executeSoundHorn fails for non-hero entity', () => {
    const state = freshState();
    state.addLog = () => {};
    const witch = createWitch(3, 3);
    state.entities.push(witch);
    state.inventory.hero.food = 5;

    const result = executeSoundHorn(state, witch);
    assert.equal(result.success, false);
  });

  test('heroRevealedByHorn makes hero visible to witch via getVisiblePositions', () => {
    const state = freshState();
    // Place hero far from all witch units
    const hero = createHero(10, 10);
    hero.owner = 'hero';
    state.entities = [hero];
    // Add a witch far away (distance > 2)
    const witch = createWitch(0, 0);
    state.entities.push(witch);

    // Without horn, hero should not be visible (distance > 2)
    state.heroRevealedByHorn = false;
    const hidden = getVisiblePositions(state, 'witch');
    assert.ok(!hidden.has(hexKey(10, 10)), 'Hero should be hidden without horn');

    // With horn, hero should be visible
    state.heroRevealedByHorn = true;
    const visible = getVisiblePositions(state, 'witch');
    assert.ok(visible.has(hexKey(10, 10)), 'Hero should be visible with horn');
  });

  test('heroRevealedByHorn cleared on startPlanning', () => {
    const state = freshState();
    state.heroRevealedByHorn = true;
    state.startPlanning();
    assert.equal(state.heroRevealedByHorn, false);
  });

  test('Sound Horn adds witch-visible log about horn sounding', () => {
    const state = freshState();
    const logs = [];
    state.addLog = (msg, faction) => logs.push({ msg, faction });
    const hero = getFaction('hero').createLeader(3, 3, 'hero');
    hero.owner = 'hero';
    state.entities.push(hero);
    state.inventory.hero.food = 5;

    executeSoundHorn(state, hero);
    const witchLog = logs.find(l => l.faction === 'witch');
    assert.ok(witchLog, 'Should have a witch-visible log entry');
    assert.ok(witchLog.msg.includes('horn') || witchLog.msg.includes('Horn'),
      'Witch log should mention the horn');
  });

  test('Sound Horn guarantees finding one survivor if hidden survivors in range', () => {
    const state = freshState();
    state.log = [];
    state.addLog = (msg, faction) => state.log.push({ msg, faction });
    const hero = getFaction('hero').createLeader(3, 3, 'hero');
    hero.owner = 'hero';
    state.entities.push(hero);
    state.inventory.hero.food = 5;

    // Place a hidden survivor at (3, 4) — within 4 hexes
    const tile = state.tiles.get(hexKey(3, 4));
    if (tile) {
      tile.type = TileType.BUILDING;
      tile.hiddenSurvivor = true;
    } else {
      state.tiles.set(hexKey(3, 4), {
        col: 3, row: 4, type: TileType.BUILDING, explored: false,
        hiddenSurvivor: true, terrain: 'grass',
      });
    }

    // Run 20 times — should always find at least one survivor
    let foundCount = 0;
    for (let i = 0; i < 20; i++) {
      // Reset state for each attempt
      const s = freshState();
      s.log = [];
      s.addLog = (msg, faction) => s.log.push({ msg, faction });
      const h = getFaction('hero').createLeader(3, 3, 'hero');
      h.owner = 'hero';
      s.entities.push(h);
      s.inventory.hero.food = 5;
      const t = s.tiles.get(hexKey(3, 4));
      if (t) {
        t.type = TileType.BUILDING;
        t.hiddenSurvivor = true;
      } else {
        s.tiles.set(hexKey(3, 4), {
          col: 3, row: 4, type: TileType.BUILDING, explored: false,
          hiddenSurvivor: true, terrain: 'grass',
        });
      }
      const result = executeSoundHorn(s, h);
      if (result.encounterSurvivor) foundCount++;
    }
    assert.ok(foundCount === 20,
      `Expected to find survivor every time, but only found ${foundCount}/20`);
  });
});
