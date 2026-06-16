// Tests for plan submission guards:
//   - Stale-round submissions are rejected when round number is provided
//   - Empty plans can be overwritten with populated plans
//   - Non-empty plans cannot be overwritten
//   - Legacy clients (no round field) are still accepted

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLobby, fillAllWithAI, startGame, claimSlot,
  handlePlanSubmit,
  getRooms, getRoom,
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
    errorMsgs() { return ws.messages.filter(m => m.type === 'error'); },
  };
  return ws;
}

function createTestGame(playerId = 'guard-player-1') {
  const ws = mockWs();
  createLobby(playerId, 'TestHero', ws, {
    playersPerSide: 1,
    mapSize: 'skirmish',
    fog: 'none',
  });

  const lobbyMsg = ws.findMsg('lobbyJoined');
  const roomId = lobbyMsg.lobby.id;

  claimSlot(playerId, roomId, 0);
  fillAllWithAI(playerId, roomId);
  startGame(playerId, roomId);

  const matchMsg = ws.findMsg('matchFound');
  return { roomId: matchMsg.roomId, ws, playerId };
}

function cleanUpRooms() {
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
  try {
    db.prepare("DELETE FROM game_plan_status WHERE room_id NOT LIKE 'test-%'").run();
    db.prepare("DELETE FROM game_saves WHERE players_json LIKE '%guard-player-%'").run();
  } catch {}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('handlePlanSubmit round validation', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('rejects plan for a stale round', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);
    const currentRound = room.state.round;

    // Submit with a stale round number
    handlePlanSubmit(playerId, roomId, [], currentRound - 1);

    const errors = ws.errorMsgs();
    const staleError = errors.find(e => e.message.includes('Stale'));
    assert.ok(staleError, 'should receive stale plan error');
    assert.ok(!room.state.playerReady.get(playerId), 'player should not be marked ready');
  });

  test('accepts plan with matching round number', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);
    const currentRound = room.state.round;

    handlePlanSubmit(playerId, roomId, [], currentRound);

    const errors = ws.errorMsgs();
    const staleError = errors.find(e => e.message.includes('Stale'));
    assert.ok(!staleError, 'should not receive stale plan error');
    assert.ok(room.state.playerReady.get(playerId), 'player should be marked ready');
  });

  test('accepts plan from legacy client with no round field', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);

    // Legacy clients send no round — undefined
    handlePlanSubmit(playerId, roomId, []);

    const errors = ws.errorMsgs();
    const staleError = errors.find(e => e.message.includes('Stale'));
    assert.ok(!staleError, 'should not reject legacy clients');
    assert.ok(room.state.playerReady.get(playerId), 'player should be marked ready');
  });
});

describe('handlePlanSubmit empty plan overwrite', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('overwrites empty plan with populated plan', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);
    const currentRound = room.state.round;

    // First submit: empty plan (e.g. from timeout)
    handlePlanSubmit(playerId, roomId, [], currentRound);
    assert.ok(room.state.playerReady.get(playerId), 'player should be marked ready after empty plan');
    assert.equal(room.state.playerPlans.get(playerId).length, 0, 'plan should be empty');

    // Second submit: populated plan (player managed to submit in time)
    const unit = room.state.entities.find(e => e.alive && e.ownerId === playerId);
    const plan = [{ type: 'explore', entityId: unit.id }];
    handlePlanSubmit(playerId, roomId, plan, currentRound);

    const errors = ws.errorMsgs();
    const alreadySubmitted = errors.find(e => e.message.includes('already submitted'));
    assert.ok(!alreadySubmitted, 'should not reject when overwriting empty plan');
    assert.equal(room.state.playerPlans.get(playerId).length, 1, 'plan should now have 1 action');
  });

  test('does not overwrite non-empty plan', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);
    const currentRound = room.state.round;

    // First submit: populated plan
    const unit = room.state.entities.find(e => e.alive && e.ownerId === playerId);
    const plan1 = [{ type: 'explore', entityId: unit.id }];
    handlePlanSubmit(playerId, roomId, plan1, currentRound);
    assert.equal(room.state.playerPlans.get(playerId).length, 1);

    // Second submit: different plan — should be rejected
    const plan2 = [{ type: 'guard', entityId: unit.id }];
    handlePlanSubmit(playerId, roomId, plan2, currentRound);

    const errors = ws.errorMsgs();
    const alreadySubmitted = errors.find(e => e.message.includes('already submitted'));
    assert.ok(alreadySubmitted, 'should reject overwrite of non-empty plan');
    assert.equal(room.state.playerPlans.get(playerId).length, 1, 'original plan should be unchanged');
  });

  test('does not overwrite empty plan with another empty plan', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);
    const currentRound = room.state.round;

    // First submit: empty
    handlePlanSubmit(playerId, roomId, [], currentRound);

    // Second submit: also empty — should be rejected (no point overwriting)
    handlePlanSubmit(playerId, roomId, [], currentRound);

    const errors = ws.errorMsgs();
    const alreadySubmitted = errors.find(e => e.message.includes('already submitted'));
    assert.ok(alreadySubmitted, 'should reject empty-to-empty overwrite');
  });
});
