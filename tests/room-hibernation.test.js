// Tests for room hibernation and recovery (unified multiplayer).

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  createLobby, fillAllWithAI, startGame,
  resumeGame, getRooms, getRoom, getActiveRoomsForPlayer,
} from '../server/lobby.js';
import { getSave } from '../server/saves.js';

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
  db.prepare("DELETE FROM game_saves WHERE players_json LIKE '%test-hibernate-%'").run();
}

function createTestGame(playerId = 'test-hibernate-p1') {
  const ws = mockWs();
  createLobby(playerId, 'HibernateHero', ws, {
    playersPerSide: 1,
    mapSize: 'skirmish',
    fog: 'none',
    turnIntervalMs: 86400000, // 1 day — long timeout
  });
  const lobbyMsg = ws.findMsg('lobbyJoined');
  const roomId = lobbyMsg.lobby.id;
  fillAllWithAI(playerId, roomId);
  startGame(playerId, roomId);
  const matchMsg = ws.findMsg('matchFound');
  return { roomId: matchMsg.roomId, ws, playerId };
}

describe('room hibernation and recovery', () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  test('configurable turnIntervalMs is stored in room config', () => {
    const { roomId } = createTestGame();
    const room = getRoom(roomId);
    assert.equal(room.config.turnIntervalMs, 86400000);
  });

  test('consecutiveTimeouts initialized as empty object', () => {
    const { roomId } = createTestGame();
    const room = getRoom(roomId);
    assert.deepEqual(room.consecutiveTimeouts, {});
  });

  test('resumeGame works for in-memory rooms', () => {
    const { roomId, playerId } = createTestGame();
    const ws2 = mockWs();
    resumeGame(playerId, ws2, roomId);
    const reconnected = ws2.findMsg('reconnected');
    assert.ok(reconnected, 'should send reconnected message');
    assert.equal(reconnected.roomId, roomId);
  });

  test('getActiveRoomsForPlayer includes turn_interval_ms', () => {
    const { playerId } = createTestGame();
    const games = getActiveRoomsForPlayer(playerId);
    assert.ok(games.length >= 1);
    const game = games[0];
    assert.equal(game.turn_interval_ms, 86400000);
  });

  test('resumeGame sends planningPhase even when state was saved between rounds', () => {
    const { roomId, playerId } = createTestGame();

    // Simulate the state being saved after endRound (planningPhase = false)
    const room = getRoom(roomId);
    room.state.planningPhase = false;

    // Resume with a new WebSocket — should trigger a fresh planning phase
    const ws2 = mockWs();
    resumeGame(playerId, ws2, roomId);

    const reconnected = ws2.findMsg('reconnected');
    assert.ok(reconnected, 'should send reconnected');

    const planning = ws2.findMsg('planningPhase');
    assert.ok(planning, 'should send planningPhase even though state had planningPhase=false');
    assert.ok(planning.myActionsLeft >= 0, 'should include budget');
  });
});
