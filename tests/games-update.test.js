// Tests for the gamesUpdate WebSocket notification flow — the server pushes
// gamesUpdate to affected human players when plans are submitted or rounds
// resolve, and the client routes the message to onGamesUpdate.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createLobby, fillAllWithAI, startGame, claimSlot,
  handlePlanSubmit, setSendToPlayer,
  getRooms, getRoom,
} from '../server/lobby.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

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

function createTestGame(playerId = 'games-update-p1') {
  const ws = mockWs();
  createLobby(playerId, 'TestHero', ws, {
    playersPerSide: 1, mapSize: 'skirmish', fog: 'none',
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
      for (const t of room.disconnectTimers?.values() ?? []) clearTimeout(t);
      for (const t of room.takeoverTimers?.values() ?? []) clearTimeout(t);
    }
  }
}

// ── server/lobby.js — gamesUpdate notifications (behavioral) ─────────────────

describe('server/lobby.js — gamesUpdate notifications', () => {
  let sent; // [playerId, msg] pairs captured from the injected sendToPlayer

  beforeEach(() => {
    cleanUpRooms();
    sent = [];
    setSendToPlayer((playerId, msg) => sent.push([playerId, msg]));
  });
  afterEach(() => {
    setSendToPlayer(null);
    cleanUpRooms();
  });

  const gamesUpdatesFor = (playerId) =>
    sent.filter(([pid, msg]) => pid === playerId && msg.type === 'gamesUpdate');

  test('plan submission pushes gamesUpdate to human players (not AI)', () => {
    const { roomId, playerId } = createTestGame();
    const room = getRoom(roomId);
    sent.length = 0;

    const unit = room.state.entities.find(e => e.alive && e.ownerId === playerId);
    handlePlanSubmit(playerId, roomId, [{ type: 'explore', entityId: unit.id }], room.state.round);

    assert.ok(gamesUpdatesFor(playerId).length >= 1,
      'human player must receive gamesUpdate after a plan submission');
    const aiSeat = room.players.find(s => s.isAI);
    assert.equal(gamesUpdatesFor(aiSeat.playerId).length, 0,
      'AI seats must not be notified');
  });

  test('round resolution pushes gamesUpdate to human players', () => {
    const { roomId, ws, playerId } = createTestGame();
    const room = getRoom(roomId);
    const round = room.state.round;

    // Human submits first, then the AI's submission completes the round and
    // triggers resolution synchronously.
    const unit = room.state.entities.find(e => e.alive && e.ownerId === playerId);
    handlePlanSubmit(playerId, roomId, [{ type: 'explore', entityId: unit.id }], round);
    sent.length = 0;

    const aiSeat = room.players.find(s => s.isAI);
    handlePlanSubmit(aiSeat.playerId, roomId, [], round);

    assert.ok(ws.findMsg('resolutionComplete'), 'round must have resolved');
    assert.ok(room.state.round > round, 'round must advance');
    assert.ok(gamesUpdatesFor(playerId).length >= 1,
      'human player must receive gamesUpdate after resolution');
  });
});

// ── src/multiplayer.js — gamesUpdate routing (behavioral) ────────────────────

describe('multiplayer.js — gamesUpdate routing', () => {
  test('routes gamesUpdate message to onGamesUpdate callback', async () => {
    // platform.js (imported by multiplayer.js) touches browser globals at init.
    globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
    globalThis.document ??= { addEventListener() {}, removeEventListener() {}, hidden: false };
    const { MultiplayerClient } = await import('../src/multiplayer.js');

    let calls = 0;
    const client = new MultiplayerClient({ onGamesUpdate() { calls++; } });
    client._route({ type: 'gamesUpdate' });
    assert.equal(calls, 1, 'onGamesUpdate must be invoked');
  });
});

// ── Wiring checks (source-level) ─────────────────────────────────────────────
//
// server.js is the process entry point (binds HTTP/WS servers on import) and
// src/main.js is the client entry script with top-level DOM side effects —
// neither can be imported under node:test, and async-game rooms need heavy DB
// fixtures. The remaining wiring is asserted minimally against the source.

describe('gamesUpdate wiring (source-level)', () => {
  test('server.js tracks player sockets and injects sendToPlayer into lobby.js', () => {
    const serverSource = readFileSync(join(root, 'server.js'), 'utf8');
    assert.ok(serverSource.includes('playerWsMap'),
      'server.js should track player→WebSocket mapping');
    assert.ok(serverSource.includes('setSendToPlayer(sendToPlayer)'),
      'server.js should inject sendToPlayer into lobby.js');
    assert.ok(serverSource.includes('_unregisterPlayerWs'),
      'server.js should unregister sockets on close');
  });

  test('async rounds also push gamesUpdate (async rooms need heavy DB fixtures)', () => {
    const asyncRoomsSource = readFileSync(join(root, 'server', 'async-game-rooms.js'), 'utf8');
    assert.ok(asyncRoomsSource.includes('_notifyGamesUpdate'),
      'async-game-rooms.js should notify on async plan submission/resolution');
  });

  test('main.js wires onGamesUpdate and refreshes the badge on navigation', () => {
    const mainSource = readFileSync(join(root, 'src', 'main.js'), 'utf8');
    assert.ok(mainSource.includes('onGamesUpdate'),
      'main.js should wire onGamesUpdate in MultiplayerClient options');
    assert.ok(mainSource.includes('_updateMultiplayerBadge()'),
      'main.js should refresh the multiplayer badge');
  });
});
