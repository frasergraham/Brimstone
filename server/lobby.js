// Lobby: matchmaking queue, room lifecycle, server-side AI, action dispatch
import { randomUUID } from 'crypto';
import { GameState, Player } from '../src/game.js';
import { WitchAI, HeroAI }  from '../src/ai.js';
import { serializeState, deserializeState } from './state-sync.js';
import { recordResult }                    from './leaderboard.js';
import { resolvePlansMP }                  from './resolver.js';
import { upsertSave, deleteSave, getSave } from './saves.js';
import { VERSION }                         from '../src/version.js';

// ── Constants ────────────────────────────────────────────────────────────────
const AI_FILL_DELAY_MS   = 5_000;  // wait this long before filling with AI
const RECONNECT_GRACE_MS = 60_000; // time to reconnect before forfeit
const AI_TAKEOVER_MS     = 12_000; // replace disconnected player with AI after 12s
const TURN_TIMEOUT_MS    = 90_000; // auto-submit empty plan after 90s of inactivity

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, Room>} */
const rooms = new Map();

/** @type {{ playerId: string, ws: import('ws').WebSocket, playerName: string, joinedAt: number, fog: boolean }[]} */
const queue = [];

/** 6-char uppercase code → roomId */
const codeToRoom = new Map();

// ── Types ─────────────────────────────────────────────────────────────────────

/**
 * One seat in a room — either a human player or a server AI.
 *
 * @typedef {{
 *   playerId: string,                       // UUID or 'ai'
 *   ws:       import('ws').WebSocket|null,  // null for AI seats
 *   name:     string,
 *   faction:  'hero'|'witch',
 *   isAI:     boolean,
 *   ai:       import('../src/ai.js').WitchAI|import('../src/ai.js').HeroAI|null,
 * }} Seat
 */

/**
 * @typedef {{
 *   id:               string,
 *   code:             string,
 *   state:            import('../src/game.js').GameState,
 *   players:          Seat[],
 *   aiTimer:          ReturnType<typeof setTimeout>|null,
 *   turnTimer:        ReturnType<typeof setTimeout>|null,
 *   disconnectTimers: Map<string, ReturnType<typeof setTimeout>>,
 *   takeoverTimers:   Map<string, ReturnType<typeof setTimeout>>,
 * }} Room
 */

// ── Helpers ──────────────────────────────────────────────────────────────────

function send(ws, obj) {
  if (ws?.readyState === 1 /* OPEN */) ws.send(JSON.stringify(obj));
}

/** Send to every player in the room. */
function broadcast(room, obj) {
  for (const seat of room.players) send(seat.ws, obj);
}

/** Send to every player except the one with the given playerId. */
function broadcastExcept(room, playerId, obj) {
  for (const seat of room.players) {
    if (seat.playerId !== playerId) send(seat.ws, obj);
  }
}

function randomCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 6; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

/** Find the seat object for a given playerId; null if not in this room. */
function seatFor(room, playerId) {
  return room.players.find(s => s.playerId === playerId) ?? null;
}

function factionFor(room, playerId) {
  return seatFor(room, playerId)?.faction ?? null;
}

function wsFor(room, playerId) {
  return seatFor(room, playerId)?.ws ?? null;
}

// ── Room ─────────────────────────────────────────────────────────────────────

/** Create an empty room shell. Players are added via _addSeat(). */
function createRoom(fog = true) {
  const id    = randomUUID();
  let   code;
  do { code = randomCode(); } while (codeToRoom.has(code));

  const state = new GameState(false, false);
  state.fogOfWar = fog;

  /** @type {Room} */
  const room = {
    id, code, state,
    players:          [],
    aiTimer:          null,
    turnTimer:        null,
    disconnectTimers: new Map(),
    takeoverTimers:   new Map(),
  };

  rooms.set(id, room);
  codeToRoom.set(code, id);
  return room;
}

/**
 * Register a player seat in the room and wire up the corresponding state.players entry.
 *
 * For a freshly-created room, the GameState constructor pre-populated two synthetic
 * player records (id='hero', id='witch') and their leader entities.  We patch those
 * records to use the real player IDs so ownerId resolution works throughout the engine.
 */
function _addSeat(room, playerId, ws, name, faction, isAI, ai = null) {
  const seat = { playerId, ws, name, faction, isAI, ai };
  room.players.push(seat);

  // Patch the matching synthetic player record in state.players and the leader entity.
  const syntheticId = faction; // constructor uses 'hero' or 'witch' as synthetic ID
  const statePlayer = room.state.players.find(p => p.id === syntheticId);
  if (statePlayer) {
    statePlayer.id   = playerId;
    statePlayer.name = name;
    statePlayer.isAI = isAI;
    // Update the leader entity's ownerId to match the real player ID
    const leader = room.state.entities.find(e => e.id === statePlayer.leaderId);
    if (leader) leader.ownerId = playerId;
  }
}

function destroyRoom(room) {
  if (room.aiTimer)   clearTimeout(room.aiTimer);
  if (room.turnTimer) clearTimeout(room.turnTimer);
  for (const t of room.disconnectTimers.values()) clearTimeout(t);
  for (const t of room.takeoverTimers.values())   clearTimeout(t);
  rooms.delete(room.id);
  codeToRoom.delete(room.code);
}

// ── Planning timer ────────────────────────────────────────────────────────────

function _startPlanningTimer(room) {
  _clearTurnTimer(room);
  if (room.state.gameOver) return;

  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.state.gameOver || !room.state.planningPhase) return;
    // Auto-submit empty plans for any human who hasn't submitted yet
    for (const seat of room.players) {
      if (!seat.isAI && !room.state.playerReady.get(seat.playerId)) {
        send(seat.ws, { type: 'error', message: 'Planning time expired — an empty plan was submitted.' });
        _submitPlayerPlan(room, seat.playerId, []);
      }
    }
  }, TURN_TIMEOUT_MS);
}

function _clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

// ── Simultaneous planning helpers ─────────────────────────────────────────────

/** Begin a new planning phase: reset plans, compute per-player budgets, broadcast, kick AI. */
function _startPlanningPhase(room) {
  if (room.state.gameOver) return;
  room.state.startPlanning();

  // Build the submission-status array for clients: who is in the game and their faction
  const playerList = room.players.map(s => ({
    playerId: s.playerId,
    name:     s.name,
    faction:  s.faction,
    isAI:     s.isAI,
  }));

  broadcastState(room, 'planningPhase');

  // Send planning-phase message to each player individually so each gets their own budget
  for (const seat of room.players) {
    send(seat.ws, {
      type:          'planningPhase',
      myActionsLeft: room.state.playerActionsLeft.get(seat.playerId) ?? 0,
      // Legacy fields kept for clients that haven't been updated yet
      heroActionsLeft:  room.state.heroActionsLeft,
      witchActionsLeft: room.state.witchActionsLeft,
      timeoutMs:     TURN_TIMEOUT_MS,
      players:       playerList,
    });
  }

  _startPlanningTimer(room);
  _runAIPlanSubmission(room);
}

/** Generate and submit plans for every AI seat immediately. */
function _runAIPlanSubmission(room) {
  if (room.state.gameOver) return;
  for (const seat of room.players) {
    if (!seat.isAI || !seat.ai) continue;
    if (room.state.gameOver) break;
    const plan = seat.ai.generatePlan();
    _submitPlayerPlan(room, seat.playerId, plan);
  }
}

/**
 * Submit one player's plan.
 * Broadcasts a playerSubmitted notification to everyone else.
 * Triggers resolution once all players are ready.
 */
function _submitPlayerPlan(room, playerId, plan) {
  if (!room.state.planningPhase) return;

  let allReady;
  try {
    allReady = room.state.submitPlayerPlan(playerId, plan);
  } catch (err) {
    console.error(`[room ${room.id}] submitPlayerPlan error (${playerId}):`, err);
    return;
  }

  // Notify all other players that this player has locked in
  broadcastExcept(room, playerId, {
    type:     'playerSubmitted',
    playerId,
    name:     seatFor(room, playerId)?.name ?? playerId,
    faction:  factionFor(room, playerId),
  });

  if (allReady) {
    _executeResolution(room);
  }
}

/** Run the N-player resolver, advance state, and broadcast the result. */
function _executeResolution(room) {
  _clearTurnTimer(room);
  const state = room.state;

  // Build the playerEntries array for resolvePlansMP
  const playerEntries = [];
  for (const [playerId, plan] of state.playerPlans) {
    const seat = seatFor(room, playerId);
    playerEntries.push({
      playerId,
      faction: seat?.faction ?? factionFor(room, playerId) ?? 'hero',
      plan,
    });
  }

  let steps;
  try {
    steps = resolvePlansMP(state, playerEntries);
  } catch (err) {
    console.error(`[room ${room.id}] resolvePlansMP error:`, err);
    steps = [];
  }

  state.endRound();
  checkAndHandleGameOver(room);

  const finalState = serializeState(state);

  // Persist after every round for crash-recovery reconnect
  if (!state.gameOver) {
    try {
      // Extract the first human hero/witch player IDs for the DB columns
      const firstHero  = room.players.find(s => s.faction === 'hero'  && !s.isAI);
      const firstWitch = room.players.find(s => s.faction === 'witch' && !s.isAI);
      const heroName   = room.players.find(s => s.faction === 'hero')?.name  ?? '';
      const witchName  = room.players.find(s => s.faction === 'witch')?.name ?? '';
      upsertSave(
        room.id,
        firstHero?.playerId  ?? null,
        firstWitch?.playerId ?? null,
        heroName,
        witchName,
        finalState,
      );
    } catch (err) {
      console.error(`[room ${room.id}] upsertSave error:`, err);
    }
  }

  // Serialize steps for the wire — playerEvents instead of heroEvents/witchEvents
  const serializedSteps = steps.map(step => ({
    stepIndex:      step.stepIndex,
    playerEvents:   step.playerEvents.map(pe => ({
      playerId: pe.playerId,
      faction:  pe.faction,
      events:   _serializeEvents(pe.events),
    })),
    entitySnapshot: step.entitySnapshot ?? [],
  }));

  broadcast(room, { type: 'resolutionComplete', steps: serializedSteps, finalState });

  if (!state.gameOver) {
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

// ── AI helpers ────────────────────────────────────────────────────────────────

function _makeAI(room, faction) {
  return faction === 'witch'
    ? new WitchAI(room.state, () => {}, 0)
    : new HeroAI(room.state, () => {}, 0);
}

/**
 * Attach a server AI to an existing faction slot.
 * Replaces the human player's seat entry with an AI seat.
 */
function attachAI(room, faction, forPlayerId = null) {
  const syntheticPlayerId = `ai-${faction}-${randomUUID().slice(0, 8)}`;
  const ai = _makeAI(room, faction);

  if (forPlayerId) {
    // Take over an existing human seat
    const seat = seatFor(room, forPlayerId);
    if (seat) {
      seat.playerId = syntheticPlayerId;
      seat.ws       = null;
      seat.isAI     = true;
      seat.ai       = ai;
      seat.name     = faction === 'witch' ? 'The AI Witch' : 'The AI Hero';
      // Patch state.players too
      const sp = room.state.players.find(p => p.id === forPlayerId);
      if (sp) {
        sp.id   = syntheticPlayerId;
        sp.name = seat.name;
        sp.isAI = true;
        const leader = room.state.entities.find(e => e.id === sp.leaderId);
        if (leader) leader.ownerId = syntheticPlayerId;
      }
      return seat;
    }
  }

  // Add a fresh AI seat (used when filling an empty slot)
  const name = faction === 'witch' ? 'The AI Witch' : 'The AI Hero';
  _addSeat(room, syntheticPlayerId, null, name, faction, true, ai);

  // Also update AI flags on the state so fog-of-war works
  if (faction === 'witch') room.state.witchIsAI = true;
  else                     room.state.heroIsAI  = true;

  return seatFor(room, syntheticPlayerId);
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
    if (playerId && playerId !== 'ai' && !playerId.startsWith('ai-')) {
      recordResult(playerId, outcome);
    }
  };

  for (const seat of room.players) {
    const outcome = seat.faction === winner ? 'win' : (winner ? 'loss' : 'draw');
    record(seat.playerId, outcome);
  }

  try { deleteSave(room.id); } catch (err) { console.error(`[room ${room.id}] deleteSave error:`, err); }
  setTimeout(() => destroyRoom(room), 5_000);
}

// ── Matchmaking ───────────────────────────────────────────────────────────────

function tryMatch() {
  if (queue.length < 2) return;

  const a = queue.shift();
  const b = queue.shift();

  // Randomly assign factions
  const [heroEntry, witchEntry] = Math.random() < 0.5 ? [a, b] : [b, a];
  const fog = heroEntry.fog ?? witchEntry.fog ?? true;

  const room = createRoom(fog);
  _addSeat(room, heroEntry.playerId,  heroEntry.ws,  heroEntry.playerName,  'hero',  false);
  _addSeat(room, witchEntry.playerId, witchEntry.ws, witchEntry.playerName, 'witch', false);

  // matchFound includes the full player roster so clients know who they're playing with
  const playerList = room.players.map(s => ({
    playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI,
  }));
  send(heroEntry.ws,  { type: 'matchFound', roomId: room.id, faction: 'hero',  myPlayerId: heroEntry.playerId,  players: playerList, aiOpponent: false });
  send(witchEntry.ws, { type: 'matchFound', roomId: room.id, faction: 'witch', myPlayerId: witchEntry.playerId, players: playerList, aiOpponent: false });

  broadcastState(room, 'start');
  _startPlanningPhase(room);
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Player joins the matchmaking queue. Returns a cleanup fn. */
export function joinQueue(playerId, playerName, ws, fog = true) {
  leaveQueue(playerId);

  const entry = { playerId, playerName, ws, joinedAt: Date.now(), fog };
  queue.push(entry);
  send(ws, { type: 'inQueue', position: queue.length });
  tryMatch();

  // AI fill-in after delay if still waiting
  const fillTimer = setTimeout(() => {
    const idx = queue.findIndex(e => e.playerId === playerId);
    if (idx === -1) return; // already matched
    queue.splice(idx, 1);

    const humanFaction = Math.random() < 0.5 ? 'hero' : 'witch';
    const aiFaction    = humanFaction === 'hero' ? 'witch' : 'hero';

    const room = createRoom(fog);
    _addSeat(room, playerId, ws, playerName, humanFaction, false);
    const aiSeat = attachAI(room, aiFaction);

    const playerList = room.players.map(s => ({ playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI }));
    send(ws, {
      type:         'matchFound',
      roomId:       room.id,
      faction:      humanFaction,
      myPlayerId:   playerId,
      players:      playerList,
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

/** Create a private room and return the join code. First player becomes hero. */
export function createPrivateRoom(playerId, playerName, ws, fog = true) {
  const room = createRoom(fog);
  _addSeat(room, playerId, ws, playerName, 'hero', false);
  send(ws, { type: 'roomCode', code: room.code, roomId: room.id });

  // AI fill-in if second player never arrives
  room.aiTimer = setTimeout(() => {
    if (room.players.some(s => s.faction === 'witch')) return; // already filled
    const aiSeat = attachAI(room, 'witch');
    const playerList = room.players.map(s => ({ playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI }));
    send(ws, { type: 'opponentJoined', opponentName: aiSeat.name, aiOpponent: true, players: playerList });
    broadcastState(room, 'start');
    _startPlanningPhase(room);
  }, AI_FILL_DELAY_MS);
}

/** Immediately start a solo game against a server AI (no queue wait). */
export function joinAIGame(playerId, playerName, ws, fog = true) {
  const humanFaction = Math.random() < 0.5 ? 'hero' : 'witch';
  const aiFaction    = humanFaction === 'hero' ? 'witch' : 'hero';

  const room = createRoom(fog);
  _addSeat(room, playerId, ws, playerName, humanFaction, false);
  const aiSeat = attachAI(room, aiFaction);

  const playerList = room.players.map(s => ({ playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI }));
  send(ws, {
    type:         'matchFound',
    roomId:       room.id,
    faction:      humanFaction,
    myPlayerId:   playerId,
    players:      playerList,
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

  // Room is full when the witch slot is already taken by a human or AI
  const witchFilled = room.players.some(s => s.faction === 'witch');
  if (witchFilled) { send(ws, { type: 'error', message: 'Room is already full.' }); return; }

  // Clear the AI fill timer — a real player is joining
  if (room.aiTimer) { clearTimeout(room.aiTimer); room.aiTimer = null; }

  _addSeat(room, playerId, ws, playerName, 'witch', false);

  const playerList = room.players.map(s => ({ playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI }));
  const heroSeat = room.players.find(s => s.faction === 'hero');
  send(heroSeat?.ws, { type: 'opponentJoined', opponentName: playerName, aiOpponent: false, players: playerList });
  send(ws, { type: 'matchFound', roomId: room.id, faction: 'witch', myPlayerId: playerId, players: playerList, aiOpponent: false });

  broadcastState(room, 'start');
  _startPlanningPhase(room);
}

/** Handle a plan submission from a player. */
export function handlePlanSubmit(playerId, roomId, plan) {
  const room = rooms.get(roomId);
  if (!room) return;

  const seat = seatFor(room, playerId);
  if (!seat) return;

  const state = room.state;
  if (state.gameOver) { send(seat.ws, { type: 'error', message: 'Game is over.' }); return; }
  if (!state.planningPhase) { send(seat.ws, { type: 'error', message: 'Not in planning phase.' }); return; }
  if (state.playerReady.get(playerId)) { send(seat.ws, { type: 'error', message: 'Plan already submitted.' }); return; }
  if (!Array.isArray(plan)) { send(seat.ws, { type: 'error', message: 'Invalid plan format.' }); return; }

  // Reset the planning timer each time a plan comes in
  _startPlanningTimer(room);

  _submitPlayerPlan(room, playerId, plan);
}

/** Legacy handler — kept for clients that submit via the old 'endTurn' message. */
export function handleEndTurn(playerId, roomId) {
  handlePlanSubmit(playerId, roomId, []);
}

/** Legacy handler — kept for any sequential-mode callers; redirects to plan submit. */
export function handleAction(playerId, roomId, _actionType, _params) {
  const room = rooms.get(roomId);
  if (!room) return;
  const seat = seatFor(room, playerId);
  send(seat?.ws, { type: 'error', message: 'Use submitPlan — simultaneous planning is active.' });
}

/** Handle a player disconnecting mid-game. */
export function handleDisconnect(playerId, roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  const faction = factionFor(room, playerId);
  broadcastExcept(room, playerId, { type: 'opponentDisconnected', graceMs: RECONNECT_GRACE_MS });

  // AI takeover after a short gap so the remaining player isn't stuck
  const takeoverTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r || r.state.gameOver) return;
    const seat = seatFor(r, playerId);
    if (!seat || seat.faction !== faction) return; // already replaced or reassigned

    console.log(`[room ${roomId}] ${faction} (${playerId}) disconnected — attaching AI.`);
    _clearTurnTimer(r);
    attachAI(r, faction, playerId); // replaces the seat in-place
    const aiName = faction === 'hero' ? 'The AI Hero' : 'The AI Witch';
    broadcastExcept(r, playerId, { type: 'opponentJoined', opponentName: `${aiName} (took over)`, aiOpponent: true });
    broadcastState(r, 'update');
    if (r.state.planningPhase) _runAIPlanSubmission(r);
  }, AI_TAKEOVER_MS);
  room.takeoverTimers.set(playerId, takeoverTimer);

  // Forfeit after full grace period if still not reconnected
  const forfeitTimer = setTimeout(() => {
    const room2 = rooms.get(roomId);
    if (!room2) return;
    const seat2 = seatFor(room2, playerId);
    if (!seat2 || seat2.isAI) { room2.disconnectTimers.delete(playerId); return; }

    recordResult(playerId, 'loss');
    for (const s of room2.players) {
      if (s.playerId !== playerId && !s.isAI) recordResult(s.playerId, 'win');
    }
    broadcast(room2, { type: 'opponentForfeited' });
    destroyRoom(room2);
  }, RECONNECT_GRACE_MS);

  room.disconnectTimers.set(playerId, forfeitTimer);
}

/** Handle a player reconnecting. */
export function handleReconnect(playerId, roomId, ws) {
  const room = rooms.get(roomId);
  if (!room) return false;

  const seat = seatFor(room, playerId);
  if (!seat) return false;

  // Cancel takeover and forfeit timers
  const takeover = room.takeoverTimers.get(playerId);
  if (takeover) { clearTimeout(takeover); room.takeoverTimers.delete(playerId); }
  const forfeit = room.disconnectTimers.get(playerId);
  if (forfeit)  { clearTimeout(forfeit);  room.disconnectTimers.delete(playerId); }

  // If an AI already replaced this seat, it's too late
  if (seat.isAI) {
    send(ws, { type: 'error', message: 'An AI took over your faction. The game continues without you.' });
    return false;
  }

  seat.ws = ws;
  broadcastExcept(room, playerId, { type: 'opponentReconnected' });

  send(ws, { type: 'reconnected', faction: seat.faction, myPlayerId: playerId, roomId: room.id });
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

/**
 * Resume a saved game for a reconnecting player.
 *
 * First tries to reconnect to a live in-memory room (browser-refresh case).
 * If the room is gone (server restart), reconstructs it from the DB save
 * and starts a fresh planning phase against a new AI opponent.
 */
export function resumeGame(playerId, ws, roomId) {
  // 1. Try live reconnect first.
  if (rooms.has(roomId)) {
    const rejoined = handleReconnect(playerId, roomId, ws);
    if (rejoined) return;
  }

  // 2. Load from saved state.
  const save = getSave(roomId);
  if (!save) {
    send(ws, { type: 'error', message: 'No save found for this game.' });
    return;
  }

  const isHero  = save.hero_player_id  === playerId;
  const isWitch = save.witch_player_id === playerId;
  if (!isHero && !isWitch) {
    send(ws, { type: 'error', message: 'You are not a player in this save.' });
    return;
  }

  if (save.game_version !== VERSION) {
    send(ws, { type: 'error', message: `Save is from v${save.game_version}; server is v${VERSION}. Cannot resume.` });
    return;
  }

  let state;
  try {
    state = deserializeState(save.state);
  } catch (err) {
    console.error(`[resume ${roomId}] deserializeState error:`, err);
    send(ws, { type: 'error', message: 'Failed to restore save.' });
    return;
  }

  const humanFaction = isHero ? 'hero' : 'witch';
  const aiFaction    = humanFaction === 'hero' ? 'witch' : 'hero';

  // Create a fresh room and inject the restored state
  const room   = createRoom(state.fogOfWar);
  room.state   = state;

  // Add the human player's seat, then an AI for the opponent
  const humanName = isHero  ? (save.hero_name  || 'Hero')  : (save.witch_name || 'Witch');
  _addSeat(room, playerId, ws, humanName, humanFaction, false);
  const aiSeat  = attachAI(room, aiFaction);

  deleteSave(roomId);

  const playerList = room.players.map(s => ({ playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI }));
  send(ws, {
    type:         'matchFound',
    roomId:       room.id,
    faction:      humanFaction,
    myPlayerId:   playerId,
    players:      playerList,
    aiOpponent:   true,
    resumed:      true,
  });

  broadcastState(room, 'resume');
  _startPlanningPhase(room);
}
