// Tests for campaign/story mode: Campaign class, victory delegates, no-witch games, wave spawner.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase } from '../src/game.js';
import { EntityType, createMinion, createZombie, createSurvivor, markRosterUsedByName, resetRoster, SURVIVOR_ROSTER } from '../src/entities.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import {
  Campaign, buildVictoryDelegate, snapshotSurvivor, processWaves,
  reconcileRosterAfterMission,
} from '../src/campaign/campaign.js';
import { ObjectiveType, processStoryTriggers } from '../src/campaign/missions.js';
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

const hollowDef = getCampaignById('calebs_hollow_prologue');

function buildMap(builderKey) {
  return hollowDef.mapBuilders[builderKey]();
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
      // Disabled (coming soon) campaigns don't need firstMission or populated missions
      if (!c.disabled) {
        assert.ok(c.firstMission, `${c.id} missing firstMission`);
      }
      assert.ok('prerequisiteCampaign' in c, `${c.id} missing prerequisiteCampaign field`);
    }
  });

  test('getCampaignById returns matching campaign', () => {
    assert.ok(hollowDef);
    assert.equal(hollowDef.id, 'calebs_hollow_prologue');
  });

  test('getCampaignById returns null for unknown ID', () => {
    assert.equal(getCampaignById('nonexistent'), null);
  });
});

// ── Mission definitions (inside campaign) ───────────────────────────────────

describe('Mission definitions', () => {
  test('all missions have required fields', () => {
    for (const m of hollowDef.missions) {
      assert.ok(m.id, `mission missing id`);
      assert.ok(m.title, `${m.id} missing title`);
      assert.ok(m.briefing, `${m.id} missing briefing`);
      assert.ok(m.mapBuilder, `${m.id} missing mapBuilder`);
      assert.ok(m.objectives?.win, `${m.id} missing win objective`);
      assert.ok(m.objectives?.lose, `${m.id} missing lose objective`);
    }
  });

  test('all mission map builders exist and return valid mapData', () => {
    for (const m of hollowDef.missions) {
      const builder = hollowDef.mapBuilders[m.mapBuilder];
      assert.ok(builder, `No builder for ${m.mapBuilder}`);
      const mapData = builder();
      assert.ok(mapData.tiles instanceof Map, `${m.id}: tiles is not a Map`);
      assert.ok(mapData.heroStart, `${m.id}: missing heroStart`);
      assert.ok(typeof mapData.cols === 'number', `${m.id}: missing cols`);
      assert.ok(typeof mapData.rows === 'number', `${m.id}: missing rows`);
    }
  });

  test('prologue campaign has 6 missions total', () => {
    assert.equal(hollowDef.missions.length, 6);
  });

  test('mission prerequisites form a valid chain', () => {
    const completed = new Set();
    for (const m of hollowDef.missions) {
      if (m.requires) {
        for (const req of m.requires) {
          assert.ok(completed.has(req), `${m.id} requires ${req} which hasn't appeared yet`);
        }
      }
      completed.add(m.id);
    }
  });

  test('firstMission matches the first mission id', () => {
    assert.equal(hollowDef.firstMission, hollowDef.missions[0].id);
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
    const c = new Campaign(hollowDef);
    assert.equal(c.currentMission, 'prologue');
    assert.equal(c.roster.length, 0);
    assert.equal(c.completedMissions.size, 0);
  });

  test('campaign stores campaignDef reference', () => {
    const c = new Campaign(hollowDef);
    assert.equal(c.campaignDef.id, 'calebs_hollow_prologue');
    assert.equal(c.campaignDef.missions.length, 6);
  });

  test('save slot defaults to campaign-{id}', () => {
    const c = new Campaign(hollowDef);
    assert.equal(c.saveSlot, 'campaign-calebs_hollow_prologue');
  });

  test('save slot can be overridden', () => {
    const c = new Campaign(hollowDef, 'custom-slot');
    assert.equal(c.saveSlot, 'custom-slot');
  });

  test('save and load round-trips', () => {
    const c = new Campaign(hollowDef);
    c.resources.herbs = 5;
    c.roster.push({ name: 'Abigail', hp: 3, maxHp: 4 });
    c.save();

    const c2 = new Campaign(hollowDef);
    const loaded = c2.load();
    assert.ok(loaded);
    assert.equal(c2.resources.herbs, 5);
    assert.equal(c2.roster.length, 1);
    assert.equal(c2.roster[0].name, 'Abigail');
  });

  test('save includes campaignId', () => {
    const c = new Campaign(hollowDef);
    c.save();
    const raw = JSON.parse(localStorage.getItem(`brimstone-campaign-calebs_hollow_prologue`));
    assert.equal(raw.campaignId, 'calebs_hollow_prologue');
  });

  test('delete clears save', () => {
    const c = new Campaign(hollowDef, 'test-del');
    c.save();
    assert.ok(Campaign.exists('test-del'));
    c.delete();
    assert.ok(!Campaign.exists('test-del'));
  });

  test('getMissionList returns correct statuses', () => {
    const c = new Campaign(hollowDef);
    const list = c.getMissionList();
    assert.equal(list.length, 6);
    assert.ok(list[0].available);      // prologue — no prereqs
    assert.ok(!list[1].available);     // gathering_survivors — needs prologue
    assert.ok(!list[2].available);     // first_night — needs gathering_survivors
    assert.ok(!list[3].available);     // river_crossing — needs first_night
    assert.ok(!list[4].available);     // dark_ritual — needs river_crossing
    assert.ok(!list[5].available);     // witchs_trail — needs dark_ritual
  });

  test('getMissionDef looks up from campaignDef missions', () => {
    const c = new Campaign(hollowDef);
    const m = c.getMissionDef('prologue');
    assert.ok(m);
    assert.equal(m.title, 'The Awakening');
  });

  test('getMapBuilder returns builder from campaignDef', () => {
    const c = new Campaign(hollowDef);
    const builder = c.getMapBuilder('prologue');
    assert.equal(typeof builder, 'function');
    const mapData = builder();
    assert.ok(mapData.tiles instanceof Map);
  });

  test('applyMissionResult advances campaign on victory', () => {
    const c = new Campaign(hollowDef);
    c.applyMissionResult('prologue', {
      won: true,
      survivors: [{ name: 'Martha', hp: 2, maxHp: 3, attack: 1, defense: 1 }],
      resources: { herbs: 3, food: 1 },
      heroStats: { hp: 12, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });
    assert.ok(c.completedMissions.has('prologue'));
    assert.equal(c.currentMission, 'gathering_survivors');
    assert.equal(c.roster.length, 1);
    assert.equal(c.roster[0].name, 'Martha');
  });

  test('applyMissionResult applies rewards on victory', () => {
    const c = new Campaign(hollowDef);
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
    const c = new Campaign(hollowDef);
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
    const c = new Campaign(hollowDef);
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

  test('isComplete returns false when missions remain', () => {
    const c = new Campaign(hollowDef);
    c.completedMissions.add('prologue');
    assert.ok(!c.isComplete());
  });

  test('isComplete returns true when all missions are completed', () => {
    const c = new Campaign(hollowDef);
    for (const m of hollowDef.missions) c.completedMissions.add(m.id);
    assert.ok(c.isComplete());
  });

  test('static isCampaignCompleted returns false with no save', () => {
    localStorage.clear();
    assert.ok(!Campaign.isCampaignCompleted(hollowDef));
  });

  test('static isCampaignCompleted returns true when all missions done', () => {
    localStorage.clear();
    const c = new Campaign(hollowDef);
    for (const m of hollowDef.missions) c.completedMissions.add(m.id);
    c.save();
    assert.ok(Campaign.isCampaignCompleted(hollowDef));
    localStorage.clear();
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
    for (const m of hollowDef.missions) {
      assert.equal(typeof m.disableScoring, 'boolean', `${m.id} missing disableScoring`);
    }
  });
});

// ── Roster balancing (min/max survivors) ─────────────────────────────────────

describe('Roster balancing config', () => {
  test('witchs_trail mission has minSurvivors and maxSurvivors', () => {
    const m = hollowDef.missions.find(m => m.id === 'witchs_trail');
    assert.equal(m.minSurvivors, 1);
    assert.equal(m.maxSurvivors, 3);
  });

  test('minSurvivors <= maxSurvivors when both set', () => {
    for (const m of hollowDef.missions) {
      if (m.minSurvivors != null && m.maxSurvivors != null) {
        assert.ok(m.minSurvivors <= m.maxSurvivors,
          `${m.id}: minSurvivors (${m.minSurvivors}) > maxSurvivors (${m.maxSurvivors})`);
      }
    }
  });

  test('maxSurvivors >= maxSurvivorsFromRoster when both set', () => {
    for (const m of hollowDef.missions) {
      if (m.maxSurvivors != null && m.maxSurvivorsFromRoster != null) {
        assert.ok(m.maxSurvivors >= m.maxSurvivorsFromRoster || m.maxSurvivorsFromRoster === 0,
          `${m.id}: maxSurvivors < maxSurvivorsFromRoster`);
      }
    }
  });

  test('missions without min/max are valid (fields are optional)', () => {
    const m = hollowDef.missions.find(m => m.id === 'prologue');
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

// ── maxDiscoverableSurvivors config ────────────────────────────────────────

describe('maxDiscoverableSurvivors config', () => {
  test('mission 1 has no discoverable survivors, mission 2 has 2', () => {
    const m1 = hollowDef.missions.find(m => m.id === 'prologue');
    const m2 = hollowDef.missions.find(m => m.id === 'first_night');
    assert.equal(m1.maxDiscoverableSurvivors, 0);
    assert.equal(m2.maxDiscoverableSurvivors, 2);
  });

  test('mission 3 does not restrict discoverable survivors', () => {
    const m3 = hollowDef.missions.find(m => m.id === 'witchs_trail');
    assert.equal(m3.maxDiscoverableSurvivors, undefined);
  });
});

// ── disableScoring on missions ─────────────────────────────────────────────

describe('disableScoring on missions', () => {
  test('all prologue missions have disableScoring set except dark_ritual', () => {
    for (const m of hollowDef.missions) {
      if (m.id === 'dark_ritual') {
        assert.equal(m.disableScoring, false, 'dark_ritual uses node scoring');
      } else {
        assert.equal(m.disableScoring, true, `${m.id} should have disableScoring: true`);
      }
    }
  });
});

// ── New map builders ──────────────────────────────────────────────────────

describe('new campaign map builders', () => {
  for (const key of ['gathering_survivors', 'river_crossing', 'dark_ritual']) {
    test(`${key} builder produces valid mapData`, () => {
      const mapData = buildMap(key);
      assert.ok(mapData.tiles instanceof Map, `${key}: tiles should be a Map`);
      assert.ok(mapData.tiles.size > 0, `${key}: tiles should be non-empty`);
      assert.ok(mapData.heroStart, `${key}: should have heroStart`);
      assert.ok(mapData.witchStart, `${key}: should have witchStart`);
      assert.ok(typeof mapData.cols === 'number', `${key}: should have cols`);
      assert.ok(typeof mapData.rows === 'number', `${key}: should have rows`);
      assert.ok(mapData.mapSize, `${key}: should have mapSize`);
    });
  }

  test('river_crossing map is a wide corridor (17x9)', () => {
    const mapData = buildMap('river_crossing');
    assert.equal(mapData.cols, 17);
    assert.equal(mapData.rows, 9);
  });

  test('dark_ritual has 2 power nodes', () => {
    const mapData = buildMap('dark_ritual');
    assert.equal(mapData.witchObjectives.length, 2);
  });

  test('gathering_survivors has no power nodes', () => {
    const mapData = buildMap('gathering_survivors');
    assert.equal(mapData.witchObjectives.length, 0);
  });
});

// ── Story triggers ────────────────────────────────────────────────────────

describe('processStoryTriggers', () => {
  test('round trigger fires on correct round', () => {
    const state = { round: 3, hero: { col: 0, row: 0 } };
    const triggers = [
      { type: 'round', round: 3, title: 'Test', text: 'Hello', flag: 'test_flag' },
    ];
    const flags = {};
    const events = processStoryTriggers(state, triggers, flags);
    assert.equal(events.length, 1);
    assert.equal(events[0].title, 'Test');
    assert.ok(flags.test_flag);
  });

  test('round trigger does not fire on wrong round', () => {
    const state = { round: 2, hero: { col: 0, row: 0 } };
    const triggers = [
      { type: 'round', round: 3, title: 'Test', text: 'Hello', flag: 'test_flag' },
    ];
    const events = processStoryTriggers(state, triggers, {});
    assert.equal(events.length, 0);
  });

  test('area trigger fires when hero is on hex', () => {
    const state = { round: 1, hero: { col: 5, row: 3 } };
    const triggers = [
      { type: 'area', hexes: [{ col: 5, row: 3 }], title: 'Found', text: 'Here', flag: 'area_flag' },
    ];
    const flags = {};
    const events = processStoryTriggers(state, triggers, flags);
    assert.equal(events.length, 1);
    assert.ok(flags.area_flag);
  });

  test('flag prevents re-firing', () => {
    const state = { round: 3, hero: { col: 0, row: 0 } };
    const triggers = [
      { type: 'round', round: 3, title: 'Test', text: 'Hello', flag: 'already_seen' },
    ];
    const flags = { already_seen: true };
    const events = processStoryTriggers(state, triggers, flags);
    assert.equal(events.length, 0);
  });

  test('returns empty for null triggers', () => {
    const events = processStoryTriggers({}, null, {});
    assert.equal(events.length, 0);
  });
});

// ── Mission content validation ────────────────────────────────────────────

describe('mission story triggers and loot overrides', () => {
  test('all missions with storyTriggers have valid trigger structure', () => {
    for (const m of hollowDef.missions) {
      if (!m.storyTriggers) continue;
      for (const t of m.storyTriggers) {
        assert.ok(t.type === 'round' || t.type === 'area', `${m.id}: trigger must be round or area`);
        assert.ok(t.title, `${m.id}: trigger must have title`);
        assert.ok(t.text, `${m.id}: trigger must have text`);
        assert.ok(t.flag, `${m.id}: trigger must have flag`);
        if (t.type === 'round') assert.ok(typeof t.round === 'number', `${m.id}: round trigger needs round`);
        if (t.type === 'area') assert.ok(Array.isArray(t.hexes), `${m.id}: area trigger needs hexes`);
      }
    }
  });

  test('missions with lootOverrides have valid structure', () => {
    for (const m of hollowDef.missions) {
      if (!m.lootOverrides) continue;
      if (m.lootOverrides.remove) {
        assert.ok(Array.isArray(m.lootOverrides.remove), `${m.id}: remove should be array`);
      }
    }
  });

  test('river_crossing has reach_hex objective', () => {
    const m = hollowDef.missions.find(m => m.id === 'river_crossing');
    assert.equal(m.objectives.win.type, 'reach_hex');
  });

  test('dark_ritual has rounds_exceeded lose condition', () => {
    const m = hollowDef.missions.find(m => m.id === 'dark_ritual');
    const loseConds = Array.isArray(m.objectives.lose) ? m.objectives.lose : [m.objectives.lose];
    assert.ok(loseConds.some(l => l.type === 'rounds_exceeded'));
  });

  test('mission 6-step progression chain is valid', () => {
    const ids = hollowDef.missions.map(m => m.id);
    assert.deepEqual(ids, [
      'prologue', 'gathering_survivors', 'first_night',
      'river_crossing', 'dark_ritual', 'witchs_trail',
    ]);
  });

  test('all missions have healBonus defined', () => {
    for (const m of hollowDef.missions) {
      assert.ok(typeof m.healBonus === 'number', `${m.id} should have healBonus`);
      assert.ok(m.healBonus > 0, `${m.id} healBonus should be positive`);
    }
  });
});

// ── healBonus ─────────────────────────────────────────────────────────────

describe('healBonus on mission victory', () => {
  let campaign;

  beforeEach(() => {
    localStorage.clear();
    campaign = new Campaign(hollowDef);
  });

  test('heals hero and survivors on victory', () => {
    // Set up damaged hero and roster
    campaign.heroStats = { hp: 5, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} };
    campaign.roster = [
      { name: 'A', title: 'Test', bio: '', ability: 'BRAWLER', abilityLabel: 'Strong', color: '#fff', hp: 1, maxHp: 4, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'B', title: 'Test', bio: '', ability: 'HEAL', abilityLabel: 'Healer', color: '#fff', hp: 3, maxHp: 5, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    // Prologue mission has healBonus: 2
    campaign.applyMissionResult('prologue', {
      won: true,
      survivors: campaign.roster,
      heroStats: { ...campaign.heroStats },
      resources: {},
      flags: {},
    });

    assert.equal(campaign.heroStats.hp, 7); // 5 + 2
    assert.equal(campaign.roster[0].hp, 3); // 1 + 2
    assert.equal(campaign.roster[1].hp, 5); // 3 + 2, capped at maxHp
  });

  test('does not heal on defeat', () => {
    campaign.heroStats = { hp: 5, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} };
    campaign.roster = [
      { name: 'A', title: 'Test', bio: '', ability: 'BRAWLER', abilityLabel: 'Strong', color: '#fff', hp: 1, maxHp: 4, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    campaign.applyMissionResult('prologue', {
      won: false,
      survivors: campaign.roster,
      heroStats: { ...campaign.heroStats },
      resources: {},
      flags: {},
    });

    assert.equal(campaign.heroStats.hp, 5); // unchanged
    assert.equal(campaign.roster[0].hp, 1); // unchanged
  });

  test('heal is capped at maxHp', () => {
    // Use first_night which has healBonus: 3
    campaign.completedMissions.add('prologue');
    campaign.completedMissions.add('gathering_survivors');
    campaign.heroStats = { hp: 13, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} };
    campaign.roster = [
      { name: 'A', title: 'Test', bio: '', ability: 'BRAWLER', abilityLabel: 'Strong', color: '#fff', hp: 4, maxHp: 4, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    campaign.applyMissionResult('first_night', {
      won: true,
      survivors: campaign.roster,
      heroStats: { ...campaign.heroStats },
      resources: {},
      flags: {},
    });

    assert.equal(campaign.heroStats.hp, 14); // 13 + 3 capped at 14
    assert.equal(campaign.roster[0].hp, 4); // already full, stays at 4
  });

  test('no healBonus field means no healing', () => {
    // Create a campaign with a mission that has no healBonus
    const customDef = {
      id: 'test_campaign',
      title: 'Test',
      description: 'Test',
      firstMission: 'test_mission',
      prerequisiteCampaign: null,
      missions: [{
        id: 'test_mission', title: 'Test', briefing: 'Test',
        mapBuilder: 'prologue', objectives: { win: { type: 'eliminate_all' }, lose: { type: 'hero_killed' } },
        hasWitch: false, disableScoring: true, maxSurvivorsFromRoster: 0,
        // no healBonus
      }],
      mapBuilders: hollowDef.mapBuilders,
    };
    const c = new Campaign(customDef);
    c.heroStats = { hp: 5, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} };
    c.roster = [
      { name: 'A', title: 'Test', bio: '', ability: 'BRAWLER', abilityLabel: 'Strong', color: '#fff', hp: 2, maxHp: 4, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    c.applyMissionResult('test_mission', {
      won: true,
      survivors: c.roster,
      heroStats: { ...c.heroStats },
      resources: {},
      flags: {},
    });

    assert.equal(c.heroStats.hp, 5); // no change
    assert.equal(c.roster[0].hp, 2); // no change
  });

  test('undeployed roster members are preserved after mission result', () => {
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Deployed', title: 'Test', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 4, maxHp: 4, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'StayedBehind', title: 'Safe', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
    ];
    // Simulate a mission where only 'Deployed' was in-game and survived
    const deployedSurvivors = [
      { name: 'Deployed', title: 'Test', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 2, maxHp: 4, attack: 1, defense: 1, weapon: null, items: {} },
    ];
    const deployedNames = new Set(deployedSurvivors.map(s => s.name));
    const undeployed = c.roster.filter(s => !deployedNames.has(s.name));
    const allSurvivors = [...deployedSurvivors, ...undeployed];

    c.applyMissionResult('prologue', {
      won: true,
      survivors: allSurvivors,
      heroStats: c.heroStats,
      resources: {},
      flags: {},
    });

    assert.equal(c.roster.length, 2, 'both survivors should be in roster');
    assert.ok(c.roster.some(s => s.name === 'Deployed'), 'deployed survivor preserved');
    assert.ok(c.roster.some(s => s.name === 'StayedBehind'), 'undeployed survivor preserved');
    // prologue has healBonus: 2, so deployed survivor heals from 2 → 4 (capped at maxHp)
    const healBonus = hollowDef.missions[0].healBonus ?? 0;
    assert.equal(c.roster.find(s => s.name === 'Deployed').hp, Math.min(2 + healBonus, 4), 'deployed survivor HP updated + healed');
    assert.equal(c.roster.find(s => s.name === 'StayedBehind').hp, Math.min(3 + healBonus, 3), 'undeployed survivor also healed');
  });
});

// ── Mid-mission save/resume ───────────────────────────────────────────────

describe('Campaign mid-mission save/resume', () => {
  beforeEach(() => localStorage.clear());

  test('mid-mission save key format is correct', () => {
    const key = `brimstone_campaign_mission_calebs_hollow_prologue_prologue`;
    const data = { campaignId: 'calebs_hollow_prologue', missionId: 'prologue', state: {}, updatedAt: Date.now() };
    localStorage.setItem(key, JSON.stringify(data));
    const loaded = JSON.parse(localStorage.getItem(key));
    assert.equal(loaded.campaignId, 'calebs_hollow_prologue');
    assert.equal(loaded.missionId, 'prologue');
  });

  test('mid-mission save can be deleted', () => {
    const key = `brimstone_campaign_mission_calebs_hollow_prologue_prologue`;
    localStorage.setItem(key, JSON.stringify({ test: true }));
    assert.ok(localStorage.getItem(key));
    localStorage.removeItem(key);
    assert.equal(localStorage.getItem(key), null);
  });

  test('mission list detects in-progress saves', () => {
    const key = `brimstone_campaign_mission_calebs_hollow_prologue_prologue`;
    localStorage.setItem(key, JSON.stringify({ campaignId: 'calebs_hollow_prologue', missionId: 'prologue' }));
    const hasSave = localStorage.getItem(key) !== null;
    assert.ok(hasSave, 'should detect in-progress save');
  });
});

// ── Campaign AI budget bonus ──────────────────────────────────────────────

describe('Campaign AI budget bonus', () => {
  test('all prologue missions have aiBudgetBonus defined', () => {
    for (const m of hollowDef.missions) {
      assert.ok(typeof m.aiBudgetBonus === 'number', `${m.id} missing aiBudgetBonus`);
      assert.ok(m.aiBudgetBonus >= 1, `${m.id} aiBudgetBonus should be at least 1`);
    }
  });

  test('later missions have higher budget bonus', () => {
    const prologue = hollowDef.missions.find(m => m.id === 'prologue');
    const darkRitual = hollowDef.missions.find(m => m.id === 'dark_ritual');
    assert.ok(darkRitual.aiBudgetBonus > prologue.aiBudgetBonus,
      'dark_ritual should have higher budget bonus than prologue');
  });

  test('campaignAIBudgetBonus survives state serialization', async () => {
    const { serializeState, deserializeState } = await import('../server/state-sync.js');
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    state.campaignAIBudgetBonus = 3;
    const snap = serializeState(state);
    assert.equal(snap.campaignAIBudgetBonus, 3);
    const restored = deserializeState(snap);
    assert.equal(restored.campaignAIBudgetBonus, 3);
  });
});

// ── Leaderless plan (campaign AI) ─────────────────────────────────────────

describe('Leaderless plan improvements', () => {
  test('leaderless plan attacks adjacent heroes', async () => {
    const { WitchAIEngine } = await import('../src/ai-engine.js');
    const mapData = buildMap('prologue');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    // Place a zombie adjacent to the hero
    const hero = state.hero;
    const neighbors = getNeighbors(hero.col, hero.row);
    const z = createZombie(neighbors[0].col, neighbors[0].row, 'witch');
    state.entities.push(z);
    state.startPlanning();
    const ai = new WitchAIEngine(state, () => {});
    const plan = ai.generatePlan();
    const battles = plan.filter(a => a.type === 'battle-unit');
    assert.ok(battles.length > 0, 'should have at least one battle action');
  });

  test('leaderless plan moves toward heroes when not adjacent', async () => {
    const { WitchAIEngine } = await import('../src/ai-engine.js');
    const mapData = buildMap('gathering_survivors');
    mapData.noWitch = true;
    const state = new GameState(true, false, 'skirmish', null, mapData);
    // Place a zombie far from hero
    const z = createZombie(9, 1, 'witch');
    state.entities.push(z);
    state.startPlanning();
    const ai = new WitchAIEngine(state, () => {});
    const plan = ai.generatePlan();
    const moves = plan.filter(a => a.type === 'move');
    assert.ok(moves.length > 0, 'should have at least one move action');
  });
});

// ── Mission failure preserves party state ────────────────────────────────

describe('Mission failure preserves party state', () => {
  beforeEach(() => localStorage.clear());

  test('defeat preserves roster (no permadeath on failure)', () => {
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'Bob', title: 'Guard', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 2, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
    ];
    c.save();

    // Simulate defeat: only Alice survived, Bob died in battle
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [{ name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 1, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} }],
      resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });

    assert.equal(c.roster.length, 2, 'both roster members should be preserved on defeat');
    assert.ok(c.roster.some(s => s.name === 'Alice'), 'Alice should still be in roster');
    assert.ok(c.roster.some(s => s.name === 'Bob'), 'Bob should still be in roster (not permadeath on defeat)');
  });

  test('defeat preserves hero stats (no dead hero carry-over)', () => {
    const c = new Campaign(hollowDef);
    c.heroStats = { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: 'sword', items: { herbs: 2 } };
    c.save();

    // Simulate defeat: hero died (hp: 0)
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [],
      resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });

    assert.equal(c.heroStats.hp, 14, 'hero HP should be preserved at pre-mission value');
    assert.equal(c.heroStats.weapon, 'sword', 'hero weapon should be preserved');
    assert.deepEqual(c.heroStats.items, { herbs: 2 }, 'hero items should be preserved');
  });

  test('defeat preserves resources (no spent resources carry-over)', () => {
    const c = new Campaign(hollowDef);
    c.resources = { wood: 5, metal: 3, herbs: 2, food: 4, silver: 1, scripture: 0 };
    c.save();

    // Simulate defeat: resources were spent during mission
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [],
      resources: { wood: 0, metal: 0, herbs: 0, food: 0, silver: 0, scripture: 0 },
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });

    assert.equal(c.resources.wood, 5, 'wood should be preserved');
    assert.equal(c.resources.metal, 3, 'metal should be preserved');
    assert.equal(c.resources.herbs, 2, 'herbs should be preserved');
    assert.equal(c.resources.food, 4, 'food should be preserved');
  });

  test('defeat preserves story flags (no in-mission flags carry-over)', () => {
    const c = new Campaign(hollowDef);
    c.storyFlags = { intro_seen: true };
    c.save();

    // Simulate defeat: new flags were set during mission
    c.applyMissionResult('prologue', {
      won: false,
      survivors: [],
      resources: {},
      heroStats: { hp: 0, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
      flags: { mid_mission_event: true },
    });

    assert.ok(c.storyFlags.intro_seen, 'pre-existing flags should be preserved');
    assert.equal(c.storyFlags.mid_mission_event, undefined, 'in-mission flags should not carry over on defeat');
  });

  test('dead deployed survivor is removed from roster on victory', () => {
    // Regression: previously, a survivor who died during a winning mission
    // was silently restored from the pre-mission roster because the
    // "undeployed" filter looked only at alive-at-end names.
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'Bob',   title: 'Guard', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
    ];

    // Simulate end-of-mission state.entities: Alice alive, Bob was deployed but died.
    const entities = [
      { owner: 'hero', type: 'survivor', name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 1, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: true },
      { owner: 'hero', type: 'survivor', name: 'Bob',   title: 'Guard', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 0, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: false },
    ];
    const survivors = reconcileRosterAfterMission(c.roster, entities);

    c.applyMissionResult('prologue', {
      won: true,
      survivors,
      resources: {},
      heroStats: { hp: 10, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} },
    });

    assert.equal(c.roster.length, 1, 'dead survivor should be dropped from roster');
    assert.equal(c.roster[0].name, 'Alice');
    assert.ok(!c.roster.some(s => s.name === 'Bob'), 'Bob should not be resurrected from pre-mission roster');
  });

  test('reconcileRosterAfterMission keeps undeployed, drops dead deployed, keeps alive deployed', () => {
    const roster = [
      { name: 'Alice', hp: 3, maxHp: 3 },
      { name: 'Bob',   hp: 2, maxHp: 3 },
      { name: 'Carol', hp: 3, maxHp: 3 }, // never deployed — stays behind
    ];
    const entities = [
      // Alice deployed and survived with reduced HP
      { owner: 'hero', type: 'survivor', name: 'Alice', hp: 1, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: true },
      // Bob deployed and died
      { owner: 'hero', type: 'survivor', name: 'Bob',   hp: 0, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: false },
      // Hero and an enemy are also in the entity list — must be ignored
      { owner: 'hero',  type: 'hero',    name: null, hp: 10, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {}, alive: true },
      { owner: 'witch', type: 'zombie',  name: null, hp: 0,  maxHp: 2,  attack: 1, defense: 1, weapon: null, items: {}, alive: false },
    ];

    const result = reconcileRosterAfterMission(roster, entities);

    const names = result.map(s => s.name).sort();
    assert.deepEqual(names, ['Alice', 'Carol'], 'only Alice (survived) and Carol (undeployed) remain');
    assert.equal(result.find(s => s.name === 'Alice').hp, 1, 'Alice HP taken from end-of-mission entity');
    assert.equal(result.find(s => s.name === 'Carol').hp, 3, 'Carol HP taken from pre-mission roster');
  });

  test('reconcileRosterAfterMission handles empty roster and no survivor entities', () => {
    const result = reconcileRosterAfterMission([], [
      { owner: 'hero', type: 'hero', name: null, hp: 10, maxHp: 14, alive: true },
    ]);
    assert.deepEqual(result, []);
  });

  test('reconcileRosterAfterMission drops a roster survivor with the same name even if only dead deployed copy exists', () => {
    const roster = [{ name: 'Ghost', hp: 3, maxHp: 3 }];
    const entities = [
      { owner: 'hero', type: 'survivor', name: 'Ghost', hp: 0, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {}, alive: false },
    ];
    const result = reconcileRosterAfterMission(roster, entities);
    assert.equal(result.length, 0, 'Ghost died in mission — gone from roster');
  });

  test('victory still applies permadeath and state changes', () => {
    const c = new Campaign(hollowDef);
    c.roster = [
      { name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 3, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
      { name: 'Bob', title: 'Guard', bio: '', ability: null, abilityLabel: null, color: '#aaa', hp: 2, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} },
    ];
    c.heroStats = { hp: 14, maxHp: 14, attack: 3, defense: 2, weapon: null, items: {} };
    c.save();

    // Victory: only Alice survived
    c.applyMissionResult('prologue', {
      won: true,
      survivors: [{ name: 'Alice', title: 'Scout', bio: '', ability: null, abilityLabel: null, color: '#fff', hp: 1, maxHp: 3, attack: 1, defense: 1, weapon: null, items: {} }],
      resources: { wood: 1 },
      heroStats: { hp: 10, maxHp: 14, attack: 3, defense: 2, weapon: 'axe', items: {} },
    });

    assert.equal(c.roster.length, 1, 'only surviving roster member on victory');
    assert.equal(c.roster[0].name, 'Alice');
    assert.equal(c.heroStats.hp, 12, 'hero HP updated + healBonus (prologue healBonus=2)');
    assert.equal(c.heroStats.weapon, 'axe', 'hero weapon updated on victory');
    assert.equal(c.resources.wood, 2, 'resources updated on victory (1 carry-forward + 1 reward)');
    assert.ok(c.completedMissions.has('prologue'), 'mission completed');
  });
});
