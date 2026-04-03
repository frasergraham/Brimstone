// Lobby: room lifecycle, server-side AI, action dispatch
import { randomUUID } from 'crypto';
import { GameState, Player } from '../src/game.js';
import { HERO_PERSONALITIES, WITCH_PERSONALITIES } from '../src/ai.js';
import { WitchAIEngine } from '../src/ai-engine.js';
import { HeroAIEngine } from '../src/hero-ai-engine.js';
import { serializeState, deserializeState } from './state-sync.js';
import { recordResult }                    from './leaderboard.js';
import { recordGameStats }                 from './game-stats.js';
import { resolvePlansMP, ResEventType }    from './resolver.js';
import { compileTurnBattleSummary }        from '../src/battle-utils.js';
import { PlanActionType }                  from '../src/planner.js';
import { upsertSave, deleteSave, getSave,
         createCompletedGame, appendSaveRound,
         getSaveRounds, getLastSaveRound,
         insertPlanStatusRows, upsertPlanStatus,
         getPlanStatus, clearPlanStatus,
         clearAllPlanStatus, getExpiredDeadlineGames,
         getApproachingDeadlineGames,
         getActiveGamesForPlayer }                      from './saves.js';
import { insertAsyncGame, getAsyncGame, getAsyncGameByCode,
         getAsyncGamesForPlayer, activateAsyncGame,
         updateAsyncGameState, finishAsyncGame,
         insertPlanStatus as insertAsyncPlanStatus,
         submitPlan as submitAsyncPlan,
         getPlanStatus as getAsyncPlanStatus,
         allPlansSubmitted as asyncAllPlansSubmitted,
         getExpiredGames, pruneStaleAsyncGames as _pruneAsyncGames,
         deleteAsyncGame }                       from './async-game.js';
import { notifyWaitingOnYou, notifyRoundReady,
         notifyDeadlineApproaching, notifyGameOver,
         notifyGameAbandoned, sendGameInvite,
         shouldNotify }                          from './notifications.js';
import db                                  from './db.js';
import { VERSION }                         from '../src/version.js';
import { generateMultipleStarts }          from '../src/map.js';
import { HERO_PLAYER_COLORS, WITCH_PLAYER_COLORS } from '../src/entities.js';
import { pickAIName }                              from '../src/ai-names.js';

// ── Constants ────────────────────────────────────────────────────────────────
const RECONNECT_GRACE_MS = 60_000; // time to reconnect before forfeit
const TURN_TIMEOUT_MS    = 90_000; // auto-submit empty plan after 90s of inactivity
const CHRONICLE_MAX      = 100;    // max rounds retained per room in the chronicle

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, Room>} */
const rooms = new Map();

/** 6-char uppercase code → roomId */
const codeToRoom = new Map();

// ── Personality helpers ───────────────────────────────────────────────────────

const PERSONALITY_LABELS = {
  balanced:   'Balanced',
  aggressive: 'Aggressive',
  defensive:  'Defensive',
  explorer:   'Explorer',
  hoarder:    'Hoarder',
  swarm:      'Swarm',
};

function _randomPersonality(_faction) {
  // Non-balanced personalities are temporarily disabled pending tuning.
  return 'balanced';
}

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
 *   ai:       import('../src/ai-engine.js').WitchAIEngine|import('../src/ai.js').HeroAI|null,
 * }} Seat
 */

/**
 * @typedef {{ faction:'hero'|'witch', seatIndex:number, status:'empty'|'human'|'ai',
 *             playerId:string|null, name:string|null, personality:string|null }} SlotDescriptor
 */

/**
 * @typedef {{
 *   id:               string,
 *   code:             string,
 *   status:           'lobby'|'playing',
 *   isPrivate:        boolean,
 *   hostPlayerId:     string|null,
 *   config:           { fog:boolean, mapSize:string, playersPerSide:number },
 *   slots:            SlotDescriptor[],
 *   state:            import('../src/game.js').GameState|null,
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

/** Send a message to every admin spectator watching this room. */
function broadcastToSpectators(room, obj) {
  for (const ws of room.spectators) send(ws, obj);
}

/** Build notification options for a unified room. */
function _notifyOpts(room) {
  return {
    isAsync: room.config.isAsync ?? false,
    isConnected: (playerId) => {
      const seat = seatFor(room, playerId);
      // Treat backgrounded/inactive players as not connected for notifications
      return seat?.ws?.readyState === 1 && !seat.ws._inactive;
    },
  };
}

/** Build the player list with connection/active status for client display. */
function _buildPlayerList(room) {
  return room.players.map(s => ({
    playerId:  s.playerId,
    name:      s.name,
    faction:   s.faction,
    isAI:      s.isAI,
    connected: s.isAI || (s.ws?.readyState === 1),
    active:    s.isAI || (s.ws?.readyState === 1 && !s.ws._inactive),
  }));
}

/** Broadcast updated player presence to all connected clients in a room. */
function _broadcastPresence(room) {
  const players = _buildPlayerList(room);
  broadcast(room, { type: 'playerPresence', players });
  broadcastToSpectators(room, { type: 'playerPresence', players });
}

/** Broadcast presence update for a specific player's room. */
export function broadcastPresenceForPlayer(playerId) {
  for (const room of rooms.values()) {
    if (room.players.some(s => s.playerId === playerId)) {
      _broadcastPresence(room);
      return;
    }
  }
}

/** Append a chronicle entry and trim to CHRONICLE_MAX. */
function _appendChronicle(room, entry) {
  room.chronicle.push(entry);
  if (room.chronicle.length > CHRONICLE_MAX) room.chronicle.shift();
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

/**
 * Create an empty room shell in lobby state.
 * GameState is deferred — created when the host calls startGame().
 * @param {object} [config]
 * @param {string} [config.fog]  'none' | 'partial' | 'full'
 * @param {string}  [config.mapSize]
 * @param {number}  [config.playersPerSide]
 */
function createRoom(config = {}) {
  const id   = randomUUID();
  let   code;
  do { code = randomCode(); } while (codeToRoom.has(code));

  /** @type {Room} */
  const room = {
    id,
    code,
    status:           'lobby',
    isPrivate:        false,
    hostPlayerId:     null,
    config: {
      fog:              config.fog ?? 'partial',
      mapSize:          config.mapSize ?? 'standard',
      nodeCount:        config.nodeCount ?? null,
      playersPerSide:   Math.max(1, Math.min(4, (config.playersPerSide | 0) || 1)),
      turnIntervalMs:   Math.max(30_000, Math.min(259_200_000, Number(config.turnIntervalMs) || TURN_TIMEOUT_MS)),
      isAsync:          !!config.isAsync,
    },
    consecutiveTimeouts: {},  // playerId → consecutive empty-plan timeout count
    slots:            [],
    state:            null,
    players:          [],
    turnTimer:        null,
    disconnectTimers: new Map(),
    takeoverTimers:   new Map(),
    spectators:       new Set(),
    chronicle:        [],
    replayRounds:     [],   // { roundNum, preStateJson, stepsJson }[]
    usedAINames:      new Set(),
    createdAt:        Date.now(),
  };

  rooms.set(id, room);
  codeToRoom.set(code, id);
  return room;
}

/** Build an ordered slot array for the given players-per-side count. */
function _buildSlots(playersPerSide) {
  const pps   = Math.max(1, Math.min(4, playersPerSide | 0));
  const slots = [];
  for (let i = 0; i < pps; i++) {
    slots.push({ faction: 'hero', seatIndex: i, status: 'empty', playerId: null, name: null, personality: null });
  }
  for (let i = 0; i < pps; i++) {
    slots.push({ faction: 'witch', seatIndex: i, status: 'empty', playerId: null, name: null, personality: null });
  }
  return slots;
}

/** Serialise a lobby room for wire transmission (no ws refs). */
function _lobbyPublic(room) {
  return {
    id:               room.id,
    code:             room.isPrivate ? room.code : null,
    isPrivate:        room.isPrivate,
    hostPlayerId:     room.hostPlayerId,
    config:           { ...room.config },
    slots:            room.slots.map(s => ({ ...s })),
    createdAt:        room.createdAt,
    participantCount: room.slots.filter(s => s.status === 'human').length,
  };
}

/** Send a lobbyUpdate to every human participant in a lobby room. */
function broadcastLobbyUpdate(room) {
  const payload = { type: 'lobbyUpdate', lobby: _lobbyPublic(room) };
  for (const slot of room.slots) {
    if (slot.status === 'human' && slot._ws) {
      send(slot._ws, payload);
    }
  }
}

/**
 * Register a player seat in the room and wire up the corresponding state.players entry.
 *
 * For a freshly-created room, the GameState constructor pre-populated two synthetic
 * player records (id='hero', id='witch') and their leader entities.  We patch those
 * records to use the real player IDs so ownerId resolution works throughout the engine.
 */
function _addSeat(room, playerId, ws, name, faction, isAI, ai = null) {
  // Determine this player's color slot before pushing (0-based index in faction)
  const factionIndex = room.players.filter(s => s.faction === faction).length;
  const colors       = faction === 'hero' ? HERO_PLAYER_COLORS : WITCH_PLAYER_COLORS;
  const playerColor  = colors[factionIndex % colors.length];

  const seat = { playerId, ws, name, faction, isAI, ai };
  room.players.push(seat);

  // Patch the matching synthetic player record in state.players and the leader entity.
  const syntheticId = faction; // constructor uses 'hero' or 'witch' as synthetic ID
  const statePlayer = room.state.players.find(p => p.id === syntheticId);
  if (statePlayer) {
    statePlayer.id   = playerId;
    statePlayer.name = name;
    statePlayer.isAI = isAI;
    // Update the leader entity's ownerId and color to match the real player
    const leader = room.state.entities.find(e => e.id === statePlayer.leaderId);
    if (leader) {
      leader.ownerId = playerId;
      leader.color   = playerColor;
    }
  }
}

function destroyRoom(room) {
  if (room.turnTimer) clearTimeout(room.turnTimer);
  if (room.allHumansGoneTimer) clearTimeout(room.allHumansGoneTimer);
  for (const t of room.disconnectTimers.values()) clearTimeout(t);
  for (const t of room.takeoverTimers.values())   clearTimeout(t);
  // Notify admin spectators the room is gone
  broadcastToSpectators(room, { type: 'adminRoomEnded', roomId: room.id });
  room.spectators.clear();
  rooms.delete(room.id);
  codeToRoom.delete(room.code);
}

// ── Planning timer ────────────────────────────────────────────────────────────

function _startPlanningTimer(room) {
  _clearTurnTimer(room);
  if (room.state.gameOver) return;

  const timeoutMs = room.config.turnIntervalMs ?? TURN_TIMEOUT_MS;

  // Store the deadline in the room for background checker (hibernated rooms)
  room.turnDeadline = Math.floor(Date.now() / 1000) + Math.ceil(timeoutMs / 1000);

  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.state.gameOver || !room.state.planningPhase) return;
    _autoSubmitMissingPlans(room);
  }, timeoutMs);
}

/** Auto-submit empty plans for any seat that hasn't submitted yet. */
function _autoSubmitMissingPlans(room) {
  for (const seat of room.players) {
    if (!room.state.playerReady.get(seat.playerId)) {
      if (!seat.isAI) {
        send(seat.ws, { type: 'error', message: 'Planning time expired — an empty plan was submitted.' });
      }
      _submitPlayerPlan(room, seat.playerId, [], true); // isTimeout=true
    }
  }
}

function _clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

// ── Simultaneous planning helpers ─────────────────────────────────────────────

/** Begin a new planning phase: reset plans, compute per-player budgets, broadcast, kick AI. */
function _startPlanningPhase(room) {
  if (room.state.gameOver) return;
  room.state.updateExploredHexes();
  room.state.startPlanning();

  // Build the submission-status array for clients: who is in the game and their faction
  const playerList = _buildPlayerList(room);

  // Persist empty plan-status rows so hibernated rooms know who needs to submit
  try {
    const playerIds = room.players.map(s => s.playerId);
    insertPlanStatusRows(room.id, playerIds, room.state.round);
  } catch (err) {
    console.error(`[room ${room.id}] insertPlanStatusRows error:`, err);
  }

  broadcastState(room, 'planningPhase');

  const timeoutMs = room.config.turnIntervalMs ?? TURN_TIMEOUT_MS;

  // Send planning-phase message to each player individually so each gets their own budget
  for (const seat of room.players) {
    send(seat.ws, {
      type:          'planningPhase',
      myActionsLeft: room.state.playerActionsLeft.get(seat.playerId) ?? 0,
      // Legacy fields kept for clients that haven't been updated yet
      heroActionsLeft:  room.state.heroActionsLeft,
      witchActionsLeft: room.state.witchActionsLeft,
      timeoutMs,
      players:       playerList,
    });
  }

  _startPlanningTimer(room);
  _runAIPlanSubmission(room);

  // Let admin spectators know a new planning phase has started
  broadcastToSpectators(room, {
    type:    'adminPlanningPhase',
    roomId:  room.id,
    round:   room.state.round,
    phase:   room.state.phase,
    players: room.players.map(s => ({
      playerId:     s.playerId,
      name:         s.name,
      faction:      s.faction,
      isAI:         s.isAI,
      personality:  s.personality ?? null,
      actionsLeft:  room.state.playerActionsLeft?.get(s.playerId) ?? 0,
    })),
  });
}

/** Generate and submit plans for every AI seat, staggered by a short random delay.
 *
 * Allied AI players of the same faction share a mutable ally context so each
 * player's plan avoids duplicating the prior player's node targets and battle focus.
 * The staggered timeouts fire in a deterministic order (offset 0, 400, 800 …),
 * so context written by an earlier AI is visible to all later ones in the same faction.
 */
function _runAIPlanSubmission(room) {
  if (room.state.gameOver) return;

  // One ally context per faction — shared across all AI players of that faction.
  const heroCtx  = { claimedNodes: new Set(), allyPositions: [] };
  const witchCtx = { claimedNodes: new Set(), allyPositions: [] };

  let offset = 0;
  for (const seat of room.players) {
    if (!seat.isAI || !seat.ai) continue;
    const delay = 300 + offset + Math.floor(Math.random() * 350);
    offset += 400;
    const { playerId, faction, ai } = seat;
    const ctx = faction === 'hero' ? heroCtx : witchCtx;
    setTimeout(() => {
      if (!rooms.has(room.id)) return;
      if (room.state.gameOver || !room.state.planningPhase) return;
      let plan;
      try {
        plan = ai.generatePlan(ctx);
      } catch (err) {
        console.error(`[room ${room.id}] AI plan generation error for ${playerId}:`, err);
        plan = [];
      }
      // Update ally context so subsequent AI players (higher offsets) see this plan's choices.
      const leader = room.state.entities.find(e => e.alive && e.ownerId === playerId &&
        (e.type === 'hero' || e.type === 'witch'));
      if (leader) ctx.allyPositions.push({ col: leader.col, row: leader.row });
      _submitPlayerPlan(room, playerId, plan);
    }, delay);
  }
}

/**
 * Submit one player's plan.
 * Broadcasts a playerSubmitted notification to everyone else.
 * Triggers resolution once all players are ready.
 * @param {boolean} [isTimeout] — true when auto-submitted due to deadline expiry
 */
function _submitPlayerPlan(room, playerId, plan, isTimeout = false) {
  if (!room.state.planningPhase) return;

  let allReady;
  try {
    allReady = room.state.submitPlayerPlan(playerId, plan);
  } catch (err) {
    console.error(`[room ${room.id}] submitPlayerPlan error (${playerId}):`, err);
    return;
  }

  // Persist plan to DB for crash recovery / hibernation
  try {
    upsertPlanStatus(room.id, playerId, room.state.round, plan);
  } catch (err) {
    console.error(`[room ${room.id}] upsertPlanStatus error:`, err);
  }

  // Track consecutive timeouts for AI takeover
  const seat = seatFor(room, playerId);
  if (isTimeout && !seat?.isAI) {
    room.consecutiveTimeouts[playerId] = (room.consecutiveTimeouts[playerId] || 0) + 1;
  } else if (!isTimeout && !seat?.isAI) {
    room.consecutiveTimeouts[playerId] = 0;
  }

  // Notify all other players and spectators that this player has locked in
  const submittedMsg = {
    type:     'playerSubmitted',
    playerId,
    name:     seat?.name ?? playerId,
    faction:  factionFor(room, playerId),
  };
  broadcastExcept(room, playerId, submittedMsg);
  broadcastToSpectators(room, submittedMsg);

  // Notify the last unsubmitted human player that everyone else has submitted
  if (!isTimeout && !seat?.isAI) {
    const opts = _notifyOpts(room);
    const unsubmitted = room.players.filter(
      s => !s.isAI && s.playerId !== playerId && !room.state.playerReady?.get(s.playerId)
    );
    if (unsubmitted.length === 1) {
      notifyWaitingOnYou(unsubmitted[0].playerId, {
        roomId: room.id,
      }, opts).catch(() => {});
    }
  }

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

  // Snapshot state BEFORE resolution for full-game replay
  const preStateJson = JSON.stringify(serializeState(state));

  let steps;
  try {
    steps = resolvePlansMP(state, playerEntries);
  } catch (err) {
    console.error(`[room ${room.id}] resolvePlansMP error:`, err);
    steps = [];
  }

  // Add aggregate battle summary to log before endRound (so it serialises into finalState)
  const summaryLines = compileTurnBattleSummary(steps, state.entities, ResEventType, PlanActionType);
  for (const line of summaryLines) state.log.push(line);

  state.updateNodeDiscovery();
  state.checkAndLogNodeControlChanges();
  state.updateExploredHexes();
  state.endRound();
  checkAndHandleGameOver(room);

  const finalState = serializeState(state);

  // Clear plan status for the resolved round
  try {
    clearPlanStatus(room.id, state.round - 1);  // endRound() already incremented
  } catch (err) {
    console.error(`[room ${room.id}] clearPlanStatus error:`, err);
  }

  // Persist after every round for crash-recovery / hibernation reconnect
  if (!state.gameOver) {
    try {
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
        {
          turnIntervalMs:      room.config.turnIntervalMs,
          consecutiveTimeouts: room.consecutiveTimeouts,
          config:              room.config,
          players:             room.players.map(s => ({
            playerId: s.playerId, name: s.name, faction: s.faction,
            isAI: s.isAI, personality: s.personality ?? null,
            originalPlayerId: s.originalPlayerId ?? null,
          })),
          isPrivate: room.isPrivate,
          code:      room.code,
          status:    'playing',
        },
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

  // Store round data for full-game replay (roundNum is pre-endRound value)
  const roundEntry = {
    roundNum:    state.round - 1,  // endRound() already incremented state.round
    preStateJson,
    stepsJson:   JSON.stringify(serializedSteps),
  };
  room.replayRounds.push(roundEntry);

  // Persist the round to the DB so resumed games retain full replay history
  if (!state.gameOver) {
    try {
      appendSaveRound(room.id, roundEntry.roundNum, roundEntry.preStateJson, roundEntry.stepsJson);
    } catch (err) {
      console.error(`[room ${room.id}] appendSaveRound error:`, err);
    }
  }

  const resolutionMsg = { type: 'resolutionComplete', steps: serializedSteps, finalState };
  broadcast(room, resolutionMsg);
  broadcastToSpectators(room, resolutionMsg);

  // Append to the per-room chronicle for admin inspection
  _appendChronicle(room, {
    round:       finalState.round,
    phase:       finalState.phase,
    resolvedAt:  Date.now(),
    steps:       serializedSteps,
    entities:    finalState.entities.map(e => ({
      id: e.id, type: e.type, owner: e.owner, ownerId: e.ownerId,
      name: e.name, hp: e.hp, maxHp: e.maxHp, col: e.col, row: e.row,
      alive: (e.hp ?? 0) > 0,
    })),
    log:         finalState.log ?? [],
  });

  if (!state.gameOver) {
    // Check for consecutive timeout AI takeover before next planning phase
    _checkTimeoutTakeovers(room);
    setTimeout(() => _startPlanningPhase(room), 4000);

    // Notify disconnected human players that a new round is ready
    const opts = _notifyOpts(room);
    for (const seat of room.players) {
      if (seat.isAI) continue;
      notifyRoundReady(seat.playerId, {
        roomId: room.id, round: state.round,
      }, opts).catch(() => {});
    }
  }
}

/**
 * After resolution, check if any human player has hit 2+ consecutive timeouts.
 * If so, replace them with AI and notify all players.
 */
function _checkTimeoutTakeovers(room) {
  for (const seat of [...room.players]) {
    if (seat.isAI) continue;
    const count = room.consecutiveTimeouts[seat.playerId] || 0;
    if (count >= 2) {
      const playerName = seat.name;
      const playerId   = seat.playerId;
      console.log(`[room ${room.id}] ${playerName} (${playerId}) — ${count} consecutive timeouts — AI takeover.`);
      attachAI(room, seat.faction, playerId);
      // Broadcast takeover notification
      const takeoverMsg = { type: 'playerTakenOver', playerId, playerName };
      broadcast(room, takeoverMsg);
      broadcastToSpectators(room, takeoverMsg);
      // Reset counter
      delete room.consecutiveTimeouts[playerId];
    }
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
        success:           ev.result.success,
        log:               ev.result.log              ?? [],
        encounterLog:      ev.result.encounterLog     ?? [],
        encounterSurvivor: ev.result.encounterSurvivor ?? null,
        cost:              ev.result.cost             ?? 1,
        killed:            ev.result.killed           ?? false,
        damage:            ev.result.damage           ?? 0,
        counterDmg:        ev.result.counterDmg       ?? 0,
        crush:             ev.result.crush            ?? false,
        counter:           ev.result.counter          ?? false,
        attackRoll:        ev.result.attackRoll       ?? 0,
        defenseRoll:       ev.result.defenseRoll      ?? 0,
        hit:               ev.result.hit              ?? false,
        margin:            ev.result.margin           ?? 0,
        fortAbsorbed:      ev.result.fortAbsorbed     ?? 0,
        breakdown:         ev.result.breakdown        ?? null,
        path:              ev.result.path             ?? [],
        lootItems:         ev.result.lootItems        ?? [],
      };
    }
    if (ev.battleSnaps) {
      out.battleSnaps = ev.battleSnaps;
    }
    return out;
  });
}

// ── AI helpers ────────────────────────────────────────────────────────────────

function _makeAI(room, faction, playerId = null, personality = null) {
  const registry   = faction === 'witch' ? WITCH_PERSONALITIES : HERO_PERSONALITIES;
  const AICls      = registry[personality] ?? (faction === 'witch' ? WitchAIEngine : HeroAIEngine);
  return new AICls(room.state, () => {}, 0, playerId);
}

/**
 * Attach a server AI to an existing faction slot.
 * Replaces the human player's seat entry with an AI seat.
 * @param {string|null} personality  Key from HERO/WITCH_PERSONALITIES, or null for balanced.
 */
function attachAI(room, faction, forPlayerId = null, personality = null) {
  const syntheticPlayerId = `ai-${faction}-${randomUUID().slice(0, 8)}`;
  const ai = _makeAI(room, faction, syntheticPlayerId, personality);

  if (forPlayerId) {
    // Take over an existing human seat
    const seat = seatFor(room, forPlayerId);
    if (seat) {
      seat.originalPlayerId = forPlayerId; // track for reconnect
      seat.playerId = syntheticPlayerId;
      seat.ws       = null;
      seat.isAI     = true;
      seat.ai       = ai;
      seat.name     = pickAIName(faction, room.usedAINames);
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
  const name = pickAIName(faction, room.usedAINames);
  _addSeat(room, syntheticPlayerId, null, name, faction, true, ai);
  // Store personality on the seat for player-list broadcasts
  const newSeat = seatFor(room, syntheticPlayerId);
  if (newSeat) newSeat.personality = personality ?? 'balanced';

  // Also update AI flags on the state so fog-of-war works
  if (faction === 'witch') room.state.witchIsAI = true;
  else                     room.state.heroIsAI  = true;

  return seatFor(room, syntheticPlayerId);
}

/**
 * Add extra AI seats on a faction side beyond the first player.
 * Calls state.addPlayer() to create a new leader entity at a spawn point
 * near the faction's existing leader (no synthetic-patching needed).
 */
function _addExtraAISeat(room, faction, personality = null) {
  const pid  = `ai-${faction}-${randomUUID().slice(0, 8)}`;
  const name = pickAIName(faction, room.usedAINames);
  const ai   = _makeAI(room, faction, pid, personality); // pass pid so AI scopes plan to its own entities

  // Spawn near the faction's existing leaders, with enough separation
  const existing = room.state.entities.filter(
    e => e.alive && e.owner === faction && (e.type === 'hero' || e.type === 'witch')
  );
  const start = existing[0] ?? { col: 0, row: 0 };
  const positions = generateMultipleStarts(room.state.tiles, start, existing.length + 1, 2, 6);
  const pos = positions[existing.length] ?? start;

  room.state.addPlayer(pid, name, faction, pos.col, pos.row, true);

  // Assign per-player color to this AI's leader entity
  const factionIndex = room.players.filter(s => s.faction === faction).length;
  const colors       = faction === 'hero' ? HERO_PLAYER_COLORS : WITCH_PLAYER_COLORS;
  const leader       = room.state.entities.find(e => e.ownerId === pid);
  if (leader) leader.color = colors[factionIndex % colors.length];

  const seat = { playerId: pid, ws: null, name, faction, isAI: true, ai, personality: personality ?? 'balanced' };
  room.players.push(seat);
  if (faction === 'witch') room.state.witchIsAI = true;
  else                     room.state.heroIsAI  = true;
  return seat;
}

/**
 * Fill both factions with AI so each side reaches `perSide` players total.
 * Human players must already be seated before calling this.
 */
function _fillAISeats(room, heroPerSide, witchPerSide) {
  const heroCount  = room.players.filter(s => s.faction === 'hero').length;
  const witchCount = room.players.filter(s => s.faction === 'witch').length;
  for (let i = heroCount;  i < heroPerSide;  i++) _addExtraAISeat(room, 'hero');
  for (let i = witchCount; i < witchPerSide; i++) _addExtraAISeat(room, 'witch');
}

// ── Broadcast helpers ─────────────────────────────────────────────────────────

function broadcastState(room, reason = 'update') {
  if (!room.state) return;
  const snap = serializeState(room.state);
  broadcast(room, { type: 'stateUpdate', reason, state: snap });
  broadcastToSpectators(room, { type: 'stateUpdate', reason, state: snap });
}

function checkAndHandleGameOver(room) {
  if (!room.state.gameOver) return;

  const winner = room.state.winner;
  // Don't broadcast a stateUpdate here — the game-over state is already
  // included in the resolutionComplete finalState, which the client displays
  // after the resolution animation finishes.  Broadcasting early would show
  // the victory screen before the final turn plays out.

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

  // Record per-game stats
  try {
    const firstHero  = room.players.find(s => s.faction === 'hero'  && !s.isAI);
    const firstWitch = room.players.find(s => s.faction === 'witch' && !s.isAI);
    const heroSlot   = room.slots?.find(s => s.faction === 'hero'  && s.status === 'ai');
    const witchSlot  = room.slots?.find(s => s.faction === 'witch' && s.status === 'ai');
    recordGameStats({
      id:                randomUUID(),
      mode:              'online',
      map_size:          room.state.mapSize || 'standard',
      winner:            room.state.winner,
      win_reason:        room.state.winReason,
      rounds:            room.state.round,
      final_phase:       room.state.phase,
      hero_score:        room.state.nodeScore?.hero  || 0,
      witch_score:       room.state.nodeScore?.witch || 0,
      hero_kills:        room.state.heroKills  || 0,
      witch_kills:       room.state.witchKills || 0,
      hero_survivors:    room.state.entities.filter(e => e.owner === 'hero' && e.type === 'survivor').length,
      witch_summons:     room.state.witchSummonCount || 0,
      hero_personality:  heroSlot?.personality  || null,
      witch_personality: witchSlot?.personality || null,
      hero_player_id:    firstHero?.playerId   || null,
      witch_player_id:   firstWitch?.playerId  || null,
      game_version:      VERSION,
      fog_of_war:        room.state.fogOfWar !== 'none' ? 1 : 0,
      duration_ms:       Date.now() - room.createdAt,
    });
  } catch (err) { console.error(`[room ${room.id}] recordGameStats error:`, err); }

  try { clearAllPlanStatus(room.id); } catch {}
  try { deleteSave(room.id); } catch (err) { console.error(`[room ${room.id}] deleteSave error:`, err); }

  // Persist full-game replay
  if (room.replayRounds.length > 0) {
    try {
      const gameId    = randomUUID();
      const firstHero  = room.players.find(s => s.faction === 'hero'  && !s.isAI);
      const firstWitch = room.players.find(s => s.faction === 'witch' && !s.isAI);
      const heroName   = room.players.find(s => s.faction === 'hero')?.name  ?? '';
      const witchName  = room.players.find(s => s.faction === 'witch')?.name ?? '';
      const humanHero  = room.players.some(s => s.faction === 'hero'  && !s.isAI);
      const humanWitch = room.players.some(s => s.faction === 'witch' && !s.isAI);
      const mode = humanHero && humanWitch ? 'hvh'
                 : humanHero               ? 'hvai'
                 : humanWitch              ? 'aivh'
                 :                          'aivai';
      createCompletedGame(gameId, room.id, {
        heroPlayerId:  firstHero?.playerId  ?? null,
        witchPlayerId: firstWitch?.playerId ?? null,
        heroName,
        witchName,
        winner:      room.state.winner      ?? '',
        winReason:   room.state.winReason   ?? '',
        totalRounds: room.state.round - 1,
        gameVersion: VERSION,
        mode,
        playersJson: JSON.stringify(room.players.map(s => ({
          playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI,
        }))),
      }, room.replayRounds);
    } catch (err) {
      console.error(`[room ${room.id}] createCompletedGame error:`, err);
    }
  }

  // Notify disconnected human players that the game is over
  const opts = _notifyOpts(room);
  for (const seat of room.players) {
    if (seat.isAI) continue;
    notifyGameOver(seat.playerId, {
      roomId: room.id,
      winner: room.state.winner,
      winReason: room.state.winReason,
    }, opts).catch(() => {});
  }

  setTimeout(() => destroyRoom(room), 5_000);
}

// ── Lobby API ─────────────────────────────────────────────────────────────────

/**
 * Create a new lobby room. The host fills the first hero slot.
 */
export function createLobby(playerId, playerName, ws, config = {}) {
  const pps  = Math.max(1, Math.min(4, (config.playersPerSide | 0) || 1));
  const room = createRoom({
    fog:            config.fog ?? 'partial',
    mapSize:        config.mapSize ?? 'standard',
    nodeCount:      config.nodeCount ?? null,
    playersPerSide: pps,
    turnIntervalMs: config.turnIntervalMs,
    isAsync:        config.isAsync ?? false,
  });
  room.isPrivate    = config.isPrivate ?? false;
  room.hostPlayerId = playerId;
  room.slots        = _buildSlots(pps);

  // Host takes the first hero slot
  const heroSlot = room.slots.find(s => s.faction === 'hero');
  heroSlot.status   = 'human';
  heroSlot.playerId = playerId;
  heroSlot.name     = playerName;
  heroSlot._ws      = ws;

  send(ws, { type: 'lobbyJoined', lobby: _lobbyPublic(room) });
}

/**
 * Join an existing lobby by room ID (public) or 6-char code (private).
 */
export function joinLobby(playerId, playerName, ws, codeOrId) {
  // Look up by code first, then by direct ID
  const byCode   = codeOrId?.length === 6 ? codeToRoom.get(codeOrId.toUpperCase()) : null;
  const roomId   = byCode ?? codeOrId;
  const room     = rooms.get(roomId);

  if (!room || room.status !== 'lobby') {
    send(ws, { type: 'error', message: 'Lobby not found or already started.' });
    return;
  }

  // Prevent duplicate joins
  if (room.slots.some(s => s.playerId === playerId)) {
    send(ws, { type: 'error', message: 'You are already in this lobby.' });
    return;
  }

  // Find first empty slot (witch side preferred for 1v1 parity, then hero)
  const emptySlot =
    room.slots.find(s => s.status === 'empty' && s.faction === 'witch') ??
    room.slots.find(s => s.status === 'empty');

  if (!emptySlot) {
    send(ws, { type: 'error', message: 'Lobby is full.' });
    return;
  }

  emptySlot.status   = 'human';
  emptySlot.playerId = playerId;
  emptySlot.name     = playerName;
  emptySlot._ws      = ws;

  send(ws, { type: 'lobbyJoined', lobby: _lobbyPublic(room) });
  broadcastLobbyUpdate(room);
}

/** Return a list of public lobbies (not yet started). */
export function browseLobby() {
  return [...rooms.values()]
    .filter(r => r.status === 'lobby' && !r.isPrivate)
    .map(_lobbyPublic);
}

/** Host assigns an AI personality to an empty slot. */
export function setSlotAI(playerId, roomId, slotIndex, personality) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') { return; }
  if (room.hostPlayerId !== playerId)   { return; }

  const slot = room.slots[slotIndex];
  if (!slot || slot.status === 'human') { return; }

  const resolved = personality === 'random'
    ? _randomPersonality(slot.faction)
    : (personality ?? 'balanced');

  const aiName = pickAIName(slot.faction, room.usedAINames);

  slot.status      = 'ai';
  slot.personality = resolved;
  slot.name        = aiName;
  slot._ws         = null;

  broadcastLobbyUpdate(room);
}

/** Host removes an AI from a slot, returning it to empty. */
export function removeSlotAI(playerId, roomId, slotIndex) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') { return; }
  if (room.hostPlayerId !== playerId)   { return; }

  const slot = room.slots[slotIndex];
  if (!slot || slot.status !== 'ai')    { return; }

  // Release the AI name back to the pool
  if (slot.name && room.usedAINames) {
    room.usedAINames.delete(slot.name);
  }

  slot.status      = 'empty';
  slot.personality = null;
  slot.name        = null;

  broadcastLobbyUpdate(room);
}

/** Host fills all empty slots with AI (personality: specific key or 'random'). */
export function fillAllWithAI(playerId, roomId, personality) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') { return; }
  if (room.hostPlayerId !== playerId)   { return; }

  for (let i = 0; i < room.slots.length; i++) {
    if (room.slots[i].status === 'empty') {
      setSlotAI(playerId, roomId, i, personality ?? 'random');
    }
  }
  // broadcastLobbyUpdate is called by each setSlotAI — fire one final authoritative update
  broadcastLobbyUpdate(room);
}

/** Host starts the game. Initializes GameState and begins planning phase. */
export function startGame(playerId, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') { return; }
  if (room.hostPlayerId !== playerId)   { return; }

  // All slots must be filled
  if (room.slots.some(s => s.status === 'empty')) {
    const hostSlot = room.slots.find(s => s.playerId === playerId);
    send(hostSlot?._ws, { type: 'error', message: 'Fill all slots before starting.' });
    return;
  }

  // Determine AI flags for GameState constructor
  const anyWitchAI = room.slots.some(s => s.faction === 'witch' && s.status === 'ai');
  const anyHeroAI  = room.slots.some(s => s.faction === 'hero'  && s.status === 'ai');

  // Initialize GameState
  const state      = new GameState(anyWitchAI, anyHeroAI, room.config.mapSize, room.config.nodeCount);
  state.fogOfWar   = room.config.fog;
  room.state       = state;
  room.status      = 'playing';

  // Add seats in slot order — first hero slot patches the synthetic ID, extras use addPlayer
  let heroCount  = 0;
  let witchCount = 0;
  for (const slot of room.slots) {
    if (slot.status === 'human') {
      if ((slot.faction === 'hero' && heroCount === 0) ||
          (slot.faction === 'witch' && witchCount === 0)) {
        _addSeat(room, slot.playerId, slot._ws, slot.name, slot.faction, false);
      } else {
        // Extra human seat — for now treat as AI-ally until human join is fully wired
        _addExtraAISeat(room, slot.faction, slot.personality ?? 'balanced');
      }
    } else {
      // AI slot
      if ((slot.faction === 'hero' && heroCount === 0) ||
          (slot.faction === 'witch' && witchCount === 0)) {
        attachAI(room, slot.faction, null, slot.personality);
      } else {
        _addExtraAISeat(room, slot.faction, slot.personality);
      }
    }
    if (slot.faction === 'hero')  heroCount++;
    else                          witchCount++;
  }

  // Send matchFound to every human player
  const playerList = _buildPlayerList(room);
  const aiOpponent = room.slots.some(s => s.status === 'ai');
  for (const slot of room.slots) {
    if (slot.status === 'human' && slot._ws) {
      send(slot._ws, {
        type:       'matchFound',
        roomId:     room.id,
        faction:    slot.faction,
        myPlayerId: slot.playerId,
        players:    playerList,
        aiOpponent,
      });
    }
  }

  broadcastState(room, 'start');
  _startPlanningPhase(room);
}

/** Player leaves a lobby before the game starts. */
export function leaveLobby(playerId, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') { return; }

  if (room.hostPlayerId === playerId) {
    // Host left — notify everyone and destroy the room
    for (const slot of room.slots) {
      if (slot.status === 'human' && slot._ws && slot.playerId !== playerId) {
        send(slot._ws, { type: 'error', message: 'The host left the lobby.' });
      }
    }
    destroyRoom(room);
    return;
  }

  // Non-host — reset their slot to empty
  const slot = room.slots.find(s => s.playerId === playerId);
  if (slot) {
    slot.status   = 'empty';
    slot.playerId = null;
    slot.name     = null;
    slot._ws      = null;
    broadcastLobbyUpdate(room);
  }
}

/**
 * Resign from an active game. The resigning player loses; opponents win.
 * Works for both in-memory and hibernated games.
 */
export function resignGame(playerId, roomId, ws) {
  // Try in-memory room first
  let room = rooms.get(roomId);
  if (!room) {
    // Try recovering from DB
    room = _recoverRoom(roomId);
  }
  if (!room || !room.state) {
    send(ws, { type: 'error', message: 'Game not found.' });
    return;
  }
  if (room.state.gameOver) {
    send(ws, { type: 'error', message: 'Game is already over.' });
    return;
  }

  const seat = room.players.find(
    s => s.playerId === playerId || s.originalPlayerId === playerId
  );
  if (!seat) {
    send(ws, { type: 'error', message: 'You are not in this game.' });
    return;
  }

  const playerName = seat.name ?? 'A player';
  const faction    = seat.faction;

  // Check if there are other humans on the same side
  const otherHumansOnSide = room.players.filter(
    s => s.faction === faction && !s.isAI && s.playerId !== playerId
  );

  if (otherHumansOnSide.length > 0) {
    // Teammates remain — replace resigning player with AI
    attachAI(room, faction, playerId);

    const msg = { type: 'playerResigned', playerId, playerName };
    broadcast(room, msg);
    broadcastToSpectators(room, msg);

    // If we're in planning and the now-AI seat hasn't submitted, auto-generate a plan
    if (room.state.planningPhase && !room.state.resolving) {
      _runAIPlanSubmission(room);
    }

    // Update the save
    broadcastState(room, 'resign-replaced');
    send(ws, { type: 'resigned', roomId, replaced: true });
    return;
  }

  // Last human on their side (or 1v1) — the other faction wins
  const winnerFaction = faction === 'hero' ? 'witch' : 'hero';
  room.state.winner    = winnerFaction;
  room.state.winReason = `${playerName} resigned.`;

  // Stop timers
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }

  // Notify connected players
  broadcastState(room, 'resign');

  // Run full game-over cleanup (stats, replay, notifications, room cleanup)
  checkAndHandleGameOver(room);

  // Confirm to the resigning player
  send(ws, { type: 'resigned', roomId });
}

/**
 * Send an email invite for a specific lobby slot. Host-only.
 */
export function sendSlotInvite(player, roomId, slotIndex, email) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') return;
  if (room.hostPlayerId !== player.id) return;
  if (!email || typeof email !== 'string') return;

  const joinKey = room.isPrivate ? room.code : room.id;
  sendGameInvite(email.trim().toLowerCase(), {
    roomId: room.id,
    code: joinKey,
    hostName: player.username ?? 'A player',
  }).catch(() => {});
}

/** Handle a plan submission from a player. */
export function handlePlanSubmit(playerId, roomId, plan) {
  const room = rooms.get(roomId);
  if (!room || !room.state) return;

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

  // Notify remaining players that the deadline has been extended
  if (room.state.planningPhase) {
    const timeoutMs = room.config.turnIntervalMs ?? TURN_TIMEOUT_MS;
    for (const seat of room.players) {
      if (!room.state.playerReady.get(seat.playerId)) {
        send(seat.ws, { type: 'timerReset', timeoutMs });
      }
    }
  }
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

  // If still in lobby, just leave it
  if (room.status === 'lobby') {
    leaveLobby(playerId, roomId);
    return;
  }

  broadcastExcept(room, playerId, { type: 'opponentDisconnected' });

  // No immediate AI takeover on disconnect — AI only takes over after
  // 2 consecutive missed turn deadlines (_checkTimeoutTakeovers).
  // If all humans are gone, hibernate the room to DB.
  _checkAllHumansGone(room);
}

/**
 * If no human players remain connected in the room, start a timer to
 * hibernate the room (evict from memory, keep in DB for reconnect).
 * Short-timeout games (< 1 hour) get the legacy 60s destruction timer.
 * Long-timeout games hibernate immediately so the DB deadline checker handles them.
 */
function _checkAllHumansGone(room) {
  const hasHuman = room.players.some(s => !s.isAI);
  if (hasHuman) return;
  if (room.allHumansGoneTimer) return; // already ticking

  const isLongTimeout = (room.config.turnIntervalMs ?? TURN_TIMEOUT_MS) >= 3_600_000;

  if (isLongTimeout) {
    // Hibernate immediately — the background deadline checker handles resolution
    console.log(`[room ${room.id}] all humans gone — hibernating (long timeout).`);
    _hibernateRoom(room);
  } else {
    console.log(`[room ${room.id}] all humans gone — starting ${RECONNECT_GRACE_MS / 1000}s destruction timer.`);
    room.allHumansGoneTimer = setTimeout(() => {
      const r = rooms.get(room.id);
      if (!r) return;
      if (r.players.some(s => !s.isAI)) { r.allHumansGoneTimer = null; return; }
      console.log(`[room ${room.id}] destruction timer expired — hibernating room.`);
      _hibernateRoom(r);
    }, RECONNECT_GRACE_MS);
  }
}

/**
 * Persist room state to DB and remove from in-memory rooms Map.
 * The room can be recovered later via _recoverRoom().
 */
function _hibernateRoom(room) {
  if (!room.state) return;
  try {
    const finalState = serializeState(room.state);
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
      {
        turnDeadline:        room.turnDeadline ?? null,
        turnIntervalMs:      room.config.turnIntervalMs,
        consecutiveTimeouts: room.consecutiveTimeouts,
        config:              room.config,
        players:             room.players.map(s => ({
          playerId: s.playerId, name: s.name, faction: s.faction,
          isAI: s.isAI, personality: s.personality ?? null,
          originalPlayerId: s.originalPlayerId ?? null,
        })),
        isPrivate: room.isPrivate,
        code:      room.code,
        status:    'playing',
      },
    );
  } catch (err) {
    console.error(`[room ${room.id}] hibernate upsertSave error:`, err);
  }
  destroyRoom(room);
}

/**
 * Recover a hibernated room from DB. Returns the restored room or null.
 */
function _recoverRoom(roomId) {
  const save = getSave(roomId);
  if (!save || save.status === 'finished') return null;
  if (save.game_version !== VERSION) return null;

  let state;
  try {
    state = deserializeState(save.state);
  } catch (err) {
    console.error(`[recoverRoom ${roomId}] deserializeState error:`, err);
    return null;
  }

  const savedPlayers = JSON.parse(save.players_json || '[]');
  const savedConfig  = JSON.parse(save.config_json || '{}');

  const room = createRoom(savedConfig);
  // Override the generated ID/code with the saved ones
  rooms.delete(room.id);
  codeToRoom.delete(room.code);
  room.id     = roomId;
  room.code   = save.code || room.code;
  room.state  = state;
  room.status = 'playing';
  room.isPrivate = !!save.is_private;
  room.consecutiveTimeouts = JSON.parse(save.consecutive_timeouts || '{}');
  rooms.set(room.id, room);
  if (room.code) codeToRoom.set(room.code, room.id);

  // Reconstruct seats from saved players
  for (const p of savedPlayers) {
    const seat = {
      playerId: p.playerId,
      ws:       null,
      name:     p.name,
      faction:  p.faction,
      isAI:     p.isAI,
      ai:       null,
      personality: p.personality ?? null,
    };
    if (p.originalPlayerId) seat.originalPlayerId = p.originalPlayerId;
    room.players.push(seat);

    // Create AI engine for AI seats
    if (p.isAI) {
      seat.ai = _makeAI(room, p.faction, p.playerId, p.personality);
      if (p.faction === 'witch') state.witchIsAI = true;
      else                       state.heroIsAI  = true;
    }
  }

  // Restore submitted plans from DB
  try {
    const planRows = getPlanStatus(roomId, state.round);
    for (const row of planRows) {
      if (row.plan_json !== null) {
        const plan = JSON.parse(row.plan_json);
        try { state.submitPlayerPlan(row.player_id, plan); } catch {}
      }
    }
  } catch (err) {
    console.error(`[recoverRoom ${roomId}] restore plans error:`, err);
  }

  console.log(`[room ${roomId}] recovered from DB (round ${state.round}, phase ${state.phase}).`);
  return room;
}

/** Handle a player reconnecting. */
export function handleReconnect(playerId, roomId, ws) {
  const room = rooms.get(roomId);
  if (!room) return false;

  // Find seat by current playerId or by originalPlayerId (AI-taken-over seats)
  let seat = seatFor(room, playerId);
  if (!seat) {
    seat = room.players.find(s => s.originalPlayerId === playerId) ?? null;
  }
  if (!seat) return false;

  // Cancel takeover and forfeit timers
  const takeover = room.takeoverTimers.get(playerId);
  if (takeover) { clearTimeout(takeover); room.takeoverTimers.delete(playerId); }
  const forfeit = room.disconnectTimers.get(playerId);
  if (forfeit)  { clearTimeout(forfeit);  room.disconnectTimers.delete(playerId); }

  // Cancel room-level all-humans-gone timer if present
  if (room.allHumansGoneTimer) {
    clearTimeout(room.allHumansGoneTimer);
    room.allHumansGoneTimer = null;
  }

  // If an AI already replaced this seat, reclaim it
  if (seat.isAI && seat.originalPlayerId === playerId) {
    const oldAiId = seat.playerId;
    seat.playerId = playerId;
    seat.ws       = ws;
    seat.isAI     = false;
    seat.ai       = null;
    delete seat.originalPlayerId;

    // Patch state.players to restore the human identity
    const sp = room.state.players.find(p => p.id === oldAiId);
    if (sp) {
      sp.id   = playerId;
      sp.isAI = false;
      const leader = room.state.entities.find(e => e.id === sp.leaderId);
      if (leader) leader.ownerId = playerId;
    }

    // Update AI flags on the state
    if (seat.faction === 'witch') room.state.witchIsAI = false;
    else                          room.state.heroIsAI  = false;

    broadcastExcept(room, playerId, { type: 'opponentReconnected' });
    send(ws, { type: 'reconnected', faction: seat.faction, myPlayerId: playerId, roomId: room.id });
    send(ws, { type: 'stateUpdate', reason: 'reconnect', state: serializeState(room.state) });

    // Resend planning phase if active
    if (room.state.planningPhase && !room.state.resolving) {
      const budget = room.state.playerActionsLeft?.get(playerId)
        ?? (seat.faction === 'hero' ? room.state.heroActionsLeft : room.state.witchActionsLeft);
      send(ws, {
        type:            'planningPhase',
        myActionsLeft:   budget,
        heroActionsLeft:  room.state.heroActionsLeft,
        witchActionsLeft: room.state.witchActionsLeft,
        timeoutMs:        0,
        players:          _buildPlayerList(room),
      });
      // Inform reconnecting player of who has already submitted
      for (const s of room.players) {
        if (s.playerId === playerId) continue;
        if (room.state.playerReady.get(s.playerId)) {
          send(ws, { type: 'playerSubmitted', playerId: s.playerId, name: s.name, faction: s.faction });
        }
      }
    }

    return true;
  }

  seat.ws = ws;
  broadcastExcept(room, playerId, { type: 'opponentReconnected' });

  send(ws, { type: 'reconnected', faction: seat.faction, myPlayerId: playerId, roomId: room.id });
  send(ws, { type: 'stateUpdate', reason: 'reconnect', state: serializeState(room.state) });

  // If the game is in planning phase, resend the planningPhase message so the
  // client re-enters planning mode (no separate planningPhase is sent on reconnect otherwise).
  if (room.state.planningPhase && !room.state.resolving) {
    const budget = room.state.playerActionsLeft?.get(playerId)
      ?? (seat.faction === 'hero' ? room.state.heroActionsLeft : room.state.witchActionsLeft);
    send(ws, {
      type:            'planningPhase',
      myActionsLeft:   budget,
      heroActionsLeft:  room.state.heroActionsLeft,
      witchActionsLeft: room.state.witchActionsLeft,
      timeoutMs:        0,  // no countdown for reconnected players
      players:          _buildPlayerList(room),
    });
    // Inform reconnecting player of who has already submitted
    for (const s of room.players) {
      if (s.playerId === playerId) continue;
      if (room.state.playerReady.get(s.playerId)) {
        send(ws, { type: 'playerSubmitted', playerId: s.playerId, name: s.name, faction: s.faction });
      }
    }
  }

  return true;
}

export function getRoomByCode(code) {
  const roomId = codeToRoom.get(code?.toUpperCase());
  return roomId ? rooms.get(roomId) : null;
}

export function getRoom(roomId) {
  return rooms.get(roomId) ?? null;
}

// ── Admin / spectator exports ─────────────────────────────────────────────────

/** Lightweight summary of every active room (no full state). */
export function getRooms() {
  return [...rooms.values()].map(room => ({
    id:             room.id,
    code:           room.code,
    status:         room.status,
    round:          room.state?.round          ?? 0,
    phase:          room.state?.phase          ?? null,
    gameOver:       room.state?.gameOver       ?? false,
    winner:         room.state?.winner         ?? null,
    planningPhase:  room.state?.planningPhase  ?? false,
    config:         room.config,
    slots:          room.slots.map(s => ({ faction: s.faction, status: s.status, name: s.name })),
    players:        room.players.map(s => ({
      playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI, personality: s.personality ?? null,
    })),
    spectatorCount: room.spectators.size,
    createdAt:      room.createdAt,
  }));
}

/**
 * Return all games where the given player has (or had) a seat.
 * Includes both in-memory rooms and DB-hibernated games.
 * Used by the /api/saves REST endpoint so the client can show a "Rejoin" list.
 */
export function getActiveRoomsForPlayer(playerId) {
  const results = [];
  const seenRoomIds = new Set();

  // In-memory rooms first
  for (const room of rooms.values()) {
    if (room.status !== 'playing') continue;
    if (room.state?.gameOver) continue;
    const seat = room.players.find(
      s => s.playerId === playerId || s.originalPlayerId === playerId
    );
    if (!seat) continue;
    seenRoomIds.add(room.id);
    const heroName  = room.players.find(s => s.faction === 'hero')?.name  ?? '';
    const witchName = room.players.find(s => s.faction === 'witch')?.name ?? '';
    // Check if this player still needs to submit a plan
    const actionNeeded = room.state.planningPhase &&
      !room.state.playerReady?.get(playerId) &&
      !seat.isAI;
    results.push({
      room_id:          room.id,
      hero_name:        heroName,
      witch_name:       witchName,
      round:            room.state.round,
      phase:            room.state.phase,
      hero_player_id:   room.players.find(s => s.faction === 'hero'  && !s.isAI)?.playerId ?? null,
      witch_player_id:  room.players.find(s => s.faction === 'witch' && !s.isAI)?.playerId ?? null,
      turn_interval_ms: room.config.turnIntervalMs ?? TURN_TIMEOUT_MS,
      is_async:         room.config.isAsync ?? false,
      turn_deadline:    room.turnDeadline ?? null,
      map_size:         room.config.mapSize ?? 'standard',
      players_per_side: room.config.playersPerSide ?? 1,
      updated_at:       Math.floor(Date.now() / 1000),
      status:           room.status,
      action_needed:    actionNeeded,
      players_json:     JSON.stringify(room.players.map(s => ({
        playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI,
      }))),
    });
  }

  // DB-hibernated games
  try {
    const dbGames = getActiveGamesForPlayer(playerId);
    for (const g of dbGames) {
      if (seenRoomIds.has(g.room_id)) continue;
      // Extract fields from config_json
      try {
        const cfg = JSON.parse(g.config_json || '{}');
        g.is_async = cfg.isAsync ?? false;
        g.map_size = cfg.mapSize ?? 'standard';
        g.players_per_side = cfg.playersPerSide ?? 1;
      } catch {
        g.is_async = false;
        g.map_size = 'standard';
        g.players_per_side = 1;
      }
      delete g.config_json;
      // Compute action_needed from plan status
      if (g.status === 'playing') {
        try {
          const plans = getPlanStatus(g.room_id, g.round);
          const myPlan = plans.find(p => p.player_id === playerId);
          g.action_needed = myPlan ? !myPlan.submitted_at : true;
        } catch { g.action_needed = true; }
      } else {
        g.action_needed = false;
      }
      results.push(g);
    }
  } catch {}

  return results;
}

/** Queue no longer exists — returns empty array for backwards compat. */
export function getQueue() {
  return [];
}

/**
 * Subscribe an admin WebSocket to a room's live updates.
 * Immediately sends the current serialized state and full chronicle.
 * Returns false if the room doesn't exist.
 */
export function subscribeSpectator(roomId, ws) {
  const room = rooms.get(roomId);
  if (!room) return false;
  room.spectators.add(ws);
  // Send current state immediately so the spectator gets a starting snapshot
  send(ws, {
    type:      'adminSpectateInit',
    roomId,
    state:     room.state ? serializeState(room.state) : null,
    players:   room.players.map(s => ({
      playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI, personality: s.personality ?? null,
    })),
    chronicle: room.chronicle,
  });
  return true;
}

/**
 * Remove an admin WebSocket from all rooms it was spectating.
 * Pass a specific roomId to unsubscribe from one room only.
 */
export function unsubscribeSpectator(ws, roomId = null) {
  if (roomId) {
    rooms.get(roomId)?.spectators.delete(ws);
  } else {
    for (const room of rooms.values()) room.spectators.delete(ws);
  }
}

/** Return the full chronicle for a room (array of round records). */
export function getRoomChronicle(roomId) {
  return rooms.get(roomId)?.chronicle ?? null;
}

/**
 * Admin-initiated save activation — loads a save and starts it as an AI-vs-AI
 * game that can be spectated from the admin panel.
 * Returns { ok, roomId } on success, { ok: false, error, status } on failure.
 */
export function adminResumeGame(savedRoomId) {
  const save = getSave(savedRoomId);
  if (!save) return { ok: false, error: 'No save found.', status: 404 };

  if (save.game_version !== VERSION) {
    return { ok: false, error: `Save is from v${save.game_version}; server is v${VERSION}. Cannot resume.`, status: 400 };
  }

  let state;
  try {
    state = deserializeState(save.state);
  } catch (err) {
    console.error(`[adminResume ${savedRoomId}] deserializeState error:`, err);
    return { ok: false, error: 'Failed to restore save.', status: 500 };
  }

  // Force both sides to AI
  state.heroIsAI  = true;
  state.witchIsAI = true;

  const room = createRoom({ fog: state.fogOfWar });
  room.state  = state;
  room.status = 'playing';

  // Attach AI for both factions
  attachAI(room, 'hero');
  attachAI(room, 'witch');

  deleteSave(savedRoomId);

  _startPlanningPhase(room);
  return { ok: true, roomId: room.id };
}

/**
 * Rejoin a game. Tries in-memory first; falls back to DB recovery.
 */
export function resumeGame(playerId, ws, roomId) {
  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    // If room was saved between rounds, start planning before reconnecting
    if (!room.state.planningPhase && !room.state.gameOver && !room.state.resolving) {
      _startPlanningPhase(room);
    }
    const rejoined = handleReconnect(playerId, roomId, ws);
    if (rejoined) return;
  }

  // Try recovering the room from DB (hibernated game)
  const room = _recoverRoom(roomId);
  if (room) {
    const rejoined = handleReconnect(playerId, roomId, ws);
    if (rejoined) {
      if (room.state.planningPhase && !room.state.resolving) {
        // Already in planning — restart timer and kick AI plans
        _startPlanningTimer(room);
        _runAIPlanSubmission(room);
      } else if (!room.state.gameOver) {
        // Room was saved between rounds (after endRound, before startPlanning).
        // Kick off a fresh planning phase so the client isn't stuck.
        _startPlanningPhase(room);
      }
      return;
    }
  }

  send(ws, { type: 'error', message: 'Game is no longer active.' });
}

// ── Async (play-by-mail) game support ───────────────────────────────────────
//
// Async games live in the DB, not in the rooms Map. Players connect via
// WebSocket only while actively viewing/submitting. The asyncSessions Map
// tracks these lightweight connections.

/** @type {Map<string, Map<string, WebSocket>>} roomId → playerId → ws */
const asyncSessions = new Map();

// Re-export for notifications module to check online status
export { asyncSessions };

/**
 * Create a new async game. Returns { roomId, code } or { error }.
 */
export function createAsyncGameRoom(playerId, playerName, config) {
  const turnIntervalMs = Math.max(
    3_600_000,
    Math.min(259_200_000, Number(config.turnInterval) || 86_400_000)
  );
  const gameConfig = {
    fog:     config.fog     ?? 'partial',
    mapSize: config.mapSize ?? 'standard',
  };
  const faction = config.faction === 'witch' ? 'witch' : 'hero';
  const inviteeEmail = (config.inviteeEmail || '').trim().toLowerCase() || null;

  const result = insertAsyncGame(
    playerId, playerName, faction, gameConfig, turnIntervalMs, VERSION, inviteeEmail
  );

  // Generate the map immediately so the host can plan while waiting
  const state = new GameState(true, true, gameConfig.mapSize || 'standard');
  state.fogOfWar = gameConfig.fog || 'partial';

  // Patch the host's player record; opponent stays AI placeholder for now
  for (const p of state.players) {
    if (p.faction === faction) {
      p.id   = playerId;
      p.name = playerName;
      p.isAI = false;
      const leader = state.entities.find(e => e.id === p.leaderId);
      if (leader) leader.ownerId = playerId;
    }
  }
  if (faction === 'hero') state.heroIsAI = false;
  else                     state.witchIsAI = false;

  state.startPlanning();

  const serialized = serializeState(state);
  const stateJson  = JSON.stringify(serialized);
  const deadline   = Math.floor(Date.now() / 1000) + Math.floor(turnIntervalMs / 1000);

  // Store the generated state and insert a plan-status row for the host
  updateAsyncGameState(result.roomId, stateJson, state.round, state.phase, deadline, 0);
  insertAsyncPlanStatus(result.roomId, [playerId], state.round);

  // Send invite email if an invitee was specified
  if (inviteeEmail) {
    sendGameInvite(inviteeEmail, { roomId: result.roomId, code: result.code, hostName: playerName })
      .catch(() => {});
  }

  return result; // { roomId, code }
}

/**
 * Opponent joins an async game by code. Returns game summary or { error }.
 */
export function joinAsyncGameRoom(playerId, playerName, code) {
  const game = getAsyncGameByCode(code);
  if (!game) return { error: 'No waiting game found with that code.' };
  if (game.host_player_id === playerId) return { error: 'You cannot join your own game.' };

  const opponentFaction = game.host_faction === 'hero' ? 'witch' : 'hero';

  // Load the map that was generated at creation time
  const state = deserializeState(JSON.parse(game.state_json));

  // Patch the opponent's player record into the existing state
  const heroPlayerId  = game.host_faction === 'hero'  ? game.host_player_id : playerId;
  const witchPlayerId = game.host_faction === 'witch' ? game.host_player_id : playerId;
  const heroName      = game.host_faction === 'hero'  ? game.hero_name || game.witch_name : playerName;
  const witchName     = game.host_faction === 'witch' ? game.witch_name || game.hero_name : playerName;

  for (const p of state.players) {
    if (p.faction === opponentFaction) {
      p.id   = playerId;
      p.name = playerName;
      p.isAI = false;
      const leader = state.entities.find(e => e.id === p.leaderId);
      if (leader) leader.ownerId = playerId;
    }
  }
  state.heroIsAI  = false;
  state.witchIsAI = false;

  state.startPlanning();

  const serialized = serializeState(state);
  const stateJson  = JSON.stringify(serialized);
  const deadline   = Math.floor(Date.now() / 1000) + Math.floor(game.turn_interval_ms / 1000);

  const ok = activateAsyncGame(
    game.room_id, playerId, playerName,
    heroName, witchName,
    stateJson, state.round, state.phase, deadline
  );
  if (!ok) return { error: 'Failed to activate game.' };

  // Notify the host that round 1 is ready
  const opponentId = game.host_player_id;
  notifyRoundReady(opponentId, {
    roomId: game.room_id, round: 1,
  }, { isAsync: true }).catch(() => {});

  // If host already connected, push updated state so they see the opponent joined
  _asyncSend(game.room_id, opponentId, {
    type:       'asyncOpponentJoined',
    roomId:     game.room_id,
    opponentName: playerName,
  });

  return {
    roomId:   game.room_id,
    faction:  opponentFaction,
    round:    state.round,
    phase:    state.phase,
    heroName, witchName,
    turnDeadline: deadline,
    turnIntervalMs: game.turn_interval_ms,
  };
}

/**
 * Player connects to view/submit for an async game.
 * Sends state + plan status over the WebSocket.
 */
export function connectToAsyncGame(playerId, ws, roomId) {
  const game = getAsyncGame(roomId);
  if (!game) { send(ws, { type: 'error', message: 'Async game not found.' }); return; }
  if (game.hero_player_id !== playerId && game.witch_player_id !== playerId) {
    send(ws, { type: 'error', message: 'You are not a participant in this game.' }); return;
  }
  if (game.status === 'waiting') {
    // Only the host can connect while waiting for an opponent
    if (game.host_player_id !== playerId) {
      send(ws, { type: 'error', message: 'Waiting for an opponent to join.' }); return;
    }
    // Host can view the map and plan while waiting
  }

  // Register session
  if (!asyncSessions.has(roomId)) asyncSessions.set(roomId, new Map());
  asyncSessions.get(roomId).set(playerId, ws);

  const myFaction = game.hero_player_id === playerId ? 'hero' :
                    (game.witch_player_id === playerId ? 'witch' : game.host_faction);
  const state     = JSON.parse(game.state_json);
  const plans     = getAsyncPlanStatus(roomId, game.round);
  const myPlan    = plans.find(p => p.player_id === playerId);

  // Include last round's replay data so the client can offer "Show Last Turn"
  const lastRound = game.round > 1 ? getLastSaveRound(roomId) : null;

  // ── Debug: log reconnect replay data ──
  if (lastRound) {
    const parsedSteps = JSON.parse(lastRound.steps_json);
    console.log(`[async ${roomId}] Reconnect — sending lastRound for round ${lastRound.round_num}:`);
    console.log(`  steps: ${parsedSteps.length}`);
    for (let i = 0; i < parsedSteps.length; i++) {
      const s = parsedSteps[i];
      const evCount = (s.playerEvents ?? []).reduce((n, pe) => n + (pe.events?.length ?? 0), 0)
        + (s.heroEvents?.length ?? 0) + (s.witchEvents?.length ?? 0);
      console.log(`  step[${i}]: ${evCount} events, ${s.entitySnapshot?.length ?? 0} entities`);
    }
    console.log(`  preStateJson length: ${lastRound.pre_state_json?.length ?? 0}`);
    console.log(`  state entities: ${state?.entities?.length ?? 0}`);
  } else {
    console.log(`[async ${roomId}] Reconnect — no lastRound (round=${game.round})`);
  }

  send(ws, {
    type:       'asyncStateUpdate',
    roomId,
    state,
    faction:    myFaction,
    myPlayerId: playerId,
    round:      game.round,
    phase:      game.phase,
    turnDeadline:   game.turn_deadline,
    turnIntervalMs: game.turn_interval_ms,
    myPlanSubmitted: myPlan ? !!myPlan.submitted : false,
    myPlanActions: (myPlan?.submitted && myPlan?.plan_json)
      ? JSON.parse(myPlan.plan_json) : null,
    planStatus: plans.map(p => ({
      playerId:  p.player_id,
      submitted: !!p.submitted,
    })),
    heroName:  game.hero_name,
    witchName: game.witch_name,
    gameStatus: game.status,
    winner:     game.winner,
    winReason:  game.win_reason,
    myActionsLeft: state.playerActionsLeft?.[playerId] ?? state[myFaction + 'ActionsLeft'] ?? 3,
    lastRound:  lastRound ? {
      roundNum:     lastRound.round_num,
      preStateJson: lastRound.pre_state_json,
      stepsJson:    lastRound.steps_json,
    } : null,
  });
}

/**
 * Handle async plan submission. Persists to DB, triggers resolution if all in.
 */
export function handleAsyncPlanSubmit(playerId, roomId, plan) {
  const game = getAsyncGame(roomId);
  if (!game || (game.status !== 'playing' && game.status !== 'waiting')) {
    _asyncSend(roomId, playerId, { type: 'error', message: 'Game is not active.' });
    return;
  }
  // In 'waiting' status only the host can submit
  if (game.status === 'waiting' && game.host_player_id !== playerId) {
    _asyncSend(roomId, playerId, { type: 'error', message: 'Not a participant.' });
    return;
  }
  if (game.status === 'playing' &&
      game.hero_player_id !== playerId && game.witch_player_id !== playerId) {
    _asyncSend(roomId, playerId, { type: 'error', message: 'Not a participant.' });
    return;
  }

  if (!Array.isArray(plan)) plan = [];

  const ok = submitAsyncPlan(roomId, playerId, game.round, plan);
  if (!ok) {
    _asyncSend(roomId, playerId, { type: 'error', message: 'Plan already submitted or invalid round.' });
    return;
  }

  // Confirm to submitter
  _asyncSend(roomId, playerId, { type: 'asyncPlanAccepted', roomId });

  // If still waiting for opponent, nothing more to do
  if (game.status === 'waiting') return;

  // Notify opponent via WebSocket if connected
  const opponentId = game.hero_player_id === playerId ? game.witch_player_id : game.hero_player_id;
  _asyncSend(roomId, opponentId, {
    type:       'asyncPlanStatus',
    roomId,
    planStatus: getAsyncPlanStatus(roomId, game.round).map(p => ({
      playerId: p.player_id, submitted: !!p.submitted,
    })),
  });

  // Check if all plans are in
  if (asyncAllPlansSubmitted(roomId, game.round)) {
    _resolveAsyncRound(roomId);
  } else {
    // Notify opponent if they're the last one who hasn't submitted
    notifyWaitingOnYou(opponentId, {
      roomId,
    }, { isAsync: true }).catch(() => {});
  }
}

/**
 * Handle async player disconnect — just clean up the session.
 */
export function handleAsyncDisconnect(playerId, roomId) {
  const roomSessions = asyncSessions.get(roomId);
  if (roomSessions) {
    roomSessions.delete(playerId);
    if (roomSessions.size === 0) asyncSessions.delete(roomId);
  }
}

/**
 * Run resolution for an async game. Called when all plans are submitted
 * or when the deadline expires.
 */
function _resolveAsyncRound(roomId) {
  const game = getAsyncGame(roomId);
  if (!game || game.status !== 'playing') return;

  const state = deserializeState(JSON.parse(game.state_json));
  state.startPlanning();

  // Gather submitted plans
  const plans = getAsyncPlanStatus(roomId, game.round);
  const playerEntries = [];
  for (const p of plans) {
    const plan = p.plan_json ? JSON.parse(p.plan_json) : [];
    const faction = p.player_id === game.hero_player_id ? 'hero' : 'witch';
    playerEntries.push({ playerId: p.player_id, faction, plan });

    // Submit into state so resolvePlansMP can read playerPlans
    try { state.submitPlayerPlan(p.player_id, plan); } catch (_) {}
  }

  // Snapshot before resolution
  const preStateJson = JSON.stringify(serializeState(state));

  let steps;
  try {
    steps = resolvePlansMP(state, playerEntries);
  } catch (err) {
    console.error(`[async ${roomId}] resolvePlansMP error:`, err);
    steps = [];
  }

  // Post-resolution updates
  const summaryLines = compileTurnBattleSummary(steps, state.entities, ResEventType, PlanActionType);
  for (const line of summaryLines) state.log.push(line);

  state.updateNodeDiscovery();
  state.checkAndLogNodeControlChanges();
  state.updateExploredHexes();
  state.endRound();

  const finalState   = serializeState(state);
  const finalJson    = JSON.stringify(finalState);
  const resolvedRound = state.round - 1; // endRound already incremented

  // Serialize steps for wire + storage
  const serializedSteps = steps.map(step => ({
    stepIndex:      step.stepIndex,
    playerEvents:   step.playerEvents.map(pe => ({
      playerId: pe.playerId,
      faction:  pe.faction,
      events:   _serializeEvents(pe.events),
    })),
    entitySnapshot: step.entitySnapshot ?? [],
  }));

  // Store replay round
  try {
    appendSaveRound(roomId, resolvedRound, preStateJson, JSON.stringify(serializedSteps));
  } catch (err) {
    console.error(`[async ${roomId}] appendSaveRound error:`, err);
  }

  if (state.gameOver) {
    _finishAsyncGame(roomId, game, state, serializedSteps, finalState);
  } else {
    // Advance to next round
    const newDeadline = Math.floor(Date.now() / 1000) + Math.floor(game.turn_interval_ms / 1000);
    updateAsyncGameState(roomId, finalJson, state.round, state.phase, newDeadline, 0);
    insertAsyncPlanStatus(roomId, [game.hero_player_id, game.witch_player_id], state.round);

    // Notify both players of new round
    for (const pid of [game.hero_player_id, game.witch_player_id]) {
      notifyRoundReady(pid, {
        roomId, round: state.round,
      }, { isAsync: true }).catch(() => {});
    }
  }

  // Push resolution to any connected players
  const resolutionMsg = {
    type: 'asyncResolution', roomId,
    resolvedRound, preStateJson,
    steps: serializedSteps, finalState,
  };

  // ── Debug: log what we're broadcasting ──
  console.log(`[async ${roomId}] Broadcasting resolution for round ${resolvedRound}:`);
  console.log(`  steps: ${serializedSteps.length}`);
  for (let i = 0; i < serializedSteps.length; i++) {
    const s = serializedSteps[i];
    const evCount = s.playerEvents.reduce((n, pe) => n + pe.events.length, 0);
    console.log(`  step[${i}]: ${evCount} events, ${s.entitySnapshot?.length ?? 0} entities`);
    for (const pe of s.playerEvents) {
      for (const ev of pe.events) {
        const extra = [];
        if (ev.action?.type === 'move') {
          extra.push(`to=${ev.action.toCol},${ev.action.toRow}`);
          extra.push(`path=${JSON.stringify(ev.result?.path ?? 'MISSING')}`);
        }
        if (ev.battleSnaps) extra.push('hasBattleSnaps');
        console.log(`    ${pe.faction} ${ev.type} ${ev.action?.type ?? '?'} entity=${ev.action?.entityId ?? '?'} ${extra.join(' ')}`);
      }
    }
  }
  console.log(`  preStateJson length: ${preStateJson?.length ?? 0}`);
  console.log(`  finalState entities: ${finalState?.entities?.length ?? 0}`);

  _asyncBroadcast(roomId, resolutionMsg);
}

function _finishAsyncGame(roomId, game, state, serializedSteps, finalState) {
  finishAsyncGame(roomId, 'finished', state.winner, state.winReason, JSON.stringify(finalState));

  // Record leaderboard results
  for (const pid of [game.hero_player_id, game.witch_player_id]) {
    if (!pid) continue;
    const faction = pid === game.hero_player_id ? 'hero' : 'witch';
    const outcome = faction === state.winner ? 'win' : (state.winner ? 'loss' : 'draw');
    try { recordResult(pid, outcome); } catch (_) {}
  }

  // Record game stats
  try {
    recordGameStats({
      id:                randomUUID(),
      mode:              'async',
      map_size:          state.mapSize || 'standard',
      winner:            state.winner,
      win_reason:        state.winReason,
      rounds:            state.round,
      final_phase:       state.phase,
      hero_score:        state.nodeScore?.hero  || 0,
      witch_score:       state.nodeScore?.witch || 0,
      hero_kills:        state.heroKills  || 0,
      witch_kills:       state.witchKills || 0,
      hero_survivors:    state.entities.filter(e => e.owner === 'hero' && e.type === 'survivor').length,
      witch_summons:     state.witchSummonCount || 0,
      hero_personality:  null,
      witch_personality: null,
      hero_player_id:    game.hero_player_id,
      witch_player_id:   game.witch_player_id,
      game_version:      VERSION,
      fog_of_war:        state.fogOfWar !== 'none' ? 1 : 0,
      duration_ms:       (Math.floor(Date.now() / 1000) - game.created_at) * 1000,
    });
  } catch (err) { console.error(`[async ${roomId}] recordGameStats error:`, err); }

  // Save completed game replay
  try {
    const rounds = getSaveRounds(roomId);
    if (rounds.length > 0) {
      const gameId = randomUUID();
      createCompletedGame(gameId, roomId, {
        heroPlayerId:  game.hero_player_id,
        witchPlayerId: game.witch_player_id,
        heroName:      game.hero_name,
        witchName:     game.witch_name,
        winner:        state.winner ?? '',
        winReason:     state.winReason ?? '',
        totalRounds:   state.round - 1,
        gameVersion:   VERSION,
        mode:          'hvh',
      }, rounds.map(r => ({
        roundNum:     r.round_num,
        preStateJson: r.pre_state_json,
        stepsJson:    r.steps_json,
      })));
    }
  } catch (err) {
    console.error(`[async ${roomId}] createCompletedGame error:`, err);
  }

  // Notify both players
  for (const pid of [game.hero_player_id, game.witch_player_id]) {
    notifyGameOver(pid, {
      roomId, winner: state.winner, winReason: state.winReason,
    }, { isAsync: true }).catch(() => {});
  }
}

// ── Async deadline checker ──────────────────────────────────────────────────

/**
 * Check for async games with expired deadlines.
 * Called periodically by setInterval in server.js.
 */
export function checkAsyncDeadlines() {
  const expired = getExpiredGames();
  for (const { room_id: roomId } of expired) {
    try {
      const game = getAsyncGame(roomId);
      if (!game || game.status !== 'playing') continue;

      const plans = getAsyncPlanStatus(roomId, game.round);
      const submitted = plans.filter(p => p.submitted);

      // Check if NEITHER player submitted (double timeout)
      if (submitted.length === 0) {
        const newCount = (game.consecutive_timeout_rounds || 0) + 1;
        if (newCount >= 3) {
          // Abandon the game
          finishAsyncGame(roomId, 'abandoned', null, 'Abandoned due to inactivity', game.state_json);
          console.log(`[async ${roomId}] Abandoned after ${newCount} consecutive double-timeouts.`);
          for (const pid of [game.hero_player_id, game.witch_player_id]) {
            const opponentId = pid === game.hero_player_id ? game.witch_player_id : game.hero_player_id;
            notifyGameAbandoned(pid, { roomId, opponentId }).catch(() => {});
          }
          continue;
        }
        // Update timeout counter, auto-submit empty plans, resolve
        updateAsyncGameState(
          roomId, game.state_json, game.round, game.phase,
          game.turn_deadline, newCount
        );
      }

      // Auto-submit empty plans for players who haven't submitted
      for (const p of plans) {
        if (!p.submitted) {
          submitAsyncPlan(roomId, p.player_id, game.round, []);
        }
      }

      _resolveAsyncRound(roomId);
    } catch (err) {
      console.error(`[async ${roomId}] deadline check error:`, err);
    }
  }
}

/** Prune stale async games on startup. */
export function pruneAsyncGames() {
  _pruneAsyncGames(VERSION);
}

/** Exported for testing only. */
export { _serializeEvents as serializeEventsForTest };

/** Get async games list for a player (for REST endpoint). */
export { getAsyncGamesForPlayer };

// ── Unified deadline checker (for hibernated rooms) ─────────────────────────

/**
 * Check for game_saves with expired turn deadlines.
 * Recovers hibernated rooms, auto-submits empty plans, and resolves.
 * Called periodically by the server (e.g. every 30 seconds).
 */
export function checkDeadlines() {
  let expired;
  try {
    expired = getExpiredDeadlineGames();
  } catch (err) {
    console.error('[checkDeadlines] query error:', err);
    return;
  }

  for (const row of expired) {
    const roomId = row.room_id;
    try {
      // Skip if room is already active in memory (timer handles it)
      if (rooms.has(roomId)) continue;

      const room = _recoverRoom(roomId);
      if (!room) continue;

      // If room was saved between rounds, start planning first
      if (!room.state.planningPhase && !room.state.gameOver) {
        _startPlanningPhase(room);
      }

      if (room.state.planningPhase && !room.state.resolving) {
        console.log(`[room ${roomId}] deadline expired — auto-submitting empty plans.`);
        _autoSubmitMissingPlans(room);
      }

      // If no humans connected after recovery, hibernate again
      if (!room.players.some(s => s.ws)) {
        _hibernateRoom(room);
      }
    } catch (err) {
      console.error(`[checkDeadlines] room ${roomId} error:`, err);
    }
  }
}

/**
 * Check for games approaching their deadline (~10 min) and notify
 * unsubmitted players. Called periodically by the server.
 */
export function checkApproachingDeadlines() {
  let games;
  try {
    games = getApproachingDeadlineGames(600_000); // 10 minutes
  } catch (err) {
    console.error('[checkApproachingDeadlines] query error:', err);
    return;
  }

  for (const row of games) {
    try {
      const config = row.config_json ? JSON.parse(row.config_json) : {};
      if (!config.isAsync) continue;

      const minutesLeft = Math.max(1, Math.round((row.turn_deadline - Date.now() / 1000) / 60));
      const plans = getPlanStatus(row.room_id, row.round);

      for (const p of plans) {
        if (p.submitted_at) continue; // already submitted
        notifyDeadlineApproaching(p.player_id, {
          roomId: row.room_id, minutesLeft,
        }, { isAsync: true }).catch(() => {});
      }
    } catch (err) {
      console.error(`[checkApproachingDeadlines] room ${row.room_id} error:`, err);
    }
  }
}

// ── Async → Unified migration ───────────────────────────────────────────────

/**
 * Migrate existing async_games rows to the unified game_saves table.
 * Called once at startup. Skips games that already have a game_saves row.
 */
export function migrateAsyncGames() {
  let rows;
  try {
    rows = db.prepare(
      `SELECT * FROM async_games WHERE status IN ('playing', 'waiting')`
    ).all();
  } catch {
    return 0; // table doesn't exist or is empty
  }

  let migrated = 0;
  for (const g of rows) {
    // Skip if already migrated (game_saves row exists)
    const existing = getSave(g.room_id);
    if (existing) continue;

    try {
      const config = g.config_json ? JSON.parse(g.config_json) : {};
      const players = [];
      if (g.hero_player_id) {
        players.push({
          playerId: g.hero_player_id, name: g.hero_name || 'Hero',
          faction: 'hero', isAI: false, personality: null,
        });
      }
      if (g.witch_player_id) {
        players.push({
          playerId: g.witch_player_id, name: g.witch_name || 'Witch',
          faction: 'witch', isAI: false, personality: null,
        });
      }

      const serializedState = g.state_json ? JSON.parse(g.state_json) : null;
      if (!serializedState && g.status !== 'waiting') continue;

      // Only migrate playing games with actual state
      if (g.status === 'playing' && serializedState) {
        upsertSave(
          g.room_id,
          g.hero_player_id,
          g.witch_player_id,
          g.hero_name || '',
          g.witch_name || '',
          serializedState,
          {
            turnIntervalMs:      g.turn_interval_ms || 86400000,
            consecutiveTimeouts: {},
            config:              { ...config, turnIntervalMs: g.turn_interval_ms || 86400000 },
            players,
            isPrivate: 1,
            code:      g.code,
            status:    'playing',
          },
        );

        // Copy plan status rows
        try {
          const plans = db.prepare(
            `SELECT * FROM async_plan_status WHERE room_id = ?`
          ).all(g.room_id);
          for (const p of plans) {
            try {
              const planData = p.plan_json ? JSON.parse(p.plan_json) : null;
              if (planData) {
                upsertPlanStatus(g.room_id, p.player_id, p.round, planData);
              }
            } catch {}
          }
        } catch {}

        migrated++;
      }

      // Mark async game as migrated by setting status
      try {
        db.prepare(`UPDATE async_games SET status = 'migrated' WHERE room_id = ?`).run(g.room_id);
      } catch {}
    } catch (err) {
      console.error(`[migration] Error migrating async game ${g.room_id}:`, err);
    }
  }

  if (migrated > 0) console.log(`[migration] Migrated ${migrated} async game(s) to unified system.`);
  return migrated;
}

// ── Async session helpers ───────────────────────────────────────────────────

function _asyncSend(roomId, playerId, msg) {
  const ws = asyncSessions.get(roomId)?.get(playerId);
  send(ws, msg);
}

function _asyncBroadcast(roomId, msg) {
  const roomSessions = asyncSessions.get(roomId);
  if (!roomSessions) return;
  for (const ws of roomSessions.values()) send(ws, msg);
}
