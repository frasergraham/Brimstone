// Tests for the online resolution loop in server/lobby.js:
//   - _executeResolution via handlePlanSubmit (all-ready → resolve → next planning phase)
//   - planned moves actually applied to room state
//   - replay round accumulation and resolutionComplete broadcast
//   - _autoSubmitMissingPlans (deadline expiry → empty plan, timeout counter)
//   - AI takeover fired from the resolution path after 2 consecutive timeouts
//
// Uses a two-human 1v1 room so resolution fires synchronously on the last
// handlePlanSubmit — no real timers, no AI-submission delays.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  createLobby, joinLobby, startGame, claimSlot, handlePlanSubmit,
  getRooms, getRoom,
  autoSubmitMissingPlansForTest,
} from '../server/lobby.js';
import { PlanActionType } from '../src/planner.js';
import { isLeaderType } from '../src/entities.js';
import { getReachableHexes } from '../src/actions.js';

function mockWs() {
  const ws = {
    readyState: 1,
    messages: [],
    send(data) { ws.messages.push(JSON.parse(data)); },
    findMsg(type) { return ws.messages.find(m => m.type === type); },
    allMsg(type) { return ws.messages.filter(m => m.type === type); },
  };
  return ws;
}

const P1 = 'test-resolution-p1';
const P2 = 'test-resolution-p2';

/** Two-human 1v1 room: P1 hero, P2 witch. Resolution is fully synchronous. */
function createTwoHumanGame() {
  const ws1 = mockWs();
  const ws2 = mockWs();
  createLobby(P1, 'ResHero', ws1, {
    playersPerSide: 1,
    mapSize: 'skirmish',
    fog: 'none',
    turnIntervalMs: 90_000,
  });
  const roomId = ws1.findMsg('lobbyJoined').lobby.id;
  joinLobby(P2, 'ResWitch', ws2, roomId);
  claimSlot(P1, roomId, 0);
  claimSlot(P2, roomId, 1);
  startGame(P1, roomId);

  const room = getRoom(ws1.findMsg('matchFound').roomId);
  assert.ok(room, 'started room should exist');
  return { room, ws1, ws2 };
}

function leaderOf(room, playerId) {
  return room.state.entities.find(
    e => e.alive && e.ownerId === playerId && isLeaderType(e.type)
  );
}

function cleanUp() {
  for (const r of getRooms()) {
    const room = getRoom(r.id);
    if (room) {
      if (room.state) room.state.winner = 'hero'; // stop AI planning chains
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.allHumansGoneTimer) clearTimeout(room.allHumansGoneTimer);
      for (const t of room.disconnectTimers.values()) clearTimeout(t);
      for (const t of room.takeoverTimers.values()) clearTimeout(t);
    }
  }
  try {
    db.prepare("DELETE FROM game_plan_status WHERE 1=1").run();
    db.prepare("DELETE FROM game_saves WHERE players_json LIKE '%test-resolution-%'").run();
  } catch {}
}

describe('online resolution loop — _executeResolution', () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  test('last submit triggers resolution and the next planning phase', () => {
    const { room, ws1 } = createTwoHumanGame();
    assert.equal(room.state.round, 1);

    handlePlanSubmit(P1, room.id, []);
    assert.equal(room.state.round, 1, 'one of two submits must not resolve');

    handlePlanSubmit(P2, room.id, []);
    assert.equal(room.state.round, 2, 'all-ready should resolve and advance the round');
    assert.equal(room.phase, 'planning', 'room should re-enter planning for round 2');
    assert.ok(room.state.planningPhase, 'state should be back in planning');
    assert.ok(!room.state.playerReady.get(P1), 'ready flags should reset for the new round');

    const resolved = ws1.findMsg('resolutionComplete');
    assert.ok(resolved, 'players should receive resolutionComplete');
    assert.ok(Array.isArray(resolved.steps));
    assert.equal(resolved.finalState.round, 2);

    // A fresh planningPhase message with this round's budget
    const planningMsgs = ws1.allMsg('planningPhase');
    assert.ok(planningMsgs.length >= 2, 'should get a planningPhase per round');
    assert.ok(planningMsgs.at(-1).myActionsLeft > 0, 'new round should carry a budget');
  });

  test('a planned move is applied to the room state', () => {
    const { room } = createTwoHumanGame();
    const hero = leaderOf(room, P1);
    assert.ok(hero, 'P1 should own a leader');
    const dest = getReachableHexes(room.state, hero, 1)[0];
    assert.ok(dest, 'hero should have a reachable hex');

    handlePlanSubmit(P1, room.id, [{
      type: PlanActionType.MOVE, entityId: hero.id, toCol: dest.col, toRow: dest.row,
    }]);
    handlePlanSubmit(P2, room.id, []);

    const moved = room.state.entities.find(e => e.id === hero.id);
    assert.deepEqual({ col: moved.col, row: moved.row },
                     { col: dest.col,  row: dest.row },
                     'move should be applied by the online resolver');
  });

  test('each resolved round is appended to replayRounds', () => {
    const { room } = createTwoHumanGame();

    handlePlanSubmit(P1, room.id, []);
    handlePlanSubmit(P2, room.id, []);
    handlePlanSubmit(P1, room.id, []);
    handlePlanSubmit(P2, room.id, []);

    assert.equal(room.state.round, 3, 'two full rounds should have resolved');
    assert.equal(room.replayRounds.length, 2);
    assert.deepEqual(room.replayRounds.map(r => r.roundNum), [1, 2]);
    for (const entry of room.replayRounds) {
      assert.ok(entry.preStateJson, 'replay round should snapshot pre-state');
      assert.ok(entry.stepsJson,    'replay round should record steps');
    }
  });
});

describe('online resolution loop — _autoSubmitMissingPlans', () => {
  beforeEach(cleanUp);
  afterEach(cleanUp);

  test('deadline expiry submits empty plans, resolves, and counts the timeout', () => {
    const { room, ws2 } = createTwoHumanGame();

    handlePlanSubmit(P1, room.id, []);
    autoSubmitMissingPlansForTest(room); // what the turn timer fires

    assert.equal(room.state.round, 2, 'auto-submit should complete the round');
    assert.equal(room.consecutiveTimeouts[P2], 1,
      'timed-out human should accrue a consecutive-timeout strike');
    assert.equal(room.consecutiveTimeouts[P1] ?? 0, 0,
      'player who submitted manually should have no strikes');
    assert.ok(ws2.findMsg('error')?.message.includes('Planning time expired'),
      'timed-out player should be told their plan was auto-submitted');
  });

  test('second consecutive timeout hands the seat to AI after resolution', () => {
    const { room } = createTwoHumanGame();
    room.consecutiveTimeouts[P2] = 1; // strike one from a previous round

    handlePlanSubmit(P1, room.id, []);
    autoSubmitMissingPlansForTest(room); // strike two → takeover in _executeResolution

    assert.equal(room.state.round, 2, 'round should still resolve');
    assert.ok(!room.players.some(s => s.playerId === P2),
      'timed-out seat should no longer belong to the human');
    const aiSeat = room.players.find(s => s.faction === 'witch');
    assert.ok(aiSeat?.isAI, 'witch seat should now be AI-controlled');
    assert.equal(aiSeat.originalPlayerId, P2,
      'AI seat should remember the original player for reclaim');
  });

  test('full timeout strikes everyone; players who submitted are untouched', () => {
    const { room, ws1 } = createTwoHumanGame();

    autoSubmitMissingPlansForTest(room); // nobody submitted — both time out

    assert.equal(room.state.round, 2, 'a fully timed-out round should still resolve');
    assert.equal(room.consecutiveTimeouts[P1], 1);
    assert.equal(room.consecutiveTimeouts[P2], 1);
    assert.ok(ws1.findMsg('error'), 'both humans should be told they timed out');

    // Next round: P1 submits in time and is not re-struck or double-submitted
    handlePlanSubmit(P1, room.id, []);
    const errorsBefore = ws1.allMsg('error').length;
    autoSubmitMissingPlansForTest(room);
    assert.equal(room.state.round, 3);
    assert.equal(room.consecutiveTimeouts[P1], 0,
      'manual submit should reset the strike counter');
    assert.equal(ws1.allMsg('error').length, errorsBefore,
      'submitted player must not get a timeout notice');
  });
});
