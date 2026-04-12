// Tests for save_replay_rounds persistence: appendSaveRound, getSaveRounds,
// deleteSave cascade, and pruneStaleAndIncompatibleSaves cleanup.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import db from '../server/db.js';
import {
  upsertSave,
  deleteSave,
  appendSaveRound,
  getSaveRounds,
  pruneStaleAndIncompatibleSaves,
} from '../server/saves.js';
import { recoverRoom, getRooms, getRoom } from '../server/lobby.js';
import { GameState } from '../src/game.js';
import { serializeState } from '../server/state-sync.js';
import { VERSION, SAVE_VERSION } from '../src/version.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanUp() {
  db.prepare("DELETE FROM game_saves WHERE room_id LIKE 'test-%'").run();
  db.prepare("DELETE FROM save_replay_rounds WHERE room_id LIKE 'test-%'").run();
}

function makeSave(roomId) {
  const gs = new GameState(false, false);
  const serialized = serializeState(gs);
  upsertSave(roomId, 'player-hero', 'player-witch', 'Hero', 'Witch', serialized);
}

// ── appendSaveRound / getSaveRounds ──────────────────────────────────────────

describe('appendSaveRound and getSaveRounds', () => {
  beforeEach(cleanUp);

  test('inserts and retrieves rounds in order', () => {
    const roomId = 'test-' + randomUUID();
    appendSaveRound(roomId, 1, '{"round":1}', '[]');
    appendSaveRound(roomId, 2, '{"round":2}', '[{"step":1}]');
    appendSaveRound(roomId, 3, '{"round":3}', '[{"step":2}]');

    const rounds = getSaveRounds(roomId);
    assert.equal(rounds.length, 3);
    assert.equal(rounds[0].round_num, 1);
    assert.equal(rounds[1].round_num, 2);
    assert.equal(rounds[2].round_num, 3);
    assert.equal(rounds[0].pre_state_json, '{"round":1}');
    assert.equal(rounds[1].steps_json, '[{"step":1}]');
  });

  test('returns empty array for unknown room', () => {
    const rounds = getSaveRounds('test-nonexistent');
    assert.deepEqual(rounds, []);
  });

  test('OR REPLACE overwrites duplicate round_num', () => {
    const roomId = 'test-' + randomUUID();
    appendSaveRound(roomId, 1, '{"v":1}', '[]');
    appendSaveRound(roomId, 1, '{"v":2}', '[1]');

    const rounds = getSaveRounds(roomId);
    assert.equal(rounds.length, 1);
    assert.equal(rounds[0].pre_state_json, '{"v":2}');
  });
});

// ── deleteSave cascades ──────────────────────────────────────────────────────

describe('deleteSave cascades to save_replay_rounds', () => {
  beforeEach(cleanUp);

  test('deleting a save removes its replay rounds', () => {
    const roomId = 'test-' + randomUUID();
    makeSave(roomId);
    appendSaveRound(roomId, 1, '{}', '[]');
    appendSaveRound(roomId, 2, '{}', '[]');

    assert.equal(getSaveRounds(roomId).length, 2);
    deleteSave(roomId);
    assert.equal(getSaveRounds(roomId).length, 0);
  });

  test('deleting a save does not affect other rooms rounds', () => {
    const roomA = 'test-' + randomUUID();
    const roomB = 'test-' + randomUUID();
    makeSave(roomA);
    makeSave(roomB);
    appendSaveRound(roomA, 1, '{}', '[]');
    appendSaveRound(roomB, 1, '{}', '[]');

    deleteSave(roomA);
    assert.equal(getSaveRounds(roomA).length, 0);
    assert.equal(getSaveRounds(roomB).length, 1);
  });
});

// ── pruneStaleAndIncompatibleSaves ───────────────────────────────────────────

describe('pruneStaleAndIncompatibleSaves cleans up rounds', () => {
  beforeEach(cleanUp);

  test('prunes replay rounds for incompatible saves', () => {
    const roomId = 'test-' + randomUUID();
    // Insert a save with a fake old version
    const gs = new GameState(false, false);
    const serialized = serializeState(gs);
    // Manually insert with old version
    db.prepare(`
      INSERT INTO game_saves (room_id, hero_player_id, witch_player_id, hero_name, witch_name,
        round, phase, game_version, state_json, updated_at, created_at)
      VALUES (?, 'p1', 'p2', '', '', 1, 'dawn', 'old-version', ?, unixepoch(), unixepoch())
    `).run(roomId, JSON.stringify(serialized));

    appendSaveRound(roomId, 1, '{}', '[]');
    appendSaveRound(roomId, 2, '{}', '[]');

    assert.equal(getSaveRounds(roomId).length, 2);
    pruneStaleAndIncompatibleSaves(VERSION, SAVE_VERSION);
    assert.equal(getSaveRounds(roomId).length, 0);
  });
});

// ── recoverRoom restores replayRounds from DB ───────────────────────────────

describe('recoverRoom restores replayRounds from DB', () => {
  beforeEach(cleanUp);

  function destroyRecoveredRoom(roomId) {
    const room = getRoom(roomId);
    if (!room) return;
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    for (const t of room.disconnectTimers?.values() ?? []) clearTimeout(t);
    for (const t of room.takeoverTimers?.values() ?? []) clearTimeout(t);
    room.disconnectTimers?.clear();
    room.takeoverTimers?.clear();
    // Remove from rooms map
    for (const r of getRooms()) {
      if (r.id === roomId) {
        const map = getRooms();
        // getRooms returns values(); we need to remove from the underlying Map
        break;
      }
    }
  }

  test('replay rounds are restored from save_replay_rounds on recovery', () => {
    const roomId = 'test-recover-' + randomUUID();
    const gs = new GameState(false, false);
    gs.round = 4;  // pretend we're on round 4
    const serialized = serializeState(gs);

    // Create a save with some state
    upsertSave(roomId, 'p-hero', 'p-witch', 'Hero', 'Witch', serialized, {
      gameVersion: VERSION,
      saveVersion: SAVE_VERSION,
    });

    // Add 3 rounds of replay data
    appendSaveRound(roomId, 1, '{"round":1}', '[{"step":1}]');
    appendSaveRound(roomId, 2, '{"round":2}', '[{"step":2}]');
    appendSaveRound(roomId, 3, '{"round":3}', '[{"step":3}]');

    // Recover the room
    const room = recoverRoom(roomId);
    assert.ok(room, 'room should be recovered');
    assert.equal(room.replayRounds.length, 3, 'should restore 3 replay rounds');
    assert.equal(room.replayRounds[0].roundNum, 1);
    assert.equal(room.replayRounds[1].roundNum, 2);
    assert.equal(room.replayRounds[2].roundNum, 3);
    assert.equal(room.replayRounds[0].preStateJson, '{"round":1}');
    assert.equal(room.replayRounds[2].stepsJson, '[{"step":3}]');

    // Clean up — destroy the room
    destroyRecoveredRoom(roomId);
    deleteSave(roomId);
  });

  test('room recovers with empty replayRounds if DB has none', () => {
    const roomId = 'test-recover-empty-' + randomUUID();
    const gs = new GameState(false, false);
    const serialized = serializeState(gs);

    upsertSave(roomId, 'p-hero', 'p-witch', 'Hero', 'Witch', serialized, {
      gameVersion: VERSION,
      saveVersion: SAVE_VERSION,
    });

    const room = recoverRoom(roomId);
    assert.ok(room, 'room should be recovered');
    assert.equal(room.replayRounds.length, 0, 'should have 0 replay rounds');

    destroyRecoveredRoom(roomId);
    deleteSave(roomId);
  });
});
