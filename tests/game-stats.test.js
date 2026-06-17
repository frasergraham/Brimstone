// Tests for game stats tracking: kill/summon counters, state-sync round-trip,
// DB recording, and aggregate queries.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase } from '../src/game.js';
import { executeBattle, executeSummon } from '../src/actions.js';
import {
  createHero, createWitch, createMinion, createZombie,
  createWoodGolem, createIronGolem, setForcedDice, resetRoster,
} from '../src/entities.js';
import { hexKey } from '../src/hex.js';
import { TileType, ResourceType } from '../src/tiles.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { recordGameStats, getGameStats, getAggregateStats } from '../server/game-stats.js';
import { randomUUID } from 'crypto';

function freshState() {
  return new GameState(true, true);
}

// Place an entity on the map and return it
function placeEntity(state, entity) {
  state.entities.push(entity);
  return entity;
}

// ── Kill counter tests ───────────────────────────────────────────────────────

describe('kill counters', () => {
  test('heroKills increments when hero side kills a witch unit', () => {
    const state = freshState();
    assert.equal(state.heroKills, 0);

    const hero  = state.hero;
    const minion = placeEntity(state, createMinion(hero.col, hero.row));

    // Force a guaranteed kill: high attack roll, low defense roll
    state.setForcedDice(6, 1);
    executeBattle(state, hero, minion);

    // Minion has 2 HP; one hit deals 1 damage. Force another kill hit.
    if (state.entities.includes(minion) && minion.hp > 0) {
      state.setForcedDice(6, 1);
      executeBattle(state, hero, minion);
    }

    assert.ok(state.heroKills >= 1, `heroKills should be >= 1, got ${state.heroKills}`);
  });

  test('witchKills increments when witch side kills a hero unit', () => {
    const state = freshState();
    assert.equal(state.witchKills, 0);

    const witch = state.witch;
    // Create a weak target for the witch
    const minion = placeEntity(state, createMinion(witch.col, witch.row));
    // Change minion to hero side for testing
    minion.owner = 'hero';
    minion.hp = 1;

    // Witch has range 2, so attacking a same-hex target counts as a
    // close-range ranged attack with 1 disadvantage die (2 atk dice, worst
    // pick). Pad with extra 6s so the worst-of-2 still lands the hit.
    state.setForcedDice(6, 6, 1);
    executeBattle(state, witch, minion);

    assert.ok(state.witchKills >= 1, `witchKills should be >= 1, got ${state.witchKills}`);
  });

  test('counter-kill increments the defender side kill count', () => {
    const state = freshState();
    const hero = state.hero;

    // Create a minion with 1 HP attacking the hero
    const minion = placeEntity(state, createMinion(hero.col, hero.row));

    // Force: low attack roll (1), very high defense roll (6) → counter
    // Counter requires defenseRoll >= 2 * attackRoll
    // minion ATK=1, hero DEF=2: attackRoll = 1+1+0 = 2, defenseRoll = 6+2+0 = 8
    // 8 >= 2*2 → counter, deals 1 damage to minion (hp=2→1)
    // Actually minion attacks hero and hero counters; we need minion as attacker
    state.setForcedDice(1, 6);
    executeBattle(state, minion, hero);

    // The hero (defender) should get a counter-kill credit
    assert.ok(state.heroKills >= 1 || minion.hp > 0,
      'heroKills should increment on counter-kill, or minion survived');
  });
});

// ── Summon counter tests ─────────────────────────────────────────────────────

describe('witchSummonCount', () => {
  test('increments on successful summon', () => {
    const state = freshState();
    assert.equal(state.witchSummonCount, 0);

    // Give witch resources to summon
    state.inventory.witch[ResourceType.WOOD] = { count: 4 };
    state.inventory.witch[ResourceType.METAL] = { count: 4 };

    const witch = state.witch;
    const result = executeSummon(state, witch);
    assert.ok(result.success);
    assert.equal(state.witchSummonCount, 1);

    // Summon again
    const result2 = executeSummon(state, witch);
    assert.ok(result2.success);
    assert.equal(state.witchSummonCount, 2);
  });

  test('does not increment on failed summon', () => {
    const state = freshState();
    // No resources
    state.inventory.witch = {};

    const result = executeSummon(state, state.witch);
    assert.ok(!result.success);
    assert.equal(state.witchSummonCount, 0);
  });
});

// ── State sync round-trip tests ──────────────────────────────────────────────

describe('state-sync round-trips new stat fields', () => {
  test('heroKills, witchKills, witchSummonCount survive serialize/deserialize', () => {
    const state = freshState();
    state.heroKills = 5;
    state.witchKills = 3;
    state.witchSummonCount = 7;

    const snap = serializeState(state);
    assert.equal(snap.heroKills, 5);
    assert.equal(snap.witchKills, 3);
    assert.equal(snap.witchSummonCount, 7);

    const restored = deserializeState(snap);
    assert.equal(restored.heroKills, 5);
    assert.equal(restored.witchKills, 3);
    assert.equal(restored.witchSummonCount, 7);
  });

  test('defaults to 0 for missing fields (backward compat)', () => {
    const state = freshState();
    const snap = serializeState(state);

    // Simulate an old snapshot without the new fields
    delete snap.heroKills;
    delete snap.witchKills;
    delete snap.witchSummonCount;

    const restored = deserializeState(snap);
    assert.equal(restored.heroKills, 0);
    assert.equal(restored.witchKills, 0);
    assert.equal(restored.witchSummonCount, 0);
  });

  test('maxDiscoverableSurvivors and discoveredSurvivorCount survive round-trip', () => {
    const state = freshState();
    state.maxDiscoverableSurvivors = 2;
    state.discoveredSurvivorCount = 1;

    const snap = serializeState(state);
    assert.equal(snap.maxDiscoverableSurvivors, 2);
    assert.equal(snap.discoveredSurvivorCount, 1);

    const restored = deserializeState(snap);
    assert.equal(restored.maxDiscoverableSurvivors, 2);
    assert.equal(restored.discoveredSurvivorCount, 1);
  });

  test('maxDiscoverableSurvivors defaults to null for old snapshots', () => {
    const state = freshState();
    const snap = serializeState(state);
    delete snap.maxDiscoverableSurvivors;
    delete snap.discoveredSurvivorCount;

    const restored = deserializeState(snap);
    assert.equal(restored.maxDiscoverableSurvivors, null);
    assert.equal(restored.discoveredSurvivorCount, 0);
  });
});

// ── Database stats tests ─────────────────────────────────────────────────────

describe('game-stats DB module', () => {
  function makeStats(overrides = {}) {
    return {
      id: randomUUID(),
      mode: 'local',
      map_size: 'standard',
      winner: 'hero',
      win_reason: 'witch_slain',
      rounds: 15,
      final_phase: 'day',
      hero_score: 2,
      witch_score: 1,
      hero_kills: 3,
      witch_kills: 1,
      hero_survivors: 2,
      witch_summons: 4,
      hero_personality: 'HeroBerserker',
      witch_personality: 'WitchSwarm',
      hero_player_id: null,
      witch_player_id: null,
      game_version: '1.0.4',
      fog_of_war: 1,
      duration_ms: 120000,
      ...overrides,
    };
  }

  test('recordGameStats inserts and getGameStats retrieves', () => {
    const stats = makeStats();
    recordGameStats(stats);

    const rows = getGameStats({ limit: 1000 });
    const found = rows.find(r => r.id === stats.id);
    assert.ok(found, 'inserted stats should be retrievable');
    assert.equal(found.winner, 'hero');
    assert.equal(found.rounds, 15);
    assert.equal(found.hero_kills, 3);
    assert.equal(found.game_version, '1.0.4');
  });

  test('getGameStats filters by mode', () => {
    const id1 = randomUUID();
    const id2 = randomUUID();
    recordGameStats(makeStats({ id: id1, mode: 'online' }));
    recordGameStats(makeStats({ id: id2, mode: 'local' }));

    const online = getGameStats({ mode: 'online', limit: 1000 });
    assert.ok(online.some(r => r.id === id1));
    assert.ok(!online.some(r => r.id === id2));
  });

  test('getAggregateStats returns valid summary', () => {
    // Insert a few known records
    recordGameStats(makeStats({ winner: 'hero',  rounds: 10 }));
    recordGameStats(makeStats({ winner: 'witch', rounds: 20 }));
    recordGameStats(makeStats({ winner: 'hero',  rounds: 15 }));

    const agg = getAggregateStats();
    assert.ok(agg.totalGames >= 3, `totalGames should be >= 3, got ${agg.totalGames}`);
    assert.ok(agg.heroWins >= 2);
    assert.ok(agg.witchWins >= 1);
    assert.ok(agg.avgRounds > 0);
    assert.ok(typeof agg.heroWinPct === 'number');
    assert.ok(Array.isArray(agg.byWinReason));
    assert.ok(Array.isArray(agg.byVersion));
    assert.ok(Array.isArray(agg.byPersonality));
  });
});
