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
import { resolvePlans }       from './resolver.js';

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

function createRoom(heroPlayerId, heroWs, heroName, witchPlayerId, witchWs, witchName, fog = true) {
  const id    = randomUUID();
  let   code;
  do { code = randomCode(); } while (codeToRoom.has(code));

  // Both sides human-controlled from the server's perspective; AI is driven externally
  const state = new GameState(false, false);
  state.fogOfWar = fog;

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

// ── Planning timer helpers ────────────────────────────────────────────────────

/** Start the planning countdown; auto-submit empty plan for any human who times out. */
function _startPlanningTimer(room) {
  _clearTurnTimer(room);
  if (room.state.gameOver) return;

  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.state.gameOver || !room.state.planningPhase) return;
    // Auto-submit empty plans for any human faction that hasn't submitted yet
    if (!room.state.heroReady && room.heroPlayerId !== 'ai') {
      const ws = room.heroWs;
      send(ws, { type: 'error', message: 'Planning time expired — an empty plan was submitted.' });
      _submitFactionPlan(room, 'hero', []);
    }
    if (!room.state.witchReady && room.witchPlayerId !== 'ai') {
      const ws = room.witchWs;
      send(ws, { type: 'error', message: 'Planning time expired — an empty plan was submitted.' });
      _submitFactionPlan(room, 'witch', []);
    }
  }, TURN_TIMEOUT_MS);
}

function _clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

// ── Simultaneous planning helpers ─────────────────────────────────────────────

/** Begin a new planning phase: reset plans, compute budgets, broadcast, kick AI. */
function _startPlanningPhase(room) {
  if (room.state.gameOver) return;
  room.state.startPlanning();
  broadcastState(room, 'planningPhase');
  broadcast(room, {
    type:             'planningPhase',
    heroActionsLeft:  room.state.heroActionsLeft,
    witchActionsLeft: room.state.witchActionsLeft,
    timeoutMs:        TURN_TIMEOUT_MS,
  });
  _startPlanningTimer(room);
  _runAIPlanSubmission(room);
}

/** Generate and submit AI plans immediately (synchronous). */
function _runAIPlanSubmission(room) {
  if (room.state.gameOver) return;
  if (room.witchAI) {
    const plan = room.witchAI.generatePlan();
    _submitFactionPlan(room, 'witch', plan);
  }
  if (room.heroAI && !room.state.gameOver) {
    const plan = room.heroAI.generatePlan();
    _submitFactionPlan(room, 'hero', plan);
  }
}

/** Submit one faction's plan. When both are ready, trigger resolution. */
function _submitFactionPlan(room, faction, plan) {
  if (!room.state.planningPhase) return;
  let bothReady;
  try {
    bothReady = room.state.submitPlan(faction, plan);
  } catch (err) {
    console.error(`[room ${room.id}] submitPlan error:`, err);
    return;
  }

  // Notify the other side that this faction has locked in their plan
  const otherWs = faction === 'hero' ? room.witchWs : room.heroWs;
  send(otherWs, { type: 'opponentReady' });

  if (bothReady) {
    _executeResolution(room);
  }
}

/** Run the resolver, advance state, and broadcast the full resolution to clients. */
function _executeResolution(room) {
  _clearTurnTimer(room);
  const state = room.state;
  let steps;
  try {
    steps = resolvePlans(state, state.heroPlan, state.witchPlan);
  } catch (err) {
    console.error(`[room ${room.id}] resolvePlans error:`, err);
    steps = [];
  }

  state.endRound();
  checkAndHandleGameOver(room);

  // Serialize the final state (post-endRound)
  const finalState = serializeState(state);

  // Serialize steps — convert any entity objects to plain data
  const serializedSteps = steps.map(step => ({
    stepIndex:      step.stepIndex,
    heroEvents:     _serializeEvents(step.heroEvents),
    witchEvents:    _serializeEvents(step.witchEvents),
    entitySnapshot: step.entitySnapshot ?? [],   // pre-step entity state for client animation
  }));

  broadcast(room, { type: 'resolutionComplete', steps: serializedSteps, finalState });

  if (!state.gameOver) {
    // Give clients enough time to finish animating the resolution before starting the
    // next planning phase.  The client buffers the planningPhase message anyway, but
    // a longer delay avoids unnecessary buffering for short plans.
    setTimeout(() => _startPlanningPhase(room), 4000);
  }
}

function _serializeEvents(events) {
  return events.map(ev => {
    const out = {
      type:    ev.type,
      faction: ev.faction,
      action:  ev.action,
      reason:  ev.reason ?? null,
    };
    if (ev.result) {
      out.result = {
        success:      ev.result.success,
        log:          ev.result.log          ?? [],
        encounterLog: ev.result.encounterLog ?? [],
        cost:         ev.result.cost         ?? 1,
        killed:       ev.result.killed       ?? false,
        damage:       ev.result.damage       ?? 0,
        counterDmg:   ev.result.counterDmg   ?? 0,
        crush:        ev.result.crush        ?? false,
        counter:      ev.result.counter      ?? false,
        attackRoll:   ev.result.attackRoll   ?? 0,
        defenseRoll:  ev.result.defenseRoll  ?? 0,
      };
    }
    if (ev.battleSnaps) {
      out.battleSnaps = ev.battleSnaps;
    }
    return out;
  });
}

// ── AI helpers ───────────────────────────────────────────────────────────────

function attachAI(room, faction) {
  if (faction === 'witch') {
    room.witchPlayerId = 'ai';
    room.witchName     = 'The AI Witch';
    room.witchAI       = new WitchAI(room.state, () => {}, 0);
    room.state.witchIsAI = true;
  } else {
    room.heroPlayerId = 'ai';
    room.heroName     = 'The AI Hero';
    room.heroAI       = new HeroAI(room.state, () => {}, 0);
    room.state.heroIsAI = true;
  }
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcastState(room, reason = 'update') {
  const snap = serializeState(room.state);
  broadcast(room, { type: 'stateUpdate', reason, state: snap });
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

  // Use fog setting from whichever player joined the queue first (host decides)
  const fog = hero.fog ?? witch.fog ?? true;
  const room = createRoom(
    hero.playerId,  hero.ws,  hero.playerName,
    witch.playerId, witch.ws, witch.playerName,
    fog,
  );

  send(hero.ws,  { type: 'matchFound', roomId: room.id, faction: 'hero',  opponentName: witch.playerName, aiOpponent: false });
  send(witch.ws, { type: 'matchFound', roomId: room.id, faction: 'witch', opponentName: hero.playerName,  aiOpponent: false });

  broadcastState(room, 'start');
  _startPlanningPhase(room);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Player joins the matchmaking queue. Returns a cleanup fn. */
export function joinQueue(playerId, playerName, ws, fog = true) {
  // Remove any existing queue entry for this player
  leaveQueue(playerId);

  const entry = { playerId, playerName, ws, joinedAt: Date.now(), fog };
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
      room = createRoom(playerId, ws, playerName, null, null, 'AI Witch', fog);
    } else {
      room = createRoom(null, null, 'AI Hero', playerId, ws, playerName, fog);
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
    _startPlanningPhase(room);

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
export function createPrivateRoom(playerId, playerName, ws, fog = true) {
  // First player becomes hero by default; second player gets witch when joining
  const room = createRoom(playerId, ws, playerName, null, null, '', fog);
  send(ws, { type: 'roomCode', code: room.code, roomId: room.id });

  // Set up AI fill-in timer (if second player never joins)
  room.aiTimer = setTimeout(() => {
    if (room.witchPlayerId !== null) return; // already joined
    room.witchPlayerId = null; // will be set to 'ai' by attachAI
    attachAI(room, 'witch');
    send(room.heroWs, { type: 'opponentJoined', opponentName: 'The AI Witch', aiOpponent: true });
    broadcastState(room, 'start');
    _startPlanningPhase(room);
  }, AI_FILL_DELAY_MS);
}

/** Immediately start a game against a server AI (no queue wait). */
export function joinAIGame(playerId, playerName, ws, fog = true) {
  const humanFaction = Math.random() < 0.5 ? 'hero' : 'witch';
  const aiFaction    = humanFaction === 'hero' ? 'witch' : 'hero';

  const room = humanFaction === 'hero'
    ? createRoom(playerId, ws, playerName, null, null, '', fog)
    : createRoom(null, null, '', playerId, ws, playerName, fog);

  attachAI(room, aiFaction);

  send(ws, {
    type:         'matchFound',
    roomId:       room.id,
    faction:      humanFaction,
    opponentName: aiFaction === 'witch' ? 'The AI Witch' : 'The AI Hero',
    aiOpponent:   true,
  });

  broadcastState(room, 'start');
  _startPlanningPhase(room);
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
  _startPlanningPhase(room);
}

/** Handle an incoming action from a player (legacy sequential mode — kept for fallback). */
export function handleAction(playerId, roomId, actionType, params) {
  // In simultaneous planning mode, individual actions are not used.
  // Clients should use submitPlan instead.
  const room = rooms.get(roomId);
  if (!room) return;
  const faction = factionFor(room, playerId);
  const ws = faction === 'hero' ? room.heroWs : room.witchWs;
  send(ws, { type: 'error', message: 'Use submitPlan — simultaneous planning is active.' });
}

/** Handle end-of-turn from a player (legacy — redirects to empty plan submit). */
export function handleEndTurn(playerId, roomId) {
  // Treat as submitting an empty plan
  handlePlanSubmit(playerId, roomId, []);
}

/** Handle a plan submission from a player. */
export function handlePlanSubmit(playerId, roomId, plan) {
  const room = rooms.get(roomId);
  if (!room) return;

  const faction = factionFor(room, playerId);
  if (!faction) return;

  const ws    = faction === 'hero' ? room.heroWs : room.witchWs;
  const state = room.state;

  if (state.gameOver) { send(ws, { type: 'error', message: 'Game is over.' }); return; }
  if (!state.planningPhase) { send(ws, { type: 'error', message: 'Not in planning phase.' }); return; }

  // Check not already submitted
  if (faction === 'hero'  && state.heroReady)  { send(ws, { type: 'error', message: 'Plan already submitted.' }); return; }
  if (faction === 'witch' && state.witchReady) { send(ws, { type: 'error', message: 'Plan already submitted.' }); return; }

  // Validate plan is an array
  if (!Array.isArray(plan)) { send(ws, { type: 'error', message: 'Invalid plan format.' }); return; }

  // Reset planning timer when a plan comes in
  _startPlanningTimer(room);

  _submitFactionPlan(room, faction, plan);
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
      // In planning phase, AI immediately submits its plan
      if (r.state.planningPhase) {
        _runAIPlanSubmission(r);
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
    name:     entity.displayName,  // displayName always non-null; .name is null for hero/witch
    title:    entity.title,
    displayName: entity.displayName,
  };
}
