// Data-access layer for async (play-by-mail) games.
// Pure DB operations — no WebSocket, notification, or game-logic concerns.
// All SQL lives in server/db/; this module is the business-logic facade.

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

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Create a new async game in 'waiting' status.
 * Returns { roomId, code }.
 */
export function insertAsyncGame(hostPlayerId, hostPlayerName, hostFaction, config, turnIntervalMs, gameVersion, inviteeEmail = null) {
  const roomId = randomUUID();
  let code;
  do { code = randomCode(); } while (db.async.codeExists(code));

  const heroPlayerId  = hostFaction === 'hero'  ? hostPlayerId : null;
  const witchPlayerId = hostFaction === 'witch' ? hostPlayerId : null;
  const heroName      = hostFaction === 'hero'  ? hostPlayerName : '';
  const witchName     = hostFaction === 'witch' ? hostPlayerName : '';

  db.async.create({
    roomId, code, hostPlayerId, hostFaction,
    heroPlayerId, witchPlayerId, heroName, witchName,
    turnIntervalMs, gameVersion,
    configJson: JSON.stringify(config),
    inviteeEmail: inviteeEmail || null,
  });

  return { roomId, code };
}

/** Load full async game row (with state_json). Returns null if not found. */
export function getAsyncGame(roomId) {
  return db.async.get(roomId);
}

/** Look up a waiting game by join code. Returns null if not found or not waiting. */
export function getAsyncGameByCode(code) {
  return db.async.getByCode(code.toUpperCase());
}

/**
 * Lightweight list of async games for a player (no state_json).
 * Includes plan submission counts for the current round.
 */
export function getAsyncGamesForPlayer(playerId) {
  const rows = db.async.listForPlayer(playerId);
  const allStatus = db.async.listCurrentRoundPlanStatus();
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

/** Activate a waiting game: assign opponent, store initial state, start round 1. */
export function activateAsyncGame(roomId, opponentId, opponentName, heroName, witchName, stateJson, round, phase, turnDeadline) {
  const game = db.async.get(roomId);
  if (!game || game.status !== 'waiting') return false;

  const heroPlayerId  = game.host_faction === 'hero'  ? game.host_player_id : opponentId;
  const witchPlayerId = game.host_faction === 'witch' ? game.host_player_id : opponentId;

  db.async.activate({
    roomId, heroPlayerId, witchPlayerId,
    heroName, witchName, stateJson,
    round, phase, turnDeadline,
  });

  // Insert plan status row for the opponent (host already has one from creation)
  db.async.insertPlanRow({ roomId, playerId: opponentId, round });

  return true;
}

/** Update game state after resolution. */
export function updateAsyncGameState(roomId, stateJson, round, phase, turnDeadline, consecutiveTimeoutRounds = 0) {
  db.async.update({ roomId, stateJson, round, phase, turnDeadline, consecutiveTimeoutRounds });
}

/** Mark game as finished or abandoned. */
export function finishAsyncGame(roomId, status, winner, winReason, stateJson) {
  db.async.finish({ roomId, status, winner: winner ?? '', winReason: winReason ?? '', stateJson });
}

/** Delete an async game and all associated data. */
export function deleteAsyncGame(roomId) {
  db.async.delete(roomId);
}

/** Remove stale/incompatible games on startup. */
export function pruneStaleAsyncGames(currentVersion) {
  const cutoff = Math.floor(Date.now() / 1000) - STALE_DAYS * 86400;
  const { deleted } = db.async.pruneStale(cutoff, currentVersion);
  if (deleted) console.log(`[Async] Pruned ${deleted} stale async game(s).`);
}

// ── Plan status ─────────────────────────────────────────────────────────────

/** Insert plan status rows for a new round. */
export function insertPlanStatus(roomId, playerIds, round) {
  for (const playerId of playerIds) {
    db.async.insertPlanRow({ roomId, playerId, round });
  }
}

/** Submit a plan for a player. Returns true if the update matched a row. */
export function submitPlan(roomId, playerId, round, plan) {
  return db.async.submitPlan({
    roomId, playerId, round,
    planJson: JSON.stringify(plan),
  });
}

/**
 * Get plan status for a round.
 * Returns [{ player_id, submitted: 0|1, plan_json }].
 */
export function getPlanStatus(roomId, round) {
  return db.async.listPlanStatusForRound(roomId, round);
}

/** Check if all plans are submitted for a round. */
export function allPlansSubmitted(roomId, round) {
  return db.async.countPendingPlans(roomId, round) === 0;
}

/** Get all games with expired deadlines. */
export function getExpiredGames() {
  return db.async.listExpiredDeadlineRooms();
}
