// Tests for unified plan persistence (game_plan_status table).

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  insertPlanStatusRows,
  upsertPlanStatus,
  getPlanStatus,
  allPlansSubmitted,
  clearPlanStatus,
  clearAllPlanStatus,
  upsertSave,
  getSave,
  getExpiredDeadlineGames,
  getActiveGamesForPlayer,
} from '../server/saves.js';
import { VERSION } from '../src/version.js';

const ROOM  = 'test-plan-room-1';
const P1    = 'test-plan-p1';
const P2    = 'test-plan-p2';
const P3    = 'test-plan-p3';

function cleanUp() {
  db.prepare("DELETE FROM game_plan_status WHERE room_id LIKE 'test-%'").run();
  db.prepare("DELETE FROM game_saves WHERE room_id LIKE 'test-%'").run();
}

describe('game_plan_status CRUD', () => {
  beforeEach(cleanUp);

  test('insertPlanStatusRows creates empty rows for all players', () => {
    insertPlanStatusRows(ROOM, [P1, P2], 1);
    const rows = getPlanStatus(ROOM, 1);
    assert.equal(rows.length, 2);
    assert.equal(rows[0].plan_json, null);
    assert.equal(rows[1].plan_json, null);
  });

  test('upsertPlanStatus stores a plan', () => {
    insertPlanStatusRows(ROOM, [P1, P2], 1);
    const plan = [{ type: 'MOVE', entityId: 'e1', col: 3, row: 4 }];
    upsertPlanStatus(ROOM, P1, 1, plan);

    const rows = getPlanStatus(ROOM, 1);
    const p1Row = rows.find(r => r.player_id === P1);
    assert.ok(p1Row.submitted_at, 'should have a timestamp');
    assert.deepEqual(JSON.parse(p1Row.plan_json), plan);

    const p2Row = rows.find(r => r.player_id === P2);
    assert.equal(p2Row.plan_json, null, 'P2 should not have submitted');
  });

  test('allPlansSubmitted returns false when plans missing', () => {
    insertPlanStatusRows(ROOM, [P1, P2], 1);
    upsertPlanStatus(ROOM, P1, 1, []);
    assert.equal(allPlansSubmitted(ROOM, 1, [P1, P2]), false);
  });

  test('allPlansSubmitted returns true when all submitted', () => {
    insertPlanStatusRows(ROOM, [P1, P2], 1);
    upsertPlanStatus(ROOM, P1, 1, []);
    upsertPlanStatus(ROOM, P2, 1, [{ type: 'MOVE' }]);
    assert.equal(allPlansSubmitted(ROOM, 1, [P1, P2]), true);
  });

  test('allPlansSubmitted works with 3+ players (NvN)', () => {
    insertPlanStatusRows(ROOM, [P1, P2, P3], 2);
    upsertPlanStatus(ROOM, P1, 2, []);
    upsertPlanStatus(ROOM, P2, 2, []);
    assert.equal(allPlansSubmitted(ROOM, 2, [P1, P2, P3]), false);
    upsertPlanStatus(ROOM, P3, 2, []);
    assert.equal(allPlansSubmitted(ROOM, 2, [P1, P2, P3]), true);
  });

  test('clearPlanStatus removes rows for a specific round', () => {
    insertPlanStatusRows(ROOM, [P1, P2], 1);
    insertPlanStatusRows(ROOM, [P1, P2], 2);
    upsertPlanStatus(ROOM, P1, 1, []);
    clearPlanStatus(ROOM, 1);

    assert.equal(getPlanStatus(ROOM, 1).length, 0, 'round 1 should be gone');
    assert.equal(getPlanStatus(ROOM, 2).length, 2, 'round 2 should remain');
  });

  test('clearAllPlanStatus removes all rounds', () => {
    insertPlanStatusRows(ROOM, [P1, P2], 1);
    insertPlanStatusRows(ROOM, [P1, P2], 2);
    clearAllPlanStatus(ROOM);
    assert.equal(getPlanStatus(ROOM, 1).length, 0);
    assert.equal(getPlanStatus(ROOM, 2).length, 0);
  });
});

describe('game_saves extended fields', () => {
  beforeEach(cleanUp);

  const fakeState = { round: 1, phase: 'dawn', version: VERSION };

  test('upsertSave stores new unified fields', () => {
    upsertSave(ROOM, P1, P2, 'Hero', 'Witch', fakeState, {
      turnDeadline: 1700000000,
      turnIntervalMs: 86400000,
      consecutiveTimeouts: { [P1]: 1 },
      config: { mapSize: 'standard' },
      players: [{ id: P1, faction: 'hero' }, { id: P2, faction: 'witch' }],
      isPrivate: true,
      code: 'ABC123',
      status: 'playing',
    });

    const save = getSave(ROOM);
    assert.ok(save);
    assert.equal(save.turn_deadline, 1700000000);
    assert.equal(save.turn_interval_ms, 86400000);
    assert.deepEqual(JSON.parse(save.consecutive_timeouts), { [P1]: 1 });
    assert.deepEqual(JSON.parse(save.config_json), { mapSize: 'standard' });
    assert.equal(JSON.parse(save.players_json).length, 2);
    assert.equal(save.is_private, 1);
    assert.equal(save.code, 'ABC123');
    assert.equal(save.status, 'playing');
  });

  test('upsertSave defaults new fields when extra not provided', () => {
    upsertSave(ROOM, P1, P2, 'Hero', 'Witch', fakeState);
    const save = getSave(ROOM);
    assert.equal(save.turn_deadline, null);
    assert.equal(save.turn_interval_ms, 90000);
    assert.equal(save.status, 'playing');
  });

  test('getExpiredDeadlineGames finds games past deadline', () => {
    const pastDeadline = Math.floor(Date.now() / 1000) - 60;
    upsertSave(ROOM, P1, P2, 'H', 'W', fakeState, {
      turnDeadline: pastDeadline,
      turnIntervalMs: 90000,
      players: [{ id: P1 }, { id: P2 }],
    });

    const expired = getExpiredDeadlineGames();
    const match = expired.find(r => r.room_id === ROOM);
    assert.ok(match, 'should find expired game');
  });

  test('getExpiredDeadlineGames ignores future deadlines', () => {
    const future = Math.floor(Date.now() / 1000) + 3600;
    upsertSave(ROOM, P1, P2, 'H', 'W', fakeState, {
      turnDeadline: future,
      turnIntervalMs: 90000,
    });

    const expired = getExpiredDeadlineGames();
    const match = expired.find(r => r.room_id === ROOM);
    assert.ok(!match, 'should not find future game');
  });

  test('getActiveGamesForPlayer returns games by player ID', () => {
    upsertSave(ROOM, P1, P2, 'H', 'W', fakeState, {
      status: 'playing',
      players: [{ id: P1 }, { id: P2 }],
    });

    const games = getActiveGamesForPlayer(P1);
    assert.ok(games.find(g => g.room_id === ROOM));
  });
});
