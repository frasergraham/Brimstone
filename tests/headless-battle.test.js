// Tests for headless battle mode support and performance metrics
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, GameMode } from '../src/game.js';
import { HeroAIEngine } from '../src/hero-ai-engine.js';
import { WitchAIEngine } from '../src/ai-engine.js';
import { resolvePlansMP, ResEventType } from '../server/resolver.js';
import { generateBattleStarts, MAP_SIZES } from '../src/map.js';
import { HERO_PLAYER_COLORS, WITCH_PLAYER_COLORS } from '../src/entities.js';
import { hexKey } from '../src/hex.js';
import { BuildingType } from '../src/tiles.js';
import { serializeState } from '../server/state-sync.js';
import { randomUUID } from 'crypto';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Build a battle-mode game state with N players per side (mirrors headless.js). */
function buildBattleState(perSide) {
  const state = new GameState(true, true, 'battle');
  state.gameMode     = GameMode.BATTLE;
  state.battleConfig = { endsAt: 0, maxPlayersPerSide: perSide };

  // Clear default entities/players — battle adds all via addPlayer
  state.entities.length = 0;
  state.players.length  = 0;
  state.hero  = null;
  state.witch = null;

  const heroStarts  = generateBattleStarts(state.tiles, 'hero',  perSide, 2);
  const witchStarts = generateBattleStarts(state.tiles, 'witch', perSide, 2);

  for (let i = 0; i < perSide; i++) {
    const hp = heroStarts[i] ?? heroStarts[0];
    state.addPlayer(randomUUID(), `Hero${i + 1}`, 'hero', hp.col, hp.row, true);
  }
  for (let i = 0; i < perSide; i++) {
    const wp = witchStarts[i] ?? witchStarts[0];
    state.addPlayer(randomUUID(), `Witch${i + 1}`, 'witch', wp.col, wp.row, true);
  }

  // Assign colors
  let heroIdx = 0, witchIdx = 0;
  for (const p of state.players) {
    const colors = p.faction === 'hero' ? HERO_PLAYER_COLORS : WITCH_PLAYER_COLORS;
    const idx    = p.faction === 'hero' ? heroIdx++ : witchIdx++;
    const leader = state.entities.find(e => e.id === p.leaderId);
    if (leader) leader.color = colors[idx % colors.length];
  }

  return state;
}

// ── Battle map exists ────────────────────────────────────────────────────────

describe('Battle map size', () => {
  test('MAP_SIZES includes battle (42x42)', () => {
    assert.ok(MAP_SIZES.battle);
    assert.equal(MAP_SIZES.battle.cols, 42);
    assert.equal(MAP_SIZES.battle.rows, 42);
  });
});

// ── Battle state setup ───────────────────────────────────────────────────────

describe('Battle mode state construction', () => {
  test('creates correct number of players for 10v10', () => {
    const state = buildBattleState(10);
    assert.equal(state.players.length, 20);
    assert.equal(state.players.filter(p => p.faction === 'hero').length, 10);
    assert.equal(state.players.filter(p => p.faction === 'witch').length, 10);
  });

  test('creates correct number of players for 3v3', () => {
    const state = buildBattleState(3);
    assert.equal(state.players.length, 6);
  });

  test('all players have leader entities', () => {
    const state = buildBattleState(5);
    for (const p of state.players) {
      const leader = state.entities.find(e => e.id === p.leaderId);
      assert.ok(leader, `Player ${p.name} should have a leader entity`);
      assert.ok(leader.hp > 0, `Leader for ${p.name} should be alive`);
    }
  });

  test('gameMode is BATTLE and battleConfig is set', () => {
    const state = buildBattleState(4);
    assert.equal(state.gameMode, GameMode.BATTLE);
    assert.ok(state.battleConfig);
    assert.equal(state.battleConfig.maxPlayersPerSide, 4);
  });

  test('hero and witch leaders are at their faction buildings', () => {
    const state = buildBattleState(5);
    const heroLeaders  = state.players.filter(p => p.faction === 'hero')
      .map(p => state.entities.find(e => e.id === p.leaderId));
    const witchLeaders = state.players.filter(p => p.faction === 'witch')
      .map(p => state.entities.find(e => e.id === p.leaderId));

    // Heroes should be at INN buildings
    for (const h of heroLeaders) {
      const t = state.tiles.get(hexKey(h.col, h.row));
      assert.ok(t, `tile at hero pos ${h.col},${h.row} should exist`);
      assert.equal(t.building, BuildingType.INN, `Hero leader at ${h.col},${h.row} should be at an INN`);
    }
    // Witches should be at GRAVEYARD buildings
    for (const w of witchLeaders) {
      const t = state.tiles.get(hexKey(w.col, w.row));
      assert.ok(t, `tile at witch pos ${w.col},${w.row} should exist`);
      assert.equal(t.building, BuildingType.GRAVEYARD, `Witch leader at ${w.col},${w.row} should be at a GRAVEYARD`);
    }
  });
});

// ── AI plan generation and resolution with many players ──────────────────────

describe('Battle mode plan generation and resolution', () => {
  test('can generate plans for 10v10 and resolve without errors', () => {
    const perSide = 10;
    const state = buildBattleState(perSide);

    const playerAIs = new Map();
    for (const p of state.players) {
      const AIClass = p.faction === 'hero' ? HeroAIEngine : WitchAIEngine;
      playerAIs.set(p.id, new AIClass(state, () => {}, 0, p.id));
    }

    state.startPlanning();

    const playerEntries = [];
    const ordered = [
      ...state.players.filter(p => p.faction === 'hero'),
      ...state.players.filter(p => p.faction === 'witch'),
    ];
    for (const p of ordered) {
      const ai = playerAIs.get(p.id);
      const plan = ai.generatePlan({ claimedNodes: new Set(), allyPositions: [] });
      state.submitPlayerPlan(p.id, plan);
      playerEntries.push({ playerId: p.id, faction: p.faction, plan });
    }

    assert.equal(playerEntries.length, 20, 'Should have 20 plan entries');

    // Resolution should not throw
    const steps = resolvePlansMP(state, playerEntries);
    assert.ok(Array.isArray(steps), 'Should return steps array');
    assert.ok(steps.length > 0, 'Should have at least one step');
  });
});

// ── Performance metric measurement ───────────────────────────────────────────

describe('Performance metrics measurability', () => {
  test('serialized state is measurable in bytes', () => {
    const state = buildBattleState(10);
    const snap = serializeState(state);
    const json = JSON.stringify(snap);
    const bytes = Buffer.byteLength(json, 'utf8');

    // 42x42 map with 20 players — expect a substantial payload
    assert.ok(bytes > 10000, `State should be >10KB, got ${bytes} bytes`);
  });

  test('resolution steps are serializable and measurable', () => {
    const state = buildBattleState(3);
    const playerAIs = new Map();
    for (const p of state.players) {
      const AIClass = p.faction === 'hero' ? HeroAIEngine : WitchAIEngine;
      playerAIs.set(p.id, new AIClass(state, () => {}, 0, p.id));
    }

    state.startPlanning();
    const playerEntries = [];
    for (const p of state.players) {
      const ai = playerAIs.get(p.id);
      const plan = ai.generatePlan({ claimedNodes: new Set(), allyPositions: [] });
      state.submitPlayerPlan(p.id, plan);
      playerEntries.push({ playerId: p.id, faction: p.faction, plan });
    }

    const steps = resolvePlansMP(state, playerEntries);
    const json = JSON.stringify(steps);
    const bytes = Buffer.byteLength(json, 'utf8');

    assert.ok(bytes > 0, 'Steps payload should have non-zero size');
  });

  test('plan generation time is non-negative', () => {
    const state = buildBattleState(2);
    const playerAIs = new Map();
    for (const p of state.players) {
      const AIClass = p.faction === 'hero' ? HeroAIEngine : WitchAIEngine;
      playerAIs.set(p.id, new AIClass(state, () => {}, 0, p.id));
    }

    state.startPlanning();

    const start = performance.now();
    for (const p of state.players) {
      const ai = playerAIs.get(p.id);
      ai.generatePlan({ claimedNodes: new Set(), allyPositions: [] });
    }
    const elapsed = performance.now() - start;

    assert.ok(elapsed >= 0, 'Elapsed time should be non-negative');
  });
});
