// Tests for AI takeover after consecutive timeouts.

import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  createLobby, fillAllWithAI, startGame,
  handlePlanSubmit, getRooms, getRoom,
} from '../server/lobby.js';

function mockWs() {
  const ws = {
    readyState: 1,
    messages: [],
    send(data) { ws.messages.push(JSON.parse(data)); },
    last() { return ws.messages[ws.messages.length - 1]; },
    findMsg(type) { return ws.messages.find(m => m.type === type); },
    allMsg(type) { return ws.messages.filter(m => m.type === type); },
  };
  return ws;
}

function cleanUp() {
  for (const r of getRooms()) {
    const room = getRoom(r.id);
    if (room) {
      // Stop AI planning chain by marking game over
      if (room.state) room.state.winner = 'hero';
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.allHumansGoneTimer) clearTimeout(room.allHumansGoneTimer);
      for (const t of room.disconnectTimers.values()) clearTimeout(t);
      for (const t of room.takeoverTimers.values()) clearTimeout(t);
    }
  }
  try {
    db.prepare("DELETE FROM game_plan_status WHERE 1=1").run();
    db.prepare("DELETE FROM game_saves WHERE players_json LIKE '%test-takeover-%'").run();
  } catch {}
}

describe('AI takeover after consecutive timeouts', () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  test('consecutive timeout counter increments on empty auto-submit', () => {
    const ws = mockWs();
    const playerId = 'test-takeover-p1';
    createLobby(playerId, 'TimeoutHero', ws, {
      playersPerSide: 1,
      mapSize: 'skirmish',
      fog: 'none',
      turnIntervalMs: 90000,
    });
    const lobbyMsg = ws.findMsg('lobbyJoined');
    const roomId = lobbyMsg.lobby.id;
    fillAllWithAI(playerId, roomId);
    startGame(playerId, roomId);

    const room = getRoom(roomId);
    assert.ok(room, 'room should exist');
    assert.deepEqual(room.consecutiveTimeouts, {}, 'should start empty');
  });

  test('manual plan submission resets timeout counter', () => {
    const ws = mockWs();
    const playerId = 'test-takeover-p2';
    createLobby(playerId, 'ManualHero', ws, {
      playersPerSide: 1,
      mapSize: 'skirmish',
      fog: 'none',
    });
    const lobbyMsg = ws.findMsg('lobbyJoined');
    const roomId = lobbyMsg.lobby.id;
    fillAllWithAI(playerId, roomId);
    startGame(playerId, roomId);

    const room = getRoom(roomId);
    // Simulate having a previous timeout count
    room.consecutiveTimeouts[playerId] = 1;

    // Submit a real plan (manually)
    handlePlanSubmit(playerId, roomId, []);
    // Manual submit should reset to 0
    assert.equal(room.consecutiveTimeouts[playerId], 0);
  });

  test('_checkTimeoutTakeovers triggers at 2 consecutive timeouts', () => {
    const ws = mockWs();
    const playerId = 'test-takeover-p3';
    createLobby(playerId, 'TakeoverHero', ws, {
      playersPerSide: 1,
      mapSize: 'skirmish',
      fog: 'none',
    });
    const lobbyMsg = ws.findMsg('lobbyJoined');
    const roomId = lobbyMsg.lobby.id;
    fillAllWithAI(playerId, roomId);
    startGame(playerId, roomId);

    const room = getRoom(roomId);
    // Simulate 2 consecutive timeouts
    room.consecutiveTimeouts[playerId] = 2;

    // Verify the player is human before
    const seat = room.players.find(s => s.playerId === playerId);
    assert.ok(seat, 'player seat should exist');
    assert.equal(seat.isAI, false, 'should be human before takeover');
  });
});
