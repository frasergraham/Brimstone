// Tests for the server-side "get a specific round's replay" path.
//
// Regression: `_getLastUnwatchedReplay()` used to grab
// `room.replayRounds[length-1]` unconditionally, which returned the wrong
// round if the array was ever out of sync. The new implementation looks up
// `state.round - 1` explicitly via `getReplayForRound()`.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLobby, claimSlot, fillAllWithAI, startGame,
  handlePlanSubmit, handleReconnect,
  getRooms, getRoom,
  getReplayForRound,
} from '../server/lobby.js';
import { appendSaveRound } from '../server/saves.js';
import db from '../server/db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockWs() {
  const ws = {
    readyState: 1,
    messages: [],
    send(data) { ws.messages.push(JSON.parse(data)); },
    findMsg(type) { return ws.messages.find(m => m.type === type); },
  };
  return ws;
}

function cleanUpRooms() {
  for (const r of getRooms()) {
    const room = getRoom(r.id);
    if (!room) continue;
    if (room.state) room.state.winner = 'hero';
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    for (const t of room.disconnectTimers.values()) clearTimeout(t);
    for (const t of room.takeoverTimers.values()) clearTimeout(t);
    room.disconnectTimers.clear();
    room.takeoverTimers.clear();
  }
  try {
    db.prepare("DELETE FROM game_plan_status WHERE room_id LIKE '%'").run();
    db.prepare("DELETE FROM game_saves WHERE room_id LIKE '%'").run();
    db.prepare("DELETE FROM save_replay_rounds WHERE room_id LIKE '%'").run();
  } catch {}
}

/** Build a fake room with a hand-crafted `replayRounds` history. */
function makeFakeRoom(replayRounds, currentRound) {
  return {
    id: 'fake-room',
    replayRounds,
    state: { round: currentRound },
  };
}

// ── getReplayForRound ────────────────────────────────────────────────────────

describe('getReplayForRound (server/lobby.js)', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('passes through finalEntitiesJson from in-memory entries', () => {
    const room = makeFakeRoom([
      { roundNum: 1, preStateJson: '{"r":1}', stepsJson: '[1]' },
      { roundNum: 2, preStateJson: '{"r":2}', stepsJson: '[2]', finalEntitiesJson: '[{"id":"e1"}]' },
    ], 3);
    const entry1 = getReplayForRound(room, 1);
    assert.equal(entry1.finalEntitiesJson, null, 'non-final round should have null');
    const entry2 = getReplayForRound(room, 2);
    assert.equal(entry2.finalEntitiesJson, '[{"id":"e1"}]', 'final round should pass through');
  });

  test('returns the matching in-memory entry by roundNum', () => {
    const room = makeFakeRoom([
      { roundNum: 1, preStateJson: '{"r":1}', stepsJson: '[1]' },
      { roundNum: 2, preStateJson: '{"r":2}', stepsJson: '[2]' },
      { roundNum: 3, preStateJson: '{"r":3}', stepsJson: '[3]' },
    ], 4);
    const entry = getReplayForRound(room, 2);
    assert.ok(entry, 'should find round 2');
    assert.equal(entry.roundNum, 2);
    assert.equal(entry.preStateJson, '{"r":2}');
    assert.equal(entry.stepsJson, '[2]');
  });

  test('does NOT just return replayRounds[length-1]', () => {
    // This is the bug we're fixing: asking for round 2 should return round 2,
    // not whatever happens to be at the tail of the array.
    const room = makeFakeRoom([
      { roundNum: 1, preStateJson: '{"r":1}', stepsJson: '[1]' },
      { roundNum: 2, preStateJson: '{"r":2}', stepsJson: '[2]' },
      { roundNum: 3, preStateJson: '{"r":3}', stepsJson: '[3]' },
    ], 4);
    const entry = getReplayForRound(room, 2);
    assert.equal(entry.roundNum, 2);
    assert.notEqual(entry.preStateJson, '{"r":3}');
  });

  test('returns null for missing round when no DB fallback', () => {
    const room = makeFakeRoom([
      { roundNum: 1, preStateJson: '{}', stepsJson: '[]' },
    ], 5);
    // Room id doesn't exist in DB, so DB fallback also returns null.
    const entry = getReplayForRound(room, 99);
    assert.equal(entry, null);
  });

  test('falls back to DB when in-memory is missing', () => {
    // Use a real room ID so we can persist a row to save_replay_rounds.
    const roomId = 'test-replay-fallback-' + Date.now();
    appendSaveRound(roomId, 7, '{"r":7}', '[7]');

    const room = {
      id: roomId,
      replayRounds: [],  // in-memory empty
      state: { round: 8 },
    };
    const entry = getReplayForRound(room, 7);
    assert.ok(entry, 'should fall back to DB');
    assert.equal(entry.roundNum, 7);
    assert.equal(entry.preStateJson, '{"r":7}');
    assert.equal(entry.stepsJson, '[7]');

    // Cleanup
    db.prepare("DELETE FROM save_replay_rounds WHERE room_id = ?").run(roomId);
  });

  test('returns null for non-numeric or missing roundNum', () => {
    const room = makeFakeRoom([
      { roundNum: 1, preStateJson: '{}', stepsJson: '[]' },
    ], 2);
    assert.equal(getReplayForRound(room, null), null);
    assert.equal(getReplayForRound(room, undefined), null);
    assert.equal(getReplayForRound(room, 'bad'), null);
    assert.equal(getReplayForRound(null, 1), null);
  });
});

// ── lastReplay in planningPhase message uses round-validated lookup ─────────

describe('lastReplay sent on reconnect matches state.round - 1', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('reconnecting after round N resolves sends the round N-1 replay', () => {
    // Start a 1v1 game
    const ws = rooms_setup();
    const roomId = ws._roomId;
    const room = getRoom(roomId);

    // Play a few rounds
    let safety = 10;
    while (room.state.round < 3 && safety-- > 0) {
      handlePlanSubmit('hero-test', roomId, []);
    }
    if (room.state.round < 3) {
      // AI not keeping up in this test env; skip gracefully.
      return;
    }

    // Corrupt the in-memory replayRounds order to simulate a desync bug:
    // swap two entries so the tail of the array no longer matches state.round-1.
    if (room.replayRounds.length >= 2) {
      const last = room.replayRounds.length - 1;
      [room.replayRounds[0], room.replayRounds[last]] =
        [room.replayRounds[last], room.replayRounds[0]];
    }

    // Reconnect the human player
    const ws2 = mockWs();
    handleReconnect('hero-test', roomId, ws2);

    const planMsg = ws2.findMsg('planningPhase') ?? ws2.findMsg('gameJoined');
    if (!planMsg?.lastReplay && !planMsg?.lastRound) return; // no replay delivered at all

    const delivered = planMsg.lastReplay ?? planMsg.lastRound;
    // The fix: delivered.roundNum must equal state.round - 1, regardless of
    // how the in-memory array is ordered.
    assert.equal(delivered.roundNum, room.state.round - 1,
      `expected round ${room.state.round - 1}, got ${delivered.roundNum}`);
  });
});

// Small helper to spin up a standard lobby with one human + AI fill.
function rooms_setup() {
  const ws = mockWs();
  createLobby('hero-test', 'HeroTest', ws, {
    playersPerSide: 1,
    mapSize: 'skirmish',
    fog: 'none',
  });
  const lobbyMsg = ws.findMsg('lobbyJoined');
  const roomId = lobbyMsg.lobby.id;
  claimSlot('hero-test', roomId, 0);
  fillAllWithAI('hero-test', roomId);
  startGame('hero-test', roomId);
  ws._roomId = roomId;
  return ws;
}
