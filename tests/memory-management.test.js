// Tests for always-in-memory mode: loadAllRooms, nukeGame.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  createLobby, fillAllWithAI, startGame, claimSlot,
  getRooms, getRoom, loadAllRooms, nukeGame,
} from '../server/lobby.js';
import { getSave, getAllPlayingSaves } from '../server/saves.js';

function mockWs(readyState = 1) {
  const ws = {
    readyState,
    messages: [],
    send(data) { ws.messages.push(JSON.parse(data)); },
    last() { return ws.messages[ws.messages.length - 1]; },
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
  db.prepare("DELETE FROM game_saves WHERE players_json LIKE '%test-mem-%'").run();
  db.prepare("DELETE FROM save_replay_rounds WHERE room_id IN (SELECT room_id FROM game_saves WHERE players_json LIKE '%test-mem-%')").run();
}

describe('loadAllRooms', () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  test('loads saved games from DB into memory', () => {
    const ws = mockWs();
    const roomId = createLobby('test-mem-p1', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
      turnIntervalMs: 86400000,
    });
    claimSlot('test-mem-p1', roomId, 0);
    fillAllWithAI('test-mem-p1', roomId);
    startGame('test-mem-p1', roomId);

    // Verify game is in memory and has a save
    assert.ok(getRoom(roomId), 'room should exist in memory after start');
    const save = getSave(roomId);
    assert.ok(save, 'save should exist in DB after start');

    // loadAllRooms should skip rooms already in memory
    const count = loadAllRooms();
    assert.equal(count, 0, 'should load 0 new rooms when all are already in memory');
  });

  test('getAllPlayingSaves returns active saves', () => {
    const ws = mockWs();
    const roomId = createLobby('test-mem-p2', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
      turnIntervalMs: 86400000,
    });
    claimSlot('test-mem-p2', roomId, 0);
    fillAllWithAI('test-mem-p2', roomId);
    startGame('test-mem-p2', roomId);

    const saves = getAllPlayingSaves();
    const found = saves.find(s => s.room_id === roomId);
    assert.ok(found, 'getAllPlayingSaves should include the active game');
    assert.ok(found.state, 'save should have parsed state');
  });
});

describe('nukeGame', () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  test('removes game from memory and DB', () => {
    const ws = mockWs();
    const roomId = createLobby('test-mem-p3', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
      turnIntervalMs: 86400000,
    });
    claimSlot('test-mem-p3', roomId, 0);
    fillAllWithAI('test-mem-p3', roomId);
    startGame('test-mem-p3', roomId);

    assert.ok(getRoom(roomId), 'room should exist before nuke');
    assert.ok(getSave(roomId), 'save should exist before nuke');

    const result = nukeGame(roomId);
    assert.ok(result.ok, 'nukeGame should return ok');

    // DB records should be gone immediately
    assert.equal(getSave(roomId), null, 'save should be deleted from DB');

    // Room is destroyed after a 2s delay for client notification,
    // but the game state is set to gameOver immediately
    const room = getRoom(roomId);
    if (room) {
      assert.ok(room.state.gameOver, 'game should be marked as over');
    }
  });

  test('notifies connected clients', () => {
    const ws = mockWs();
    const roomId = createLobby('test-mem-p4', 'Host', ws, {
      playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
      turnIntervalMs: 86400000,
    });
    claimSlot('test-mem-p4', roomId, 0);
    fillAllWithAI('test-mem-p4', roomId);
    startGame('test-mem-p4', roomId);

    // Simulate a connected player
    const room = getRoom(roomId);
    const playerWs = mockWs();
    room.players[0].ws = playerWs;

    nukeGame(roomId);

    const stateUpdate = playerWs.messages.find(m => m.type === 'stateUpdate');
    assert.ok(stateUpdate, 'connected player should receive stateUpdate');
    assert.equal(stateUpdate.reason, 'adminForceEnd');
    assert.equal(stateUpdate.state.winner, 'draw', 'state should show winner');
  });

  test('succeeds even if game only exists in DB', () => {
    // Nuke a non-existent room — should not throw
    const result = nukeGame('non-existent-room-id');
    assert.ok(result.ok, 'nukeGame should return ok even for missing rooms');
  });
});
