// Tests for async (play-by-mail) game data layer.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import db from '../server/db.js';
import {
  insertAsyncGame,
  getAsyncGame,
  getAsyncGameByCode,
  getAsyncGamesForPlayer,
  activateAsyncGame,
  updateAsyncGameState,
  finishAsyncGame,
  deleteAsyncGame,
  pruneStaleAsyncGames,
  insertPlanStatus,
  submitPlan,
  getPlanStatus,
  allPlansSubmitted,
  getExpiredGames,
} from '../server/async-game.js';
import { VERSION } from '../src/version.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function cleanUp() {
  db.prepare("DELETE FROM async_notifications WHERE room_id LIKE 'test-%'").run();
  db.prepare("DELETE FROM async_plan_status WHERE room_id LIKE 'test-%'").run();
  db.prepare("DELETE FROM async_games WHERE room_id LIKE 'test-%'").run();
}

const HOST_ID  = 'test-host-' + randomUUID();
const OPP_ID   = 'test-opp-'  + randomUUID();
const CONFIG   = { mapSize: 'standard', fogOfWar: true };
const INTERVAL = 3600_000; // 1 hour

/** Insert a game and return { roomId, code }. */
function createTestGame(overrides = {}) {
  const hostId   = overrides.hostId   ?? HOST_ID;
  const hostName = overrides.hostName ?? 'TestHost';
  const faction  = overrides.faction  ?? 'hero';
  const result   = insertAsyncGame(hostId, hostName, faction, CONFIG, INTERVAL, VERSION);
  // Override room_id to have test- prefix for cleanup
  // Since insertAsyncGame generates its own roomId, we'll just track and clean up all
  return result;
}

describe('async-game data layer', () => {
  beforeEach(cleanUp);

  // ── insertAsyncGame ───────────────────────────────────────────────────────

  describe('insertAsyncGame', () => {
    test('creates a waiting game with a code', () => {
      const { roomId, code } = createTestGame();
      assert.ok(roomId, 'should return a roomId');
      assert.ok(code, 'should return a join code');
      assert.equal(code.length, 6, 'code should be 6 characters');

      const game = getAsyncGame(roomId);
      assert.ok(game, 'game should exist in DB');
      assert.equal(game.status, 'waiting');
      assert.equal(game.host_player_id, HOST_ID);
      assert.equal(game.host_faction, 'hero');
      assert.equal(game.hero_player_id, HOST_ID);
      assert.equal(game.witch_player_id, null);
      assert.equal(game.turn_interval_ms, INTERVAL);

      // Clean up by room_id
      deleteAsyncGame(roomId);
    });

    test('assigns witch when host picks witch faction', () => {
      const { roomId } = createTestGame({ faction: 'witch' });
      const game = getAsyncGame(roomId);
      assert.equal(game.witch_player_id, HOST_ID);
      assert.equal(game.hero_player_id, null);
      deleteAsyncGame(roomId);
    });
  });

  // ── getAsyncGameByCode ────────────────────────────────────────────────────

  describe('getAsyncGameByCode', () => {
    test('finds a waiting game by code', () => {
      const { roomId, code } = createTestGame();
      const game = getAsyncGameByCode(code);
      assert.ok(game, 'should find the game');
      assert.equal(game.room_id, roomId);
      deleteAsyncGame(roomId);
    });

    test('is case-insensitive', () => {
      const { roomId, code } = createTestGame();
      const game = getAsyncGameByCode(code.toLowerCase());
      assert.ok(game, 'should find with lowercase code');
      deleteAsyncGame(roomId);
    });

    test('returns null for nonexistent code', () => {
      assert.equal(getAsyncGameByCode('ZZZZZZ'), null);
    });
  });

  // ── activateAsyncGame ─────────────────────────────────────────────────────

  describe('activateAsyncGame', () => {
    test('transitions game to playing with opponent assigned', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      const ok = activateAsyncGame(
        roomId, OPP_ID, 'TestOpp',
        'TestHost', 'TestOpp',
        '{"fake":"state"}', 1, 'dawn', deadline
      );
      assert.ok(ok, 'should return true');

      const game = getAsyncGame(roomId);
      assert.equal(game.status, 'playing');
      assert.equal(game.hero_player_id, HOST_ID);
      assert.equal(game.witch_player_id, OPP_ID);
      assert.equal(game.round, 1);
      assert.equal(game.state_json, '{"fake":"state"}');

      // Plan status rows should exist for both players
      const plans = getPlanStatus(roomId, 1);
      assert.equal(plans.length, 2, 'should have plan rows for both players');

      deleteAsyncGame(roomId);
    });

    test('returns false for non-waiting game', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', deadline);

      // Try to activate again
      const ok = activateAsyncGame(roomId, 'other-id', 'Other', 'H', 'W', '{}', 1, 'dawn', deadline);
      assert.equal(ok, false);
      deleteAsyncGame(roomId);
    });
  });

  // ── Plan submission ───────────────────────────────────────────────────────

  describe('plan submission', () => {
    let roomId;

    beforeEach(() => {
      const result = createTestGame();
      roomId = result.roomId;
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'Host', 'Opp', '{}', 1, 'dawn', deadline);
    });

    test('submitPlan marks a player as submitted', () => {
      const plan = [{ type: 'MOVE', entityId: 'e1', col: 2, row: 3 }];
      const ok = submitPlan(roomId, HOST_ID, 1, plan);
      assert.ok(ok, 'should succeed');

      const status = getPlanStatus(roomId, 1);
      const hostStatus = status.find(s => s.player_id === HOST_ID);
      assert.equal(hostStatus.submitted, 1);
      assert.ok(hostStatus.plan_json, 'should have plan JSON');

      const parsed = JSON.parse(hostStatus.plan_json);
      assert.deepEqual(parsed, plan);
    });

    test('double submit returns false', () => {
      submitPlan(roomId, HOST_ID, 1, []);
      const ok = submitPlan(roomId, HOST_ID, 1, [{ type: 'MOVE' }]);
      assert.equal(ok, false, 'second submit should fail');
    });

    test('allPlansSubmitted is false with one pending', () => {
      submitPlan(roomId, HOST_ID, 1, []);
      assert.equal(allPlansSubmitted(roomId, 1), false);
    });

    test('allPlansSubmitted is true when both submit', () => {
      submitPlan(roomId, HOST_ID, 1, []);
      submitPlan(roomId, OPP_ID, 1, []);
      assert.equal(allPlansSubmitted(roomId, 1), true);
    });

    // Clean up after each test in this block
    test('cleanup', () => { deleteAsyncGame(roomId); });
  });

  // ── updateAsyncGameState ──────────────────────────────────────────────────

  describe('updateAsyncGameState', () => {
    test('updates state, round, phase, deadline', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{"r":1}', 1, 'dawn', deadline);

      const newDeadline = deadline + 3600;
      updateAsyncGameState(roomId, '{"r":2}', 2, 'day', newDeadline, 0);

      const game = getAsyncGame(roomId);
      assert.equal(game.round, 2);
      assert.equal(game.phase, 'day');
      assert.equal(game.state_json, '{"r":2}');
      assert.equal(game.turn_deadline, newDeadline);
      assert.equal(game.consecutive_timeout_rounds, 0);

      deleteAsyncGame(roomId);
    });

    test('tracks consecutive timeout rounds', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', deadline);

      updateAsyncGameState(roomId, '{}', 2, 'day', deadline + 3600, 1);
      assert.equal(getAsyncGame(roomId).consecutive_timeout_rounds, 1);

      updateAsyncGameState(roomId, '{}', 3, 'day', deadline + 7200, 2);
      assert.equal(getAsyncGame(roomId).consecutive_timeout_rounds, 2);

      deleteAsyncGame(roomId);
    });
  });

  // ── finishAsyncGame ───────────────────────────────────────────────────────

  describe('finishAsyncGame', () => {
    test('sets status, winner, and win_reason', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', deadline);

      finishAsyncGame(roomId, 'finished', 'hero', 'Witch slain', '{"final":true}');

      const game = getAsyncGame(roomId);
      assert.equal(game.status, 'finished');
      assert.equal(game.winner, 'hero');
      assert.equal(game.win_reason, 'Witch slain');
      assert.equal(game.state_json, '{"final":true}');

      deleteAsyncGame(roomId);
    });

    test('handles abandoned status', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', deadline);

      finishAsyncGame(roomId, 'abandoned', null, null, '{}');

      const game = getAsyncGame(roomId);
      assert.equal(game.status, 'abandoned');
      deleteAsyncGame(roomId);
    });
  });

  // ── deleteAsyncGame ───────────────────────────────────────────────────────

  describe('deleteAsyncGame', () => {
    test('removes game and associated plan/notification rows', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', deadline);

      // Add a notification manually
      db.prepare("INSERT INTO async_notifications (room_id, player_id, type) VALUES (?, ?, ?)")
        .run(roomId, HOST_ID, 'turn_ready');

      deleteAsyncGame(roomId);

      assert.equal(getAsyncGame(roomId), null);
      const plans = getPlanStatus(roomId, 1);
      assert.equal(plans.length, 0);
      const notifs = db.prepare("SELECT * FROM async_notifications WHERE room_id = ?").all(roomId);
      assert.equal(notifs.length, 0);
    });
  });

  // ── getAsyncGamesForPlayer ────────────────────────────────────────────────

  describe('getAsyncGamesForPlayer', () => {
    test('returns games for a player with plan status', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'Host', 'Opp', '{}', 1, 'dawn', deadline);

      const games = getAsyncGamesForPlayer(HOST_ID);
      assert.ok(games.length >= 1, 'should return at least 1 game');

      const game = games.find(g => g.room_id === roomId);
      assert.ok(game, 'should include our test game');
      assert.equal(game.my_plan_submitted, false);
      assert.equal(game.players_total, 2);
      assert.equal(game.players_submitted, 0);

      deleteAsyncGame(roomId);
    });

    test('reflects submission status', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'Host', 'Opp', '{}', 1, 'dawn', deadline);
      submitPlan(roomId, HOST_ID, 1, []);

      const games = getAsyncGamesForPlayer(HOST_ID);
      const game = games.find(g => g.room_id === roomId);
      assert.equal(game.my_plan_submitted, true);
      assert.equal(game.players_submitted, 1);

      deleteAsyncGame(roomId);
    });

    test('includes waiting games for host', () => {
      const { roomId } = createTestGame();

      const games = getAsyncGamesForPlayer(HOST_ID);
      const game = games.find(g => g.room_id === roomId);
      assert.ok(game, 'should show waiting game for host');
      assert.equal(game.status, 'waiting');

      deleteAsyncGame(roomId);
    });
  });

  // ── getExpiredGames ───────────────────────────────────────────────────────

  describe('getExpiredGames', () => {
    test('returns games past their deadline', () => {
      const { roomId } = createTestGame();
      const pastDeadline = Math.floor(Date.now() / 1000) - 60; // 1 min ago
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', pastDeadline);

      const expired = getExpiredGames();
      const found = expired.find(g => g.room_id === roomId);
      assert.ok(found, 'should find expired game');

      deleteAsyncGame(roomId);
    });

    test('does not return games with future deadlines', () => {
      const { roomId } = createTestGame();
      const futureDeadline = Math.floor(Date.now() / 1000) + 999999;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', futureDeadline);

      const expired = getExpiredGames();
      const found = expired.find(g => g.room_id === roomId);
      assert.ok(!found, 'should NOT find game with future deadline');

      deleteAsyncGame(roomId);
    });
  });

  // ── insertPlanStatus ──────────────────────────────────────────────────────

  describe('insertPlanStatus', () => {
    test('creates plan rows for a new round', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', deadline);

      // Round 1 plans already created by activateAsyncGame.
      // Create round 2 plans.
      insertPlanStatus(roomId, [HOST_ID, OPP_ID], 2);

      const plans = getPlanStatus(roomId, 2);
      assert.equal(plans.length, 2);
      assert.ok(plans.every(p => !p.submitted), 'all should be unsubmitted');

      deleteAsyncGame(roomId);
    });
  });

  // ── pruneStaleAsyncGames ──────────────────────────────────────────────────

  describe('pruneStaleAsyncGames', () => {
    test('removes finished games older than 7 days', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', deadline);
      finishAsyncGame(roomId, 'finished', 'hero', 'test', '{}');

      // Backdate updated_at to 8 days ago
      const oldTs = Math.floor(Date.now() / 1000) - 8 * 86400;
      db.prepare("UPDATE async_games SET updated_at = ? WHERE room_id = ?").run(oldTs, roomId);

      pruneStaleAsyncGames(VERSION);
      assert.equal(getAsyncGame(roomId), null, 'stale game should be pruned');
    });

    test('removes games with wrong version', () => {
      const { roomId } = createTestGame();

      pruneStaleAsyncGames('99.99.99');
      assert.equal(getAsyncGame(roomId), null, 'wrong-version game should be pruned');
    });

    test('keeps active games with current version', () => {
      const { roomId } = createTestGame();
      const deadline = Math.floor(Date.now() / 1000) + 3600;
      activateAsyncGame(roomId, OPP_ID, 'Opp', 'H', 'W', '{}', 1, 'dawn', deadline);

      pruneStaleAsyncGames(VERSION);
      assert.ok(getAsyncGame(roomId), 'active game should survive pruning');

      deleteAsyncGame(roomId);
    });
  });
});
