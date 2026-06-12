// Tests for the multiplayer nudge system.
//
// Covers:
// 1. buildPlayerStatusHtml nudge button rendering
// 2. Server-side handleNudge behavior (validation + message delivery)
// 3. Client multiplayer.js nudge send/routing

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildPlayerStatusHtml } from '../src/ui-render.js';
import { notifyNudge } from '../server/notifications.js';
import {
  createLobby, joinLobby, claimSlot, fillAllWithAI, startGame,
  handlePlanSubmit, handleNudge, setSendToPlayer,
  getRooms, getRoom,
} from '../server/lobby.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

// ── buildPlayerStatusHtml nudge button tests ─────────────────────────────────

describe('buildPlayerStatusHtml — nudge buttons', () => {
  const players = [
    { playerId: 'me',    name: 'Alice', faction: 'hero',  isAI: false, _submitted: false },
    { playerId: 'other', name: 'Bob',   faction: 'witch', isAI: false, _submitted: false },
    { playerId: 'ai1',   name: 'BotX',  faction: 'witch', isAI: true,  _submitted: false },
  ];

  test('no nudge buttons when nudgeCtx is omitted', () => {
    const html = buildPlayerStatusHtml(players);
    assert.ok(!html.includes('nudge-btn'), 'should not render nudge buttons without context');
  });

  test('no nudge button for self', () => {
    const html = buildPlayerStatusHtml(players, {
      myPlayerId: 'me',
      nudgedSet: new Set(),
    });
    // Count nudge buttons — should not appear for 'me' or the AI
    const matches = html.match(/data-nudge-id/g) || [];
    assert.equal(matches.length, 1, 'exactly one nudge button (for Bob)');
    assert.ok(html.includes('data-nudge-id="other"'), 'nudge button targets Bob');
  });

  test('no nudge button for AI players', () => {
    const html = buildPlayerStatusHtml(players, {
      myPlayerId: 'me',
      nudgedSet: new Set(),
    });
    assert.ok(!html.includes('data-nudge-id="ai1"'), 'AI player should not have nudge button');
  });

  test('nudge button is disabled after nudging', () => {
    const html = buildPlayerStatusHtml(players, {
      myPlayerId: 'me',
      nudgedSet: new Set(['other']),
    });
    assert.ok(!html.includes('data-nudge-id="other"'), 'no active nudge button after nudging');
    assert.ok(html.includes('nudge-sent'), 'should show nudge-sent class');
    assert.ok(html.includes('disabled'), 'button should be disabled');
  });

  test('no nudge button for players who already submitted', () => {
    const submitted = [
      { playerId: 'me',    name: 'Alice', faction: 'hero',  isAI: false, _submitted: false },
      { playerId: 'other', name: 'Bob',   faction: 'witch', isAI: false, _submitted: true },
    ];
    const html = buildPlayerStatusHtml(submitted, {
      myPlayerId: 'me',
      nudgedSet: new Set(),
    });
    assert.ok(!html.includes('nudge-btn'), 'submitted player should not have nudge button');
  });
});

// ── Server-side nudge handler (behavioral) ───────────────────────────────────

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

/** 1v1 game with two human players, in the planning phase. */
function createTwoHumanGame() {
  const ws1 = mockWs();
  const ws2 = mockWs();
  const p1 = 'nudge-p1';
  const p2 = 'nudge-p2';
  createLobby(p1, 'NudgeHero', ws1, { playersPerSide: 1, mapSize: 'skirmish', fog: 'none' });
  const roomId = ws1.findMsg('lobbyJoined').lobby.id;
  claimSlot(p1, roomId, 0);
  joinLobby(p2, 'NudgeWitch', ws2, roomId);
  claimSlot(p2, roomId, 1);
  startGame(p1, roomId);
  return { roomId: ws1.findMsg('matchFound').roomId, ws1, ws2, p1, p2 };
}

describe('server nudge handler — lobby.js (behavioral)', () => {
  let pushed; // [playerId, msg] pairs captured from the injected sendToPlayer

  beforeEach(() => {
    cleanUpRooms();
    pushed = [];
    setSendToPlayer((playerId, msg) => pushed.push([playerId, msg]));
  });
  afterEach(() => {
    setSendToPlayer(null);
    cleanUpRooms();
  });

  const nudgedFor = (playerId) =>
    pushed.filter(([pid, msg]) => pid === playerId && msg.type === 'nudged');

  test('delivers nudged to the target and nudgeAck to the sender', () => {
    const { roomId, ws1, p1, p2 } = createTwoHumanGame();

    handleNudge(p1, roomId, p2);

    const delivered = nudgedFor(p2);
    assert.equal(delivered.length, 1, 'target must receive a nudged message');
    assert.equal(delivered[0][1].fromPlayerId, p1);
    assert.equal(delivered[0][1].fromName, 'NudgeHero');
    assert.equal(delivered[0][1].roomId, roomId);

    const ack = ws1.findMsg('nudgeAck');
    assert.ok(ack, 'sender must receive nudgeAck');
    assert.equal(ack.targetPlayerId, p2);
  });

  test('only one nudge per sender→target per round', () => {
    const { roomId, ws1, p1, p2 } = createTwoHumanGame();

    handleNudge(p1, roomId, p2);
    handleNudge(p1, roomId, p2);

    assert.equal(nudgedFor(p2).length, 1, 'second nudge in the same round is dropped');
    assert.equal(ws1.msgsOf('nudgeAck').length, 1, 'no second ack either');
  });

  test('self-nudge is rejected', () => {
    const { roomId, ws1, p1 } = createTwoHumanGame();
    handleNudge(p1, roomId, p1);
    assert.equal(nudgedFor(p1).length, 0);
    assert.equal(ws1.msgsOf('nudgeAck').length, 0);
  });

  test('nudging an AI seat is rejected', () => {
    const ws = mockWs();
    const p1 = 'nudge-ai-p1';
    createLobby(p1, 'NudgeHero', ws, { playersPerSide: 1, mapSize: 'skirmish', fog: 'none' });
    const roomId = ws.findMsg('lobbyJoined').lobby.id;
    claimSlot(p1, roomId, 0);
    fillAllWithAI(p1, roomId);
    startGame(p1, roomId);
    const room = getRoom(ws.findMsg('matchFound').roomId);
    const aiSeat = room.players.find(s => s.isAI);

    handleNudge(p1, room.id, aiSeat.playerId);
    assert.equal(nudgedFor(aiSeat.playerId).length, 0, 'AI must not be nudged');
    assert.equal(ws.msgsOf('nudgeAck').length, 0);
  });

  test('players who already submitted cannot be nudged', () => {
    const { roomId, ws1, p1, p2 } = createTwoHumanGame();
    const room = getRoom(roomId);
    const unit = room.state.entities.find(e => e.alive && e.ownerId === p2);
    handlePlanSubmit(p2, roomId, [{ type: 'explore', entityId: unit.id }], room.state.round);

    handleNudge(p1, roomId, p2);
    assert.equal(nudgedFor(p2).length, 0, 'submitted player must not be nudged');
    assert.equal(ws1.msgsOf('nudgeAck').length, 0);
  });

  test('nudges are only allowed during the planning phase', () => {
    const { roomId, ws1, p1, p2 } = createTwoHumanGame();
    const room = getRoom(roomId);
    room.phase = 'resolving'; // simulate mid-resolution

    handleNudge(p1, roomId, p2);
    assert.equal(nudgedFor(p2).length, 0);
    assert.equal(ws1.msgsOf('nudgeAck').length, 0);
  });
});

// ── Server route — server.js (source-level) ──────────────────────────────────
//
// server.js is the process entry point (binds HTTP/WS servers on import), so
// the message-routing wiring is asserted minimally against the source.

describe('server.js nudge routing (source-level)', () => {
  test('routes the nudge message type to handleNudge', () => {
    const serverSource = readFileSync(join(root, 'server.js'), 'utf8');
    assert.ok(serverSource.includes("case 'nudge':"),
      'server.js should route the nudge message type');
    assert.ok(serverSource.includes('handleNudge(cs.player.id, cs.roomId, msg.targetPlayerId)'),
      'should call handleNudge with sender, room, and target');
  });
});

// ── Client multiplayer.js (behavioral) ───────────────────────────────────────

describe('multiplayer.js nudge support', () => {
  // platform.js (imported by multiplayer.js) touches browser globals at init.
  globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
  globalThis.document ??= { addEventListener() {}, removeEventListener() {}, hidden: false };

  async function makeClient(opts = {}) {
    const { MultiplayerClient } = await import('../src/multiplayer.js');
    return new MultiplayerClient(opts);
  }

  test('sendNudge sends a nudge message over the socket', async () => {
    const client = await makeClient();
    const sent = [];
    client._ws = { readyState: 1, send(d) { sent.push(JSON.parse(d)); } };

    client.sendNudge('target-player');
    assert.deepEqual(sent, [{ type: 'nudge', targetPlayerId: 'target-player' }]);
  });

  test('routes nudged message to onNudged callback', async () => {
    const received = [];
    const client = await makeClient({ onNudged(msg) { received.push(msg); } });
    client._route({ type: 'nudged', fromPlayerId: 'p9', fromName: 'Eve', roomId: 'r1' });
    assert.equal(received.length, 1);
    assert.equal(received[0].fromName, 'Eve');
  });

  test('routes nudgeAck message to onNudgeAck callback', async () => {
    const received = [];
    const client = await makeClient({ onNudgeAck(msg) { received.push(msg); } });
    client._route({ type: 'nudgeAck', targetPlayerId: 'p2' });
    assert.equal(received.length, 1);
    assert.equal(received[0].targetPlayerId, 'p2');
  });

  test('stores isAsync from matchFound', async () => {
    const client = await makeClient({ onMatchFound() {} });
    client._route({ type: 'matchFound', faction: 'hero', roomId: 'r1', isAsync: true });
    assert.equal(client.isAsync, true);
  });
});

// ── Notifications ────────────────────────────────────────────────────────────

describe('notifications.js nudge support', () => {
  test('exports a notifyNudge function', () => {
    assert.equal(typeof notifyNudge, 'function');
  });
});
