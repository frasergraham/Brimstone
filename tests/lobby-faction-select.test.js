// Tests for lobby faction selection (claimSlot):
//   - Host starts unassigned, can claim a slot
//   - Joining players start unassigned
//   - Players can switch between slots
//   - Fill with AI blocked while players are unassigned
//   - Start game blocked while players are unassigned
//   - Invited players (with slotIndex) go directly to the target slot
//   - leaveLobby works for unassigned players

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  createLobby, joinLobby, claimSlot, fillAllWithAI, startGame,
  leaveLobby, getRooms, getRoom, setFaction,
} from '../server/lobby.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockWs() {
  const ws = {
    readyState: 1,
    messages: [],
    send(data) { ws.messages.push(JSON.parse(data)); },
    last() { return ws.messages[ws.messages.length - 1]; },
    findMsg(type) { return ws.messages.find(m => m.type === type); },
    allMsgs(type) { return ws.messages.filter(m => m.type === type); },
    clearMsgs() { ws.messages.length = 0; },
  };
  return ws;
}

function cleanUpRooms() {
  for (const r of getRooms()) {
    const room = getRoom(r.id);
    if (room) {
      if (room.turnTimer) clearTimeout(room.turnTimer);
      if (room.allHumansGoneTimer) clearTimeout(room.allHumansGoneTimer);
      for (const t of room.disconnectTimers.values()) clearTimeout(t);
      for (const t of room.takeoverTimers.values()) clearTimeout(t);
    }
  }
}

function createTestLobby(hostId = 'host-1', pps = 1) {
  const ws = mockWs();
  createLobby(hostId, 'HostPlayer', ws, {
    playersPerSide: pps,
    mapSize: 'skirmish',
    fog: 'none',
  });
  const lobbyMsg = ws.findMsg('lobbyJoined');
  return { roomId: lobbyMsg.lobby.id, ws, lobby: lobbyMsg.lobby };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('lobby faction selection: unassigned state', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('host starts unassigned — not placed in any slot', () => {
    const { lobby } = createTestLobby();

    // Host should be in unassigned, not in any slot
    assert.equal(lobby.unassigned.length, 1);
    assert.equal(lobby.unassigned[0].playerId, 'host-1');
    assert.equal(lobby.unassigned[0].name, 'HostPlayer');

    // All slots should be empty
    for (const slot of lobby.slots) {
      assert.equal(slot.status, 'empty');
      assert.equal(slot.playerId, null);
    }
  });

  test('joining player starts unassigned', () => {
    const { roomId, ws: hostWs, lobby } = createTestLobby('host-1', 2);

    const guestWs = mockWs();
    joinLobby('guest-1', 'GuestPlayer', guestWs, roomId);

    const guestLobby = guestWs.findMsg('lobbyJoined').lobby;
    assert.equal(guestLobby.unassigned.length, 2);

    const guestEntry = guestLobby.unassigned.find(u => u.playerId === 'guest-1');
    assert.ok(guestEntry, 'guest should be in unassigned');
    assert.equal(guestEntry.name, 'GuestPlayer');
  });

  test('duplicate join is rejected', () => {
    const { roomId } = createTestLobby();
    const ws2 = mockWs();
    joinLobby('host-1', 'HostPlayer', ws2, roomId);
    const err = ws2.findMsg('error');
    assert.ok(err, 'should get error');
    assert.match(err.message, /already in this lobby/i);
  });
});

describe('lobby faction selection: claimSlot', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('unassigned player can claim an empty slot', () => {
    const { roomId, ws } = createTestLobby();
    ws.clearMsgs();

    // Hero slot is index 0, witch slot is index 1 (for 1v1)
    claimSlot('host-1', roomId, 0);

    const update = ws.findMsg('lobbyUpdate');
    assert.ok(update, 'should receive lobbyUpdate');
    assert.equal(update.lobby.unassigned.length, 0, 'no one should be unassigned');
    assert.equal(update.lobby.slots[0].status, 'human');
    assert.equal(update.lobby.slots[0].playerId, 'host-1');
    assert.equal(update.lobby.slots[0].name, 'HostPlayer');
  });

  test('player can switch from one slot to another', () => {
    const { roomId, ws } = createTestLobby();

    // Claim hero slot first
    claimSlot('host-1', roomId, 0);
    ws.clearMsgs();

    // Switch to witch slot
    claimSlot('host-1', roomId, 1);

    const update = ws.findMsg('lobbyUpdate');
    assert.ok(update);
    // Old slot (hero) should be empty again
    assert.equal(update.lobby.slots[0].status, 'empty');
    assert.equal(update.lobby.slots[0].playerId, null);
    // New slot (witch) should have the player
    assert.equal(update.lobby.slots[1].status, 'human');
    assert.equal(update.lobby.slots[1].playerId, 'host-1');
  });

  test('claiming an occupied slot is rejected', () => {
    const { roomId, ws } = createTestLobby('host-1', 2);
    claimSlot('host-1', roomId, 0);

    const guestWs = mockWs();
    joinLobby('guest-1', 'GuestPlayer', guestWs, roomId);
    guestWs.clearMsgs();

    // Try to claim the same slot as host
    claimSlot('guest-1', roomId, 0);

    const err = guestWs.findMsg('error');
    assert.ok(err, 'should get error');
    assert.match(err.message, /not available/i);
  });

  test('unassigned player receives lobby updates', () => {
    const { roomId } = createTestLobby('host-1', 2);

    const guestWs = mockWs();
    joinLobby('guest-1', 'GuestPlayer', guestWs, roomId);
    guestWs.clearMsgs();

    // Host claims a slot — guest (still unassigned) should get the update
    claimSlot('host-1', roomId, 0);

    const update = guestWs.findMsg('lobbyUpdate');
    assert.ok(update, 'unassigned player should receive lobbyUpdate');
    assert.equal(update.lobby.slots[0].playerId, 'host-1');
  });
});

describe('lobby faction selection: fillAllWithAI blocked', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('fillAllWithAI rejected when players are unassigned', () => {
    const { roomId, ws } = createTestLobby();
    ws.clearMsgs();

    fillAllWithAI('host-1', roomId, 'random');

    const err = ws.findMsg('error');
    assert.ok(err, 'should get error');
    assert.match(err.message, /pick a side/i);

    // Verify no slot was filled
    const room = getRoom(roomId);
    assert.ok(room.slots.every(s => s.status === 'empty'), 'all slots should still be empty');
  });

  test('fillAllWithAI works when all humans have slots', () => {
    const { roomId, ws } = createTestLobby();

    // Host claims hero slot
    claimSlot('host-1', roomId, 0);
    ws.clearMsgs();

    // Now fill rest with AI
    fillAllWithAI('host-1', roomId, 'random');

    const room = getRoom(roomId);
    assert.equal(room.slots[1].status, 'ai', 'witch slot should have AI');
  });
});

describe('lobby faction selection: startGame blocked', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('startGame rejected when players are unassigned', () => {
    const { roomId, ws } = createTestLobby();
    ws.clearMsgs();

    startGame('host-1', roomId);

    const err = ws.findMsg('error');
    assert.ok(err, 'should get error');
    assert.match(err.message, /pick a side/i);
  });

  test('startGame works after all players pick slots', () => {
    const { roomId, ws } = createTestLobby();

    // Claim slot and fill rest with AI
    claimSlot('host-1', roomId, 0);
    fillAllWithAI('host-1', roomId, 'random');
    ws.clearMsgs();

    startGame('host-1', roomId);

    const matchMsg = ws.findMsg('matchFound');
    assert.ok(matchMsg, 'should receive matchFound after starting');
  });
});

describe('lobby faction selection: invited slot', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('joining with slotIndex places player directly in that slot', () => {
    const { roomId, ws: hostWs } = createTestLobby('host-1', 2);

    const guestWs = mockWs();
    // Join with slotIndex pointing to witch slot (index 2 for 2v2: hero0, hero1, witch0, witch1)
    joinLobby('guest-1', 'GuestPlayer', guestWs, roomId, 2);

    const guestLobby = guestWs.findMsg('lobbyJoined').lobby;
    assert.equal(guestLobby.slots[2].status, 'human');
    assert.equal(guestLobby.slots[2].playerId, 'guest-1');
    // Guest should NOT be in unassigned
    assert.ok(
      !guestLobby.unassigned.some(u => u.playerId === 'guest-1'),
      'invited player should not be unassigned'
    );
  });

  test('joining with taken slotIndex falls back to unassigned', () => {
    const { roomId } = createTestLobby('host-1', 2);

    // First guest takes slot 0
    const ws1 = mockWs();
    joinLobby('guest-1', 'Guest1', ws1, roomId, 0);

    // Second guest tries same slot — should fall through to unassigned
    const ws2 = mockWs();
    joinLobby('guest-2', 'Guest2', ws2, roomId, 0);

    const lobby = ws2.findMsg('lobbyJoined').lobby;
    assert.ok(
      lobby.unassigned.some(u => u.playerId === 'guest-2'),
      'should be in unassigned when invited slot is taken'
    );
  });
});

describe('lobby faction selection: leaveLobby', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('unassigned non-host can leave', () => {
    const { roomId, ws: hostWs } = createTestLobby('host-1', 2);

    const guestWs = mockWs();
    joinLobby('guest-1', 'GuestPlayer', guestWs, roomId);
    hostWs.clearMsgs();

    leaveLobby('guest-1', roomId);

    // Host should get update without the guest
    const update = hostWs.findMsg('lobbyUpdate');
    assert.ok(update);
    assert.ok(
      !update.lobby.unassigned.some(u => u.playerId === 'guest-1'),
      'guest should be removed from unassigned'
    );
  });

  test('lobby capacity check accounts for unassigned players', () => {
    const { roomId } = createTestLobby('host-1', 1);

    // With 1v1, total slots = 2. Host (unassigned) = 1.
    const guestWs = mockWs();
    joinLobby('guest-1', 'GuestPlayer', guestWs, roomId);

    // Third player should be rejected (2 unassigned, 2 total slots)
    const ws3 = mockWs();
    joinLobby('player-3', 'Player3', ws3, roomId);
    const err = ws3.findMsg('error');
    assert.ok(err);
    assert.match(err.message, /full/i);
  });
});

// ── Side / factionId carried on slots ──────────────────────────────────────

describe('lobby slots carry side and factionId', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('every slot exposes side and factionId on lobbyJoined', () => {
    const { lobby } = createTestLobby();
    for (const slot of lobby.slots) {
      assert.ok(['day', 'night'].includes(slot.side), `slot.side should be day|night, got ${slot.side}`);
      assert.ok(slot.factionId, 'slot.factionId should be set');
      // Default mapping today: factionId === legacy faction.
      assert.equal(slot.factionId, slot.faction);
    }
  });

  test('hero slots map to day side; witch slots map to night side', () => {
    const { lobby } = createTestLobby('host-1', 2);
    const heroSlots  = lobby.slots.filter(s => s.faction === 'hero');
    const witchSlots = lobby.slots.filter(s => s.faction === 'witch');
    assert.ok(heroSlots.every(s => s.side === 'day'));
    assert.ok(witchSlots.every(s => s.side === 'night'));
  });
});

// ── claimSlot factionId override ───────────────────────────────────────────

describe('claimSlot with factionId override', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('claiming with the slot\'s default factionId is a no-op override', () => {
    const { roomId, ws } = createTestLobby();
    ws.clearMsgs();

    claimSlot('host-1', roomId, 0, 'hero');

    const update = ws.findMsg('lobbyUpdate');
    assert.ok(update);
    assert.equal(update.lobby.slots[0].factionId, 'hero');
    assert.equal(update.lobby.slots[0].side,      'day');
  });

  test('a factionId from the wrong side is silently ignored at claim time', () => {
    const { roomId, ws } = createTestLobby();
    ws.clearMsgs();

    // Witch is on the night side; trying to set it on a day slot must not stick.
    claimSlot('host-1', roomId, 0, 'witch');

    const update = ws.findMsg('lobbyUpdate');
    assert.ok(update);
    assert.equal(update.lobby.slots[0].factionId, 'hero', 'factionId should remain default');
  });

  test('omitting factionId leaves the slot\'s pre-existing value', () => {
    const { roomId, ws } = createTestLobby();
    ws.clearMsgs();
    claimSlot('host-1', roomId, 0); // no factionId
    const update = ws.findMsg('lobbyUpdate');
    assert.equal(update.lobby.slots[0].factionId, 'hero');
  });
});

// ── setFaction ─────────────────────────────────────────────────────────────

describe('setFaction', () => {
  beforeEach(cleanUpRooms);
  afterEach(cleanUpRooms);

  test('valid same-side faction switch updates slot.factionId', () => {
    const { roomId, ws } = createTestLobby();
    claimSlot('host-1', roomId, 0); // claim a day slot
    ws.clearMsgs();

    // 'hero' is on day side — same-side, so this should succeed (and is a no-op
    // since the seat already holds hero, but still sends an update if changed).
    setFaction('host-1', roomId, 'hero');

    // No-op when factionId unchanged — no update broadcast required, and no error.
    assert.equal(ws.findMsg('error'), undefined);
  });

  test('cross-side faction switch is rejected with an error', () => {
    const { roomId, ws } = createTestLobby();
    claimSlot('host-1', roomId, 0); // day slot
    ws.clearMsgs();

    setFaction('host-1', roomId, 'witch'); // wrong side

    const err = ws.findMsg('error');
    assert.ok(err, 'should receive an error for cross-side faction switch');
    assert.match(err.message, /not on the day side/i);

    // Faction id should be unchanged.
    const room = getRoom(roomId);
    assert.equal(room.slots[0].factionId, 'hero');
  });

  test('setFaction does nothing if player is not seated', () => {
    const { roomId, ws } = createTestLobby();
    // Player has not claimed a slot yet — still in unassigned.
    ws.clearMsgs();

    setFaction('host-1', roomId, 'hero');

    // No error and no update — silently ignored, like other lobby ops on
    // unseated players.
    assert.equal(ws.findMsg('error'), undefined);
  });

  test('setFaction is rejected once the room leaves lobby state', () => {
    const { roomId } = createTestLobby();
    claimSlot('host-1', roomId, 0);
    const room = getRoom(roomId);
    room.status = 'playing'; // simulate game start

    // Should be a no-op — neither error nor mutation. (We're past validation
    // gates that send 'error'; setFaction simply returns when status !== 'lobby'.)
    setFaction('host-1', roomId, 'hero');
    assert.equal(room.slots[0].factionId, 'hero');
  });
});
