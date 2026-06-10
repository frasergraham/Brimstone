// Tests for resolution error recovery:
//   - A resolver throw rolls the room back to the pre-resolution snapshot
//     and restarts the planning phase instead of finalizing a corrupt round
//   - Players are notified and can resubmit plans
//   - The _executeResolution catch path is wired to the recovery helper

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  createLobby, fillAllWithAI, startGame, claimSlot,
  handlePlanSubmit,
  getRooms, getRoom,
  recoverFromResolutionErrorForTest,
} from '../server/lobby.js';
import { serializeState } from '../server/state-sync.js';
import db from '../server/db.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockWs() {
  const ws = {
    readyState: 1,
    messages: [],
    send(data) { ws.messages.push(JSON.parse(data)); },
    findMsg(type) { return ws.messages.find(m => m.type === type); },
    msgsOf(type) { return ws.messages.filter(m => m.type === type); },
  };
  return ws;
}

function createTestGame(playerId = 'recovery-player-1') {
  const ws = mockWs();
  createLobby(playerId, 'TestHero', ws, {
    playersPerSide: 1,
    mapSize: 'skirmish',
    fog: 'none',
  });
  const roomId = ws.findMsg('lobbyJoined').lobby.id;
  claimSlot(playerId, roomId, 0);
  fillAllWithAI(playerId, roomId);
  startGame(playerId, roomId);
  return { roomId: ws.findMsg('matchFound').roomId, ws, playerId };
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
    db.prepare("DELETE FROM game_saves WHERE players_json LIKE '%recovery-player-%'").run();
  } catch {}
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('resolution error recovery', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('rolls back to the pre-resolution snapshot and restarts planning', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);

    const roundBefore = room.state.round;
    const entitiesBefore = room.state.entities.filter(e => e.alive).length;
    const preStateJson = JSON.stringify(serializeState(room.state));

    // Submit a plan so there's submitted planning data to discard on rollback
    const unit = room.state.entities.find(e => e.alive && e.ownerId === playerId);
    handlePlanSubmit(playerId, roomId, [{ type: 'explore', entityId: unit.id }], roundBefore);

    // Simulate a resolver that half-mutated the state before throwing
    room.state.round += 3;
    for (const e of room.state.entities) e.hp = 0;

    const ok = recoverFromResolutionErrorForTest(room, preStateJson);
    assert.equal(ok, true, 'recovery should succeed');

    assert.equal(room.state.round, roundBefore, 'round must be rolled back');
    assert.equal(room.state.entities.filter(e => e.alive).length, entitiesBefore,
      'entities must be restored');
    assert.equal(room.phase, 'planning', 'room must be back in planning phase');
    assert.equal(room.state.planningPhase, true);
    assert.equal(room.state.resolving, false);
    assert.equal(room.state.playerReady.get(playerId), false,
      'submitted plans must be discarded so the player can resubmit');

    const errMsg = ws.msgsOf('error').find(m => m.message.includes('resolution failed'));
    assert.ok(errMsg, 'players must be told the round was reset');
    const planMsgs = ws.msgsOf('planningPhase');
    assert.ok(planMsgs.length >= 2, 'a fresh planningPhase message must be sent');
  });

  test('player can resubmit a plan after recovery', () => {
    const { roomId, playerId } = createTestGame();
    const room = getRoom(roomId);
    const preStateJson = JSON.stringify(serializeState(room.state));

    recoverFromResolutionErrorForTest(room, preStateJson);

    const unit = room.state.entities.find(e => e.alive && e.ownerId === playerId);
    handlePlanSubmit(playerId, roomId, [{ type: 'explore', entityId: unit.id }], room.state.round);
    assert.equal(room.state.playerReady.get(playerId), true,
      'resubmission after recovery must be accepted');
  });

  test('returns false when the snapshot itself is unusable', () => {
    const { roomId } = createTestGame();
    const room = getRoom(roomId);

    const ok = recoverFromResolutionErrorForTest(room, '{not json');
    assert.equal(ok, false);
  });

  test('AI engines are rebound to the restored state object', () => {
    const { roomId } = createTestGame();
    const room = getRoom(roomId);
    const preStateJson = JSON.stringify(serializeState(room.state));
    const aiSeat = room.players.find(s => s.isAI && s.ai);
    assert.ok(aiSeat, 'test setup: expected an AI seat');
    const oldEngine = aiSeat.ai;

    recoverFromResolutionErrorForTest(room, preStateJson);

    assert.notEqual(aiSeat.ai, oldEngine, 'AI engine must be recreated');
    assert.equal(aiSeat.ai.state, room.state,
      'new AI engine must reference the restored state');
  });

  test('_executeResolution catch path invokes the recovery helper', () => {
    // Source-level wiring check (same convention as timer-reset.test.js):
    // the resolvePlansMP catch block must attempt rollback before falling
    // back to an empty step list.
    const lobbyJs = readFileSync(join(__dirname, '..', 'server', 'lobby.js'), 'utf8');
    const catchStart = lobbyJs.indexOf('resolvePlansMP error');
    assert.ok(catchStart !== -1);
    const catchBlock = lobbyJs.slice(catchStart, catchStart + 500);
    assert.ok(catchBlock.includes('_recoverFromResolutionError(room, preStateJson)'),
      'catch block must call _recoverFromResolutionError with the pre-resolution snapshot');
    assert.ok(catchBlock.includes('return'),
      'catch block must return after successful rollback');
  });
});
