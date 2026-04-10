// Tests for multi-battle room support:
//   - pickBestBattleRoom() selection logic
//   - getActiveBattleRooms() returning multiple rooms
//   - getBattleStatus() multi-room response shape
//   - joinBattle() auto-selection and overflow room creation
//
// Battle rooms use large 42×42 maps, so we minimize room creation
// by sharing rooms across tests within each suite.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  createBattleRoom, joinBattle,
  getActiveBattleRooms, pickBestBattleRoom,
  getBattleStatus,
  getRoom,
  getRooms,
} from '../server/lobby.js';
import db from '../server/db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockWs() {
  const ws = {
    readyState: 1,
    messages: [],
    send(data) { ws.messages.push(JSON.parse(data)); },
    last() { return ws.messages[ws.messages.length - 1]; },
    findMsg(type) { return ws.messages.find(m => m.type === type); },
  };
  return ws;
}

const _testRoomIds = [];

function _cleanUpRoom(room) {
  if (!room) return;
  if (room.state) room.state.winner = 'hero';
  room.status = 'finished'; // prevent getActiveBattleRooms() from seeing it
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
  if (room.allHumansGoneTimer) { clearTimeout(room.allHumansGoneTimer); room.allHumansGoneTimer = null; }
  for (const t of room.disconnectTimers.values()) clearTimeout(t);
  for (const t of room.takeoverTimers.values()) clearTimeout(t);
  room.disconnectTimers.clear();
  room.takeoverTimers.clear();
}

function cleanUpAll() {
  for (const r of getRooms()) _cleanUpRoom(getRoom(r.id));
  for (const id of _testRoomIds) _cleanUpRoom(getRoom(id));
  _testRoomIds.length = 0;
  try {
    db.prepare("DELETE FROM game_plan_status WHERE room_id LIKE '%'").run();
    db.prepare("DELETE FROM game_saves WHERE room_id LIKE '%'").run();
  } catch {}
}

function createTestBattle(endsAt) {
  endsAt = endsAt ?? Math.floor(Date.now() / 1000) + 86400;
  const roomId = createBattleRoom({ endsAt });
  _testRoomIds.push(roomId);
  const room = getRoom(roomId);
  room.state.startPlanning();
  return { roomId, room };
}

function joinPlayer(roomId, playerId, name) {
  const ws = mockWs();
  joinBattle(playerId, name, ws, roomId);
  return ws;
}

// ── Tests ────────────────────────────────────────────────────────────────────

// This suite creates exactly 2 battle rooms and reuses them for all tests.
describe('multi-battle rooms', () => {
  let b1, b2;
  const endsAt = Math.floor(Date.now() / 1000) + 86400;

  before(() => {
    cleanUpAll();
    b1 = createTestBattle(endsAt);
    b2 = createTestBattle(endsAt);
  });

  after(cleanUpAll);

  test('getActiveBattleRooms returns all active rooms', () => {
    const rooms = getActiveBattleRooms();
    assert.ok(rooms.length >= 2, `expected >= 2 active rooms, got ${rooms.length}`);
    const ids = rooms.map(r => r.id);
    assert.ok(ids.includes(b1.roomId));
    assert.ok(ids.includes(b2.roomId));
  });

  test('pickBestBattleRoom returns a room with space', () => {
    const picked = pickBestBattleRoom();
    assert.ok(picked, 'should pick a room');
    assert.ok(picked.config.isBattle);
  });

  test('pickBestBattleRoom prefers room with fewer open slots', () => {
    // Add players to b1 to make it more populated
    joinPlayer(b1.roomId, 'mbr-h1', 'H1');
    joinPlayer(b1.roomId, 'mbr-h2', 'H2');
    joinPlayer(b1.roomId, 'mbr-h3', 'H3');
    // b2 has 0 players, b1 has 3 → b1 has fewer open slots
    const picked = pickBestBattleRoom();
    assert.equal(picked?.id, b1.roomId, 'should pick the more populated room');
  });

  test('pickBestBattleRoom breaks ties by faction balance', () => {
    // Give b2 same number of players as b1 but better balanced
    // b1 currently has 3 players (all heroes since first 2 go hero, tie-break hero)
    // Let's add players to b2 with mixed factions
    joinPlayer(b2.roomId, 'mbr-h4', 'H4'); // hero (first)
    joinPlayer(b2.roomId, 'mbr-w1', 'W1'); // witch (balances)
    joinPlayer(b2.roomId, 'mbr-h5', 'H5'); // hero

    // b1: 3 players, b2: 3 players → same open slots
    // Check balance: b2 should be more balanced (2h 1w vs b1's 2h 1w or similar)
    const picked = pickBestBattleRoom();
    // Both have 3 players (same open slots). The tie-break is faction imbalance.
    const b1Heroes = b1.room.players.filter(s => s.faction === 'hero').length;
    const b1Witches = b1.room.players.filter(s => s.faction === 'witch').length;
    const b2Heroes = b2.room.players.filter(s => s.faction === 'hero').length;
    const b2Witches = b2.room.players.filter(s => s.faction === 'witch').length;
    const b1Imbalance = Math.abs(b1Heroes - b1Witches);
    const b2Imbalance = Math.abs(b2Heroes - b2Witches);

    if (b1Imbalance !== b2Imbalance) {
      const expectedId = b1Imbalance < b2Imbalance ? b1.roomId : b2.roomId;
      assert.equal(picked?.id, expectedId, 'should pick the better-balanced room');
    }
    // If same imbalance, either is fine — just ensure one was picked
    assert.ok(picked, 'should pick a room');
  });

  test('pickBestBattleRoom returns null when all rooms are full', () => {
    // Override maxPlayersPerSide to current player count to simulate full
    const origMax1 = b1.room.state.battleConfig.maxPlayersPerSide;
    const origMax2 = b2.room.state.battleConfig.maxPlayersPerSide;
    b1.room.state.battleConfig.maxPlayersPerSide = 0;
    b2.room.state.battleConfig.maxPlayersPerSide = 0;

    assert.equal(pickBestBattleRoom(), null);

    b1.room.state.battleConfig.maxPlayersPerSide = origMax1;
    b2.room.state.battleConfig.maxPlayersPerSide = origMax2;
  });

  test('getBattleStatus returns multi-room summary', () => {
    const status = getBattleStatus();
    assert.ok(status, 'should return status');
    assert.ok(status.totalBattles >= 2);
    assert.ok(status.battles.length >= 2);
    assert.ok(status.endsAt > 0);
    assert.equal(typeof status.totalHeroes, 'number');
    assert.equal(typeof status.totalWitches, 'number');
    assert.equal(typeof status.allFull, 'boolean');
    assert.equal(status.myBattle, null, 'no playerId → no myBattle');
  });

  test('getBattleStatus returns myBattle for joined player', () => {
    const status = getBattleStatus('mbr-h1');
    assert.ok(status.myBattle, 'should have myBattle');
    assert.equal(status.myBattle.roomId, b1.roomId);
    assert.equal(status.myBattle.joined, true);
    assert.ok(status.myBattle.myFaction);
  });

  test('getBattleStatus returns null myBattle for non-participant', () => {
    const status = getBattleStatus('not-in-any-battle');
    assert.equal(status.myBattle, null);
  });

  test('getBattleStatus totalHeroes/totalWitches aggregate across rooms', () => {
    const status = getBattleStatus();
    const expectedTotal = b1.room.players.length + b2.room.players.length;
    assert.equal(status.totalHeroes + status.totalWitches, expectedTotal);
  });

  test('joinBattle auto-selects room when roomId is undefined', () => {
    const ws = mockWs();
    const result = joinBattle('auto-join-1', 'AutoJoin', ws, undefined);
    assert.ok(result, 'should succeed');
    // Should join one of the existing rooms
    assert.ok(result.roomId === b1.roomId || result.roomId === b2.roomId,
      'should join an existing room');
  });

  test('joinBattle reconnects existing player to their room', () => {
    const ws = mockWs();
    const result = joinBattle('mbr-h1', 'H1', ws, undefined);
    assert.ok(result, 'should succeed');
    assert.equal(result.roomId, b1.roomId, 'should reconnect to original room');
  });
});

// Separate suite for overflow test (creates one additional room)
describe('multi-battle overflow', () => {
  let fullRoom;

  before(() => {
    cleanUpAll();
    const { roomId, room } = createTestBattle();
    // Make it tiny so it fills fast
    room.state.battleConfig.maxPlayersPerSide = 1;
    joinPlayer(roomId, 'full-h1', 'FullH1');
    joinPlayer(roomId, 'full-w1', 'FullW1');
    fullRoom = { roomId, room };
  });

  after(cleanUpAll);

  test('creates new room when all rooms are full', () => {
    const ws = mockWs();
    const result = joinBattle('overflow-player', 'Overflow', ws, undefined);
    assert.ok(result, 'should succeed');
    assert.notEqual(result.roomId, fullRoom.roomId, 'should be in a different room');
    _testRoomIds.push(result.roomId);

    const rooms = getActiveBattleRooms();
    assert.ok(rooms.length >= 2, 'should now have >= 2 battle rooms');
  });

  test('new overflow room inherits same endsAt', () => {
    const rooms = getActiveBattleRooms();
    const endsAts = rooms.map(r => r.state?.battleConfig?.endsAt).filter(Boolean);
    // All should be the same
    const unique = [...new Set(endsAts)];
    assert.equal(unique.length, 1, 'all rooms should share the same endsAt');
  });
});
