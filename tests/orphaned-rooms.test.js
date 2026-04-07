// Tests for orphaned room detection and cleanup.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  createLobby, joinLobby, fillAllWithAI, startGame, claimSlot,
  getRooms, getRoom, browseLobby, pruneOrphanedRooms,
  handleDisconnect,
} from '../server/lobby.js';
import { getSave } from '../server/saves.js';

function mockWs(readyState = 1) {
  const ws = {
    readyState,
    messages: [],
    send(data) { ws.messages.push(JSON.parse(data)); },
    last() { return ws.messages[ws.messages.length - 1]; },
    findMsg(type) { return ws.messages.find(m => m.type === type); },
  };
  return ws;
}

function cleanUp() {
  for (const r of getRooms()) {
    const room = getRoom(r.id);
    if (room) {
      if (room.state) room.state.winner = 'hero';
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.allHumansGoneTimer) clearTimeout(room.allHumansGoneTimer);
      for (const t of room.disconnectTimers.values()) clearTimeout(t);
      for (const t of room.takeoverTimers.values()) clearTimeout(t);
    }
  }
  db.prepare("DELETE FROM game_plan_status WHERE 1=1").run();
  db.prepare("DELETE FROM game_saves WHERE players_json LIKE '%test-orphan-%'").run();
}

describe('orphaned room cleanup', () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  // ── Return value tests ──────────────────────────────────────────────────────

  test('createLobby returns room ID', () => {
    const ws = mockWs();
    const roomId = createLobby('test-orphan-p1', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
    });
    assert.ok(roomId, 'should return a room ID');
    assert.ok(getRoom(roomId), 'room should exist');
  });

  test('joinLobby returns room ID on success', () => {
    const ws1 = mockWs();
    const roomId = createLobby('test-orphan-p1', 'Host', ws1, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
    });
    const ws2 = mockWs();
    const joinedId = joinLobby('test-orphan-p2', 'Joiner', ws2, roomId);
    assert.equal(joinedId, roomId, 'should return the same room ID');
  });

  test('joinLobby returns null on error', () => {
    const ws = mockWs();
    const result = joinLobby('test-orphan-p1', 'Player', ws, 'nonexistent-room');
    assert.equal(result, null, 'should return null for nonexistent room');
  });

  test('joinLobby returns null when lobby is full', () => {
    const ws1 = mockWs();
    const roomId = createLobby('test-orphan-p1', 'Host', ws1, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
    });
    // Fill the other slot
    const ws2 = mockWs();
    joinLobby('test-orphan-p2', 'Player2', ws2, roomId);
    // Try to join a full lobby
    const ws3 = mockWs();
    const result = joinLobby('test-orphan-p3', 'Player3', ws3, roomId);
    assert.equal(result, null, 'should return null when lobby is full');
  });

  // ── Pruning tests ───────────────────────────────────────────────────────────

  test('pruneOrphanedRooms destroys lobby with no live WebSockets older than 60s', () => {
    const ws = mockWs(3); // readyState 3 = CLOSED
    const roomId = createLobby('test-orphan-p1', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
    });
    // Backdate createdAt to make it older than the grace period
    const room = getRoom(roomId);
    room.createdAt = Date.now() - 120_000; // 2 minutes ago

    pruneOrphanedRooms();

    assert.equal(getRoom(roomId), null, 'orphaned lobby should be destroyed');
  });

  test('pruneOrphanedRooms does NOT destroy lobby younger than 60s', () => {
    const ws = mockWs(3); // CLOSED
    const roomId = createLobby('test-orphan-p1', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
    });
    // createdAt is already ~now, well within the grace period

    pruneOrphanedRooms();

    assert.ok(getRoom(roomId), 'young lobby should NOT be destroyed');
  });

  test('pruneOrphanedRooms does NOT destroy lobby with live WebSocket', () => {
    const ws = mockWs(1); // readyState 1 = OPEN
    const roomId = createLobby('test-orphan-p1', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
    });
    const room = getRoom(roomId);
    room.createdAt = Date.now() - 120_000; // old enough

    pruneOrphanedRooms();

    assert.ok(getRoom(roomId), 'lobby with live WebSocket should NOT be destroyed');
  });

  test('pruneOrphanedRooms removes orphaned lobby from browseLobby results', () => {
    const ws = mockWs(3); // CLOSED
    const roomId = createLobby('test-orphan-p1', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
    });
    const room = getRoom(roomId);
    room.createdAt = Date.now() - 120_000;

    // Before pruning, the lobby should appear in browseLobby
    const beforeList = browseLobby();
    assert.ok(beforeList.some(r => r.id === roomId), 'orphaned lobby should be in browse list before prune');

    pruneOrphanedRooms();

    const afterList = browseLobby();
    assert.ok(!afterList.some(r => r.id === roomId), 'orphaned lobby should NOT be in browse list after prune');
  });

  test('pruneOrphanedRooms hibernates playing room with all-AI and no timer', () => {
    const ws = mockWs();
    const roomId = createLobby('test-orphan-p1', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
      turnIntervalMs: 86400000,
    });
    claimSlot('test-orphan-p1', roomId, 0);
    fillAllWithAI('test-orphan-p1', roomId);
    startGame('test-orphan-p1', roomId);

    const room = getRoom(roomId);
    // Simulate: all players became AI (e.g. disconnect + takeover) and no timer
    for (const seat of room.players) { seat.isAI = true; }
    if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
    room.allHumansGoneTimer = null;

    pruneOrphanedRooms();

    assert.equal(getRoom(roomId), null, 'room should be evicted from memory');
    const save = getSave(roomId);
    assert.ok(save, 'room should be hibernated to DB');
  });
});
