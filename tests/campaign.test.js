// Tests for campaign/story mode: Campaign class, victory delegates, no-witch games, wave spawner.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase } from '../src/game.js';
import { EntityType, createMinion, createZombie, createSurvivor, markRosterUsedByName, resetRoster, SURVIVOR_ROSTER } from '../src/entities.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import {
  Campaign, buildVictoryDelegate, snapshotSurvivor, processWaves,
} from '../src/campaign/campaign.js';
import { ObjectiveType } from '../src/campaign/missions.js';
import { CAMPAIGNS, getCampaignById } from '../src/campaign/campaign-registry.js';

// ── Helper: localStorage mock for Node ──────────────────────────────────────
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

// ── Helpers ────────────────────────────────────────────────────────────────

const salemDef = getCampaignById('salem_prologue');

function buildMap(builderKey) {
  return salemDef.mapBuilders[builderKey]();
}

// ── Campaign registry ──────────────────────────────────────────────────────

describe('Campaign registry', () => {
  test('CAMPAIGNS array is non-empty', () => {
    assert.ok(CAMPAIGNS.length > 0);
  });

  test('each campaign has required fields', () => {
    for (const c of CAMPAIGNS) {
      assert.ok(c.id, 'campaign missing id');
      assert.ok(c.title, `${c.id} missing title`);
      assert.ok(c.description, `${c.id} missing description`);
      assert.ok(Array.isArray(c.missions), `${c.id} missing missions array`);
      assert.ok(c.mapBuilders, `${c.id} missing mapBuilders`);
      assert.ok(c.firstMission, `${c.id} missing firstMission`);
    }
  });

  test('getCampaignById returns matching campaign', () => {
    assert.ok(salemDef);
    assert.equal(salemDef.id, 'salem_prologue');
  });

  test('getCampaignById returns null for unknown ID', () => {
    assert.equal(getCampaignById('nonexistent'), null);
  });
});

// ── Mission definitions (inside campaign) ───────────────────────────────────

describe('Mission definitions', () => {
  test('all missions have required fields', () => {
    for (const m of salemDef.missions) {
      assert.ok(m.id, `mission missing id`);
      assert.ok(m.title, `${m.id} missing title`);
      assert.ok(m.briefing, `${m.id} missing briefing`);
      assert.ok(m.mapBuilder, `${m.id} missing mapBuilder`);
      assert.ok(m.objectives?.win, `${m.id} missing win objective`);
      assert.ok(m.objectives?.lose, `${m.id} missing lose objective`);
    }
  });

  test('all mission map builders exist and return valid mapData', () => {
    for (const m of salemDef.missions) {
      const builder = salemDef.mapBuilders[m.mapBuilder];
      assert.ok(builder, `No builder for ${m.mapBuilder}`);
      const mapData = builder();
      assert.ok(mapData.tiles instanceof Map, `${m.id}: tiles is not a Map`);
      assert.ok(mapData.heroStart, `${m.id}: missing heroStart`);
      assert.ok(typeof mapData.cols === 'number', `${m.id}: missing cols`);
      assert.ok(typeof mapData.rows === 'number', `${m.id}: missing rows`);
    }
  });

  test('prologue campaign has 3 missions total', () => {
    assert.equal(salemDef.missions.length, 3);
  });

  test('mission prerequisites form a valid chain', () => {
    const completed = new Set();
    for (const m of salemDef.missions) {
      if (m.requires) {
        for (const req of m.requires) {
          assert.ok(completed.has(req), `${m.id} requires ${req} which hasn't appeared yet`);
        }
      }
      completed.add(m.id);
    }
  });

  test('firstMission matches the first mission id', () => {
    assert.equal(salemDef.firstMission, salemDef.missions[0].id);
  });
});

// ── GameState: no-witch mode ─────────────────────────────────────────────────

describe('GameState no-witch mode', () => {
  test('GameState can be created without a witch', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.witch, null);
    assert.ok(state.hero);
    assert.ok(state.hero.alive);
  });

  test('witch faction is registered but has no leader', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    const witchPlayer = state.players.find(p => p.faction === 'witch');
    assert.ok(witchPlayer);
    assert.equal(witchPlayer.leaderId, null);
  });

  test('factionEliminated returns false for no-witch faction', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.factionEliminated('witch'), false);
  });

  test('checkVictory does not crash with null witch', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.checkVictory();
    assert.equal(state.gameOver, false);
  });

  test('no-witch game with witch entities still tracks them', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
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
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'hero');
  });

  test('eliminate_all does not trigger while enemies alive', () => {
    const delegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    const mapData = buildMap('prologue');
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
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.round = 5;
    assert.equal(delegate(state), null);
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
    const mapData = buildMap('prologue');
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.hero.hp = 0;
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
    state.witch.hp = 0;
    const result = delegate(state);
    assert.ok(result);
    assert.equal(result.winner, 'hero');
  });

  test('victoryDelegate is called by checkVictory', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.victoryDelegate = buildVictoryDelegate({
      win: { type: 'eliminate_all' },
      lose: { type: 'hero_killed' },
    });
    state.checkVictory();
    assert.equal(state.winner, 'hero');
  });
});

// ── Campaign class ──────────────────────────────────────────────────────────

describe('Campaign class', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  test('new campaign starts at firstMission with empty roster', () => {
    const c = new Campaign(salemDef);
    assert.equal(c.currentMission, 'prologue');
    assert.equal(c.roster.length, 0);
    assert.equal(c.completedMissions.size, 0);
  });

  test('campaign stores campaignDef reference', () => {
    const c = new Campaign(salemDef);
    assert.equal(c.campaignDef.id, 'salem_prologue');
    assert.equal(c.campaignDef.missions.length, 3);
  });

  test('save slot defaults to campaign-{id}', () => {
    const c = new Campaign(salemDef);
    assert.equal(c.saveSlot, 'campaign-salem_prologue');
  });

  test('save slot can be overridden', () => {
    const c = new Campaign(salemDef, 'custom-slot');
    assert.equal(c.saveSlot, 'custom-slot');
  });

  test('save and load round-trips', () => {
    const c = new Campaign(salemDef);
    c.resources.herbs = 5;
    c.roster.push({ name: 'Abigail', hp: 3, maxHp: 4 });
    c.save();

    const c2 = new Campaign(salemDef);
    const loaded = c2.load();
    assert.ok(loaded);
    assert.equal(c2.resources.herbs, 5);
    assert.equal(c2.roster.length, 1);
    assert.equal(c2.roster[0].name, 'Abigail');
  });

  test('save includes campaignId', () => {
    const c = new Campaign(salemDef);
    c.save();
    const raw = JSON.parse(localStorage.getItem(`brimstone-campaign-salem_prologue`));
    assert.equal(raw.campaignId, 'salem_prologue');
  });

  test('delete clears save', () => {
    const c = new Campaign(salemDef, 'test-del');
    c.save();
    assert.ok(Campaign.exists('test-del'));
    c.delete();
    assert.ok(!Campaign.exists('test-del'));
  });

  test('getMissionList returns correct statuses', () => {
    const c = new Campaign(salemDef);
    const list = c.getMissionList();
    assert.equal(list.length, 3);
    assert.ok(list[0].available);
    assert.ok(!list[1].available);
    assert.ok(!list[2].available);
  });

  test('getMissionDef looks up from campaignDef missions', () => {
    const c = new Campaign(salemDef);
    const m = c.getMissionDef('prologue');
    assert.ok(m);
    assert.equal(m.title, 'The Awakening');
  });

  test('getMapBuilder returns builder from campaignDef', () => {
    const c = new Campaign(salemDef);
    const builder = c.getMapBuilder('prologue');
    assert.equal(typeof builder, 'function');
    const mapData = builder();
    assert.ok(mapData.tiles instanceof Map);
  });

  test('applyMissionResult advances campaign on victory', () => {
    const c = new Campaign(salemDef);
    c.applyMissionResult('prologue', {
      won: true,
      survivors: [{ name: 'Martha', hp: 2, maxHp: 3, attack: 1, defense: 1 }],
      resources: { herbs: 3, food: 1 },
      heroStats: { hp: 12, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.ok(c.completedMissions.has('prologue'));
    assert.equal(c.currentMission, 'first_night');
    assert.equal(c.roster.length, 1);
    assert.equal(c.roster[0].name, 'Martha');
  });

  test('applyMissionResult applies rewards on victory', () => {
    const c = new Campaign(salemDef);
    c.applyMissionResult('prologue', {
      won: true,
      survivors: [],
      resources: { herbs: 0 },
      heroStats: { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.equal(c.resources.herbs, 2);
    assert.equal(c.resources.food, 1);
  });

  test('applyMissionResult does not advance on defeat', () => {
    const c = new Campaign(salemDef);
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [],
      resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.ok(!c.completedMissions.has('prologue'));
    assert.equal(c.currentMission, 'prologue');
  });

  test('permadeath: dead survivors are removed from roster', () => {
    const c = new Campaign(salemDef);
    c.roster = [
      { name: 'Alice', hp: 3, maxHp: 3 },
      { name: 'Bob', hp: 2, maxHp: 3 },
    ];
    c.applyMissionResult('prologue', {
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
    entity.items.herbs = 99;
    assert.equal(snap.items.herbs, 1);
  });
});

// ── Wave spawner ────────────────────────────────────────────────────────────

describe('Wave spawner', () => {
  test('processWaves spawns units on matching round', () => {
    const mapData = buildMap('prologue');
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
    const witchEntities = state.entities.filter(e => e.owner === 'witch');
    assert.equal(witchEntities.length, 1);
  });

  test('processWaves returns empty for null waves', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    const logs = processWaves(state, null, () => {});
    assert.deepEqual(logs, []);
  });

  test('processWaves handles graveyard spawn location', () => {
    const mapData = buildMap('first_night');
    const state = new GameState(true, false, 'standard', null, mapData);
    state.round = 3;

    const waves = [
      { round: 3, units: [{ type: 'zombie', spawnAt: 'graveyard' }] },
    ];

    const initialCount = state.entities.length;
    const createFn = (type, col, row) => createZombie(col, row, 'witch');
    processWaves(state, waves, createFn);

    assert.equal(state.entities.length, initialCount + 1);
  });
});

// ── Disable scoring ─────────────────────────────────────────────────────────

describe('disableScoring', () => {
  test('disableScoring flag is set from mapDataOverride', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    mapData.disableScoring = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.disableScoring, true);
  });

  test('disableScoring defaults to false', () => {
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    assert.equal(state.disableScoring, false);
  });

  test('endRound skips node scoring when disableScoring is true', () => {
    const mapData = buildMap('first_night');
    mapData.disableScoring = true;
    const state = new GameState(true, false, 'standard', null, mapData);
    state.disableScoring = true;

    const initialScore = { ...state.nodeScore };
    for (let i = 0; i < 8; i++) {
      state.endRound();
      if (state.gameOver) break;
    }
    assert.deepEqual(state.nodeScore, initialScore);
  });

  test('all prologue missions have disableScoring set', () => {
    for (const m of salemDef.missions) {
      assert.equal(typeof m.disableScoring, 'boolean', `${m.id} missing disableScoring`);
    }
  });
});

// ── Roster balancing (min/max survivors) ─────────────────────────────────────

describe('Roster balancing config', () => {
  test('witchs_trail mission has minSurvivors and maxSurvivors', () => {
    const m = salemDef.missions.find(m => m.id === 'witchs_trail');
    assert.equal(m.minSurvivors, 1);
    assert.equal(m.maxSurvivors, 3);
  });

  test('minSurvivors <= maxSurvivors when both set', () => {
    for (const m of salemDef.missions) {
      if (m.minSurvivors != null && m.maxSurvivors != null) {
        assert.ok(m.minSurvivors <= m.maxSurvivors,
          `${m.id}: minSurvivors (${m.minSurvivors}) > maxSurvivors (${m.maxSurvivors})`);
      }
    }
  });

  test('maxSurvivors >= maxSurvivorsFromRoster when both set', () => {
    for (const m of salemDef.missions) {
      if (m.maxSurvivors != null && m.maxSurvivorsFromRoster != null) {
        assert.ok(m.maxSurvivors >= m.maxSurvivorsFromRoster || m.maxSurvivorsFromRoster === 0,
          `${m.id}: maxSurvivors < maxSurvivorsFromRoster`);
      }
    }
  });

  test('missions without min/max are valid (fields are optional)', () => {
    const m = salemDef.missions.find(m => m.id === 'prologue');
    // These fields are optional; should be undefined or null
    assert.ok(m.minSurvivors == null || typeof m.minSurvivors === 'number');
  });

  test('balancing: too many survivors get trimmed', () => {
    // Simulate the balancing logic from _initCampaignMission
    const mapData = buildMap('witchs_trail');
    const state = new GameState(true, false, 'standard', null, mapData);
    const max = 3;
    // Add 5 survivors (exceeding max of 3)
    for (let i = 0; i < 5; i++) {
      const s = createSurvivor(2 + i, 9, 'hero');
      s.owner = 'hero';
      state.entities.push(s);
    }
    const heroSurvivors = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    );
    assert.equal(heroSurvivors.length, 5);

    // Trim excess
    const excess = heroSurvivors.slice(max);
    for (const s of excess) {
      state.entities.splice(state.entities.indexOf(s), 1);
    }
    const remaining = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    );
    assert.equal(remaining.length, 3);
  });

  test('balancing: too few survivors get reinforced', () => {
    const mapData = buildMap('witchs_trail');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'standard', null, mapData);
    const min = 1;
    // No survivors deployed — below minimum
    const count = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    ).length;
    assert.equal(count, 0);

    // Spawn reinforcements
    const heroStart = mapData.heroStart;
    const spots = getNeighbors(heroStart.col, heroStart.row);
    for (let i = count; i < min && spots.length > 0; i++) {
      const spot = spots.shift();
      const s = createSurvivor(spot.col, spot.row, 'hero');
      s.owner = 'hero';
      state.entities.push(s);
    }
    const newCount = state.entities.filter(
      e => e.alive && e.owner === 'hero' && e.type === EntityType.SURVIVOR
    ).length;
    assert.equal(newCount, min);
  });
});

// ── markRosterUsedByName ─────────────────────────────────────────────────────

describe('markRosterUsedByName', () => {
  beforeEach(() => {
    resetRoster();
  });

  test('marked survivor is not generated by createSurvivor', () => {
    const targetName = SURVIVOR_ROSTER[0].name;
    markRosterUsedByName(targetName);

    // Create up to the remaining available roster entries
    const remaining = SURVIVOR_ROSTER.length - 1;
    const created = [];
    for (let i = 0; i < remaining; i++) {
      created.push(createSurvivor(0, 0, 'hero'));
    }
    const match = created.find(s => s.name === targetName);
    assert.equal(match, undefined, `${targetName} should not appear after being marked used`);
  });

  test('multiple marked survivors are all excluded', () => {
    const name1 = SURVIVOR_ROSTER[0].name;
    const name2 = SURVIVOR_ROSTER[1].name;
    markRosterUsedByName(name1);
    markRosterUsedByName(name2);

    // Create fewer than the remaining available roster entries to avoid
    // the exhaustion fallback which picks from the full list.
    const remaining = SURVIVOR_ROSTER.length - 2;
    const created = [];
    for (let i = 0; i < remaining; i++) {
      created.push(createSurvivor(0, 0, 'hero'));
    }
    assert.ok(!created.some(s => s.name === name1), `${name1} should be excluded`);
    assert.ok(!created.some(s => s.name === name2), `${name2} should be excluded`);
  });

  test('marking unknown name does not crash', () => {
    markRosterUsedByName('Nonexistent Person');
    // Should not throw, just no-op
    const s = createSurvivor(0, 0, 'hero');
    assert.ok(s.name);
  });
});
