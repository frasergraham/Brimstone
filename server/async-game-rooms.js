// Async game room management — create, join, connect, submit, resolve, finish.
// Extracted from lobby.js to reduce its responsibility count.

import { randomUUID } from 'crypto';
import { GameState } from '../src/game.js';
import { serializeState, deserializeState } from './state-sync.js';
import { recordResult }                    from './leaderboard.js';
import { recordGameStats }                 from './game-stats.js';
import { resolvePlansMP, ResEventType }    from './resolver.js';
import { compileTurnBattleSummary }        from '../src/battle-utils.js';
import { PlanActionType }                  from '../src/planner.js';
import { createCompletedGame, appendSaveRound, getSaveRounds, getLastSaveRound } from './saves.js';
import { insertAsyncGame, getAsyncGame, getAsyncGameByCode,
         activateAsyncGame, updateAsyncGameState, finishAsyncGame as dbFinishAsyncGame,
         insertPlanStatus as insertAsyncPlanStatus,
         submitPlan as submitAsyncPlan,
         getPlanStatus as getAsyncPlanStatus,
         allPlansSubmitted as asyncAllPlansSubmitted } from './async-game.js';
import { notifyWaitingOnYou, notifyRoundReady, notifyGameOver, sendGameInvite } from './notifications.js';
import { VERSION } from '../src/version.js';
import { send, _serializeEvents } from './lobby.js';

// ── Injected dependencies (set by lobby.js at startup) ─────────────────────

let _notifyGamesUpdate = () => {};

/** Called by lobby.js to provide the _notifyGamesUpdate function. */
export function setNotifyGamesUpdate(fn) { _notifyGamesUpdate = fn; }


// ── Async session tracking ─────────────────────────────────────────────────

/** @type {Map<string, Map<string, WebSocket>>} roomId → playerId → ws */
export const asyncSessions = new Map();

function _asyncSend(roomId, playerId, msg) {
  const ws = asyncSessions.get(roomId)?.get(playerId);
  send(ws, msg);
}

function _asyncBroadcast(roomId, msg) {
  const roomSessions = asyncSessions.get(roomId);
  if (!roomSessions) return;
  for (const ws of roomSessions.values()) send(ws, msg);
}
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
  // Legacy 'full' fog (retired) degrades to 'partial'.
  state.fogOfWar = (!gameConfig.fog || gameConfig.fog === 'full') ? 'partial' : gameConfig.fog;

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

  // Check if the player was idle (empty plan) in the previous round
  let wasIdleLastRound = false;
  if (game.round > 1) {
    const prevPlans = getAsyncPlanStatus(roomId, game.round - 1);
    const prevMyPlan = prevPlans.find(p => p.player_id === playerId);
    if (prevMyPlan?.plan_json === '[]') wasIdleLastRound = true;
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
    wasIdleLastRound,
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

  // Push game-list refresh so badge/list update in real time
  _notifyGamesUpdate(playerId);
  const _opId = game.hero_player_id === playerId ? game.witch_player_id : game.hero_player_id;
  _notifyGamesUpdate(_opId);

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
 * @param {string} roomId
 * @param {Set<string>} [timedOutPlayerIds] — player IDs whose plans were auto-submitted empty
 */
function _resolveAsyncRound(roomId, timedOutPlayerIds) {
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
      const wasIdle = timedOutPlayerIds?.has(pid) ?? false;
      const idleFaction = pid === game.hero_player_id ? 'hero' : 'witch';
      notifyRoundReady(pid, {
        roomId, round: state.round,
        wasIdle, idleFaction: wasIdle ? idleFaction : undefined,
      }, { isAsync: true }).catch(() => {});
    }
  }

  // Push resolution to any connected players
  const resolutionMsg = {
    type: 'asyncResolution', roomId,
    resolvedRound, preStateJson,
    steps: serializedSteps, finalState,
    timedOutPlayerIds: timedOutPlayerIds ? [...timedOutPlayerIds] : [],
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

  // Push game-list refresh so badge/list update in real time
  _notifyGamesUpdate(game.hero_player_id);
  _notifyGamesUpdate(game.witch_player_id);
}

function _finishAsyncGame(roomId, game, state, serializedSteps, finalState) {
  dbFinishAsyncGame(roomId, 'finished', state.winner, state.winReason, JSON.stringify(finalState));

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
