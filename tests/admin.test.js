// Tests for admin panel: server/admin.js helpers and server/lobby.js adminResumeGame.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import { getAllPlayers, getAllSaves, getSaveWithState, getAllGamesPaginated } from '../server/admin.js';
import { createCompletedGame, deleteCompletedGame } from '../server/saves.js';
import { upsertSave, deleteSave } from '../server/saves.js';
import { getRooms, getRoom } from '../server/lobby.js';
import { GameState } from '../src/game.js';
import { serializeState } from '../server/state-sync.js';
import { VERSION } from '../src/version.js';
import { registerOrLogin } from '../server/auth.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanUp() {
  db.prepare('DELETE FROM game_saves WHERE room_id LIKE ?').run('test-%');
  db.prepare('DELETE FROM players WHERE username LIKE ?').run('test-admin-%');
}

/** Clear all room timers to prevent process hangs. */
function cleanUpRooms() {
  for (const r of getRooms()) {
    const room = getRoom(r.id);
    if (room) {
      if (room.state) room.state.winner = 'hero';
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.allHumansGoneTimer) clearTimeout(room.allHumansGoneTimer);
      for (const t of room.disconnectTimers?.values() ?? []) clearTimeout(t);
      for (const t of room.takeoverTimers?.values() ?? []) clearTimeout(t);
    }
  }
}

function createTestPlayer(suffix) {
  const result = registerOrLogin({ username: `test-admin-${suffix}` });
  assert.ok(result.ok, `Failed to create test player: ${result.error}`);
  return result.player;
}

function createTestSave(roomId, heroPlayerId, witchPlayerId) {
  const state = new GameState(true, true);
  const snap = serializeState(state);
  upsertSave(roomId, heroPlayerId, witchPlayerId, 'TestHero', 'TestWitch', snap);
  return snap;
}

// ── getAllPlayers ─────────────────────────────────────────────────────────────

describe('getAllPlayers', () => {
  beforeEach(cleanUp);

  test('returns an array (possibly empty)', () => {
    const players = getAllPlayers();
    assert.ok(Array.isArray(players));
  });

  test('includes test player after registration', () => {
    const p = createTestPlayer('list1');
    const players = getAllPlayers();
    const found = players.find(r => r.id === p.id);
    assert.ok(found, 'Registered player should appear in getAllPlayers');
    assert.equal(found.username, p.username);
    assert.equal(typeof found.win_pct, 'number');
  });

  test('respects limit parameter', () => {
    createTestPlayer('lim1');
    createTestPlayer('lim2');
    const one = getAllPlayers(1);
    assert.equal(one.length, 1);
  });
});

// ── getAllSaves ───────────────────────────────────────────────────────────────

describe('getAllSaves', () => {
  beforeEach(cleanUp);

  test('returns an array', () => {
    const saves = getAllSaves();
    assert.ok(Array.isArray(saves));
  });

  test('includes a test save after upsert', () => {
    createTestSave('test-save-1', null, null);
    const saves = getAllSaves();
    const found = saves.find(s => s.room_id === 'test-save-1');
    assert.ok(found, 'Save should appear in getAllSaves');
    assert.equal(found.hero_name, 'TestHero');
    assert.equal(found.witch_name, 'TestWitch');
    // state_json should NOT be included in lightweight listing
    assert.equal(found.state_json, undefined);
    deleteSave('test-save-1');
  });

  test('multiple saves are all returned', () => {
    createTestSave('test-save-a', null, null);
    createTestSave('test-save-b', null, null);
    const saves = getAllSaves();
    const foundA = saves.some(s => s.room_id === 'test-save-a');
    const foundB = saves.some(s => s.room_id === 'test-save-b');
    assert.ok(foundA, 'Save A should be present');
    assert.ok(foundB, 'Save B should be present');
    deleteSave('test-save-a');
    deleteSave('test-save-b');
  });
});

// ── getSaveWithState ─────────────────────────────────────────────────────────

describe('getSaveWithState', () => {
  beforeEach(cleanUp);

  test('returns null for nonexistent save', () => {
    const result = getSaveWithState('nonexistent-room-id');
    assert.equal(result, null);
  });

  test('returns save with parsed state object', () => {
    createTestSave('test-detail-1', null, null);
    const result = getSaveWithState('test-detail-1');
    assert.ok(result, 'Should return save row');
    assert.equal(result.room_id, 'test-detail-1');
    assert.equal(typeof result.state, 'object');
    assert.ok(result.state.phase, 'Parsed state should have a phase field');
    assert.ok(Array.isArray(result.state.entities), 'Parsed state should have entities array');
    deleteSave('test-detail-1');
  });
});

// ── adminResumeGame ──────────────────────────────────────────────────────────

describe('adminResumeGame', () => {
  // Dynamic import to avoid circular dependency issues at module level
  let adminResumeGame;

  beforeEach(async () => {
    cleanUp();
    const lobby = await import('../server/lobby.js');
    adminResumeGame = lobby.adminResumeGame;
  });

  afterEach(cleanUpRooms);

  test('returns error for nonexistent save', () => {
    const result = adminResumeGame('nonexistent-room');
    assert.equal(result.ok, false);
    assert.equal(result.status, 404);
    assert.ok(result.error.includes('No save found'));
  });

  test('returns error for version mismatch', () => {
    // Manually insert a save with a bogus version
    const state = new GameState(true, true);
    const snap = serializeState(state);
    snap.version = 'v0.0.0-bogus';
    upsertSave('test-resume-version', null, null, 'Hero', 'Witch', snap);

    const result = adminResumeGame('test-resume-version');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('Cannot resume'));
    deleteSave('test-resume-version');
  });

  test('successfully activates a valid save and returns new roomId', () => {
    createTestSave('test-resume-ok', null, null);

    const result = adminResumeGame('test-resume-ok');
    assert.equal(result.ok, true);
    assert.ok(result.roomId, 'Should return a new roomId');
    assert.notEqual(result.roomId, 'test-resume-ok', 'New room should have a fresh ID');

    // Original save should be deleted
    const oldSave = getSaveWithState('test-resume-ok');
    assert.equal(oldSave, null, 'Original save should be deleted after activation');
  });
});

// ── Admin REST route data shape (testing functions that back the routes) ─────

describe('admin data shape contracts', () => {
  beforeEach(cleanUp);

  test('getAllPlayers rows have expected fields', () => {
    const p = createTestPlayer('shape1');
    const players = getAllPlayers();
    const found = players.find(r => r.id === p.id);
    assert.ok(found);
    assert.ok('id' in found);
    assert.ok('username' in found);
    assert.ok('wins' in found);
    assert.ok('losses' in found);
    assert.ok('draws' in found);
    assert.ok('created_at' in found);
    assert.ok('win_pct' in found);
  });

  test('getAllSaves rows have expected fields', () => {
    createTestSave('test-shape-save', null, null);
    const saves = getAllSaves();
    const found = saves.find(s => s.room_id === 'test-shape-save');
    assert.ok(found);
    assert.ok('room_id' in found);
    assert.ok('hero_player_id' in found);
    assert.ok('witch_player_id' in found);
    assert.ok('hero_name' in found);
    assert.ok('witch_name' in found);
    assert.ok('round' in found);
    assert.ok('phase' in found);
    assert.ok('game_version' in found);
    assert.ok('updated_at' in found);
    assert.ok('created_at' in found);
    deleteSave('test-shape-save');
  });
});

// ── getAllGamesPaginated — players array ─────────────────────────────────────

describe('getAllGamesPaginated players array', () => {
  const GAME_ID = 'test-admin-players-1';
  const ROOM_ID = 'test-admin-players-room';

  beforeEach(() => {
    cleanUp();
    // Clean up any leftover completed game from prior runs
    try { db.prepare('DELETE FROM completed_games WHERE game_id = ?').run(GAME_ID); } catch {}
    try { db.prepare('DELETE FROM completed_game_rounds WHERE game_id = ?').run(GAME_ID); } catch {}
  });

  afterEach(() => {
    try { db.prepare('DELETE FROM completed_games WHERE game_id = ?').run(GAME_ID); } catch {}
    try { db.prepare('DELETE FROM completed_game_rounds WHERE game_id = ?').run(GAME_ID); } catch {}
  });

  test('completed games include parsed players array with AI tags', () => {
    const players = [
      { playerId: 'p1', name: 'Alice', faction: 'hero', isAI: false },
      { playerId: 'p2', name: 'Bob', faction: 'hero', isAI: false },
      { playerId: 'p3', name: 'WitchBot', faction: 'witch', isAI: true },
      { playerId: 'p4', name: 'EvilBot', faction: 'witch', isAI: true },
    ];
    createCompletedGame(GAME_ID, ROOM_ID, {
      heroPlayerId: 'p1',
      witchPlayerId: 'p3',
      heroName: 'Alice',
      witchName: 'WitchBot',
      winner: 'hero',
      winReason: 'Witch slain',
      totalRounds: 10,
      gameVersion: 'v0.0.0-test',
      mode: '2v2',
      playersJson: JSON.stringify(players),
    }, []);

    const result = getAllGamesPaginated({ source: 'completed_mp', limit: 100 });
    const game = result.games.find(g => g.id === GAME_ID);
    assert.ok(game, 'Test game should appear in results');

    // Should have players array instead of just counts
    assert.ok(Array.isArray(game.players), 'game.players should be an array');
    assert.equal(game.players.length, 4, 'Should have all 4 players');

    // Verify player details are present
    const alice = game.players.find(p => p.name === 'Alice');
    assert.ok(alice, 'Alice should be in players');
    assert.equal(alice.faction, 'hero');
    assert.equal(alice.isAI, false);

    const witchBot = game.players.find(p => p.name === 'WitchBot');
    assert.ok(witchBot, 'WitchBot should be in players');
    assert.equal(witchBot.faction, 'witch');
    assert.equal(witchBot.isAI, true);

    // Counts should still be present
    assert.equal(game.human_players, 2);
    assert.equal(game.total_players, 4);
  });

  test('games without players_json get empty players array', () => {
    const result = getAllGamesPaginated({ source: 'saved', limit: 1 });
    // Even if no saved games, the structure should work
    assert.ok(Array.isArray(result.games));
    for (const g of result.games) {
      assert.ok(Array.isArray(g.players), 'Every game should have a players array');
    }
  });
});
