// Lobby: room lifecycle, server-side AI, action dispatch
import { randomUUID } from 'crypto';
import { GameState, Player } from '../src/game.js';
import { WitchAI, HeroAI, HERO_PERSONALITIES, WITCH_PERSONALITIES } from '../src/ai.js';
import { serializeState, deserializeState } from './state-sync.js';
import { recordResult }                    from './leaderboard.js';
import { recordGameStats }                 from './game-stats.js';
import { resolvePlansMP, ResEventType }    from './resolver.js';
import { compileTurnBattleSummary }        from '../src/battle-utils.js';
import { PlanActionType }                  from '../src/planner.js';
import { upsertSave, deleteSave, getSave,
         createCompletedGame, appendSaveRound,
         getSaveRounds }                   from './saves.js';
import { VERSION }                         from '../src/version.js';
import { generateMultipleStarts }          from '../src/map.js';
import { HERO_PLAYER_COLORS, WITCH_PLAYER_COLORS } from '../src/entities.js';

// ── Constants ────────────────────────────────────────────────────────────────
const RECONNECT_GRACE_MS = 60_000; // time to reconnect before forfeit
const AI_TAKEOVER_MS     = 12_000; // replace disconnected player with AI after 12s
const TURN_TIMEOUT_MS    = 90_000; // auto-submit empty plan after 90s of inactivity
const CHRONICLE_MAX      = 100;    // max rounds retained per room in the chronicle

// ── State ────────────────────────────────────────────────────────────────────

/** @type {Map<string, Room>} */
const rooms = new Map();

/** 6-char uppercase code → roomId */
const codeToRoom = new Map();

// ── Personality helpers ───────────────────────────────────────────────────────

const PERSONALITY_LABELS = {
  balanced:  'Balanced',
  berserker: 'Berserker',
  sentinel:  'Sentinel',
  scavenger: 'Scavenger',
  hoarder:   'Hoarder',
  swarm:     'Swarm',
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
 *   ai:       import('../src/ai.js').WitchAI|import('../src/ai.js').HeroAI|null,
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
      fog:            config.fog ?? 'partial',
      mapSize:        config.mapSize ?? 'standard',
      nodeCount:      config.nodeCount ?? null,
      playersPerSide: Math.max(1, Math.min(4, (config.playersPerSide | 0) || 1)),
    },
    slots:            [],
    state:            null,
    players:          [],
    turnTimer:        null,
    disconnectTimers: new Map(),
    takeoverTimers:   new Map(),
    spectators:       new Set(),
    chronicle:        [],
    replayRounds:     [],   // { roundNum, preStateJson, stepsJson }[]
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

  room.turnTimer = setTimeout(() => {
    room.turnTimer = null;
    if (room.state.gameOver || !room.state.planningPhase) return;
    // Auto-submit empty plans for any seat (human or AI) that hasn't submitted yet.
    // Without the AI check the game would hang indefinitely if AI plan generation fails.
    for (const seat of room.players) {
      if (!room.state.playerReady.get(seat.playerId)) {
        if (!seat.isAI) {
          send(seat.ws, { type: 'error', message: 'Planning time expired — an empty plan was submitted.' });
        }
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

  // Notify all other players and spectators that this player has locked in
  const submittedMsg = {
    type:     'playerSubmitted',
    playerId,
    name:     seatFor(room, playerId)?.name ?? playerId,
    faction:  factionFor(room, playerId),
  };
  broadcastExcept(room, playerId, submittedMsg);
  broadcastToSpectators(room, submittedMsg);

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
  const AICls      = registry[personality] ?? (faction === 'witch' ? WitchAI : HeroAI);
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
  const label = PERSONALITY_LABELS[personality] ?? 'Balanced';
  const name  = faction === 'witch'
    ? `The AI Witch (${label})`
    : `The AI Hero (${label})`;
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
  const name = faction === 'witch' ? 'Witch Ally' : 'Hero Ally';
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
      }, room.replayRounds);
    } catch (err) {
      console.error(`[room ${room.id}] createCompletedGame error:`, err);
    }
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
    fog:           config.fog ?? 'partial',
    mapSize:       config.mapSize ?? 'standard',
    nodeCount:     config.nodeCount ?? null,
    playersPerSide: pps,
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

  const label   = PERSONALITY_LABELS[resolved] ?? 'Balanced';
  const aiName  = slot.faction === 'witch'
    ? `AI Witch (${label})`
    : `AI Hero (${label})`;

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
  const playerList = room.players.map(s => ({
    playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI, personality: s.personality ?? null,
  }));
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
    for (const seat of room.players) {
      if (!room.state.playerReady.get(seat.playerId)) {
        send(seat.ws, { type: 'timerReset', timeoutMs: TURN_TIMEOUT_MS });
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

  // If the game is in planning phase, resend the planningPhase message so the
  // client re-enters planning mode (no separate planningPhase is sent on reconnect otherwise).
  if (room.state.planningPhase && !room.state.resolving) {
    const budget = room.state.playerActionsLeft?.get(playerId)
      ?? (seat.faction === 'hero' ? room.state.heroActionsLeft : room.state.witchActionsLeft);
    const playerList = room.players.map(s => ({
      playerId: s.playerId, name: s.name, faction: s.faction,
      isAI: s.isAI, personality: s.personality ?? null,
    }));
    send(ws, {
      type:            'planningPhase',
      myActionsLeft:   budget,
      heroActionsLeft:  room.state.heroActionsLeft,
      witchActionsLeft: room.state.witchActionsLeft,
      timeoutMs:        0,  // no countdown for reconnected players
      players:          playerList,
    });
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

  // Restore replay rounds accumulated before the save
  let priorRounds = [];
  try {
    priorRounds = getSaveRounds(roomId).map(r => ({
      roundNum:     r.round_num,
      preStateJson: r.pre_state_json,
      stepsJson:    r.steps_json,
    }));
  } catch (err) {
    console.error(`[resume ${roomId}] getSaveRounds error:`, err);
  }

  // Create a fresh room and inject the restored state
  const room   = createRoom({ fog: state.fogOfWar });
  room.state   = state;
  room.status  = 'playing';
  room.replayRounds = priorRounds;

  // Add the human player's seat, then an AI for the opponent
  const humanName = isHero  ? (save.hero_name  || 'Hero')  : (save.witch_name || 'Witch');
  _addSeat(room, playerId, ws, humanName, humanFaction, false);
  const aiSeat  = attachAI(room, aiFaction);

  deleteSave(roomId);

  const playerList = room.players.map(s => ({ playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI, personality: s.personality ?? null }));
  send(ws, {
    type:         'matchFound',
    roomId:       room.id,
    faction:      humanFaction,
    myPlayerId:   playerId,
    players:      playerList,
    aiOpponent:   true,
    resumed:      true,
    priorRounds:  priorRounds,
  });

  broadcastState(room, 'resume');
  _startPlanningPhase(room);
}
