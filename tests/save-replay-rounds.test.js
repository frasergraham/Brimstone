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
import { GameState } from '../src/game.js';
import { serializeState } from '../server/state-sync.js';
import { VERSION } from '../src/version.js';

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
    pruneStaleAndIncompatibleSaves(VERSION);
    assert.equal(getSaveRounds(roomId).length, 0);
  });
});
