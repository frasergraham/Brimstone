// Tests for server-authoritative plan validation:
//   - validatePlan() rejects malformed, over-length, and unowned-entity plans
//   - multi-move chains validate hop-by-hop against projected positions
//   - handlePlanSubmit rejects invalid plans with an error and does not mark
//     the player ready or persist the plan

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { hexKey } from '../src/hex.js';
import { validatePlan, PlanActionType, MAX_PLAN_LENGTH } from '../src/planner.js';
import { Phase } from '../src/game.js';
import { createHero, createWitch } from '../src/entities.js';
import { TileType } from '../src/tiles.js';
import {
  createLobby, fillAllWithAI, startGame, claimSlot,
  handlePlanSubmit,
  getRooms, getRoom,
} from '../server/lobby.js';
import db from '../server/db.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTinyState() {
  const state = {
    phase: Phase.DAY,
    entities: [],
    tiles: new Map(),
    exploredHexes: { hero: new Set(), witch: new Set() },
    fogOfWar: 'none',
    heroRevealedByHorn: false,
    inventory: { hero: {}, witch: {} },
  };
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 7; col++) {
      state.tiles.set(hexKey(col, row), {
        type: TileType.GRASS, building: null, fortifyLevel: 0, explored: false,
      });
    }
  }
  return state;
}

// ── validatePlan unit tests ──────────────────────────────────────────────────

describe('validatePlan', () => {
  test('accepts a valid plan with a multi-move chain', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'p1');
    state.entities.push(hero);

    const plan = [
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: 3, toRow: 2 },
      { type: PlanActionType.MOVE, entityId: hero.id, toCol: 3, toRow: 1 },
      { type: PlanActionType.EXPLORE, entityId: hero.id },
    ];
    const r = validatePlan(state, 'p1', plan);
    assert.equal(r.valid, true);
  });

  test('does not reject moves into a hex an ally vacates this round', () => {
    // Structural validation must stay parity-safe with the resolver: a plan
    // that moves B into the hex A is leaving is legal at execution time even
    // though the hex is occupied in the live state at submission time.
    const state = makeTinyState();
    const a = createHero(3, 3, 'p1');
    const b = createHero(3, 4, 'p1');
    state.entities.push(a, b);

    const plan = [
      { type: PlanActionType.MOVE, entityId: a.id, toCol: 3, toRow: 2 },
      { type: PlanActionType.MOVE, entityId: b.id, toCol: 3, toRow: 3 },
    ];
    const r = validatePlan(state, 'p1', plan);
    assert.equal(r.valid, true);
  });

  test('rejects non-array plans and over-length plans', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'p1');
    state.entities.push(hero);

    assert.equal(validatePlan(state, 'p1', 'not-a-plan').valid, false);
    assert.equal(validatePlan(state, 'p1', { length: 1 }).valid, false);

    const long = Array.from({ length: MAX_PLAN_LENGTH + 1 }, () =>
      ({ type: PlanActionType.EXPLORE, entityId: hero.id }));
    const r = validatePlan(state, 'p1', long);
    assert.equal(r.valid, false);
    assert.match(r.reason, /maximum length/);
  });

  test('rejects malformed action entries', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'p1');
    state.entities.push(hero);

    for (const bad of [null, 42, 'move', [], { type: PlanActionType.EXPLORE },
                       { entityId: hero.id, type: 'launch-nuke' }]) {
      const r = validatePlan(state, 'p1', [bad]);
      assert.equal(r.valid, false, `should reject ${JSON.stringify(bad)}`);
      assert.equal(r.index, 0);
    }
  });

  test("rejects actions for another player's entity or a dead entity", () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'p1');
    const witch = createWitch(5, 5, 'p2');
    state.entities.push(hero, witch);

    const enemyAction = [{ type: PlanActionType.EXPLORE, entityId: witch.id }];
    const r1 = validatePlan(state, 'p1', enemyAction);
    assert.equal(r1.valid, false);
    assert.match(r1.reason, /another player/);

    witch.hp = 0;  // alive is derived from hp
    const r2 = validatePlan(state, 'p2', [{ type: PlanActionType.EXPLORE, entityId: witch.id }]);
    assert.equal(r2.valid, false);
  });

  test('skips ownership checks when playerId is null (offline mode)', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, null);
    state.entities.push(hero);

    const r = validatePlan(state, null, [{ type: PlanActionType.EXPLORE, entityId: hero.id }]);
    assert.equal(r.valid, true);
  });
});

// ── handlePlanSubmit integration ─────────────────────────────────────────────

function mockWs() {
  const ws = {
    readyState: 1,
    messages: [],
    send(data) { ws.messages.push(JSON.parse(data)); },
    findMsg(type) { return ws.messages.find(m => m.type === type); },
    errorMsgs() { return ws.messages.filter(m => m.type === 'error'); },
  };
  return ws;
}

function createTestGame(playerId = 'planval-player-1') {
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
    db.prepare("DELETE FROM game_saves WHERE players_json LIKE '%planval-player-%'").run();
  } catch {}
}

describe('handlePlanSubmit server-side validation', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('rejects a plan referencing a nonexistent entity', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);

    handlePlanSubmit(playerId, roomId,
      [{ type: 'explore', entityId: 'no-such-entity' }], room.state.round);

    const rejected = ws.errorMsgs().find(e => e.message.includes('Plan rejected'));
    assert.ok(rejected, 'should receive a rejection error');
    assert.ok(!room.state.playerReady.get(playerId), 'player must not be marked ready');
    assert.ok(!room.state.playerPlans.get(playerId), 'plan must not be stored');
  });

  test("rejects a plan commanding the AI opponent's units", () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);
    const enemy = room.state.entities.find(e => e.alive && e.ownerId && e.ownerId !== playerId);
    assert.ok(enemy, 'test setup: expected an AI-owned entity');

    handlePlanSubmit(playerId, roomId,
      [{ type: 'explore', entityId: enemy.id }], room.state.round);

    const rejected = ws.errorMsgs().find(e => e.message.includes('Plan rejected'));
    assert.ok(rejected, 'should receive a rejection error');
    assert.ok(!room.state.playerReady.get(playerId), 'player must not be marked ready');
  });

  test('rejects an over-length plan', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);
    const unit = room.state.entities.find(e => e.alive && e.ownerId === playerId);

    const long = Array.from({ length: MAX_PLAN_LENGTH + 1 }, () =>
      ({ type: 'explore', entityId: unit.id }));
    handlePlanSubmit(playerId, roomId, long, room.state.round);

    const rejected = ws.errorMsgs().find(e => e.message.includes('Plan rejected'));
    assert.ok(rejected, 'should receive a rejection error');
    assert.ok(!room.state.playerReady.get(playerId), 'player must not be marked ready');
  });

  test('accepts a valid plan for an owned unit', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);
    const unit = room.state.entities.find(e => e.alive && e.ownerId === playerId);

    handlePlanSubmit(playerId, roomId,
      [{ type: 'explore', entityId: unit.id }], room.state.round);

    const rejected = ws.errorMsgs().find(e => e.message.includes('Plan rejected'));
    assert.ok(!rejected, 'valid plan must not be rejected');
    assert.ok(room.state.playerReady.get(playerId), 'player should be marked ready');
    assert.equal(room.state.playerPlans.get(playerId).length, 1);
  });
});
