// Lobby: matchmaking queue, room lifecycle, server-side AI, action dispatch
import { randomUUID } from 'crypto';
import { GameState, Player } from '../src/game.js';
import { WitchAI, HeroAI }  from '../src/ai.js';
import {
  executeMove, executeExplore, executeBattle,
  executeFortify, executeSummon, executeUseItem, executeUseAbility,
} from '../src/actions.js';
import { serializeState }     from './state-sync.js';
import { recordResult }       from './leaderboard.js';

// ── Constants ────────────────────────────────────────────────────────────────
const AI_FILL_DELAY_MS   = 5_000;  // wait this long before filling with AI
const RECONNECT_GRACE_MS = 60_000; // time to reconnect before forfeit
const AI_TAKEOVER_MS     = 12_000; // replace disconnected player with AI after 12s
const TURN_TIMEOUT_MS    = 90_000; // auto-end a human turn after 90s of inactivity

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, Room>} */
const rooms = new Map();

/** @type {{ playerId: string, ws: import('ws').WebSocket, joinedAt: number }[]} */
const queue = [];

/** 6-char uppercase code → roomId */
const codeToRoom = new Map();

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws?.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj));
}

function broadcast(room, obj) {
  send(room.heroWs,  obj);
  send(room.witchWs, obj);
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function factionFor(room, playerId) {
  if (room.heroPlayerId  === playerId) return 'hero';
  if (room.witchPlayerId === playerId) return 'witch';
  return null;
}

// ── Room ─────────────────────────────────────────────────────────────────────

/**
 * @typedef {{
 *   id: string,
 *   code: string,
 *   heroPlayerId:  string|null,
 *   witchPlayerId: string|null,
 *   heroWs:        import('ws').WebSocket|null,
 *   witchWs:       import('ws').WebSocket|null,
 *   heroName:      string,
 *   witchName:     string,
 *   state:         GameState,
 *   aiTimer:       ReturnType<typeof setTimeout>|null,
 *   witchAI:       WitchAI|null,
 *   heroAI:        HeroAI|null,
 *   disconnectTimers: Map<string, ReturnType<typeof setTimeout>>,
 * }} Room
 */

function createRoom(heroPlayerId, heroWs, heroName, witchPlayerId, witchWs, witchName) {
  const id    = randomUUID();
  let   code;
  do { code = randomCode(); } while (codeToRoom.has(code));

  // Both sides human-controlled from the server's perspective; AI is driven externally
  const state = new GameState(false, false);
  state.fogOfWar = true;

  /** @type {Room} */
  const room = {
    id,
    code,
    heroPlayerId,  witchPlayerId,
    heroWs,        witchWs,
    heroName,      witchName,
    state,
    aiTimer:          null,
    witchAI:          null,
    heroAI:           null,
    disconnectTimers: new Map(),
    turnTimer:        null,   // fires when a human takes too long
    takeoverTimers:   new Map(), // fires to replace disconnected player with AI
  };

  rooms.set(id, room);
  codeToRoom.set(code, id);
  return room;
}

function destroyRoom(room) {
  if (room.aiTimer)   clearTimeout(room.aiTimer);
  if (room.turnTimer) clearTimeout(room.turnTimer);
  for (const t of room.disconnectTimers.values()) clearTimeout(t);
  for (const t of room.takeoverTimers.values())   clearTimeout(t);
  rooms.delete(room.id);
  codeToRoom.delete(room.code);
}

// ── Turn timer helpers ────────────────────────────────────────────────────────

/** Start (or restart) the turn clock for the current human player's turn. */
function _startTurnTimer(room) {
  _clearTurnTimer(room);
  if (room.state.gameOver) return;

  const faction = room.state.activePlayer;
  const isHumanTurn =
    (faction === Player.HERO  && room.heroPlayerId  !== 'ai') ||
    (faction === Player.WITCH && room.witchPlayerId !== 'ai');
  if (!isHumanTurn) return;

  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.state.gameOver) return;
    if (room.state.activePlayer !== faction) return; // already changed
    console.log(`[room ${room.id}] Turn timeout for ${faction} — auto-ending turn.`);
    const ws = faction === Player.HERO ? room.heroWs : room.witchWs;
    send(ws, { type: 'error', message: 'Turn time expired — your turn was ended automatically.' });
    room.state.endTurn();
    broadcastState(room, 'endTurn');
    checkAndHandleGameOver(room);
    if (!room.state.gameOver) {
      _startTurnTimer(room);
      setTimeout(() => runAITurn(room), 100);
    }
  }, TURN_TIMEOUT_MS);
}

function _clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

// ── AI helpers ───────────────────────────────────────────────────────────────

function attachAI(room, faction) {
  const noop = () => Promise.resolve();
  if (faction === 'witch') {
    room.witchPlayerId = 'ai';
    room.witchName     = 'The AI Witch';
    room.witchAI = new WitchAI(room.state, () => broadcastState(room), 0);
    room.witchAI.onBattleResult = (actorSnap, targetSnap, result) => {
      broadcastBattleResult(room, actorSnap, targetSnap, result);
      return noop();
    };
    room.state.witchIsAI = true;
  } else {
    room.heroPlayerId = 'ai';
    room.heroName     = 'The AI Hero';
    room.heroAI = new HeroAI(room.state, () => broadcastState(room), 0);
    room.heroAI.onBattleResult = (actorSnap, targetSnap, result) => {
      broadcastBattleResult(room, actorSnap, targetSnap, result);
      return noop();
    };
    room.state.heroIsAI = true;
  }
}

async function runAITurn(room) {
  if (room.state.gameOver) return;
  const ai = room.state.activePlayer === Player.WITCH ? room.witchAI
           : room.state.activePlayer === Player.HERO  ? room.heroAI
           : null;
  if (!ai) return;

  try {
    await ai.takeTurn();
  } catch (err) {
    console.error(`[room ${room.id}] AI takeTurn error:`, err);
    // Force end the turn so the game doesn't freeze
    if (!room.state.gameOver) {
      try { room.state.endTurn(); } catch {}
    }
  }

  broadcastState(room, 'endTurn');
  checkAndHandleGameOver(room);
  if (!room.state.gameOver) {
    _startTurnTimer(room);
    // If the next turn is also AI (e.g. both sides AI), keep going
    if (
      (room.state.activePlayer === Player.WITCH && room.witchAI) ||
      (room.state.activePlayer === Player.HERO  && room.heroAI)
    ) {
      setTimeout(() => runAITurn(room), 50);
    }
  }
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcastState(room, reason = 'update') {
  const snap = serializeState(room.state);
  broadcast(room, { type: 'stateUpdate', reason, state: snap });
}

function broadcastBattleResult(room, actorSnap, targetSnap, result) {
  broadcast(room, { type: 'battleResult', actorSnap, targetSnap, result });
}

function checkAndHandleGameOver(room) {
  if (!room.state.gameOver) return;

  const winner = room.state.winner;
  broadcastState(room, 'gameOver');

  // Record results for human players
  const record = (playerId, outcome) => {
    if (playerId && playerId !== 'ai') recordResult(playerId, outcome);
  };

  if (winner === 'hero') {
    record(room.heroPlayerId,  'win');
    record(room.witchPlayerId, 'loss');
  } else if (winner === 'witch') {
    record(room.witchPlayerId, 'win');
    record(room.heroPlayerId,  'loss');
  } else {
    record(room.heroPlayerId,  'draw');
    record(room.witchPlayerId, 'draw');
  }

  // Give clients a moment to process then clean up
  setTimeout(() => destroyRoom(room), 5_000);
}

// ── Matchmaking ───────────────────────────────────────────────────────────────

function tryMatch() {
  if (queue.length < 2) return;

  // Dequeue two players
  const a = queue.shift();
  const b = queue.shift();

  // Randomly assign factions
  const [hero, witch] = Math.random() < 0.5 ? [a, b] : [b, a];

  const room = createRoom(
    hero.playerId,  hero.ws,  hero.playerName,
    witch.playerId, witch.ws, witch.playerName,
  );

  send(hero.ws,  { type: 'matchFound', roomId: room.id, faction: 'hero',  opponentName: witch.playerName, aiOpponent: false });
  send(witch.ws, { type: 'matchFound', roomId: room.id, faction: 'witch', opponentName: hero.playerName,  aiOpponent: false });

  broadcastState(room, 'start');
  _startTurnTimer(room);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Player joins the matchmaking queue. Returns a cleanup fn. */
export function joinQueue(playerId, playerName, ws) {
  // Remove any existing queue entry for this player
  leaveQueue(playerId);

  const entry = { playerId, playerName, ws, joinedAt: Date.now() };
  queue.push(entry);

  send(ws, { type: 'inQueue', position: queue.length });
  tryMatch();

  // AI fill-in after 30s if still waiting
  const fillTimer = setTimeout(() => {
    const idx = queue.findIndex(e => e.playerId === playerId);
    if (idx === -1) return; // already matched
    queue.splice(idx, 1);

    // Randomly assign faction to the human player
    const humanFaction = Math.random() < 0.5 ? 'hero' : 'witch';
    const aiFaction    = humanFaction === 'hero' ? 'witch' : 'hero';

    let room;
    if (humanFaction === 'hero') {
      room = createRoom(playerId, ws, playerName, null, null, 'AI Witch');
    } else {
      room = createRoom(null, null, 'AI Hero', playerId, ws, playerName);
    }

    attachAI(room, aiFaction);

    send(ws, {
      type: 'matchFound',
      roomId:       room.id,
      faction:      humanFaction,
      opponentName: aiFaction === 'witch' ? 'The AI Witch' : 'The AI Hero',
      aiOpponent:   true,
    });

    broadcastState(room, 'start');
    _startTurnTimer(room);

    // If it's the AI's turn first, kick it off
    setTimeout(() => {
      if (room.state.activePlayer === Player.WITCH && room.witchAI) runAITurn(room);
      else if (room.state.activePlayer === Player.HERO && room.heroAI) runAITurn(room);
    }, 100);

  }, AI_FILL_DELAY_MS);

  return () => {
    clearTimeout(fillTimer);
    leaveQueue(playerId);
  };
}

export function leaveQueue(playerId) {
  const idx = queue.findIndex(e => e.playerId === playerId);
  if (idx !== -1) queue.splice(idx, 1);
}

/** Create a private room and return the code. */
export function createPrivateRoom(playerId, playerName, ws) {
  // First player becomes hero by default; second player gets witch when joining
  const room = createRoom(playerId, ws, playerName, null, null, '');
  send(ws, { type: 'roomCode', code: room.code, roomId: room.id });

  // Set up AI fill-in timer (if second player never joins)
  room.aiTimer = setTimeout(() => {
    if (room.witchPlayerId !== null) return; // already joined
    room.witchPlayerId = null; // will be set to 'ai' by attachAI
    attachAI(room, 'witch');
    send(room.heroWs, { type: 'opponentJoined', opponentName: 'The AI Witch', aiOpponent: true });
    broadcastState(room, 'start');
    _startTurnTimer(room);
    // Hero always goes first; witch AI would only need to go first if we
    // randomise faction, but currently hero is always the human here.
    setTimeout(() => {
      if (room.state.activePlayer === Player.WITCH && room.witchAI) runAITurn(room);
      else if (room.state.activePlayer === Player.HERO && room.heroAI) runAITurn(room);
    }, 100);
  }, AI_FILL_DELAY_MS);
}

/** Immediately start a game against a server AI (no queue wait). */
export function joinAIGame(playerId, playerName, ws) {
  const humanFaction = Math.random() < 0.5 ? 'hero' : 'witch';
  const aiFaction    = humanFaction === 'hero' ? 'witch' : 'hero';

  const room = humanFaction === 'hero'
    ? createRoom(playerId, ws, playerName, null, null, '')
    : createRoom(null, null, '', playerId, ws, playerName);

  attachAI(room, aiFaction);

  send(ws, {
    type:         'matchFound',
    roomId:       room.id,
    faction:      humanFaction,
    opponentName: aiFaction === 'witch' ? 'The AI Witch' : 'The AI Hero',
    aiOpponent:   true,
  });

  broadcastState(room, 'start');
  _startTurnTimer(room);

  // If AI takes the first turn, kick it off after the client has the initial state
  setTimeout(() => {
    if (room.state.activePlayer === Player.WITCH && room.witchAI) runAITurn(room);
    else if (room.state.activePlayer === Player.HERO && room.heroAI) runAITurn(room);
  }, 100);
}

/** Second player joins a private room by code. */
export function joinPrivateRoom(playerId, playerName, ws, code) {
  const roomId = codeToRoom.get(code.toUpperCase());
  if (!roomId) { send(ws, { type: 'error', message: 'Room not found. Check the code and try again.' }); return; }

  const room = rooms.get(roomId);
  if (!room)  { send(ws, { type: 'error', message: 'Room has expired.' }); return; }
  if (room.witchPlayerId !== null) { send(ws, { type: 'error', message: 'Room is already full.' }); return; }

  // Clear the AI fill timer
  if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }

  room.witchPlayerId = playerId;
  room.witchWs       = ws;
  room.witchName     = playerName;

  send(room.heroWs, { type: 'opponentJoined', opponentName: playerName,        aiOpponent: false });
  send(ws,          { type: 'matchFound', roomId: room.id, faction: 'witch', opponentName: room.heroName, aiOpponent: false });

  broadcastState(room, 'start');
  _startTurnTimer(room);
}

/** Handle an incoming action from a player. */
export function handleAction(playerId, roomId, actionType, params) {
  const room = rooms.get(roomId);
  if (!room) return;

  const faction = factionFor(room, playerId);
  if (!faction) return;

  const ws    = faction === 'hero' ? room.heroWs : room.witchWs;
  const state = room.state;

  if (state.gameOver) { send(ws, { type: 'error', message: 'Game is over.' }); return; }
  if (state.activePlayer !== faction) {
    send(ws, { type: 'error', message: "It's not your turn." }); return;
  }

  // Player is active — reset the inactivity clock
  _startTurnTimer(room);

  let result;
  try {
    result = _executeAction(state, actionType, params);
  } catch (err) {
    send(ws, { type: 'error', message: 'Invalid action.' });
    return;
  }

  if (!result.success) {
    send(ws, { type: 'actionError', message: result.log?.[0] ?? 'Action failed.' });
    return;
  }

  for (const msg of result.log) state.addLog(msg);
  state.spendAction(result.cost);
  state.checkVictory();

  // For battle, send the breakdown before the state update
  if (actionType === 'battle' && result.battleResult) {
    broadcastBattleResult(room, result.battleResult.actorSnap, result.battleResult.targetSnap, result.battleResult);
  }

  broadcastState(room, actionType);
  checkAndHandleGameOver(room);
}

/** Handle end-of-turn from a player. */
export function handleEndTurn(playerId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const faction = factionFor(room, playerId);
  if (!faction) return;

  const state = room.state;
  if (state.gameOver) return;
  if (state.activePlayer !== faction) return;

  _clearTurnTimer(room);
  state.endTurn();
  broadcastState(room, 'endTurn');
  checkAndHandleGameOver(room);

  if (!state.gameOver) {
    _startTurnTimer(room);
    setTimeout(() => runAITurn(room), 100);
  }
}

/** Handle a player disconnecting mid-game. */
export function handleDisconnect(playerId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const faction    = factionFor(room, playerId);
  const opponentWs = faction === 'hero' ? room.witchWs : room.heroWs;
  send(opponentWs, { type: 'opponentDisconnected', graceMs: RECONNECT_GRACE_MS });

  // ── AI takeover after short gap ───────────────────────────────────────────
  // If the disconnected player is currently active, hand their turn to an AI
  // quickly so the remaining player isn't stuck waiting.
  const takeoverTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r || r.state.gameOver) return;
    if (faction === factionFor(r, playerId)) { // still their faction slot
      console.log(`[room ${roomId}] ${faction} disconnected — attaching AI.`);
      _clearTurnTimer(r);
      attachAI(r, faction);
      const aiName = faction === 'hero' ? 'The AI Hero' : 'The AI Witch';
      send(opponentWs, { type: 'opponentJoined', opponentName: `${aiName} (took over)`, aiOpponent: true });
      broadcastState(r, 'update');
      // If it's now the AI's turn, run it
      if (r.state.activePlayer === faction) {
        setTimeout(() => runAITurn(r), 100);
      }
    }
  }, AI_TAKEOVER_MS);
  room.takeoverTimers.set(playerId, takeoverTimer);

  // ── Forfeit after full grace period ──────────────────────────────────────
  const forfeitTimer = setTimeout(() => {
    const room2 = rooms.get(roomId);
    if (!room2) return;
    // If already replaced by AI, don't forfeit — just clean up timer
    const currentId = faction === 'hero' ? room2.heroPlayerId : room2.witchPlayerId;
    if (currentId === 'ai') { room2.disconnectTimers.delete(playerId); return; }

    recordResult(playerId, 'loss');
    const opponentId = faction === 'hero' ? room2.witchPlayerId : room2.heroPlayerId;
    if (opponentId && opponentId !== 'ai') recordResult(opponentId, 'win');
    send(opponentWs, { type: 'opponentForfeited' });
    destroyRoom(room2);
  }, RECONNECT_GRACE_MS);

  room.disconnectTimers.set(playerId, forfeitTimer);
}

/** Handle a player reconnecting. */
export function handleReconnect(playerId, roomId, ws) {
  const room = rooms.get(roomId);
  if (!room) return false;

  const faction = factionFor(room, playerId);
  if (!faction) return false;

  // Cancel takeover and forfeit timers
  const takeover = room.takeoverTimers.get(playerId);
  if (takeover) { clearTimeout(takeover); room.takeoverTimers.delete(playerId); }
  const forfeit = room.disconnectTimers.get(playerId);
  if (forfeit) { clearTimeout(forfeit); room.disconnectTimers.delete(playerId); }

  // If an AI already took over this faction, don't restore — too late
  const currentId = faction === 'hero' ? room.heroPlayerId : room.witchPlayerId;
  if (currentId === 'ai') {
    send(ws, { type: 'error', message: 'An AI took over your faction. The game continues without you.' });
    return false;
  }

  // Update websocket reference
  if (faction === 'hero')  room.heroWs  = ws;
  if (faction === 'witch') room.witchWs = ws;

  const opponentWs = faction === 'hero' ? room.witchWs : room.heroWs;
  send(opponentWs, { type: 'opponentReconnected' });

  // Send current state to the reconnected player
  send(ws, { type: 'reconnected', faction, roomId: room.id });
  send(ws, { type: 'stateUpdate', reason: 'reconnect', state: serializeState(room.state) });
  return true;
}

export function getRoomByCode(code) {
  const roomId = codeToRoom.get(code?.toUpperCase());
  return roomId ? rooms.get(roomId) : null;
}

export function getRoom(roomId) {
  return rooms.get(roomId) ?? null;
}

// ── Internal action dispatcher ────────────────────────────────────────────────

function _executeAction(state, actionType, params) {
  const entity = params.entityId ? state.entities.find(e => e.id === params.entityId && e.alive) : null;

  switch (actionType) {
    case 'move':
      if (!entity) return { success: false, log: ['Entity not found.'] };
      return executeMove(state, entity, params.col, params.row);

    case 'explore':
      if (!entity) return { success: false, log: ['Entity not found.'] };
      return executeExplore(state, entity);

    case 'battle': {
      if (!entity) return { success: false, log: ['Entity not found.'] };
      const target = state.entities.find(e => e.id === params.targetId && e.alive);
      if (!target) return { success: false, log: ['Target not found.'] };
      const actorSnap  = _snap(entity);
      const targetSnap = _snap(target);
      const result = executeBattle(state, entity, target);
      // Attach snapshots for the battle dialog
      result.battleResult = { ...result, actorSnap, targetSnap };
      return result;
    }

    case 'fortify':
      if (!entity) return { success: false, log: ['Entity not found.'] };
      return executeFortify(state, entity);

    case 'summon': {
      if (!entity) return { success: false, log: ['Entity not found.'] };
      return executeSummon(state, entity, params.col, params.row);
    }

    case 'use_item':
      if (!entity) return { success: false, log: ['Entity not found.'] };
      return executeUseItem(state, entity, params.item);

    case 'use_ability':
      if (!entity) return { success: false, log: ['Entity not found.'] };
      return executeUseAbility(state, entity);

    default:
      return { success: false, log: ['Unknown action.'] };
  }
}

function _snap(entity) {
  return {
    id:       entity.id,
    type:     entity.type,
    owner:    entity.owner,
    hp:       entity.hp,
    maxHp:    entity.maxHp,
    attack:   entity.attack,
    defense:  entity.defense,
    weapon:   entity.weapon,
    name:     entity.name,
    title:    entity.title,
    displayName: entity.displayName,
  };
}
