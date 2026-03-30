// Tests for completed-game replay storage: createCompletedGame, getCompletedGames,
// getCompletedGameRounds, pinCompletedGame, deleteCompletedGame, pruneExpiredCompletedGames.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import db from '../server/db.js';
import {
  createCompletedGame,
  getCompletedGames,
  getCompletedGame,
  getCompletedGameRounds,
  pinCompletedGame,
  deleteCompletedGame,
  pruneExpiredCompletedGames,
} from '../server/saves.js';
import { registerOrLogin } from '../server/auth.js';
import { GameState } from '../src/game.js';
import { serializeState } from '../server/state-sync.js';
import { VERSION } from '../src/version.js';
import { resolvePlans } from '../server/resolver.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanUp() {
  db.prepare("DELETE FROM completed_games  WHERE game_id   LIKE 'test-%'").run();
  db.prepare("DELETE FROM game_replay_rounds WHERE game_id LIKE 'test-%'").run();
  db.prepare("DELETE FROM players WHERE username LIKE 'test-cg-%'").run();
}

function makePlayer(suffix) {
  const r = registerOrLogin({ username: `test-cg-${suffix}` });
  assert.ok(r.ok, `Failed to create player: ${r.error}`);
  return r.player;
}

/** Build a minimal round record — just needs to be JSON-serializable. */
function makeRound(roundNum, state) {
  const preState  = JSON.stringify(serializeState(state));
  // Run a quick resolution to get steps
  state.startPlanning();
  state.submitPlan('hero',  []);
  state.submitPlan('witch', []);
  let steps;
  try {
    steps = resolvePlans(state, [], []);
  } catch {
    steps = [];
  }
  return { roundNum, preStateJson: preState, stepsJson: JSON.stringify(steps) };
}

function createGame(gameId, heroId, witchId, rounds = []) {
  createCompletedGame(gameId, 'room-' + gameId, {
    heroPlayerId:  heroId,
    witchPlayerId: witchId,
    heroName:      'TestHero',
    witchName:     'TestWitch',
    winner:        'hero',
    winReason:     'Slew the Witch',
    totalRounds:   rounds.length || 3,
    gameVersion:   VERSION,
    mode:          'hvai',
  }, rounds);
}

// ── createCompletedGame ───────────────────────────────────────────────────────

describe('createCompletedGame', () => {
  beforeEach(cleanUp);

  test('inserts metadata row', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('create1');
    createGame(id, p.id, null);
    const row = db.prepare('SELECT * FROM completed_games WHERE game_id = ?').get(id);
    assert.ok(row, 'Row should exist');
    assert.equal(row.hero_player_id,  p.id);
    assert.equal(row.winner,         'hero');
    assert.equal(row.pinned,          0);
    assert.ok(row.expires_at > 0, 'expires_at should be set');
  });

  test('inserts round rows', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('create2');
    const state = new GameState(true, false);
    const rounds = [makeRound(1, state), makeRound(2, state)];
    createGame(id, p.id, null, rounds);
    const rows = db.prepare('SELECT * FROM game_replay_rounds WHERE game_id = ?').all(id);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].round_num, 1);
    assert.equal(rows[1].round_num, 2);
  });

  test('is idempotent (INSERT OR IGNORE)', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('create3');
    createGame(id, p.id, null);
    // Second call should not throw
    assert.doesNotThrow(() => createGame(id, p.id, null));
    const count = db.prepare('SELECT COUNT(*) as n FROM completed_games WHERE game_id = ?').get(id).n;
    assert.equal(count, 1);
  });
});

// ── getCompletedGames ─────────────────────────────────────────────────────────

describe('getCompletedGames', () => {
  beforeEach(cleanUp);

  test('returns games where player is hero or witch', () => {
    const p1 = makePlayer('list-h');
    const p2 = makePlayer('list-w');
    const id1 = 'test-' + randomUUID();
    const id2 = 'test-' + randomUUID();
    const id3 = 'test-' + randomUUID();
    createGame(id1, p1.id, null);    // p1 is hero
    createGame(id2, null,  p1.id);   // p1 is witch
    createGame(id3, p2.id, null);    // other player

    const games = getCompletedGames(p1.id);
    const ids = games.map(g => g.game_id);
    assert.ok(ids.includes(id1), 'Should include game where player is hero');
    assert.ok(ids.includes(id2), 'Should include game where player is witch');
    assert.ok(!ids.includes(id3), 'Should not include other player game');
  });

  test('returns empty array when no games', () => {
    const p = makePlayer('list-empty');
    assert.deepEqual(getCompletedGames(p.id), []);
  });

  test('does not include state_json (lightweight)', () => {
    const p  = makePlayer('list-light');
    const id = 'test-' + randomUUID();
    createGame(id, p.id, null);
    const games = getCompletedGames(p.id);
    const row = games.find(g => g.game_id === id);
    assert.ok(row);
    assert.equal(row.pre_state_json, undefined, 'Should not include round data in list');
  });
});

// ── getCompletedGameRounds ────────────────────────────────────────────────────

describe('getCompletedGameRounds', () => {
  beforeEach(cleanUp);

  test('returns rounds in order', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('rounds1');
    const state = new GameState(true, false);
    const rounds = [makeRound(1, state), makeRound(2, state), makeRound(3, state)];
    createGame(id, p.id, null, rounds);

    const rows = getCompletedGameRounds(id);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].round_num, 1);
    assert.equal(rows[1].round_num, 2);
    assert.equal(rows[2].round_num, 3);
  });

  test('round rows contain valid JSON', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('rounds2');
    const state = new GameState(true, false);
    const rounds = [makeRound(1, state)];
    createGame(id, p.id, null, rounds);

    const rows = getCompletedGameRounds(id);
    assert.equal(rows.length, 1);
    assert.doesNotThrow(() => JSON.parse(rows[0].pre_state_json), 'pre_state_json should be valid JSON');
    assert.doesNotThrow(() => JSON.parse(rows[0].steps_json),     'steps_json should be valid JSON');
  });

  test('returns empty array for unknown game', () => {
    assert.deepEqual(getCompletedGameRounds('test-nonexistent'), []);
  });
});

// ── pinCompletedGame ──────────────────────────────────────────────────────────

describe('pinCompletedGame', () => {
  beforeEach(cleanUp);

  test('sets pinned=1 and clears expires_at for owner', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('pin1');
    createGame(id, p.id, null);

    const ok = pinCompletedGame(id, p.id, true);
    assert.ok(ok, 'Should return true when row updated');

    const row = db.prepare('SELECT pinned, expires_at FROM completed_games WHERE game_id = ?').get(id);
    assert.equal(row.pinned, 1);
    assert.equal(row.expires_at, null, 'Pinned games should have NULL expires_at');
  });

  test('unpin restores expires_at', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('pin2');
    createGame(id, p.id, null);

    pinCompletedGame(id, p.id, true);
    pinCompletedGame(id, p.id, false);

    const row = db.prepare('SELECT pinned, expires_at FROM completed_games WHERE game_id = ?').get(id);
    assert.equal(row.pinned, 0);
    assert.ok(row.expires_at > 0, 'Unpinned games should have expires_at restored');
  });

  test('returns false for non-owner', () => {
    const id  = 'test-' + randomUUID();
    const p1  = makePlayer('pin3a');
    const p2  = makePlayer('pin3b');
    createGame(id, p1.id, null);

    const ok = pinCompletedGame(id, p2.id, true);
    assert.equal(ok, false, 'Non-owner should not be able to pin');
  });
});

// ── deleteCompletedGame ───────────────────────────────────────────────────────

describe('deleteCompletedGame', () => {
  beforeEach(cleanUp);

  test('removes metadata and rounds for owner', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('del1');
    const state = new GameState(true, false);
    createGame(id, p.id, null, [makeRound(1, state)]);

    const ok = deleteCompletedGame(id, p.id);
    assert.ok(ok, 'Should return true when deleted');

    const meta   = db.prepare('SELECT * FROM completed_games WHERE game_id = ?').get(id);
    const rounds = db.prepare('SELECT * FROM game_replay_rounds WHERE game_id = ?').all(id);
    assert.equal(meta,   undefined, 'Metadata row should be deleted');
    assert.equal(rounds.length, 0, 'Round rows should be deleted');
  });

  test('returns false for non-owner', () => {
    const id  = 'test-' + randomUUID();
    const p1  = makePlayer('del2a');
    const p2  = makePlayer('del2b');
    createGame(id, p1.id, null);

    const ok = deleteCompletedGame(id, p2.id);
    assert.equal(ok, false);
    const meta = db.prepare('SELECT * FROM completed_games WHERE game_id = ?').get(id);
    assert.ok(meta, 'Row should still exist');
  });
});

// ── pruneExpiredCompletedGames ────────────────────────────────────────────────

describe('pruneExpiredCompletedGames', () => {
  beforeEach(cleanUp);

  test('removes unpinned expired games', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('prune1');
    createGame(id, p.id, null);

    // Force expires_at into the past
    db.prepare("UPDATE completed_games SET expires_at = unixepoch() - 1 WHERE game_id = ?").run(id);

    const pruned = pruneExpiredCompletedGames();
    assert.ok(pruned >= 1, 'Should prune at least one game');

    const row = db.prepare('SELECT * FROM completed_games WHERE game_id = ?').get(id);
    assert.equal(row, undefined, 'Expired game should be removed');
  });

  test('keeps pinned games even when past expires_at', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('prune2');
    createGame(id, p.id, null);

    // Pin the game then force expires_at (pinned games have NULL expires_at, so this won't match)
    pinCompletedGame(id, p.id, true);
    // Manually set expires_at to past — but pinned=1 so it should be excluded
    db.prepare("UPDATE completed_games SET expires_at = unixepoch() - 1 WHERE game_id = ?").run(id);

    pruneExpiredCompletedGames();

    const row = db.prepare('SELECT * FROM completed_games WHERE game_id = ?').get(id);
    assert.ok(row, 'Pinned game should survive pruning');
  });

  test('keeps non-expired games', () => {
    const id = 'test-' + randomUUID();
    const p  = makePlayer('prune3');
    createGame(id, p.id, null);

    pruneExpiredCompletedGames();

    const row = db.prepare('SELECT * FROM completed_games WHERE game_id = ?').get(id);
    assert.ok(row, 'Non-expired game should survive pruning');
  });
});

// ── Replay data integrity ─────────────────────────────────────────────────────

describe('Replay data integrity', () => {
  test('steps from resolvePlans are JSON round-trippable', () => {
    const state = new GameState(true, false);
    state.startPlanning();
    state.submitPlan('hero',  []);
    state.submitPlan('witch', []);

    const steps = resolvePlans(state, [], []);
    const json  = JSON.stringify(steps);
    const parsed = JSON.parse(json);

    assert.ok(Array.isArray(parsed), 'Parsed steps should be an array');
    for (const step of parsed) {
      assert.equal(typeof step.stepIndex, 'number');
      assert.ok(
        Array.isArray(step.heroEvents) || Array.isArray(step.playerEvents),
        'Step should have heroEvents or playerEvents'
      );
    }
  });

  test('serializeState produces JSON-safe object', () => {
    const state = new GameState(true, false);
    const snap  = serializeState(state);
    assert.doesNotThrow(() => JSON.stringify(snap), 'serializeState output should be JSON-safe');
    const parsed = JSON.parse(JSON.stringify(snap));
    assert.equal(parsed.version, snap.version);
    assert.ok(Array.isArray(parsed.entities));
    assert.ok(Array.isArray(parsed.tiles));
  });
});
