// Tests for single-player completed game upload: createSpCompletedGame,
// getAllSpCompletedGames, getSpCompletedGame, getSpCompletedGameRounds.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  createSpCompletedGame,
  getAllSpCompletedGames,
  getSpCompletedGame,
  getSpCompletedGameRounds,
} from '../server/saves.js';
import { GameState } from '../src/game.js';
import { serializeState } from '../server/state-sync.js';
import { VERSION } from '../src/version.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _counter = 0;
function id() { return `test-sp-${Date.now()}-${++_counter}`; }

function cleanUp() {
  db.prepare("DELETE FROM sp_completed_games  WHERE game_id LIKE 'test-sp-%'").run();
  db.prepare("DELETE FROM sp_replay_rounds    WHERE game_id LIKE 'test-sp-%'").run();
}

function makeMeta(overrides = {}) {
  return {
    heroName:    'TestHero',
    witchName:   'TestWitch',
    winner:      'hero',
    winReason:   'Slew the Witch',
    totalRounds: 5,
    gameVersion: VERSION,
    mode:        'hvai',
    ...overrides,
  };
}

function makeRound(roundNum) {
  const state = new GameState(true, false);
  return {
    roundNum,
    preState: JSON.stringify(serializeState(state)),
    steps:    JSON.stringify([]),
  };
}

// ── createSpCompletedGame ────────────────────────────────────────────────────

describe('createSpCompletedGame', () => {
  beforeEach(cleanUp);

  test('inserts metadata row', () => {
    const gameId = id();
    createSpCompletedGame(gameId, makeMeta(), []);
    const row = getSpCompletedGame(gameId);
    assert.ok(row, 'Row should exist');
    assert.equal(row.hero_name,  'TestHero');
    assert.equal(row.witch_name, 'TestWitch');
    assert.equal(row.winner,     'hero');
    assert.equal(row.win_reason, 'Slew the Witch');
    assert.equal(row.mode,       'hvai');
  });

  test('inserts round rows', () => {
    const gameId = id();
    const rounds = [makeRound(1), makeRound(2), makeRound(3)];
    createSpCompletedGame(gameId, makeMeta({ totalRounds: 3 }), rounds);

    const rows = getSpCompletedGameRounds(gameId);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].round_num, 1);
    assert.equal(rows[2].round_num, 3);
  });

  test('handles large payloads (many rounds with full state)', () => {
    const gameId = id();
    // Simulate a long game with 25 rounds — each round includes a full
    // serialized state snapshot, mirroring the real upload payload.
    const rounds = [];
    for (let i = 1; i <= 25; i++) {
      rounds.push(makeRound(i));
    }
    createSpCompletedGame(gameId, makeMeta({ totalRounds: 25 }), rounds);

    const meta = getSpCompletedGame(gameId);
    assert.ok(meta);
    assert.equal(meta.total_rounds, 25);

    const rows = getSpCompletedGameRounds(gameId);
    assert.equal(rows.length, 25);
    // Verify round data is valid JSON
    for (const r of rows) {
      assert.doesNotThrow(() => JSON.parse(r.pre_state_json));
      assert.doesNotThrow(() => JSON.parse(r.steps_json));
    }
  });

  test('is idempotent (INSERT OR REPLACE)', () => {
    const gameId = id();
    createSpCompletedGame(gameId, makeMeta(), [makeRound(1)]);
    assert.doesNotThrow(() => {
      createSpCompletedGame(gameId, makeMeta({ winner: 'witch' }), [makeRound(1)]);
    });
    const row = getSpCompletedGame(gameId);
    assert.equal(row.winner, 'witch', 'Second insert should replace');
  });
});

// ── getAllSpCompletedGames ────────────────────────────────────────────────────

describe('getAllSpCompletedGames', () => {
  beforeEach(cleanUp);

  test('returns all uploaded games', () => {
    const id1 = id(), id2 = id();
    createSpCompletedGame(id1, makeMeta(), []);
    createSpCompletedGame(id2, makeMeta({ winner: 'witch' }), []);

    const all = getAllSpCompletedGames();
    const ids = all.map(g => g.game_id);
    assert.ok(ids.includes(id1));
    assert.ok(ids.includes(id2));
  });
});

// ── getSpCompletedGameRounds ─────────────────────────────────────────────────

describe('getSpCompletedGameRounds', () => {
  beforeEach(cleanUp);

  test('returns empty array for unknown game', () => {
    assert.deepEqual(getSpCompletedGameRounds('test-sp-nonexistent'), []);
  });

  test('round data contains valid JSON', () => {
    const gameId = id();
    createSpCompletedGame(gameId, makeMeta(), [makeRound(1)]);

    const rows = getSpCompletedGameRounds(gameId);
    assert.equal(rows.length, 1);
    assert.doesNotThrow(() => JSON.parse(rows[0].pre_state_json));
    assert.doesNotThrow(() => JSON.parse(rows[0].steps_json));
  });
});
