// Tests for campaign/story mode: Campaign class, victory delegates, no-witch games, wave spawner.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase } from '../src/game.js';
import { EntityType, createMinion, createZombie } from '../src/entities.js';
import { hexKey } from '../src/hex.js';
import {
  Campaign, buildVictoryDelegate, snapshotSurvivor, processWaves,
} from '../src/campaign/campaign.js';
import { MISSIONS, MissionId, ObjectiveType } from '../src/campaign/missions.js';
import { MISSION_MAP_BUILDERS } from '../src/campaign/mission-maps.js';

// ── Helper: localStorage mock for Node ──────────────────────────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

// ── Mission definitions ─────────────────────────────────────────────────────

describe('Mission definitions', () => {
  test('all missions have required fields', () => {
    for (const m of MISSIONS) {
      assert.ok(m.id, `mission missing id`);
      assert.ok(m.title, `${m.id} missing title`);
      assert.ok(m.briefing, `${m.id} missing briefing`);
      assert.ok(m.mapBuilder, `${m.id} missing mapBuilder`);
      assert.ok(m.objectives?.win, `${m.id} missing win objective`);
      assert.ok(m.objectives?.lose, `${m.id} missing lose objective`);
    }
  });

  test('all mission map builders exist and return valid mapData', () => {
    for (const m of MISSIONS) {
      const builder = MISSION_MAP_BUILDERS[m.mapBuilder];
      assert.ok(builder, `No builder for ${m.mapBuilder}`);
      const mapData = builder();
      assert.ok(mapData.tiles instanceof Map, `${m.id}: tiles is not a Map`);
      assert.ok(mapData.heroStart, `${m.id}: missing heroStart`);
      assert.ok(typeof mapData.cols === 'number', `${m.id}: missing cols`);
      assert.ok(typeof mapData.rows === 'number', `${m.id}: missing rows`);
    }
  });

  test('prologue mission has 3 missions total', () => {
    assert.equal(MISSIONS.length, 3);
  });

  test('mission prerequisites form a valid chain', () => {
    const completed = new Set();
    for (const m of MISSIONS) {
      if (m.requires) {
        for (const req of m.requires) {
          assert.ok(completed.has(req), `${m.id} requires ${req} which hasn't appeared yet`);
        }
      }
      completed.add(m.id);
    }
  });
});

// ── GameState: no-witch mode ─────────────────────────────────────────────────

describe('GameState no-witch mode', () => {
  test('GameState can be created without a witch', () => {
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.witch, null);
    assert.ok(state.hero);
    assert.ok(state.hero.alive);
  });

  test('witch faction is registered but has no leader', () => {
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    const witchPlayer = state.players.find(p => p.faction === 'witch');
    assert.ok(witchPlayer);
    assert.equal(witchPlayer.leaderId, null);
  });

  test('factionEliminated returns false for no-witch faction', () => {
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.factionEliminated('witch'), false);
  });

  test('checkVictory does not crash with null witch', () => {
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    // Should not throw
    state.checkVictory();
    assert.equal(state.gameOver, false);
  });

  test('no-witch game with witch entities still tracks them', () => {
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    // Add some enemy units
    const z = createZombie(3, 3, 'witch');
    state.entities.push(z);
    assert.equal(state.entities.filter(e => e.owner === 'witch').length, 1);
  });
});

// ── Victory delegate ────────────────────────────────────────────────────────

describe('Victory delegate', () => {
  test('eliminate_all triggers when all witch entities dead', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    // No enemy entities → win
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'hero');
  });

  test('eliminate_all does not trigger while enemies alive', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.entities.push(createZombie(3, 3, 'witch'));
    const result = delegate(state);
    assert.equal(result, null);
  });

  test('survive_rounds triggers after N rounds', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'survive_rounds', rounds: 5 },
      lose: { type: 'hero_killed' },
    });
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 5;
    assert.equal(delegate(state), null); // not yet (round 5 = exactly at limit)
    state.round = 6;
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'hero');
  });

  test('hero_killed loss condition triggers on hero death', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    const mapData = MISSION_MAP_BUILDERS.prologue();
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.hero.hp = 0; // kill the hero
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'witch');
  });

  test('slay_witch triggers when witch faction eliminated', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'slay_witch' },
      lose: { type: 'hero_killed' },
    });
    const state = new GameState(true, false);
    state.witch.hp = 0; // kill the witch
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'hero');
  });

  test('victoryDelegate is called by checkVictory', () => {
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.victoryDelegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    state.checkVictory();
    assert.equal(state.winner, 'hero'); // no enemies → immediate win
  });
});

// ── Campaign class ──────────────────────────────────────────────────────────

describe('Campaign class', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('new campaign starts at prologue with empty roster', () => {
    const c = new Campaign('test-1');
    assert.equal(c.currentMission, MissionId.PROLOGUE);
    assert.equal(c.roster.length, 0);
    assert.equal(c.completedMissions.size, 0);
  });

  test('save and load round-trips', () => {
    const c = new Campaign('test-1');
    c.resources.herbs = 5;
    c.roster.push({ name: 'Abigail', hp: 3, maxHp: 4 });
    c.save();

    const c2 = new Campaign('test-1');
    const loaded = c2.load();
    assert.ok(loaded);
    assert.equal(c2.resources.herbs, 5);
    assert.equal(c2.roster.length, 1);
    assert.equal(c2.roster[0].name, 'Abigail');
  });

  test('delete clears save', () => {
    const c = new Campaign('test-del');
    c.save();
    assert.ok(Campaign.exists('test-del'));
    c.delete();
    assert.ok(!Campaign.exists('test-del'));
  });

  test('getMissionList returns correct statuses', () => {
    const c = new Campaign('test-ml');
    const list = c.getMissionList();
    assert.equal(list.length, 3);
    assert.ok(list[0].available); // prologue is available
    assert.ok(!list[1].available); // first_night requires prologue
    assert.ok(!list[2].available); // witchs_trail requires first_night
  });

  test('applyMissionResult advances campaign on victory', () => {
    const c = new Campaign('test-result');
    c.applyMissionResult(MissionId.PROLOGUE, {
      won: true,
      survivors: [{ name: 'Martha', hp: 2, maxHp: 3, attack: 1, defense: 1 }],
      resources: { herbs: 3, food: 1 },
      heroStats: { hp: 12, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.ok(c.completedMissions.has(MissionId.PROLOGUE));
    assert.equal(c.currentMission, MissionId.FIRST_NIGHT);
    assert.equal(c.roster.length, 1);
    assert.equal(c.roster[0].name, 'Martha');
  });

  test('applyMissionResult applies rewards on victory', () => {
    const c = new Campaign('test-rewards');
    c.applyMissionResult(MissionId.PROLOGUE, {
      won: true,
      survivors: [],
      resources: { herbs: 0 },
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    // Prologue gives herbs:2, food:1 as rewards
    assert.equal(c.resources.herbs, 2);
    assert.equal(c.resources.food, 1);
  });

  test('applyMissionResult does not advance on defeat', () => {
    const c = new Campaign('test-defeat');
    c.applyMissionResult(MissionId.PROLOGUE, {
      won: false,
      survivors: [],
      resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.ok(!c.completedMissions.has(MissionId.PROLOGUE));
    assert.equal(c.currentMission, MissionId.PROLOGUE);
  });

  test('permadeath: dead survivors are removed from roster', () => {
    const c = new Campaign('test-perma');
    c.roster = [
      { name: 'Alice', hp: 3, maxHp: 3 },
      { name: 'Bob', hp: 2, maxHp: 3 },
    ];
    // Only Alice survived
    c.applyMissionResult(MissionId.PROLOGUE, {
      won: true,
      survivors: [{ name: 'Alice', hp: 3, maxHp: 3, attack: 1, defense: 1 }],
      resources: {},
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.equal(c.roster.length, 1);
    assert.equal(c.roster[0].name, 'Alice');
  });
});

// ── snapshotSurvivor ────────────────────────────────────────────────────────

describe('snapshotSurvivor', () => {
  test('captures entity data correctly', () => {
    // Simulate an entity
    const entity = {
      name: 'Test', title: 'The Brave', bio: 'A hero',
      ability: 'brawler', abilityLabel: 'Brawler',
      color: '#ff0000',
      hp: 3, maxHp: 4, attack: 2, defense: 1,
      weapon: 'sword', items: { herbs: 1 },
    };
    const snap = snapshotSurvivor(entity);
    assert.equal(snap.name, 'Test');
    assert.equal(snap.hp, 3);
    assert.equal(snap.weapon, 'sword');
    assert.deepEqual(snap.items, { herbs: 1 });
    // Items should be a copy, not same reference
    entity.items.herbs = 99;
    assert.equal(snap.items.herbs, 1);
  });
});

// ── Wave spawner ────────────────────────────────────────────────────────────

describe('Wave spawner', () => {
  test('processWaves spawns units on matching round', () => {
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 3;

    const waves = [
      { round: 3, units: [{ type: 'zombie', spawnAt: { col: 4, row: 4 } }] },
      { round: 5, units: [{ type: 'minion', spawnAt: { col: 5, row: 5 } }] },
    ];

    const initialCount = state.entities.length;
    const createFn = (type, col, row) => {
      if (type === 'zombie') return createZombie(col, row, 'witch');
      return createMinion(col, row, 'witch');
    };
    const logs = processWaves(state, waves, createFn);

    assert.equal(state.entities.length, initialCount + 1);
    assert.equal(logs.length, 1);
    // Round 5 wave should NOT spawn
    const witchEntities = state.entities.filter(e => e.owner === 'witch');
    assert.equal(witchEntities.length, 1);
  });

  test('processWaves returns empty for null waves', () => {
    const mapData = MISSION_MAP_BUILDERS.prologue();
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    const logs = processWaves(state, null, () => {});
    assert.deepEqual(logs, []);
  });

  test('processWaves handles graveyard spawn location', () => {
    const mapData = MISSION_MAP_BUILDERS.first_night();
    const state = new GameState(true, false, 'standard', null, mapData);
    state.round = 3;

    const waves = [
      { round: 3, units: [{ type: 'zombie', spawnAt: 'graveyard' }] },
    ];

    const initialCount = state.entities.length;
    const createFn = (type, col, row) => createZombie(col, row, 'witch');
    processWaves(state, waves, createFn);

    // Should have spawned one zombie at the graveyard
    assert.equal(state.entities.length, initialCount + 1);
  });
});
