// Tests for multiplayer rejoin behavior:
//   - getActiveRoomsForPlayer returns live rooms
//   - handleReconnect reclaims AI-taken-over seats
//   - resumeGame returns error when room doesn't exist (no DB fallback)
//   - Room-level "all humans gone" timer fires correctly

import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLobby, fillAllWithAI, startGame,
  handleDisconnect, handleReconnect, resumeGame,
  getActiveRoomsForPlayer, getRooms, getRoom,
} from '../server/lobby.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal mock WebSocket that collects sent messages. */
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

/** Create a 1v1 lobby with AI opponent, start the game, return room info. */
function createTestGame(playerId = 'test-player-1') {
  const ws = mockWs();
  createLobby(playerId, 'TestHero', ws, {
    playersPerSide: 1,
    mapSize: 'skirmish',
    fog: 'none',
  });

  const lobbyMsg = ws.findMsg('lobbyJoined');
  const roomId = lobbyMsg.lobby.id;

  fillAllWithAI(playerId, roomId);
  startGame(playerId, roomId);

  const matchMsg = ws.findMsg('matchFound');
  return { roomId: matchMsg.roomId, ws, playerId };
}

/** Clean up all rooms between tests. */
function cleanUpRooms() {
  for (const r of getRooms()) {
    const room = getRoom(r.id);
    if (room) {
      // Clear timers to avoid leaks
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.allHumansGoneTimer) clearTimeout(room.allHumansGoneTimer);
      for (const t of room.disconnectTimers.values()) clearTimeout(t);
      for (const t of room.takeoverTimers.values()) clearTimeout(t);
    }
  }
}

// ── getActiveRoomsForPlayer ──────────────────────────────────────────────────

describe('getActiveRoomsForPlayer', () => {
  afterEach(cleanUpRooms);

  test('returns rooms where the player has a seat', () => {
    const { roomId, playerId } = createTestGame();
    const active = getActiveRoomsForPlayer(playerId);
    assert.equal(active.length, 1);
    assert.equal(active[0].room_id, roomId);
    assert.ok(active[0].round >= 1);
    assert.ok(active[0].phase);
    assert.ok(active[0].hero_name);
  });

  test('returns empty array for unknown player', () => {
    createTestGame();
    const active = getActiveRoomsForPlayer('nobody');
    assert.equal(active.length, 0);
  });

  test('does not return lobbies (only playing rooms)', () => {
    const ws = mockWs();
    createLobby('lobby-player', 'LobbyHero', ws, { playersPerSide: 1, mapSize: 'skirmish' });
    const active = getActiveRoomsForPlayer('lobby-player');
    assert.equal(active.length, 0);
  });
});

// ── handleReconnect after AI takeover ────────────────────────────────────────

describe('handleReconnect reclaims AI-taken-over seat', () => {
  afterEach(cleanUpRooms);

  test('player can reclaim seat after AI takeover', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { roomId, playerId } = createTestGame();

      // Disconnect the player
      handleDisconnect(playerId, roomId);

      // Advance past AI takeover (12s)
      mock.timers.tick(13_000);

      // Verify AI took over — seat should now have originalPlayerId
      const room = getRoom(roomId);
      const seat = room.players.find(s => s.originalPlayerId === playerId);
      assert.ok(seat, 'Should find seat by originalPlayerId after AI takeover');
      assert.equal(seat.isAI, true);

      // Reconnect
      const ws2 = mockWs();
      const rejoined = handleReconnect(playerId, roomId, ws2);
      assert.equal(rejoined, true, 'handleReconnect should succeed');

      // Verify seat was reclaimed
      const room2 = getRoom(roomId);
      const reclaimed = room2.players.find(s => s.playerId === playerId);
      assert.ok(reclaimed, 'Seat should be reclaimed with original playerId');
      assert.equal(reclaimed.isAI, false);
      assert.equal(reclaimed.ws, ws2);

      // Verify client received reconnect messages
      assert.ok(ws2.findMsg('reconnected'), 'Should receive reconnected message');
      assert.ok(ws2.findMsg('stateUpdate'), 'Should receive stateUpdate message');
    } finally {
      mock.timers.reset();
    }
  });

  test('getActiveRoomsForPlayer finds AI-taken-over rooms', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const pid = 'takeover-lookup-' + Math.random();
      const { roomId } = createTestGame(pid);
      handleDisconnect(pid, roomId);
      mock.timers.tick(13_000);

      // Should still appear in active rooms via originalPlayerId
      const active = getActiveRoomsForPlayer(pid);
      assert.equal(active.length, 1);
      assert.equal(active[0].room_id, roomId);
    } finally {
      mock.timers.reset();
    }
  });
});

// ── Room-level "all humans gone" timer ───────────────────────────────────────

describe('all-humans-gone room destruction timer', () => {
  afterEach(cleanUpRooms);

  test('room is destroyed after all humans disconnect for 1 minute', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { roomId, playerId } = createTestGame();

      handleDisconnect(playerId, roomId);

      // AI takeover at 12s
      mock.timers.tick(13_000);

      // Room should still exist
      assert.ok(getRoom(roomId), 'Room should still exist after AI takeover');

      // allHumansGoneTimer fires RECONNECT_GRACE_MS (60s) after AI takeover
      // We already ticked 13s, so tick another 61s to pass the 60s timer
      mock.timers.tick(61_000);

      // Room should be destroyed
      assert.equal(getRoom(roomId), null, 'Room should be destroyed after grace period');
    } finally {
      mock.timers.reset();
    }
  });

  test('reconnect cancels room destruction timer', async () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    try {
      const { roomId, playerId } = createTestGame();

      handleDisconnect(playerId, roomId);
      mock.timers.tick(13_000); // AI takeover

      // Reconnect before destruction timer fires
      const ws2 = mockWs();
      handleReconnect(playerId, roomId, ws2);

      // Advance past when destruction would have fired
      mock.timers.tick(60_000);

      // Room should still exist
      assert.ok(getRoom(roomId), 'Room should still exist after reconnect');
    } finally {
      mock.timers.reset();
    }
  });
});

// ── resumeGame — live reconnect only ─────────────────────────────────────────

describe('resumeGame only does live reconnect', () => {
  afterEach(cleanUpRooms);

  test('returns error when room does not exist', () => {
    const ws = mockWs();
    resumeGame('some-player', ws, 'nonexistent-room');
    const err = ws.findMsg('error');
    assert.ok(err, 'Should receive an error message');
    assert.ok(err.message.includes('no longer active'), 'Error should say game is no longer active');
  });

  test('successfully reconnects to a live room', () => {
    const { roomId, playerId } = createTestGame();
    const ws2 = mockWs();
    resumeGame(playerId, ws2, roomId);
    const reconnected = ws2.findMsg('reconnected');
    assert.ok(reconnected, 'Should receive reconnected message via resumeGame');
  });
});
