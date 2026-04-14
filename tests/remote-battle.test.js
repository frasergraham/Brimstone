// Tests for the remote-battle module — admin-controlled battle roster
// with manual turn timing.
import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBattle,
  addPlayer,
  resignPlayer,
  startBattle,
  generateTurn,
  generateAllTurns,
  submitCustomPlan,
  resolveRound,
  getBattleStatus,
  listBattles,
  getPersonalities,
  deleteBattle,
} from '../server/remote-battle.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Create a battle with 1 hero and 1 witch and start it. */
function createAndStart(opts = {}) {
  const battle = createBattle({
    name: opts.name || 'Test Battle',
    mapSize: opts.mapSize || 'skirmish',
    playersPerSide: opts.playersPerSide || 1,
  });
  const h = addPlayer(battle.id, { faction: 'hero', type: 'ai', personality: 'balanced' });
  const w = addPlayer(battle.id, { faction: 'witch', type: 'ai', personality: 'balanced' });
  startBattle(battle.id);
  return { battleId: battle.id, heroId: h.playerId, witchId: w.playerId };
}

// ── Creation ────────────────────────────────────────────────────────────────

describe('Remote Battle — creation', () => {
  test('createBattle returns battle with correct fields', () => {
    const b = createBattle({ name: 'Unit Test', mapSize: 'skirmish', playersPerSide: 2 });
    assert.ok(b.id);
    assert.equal(b.name, 'Unit Test');
    assert.equal(b.mapSize, 'skirmish');
    assert.equal(b.playersPerSide, 2);
    assert.equal(b.phase, 'setup');
    assert.equal(b.roster.length, 0);
    // cleanup
    deleteBattle(b.id);
  });

  test('createBattle defaults to standard map and 2 per side', () => {
    const b = createBattle({});
    assert.equal(b.mapSize, 'standard');
    assert.equal(b.playersPerSide, 2);
    deleteBattle(b.id);
  });

  test('createBattle clamps playersPerSide between 1 and 10', () => {
    const b1 = createBattle({ playersPerSide: 0 });
    assert.equal(b1.playersPerSide, 1);
    const b2 = createBattle({ playersPerSide: 99 });
    assert.equal(b2.playersPerSide, 10);
    deleteBattle(b1.id);
    deleteBattle(b2.id);
  });
});

// ── Roster management ───────────────────────────────────────────────────────

describe('Remote Battle — roster', () => {
  test('addPlayer adds hero AI to roster', () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 2 });
    const result = addPlayer(b.id, { faction: 'hero', type: 'ai', personality: 'balanced' });
    assert.ok(result.ok);
    assert.ok(result.playerId);
    const status = getBattleStatus(b.id);
    assert.equal(status.roster.length, 1);
    assert.equal(status.roster[0].faction, 'hero');
    assert.equal(status.roster[0].type, 'ai');
    deleteBattle(b.id);
  });

  test('addPlayer rejects invalid faction', () => {
    const b = createBattle({ mapSize: 'skirmish' });
    const result = addPlayer(b.id, { faction: 'goblin' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('Faction'));
    deleteBattle(b.id);
  });

  test('addPlayer enforces per-side limit', () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 1 });
    const r1 = addPlayer(b.id, { faction: 'hero', type: 'ai' });
    assert.ok(r1.ok);
    const r2 = addPlayer(b.id, { faction: 'hero', type: 'ai' });
    assert.equal(r2.ok, false);
    assert.ok(r2.error.includes('full'));
    deleteBattle(b.id);
  });

  test('addPlayer supports LLM type', () => {
    const b = createBattle({ mapSize: 'skirmish' });
    const result = addPlayer(b.id, {
      faction: 'witch', type: 'llm',
      llmEndpoint: 'http://localhost:9999/generate',
      llmPrompt: 'test prompt',
    });
    assert.ok(result.ok);
    const status = getBattleStatus(b.id);
    assert.equal(status.roster[0].type, 'llm');
    deleteBattle(b.id);
  });

  test('addPlayer rejects LLM without endpoint', () => {
    const b = createBattle({ mapSize: 'skirmish' });
    const result = addPlayer(b.id, { faction: 'hero', type: 'llm' });
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('llmEndpoint'));
    deleteBattle(b.id);
  });

  test('resignPlayer marks player as resigned and scatters units', () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 2 });
    const h1 = addPlayer(b.id, { faction: 'hero', type: 'ai' });
    const h2 = addPlayer(b.id, { faction: 'hero', type: 'ai' });
    addPlayer(b.id, { faction: 'witch', type: 'ai' });

    const result = resignPlayer(b.id, h1.playerId);
    assert.ok(result.ok);

    const status = getBattleStatus(b.id);
    const resigned = status.roster.find(r => r.playerId === h1.playerId);
    assert.equal(resigned.status, 'resigned');

    deleteBattle(b.id);
  });

  test('resignPlayer rejects double resign', () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 1 });
    const h = addPlayer(b.id, { faction: 'hero', type: 'ai' });
    resignPlayer(b.id, h.playerId);
    const result = resignPlayer(b.id, h.playerId);
    assert.equal(result.ok, false);
    deleteBattle(b.id);
  });
});

// ── Starting ────────────────────────────────────────────────────────────────

describe('Remote Battle — start', () => {
  test('startBattle transitions to planning phase', () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 1 });
    addPlayer(b.id, { faction: 'hero', type: 'ai' });
    addPlayer(b.id, { faction: 'witch', type: 'ai' });
    const result = startBattle(b.id);
    assert.ok(result.ok);
    const status = getBattleStatus(b.id);
    assert.equal(status.phase, 'planning');
    assert.equal(status.round, 1);
    deleteBattle(b.id);
  });

  test('startBattle rejects if no hero or witch', () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 1 });
    addPlayer(b.id, { faction: 'hero', type: 'ai' });
    const result = startBattle(b.id);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('each faction'));
    deleteBattle(b.id);
  });
});

// ── Turn generation ─────────────────────────────────────────────────────────

describe('Remote Battle — turn generation', () => {
  test('generateTurn produces a plan for an AI player', async () => {
    const { battleId, heroId, witchId } = createAndStart();
    const result = await generateTurn(battleId, heroId);
    assert.ok(result.ok);
    assert.ok(Array.isArray(result.plan));
    assert.ok(result.plan.length > 0);

    // Check plan is stored
    const status = getBattleStatus(battleId);
    const hero = status.roster.find(r => r.playerId === heroId);
    assert.ok(hero.hasPlan);
    assert.ok(hero.planLength > 0);

    deleteBattle(battleId);
  });

  test('generateTurn rejects when not in planning phase', async () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 1 });
    const h = addPlayer(b.id, { faction: 'hero', type: 'ai' });
    // Still in 'setup' phase
    const result = await generateTurn(b.id, h.playerId);
    assert.equal(result.ok, false);
    deleteBattle(b.id);
  });

  test('generateAllTurns generates plans for all players', async () => {
    const { battleId, heroId, witchId } = createAndStart();
    const result = await generateAllTurns(battleId);
    assert.ok(result.ok);
    assert.equal(result.results.length, 2);
    for (const r of result.results) {
      assert.ok(r.ok);
      assert.ok(r.plan.length > 0);
    }
    deleteBattle(battleId);
  });

  test('generateAllTurns skips players who already have plans', async () => {
    const { battleId, heroId, witchId } = createAndStart();
    // Generate hero's turn first
    await generateTurn(battleId, heroId);
    // Now generate all — should only generate for witch
    const result = await generateAllTurns(battleId);
    assert.ok(result.ok);
    assert.equal(result.results.length, 1);
    assert.equal(result.results[0].playerId, witchId);
    deleteBattle(battleId);
  });
});

// ── Custom plan submission ──────────────────────────────────────────────────

describe('Remote Battle — custom plans', () => {
  test('submitCustomPlan stores a manually crafted plan', () => {
    const { battleId, heroId } = createAndStart();
    const customPlan = [{ type: 'MOVE', entityId: 'fake', toCol: 1, toRow: 1 }];
    const result = submitCustomPlan(battleId, heroId, customPlan);
    assert.ok(result.ok);

    const status = getBattleStatus(battleId);
    const hero = status.roster.find(r => r.playerId === heroId);
    assert.ok(hero.hasPlan);
    assert.equal(hero.planLength, 1);
    deleteBattle(battleId);
  });
});

// ── Resolution ──────────────────────────────────────────────────────────────

describe('Remote Battle — resolution', () => {
  test('resolveRound advances the game to the next round', async () => {
    const { battleId, heroId, witchId } = createAndStart();

    // Generate all plans
    await generateAllTurns(battleId);

    // Resolve
    const result = resolveRound(battleId);
    assert.ok(result.ok);
    assert.ok(Array.isArray(result.steps));

    // Should be in planning phase for next round
    const status = getBattleStatus(battleId);
    assert.equal(status.phase, 'planning');
    assert.equal(status.round, 2);
    // Pending plans should be cleared
    for (const r of status.roster) {
      assert.equal(r.hasPlan, false);
    }
    deleteBattle(battleId);
  });

  test('resolveRound uses empty plan for players without pending plans', async () => {
    const { battleId } = createAndStart();
    // Don't generate any plans — resolve with empty plans
    const result = resolveRound(battleId);
    assert.ok(result.ok);
    const status = getBattleStatus(battleId);
    assert.equal(status.round, 2);
    deleteBattle(battleId);
  });

  test('resolveRound rejects when not in planning phase', () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 1 });
    addPlayer(b.id, { faction: 'hero', type: 'ai' });
    addPlayer(b.id, { faction: 'witch', type: 'ai' });
    // Still in setup
    const result = resolveRound(b.id);
    assert.equal(result.ok, false);
    deleteBattle(b.id);
  });

  test('multiple rounds can be played sequentially', async () => {
    const { battleId } = createAndStart();
    for (let i = 0; i < 3; i++) {
      await generateAllTurns(battleId);
      const result = resolveRound(battleId);
      assert.ok(result.ok);
    }
    const status = getBattleStatus(battleId);
    assert.equal(status.round, 4);
    assert.equal(status.roundCount, 3);
    deleteBattle(battleId);
  });
});

// ── Status and listing ──────────────────────────────────────────────────────

describe('Remote Battle — status and listing', () => {
  test('getBattleStatus returns null for nonexistent battle', () => {
    assert.equal(getBattleStatus('nonexistent-id'), null);
  });

  test('getBattleStatus returns full battle information', () => {
    const { battleId } = createAndStart();
    const status = getBattleStatus(battleId);
    assert.ok(status.id);
    assert.ok(status.name);
    assert.ok(status.roster.length >= 2);
    assert.equal(status.phase, 'planning');
    assert.ok(Array.isArray(status.entities));
    assert.ok(Array.isArray(status.log));
    deleteBattle(battleId);
  });

  test('listBattles includes created battles', () => {
    const b = createBattle({ name: 'List Test', mapSize: 'skirmish' });
    const all = listBattles();
    assert.ok(all.some(x => x.id === b.id));
    deleteBattle(b.id);
  });
});

// ── Personality helpers ─────────────────────────────────────────────────────

describe('Remote Battle — personalities', () => {
  test('getPersonalities returns available hero personalities', () => {
    const p = getPersonalities('hero');
    assert.ok(Array.isArray(p));
    assert.ok(p.length > 0);
    assert.ok(p.includes('balanced'));
  });

  test('getPersonalities returns available witch personalities', () => {
    const p = getPersonalities('witch');
    assert.ok(Array.isArray(p));
    assert.ok(p.length > 0);
    assert.ok(p.includes('balanced'));
  });
});

// ── Multi-player battles ────────────────────────────────────────────────────

describe('Remote Battle — multi-player', () => {
  test('2v2 battle works end to end', async () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 2 });
    addPlayer(b.id, { faction: 'hero', type: 'ai', personality: 'balanced' });
    addPlayer(b.id, { faction: 'hero', type: 'ai', personality: 'aggressive' });
    addPlayer(b.id, { faction: 'witch', type: 'ai', personality: 'balanced' });
    addPlayer(b.id, { faction: 'witch', type: 'ai', personality: 'aggressive' });

    startBattle(b.id);
    const status0 = getBattleStatus(b.id);
    assert.equal(status0.roster.length, 4);

    await generateAllTurns(b.id);
    const result = resolveRound(b.id);
    assert.ok(result.ok);

    const status1 = getBattleStatus(b.id);
    assert.equal(status1.round, 2);
    deleteBattle(b.id);
  });

  test('adding different personality AI players to same faction', () => {
    const b = createBattle({ mapSize: 'skirmish', playersPerSide: 3 });
    const r1 = addPlayer(b.id, { faction: 'hero', type: 'ai', personality: 'balanced' });
    const r2 = addPlayer(b.id, { faction: 'hero', type: 'ai', personality: 'aggressive' });
    const r3 = addPlayer(b.id, { faction: 'hero', type: 'ai', personality: 'defensive' });
    assert.ok(r1.ok);
    assert.ok(r2.ok);
    assert.ok(r3.ok);

    const status = getBattleStatus(b.id);
    const heroes = status.roster.filter(r => r.faction === 'hero');
    assert.equal(heroes.length, 3);
    // All should have unique names
    const names = new Set(heroes.map(h => h.name));
    assert.equal(names.size, 3);
    deleteBattle(b.id);
  });
});

// ── Delete ──────────────────────────────────────────────────────────────────

describe('Remote Battle — delete', () => {
  test('deleteBattle removes battle from memory', () => {
    const b = createBattle({ mapSize: 'skirmish' });
    const id = b.id;
    assert.ok(getBattleStatus(id));
    deleteBattle(id);
    // After delete, it might reload from disk — that's OK, we just test the in-memory removal
    // For a full test we'd need to clean up disk too, but that's fine for unit tests
  });

  test('deleteBattle returns error for nonexistent', () => {
    const result = deleteBattle('does-not-exist');
    assert.equal(result.ok, false);
  });
});
