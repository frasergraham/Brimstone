// Data-access layer for async (play-by-mail) games.
// Pure DB operations — no WebSocket, notification, or game-logic concerns.

import { randomUUID } from 'crypto';
import db from './db.js';

const STALE_DAYS = 7;

// ── Code generation (same alphabet as lobby.js) ─────────────────────────────

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function randomCode() {
  let c = '';
  for (let i = 0; i < 6; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  return c;
}

// ── Prepared statements ─────────────────────────────────────────────────────

const _insert = db.prepare(`
  INSERT INTO async_games
    (room_id, code, host_player_id, host_faction,
     hero_player_id, witch_player_id, hero_name, witch_name,
     turn_interval_ms, game_version, config_json, status)
  VALUES
    (@roomId, @code, @hostPlayerId, @hostFaction,
     @heroPlayerId, @witchPlayerId, @heroName, @witchName,
     @turnIntervalMs, @gameVersion, @configJson, 'waiting')
`);

const _getByRoom = db.prepare(`SELECT * FROM async_games WHERE room_id = ?`);

const _getByCode = db.prepare(
  `SELECT * FROM async_games WHERE code = ? AND status = 'waiting'`
);

const _codeExists = db.prepare(
  `SELECT 1 FROM async_games WHERE code = ?`
);

const _listForPlayer = db.prepare(`
  SELECT room_id, code, hero_player_id, witch_player_id,
         hero_name, witch_name, host_player_id, host_faction,
         round, phase, turn_deadline, turn_interval_ms,
         status, winner, win_reason, config_json, updated_at, created_at
  FROM   async_games
  WHERE  (hero_player_id = ? OR witch_player_id = ? OR host_player_id = ?)
         AND status IN ('waiting', 'playing')
  ORDER  BY updated_at DESC
`);

const _activate = db.prepare(`
  UPDATE async_games SET
    hero_player_id = @heroPlayerId,
    witch_player_id = @witchPlayerId,
    hero_name = @heroName,
    witch_name = @witchName,
    state_json = @stateJson,
    round = @round,
    phase = @phase,
    turn_deadline = @turnDeadline,
    status = 'playing',
    updated_at = unixepoch()
  WHERE room_id = @roomId AND status = 'waiting'
`);

const _updateState = db.prepare(`
  UPDATE async_games SET
    state_json = @stateJson,
    round = @round,
    phase = @phase,
    turn_deadline = @turnDeadline,
    consecutive_timeout_rounds = @consecutiveTimeoutRounds,
    updated_at = unixepoch()
  WHERE room_id = @roomId
`);

const _finish = db.prepare(`
  UPDATE async_games SET
    status = @status,
    winner = @winner,
    win_reason = @winReason,
    state_json = @stateJson,
    updated_at = unixepoch()
  WHERE room_id = @roomId
`);

const _delete = db.prepare(`DELETE FROM async_games WHERE room_id = ?`);
const _deletePlans = db.prepare(`DELETE FROM async_plan_status WHERE room_id = ?`);
const _deleteNotifications = db.prepare(`DELETE FROM async_notifications WHERE room_id = ?`);

const _findStale = db.prepare(`
  SELECT room_id FROM async_games
  WHERE (status IN ('finished', 'abandoned') AND updated_at < ?)
     OR (game_version != ?)
`);
const _pruneStale = db.prepare(`
  DELETE FROM async_games
  WHERE (status IN ('finished', 'abandoned') AND updated_at < ?)
     OR (game_version != ?)
`);
const _pruneOrphanPlans = db.prepare(`
  DELETE FROM async_plan_status
  WHERE room_id NOT IN (SELECT room_id FROM async_games)
`);
const _pruneOrphanNotifs = db.prepare(`
  DELETE FROM async_notifications
  WHERE room_id NOT IN (SELECT room_id FROM async_games)
`);

// ── Plan status statements ──────────────────────────────────────────────────

const _insertPlan = db.prepare(`
  INSERT INTO async_plan_status (room_id, player_id, round)
  VALUES (@roomId, @playerId, @round)
`);

const _submitPlan = db.prepare(`
  UPDATE async_plan_status SET
    plan_json = @planJson,
    submitted_at = unixepoch()
  WHERE room_id = @roomId AND player_id = @playerId AND round = @round
        AND plan_json IS NULL
`);

const _getPlanStatus = db.prepare(`
  SELECT player_id, plan_json IS NOT NULL AS submitted, plan_json
  FROM   async_plan_status
  WHERE  room_id = ? AND round = ?
`);

const _allSubmitted = db.prepare(`
  SELECT COUNT(*) AS pending
  FROM   async_plan_status
  WHERE  room_id = ? AND round = ? AND plan_json IS NULL
`);

const _getExpired = db.prepare(`
  SELECT room_id FROM async_games
  WHERE  turn_deadline < unixepoch() AND status = 'playing'
`);

const _planStatusForPlayerList = db.prepare(`
  SELECT room_id, player_id, plan_json IS NOT NULL AS submitted
  FROM   async_plan_status AS ps
  WHERE  ps.round = (SELECT round FROM async_games WHERE async_games.room_id = ps.room_id)
`);

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new async game in 'waiting' status.
 * Returns { roomId, code }.
 */
export function insertAsyncGame(hostPlayerId, hostPlayerName, hostFaction, config, turnIntervalMs, gameVersion) {
  const roomId = randomUUID();
  let code;
  do { code = randomCode(); } while (_codeExists.get(code));

  const heroPlayerId  = hostFaction === 'hero'  ? hostPlayerId : null;
  const witchPlayerId = hostFaction === 'witch' ? hostPlayerId : null;
  const heroName      = hostFaction === 'hero'  ? hostPlayerName : '';
  const witchName     = hostFaction === 'witch' ? hostPlayerName : '';

  _insert.run({
    roomId, code, hostPlayerId, hostFaction,
    heroPlayerId, witchPlayerId, heroName, witchName,
    turnIntervalMs, gameVersion,
    configJson: JSON.stringify(config),
  });

  return { roomId, code };
}

/** Load full async game row (with state_json). Returns null if not found. */
export function getAsyncGame(roomId) {
  const row = _getByRoom.get(roomId);
  if (!row) return null;
  return row;
}

/** Look up a waiting game by join code. Returns null if not found or not waiting. */
export function getAsyncGameByCode(code) {
  return _getByCode.get(code.toUpperCase()) ?? null;
}

/**
 * Lightweight list of async games for a player (no state_json).
 * Includes plan submission counts for the current round.
 */
export function getAsyncGamesForPlayer(playerId) {
  const rows = _listForPlayer.all(playerId, playerId, playerId);
  // Attach plan status per game
  const allStatus = _planStatusForPlayerList.all();
  const statusByRoom = new Map();
  for (const s of allStatus) {
    if (!statusByRoom.has(s.room_id)) statusByRoom.set(s.room_id, []);
    statusByRoom.get(s.room_id).push(s);
  }

  return rows.map(r => {
    const plans = statusByRoom.get(r.room_id) || [];
    const myPlan = plans.find(p => p.player_id === playerId);
    return {
      ...r,
      my_plan_submitted:  myPlan ? !!myPlan.submitted : false,
      players_submitted:  plans.filter(p => p.submitted).length,
      players_total:      plans.length,
    };
  });
}

/**
 * Activate a waiting game: assign opponent, store initial state, start round 1.
 */
export function activateAsyncGame(roomId, opponentId, opponentName, heroName, witchName, stateJson, round, phase, turnDeadline) {
  const game = _getByRoom.get(roomId);
  if (!game || game.status !== 'waiting') return false;

  const heroPlayerId  = game.host_faction === 'hero'  ? game.host_player_id : opponentId;
  const witchPlayerId = game.host_faction === 'witch' ? game.host_player_id : opponentId;

  _activate.run({
    roomId, heroPlayerId, witchPlayerId,
    heroName, witchName, stateJson,
    round, phase, turnDeadline,
  });

  // Insert plan status row for the opponent (host already has one from creation)
  _insertPlan.run({ roomId, playerId: opponentId, round });

  return true;
}

/** Update game state after resolution. */
export function updateAsyncGameState(roomId, stateJson, round, phase, turnDeadline, consecutiveTimeoutRounds = 0) {
  _updateState.run({ roomId, stateJson, round, phase, turnDeadline, consecutiveTimeoutRounds });
}

/** Mark game as finished or abandoned. */
export function finishAsyncGame(roomId, status, winner, winReason, stateJson) {
  _finish.run({ roomId, status, winner: winner ?? '', winReason: winReason ?? '', stateJson });
}

/** Delete an async game and all associated data. */
export function deleteAsyncGame(roomId) {
  _deleteNotifications.run(roomId);
  _deletePlans.run(roomId);
  _delete.run(roomId);
}

/** Remove stale/incompatible games on startup. */
export function pruneStaleAsyncGames(currentVersion) {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_DAYS * 86400;
  // Find stale games first, delete children, then delete parents (FK safe)
  const staleRows = _findStale.all(cutoff, currentVersion);
  if (staleRows.length) {
    for (const { room_id } of staleRows) {
      _deletePlans.run(room_id);
      _deleteNotifications.run(room_id);
    }
  }
  const result = _pruneStale.run(cutoff, currentVersion);
  _pruneOrphanPlans.run();
  _pruneOrphanNotifs.run();
  if (result.changes) console.log(`[Async] Pruned ${result.changes} stale async game(s).`);
}

// ── Plan status ─────────────────────────────────────────────────────────────

/** Insert plan status rows for a new round. */
export function insertPlanStatus(roomId, playerIds, round) {
  for (const playerId of playerIds) {
    _insertPlan.run({ roomId, playerId, round });
  }
}

/**
 * Submit a plan for a player. Returns true if the update matched a row.
 */
export function submitPlan(roomId, playerId, round, plan) {
  const result = _submitPlan.run({
    roomId, playerId, round,
    planJson: JSON.stringify(plan),
  });
  return result.changes > 0;
}

/**
 * Get plan status for a round.
 * Returns [{ player_id, submitted: 0|1, plan_json }].
 */
export function getPlanStatus(roomId, round) {
  return _getPlanStatus.all(roomId, round);
}

/** Check if all plans are submitted for a round. */
export function allPlansSubmitted(roomId, round) {
  const row = _allSubmitted.get(roomId, round);
  return row && row.pending === 0;
}

/** Get all games with expired deadlines. */
export function getExpiredGames() {
  return _getExpired.all();
}
