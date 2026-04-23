// Lobby: room lifecycle, server-side AI, action dispatch
import { randomUUID } from 'crypto';
import { GameState, Player, GameMode, computeActionsForPlayer, countHeldNodes } from '../src/game.js';
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
         getSaveRounds, getLastSaveRound, getSaveRound,
         insertPlanStatusRows, upsertPlanStatus,
         getPlanStatus, clearPlanStatus,
         clearAllPlanStatus, getExpiredDeadlineGames,
         getApproachingDeadlineGames,
         getActiveGamesForPlayer, getAllPlayingSaves,
         isVersionCompatible }                            from './saves.js';
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
         notifyGameAbandoned, notifyNudge, sendGameInvite,
         notifyBattleDeadlineApproaching,
         shouldNotify }                          from './notifications.js';
import { sendPush }                              from './push.js';
import db                                  from './db.js';
import { VERSION, SAVE_VERSION }            from '../src/version.js';
import { generateMultipleStarts, generateBattleStarts } from '../src/map.js';
import { HERO_PLAYER_COLORS, WITCH_PLAYER_COLORS } from '../src/entities.js';
import { pickAIName }                              from '../src/ai-names.js';
import { sideOf, getFactionsForSide }              from '../src/factions.js';

// ── Room phase enum ─────────────────────────────────────────────────────────
// Single source of truth for where a room is in its lifecycle.
// Replaces the scattered state.planningPhase / state.resolving / room.status flags.
export const RoomPhase = Object.freeze({
  LOBBY:     'lobby',
  PLANNING:  'planning',
  RESOLVING: 'resolving',
  FINISHED:  'finished',
});

// ── Constants ────────────────────────────────────────────────────────────────
const RECONNECT_GRACE_MS = parseInt(process.env.RECONNECT_GRACE_MS, 10) || 60_000;
const TURN_TIMEOUT_MS    = parseInt(process.env.TURN_TIMEOUT_MS, 10)    || 90_000;
const ROUND_DELAY_MS     = parseInt(process.env.ROUND_DELAY_MS, 10)     || 4000;
const CHRONICLE_MAX      = 100;    // max rounds retained per room in the chronicle
const BATTLE_ADVANCE_THRESHOLD_S = 30 * 60; // 30 minutes — if less than this until deadline, advance to next

/** When true, rooms are never evicted from memory. Games stay loaded and the
 *  save system only persists snapshots for crash recovery. */
const HIBERNATION_DISABLED = true;

/** Next battle turn deadline: noon or midnight PST, whichever is soonest.
 *  Returns a Unix timestamp (seconds) in true UTC. */
function _nextBattleDeadline() {
  // Get current PST hours/date by formatting to PST then parsing components
  const pstStr = new Date().toLocaleString('en-US', { timeZone: 'America/Los_Angeles', hour12: false });
  const [datePart, timePart] = pstStr.split(', ');
  const [month, day, year] = datePart.split('/').map(Number);
  const [hours] = timePart.split(':').map(Number);

  // Build target times as ISO strings in America/Los_Angeles
  // Use Intl.DateTimeFormat to get the UTC offset for PST/PDT
  const nowMs = Date.now();

  // Next noon PST: if before noon PST, target is today noon; else tomorrow noon
  // Next midnight PST: if before midnight (always true if we got past noon check), tomorrow midnight
  // We test both and return whichever is sooner and still in the future

  const tryTarget = (targetHour, daysAhead) => {
    // Construct a date string in PST: "YYYY-MM-DDThh:00:00" and resolve via Date
    const d = new Date(pstStr);
    d.setDate(d.getDate() + daysAhead);
    d.setHours(targetHour, 0, 0, 0);
    // Convert back to true UTC by round-tripping through toLocaleString
    // This is imprecise. Instead, compute offset from a known reference.
    return Math.floor(d.getTime() / 1000);
  };

  // Simpler approach: compute using the offset between local JS time and PST
  const utcNow = new Date();
  const pstNow = new Date(utcNow.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const offsetMs = utcNow.getTime() - pstNow.getTime(); // UTC - PST_as_local = offset

  // Build noon and midnight in PST, convert to UTC
  const todayNoonPST = new Date(pstNow);
  todayNoonPST.setHours(12, 0, 0, 0);
  const todayNoonUTC = new Date(todayNoonPST.getTime() + offsetMs);
  if (todayNoonUTC.getTime() > nowMs) {
    return Math.floor(todayNoonUTC.getTime() / 1000);
  }

  const tomorrowMidnightPST = new Date(pstNow);
  tomorrowMidnightPST.setDate(tomorrowMidnightPST.getDate() + 1);
  tomorrowMidnightPST.setHours(0, 0, 0, 0);
  const tomorrowMidnightUTC = new Date(tomorrowMidnightPST.getTime() + offsetMs);
  return Math.floor(tomorrowMidnightUTC.getTime() / 1000);
}

// ── Player notification callback (injected by server.js to avoid circular imports) ──

let _sendToPlayer = null;

/** Called by server.js to provide a function that sends a message to a player by ID. */
export function setSendToPlayer(fn) { _sendToPlayer = fn; }

/** Notify a player that their game list has changed (plan submitted, round resolved, etc.). */
function _notifyGamesUpdate(playerId) {
  _sendToPlayer?.(playerId, { type: 'gamesUpdate' });
}

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

export function send(ws, obj) {
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
      if (!seat?.ws || seat.ws.readyState !== 1) return false;
      // Player is "paying attention" only if app is foregrounded AND they're in this game
      return !seat.ws._inactive && seat.ws._roomId === room.id;
    },
  };
}

/** Build the player list with connection/active status for client display. */
function _buildPlayerList(room) {
  return room.players.map(s => {
    const wsOpen = s.ws?.readyState === 1;
    const inThisRoom = s.ws?._roomId === room.id;
    // Look up the leader entity's color so clients can render names in the
    // same per-player color used for map unit outlines.
    const statePlayer = room.state.players.find(p => p.id === s.playerId);
    const leader = statePlayer
      ? room.state.entities.find(e => e.id === statePlayer.leaderId)
      : null;
    return {
      playerId:  s.playerId,
      name:      s.name,
      faction:   s.faction,
      color:     leader?.color ?? null,
      isAI:      s.isAI,
      connected: s.isAI || wsOpen,
      active:    s.isAI || (wsOpen && !s.ws._inactive && inThisRoom),
      submitted: !!room.state.playerReady?.get(s.playerId),
    };
  });
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

/** Send planning-phase state to a reconnecting player, including their submitted plan. */
function _sendReconnectPlanningState(room, playerId, ws) {
  if (room.phase !== RoomPhase.PLANNING) return;

  const seat = seatFor(room, playerId);
  const budget = room.state.playerActionsLeft?.get(playerId)
    ?? (seat?.faction === 'hero' ? room.state.heroActionsLeft : room.state.witchActionsLeft);

  // Send the player's submitted plan if they've already submitted this round.
  const isReady = !!room.state.playerReady.get(playerId);
  const submittedPlan = isReady
    ? (room.state.playerPlans.get(playerId) ?? null)
    : null;

  // Only send replay if the player hasn't submitted yet AND was in the game
  // for the previous round. New battle joiners skip the replay — they weren't
  // present for that round.
  let lastReplay = null;
  const wasPresent = (seat?.joinedAtRound ?? 0) < room.state.round;
  if (!submittedPlan && wasPresent) {
    lastReplay = _getLastUnwatchedReplay(room);
  }

  // Compute remaining time for the countdown timer
  let timeoutMs = 0;
  if (room.turnDeadline) {
    const remaining = room.turnDeadline - Math.floor(Date.now() / 1000);
    if (remaining > 0) timeoutMs = remaining * 1000;
  }

  send(ws, {
    type:            'planningPhase',
    myActionsLeft:   budget,
    heroActionsLeft:  room.state.heroActionsLeft,
    witchActionsLeft: room.state.witchActionsLeft,
    timeoutMs,
    players:          _buildPlayerList(room),
    submittedPlan,
    lastReplay,
  });

  // Inform reconnecting player of who has already submitted (including themselves)
  for (const s of room.players) {
    if (room.state.playerReady.get(s.playerId)) {
      send(ws, { type: 'playerSubmitted', playerId: s.playerId, name: s.name, faction: s.faction });
    }
  }
}

/**
 * Fetch a specific round's replay data (in-memory first, then DB).
 * Returns null if the round is not available.
 */
export function getReplayForRound(room, roundNum) {
  if (!room || typeof roundNum !== 'number') return null;
  const mem = room.replayRounds?.find(r => r.roundNum === roundNum);
  if (mem) {
    return {
      roundNum:          mem.roundNum,
      preStateJson:      mem.preStateJson,
      stepsJson:         mem.stepsJson,
      finalEntitiesJson: mem.finalEntitiesJson ?? null,
    };
  }
  const row = getSaveRound(room.id, roundNum);
  if (row) {
    return {
      roundNum:          row.round_num,
      preStateJson:      row.pre_state_json,
      stepsJson:         row.steps_json,
      finalEntitiesJson: null,  // save rounds never store final entities
    };
  }
  return null;
}

/**
 * Get the "last completed round" replay for reconnecting players.
 *
 * Explicitly looks up `state.round - 1` rather than trusting
 * `replayRounds[length-1]` — this guards against desync bugs where the
 * tail of the array doesn't match the round the player is waiting to see.
 */
function _getLastUnwatchedReplay(room) {
  const targetRound = (room.state?.round ?? 1) - 1;
  if (targetRound < 1) return null;
  return getReplayForRound(room, targetRound);
}

// ── Unified messages ────────────────────────────────────────────────────────
// gameJoined: single message sent on connect/reconnect with everything the
//             client needs — replaces matchFound + stateUpdate + planningPhase
// roundResolved: sent after resolution with steps + post-resolution state +
//                next round's planning params — replaces resolutionComplete + planningPhase

/**
 * Build a `gameJoined` message for a player entering/re-entering a game.
 */
function _buildGameJoinedMessage(room, playerId, faction) {
  const seat = seatFor(room, playerId);
  const budget = room.state.playerActionsLeft?.get(playerId) ?? 0;
  const isReady = !!room.state.playerReady?.get(playerId);
  const submittedPlan = isReady ? (room.state.playerPlans?.get(playerId) ?? null) : null;
  const playersReady = [];
  for (const s of room.players) {
    if (room.state.playerReady?.get(s.playerId)) {
      playersReady.push({ playerId: s.playerId, name: s.name, faction: s.faction });
    }
  }

  let deadline = null;
  if (room.turnDeadline) {
    const remaining = room.turnDeadline - Math.floor(Date.now() / 1000);
    if (remaining > 0) deadline = remaining * 1000;
  }

  // Include last round replay if the player hasn't submitted and was present
  let lastRound = null;
  const wasPresent = (seat?.joinedAtRound ?? 0) < room.state.round;
  if (!submittedPlan && wasPresent) {
    lastRound = _getLastUnwatchedReplay(room);
  }

  return {
    type: 'gameJoined',
    roomId: room.id,
    myPlayerId: playerId,
    myFaction: faction,
    gameState: serializeState(room.state),
    round: {
      budget,
      deadline,
      submittedPlan,
      playersReady,
    },
    lastRound,
    players: _buildPlayerList(room),
    isBattle: !!room.config.isBattle,
    isAsync: !!room.config.isAsync,
    gameOver: !!room.state.gameOver,
  };
}

/**
 * Build a per-player `roundResolved` message after resolution completes.
 */
function _buildRoundResolvedMessage(room, playerId, serializedSteps, finalState) {
  const budget = room.state.playerActionsLeft?.get(playerId) ?? 0;
  let deadline = null;
  if (room.turnDeadline) {
    const remaining = room.turnDeadline - Math.floor(Date.now() / 1000);
    if (remaining > 0) deadline = remaining * 1000;
  }

  // Last round = the round that just resolved (most recent entry in replayRounds)
  const lastEntry = room.replayRounds[room.replayRounds.length - 1] ?? null;

  return {
    type: 'roundResolved',
    steps: serializedSteps,
    gameState: finalState,
    round: {
      budget,
      deadline,
    },
    lastRound: lastEntry ? {
      roundNum:          lastEntry.roundNum,
      preStateJson:      lastEntry.preStateJson,
      stepsJson:         lastEntry.stepsJson,
      finalEntitiesJson: lastEntry.finalEntitiesJson ?? null,
    } : null,
    players: _buildPlayerList(room),
    gameOver: !!room.state.gameOver,
  };
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
    phase:            RoomPhase.LOBBY,
    status:           'lobby',       // legacy — kept in sync with phase for backward compat
    isPrivate:        false,
    hostPlayerId:     null,
    config: {
      fog:              config.fog ?? 'partial',
      mapSize:          config.mapSize ?? 'standard',
      nodeCount:        config.nodeCount ?? null,
      playersPerSide:   Math.max(1, Math.min(config.isBattle ? 10 : 4, (config.playersPerSide | 0) || 1)),
      turnIntervalMs:   Math.max(Math.min(TURN_TIMEOUT_MS, 30_000), Math.min(259_200_000, Number(config.turnIntervalMs) || TURN_TIMEOUT_MS)),
      isAsync:          !!config.isAsync,
      isBattle:         !!config.isBattle,
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
    unassigned:       [],  // { playerId, name, _ws } — players who haven't picked a slot yet
    usedAINames:      new Set(),
    createdAt:        Date.now(),
  };

  rooms.set(id, room);
  codeToRoom.set(code, id);
  return room;
}

/** Build an ordered slot array for the given players-per-side count.
 *
 * Each slot carries three faction-related fields:
 *   - `faction`   — legacy field, today always 'hero' or 'witch'. Read by the
 *                   bulk of lobby/state code; do not rename in-place yet.
 *   - `side`      — Side id ('day' | 'night'). Forward-looking; computed via
 *                   sideOf(faction). Read this when grouping by team.
 *   - `factionId` — the specific faction occupying the seat. Defaults to the
 *                   side's first registered faction (= legacy `faction`
 *                   today). Mutated by `setFaction()` once stub factions
 *                   land in PR 5.
 */
function _buildSlots(playersPerSide, isBattle = false) {
  const pps   = Math.max(1, Math.min(isBattle ? 10 : 4, playersPerSide | 0));
  const slots = [];
  const mkSlot = (faction, i) => ({
    faction,
    side:      sideOf(faction),
    factionId: faction,
    seatIndex: i,
    status:    'empty',
    playerId:  null,
    name:      null,
    personality: null,
  });
  for (let i = 0; i < pps; i++) slots.push(mkSlot('hero',  i));
  for (let i = 0; i < pps; i++) slots.push(mkSlot('witch', i));
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
    unassigned:       (room.unassigned || []).map(u => ({ playerId: u.playerId, name: u.name })),
    createdAt:        room.createdAt,
    participantCount: room.slots.filter(s => s.status === 'human').length +
                      (room.unassigned || []).length,
    roomStatus:       room.status,       // 'lobby' or 'playing'
    openSlots:        room.openSlots?.length ?? 0,
  };
}

/** Send a lobbyUpdate to every human participant in a lobby room (including unassigned). */
function broadcastLobbyUpdate(room) {
  const payload = { type: 'lobbyUpdate', lobby: _lobbyPublic(room) };
  for (const slot of room.slots) {
    if (slot.status === 'human' && slot._ws) {
      send(slot._ws, payload);
    }
  }
  for (const u of (room.unassigned || [])) {
    if (u._ws) send(u._ws, payload);
  }
}

/**
 * Register a player seat in the room and wire up the corresponding state.players entry.
 *
 * For a freshly-created room, the GameState constructor pre-populated two synthetic
 * player records (id='hero', id='witch') and their leader entities.  We patch those
 * records to use the real player IDs so ownerId resolution works throughout the engine.
 */
function _addSeat(room, playerId, ws, name, faction, isAI, ai = null, factionId = null) {
  // Determine this player's color slot before pushing (0-based index in faction)
  const factionIndex = room.players.filter(s => s.faction === faction).length;
  const colors       = faction === 'hero' ? HERO_PLAYER_COLORS : WITCH_PLAYER_COLORS;
  const playerColor  = colors[factionIndex % colors.length];

  const seat = {
    playerId, ws, name, faction, isAI, ai,
    side:      sideOf(faction),
    factionId: factionId ?? faction,
  };
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

export function destroyRoom(room) {
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

// ── Orphaned room cleanup ────────────────────────────────────────────────────

const ORPHAN_LOBBY_AGE_MS = 60_000; // lobbies must be older than this to be pruned

/**
 * Periodic safety-net sweep that destroys or hibernates rooms with no connected
 * humans that slipped through normal disconnect handling (e.g. host disconnected
 * before the client sent `setRoom`).
 */
export function pruneOrphanedRooms() {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.status === 'lobby') {
      // Don't prune lobbies that were just created — give the client time to connect
      if (now - room.createdAt < ORPHAN_LOBBY_AGE_MS) continue;
      // Check if any human slot or unassigned player has a live WebSocket
      const hasLiveHuman = room.slots.some(
        s => s.status === 'human' && s._ws && s._ws.readyState === 1
      ) || (room.unassigned || []).some(
        u => u._ws && u._ws.readyState === 1
      );
      if (!hasLiveHuman) {
        console.log(`[pruneOrphanedRooms] destroying orphaned lobby ${room.id} (age ${Math.round((now - room.createdAt) / 1000)}s, no live humans).`);
        destroyRoom(room);
      }
    } else if (room.status === 'playing') {
      if (HIBERNATION_DISABLED) continue; // games stay in memory regardless
      // Playing room with no human seats (all taken over by AI) and no cleanup
      // timer already running. Note: isAI is only set to true after AI takeover
      // from 2 consecutive missed deadlines — idle human players in async games
      // keep isAI=false and are NOT affected by this check.
      const hasHuman = room.players.some(s => !s.isAI);
      if (!hasHuman && !room.allHumansGoneTimer) {
        console.log(`[pruneOrphanedRooms] hibernating orphaned game ${room.id} (no humans, no cleanup timer).`);
        _hibernateRoom(room);
      }
    }
  }
}

// ── Planning timer ────────────────────────────────────────────────────────────

function _startPlanningTimer(room, keepDeadline = false) {
  _clearTurnTimer(room);
  if (room.state.gameOver) return;

  if (room.config.isBattle) {
    // Battle mode: use wall-clock deadlines (noon / midnight PST).
    // keepDeadline=true means all players submitted early and we're reusing
    // the existing deadline (unless it's < 30min away, in which case advance).
    const now = Math.floor(Date.now() / 1000);

    if (keepDeadline && room.turnDeadline) {
      const remaining = room.turnDeadline - now;
      if (remaining > BATTLE_ADVANCE_THRESHOLD_S) {
        // > 30min left — keep the same deadline
        const timeoutMs = Math.max(1000, remaining * 1000);
        room.turnTimer = setTimeout(() => {
          room.turnTimer = null;
          if (room.phase !== RoomPhase.PLANNING) return;
          _autoSubmitMissingPlans(room);
        }, timeoutMs);
        return;
      }
      // < 30min left — fall through to advance to next deadline
    }

    const nextDeadline = _nextBattleDeadline();
    room.turnDeadline = nextDeadline;
    const timeoutMs = Math.max(1000, (nextDeadline - now) * 1000);
    room.turnTimer = setTimeout(() => {
      room.turnTimer = null;
      if (room.phase !== RoomPhase.PLANNING) return;
      _autoSubmitMissingPlans(room);
    }, timeoutMs);
    return;
  }

  // Standard games: relative timeout from now
  const timeoutMs = room.config.turnIntervalMs ?? TURN_TIMEOUT_MS;
  room.turnDeadline = Math.floor(Date.now() / 1000) + Math.ceil(timeoutMs / 1000);

  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.phase !== RoomPhase.PLANNING) return;
    _autoSubmitMissingPlans(room);
  }, timeoutMs);
}

/** Auto-submit empty plans for any seat that hasn't submitted yet.
 *  If open slots remain (round 1 late-join window), close them and fill with AI first.
 */
function _autoSubmitMissingPlans(room) {
  // Close the late-join window: fill any remaining open slots with AI
  _closeOpenSlots(room);

  // Snapshot the round — resolution can fire synchronously when a submit
  // makes allReady=true, advancing to a new round mid-loop.  If that happens,
  // stop submitting so we don't accidentally auto-submit into the *next* round
  // (which races with _runAIPlanSubmission and causes double-submit errors).
  const round = room.state.round;

  for (const seat of room.players) {
    if (room.state.round !== round) break;
    if (!room.state.playerReady.get(seat.playerId)) {
      if (!seat.isAI) {
        send(seat.ws, { type: 'error', message: 'Planning time expired — an empty plan was submitted.' });
      }
      _submitPlayerPlan(room, seat.playerId, [], true); // isTimeout=true
    }
  }
}

/**
 * Close remaining open slots by finalizing the placeholder AI seats.
 * After this, no more late joins are accepted.
 */
function _closeOpenSlots(room) {
  if (!room.openSlots || room.openSlots.length === 0) return;

  console.log(`[room ${room.id}] Closing ${room.openSlots.length} open slot(s) — filling with AI.`);

  // The placeholder AI seats already exist in room.players — just update lobby slots.
  for (const openSlot of room.openSlots) {
    const lobbySlot = room.slots[openSlot.slotIndex];
    if (lobbySlot) {
      lobbySlot.status = 'ai';
      lobbySlot.personality = 'balanced';
    }
  }

  // Broadcast that the join window is closed
  broadcast(room, { type: 'openSlotsClosed', roomId: room.id });

  // Clear the open-slot tracking so AI plan submission is no longer blocked
  room.openSlots = [];
  room.openSlotPlayerIds?.clear();
}

function _clearTurnTimer(room) {
  if (room.turnTimer) { clearTimeout(room.turnTimer); room.turnTimer = null; }
}

// ── Simultaneous planning helpers ─────────────────────────────────────────────

/** Begin a new planning phase: reset plans, compute per-player budgets, broadcast, kick AI.
 *  @param {boolean} [keepDeadline] — if true, reuse the current deadline (battle early-submit)
 */
function _startPlanningPhase(room, keepDeadline = false) {
  if (room.state.gameOver) return;
  room.phase = RoomPhase.PLANNING;
  room.state.updateNodeDiscovery();
  room.state.updateExploredHexes();
  room.state.startPlanning();
  room._nudgesThisRound = new Set(); // reset nudge tracking for the new round

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

  // Compute actual remaining time for the client countdown.
  // For battle rooms this is time until the wall-clock deadline (noon/midnight),
  // not the config interval.
  let timeoutMs = room.config.turnIntervalMs ?? TURN_TIMEOUT_MS;
  if (room.turnDeadline) {
    const remaining = room.turnDeadline - Math.floor(Date.now() / 1000);
    if (remaining > 0) timeoutMs = remaining * 1000;
  }

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
      wasIdleLastRound: (room.consecutiveTimeouts[seat.playerId] || 0) > 0,
    });
  }

  _startPlanningTimer(room, keepDeadline);
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

  // Send unified roundResolved message if this planning phase follows a resolution
  if (room._pendingResolutionSteps) {
    const steps = room._pendingResolutionSteps;
    const fs = room._pendingResolutionFinalState;
    for (const seat of room.players) {
      send(seat.ws, _buildRoundResolvedMessage(room, seat.playerId, steps, fs));
    }
    room._pendingResolutionSteps = null;
    room._pendingResolutionFinalState = null;
  }

  // Persist state — always saved with planningPhase: true so recovery
  // never loads a room stuck between rounds.
  _persistRoomSave(room);
}

/** Persist the current room state to DB for crash-recovery.
 *  Called from _startPlanningPhase so the saved state always has planningPhase: true. */
function _persistRoomSave(room) {
  if (room.state.gameOver) return;
  try {
    const snap = serializeState(room.state);
    const firstHero  = room.players.find(s => s.faction === 'hero'  && !s.isAI);
    const firstWitch = room.players.find(s => s.faction === 'witch' && !s.isAI);
    const heroName   = room.players.find(s => s.faction === 'hero')?.name  ?? '';
    const witchName  = room.players.find(s => s.faction === 'witch')?.name ?? '';
    upsertSave(room.id, firstHero?.playerId ?? null, firstWitch?.playerId ?? null,
      heroName, witchName, snap, {
        turnDeadline:        room.turnDeadline,
        turnIntervalMs:      room.config.turnIntervalMs,
        consecutiveTimeouts: room.consecutiveTimeouts,
        config:              room.config,
        players:             room.players.map(s => ({
          playerId: s.playerId, name: s.name, faction: s.faction,
          isAI: s.isAI, personality: s.personality ?? null,
          originalPlayerId: s.originalPlayerId ?? null,
          joinedAtRound: s.joinedAtRound ?? null,
        })),
        isPrivate: room.isPrivate, code: room.code, status: 'playing',
        saveVersion: SAVE_VERSION,
      });
  } catch (err) {
    console.error(`[room ${room.id}] _persistBattleSave error:`, err);
  }
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
    // Skip placeholder AIs holding open slots — they don't plan until the
    // join window closes (at which point _autoSubmitMissingPlans handles them).
    if (room.openSlotPlayerIds?.has(seat.playerId)) continue;
    // Skip admin-controlled AI — plans are generated manually via the admin panel.
    if (seat.adminControlled) continue;
    const delay = 300 + offset + Math.floor(Math.random() * 350);
    offset += 400;
    const { playerId, faction, ai } = seat;
    const ctx = faction === 'hero' ? heroCtx : witchCtx;
    setTimeout(() => {
      if (!rooms.has(room.id)) return;
      if (room.phase !== RoomPhase.PLANNING) return;
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
  if (room.phase !== RoomPhase.PLANNING) return;
  // Guard against double-submission (timeout + manual submit racing)
  if (room.state.playerReady?.get(playerId)) return;

  if (room.config.isBattle) {
    const readyBefore = [...room.state.playerReady.entries()].map(([k, v]) => `${k.slice(0,8)}=${v}`).join(', ');
    console.log(`[battle] _submitPlayerPlan: player=${playerId.slice(0,8)} plan=${plan.length} actions, isTimeout=${isTimeout}, round=${room.state.round}, readyBefore={${readyBefore}}`);
  }

  let allReady;
  try {
    allReady = room.state.submitPlayerPlan(playerId, plan);
  } catch (err) {
    console.error(`[room ${room.id}] submitPlayerPlan error (${playerId}):`, err);
    return;
  }

  // Persist plan to DB for crash recovery / hibernation
  try {
    console.log(`[room ${room.id}] persisting plan for ${playerId} round=${room.state.round} actions=${plan.length}`);
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

  // Push game-list refresh to all human players so badge/list update in real time
  for (const s of room.players) {
    if (!s.isAI) _notifyGamesUpdate(s.playerId);
  }

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

  if (room.config.isBattle) {
    const readyCount = [...room.state.playerReady.values()].filter(Boolean).length;
    const totalCount = room.state.playerReady.size;
    console.log(`[battle] After submit: allReady=${allReady} ready=${readyCount}/${totalCount} planningPhase=${room.state.planningPhase} resolving=${room.state.resolving}`);
  }

  if (allReady) {
    // Battle mode: don't resolve until both factions have at least one player.
    // The solo player's plan stays submitted; resolution triggers when an
    // opponent joins and submits, or at the daily deadline.
    if (room.config.isBattle) {
      const hasHero  = room.players.some(s => s.faction === 'hero');
      const hasWitch = room.players.some(s => s.faction === 'witch');
      if (!hasHero || !hasWitch) {
        console.log(`[battle] All plans in but only one faction present — waiting for opponent`);
        // Keep the state in planning so joining players enter the right branch.
        // submitPlayerPlan already set planningPhase=false; restore it.
        room.phase               = RoomPhase.PLANNING;
        room.state.planningPhase = true;
        room.state.resolving     = false;
        // Restart the deadline timer so the room doesn't sit forever
        if (!room.turnTimer) _startPlanningTimer(room);
        return;
      }
    }
    // Track whether this was an early submission (all players beat the deadline)
    // so the next planning phase can decide whether to keep or advance the deadline.
    room._earlySubmit = !isTimeout;
    _executeResolution(room);
  }
}

/** Run the N-player resolver, advance state, and broadcast the result. */
function _executeResolution(room) {
  _clearTurnTimer(room);
  room.phase = RoomPhase.RESOLVING;
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

  if (room.config.isBattle) {
    console.log(`[battle] _executeResolution: round=${state.round} phase=${state.phase} players=${playerEntries.length}`);
    for (const pe of playerEntries) {
      console.log(`  ${pe.faction} ${pe.playerId}: ${pe.plan.length} actions [${pe.plan.map(a => a.type).join(', ')}]`);
    }
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

  if (room.config.isBattle) {
    console.log(`[battle] Resolution complete: ${steps.length} steps, gameOver=${state.gameOver}`);
    for (const step of steps) {
      for (const pe of step.playerEvents) {
        for (const ev of pe.events) {
          const act = ev.action;
          const entity = state.entities.find(e => e.id === act?.entityId);
          const pos = entity ? `@(${entity.col},${entity.row})` : '';
          const target = act?.toCol != null ? `→(${act.toCol},${act.toRow})` : '';
          const tag = act ? `${act.type} entity=${act.entityId?.slice(0,8)}${pos}${target}` : '?';
          console.log(`  step ${step.stepIndex} ${pe.faction}: ${ev.type} ${tag}${ev.reason ? ` — ${ev.reason}` : ''}`);
        }
      }
    }
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
  // For the game-over round, include final entity state so replays can show
  // the outcome (deaths, positions) instead of falling back to preState.
  if (state.gameOver) {
    roundEntry.finalEntitiesJson = JSON.stringify(finalState.entities);
  }
  room.replayRounds.push(roundEntry);

  // Persist the round to the DB so resumed games retain full replay history
  if (!state.gameOver) {
    try {
      appendSaveRound(room.id, roundEntry.roundNum, roundEntry.preStateJson, roundEntry.stepsJson);
    } catch (err) {
      console.error(`[room ${room.id}] appendSaveRound error:`, err);
    }
  }

  // Store serialized steps for the unified roundResolved message (sent after planning starts)
  room._pendingResolutionSteps = serializedSteps;
  room._pendingResolutionFinalState = finalState;

  // Legacy message — kept for old clients
  const resolutionMsg = { type: 'resolutionComplete', steps: serializedSteps, finalState };
  broadcast(room, resolutionMsg);
  broadcastToSpectators(room, resolutionMsg);

  // Push game-list refresh to all human players so badge/list update in real time
  for (const seat of room.players) {
    if (!seat.isAI) _notifyGamesUpdate(seat.playerId);
  }

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
    _checkTimeoutTakeovers(room);
    const keepDeadline = !!room._earlySubmit && room.config.isBattle;
    room._earlySubmit = false;

    // No server-side delay — resolve → startPlanning → save is atomic.
    // The client buffers the resolution animation via shouldBufferMessages()
    // and applies the planning phase when ready.
    _startPlanningPhase(room, keepDeadline);

    // Notify disconnected human players that a new round is ready
    const opts = _notifyOpts(room);
    for (const seat of room.players) {
      if (seat.isAI) continue;
      const wasIdle = (room.consecutiveTimeouts[seat.playerId] || 0) > 0;
      notifyRoundReady(seat.playerId, {
        roomId: room.id, round: state.round,
        wasIdle, idleFaction: wasIdle ? factionFor(room, seat.playerId) : undefined,
      }, opts).catch(() => {});
    }
  }
}

/**
 * After resolution, check if any human player has hit 2+ consecutive timeouts.
 * If so, replace them with AI and notify all players.
 */
function _checkTimeoutTakeovers(room) {
  if (room.config.isBattle) {
    // Battle mode: kick players who miss 2 consecutive deadlines.
    // Same as resign — scatter units, free the slot, they can rejoin later.
    for (const seat of [...room.players]) {
      if (seat.isAI) continue;
      const count = room.consecutiveTimeouts[seat.playerId] || 0;
      if (count < 2) continue;

      const playerName = seat.name;
      const playerId   = seat.playerId;
      const faction    = seat.faction;
      console.log(`[battle] ${playerName} (${playerId}) — ${count} consecutive timeouts — kicked from battle.`);

      // Scatter units (survivors to buildings, summons vanish)
      room.state.scatterPlayerUnits(playerId);

      // Remove leader entity
      room.state.entities = room.state.entities.filter(
        e => e.ownerId !== playerId || (e.type !== 'hero' && e.type !== 'witch')
      );

      // Remove from state.players and room.players
      room.state.players = room.state.players.filter(p => p.id !== playerId);
      room.players = room.players.filter(s => s.playerId !== playerId);

      room.state.addLog(`💨 ${playerName} was removed from the battle for inactivity.`);
      _appendChronicle(room, {
        round: room.state.round, phase: room.state.phase,
        event: 'playerKicked', playerName, faction, timestamp: Date.now(),
      });

      // Notify remaining players
      const msg = { type: 'playerResigned', playerId, playerName };
      broadcast(room, msg);
      broadcastToSpectators(room, msg);

      // Notify the kicked player
      send(seat.ws, { type: 'resigned', roomId: room.id, kicked: true });

      // Push notification
      try {
        sendPush(playerId, {
          title: 'Removed from the Battle',
          body: 'You were removed for missing 2 consecutive deadlines. You can rejoin anytime.',
          roomId: room.id,
        }).catch(() => {});
      } catch { /* ignore */ }

      delete room.consecutiveTimeouts[playerId];
    }
    _broadcastPresence(room);
    // Persist so kicks survive a server restart
    _persistRoomSave(room);
    return;
  }

  // Standard games: AI takeover after 2 consecutive timeouts
  for (const seat of [...room.players]) {
    if (seat.isAI) continue;
    const count = room.consecutiveTimeouts[seat.playerId] || 0;
    if (count >= 2) {
      // Don't take over the last human player — an all-AI game with nobody
      // watching is pointless. But if they're disconnected and have timed out
      // 3+ rounds in a row, hibernate the room so it stops spinning.
      const humanCount = room.players.filter(s => !s.isAI).length;
      if (humanCount <= 1) {
        const ws = seat.ws;
        const connected = ws && ws.readyState === 1 && !ws._inactive;
        if (!connected && count >= 3) {
          console.log(`[room ${room.id}] ${seat.name} (${seat.playerId}) — ${count} consecutive timeouts, not connected — hibernating room.`);
          _hibernateRoom(room);
          return;
        }
        console.log(`[room ${room.id}] ${seat.name} (${seat.playerId}) — ${count} consecutive timeouts — skipping takeover (last human).`);
        continue;
      }

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

export function _serializeEvents(events) {
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
      // Transfer per-player planning maps so the AI can submit under the new ID
      const st = room.state;
      if (st.playerReady?.has(forPlayerId)) {
        st.playerReady.set(syntheticPlayerId, st.playerReady.get(forPlayerId));
        st.playerReady.delete(forPlayerId);
      }
      if (st.playerPlans?.has(forPlayerId)) {
        st.playerPlans.set(syntheticPlayerId, st.playerPlans.get(forPlayerId));
        st.playerPlans.delete(forPlayerId);
      }
      if (st.playerActionsLeft?.has(forPlayerId)) {
        st.playerActionsLeft.set(syntheticPlayerId, st.playerActionsLeft.get(forPlayerId));
        st.playerActionsLeft.delete(forPlayerId);
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
 * Add an extra human seat on a faction side beyond the first player.
 * Mirrors _addExtraAISeat but creates a human-controlled player instead.
 */
function _addExtraHumanSeat(room, playerId, ws, name, faction) {
  const existing = room.state.entities.filter(
    e => e.alive && e.owner === faction && (e.type === 'hero' || e.type === 'witch')
  );
  const start = existing[0] ?? { col: 0, row: 0 };
  const positions = generateMultipleStarts(room.state.tiles, start, existing.length + 1, 2, 6);
  const pos = positions[existing.length] ?? start;

  room.state.addPlayer(playerId, name, faction, pos.col, pos.row, false);

  const factionIndex = room.players.filter(s => s.faction === faction).length;
  const colors       = faction === 'hero' ? HERO_PLAYER_COLORS : WITCH_PLAYER_COLORS;
  const leader       = room.state.entities.find(e => e.ownerId === playerId);
  if (leader) leader.color = colors[factionIndex % colors.length];

  const seat = { playerId, ws, name, faction, isAI: false, ai: null };
  room.players.push(seat);
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
  room.phase = RoomPhase.FINISHED;

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
  const isBattle = !!config.isBattle;
  const maxPPS   = isBattle ? 10 : 4;
  const pps      = Math.max(1, Math.min(maxPPS, (config.playersPerSide | 0) || 1));
  const room = createRoom({
    fog:            config.fog ?? 'partial',
    mapSize:        config.mapSize ?? 'standard',
    nodeCount:      config.nodeCount ?? null,
    playersPerSide: pps,
    turnIntervalMs: config.turnIntervalMs,
    isAsync:        config.isAsync ?? false,
    isBattle,
  });
  room.isPrivate    = config.isPrivate ?? false;
  room.hostPlayerId = playerId;
  room.slots        = _buildSlots(pps, isBattle);

  // Host starts unassigned — they pick a slot in the lobby UI
  room.unassigned.push({ playerId, name: playerName, _ws: ws });

  send(ws, { type: 'lobbyJoined', lobby: _lobbyPublic(room) });
  return room.id;
}

/**
 * Join an existing lobby by room ID (public) or 6-char code (private).
 * Returns the room ID on success, or null on error/redirect.
 */
export function joinLobby(playerId, playerName, ws, codeOrId, slotIndex) {
  // Look up by code first, then by direct ID
  const byCode   = codeOrId?.length === 6 ? codeToRoom.get(codeOrId.toUpperCase()) : null;
  const roomId   = byCode ?? codeOrId;
  const room     = rooms.get(roomId);

  if (!room || (room.status !== 'lobby' && room.status !== 'playing')) {
    send(ws, { type: 'error', message: 'Lobby not found or already started.' });
    return null;
  }

  // If the game already started, redirect to late-join flow
  if (room.status === 'playing') {
    joinGame(playerId, playerName, ws, codeOrId);
    return null;
  }

  // Prevent duplicate joins (check both slots and unassigned)
  if (room.slots.some(s => s.playerId === playerId) ||
      (room.unassigned || []).some(u => u.playerId === playerId)) {
    send(ws, { type: 'error', message: 'You are already in this lobby.' });
    return null;
  }

  // Check lobby capacity (slots + unassigned)
  const totalHumans = room.slots.filter(s => s.status === 'human').length +
                      (room.unassigned || []).length;
  const totalSlots  = room.slots.length;
  if (totalHumans >= totalSlots) {
    send(ws, { type: 'error', message: 'Lobby is full.' });
    return null;
  }

  // If invited to a specific slot, place directly in it
  if (slotIndex != null) {
    const slot = room.slots[slotIndex];
    if (slot && slot.status === 'empty') {
      slot.status   = 'human';
      slot.playerId = playerId;
      slot.name     = playerName;
      slot._ws      = ws;
      send(ws, { type: 'lobbyJoined', lobby: _lobbyPublic(room) });
      broadcastLobbyUpdate(room);
      return room.id;
    }
    // Slot taken or invalid — fall through to unassigned
  }

  // Player joins as unassigned — they pick a slot in the lobby UI
  room.unassigned.push({ playerId, name: playerName, _ws: ws });

  send(ws, { type: 'lobbyJoined', lobby: _lobbyPublic(room) });
  broadcastLobbyUpdate(room);
  return room.id;
  return room.id;
}

/** Return a list of public lobbies (not yet started) and active games with open slots. */
export function browseLobby() {
  const results = [];
  for (const r of rooms.values()) {
    if (r.isPrivate) continue;
    if (r.config.isBattle) continue;  // battle has its own menu entry
    if (r.status === 'lobby') {
      results.push(_lobbyPublic(r));
    } else if (r.status === 'playing' && r.openSlots?.length > 0) {
      // Active games still accepting late joiners
      results.push(_lobbyPublic(r));
    }
  }
  return results;
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

  // Block if any humans haven't picked a slot yet
  if ((room.unassigned || []).length > 0) {
    const hostWs = room.slots.find(s => s.playerId === playerId)?._ws ??
                   (room.unassigned || []).find(u => u.playerId === playerId)?._ws;
    if (hostWs) send(hostWs, { type: 'error', message: 'All players must pick a side first.' });
    return;
  }

  for (let i = 0; i < room.slots.length; i++) {
    if (room.slots[i].status === 'empty') {
      setSlotAI(playerId, roomId, i, personality ?? 'random');
    }
  }
  // broadcastLobbyUpdate is called by each setSlotAI — fire one final authoritative update
  broadcastLobbyUpdate(room);
}

/**
 * Player claims (or switches to) an empty slot.
 * If they're unassigned, moves them into the slot.
 * If they're in another slot, frees the old slot and claims the new one.
 */
export function claimSlot(playerId, roomId, slotIndex, factionId = null) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') { return; }

  const slot = room.slots[slotIndex];
  if (!slot || slot.status !== 'empty') {
    const ws = (room.unassigned || []).find(u => u.playerId === playerId)?._ws ??
               room.slots.find(s => s.playerId === playerId)?._ws;
    if (ws) send(ws, { type: 'error', message: 'That slot is not available.' });
    return;
  }

  // Check if player is unassigned
  const uIdx = (room.unassigned || []).findIndex(u => u.playerId === playerId);
  let playerName, playerWs;

  if (uIdx >= 0) {
    // Move from unassigned to slot
    const entry = room.unassigned[uIdx];
    playerName  = entry.name;
    playerWs    = entry._ws;
    room.unassigned.splice(uIdx, 1);
  } else {
    // Switch from an existing slot
    const oldSlot = room.slots.find(s => s.playerId === playerId && s.status === 'human');
    if (!oldSlot) { return; } // player not in this lobby
    playerName = oldSlot.name;
    playerWs   = oldSlot._ws;
    // Free old slot
    oldSlot.status   = 'empty';
    oldSlot.playerId = null;
    oldSlot.name     = null;
    oldSlot._ws      = null;
  }

  // Claim the new slot
  slot.status   = 'human';
  slot.playerId = playerId;
  slot.name     = playerName;
  slot._ws      = playerWs;

  // Optional faction override at claim time. Silently ignored if it doesn't
  // belong to the slot's side; setFaction() reports the same condition with
  // an explicit error message.
  if (factionId) {
    if (getFactionsForSide(slot.side).some(f => f.id === factionId)) {
      slot.factionId = factionId;
    }
  }

  broadcastLobbyUpdate(room);
}

/**
 * Switch the faction occupying the player's current seat without moving slots.
 * Only valid pre-game (room.status === 'lobby'). The new faction must belong
 * to the same Side as the seat (you can't jump from day to night this way —
 * use claimSlot with the desired index).
 */
export function setFaction(playerId, roomId, factionId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') { return; }

  const slot = room.slots.find(s => s.playerId === playerId && s.status === 'human');
  if (!slot) { return; }

  const allowed = getFactionsForSide(slot.side).map(f => f.id);
  if (!allowed.includes(factionId)) {
    if (slot._ws) send(slot._ws, {
      type: 'error',
      message: `Faction "${factionId}" is not on the ${slot.side} side.`,
    });
    return;
  }

  if (slot.factionId === factionId) return; // no-op

  slot.factionId = factionId;
  broadcastLobbyUpdate(room);
}

/** Host starts the game. Initializes GameState and begins planning phase.
 *  Empty slots are allowed — they remain open for joining during round 1
 *  and are filled with AI when the first turn deadline expires.
 */
export function startGame(playerId, roomId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') { return; }
  if (room.hostPlayerId !== playerId)   { return; }

  // All humans must have picked a slot
  if ((room.unassigned || []).length > 0) {
    const hostWs = room.slots.find(s => s.playerId === playerId)?._ws ??
                   (room.unassigned || []).find(u => u.playerId === playerId)?._ws;
    if (hostWs) send(hostWs, { type: 'error', message: 'All players must pick a side before starting.' });
    return;
  }

  // Must have at least one human player in a slot
  if (!room.slots.some(s => s.status === 'human')) {
    const hostSlot = room.slots.find(s => s.playerId === playerId);
    send(hostSlot?._ws, { type: 'error', message: 'At least one player is required.' });
    return;
  }

  // Track empty slots that remain open for late joiners during round 1.
  // These get filled with AI at the end of the first turn deadline.
  room.openSlots = room.slots
    .map((s, i) => ({ ...s, slotIndex: i }))
    .filter(s => s.status === 'empty');

  // Determine AI flags for GameState constructor — empty slots are treated as AI
  // until a human joins (fog-of-war needs to know if a faction has any AI).
  const anyWitchAI = room.slots.some(s => s.faction === 'witch' && s.status !== 'human');
  const anyHeroAI  = room.slots.some(s => s.faction === 'hero'  && s.status !== 'human');

  // Initialize GameState
  const state      = new GameState(anyWitchAI, anyHeroAI, room.config.mapSize, room.config.nodeCount);
  state.fogOfWar   = room.config.fog;
  room.state       = state;
  room.status      = 'playing';
  room.phase       = RoomPhase.PLANNING;  // game starts in planning

  // Set of placeholder AI playerIds — these should NOT submit plans while
  // their slots remain open for late-joining humans.
  room.openSlotPlayerIds = new Set();

  // Add seats in slot order — first hero slot patches the synthetic ID, extras use addPlayer
  let heroCount  = 0;
  let witchCount = 0;
  for (const slot of room.slots) {
    if (slot.status === 'empty') {
      // Empty slots get a placeholder AI seat so the game state is valid,
      // but they stay open for late joiners.
      let placeholderSeat;
      if ((slot.faction === 'hero' && heroCount === 0) ||
          (slot.faction === 'witch' && witchCount === 0)) {
        placeholderSeat = attachAI(room, slot.faction, null, 'balanced');
      } else {
        placeholderSeat = _addExtraAISeat(room, slot.faction, 'balanced');
      }
      if (placeholderSeat) {
        room.openSlotPlayerIds.add(placeholderSeat.playerId);
        // Use a generic name instead of a thematic AI name — this slot is
        // waiting for a human, not a committed AI player.
        placeholderSeat.name = 'Open slot';
        const sp = room.state.players.find(p => p.id === placeholderSeat.playerId);
        if (sp) sp.name = 'Open slot';
      }
      if (slot.faction === 'hero')  heroCount++;
      else                          witchCount++;
      continue;
    }
    if (slot.status === 'human') {
      if ((slot.faction === 'hero' && heroCount === 0) ||
          (slot.faction === 'witch' && witchCount === 0)) {
        _addSeat(room, slot.playerId, slot._ws, slot.name, slot.faction, false);
      } else {
        _addExtraHumanSeat(room, slot.playerId, slot._ws, slot.name, slot.faction);
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
  const aiOpponent = room.slots.some(s => s.status !== 'human');
  for (const slot of room.slots) {
    if (slot.status === 'human' && slot._ws) {
      send(slot._ws, {
        type:       'matchFound',
        roomId:     room.id,
        faction:    slot.faction,
        myPlayerId: slot.playerId,
        players:    playerList,
        aiOpponent,
        isAsync:    room.config.isAsync ?? false,
        openSlots:  room.openSlots.length,
      });
    }
  }

  broadcastState(room, 'start');
  _startPlanningPhase(room);

  // Send unified gameJoined to each human player (after planning starts so budgets are ready)
  for (const slot of room.slots) {
    if (slot.status === 'human' && slot._ws) {
      send(slot._ws, _buildGameJoinedMessage(room, slot.playerId, slot.faction));
    }
  }
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
    for (const u of (room.unassigned || [])) {
      if (u._ws && u.playerId !== playerId) {
        send(u._ws, { type: 'error', message: 'The host left the lobby.' });
      }
    }
    destroyRoom(room);
    return;
  }

  // Non-host — remove from slot or unassigned list
  const slot = room.slots.find(s => s.playerId === playerId);
  if (slot) {
    slot.status   = 'empty';
    slot.playerId = null;
    slot.name     = null;
    slot._ws      = null;
    broadcastLobbyUpdate(room);
    return;
  }

  const uIdx = (room.unassigned || []).findIndex(u => u.playerId === playerId);
  if (uIdx >= 0) {
    room.unassigned.splice(uIdx, 1);
    broadcastLobbyUpdate(room);
  }
}

/**
 * Join an active game during round 1 by taking over an open (placeholder AI) slot.
 * Works via room ID or 6-char join code. Available until the first turn deadline.
 */
export function joinGame(playerId, playerName, ws, codeOrId) {
  // Look up by code first, then by direct ID
  const byCode   = codeOrId?.length === 6 ? codeToRoom.get(codeOrId.toUpperCase()) : null;
  const roomId   = byCode ?? codeOrId;
  const room     = rooms.get(roomId);

  if (!room || room.status !== 'playing') {
    // Fall back: maybe it's still in lobby status — redirect to joinLobby
    if (room?.status === 'lobby') {
      joinLobby(playerId, playerName, ws, codeOrId);
      return;
    }
    send(ws, { type: 'error', message: 'Game not found.' });
    return;
  }

  // Only joinable during round 1 while open slots remain
  if (!room.openSlots || room.openSlots.length === 0) {
    send(ws, { type: 'error', message: 'No open slots available.' });
    return;
  }
  if (room.state.round !== 1 || room.phase !== RoomPhase.PLANNING) {
    send(ws, { type: 'error', message: 'Join window has closed.' });
    return;
  }

  // Prevent duplicate joins
  if (room.players.some(s => s.playerId === playerId)) {
    send(ws, { type: 'error', message: 'You are already in this game.' });
    return;
  }

  // Pick the first open slot (witch-side preferred for balance)
  const slotIdx = room.openSlots.findIndex(s => s.faction === 'witch')
    ?? room.openSlots.findIndex(() => true);
  const openSlot = room.openSlots[slotIdx >= 0 ? slotIdx : 0];
  if (!openSlot) {
    send(ws, { type: 'error', message: 'No open slots available.' });
    return;
  }

  // Find the placeholder AI seat that was created for this slot position.
  // Match by faction + seat position (the Nth AI on that faction side).
  const factionAISeats = room.players.filter(s => s.isAI && s.faction === openSlot.faction);
  // Use the last AI seat on the faction side (most likely the placeholder)
  const placeholderSeat = factionAISeats[factionAISeats.length - 1];
  if (!placeholderSeat) {
    send(ws, { type: 'error', message: 'No placeholder seat found.' });
    return;
  }

  // Replace the placeholder AI with the human player
  const oldPlayerId = placeholderSeat.playerId;
  placeholderSeat.playerId = playerId;
  placeholderSeat.ws       = ws;
  placeholderSeat.name     = playerName;
  placeholderSeat.isAI     = false;
  placeholderSeat.ai       = null;

  // Patch state.players to reflect the human takeover
  const statePlayer = room.state.players.find(p => p.id === oldPlayerId);
  if (statePlayer) {
    statePlayer.id   = playerId;
    statePlayer.name = playerName;
    statePlayer.isAI = false;
    const leader = room.state.entities.find(e => e.id === statePlayer.leaderId);
    if (leader) leader.ownerId = playerId;
  }

  // Transfer per-player planning maps from old AI ID to new human ID
  const st = room.state;
  if (st.playerReady?.has(oldPlayerId)) {
    // If AI already submitted a plan, reset it so the human can plan
    st.playerReady.set(playerId, false);
    st.playerReady.delete(oldPlayerId);
  }
  if (st.playerPlans?.has(oldPlayerId)) {
    st.playerPlans.delete(oldPlayerId);
  }
  if (st.playerActionsLeft?.has(oldPlayerId)) {
    st.playerActionsLeft.set(playerId, st.playerActionsLeft.get(oldPlayerId));
    st.playerActionsLeft.delete(oldPlayerId);
  }

  // Update AI flags — if no more AI on this faction, clear the flag
  const factionStillHasAI = room.players.some(s => s.faction === openSlot.faction && s.isAI);
  if (openSlot.faction === 'witch') room.state.witchIsAI = factionStillHasAI;
  else                              room.state.heroIsAI  = factionStillHasAI;

  // Remove this slot from the open slots list and placeholder tracking
  room.openSlots.splice(room.openSlots.indexOf(openSlot), 1);
  room.openSlotPlayerIds?.delete(oldPlayerId);

  // Also update the lobby slot record
  const lobbySlot = room.slots[openSlot.slotIndex];
  if (lobbySlot) {
    lobbySlot.status   = 'human';
    lobbySlot.playerId = playerId;
    lobbySlot.name     = playerName;
    lobbySlot._ws      = ws;
  }

  // Send matchFound to the joining player
  const playerList = _buildPlayerList(room);
  send(ws, {
    type:       'matchFound',
    roomId:     room.id,
    faction:    openSlot.faction,
    myPlayerId: playerId,
    players:    playerList,
    aiOpponent: room.players.some(s => s.isAI),
    isAsync:    room.config.isAsync ?? false,
  });

  // Send state + planning phase info
  broadcastState(room, 'lateJoin');
  _sendReconnectPlanningState(room, playerId, ws);

  // Notify everyone else
  const joinMsg = {
    type: 'playerJoinedGame',
    playerId,
    playerName,
    faction: openSlot.faction,
    openSlots: room.openSlots.length,
  };
  broadcastExcept(room, playerId, joinMsg);
  broadcastToSpectators(room, joinMsg);

  // Broadcast updated presence
  _broadcastPresence(room);

  console.log(`[room ${room.id}] ${playerName} joined open slot (${openSlot.faction}), ${room.openSlots.length} open slots remaining.`);
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
    room = recoverRoom(roomId);
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

  // ── Battle mode: free the slot, scatter units, allow rejoin later ──────
  if (room.config.isBattle) {
    // Scatter the player's units (survivors to buildings, summons vanish)
    room.state.scatterPlayerUnits(playerId);

    // Remove the leader entity
    room.state.entities = room.state.entities.filter(
      e => e.ownerId !== playerId || (e.type !== 'hero' && e.type !== 'witch')
    );

    // Remove from state.players
    room.state.players = room.state.players.filter(p => p.id !== playerId);

    // Auto-ready if in planning so they don't block resolution
    if (room.phase === RoomPhase.PLANNING) {
      room.state.playerReady.set(playerId, true);
      room.state.playerPlans.set(playerId, []);
      room.state.playerActionsLeft.delete(playerId);
    }

    // Remove their seat from the room
    room.players = room.players.filter(s => s.playerId !== playerId);

    const msg = { type: 'playerResigned', playerId, playerName };
    broadcast(room, msg);
    broadcastToSpectators(room, msg);
    broadcastState(room, 'resign');
    _broadcastPresence(room);

    room.state.addLog(`💨 ${playerName} has left the battle.`);
    _appendChronicle(room, {
      round:    room.state.round,
      phase:    room.state.phase,
      event:    'playerResigned',
      playerName,
      faction,
      timestamp: Date.now(),
    });

    send(ws, { type: 'resigned', roomId });
    console.log(`[battle] ${playerName} resigned from battle ${room.id}`);

    // Persist immediately so the resign survives a server restart
    _persistRoomSave(room);

    // Check if all plans are now ready (the resigned player was the last holdout)
    if (room.phase === RoomPhase.PLANNING) {
      const allReady = [...room.state.playerReady.values()].every(Boolean);
      if (allReady && room.players.length > 0) {
        const hasHero  = room.players.some(s => s.faction === 'hero');
        const hasWitch = room.players.some(s => s.faction === 'witch');
        if (hasHero && hasWitch) {
          room.state.planningPhase = false;
          room.state.resolving     = true;
          _executeResolution(room);
        }
      }
    }
    return;
  }

  // ── Standard game resign ──────────────────────────────────────────────
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
    if (room.phase === RoomPhase.PLANNING) {
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

/**
 * Send a push-notification invite to a Game Center friend. Host-only.
 * The push payload includes a joinCode so the recipient deep-links into the lobby.
 */
export function sendFriendInvite(player, roomId, targetPlayerId) {
  const room = rooms.get(roomId);
  if (!room || room.status !== 'lobby') return;
  if (room.hostPlayerId !== player.id) return;
  if (!targetPlayerId || typeof targetPlayerId !== 'string') return;

  const joinCode = room.isPrivate ? room.code : room.id;
  sendPush(targetPlayerId, {
    title: `${player.username ?? 'A player'} invited you!`,
    body: "Join their game of Caleb's Hollow",
    roomId: room.id,
    joinCode,
  }).catch(() => {});
}

/** Handle a plan submission from a player. */
export function handlePlanSubmit(playerId, roomId, plan, round) {
  const room = rooms.get(roomId);
  if (!room || !room.state) return;

  const seat = seatFor(room, playerId);
  if (!seat) return;

  const state = room.state;
  if (state.gameOver) { send(seat.ws, { type: 'error', message: 'Game is over.' }); return; }
  if (room.phase !== RoomPhase.PLANNING) { send(seat.ws, { type: 'error', message: 'Not in planning phase.' }); return; }

  // Reject stale-round submissions (client sent plan for an earlier round)
  if (round != null && round !== state.round) {
    console.warn(`[room ${roomId}] Rejected stale plan from ${playerId}: client round=${round}, server round=${state.round}`);
    send(seat.ws, { type: 'error', message: `Stale plan rejected (round ${round}, current ${state.round}).` });
    return;
  }

  // Allow overwriting a previously submitted empty plan with a populated one
  if (state.playerReady.get(playerId)) {
    const existingPlan = state.playerPlans.get(playerId);
    if (existingPlan && existingPlan.length === 0 && plan.length > 0) {
      console.log(`[room ${roomId}] Overwriting empty plan for ${playerId} with ${plan.length} actions (round=${state.round})`);
      state.playerPlans.set(playerId, plan);
      try { upsertPlanStatus(roomId, playerId, state.round, plan); } catch (_) { /* best-effort */ }
      return;
    }
    send(seat.ws, { type: 'error', message: 'Plan already submitted.' });
    return;
  }

  if (!Array.isArray(plan)) { send(seat.ws, { type: 'error', message: 'Invalid plan format.' }); return; }

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

/** Handle a nudge request — one player asking another to take their turn.
 *  Limited to once per sender→target per round. */
export function handleNudge(senderId, roomId, targetPlayerId) {
  const room = rooms.get(roomId);
  if (!room || room.phase !== RoomPhase.PLANNING) return;

  const sender = seatFor(room, senderId);
  if (!sender || sender.isAI) return;

  const target = seatFor(room, targetPlayerId);
  if (!target || target.isAI) return;
  if (targetPlayerId === senderId) return;

  // Don't nudge players who already submitted
  if (room.state.playerReady?.get(targetPlayerId)) return;

  // Once per sender→target per round
  if (!room._nudgesThisRound) room._nudgesThisRound = new Set();
  const key = `${senderId}→${targetPlayerId}`;
  if (room._nudgesThisRound.has(key)) return;
  room._nudgesThisRound.add(key);

  // Send in-app WebSocket nudge to the target
  _sendToPlayer?.(targetPlayerId, {
    type: 'nudged',
    fromPlayerId: senderId,
    fromName: sender.name,
    roomId,
  });

  // Send push/email notification (fire-and-forget)
  notifyNudge(targetPlayerId, {
    roomId,
    fromName: sender.name,
  }, _notifyOpts(room)).catch(() => {});

  // Confirm to sender
  send(sender.ws, { type: 'nudgeAck', targetPlayerId });
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
  _broadcastPresence(room);

  // No immediate AI takeover on disconnect — AI only takes over after
  // 2 consecutive missed turn deadlines (_checkTimeoutTakeovers).
  // If all humans are gone, hibernate the room to DB.
  _checkAllHumansGone(room);
}

/**
 * If no human players remain connected in the room, start a grace timer
 * then hibernate (evict from memory, keep in DB for reconnect).
 * All game types use the same RECONNECT_GRACE_MS window.
 */
function _checkAllHumansGone(room) {
  if (HIBERNATION_DISABLED) return; // games stay in memory regardless
  const hasHuman = room.players.some(s => !s.isAI);
  if (hasHuman) return;
  if (room.allHumansGoneTimer) return; // already ticking

  console.log(`[room ${room.id}] all humans gone — starting ${RECONNECT_GRACE_MS / 1000}s hibernation timer.`);
  room.allHumansGoneTimer = setTimeout(() => {
    const r = rooms.get(room.id);
    if (!r) return;
    if (r.players.some(s => !s.isAI)) { r.allHumansGoneTimer = null; return; }
    console.log(`[room ${room.id}] hibernation timer expired — hibernating room.`);
    _hibernateRoom(r);
  }, RECONNECT_GRACE_MS);
}

/**
 * Persist room state to DB and remove from in-memory rooms Map.
 * The room can be recovered later via recoverRoom().
 */
function _hibernateRoom(room) {
  if (!room.state) return;
  if (HIBERNATION_DISABLED) {
    // In always-in-memory mode, persist the save for crash recovery
    // but do NOT destroy the room from memory.
    _persistRoomSave(room);
    return;
  }
  // Clean up transient flags so recovered state starts in a valid planning state.
  // Resolution is synchronous and should never be interrupted, but defend against it.
  if (room.phase === RoomPhase.RESOLVING || room.state.resolving) {
    console.log(`[room ${room.id}] hibernating with resolving=true — clearing`);
    room.state.resolving = false;
    room.phase = RoomPhase.PLANNING;
  }
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
          joinedAtRound: s.joinedAtRound ?? null,
        })),
        isPrivate: room.isPrivate,
        code:      room.code,
        status:    'playing',
        saveVersion: SAVE_VERSION,
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
export function recoverRoom(roomId) {
  const save = getSave(roomId);
  if (!save || save.status === 'finished') return null;
  if (!isVersionCompatible(save.game_version, VERSION, save.save_version, SAVE_VERSION)) return null;

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
  // Override the generated ID/code with the saved ones.
  // Remove the placeholder entry createRoom added — we'll register the room
  // under the real ID only after recovery is complete (prevents clients from
  // connecting to a half-initialized room).
  rooms.delete(room.id);
  codeToRoom.delete(room.code);
  room.id     = roomId;
  room.code   = save.code || room.code;
  room.state  = state;
  room.status = 'playing';
  room.phase  = state.gameOver ? RoomPhase.FINISHED : RoomPhase.PLANNING;
  room.isPrivate = !!save.is_private;
  room.consecutiveTimeouts = JSON.parse(save.consecutive_timeouts || '{}');

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
    if (p.joinedAtRound != null) seat.joinedAtRound = p.joinedAtRound;
    room.players.push(seat);

    // Create AI engine for AI seats
    if (p.isAI) {
      seat.ai = _makeAI(room, p.faction, p.playerId, p.personality);
      if (p.faction === 'witch') state.witchIsAI = true;
      else                       state.heroIsAI  = true;
    }
  }

  // Ensure we're in a valid planning state with correct budgets.
  if (!state.gameOver) {
    const hasSerializedPlanning = state.playerPlans.size > 0 || state.playerReady.size > 0;

    if (hasSerializedPlanning) {
      // New saves: planning data was restored by deserializeState().
      // Ensure the flags are correct.
      state.planningPhase = true;
      state.resolving = false;

      // The save may have been written before all plans were submitted
      // (e.g. AI submits after _persistRoomSave). Check the DB for any
      // plans submitted after the snapshot and merge them in.
      try {
        const planRows = getPlanStatus(roomId, state.round);
        for (const row of planRows) {
          if (row.plan_json !== null && row.submitted_at && !state.playerReady.get(row.player_id)) {
            const plan = JSON.parse(row.plan_json);
            try { state.submitPlayerPlan(row.player_id, plan); } catch {}
          }
        }
      } catch (err) {
        console.error(`[recoverRoom ${roomId}] merge DB plans error:`, err);
      }

      console.log(`[recoverRoom ${roomId}] planning data restored from save+DB (${state.playerReady.size} players, ${[...state.playerReady.values()].filter(Boolean).length} ready)`);
    } else {
      // Old saves: planning data not serialized — reconstruct from DB.
      state.planningPhase = true;
      state.resolving = false;
      state.startPlanning();

      try {
        const planRows = getPlanStatus(roomId, state.round);
        for (const row of planRows) {
          if (row.plan_json !== null && row.submitted_at) {
            const plan = JSON.parse(row.plan_json);
            try { state.submitPlayerPlan(row.player_id, plan); } catch {}
          }
        }
      } catch (err) {
        console.error(`[recoverRoom ${roomId}] restore plans from DB error:`, err);
      }
      console.log(`[recoverRoom ${roomId}] planning data restored from DB (${state.playerReady.size} players, ${[...state.playerReady.values()].filter(Boolean).length} ready)`);
    }

    // If all plans were restored and everyone is ready, resolve immediately.
    // Otherwise start the planning timer for remaining players.
    const allReady = state.players.length > 0 &&
      [...state.playerReady.values()].every(Boolean);

    // Battle mode: don't mark as ready to resolve if only one faction has players.
    // The solo player's plan stays submitted; resolution triggers when an
    // opponent joins and submits (same logic as _submitPlayerPlan).
    const battleBlocked = room.config.isBattle && (
      !room.players.some(s => s.faction === 'hero') ||
      !room.players.some(s => s.faction === 'witch')
    );

    if (allReady && !state.gameOver && !battleBlocked) {
      // All plans restored — mark as ready to resolve. Resolution will trigger
      // when the first player connects (via _submitPlayerPlan → _executeResolution).
      state.planningPhase = false;
      state.resolving = true;
      room.phase = RoomPhase.RESOLVING;
      console.log(`[recoverRoom ${roomId}] all plans restored — ready to resolve on next connect`);
    } else {
      _startPlanningTimer(room);
    }
  }

  // Restore replay rounds from DB so full-game replays include pre-save history.
  try {
    const savedRounds = getSaveRounds(roomId);
    room.replayRounds = savedRounds.map(r => ({
      roundNum:     r.round_num,
      preStateJson: r.pre_state_json,
      stepsJson:    r.steps_json,
    }));
  } catch (err) {
    console.error(`[recoverRoom ${roomId}] getSaveRounds error:`, err);
  }

  // Room is fully initialized — register it so clients can find it.
  rooms.set(room.id, room);
  if (room.code) codeToRoom.set(room.code, room.id);

  console.log(`[room ${roomId}] recovered from DB (round ${state.round}, phase ${state.phase}, ${room.replayRounds.length} replay rounds restored).`);
  return room;
}

/**
 * Load all saved games into memory at startup.
 * Calls recoverRoom() for each, skipping any that fail.
 * Returns the count of successfully loaded rooms.
 */
export function loadAllRooms() {
  const saves = getAllPlayingSaves();
  let loaded = 0;
  let skipped = 0;
  for (const save of saves) {
    if (rooms.has(save.room_id)) { skipped++; continue; }
    try {
      const room = recoverRoom(save.room_id);
      if (room) {
        loaded++;
      } else {
        skipped++;
      }
    } catch (err) {
      console.error(`[loadAllRooms] failed to recover ${save.room_id}:`, err);
      skipped++;
    }
  }
  console.log(`[loadAllRooms] loaded ${loaded} rooms, skipped ${skipped}.`);
  return loaded;
}

/** Handle a player reconnecting. */
export function handleReconnect(playerId, roomId, ws) {
  let room = rooms.get(roomId);
  if (!room) {
    // Room not in memory — try recovering from DB (e.g. after server restart)
    room = recoverRoom(roomId);
    if (!room) return false;
  }

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

    // Transfer per-player planning maps back to the human ID
    const st = room.state;
    if (st.playerReady?.has(oldAiId)) {
      st.playerReady.set(playerId, st.playerReady.get(oldAiId));
      st.playerReady.delete(oldAiId);
    }
    if (st.playerPlans?.has(oldAiId)) {
      st.playerPlans.set(playerId, st.playerPlans.get(oldAiId));
      st.playerPlans.delete(oldAiId);
    }
    if (st.playerActionsLeft?.has(oldAiId)) {
      st.playerActionsLeft.set(playerId, st.playerActionsLeft.get(oldAiId));
      st.playerActionsLeft.delete(oldAiId);
    }

    // Update AI flags on the state
    if (seat.faction === 'witch') room.state.witchIsAI = false;
    else                          room.state.heroIsAI  = false;

    broadcastExcept(room, playerId, { type: 'opponentReconnected' });
    _broadcastPresence(room);

    // Unified message — client should prefer this over the legacy sequence
    send(ws, _buildGameJoinedMessage(room, playerId, seat.faction));
    // Legacy messages — kept for old clients
    send(ws, { type: 'reconnected', faction: seat.faction, myPlayerId: playerId, roomId: room.id, isAsync: room.config.isAsync ?? false });
    send(ws, { type: 'stateUpdate', reason: 'reconnect', state: serializeState(room.state) });
    _sendReconnectPlanningState(room, playerId, ws);
    return true;
  }

  seat.ws = ws;
  broadcastExcept(room, playerId, { type: 'opponentReconnected' });
  _broadcastPresence(room);

  // Unified message — client should prefer this over the legacy sequence
  send(ws, _buildGameJoinedMessage(room, playerId, seat.faction));
  // Legacy messages — kept for old clients
  send(ws, { type: 'reconnected', faction: seat.faction, myPlayerId: playerId, roomId: room.id, isAsync: room.config.isAsync ?? false });
  send(ws, { type: 'stateUpdate', reason: 'reconnect', state: serializeState(room.state) });
  _sendReconnectPlanningState(room, playerId, ws);
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
  return [...rooms.values()].filter(room => !room.config.isBattle).map(room => ({
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
    if (room.config.isBattle) continue;  // battle games shown via getBattleStatus, not here
    const seat = room.players.find(
      s => s.playerId === playerId || s.originalPlayerId === playerId
    );
    if (!seat) continue;
    seenRoomIds.add(room.id);
    const heroName  = room.players.find(s => s.faction === 'hero')?.name  ?? '';
    const witchName = room.players.find(s => s.faction === 'witch')?.name ?? '';
    // Check if this player still needs to submit a plan
    const actionNeeded = room.phase === RoomPhase.PLANNING &&
      !room.state.playerReady?.get(playerId) &&
      !seat.isAI;
    // Count submissions for in-progress display
    const humanPlayers = room.players.filter(s => !s.isAI);
    let playersSubmitted = 0;
    if (room.phase === RoomPhase.PLANNING && room.state.playerReady) {
      for (const s of humanPlayers) {
        if (room.state.playerReady.get(s.playerId)) playersSubmitted++;
      }
    }
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
      players_submitted: playersSubmitted,
      players_total:    humanPlayers.length,
      players_json:     JSON.stringify(room.players.map(s => ({
        playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI,
      }))),
    });
  }

  // DB-hibernated games (only needed when hibernation is active)
  if (!HIBERNATION_DISABLED) try {
    const dbGames = getActiveGamesForPlayer(playerId);
    for (const g of dbGames) {
      if (seenRoomIds.has(g.room_id)) continue;
      // Extract fields from config_json
      let cfg = {};
      try {
        cfg = JSON.parse(g.config_json || '{}');
        g.is_async = cfg.isAsync ?? false;
        g.map_size = cfg.mapSize ?? 'standard';
        g.players_per_side = cfg.playersPerSide ?? 1;
      } catch {
        g.is_async = false;
        g.map_size = 'standard';
        g.players_per_side = 1;
      }
      if (cfg.isBattle) continue;  // battle games shown via getBattleStatus
      delete g.config_json;
      // Compute action_needed and submission counts from plan status
      if (g.status === 'playing') {
        try {
          const plans = getPlanStatus(g.room_id, g.round);
          const myPlan = plans.find(p => p.player_id === playerId);
          g.action_needed = myPlan ? !myPlan.submitted_at : true;
          g.players_submitted = plans.filter(p => p.submitted_at).length;
          g.players_total = plans.length;
        } catch {
          g.action_needed = true;
          g.players_submitted = 0;
          g.players_total = 0;
        }
      } else {
        g.action_needed = false;
        g.players_submitted = 0;
        g.players_total = 0;
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

  if (!isVersionCompatible(save.game_version, VERSION, save.save_version, SAVE_VERSION)) {
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
 * Admin: force-end a game. Works for active (in-memory) and saved (hibernated) games.
 * Declares a winner (or draw), notifies connected players, cleans up completely.
 * @param {string} gameId - room ID
 * @param {'active'|'saved'} source - where the game lives
 * @param {'hero'|'witch'|'draw'} winner - who wins
 * @returns {{ ok: boolean, error?: string }}
 */
export function forceEndGame(gameId, source, winner = 'draw') {
  if (source === 'active') {
    const room = rooms.get(gameId);
    if (!room) return { ok: false, error: 'Room not found.' };

    room.state.winner    = winner === 'draw' ? 'draw' : winner;
    room.state.winReason = 'Game ended by admin.';
    room.phase = RoomPhase.FINISHED;

    // Notify connected players
    const snap = serializeState(room.state);
    broadcast(room, { type: 'stateUpdate', reason: 'adminForceEnd', state: snap });

    // Record stats and clean up (same as normal game-over)
    try { clearAllPlanStatus(room.id); } catch {}
    try { deleteSave(room.id); } catch {}

    // Destroy after a brief delay so clients receive the final state
    setTimeout(() => {
      if (rooms.has(gameId)) destroyRoom(rooms.get(gameId));
    }, 2000);

    console.log(`[admin] force-ended active game ${gameId} — winner: ${winner}`);
    return { ok: true };
  }

  if (source === 'saved') {
    const save = getSave(gameId);
    if (!save) return { ok: false, error: 'Save not found.' };

    // Mark the save as finished so it's never recovered
    try {
      upsertSave(gameId, save.hero_player_id, save.witch_player_id,
        save.hero_name, save.witch_name, save.state,
        { status: 'finished' });
    } catch (err) {
      return { ok: false, error: `Failed to update save: ${err.message}` };
    }

    try { clearAllPlanStatus(gameId); } catch {}

    console.log(`[admin] force-ended saved game ${gameId} — winner: ${winner}`);
    return { ok: true };
  }

  return { ok: false, error: `Cannot end games with source '${source}'.` };
}

/**
 * Admin: kick a player from a battle game. Same effect as resign —
 * scatters their units, frees the slot, and notifies remaining players.
 * Only works for active battle-mode rooms.
 * @param {string} roomId
 * @param {string} playerId
 * @returns {{ ok: boolean, error?: string }}
 */
export function adminKickPlayer(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!room.config.isBattle) return { ok: false, error: 'Kick is only supported for battle-mode games.' };
  if (room.state?.gameOver) return { ok: false, error: 'Game is already over.' };

  const seat = room.players.find(s => s.playerId === playerId);
  if (!seat) return { ok: false, error: 'Player not found in this game.' };

  const playerName = seat.name ?? 'A player';
  const faction    = seat.faction;

  // Scatter units (survivors to buildings, summons vanish)
  room.state.scatterPlayerUnits(playerId);

  // Remove leader entity
  room.state.entities = room.state.entities.filter(
    e => e.ownerId !== playerId || (e.type !== 'hero' && e.type !== 'witch')
  );

  // Remove from state.players and room.players
  room.state.players = room.state.players.filter(p => p.id !== playerId);

  // Auto-ready if in planning so they don't block resolution
  if (room.phase === RoomPhase.PLANNING) {
    room.state.playerReady.set(playerId, true);
    room.state.playerPlans.set(playerId, []);
    room.state.playerActionsLeft.delete(playerId);
  }

  room.players = room.players.filter(s => s.playerId !== playerId);

  room.state.addLog(`💨 ${playerName} was removed from the battle by an admin.`);
  _appendChronicle(room, {
    round: room.state.round, phase: room.state.phase,
    event: 'playerKicked', playerName, faction, timestamp: Date.now(),
  });

  // Notify remaining players and spectators
  const msg = { type: 'playerResigned', playerId, playerName };
  broadcast(room, msg);
  broadcastToSpectators(room, msg);
  broadcastState(room, 'admin-kick');
  _broadcastPresence(room);

  // Notify the kicked player if they're connected
  send(seat.ws, { type: 'resigned', roomId: room.id, kicked: true });

  // Persist immediately
  _persistRoomSave(room);

  console.log(`[admin] kicked ${playerName} (${playerId}) from battle ${room.id}`);

  // Check if all plans are now ready
  if (room.phase === RoomPhase.PLANNING) {
    const allReady = [...room.state.playerReady.values()].every(Boolean);
    if (allReady && room.players.length > 0) {
      const hasHero  = room.players.some(s => s.faction === 'hero');
      const hasWitch = room.players.some(s => s.faction === 'witch');
      if (hasHero && hasWitch) {
        room.state.planningPhase = false;
        room.state.resolving     = true;
        _executeResolution(room);
      }
    }
  }

  return { ok: true };
}

/**
 * Admin: completely delete a game from all storage.
 * Notifies connected clients, removes from rooms Map, and deletes from all DB tables.
 */
export function nukeGame(gameId) {
  const room = rooms.get(gameId);
  if (room) {
    // Notify connected players so their clients show game-over
    if (room.state) {
      room.state.winner    = 'draw';
      room.state.winReason = 'Game deleted by admin.';
      room.phase = RoomPhase.FINISHED;
      const snap = serializeState(room.state);
      broadcast(room, { type: 'stateUpdate', reason: 'adminForceEnd', state: snap });
    }
    // Destroy after a brief delay so clients receive the final state
    setTimeout(() => {
      if (rooms.has(gameId)) destroyRoom(rooms.get(gameId));
    }, 2000);
  }

  // Remove from all DB tables
  try { clearAllPlanStatus(gameId); } catch (err) {
    console.error(`[nukeGame] clearAllPlanStatus error for ${gameId}:`, err);
  }
  try { deleteSave(gameId); } catch (err) {
    console.error(`[nukeGame] deleteSave error for ${gameId}:`, err);
  }

  console.log(`[admin] nuked game ${gameId}`);
  return { ok: true };
}

/**
 * Rejoin a game. Tries in-memory first; falls back to DB recovery.
 */
export function resumeGame(playerId, ws, roomId) {
  if (rooms.has(roomId)) {
    const room = rooms.get(roomId);
    // If room isn't in planning (e.g. stuck in resolving or between rounds), fix it
    if (room.phase !== RoomPhase.PLANNING && room.phase !== RoomPhase.FINISHED) {
      console.log(`[room ${roomId}] resumeGame: phase=${room.phase} — forcing planning`);
      room.state.resolving = false;
      _startPlanningPhase(room);
    }
    const rejoined = handleReconnect(playerId, roomId, ws);
    if (rejoined) return;
  }

  // Try recovering the room from DB (hibernated game)
  const room = recoverRoom(roomId);
  if (room) {
    const rejoined = handleReconnect(playerId, roomId, ws);
    if (rejoined) {
      if (room.phase === RoomPhase.PLANNING) {
        // Already in planning — restart timer and kick AI plans
        _startPlanningTimer(room);
        _runAIPlanSubmission(room);
      } else if (room.phase !== RoomPhase.FINISHED) {
        // Stuck in resolving or between rounds — force planning
        console.log(`[room ${roomId}] resumeGame (DB recovery): phase=${room.phase} — forcing planning`);
        room.state.resolving = false;
        _startPlanningPhase(room);
      }
      return;
    }
  }

  send(ws, { type: 'error', message: 'Game is no longer active.' });
}

// ── Async (play-by-mail) game support ───────────────────────────────────────
//
// ── Async game rooms (extracted to ./async-game-rooms.js) ───────────────────
// Re-export all async functions so callers don't need to update their imports.
import {
  asyncSessions,
  setNotifyGamesUpdate as _setAsyncNotify,
  createAsyncGameRoom,
  joinAsyncGameRoom,
  connectToAsyncGame,
  handleAsyncPlanSubmit,
  handleAsyncDisconnect,
} from './async-game-rooms.js';

// Wire up the _notifyGamesUpdate dependency
_setAsyncNotify(_notifyGamesUpdate);

export { asyncSessions, createAsyncGameRoom, joinAsyncGameRoom,
         connectToAsyncGame, handleAsyncPlanSubmit, handleAsyncDisconnect };


// ── Battle for Caleb's Hollow ────────────────────────────────────────────────

/**
 * Create a new Battle for Caleb's Hollow room.
 * Called by the battle scheduler on server startup / weekly cron.
 * Returns the room ID.
 *
 * @param {{ endsAt: number, battleDeadlineHour?: number }} battleOpts
 */
export function createBattleRoom(battleOpts = {}) {
  const endsAt = battleOpts.endsAt ?? Math.floor(Date.now() / 1000) + 7 * 86400;
  const room = createRoom({
    fog:            'partial',
    mapSize:        'battle',
    nodeCount:      5,
    playersPerSide: 10,
    isAsync:        true,
    isBattle:       true,
    // Twice-daily deadline (noon + midnight PST) — 12 hours per turn
    turnIntervalMs: 43_200_000,
  });
  room.status = 'playing';  // battles skip the lobby phase
  room.phase  = RoomPhase.PLANNING;
  room.isPrivate = false;

  // Initialize GameState with battle-sized map (42×42)
  const state = new GameState(false, false, 'battle', 5);
  state.fogOfWar   = 'partial';
  state.gameMode   = GameMode.BATTLE;
  state.battleConfig = { endsAt, maxPlayersPerSide: 10 };

  // Remove the default hero/witch entities and player entries created by the
  // constructor — battle mode players join dynamically via joinBattle().
  state.entities = [];
  state.players  = [];
  state.hero     = null;
  state.witch    = null;

  room.state = state;

  // No slots pre-built — players join dynamically via joinBattle()
  room.slots = [];
  room.openSlotPlayerIds = new Set();
  room.openSlots = [];

  console.log(`[battle] Created Battle room ${room.id} (ends at ${new Date(endsAt * 1000).toISOString()})`);
  return room.id;
}

/**
 * Join an active Battle for Caleb's Hollow room.
 * Assigns the player to the undermanned faction and spawns their leader.
 * Can be called at any round (not limited to Round 1).
 *
 * If roomId is provided, joins that specific room (for reconnect / "Return to Battle").
 * If roomId is omitted, auto-selects the best available room or creates a new one.
 *
 * @returns {{ roomId: string, faction: string }|null}
 */
export function joinBattle(playerId, playerName, ws, roomId) {
  let room;
  if (roomId) {
    room = rooms.get(roomId);
  }

  // If no specific room (or invalid roomId), check if the player is already in a battle
  if (!room || !room.config.isBattle) {
    const battleRooms = getActiveBattleRooms();
    for (const br of battleRooms) {
      if (br.players.find(s => s.playerId === playerId)) {
        room = br;
        break;
      }
    }
  }

  // Still no room — auto-select the best available or create a new one
  if (!room || !room.config.isBattle) {
    room = pickBestBattleRoom();
    if (!room) {
      // All rooms full — create a new one with the same endsAt
      const existing = getActiveBattleRoom();
      const endsAt = existing?.state?.battleConfig?.endsAt ?? undefined;
      const newRoomId = createBattleRoom({ endsAt });
      room = rooms.get(newRoomId);
      if (!room) {
        send(ws, { type: 'error', message: 'Could not create a new Battle room.' });
        return null;
      }
    }
  }

  // ── Reconnect: existing player returning ──────────────────────────────
  const existingSeat = room.players.find(s => s.playerId === playerId);
  if (existingSeat) {
    existingSeat.ws = ws;
    const faction = existingSeat.faction;

    // If room isn't in planning (e.g. stuck in resolving after restart),
    // force it back to planning so the player can act.
    if (room.phase !== RoomPhase.PLANNING && room.phase !== RoomPhase.FINISHED) {
      console.log(`[battle] reconnect: room ${room.id} phase=${room.phase} — forcing planning`);
      room.state.resolving = false;
      _startPlanningPhase(room);
    }

    // Use matchFound — the reliable game-entry path.
    send(ws, {
      type:       'matchFound',
      roomId:     room.id,
      faction,
      myPlayerId: playerId,
      players:    _buildPlayerList(room),
      aiOpponent: false,
      isAsync:    true,
      isBattle:   true,
    });
    send(ws, { type: 'stateUpdate', reason: 'battleReconnect', state: serializeState(room.state) });
    // Unified message
    send(ws, _buildGameJoinedMessage(room, playerId, faction));

    // Send planning state if in planning phase
    if (room.phase === RoomPhase.PLANNING) {
      const budget = room.state.playerActionsLeft?.get(playerId)
        ?? (faction === 'hero' ? room.state.heroActionsLeft : room.state.witchActionsLeft);

      // Send submitted plan if the player already submitted this round.
      const isReady = !!room.state.playerReady.get(playerId);
      const submittedPlan = isReady
        ? (room.state.playerPlans.get(playerId) ?? null)
        : null;

      let timeoutMs = 0;
      if (room.turnDeadline) {
        const remaining = room.turnDeadline - Math.floor(Date.now() / 1000);
        if (remaining > 0) timeoutMs = remaining * 1000;
      }

      // Send replay if player was present for the previous round
      const wasPresent = (existingSeat.joinedAtRound ?? 0) < room.state.round;
      const lastReplay = (!submittedPlan && wasPresent) ? _getLastUnwatchedReplay(room) : null;

      send(ws, {
        type:            'planningPhase',
        myActionsLeft:   budget,
        heroActionsLeft:  room.state.heroActionsLeft,
        witchActionsLeft: room.state.witchActionsLeft,
        timeoutMs,
        players:          _buildPlayerList(room),
        submittedPlan,
        lastReplay,
      });
    }

    _broadcastPresence(room);
    console.log(`[battle] ${playerName} reconnected to battle ${room.id} as ${faction}`);
    return { roomId: room.id, faction };
  }

  // ── New player joining ────────────────────────────────────────────────
  const heroCount  = room.players.filter(s => s.faction === 'hero').length;
  const witchCount = room.players.filter(s => s.faction === 'witch').length;

  const maxPPS = room.state.battleConfig?.maxPlayersPerSide ?? 10;
  if (heroCount >= maxPPS && witchCount >= maxPPS) {
    send(ws, { type: 'error', message: 'Battle is full. You may spectate instead.' });
    return null;
  }

  // Assign to undermanned faction (tie-break: hero first)
  let faction;
  if (heroCount <= witchCount && heroCount < maxPPS) faction = 'hero';
  else if (witchCount < maxPPS) faction = 'witch';
  else faction = 'hero';

  const starts = generateBattleStarts(room.state.tiles, faction, 1);
  if (!starts.length) {
    send(ws, { type: 'error', message: 'No available spawn position.' });
    return null;
  }

  const leader = room.state.addPlayer(playerId, playerName, faction, starts[0].col, starts[0].row, false);
  const factionPlayers = room.state.players.filter(p => p.faction === faction);
  const colors = faction === 'hero' ? HERO_PLAYER_COLORS : WITCH_PLAYER_COLORS;
  leader.color = colors[(factionPlayers.length - 1) % colors.length];

  room.players.push({
    playerId, ws, name: playerName, faction,
    isAI: false, ai: null, personality: null,
    joinedAtRound: room.state.round,
  });

  // Send matchFound → stateUpdate → planningPhase — same clean sequence as reconnect
  send(ws, {
    type:       'matchFound',
    roomId:     room.id,
    faction,
    myPlayerId: playerId,
    players:    _buildPlayerList(room),
    aiOpponent: false,
    isAsync:    true,
    isBattle:   true,
  });

  // Notify existing players
  broadcastExcept(room, playerId, {
    type: 'playerJoinedBattle', playerId, playerName, faction,
  });
  broadcastState(room, 'playerJoined');

  // Ensure the room is in planning (may have been saved between rounds or
  // stuck in resolving after a server restart).
  if (room.phase !== RoomPhase.PLANNING && room.phase !== RoomPhase.FINISHED) {
    console.log(`[battle] new player join: room ${room.id} phase=${room.phase} — forcing planning`);
    room.state.resolving = false;
    _startPlanningPhase(room);
  }

  // Add the new player to the planning phase
  if (room.phase === RoomPhase.PLANNING) {
    // Already in planning — add the new player to the existing phase
    const readyBefore = [...room.state.playerReady.entries()].map(([k, v]) => `${k.slice(0,8)}=${v}`).join(', ');
    console.log(`[battle] adding player ${playerId.slice(0,8)} to planning, readyBefore={${readyBefore}}`);
    room.state.playerReady.set(playerId, false);
    const nb = countHeldNodes(faction, room.state.witchObjectives, room.state.entities);
    room.state.playerActionsLeft.set(playerId, computeActionsForPlayer(playerId, faction, room.state.phase, room.state.entities, nb));

    let timeoutMs = 0;
    if (room.turnDeadline) {
      const remaining = room.turnDeadline - Math.floor(Date.now() / 1000);
      if (remaining > 0) timeoutMs = remaining * 1000;
    }

    // Legacy planningPhase message
    send(ws, {
      type:            'planningPhase',
      myActionsLeft:   room.state.playerActionsLeft.get(playerId) ?? 0,
      heroActionsLeft:  room.state.heroActionsLeft,
      witchActionsLeft: room.state.witchActionsLeft,
      timeoutMs,
      players:          _buildPlayerList(room),
    });
    // Unified message
    send(ws, _buildGameJoinedMessage(room, playerId, faction));
  } else {
    // First player — start a fresh planning phase
    _startPlanningPhase(room);
    send(ws, _buildGameJoinedMessage(room, playerId, faction));
  }

  _broadcastPresence(room);

  // Log and chronicle the join
  const factionLabel = faction === 'hero' ? 'Hero' : 'Witch';
  room.state.addLog(`⚡ ${playerName} has joined the battle as ${factionLabel}!`);
  _appendChronicle(room, {
    round:    room.state.round,
    phase:    room.state.phase,
    event:    'playerJoined',
    playerName,
    faction,
    timestamp: Date.now(),
  });

  console.log(`[battle] ${playerName} joined Battle ${room.id} as ${faction} (${heroCount + (faction === 'hero' ? 1 : 0)}v${witchCount + (faction === 'witch' ? 1 : 0)})`);

  // Persist so the new player survives a server restart
  _persistRoomSave(room);

  return { roomId: room.id, faction };
}

/**
 * Get the first active battle room, if any.
 * @returns {Room|null}
 */
export function getActiveBattleRoom() {
  for (const [, room] of rooms) {
    if (room.config.isBattle && room.status === 'playing') return room;
  }
  return null;
}

/**
 * Get all active battle rooms.
 * @returns {Room[]}
 */
export function getActiveBattleRooms() {
  const result = [];
  for (const [, room] of rooms) {
    if (room.config.isBattle && room.status === 'playing') result.push(room);
  }
  return result;
}

/**
 * Pick the best battle room for a new player to join.
 * Prefers rooms with fewer open slots (more populated), then better faction balance.
 * @returns {Room|null} — null if all rooms are full.
 */
export function pickBestBattleRoom() {
  const battleRooms = getActiveBattleRooms();
  const candidates = [];
  for (const room of battleRooms) {
    const maxPPS = room.state?.battleConfig?.maxPlayersPerSide ?? 10;
    const heroCount = room.players.filter(s => s.faction === 'hero').length;
    const witchCount = room.players.filter(s => s.faction === 'witch').length;
    if (heroCount < maxPPS || witchCount < maxPPS) {
      const openSlots = (maxPPS - heroCount) + (maxPPS - witchCount);
      const imbalance = Math.abs(heroCount - witchCount);
      candidates.push({ room, openSlots, imbalance });
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    if (a.openSlots !== b.openSlots) return a.openSlots - b.openSlots;
    return a.imbalance - b.imbalance;
  });
  return candidates[0].room;
}

/** Build a per-room summary object for the battle status API. */
function _battleRoomSummary(room) {
  const state = room.state;
  const maxPPS = state?.battleConfig?.maxPlayersPerSide ?? 10;
  const heroCount = room.players.filter(s => s.faction === 'hero').length;
  const witchCount = room.players.filter(s => s.faction === 'witch').length;
  return {
    roomId:     room.id,
    heroCount,
    witchCount,
    maxPerSide: maxPPS,
    heroScore:  state?.nodeScore?.hero ?? 0,
    witchScore: state?.nodeScore?.witch ?? 0,
    round:      state?.round ?? 0,
    openSlots:  (maxPPS - heroCount) + (maxPPS - witchCount),
    isFull:     heroCount >= maxPPS && witchCount >= maxPPS,
  };
}

/**
 * Get battle status for the multiplayer menu.
 * Returns null if no active battles, or a multi-room summary.
 */
export function getBattleStatus(playerId = null) {
  const battleRooms = getActiveBattleRooms();
  if (battleRooms.length === 0) return null;

  // Build per-room summaries
  const battles = battleRooms.map(r => _battleRoomSummary(r));

  // Shared endsAt (all rooms share the same battle period)
  const endsAt = battleRooms[0].state?.battleConfig?.endsAt ?? 0;

  // Aggregate counts across all rooms
  let totalHeroes = 0, totalWitches = 0, allFull = true;
  for (const b of battles) {
    totalHeroes += b.heroCount;
    totalWitches += b.witchCount;
    if (!b.isFull) allFull = false;
  }

  // Find the player's battle (if any)
  let myBattle = null;
  if (playerId) {
    for (const room of battleRooms) {
      const seat = room.players.find(s => s.playerId === playerId);
      if (seat) {
        const state = room.state;
        myBattle = {
          roomId:      room.id,
          heroCount:   room.players.filter(s => s.faction === 'hero').length,
          witchCount:  room.players.filter(s => s.faction === 'witch').length,
          maxPerSide:  state?.battleConfig?.maxPlayersPerSide ?? 10,
          heroScore:   state?.nodeScore?.hero ?? 0,
          witchScore:  state?.nodeScore?.witch ?? 0,
          round:       state?.round ?? 0,
          endsAt,
          players: room.players.map(s => ({
            playerId:  s.playerId,
            name:      s.name,
            faction:   s.faction,
            isAI:      s.isAI,
            submitted: !!state?.playerReady?.get(s.playerId),
            connected: s.isAI || !!(s.ws?.readyState === 1),
            active:    s.isAI || !!(s.ws?.readyState === 1 && !s.ws._inactive),
          })),
          joined:      true,
          myFaction:   seat.faction,
          mySubmitted: !!state?.playerReady?.get(seat.playerId),
          turnDeadline: room.turnDeadline ?? null,
        };
        break;
      }
    }
  }

  return {
    totalBattles: battles.length,
    totalHeroes,
    totalWitches,
    endsAt,
    allFull,
    battles,
    myBattle,
  };
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

      // Capture which players timed out before auto-submitting
      const timedOutPlayerIds = new Set(
        plans.filter(p => !p.submitted).map(p => p.player_id)
      );

      // Auto-submit empty plans for players who haven't submitted
      for (const p of plans) {
        if (!p.submitted) {
          submitAsyncPlan(roomId, p.player_id, game.round, []);
        }
      }

      _resolveAsyncRound(roomId, timedOutPlayerIds);
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
export { _checkTimeoutTakeovers as checkTimeoutTakeoversForTest };

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

      const room = recoverRoom(roomId);
      if (!room) continue;

      // If room isn't in planning, force it
      if (room.phase !== RoomPhase.PLANNING && room.phase !== RoomPhase.FINISHED) {
        room.state.resolving = false;
        _startPlanningPhase(room);
      }

      if (room.phase === RoomPhase.PLANNING) {
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
  // Standard async games: 10-minute warning
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
      if (config.isBattle) continue; // battle has its own wider window below

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

  // Battle mode: 1-hour warning
  let battleGames;
  try {
    battleGames = getApproachingDeadlineGames(3_600_000); // 60 minutes
  } catch (err) {
    console.error('[checkApproachingDeadlines] battle query error:', err);
    return;
  }

  for (const row of battleGames) {
    try {
      const config = row.config_json ? JSON.parse(row.config_json) : {};
      if (!config.isBattle) continue;

      const minutesLeft = Math.max(1, Math.round((row.turn_deadline - Date.now() / 1000) / 60));
      const plans = getPlanStatus(row.room_id, row.round);

      for (const p of plans) {
        if (p.submitted_at) continue;
        notifyBattleDeadlineApproaching(p.player_id, {
          roomId: row.room_id, minutesLeft,
        }, { isAsync: true }).catch(() => {});
      }
    } catch (err) {
      console.error(`[checkApproachingDeadlines] battle room ${row.room_id} error:`, err);
    }
  }
}

// ── Async → Unified migration ───────────────────────────────────────────────

/**
 * Migrate existing async_games rows to the unified game_saves table.
 * Called once at startup. Skips games that already have a game_saves row.
 */
export function migrateAsyncGames() {
  const rows = db.async.listForMigration();

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
            saveVersion: SAVE_VERSION,
          },
        );

        // Copy plan status rows
        const plans = db.async.listPlansForRoom(g.room_id);
        for (const p of plans) {
          try {
            const planData = p.plan_json ? JSON.parse(p.plan_json) : null;
            if (planData) {
              upsertPlanStatus(g.room_id, p.player_id, p.round, planData);
            }
          } catch {}
        }

        migrated++;
      }

      // Mark async game as migrated by setting status
      db.async.markMigrated(g.room_id);
    } catch (err) {
      console.error(`[migration] Error migrating async game ${g.room_id}:`, err);
    }
  }

  if (migrated > 0) console.log(`[migration] Migrated ${migrated} async game(s) to unified system.`);
  return migrated;
}

// ── Remote AI battle helpers ────────────────────────────────────────────────
// Used by the admin panel / CLI to add admin-controlled AI players to existing
// battle rooms.  These AI seats have `adminControlled = true` so
// _runAIPlanSubmission skips them — turns are triggered manually.

/**
 * Add an admin-controlled AI player to an existing battle room.
 * @param {string} roomId
 * @param {string} faction  - 'hero' | 'witch'
 * @param {object} [opts]
 * @param {string} [opts.personality] - AI personality key
 * @param {string} [opts.name]       - Display name override
 * @returns {{ ok: boolean, playerId?: string, error?: string }}
 */
export function addRemoteAI(roomId, faction, opts = {}) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, error: 'Room not found.' };
  if (!room.config.isBattle) return { ok: false, error: 'Remote AI is only supported for battle rooms.' };
  if (room.state?.gameOver) return { ok: false, error: 'Game is already over.' };

  if (faction !== 'hero' && faction !== 'witch') {
    return { ok: false, error: 'Faction must be "hero" or "witch".' };
  }

  const maxPPS = room.state.battleConfig?.maxPlayersPerSide ?? 10;
  const factionCount = room.players.filter(s => s.faction === faction).length;
  if (factionCount >= maxPPS) {
    return { ok: false, error: `${faction} side is full (${maxPPS} max).` };
  }

  const playerId = `ai-${faction}-${randomUUID().slice(0, 8)}`;
  const usedNames = new Set(room.players.map(s => s.name));
  const name = opts.name || pickAIName(faction, usedNames);

  // Spawn on the map
  const starts = generateBattleStarts(room.state.tiles, faction, 1);
  if (!starts.length) return { ok: false, error: 'No available spawn position.' };
  const leader = room.state.addPlayer(playerId, name, faction, starts[0].col, starts[0].row, true);
  const colors = faction === 'hero' ? HERO_PLAYER_COLORS : WITCH_PLAYER_COLORS;
  leader.color = colors[factionCount % colors.length];

  // Create AI engine
  const ai = _makeAI(room, faction, playerId, opts.personality ?? null);

  // Create an admin-controlled seat
  room.players.push({
    playerId, ws: null, name, faction,
    isAI: true, ai, personality: opts.personality ?? 'balanced',
    adminControlled: true,
    joinedAtRound: room.state.round,
  });

  // If currently in planning, add budget for the new player
  if (room.phase === RoomPhase.PLANNING) {
    room.state.playerReady.set(playerId, false);
    room.state.playerPlans.set(playerId, null);
    const nodeBonus = countHeldNodes(faction, room.state.witchObjectives, room.state.entities);
    const budget = computeActionsForPlayer(playerId, faction, room.state.phase, room.state.entities, nodeBonus);
    room.state.playerActionsLeft.set(playerId, budget);
  }

  broadcastState(room, 'remote-ai-added');
  _broadcastPresence(room);
  _persistRoomSave(room);

  console.log(`[remote-ai] Added admin-controlled ${faction} AI "${name}" (${opts.personality ?? 'balanced'}) to room ${room.id.slice(0, 8)}`);
  return { ok: true, playerId, name };
}

/**
 * Generate and submit a plan for an admin-controlled AI player.
 * @param {string} roomId
 * @param {string} playerId
 * @returns {{ ok: boolean, plan?: Array, error?: string }}
 */
export function generateRemoteAIPlan(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, error: 'Room not found.' };
  if (room.phase !== RoomPhase.PLANNING) return { ok: false, error: `Room is not in planning phase (current: ${room.phase}).` };
  if (room.state.playerReady?.get(playerId)) return { ok: false, error: 'Plan already submitted for this round.' };

  const seat = room.players.find(s => s.playerId === playerId);
  if (!seat) return { ok: false, error: 'Player not found.' };
  if (!seat.adminControlled) return { ok: false, error: 'Player is not admin-controlled.' };
  if (!seat.ai) return { ok: false, error: 'No AI engine on this seat.' };

  // Build ally context from already-submitted plans on this faction
  const allyContext = { claimedNodes: new Set(), allyPositions: [] };
  for (const s of room.players) {
    if (s.faction !== seat.faction || s.playerId === playerId) continue;
    if (room.state.playerReady?.get(s.playerId)) {
      const leader = room.state.entities.find(
        e => e.alive && e.ownerId === s.playerId && (e.type === 'hero' || e.type === 'witch')
      );
      if (leader) allyContext.allyPositions.push({ col: leader.col, row: leader.row });
    }
  }

  let plan;
  try {
    plan = seat.ai.generatePlan(allyContext);
  } catch (err) {
    console.error(`[remote-ai] Plan generation error for ${seat.name}:`, err);
    return { ok: false, error: `Plan generation failed: ${err.message}` };
  }

  _submitPlayerPlan(room, playerId, plan);

  console.log(`[remote-ai] Generated ${plan.length} actions for ${seat.name} (round ${room.state.round})`);
  return { ok: true, plan };
}

/**
 * Submit an externally-generated plan (e.g. from an LLM) for an admin-controlled player.
 */
export function submitRemoteAIPlan(roomId, playerId, plan) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, error: 'Room not found.' };
  if (room.phase !== RoomPhase.PLANNING) return { ok: false, error: 'Room is not in planning phase.' };
  if (room.state.playerReady?.get(playerId)) return { ok: false, error: 'Plan already submitted.' };

  const seat = room.players.find(s => s.playerId === playerId);
  if (!seat) return { ok: false, error: 'Player not found.' };
  if (!seat.adminControlled) return { ok: false, error: 'Player is not admin-controlled.' };

  _submitPlayerPlan(room, playerId, plan);
  return { ok: true };
}

/**
 * Resign an admin-controlled AI player from a battle room.
 * Re-uses the same scatter+remove logic as adminKickPlayer.
 */
export function resignRemoteAI(roomId, playerId) {
  const room = rooms.get(roomId);
  if (!room) return { ok: false, error: 'Room not found.' };

  const seat = room.players.find(s => s.playerId === playerId);
  if (!seat) return { ok: false, error: 'Player not found.' };
  if (!seat.adminControlled) return { ok: false, error: 'Player is not admin-controlled.' };

  // Use the existing admin kick flow
  return adminKickPlayer(roomId, playerId);
}

/**
 * List all admin-controlled AI players across all active battle rooms.
 * @returns {{ roomId: string, players: object[] }[]}
 */
export function listRemoteAIs() {
  const results = [];
  for (const room of rooms.values()) {
    if (!room.config.isBattle) continue;
    const remotes = room.players
      .filter(s => s.adminControlled)
      .map(s => ({
        playerId:    s.playerId,
        name:        s.name,
        faction:     s.faction,
        personality: s.personality ?? 'balanced',
        submitted:   !!room.state?.playerReady?.get(s.playerId),
        leader:      _remoteLeaderSummary(room.state, s.playerId),
        entityCount: room.state.entities.filter(e => e.alive && e.ownerId === s.playerId).length,
      }));
    if (remotes.length > 0) {
      results.push({
        roomId: room.id,
        round:  room.state.round,
        phase:  room.phase,
        remotes,
      });
    }
  }
  return results;
}

function _remoteLeaderSummary(state, playerId) {
  const p = state.players.find(pl => pl.id === playerId);
  if (!p) return null;
  const leader = state.entities.find(e => e.id === p.leaderId && e.alive);
  if (!leader) return { alive: false };
  return { alive: true, hp: leader.hp, maxHp: leader.maxHp, col: leader.col, row: leader.row };
}

// ── Async session helpers ───────────────────────────────────────────────────

