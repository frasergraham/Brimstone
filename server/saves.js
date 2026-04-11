// Game save persistence — upsert/delete/list/get for in-progress game states
// and completed-game replay storage. All SQL lives in server/db/; this module
// is the business-logic facade (parameter shaping, JSON (de)serialization,
// version compatibility, TTL policy).
import db from './db.js';

const SAVE_MAX_AGE_DAYS = 3;
const TTL_SECONDS = SAVE_MAX_AGE_DAYS * 86400;

/** Check if a save's version is compatible with the running server.
 *  Uses SAVE_VERSION (integer) when present in the save; falls back to
 *  major.minor comparison for saves created before SAVE_VERSION was added. */
export function isVersionCompatible(saveVersion, currentVersion, saveSaveVersion, currentSaveVersion) {
  if (saveSaveVersion != null && currentSaveVersion != null) {
    return saveSaveVersion === currentSaveVersion;
  }
  if (!saveVersion || !currentVersion) return false;
  const [sMaj, sMin] = saveVersion.split('.');
  const [cMaj, cMin] = currentVersion.split('.');
  return sMaj === cMaj && sMin === cMin;
}

/**
 * Persist (create or update) the serialized state for a room.
 */
export function upsertSave(roomId, heroPlayerId, witchPlayerId, heroName, witchName, serializedState, extra = {}) {
  db.saves.upsert({
    roomId,
    heroPlayerId:        heroPlayerId  ?? null,
    witchPlayerId:       witchPlayerId ?? null,
    heroName:            heroName      ?? '',
    witchName:           witchName     ?? '',
    round:               serializedState.round,
    phase:               serializedState.phase,
    gameVersion:         serializedState.version,
    saveVersion:         extra.saveVersion ?? null,
    stateJson:           JSON.stringify(serializedState),
    turnDeadline:        extra.turnDeadline        ?? null,
    turnIntervalMs:      extra.turnIntervalMs       ?? 90000,
    consecutiveTimeouts: extra.consecutiveTimeouts  ? JSON.stringify(extra.consecutiveTimeouts) : '{}',
    configJson:          extra.config               ? JSON.stringify(extra.config)               : '{}',
    playersJson:         extra.players              ? JSON.stringify(extra.players)              : '[]',
    isPrivate:           extra.isPrivate            ? 1 : 0,
    code:                extra.code                 ?? null,
    status:              extra.status               ?? 'playing',
  });
}

/** Remove the save for a completed or abandoned room (including replay rounds). */
export function deleteSave(roomId) {
  db.saveReplayRounds.deleteForRoom(roomId);
  db.saves.delete(roomId);
}

/** Append a single round's replay data to the save. */
export function appendSaveRound(roomId, roundNum, preStateJson, stepsJson) {
  db.saveReplayRounds.append({ roomId, roundNum, preStateJson, stepsJson });
}

/** Retrieve all replay rounds for a save, ordered by round number. */
export function getSaveRounds(roomId) {
  return db.saveReplayRounds.listForRoom(roomId);
}

/** Retrieve just the most recent replay round for a save. Returns null if none. */
export function getLastSaveRound(roomId) {
  return db.saveReplayRounds.getLast(roomId);
}

/** Retrieve a specific round's replay data. Returns null if not found. */
export function getSaveRound(roomId, roundNum) {
  return db.saveReplayRounds.getForRound(roomId, roundNum);
}

/**
 * Remove stale saves on server startup:
 *   - any save idle for more than SAVE_MAX_AGE_DAYS days
 *   - any save from a different major.minor version (schema may be incompatible)
 * Returns the number of rows pruned.
 */
export function pruneStaleAndIncompatibleSaves(currentVersion, currentSaveVersion) {
  const cutoff = Math.floor(Date.now() / 1000) - SAVE_MAX_AGE_DAYS * 86400;
  const candidates = db.saves.listNonBattleForPruning();
  const roomsToPrune = candidates.filter(row =>
    row.updated_at < cutoff ||
    !isVersionCompatible(row.game_version, currentVersion, row.save_version, currentSaveVersion)
  );
  if (roomsToPrune.length === 0) return 0;
  return db.saves.pruneByIds(roomsToPrune.map(r => r.room_id));
}

/** All battle-mode saves in the DB (for recovery on server startup). */
export function getActiveBattleSaves() {
  return db.saves.listActiveBattles();
}

/** All saves with status 'playing' or 'lobby' (for bulk recovery at startup). */
export function getAllPlayingSaves() {
  return db.saves.listAllPlaying();
}

/** Lightweight list of in-progress saves that involve a given player ID. */
export function getActiveSaves(playerId) {
  return db.saves.listByPlayer(playerId);
}

/** Retrieve a single save by room ID with the full state parsed. */
export function getSave(roomId) {
  return db.saves.get(roomId);
}

// ---------------------------------------------------------------------------
// Completed-game replay storage
// ---------------------------------------------------------------------------

/** Persist a completed game with its full round replay history. */
export function createCompletedGame(gameId, roomId, meta, rounds) {
  db.completedGames.create({
    gameId,
    roomId,
    heroPlayerId:  meta.heroPlayerId  ?? null,
    witchPlayerId: meta.witchPlayerId ?? null,
    heroName:      meta.heroName      ?? '',
    witchName:     meta.witchName     ?? '',
    winner:        meta.winner        ?? '',
    winReason:     meta.winReason     ?? '',
    totalRounds:   meta.totalRounds   ?? 0,
    gameVersion:   meta.gameVersion   ?? '',
    mode:          meta.mode          ?? 'hvai',
    playersJson:   meta.playersJson   ?? '[]',
    ttlSeconds:    TTL_SECONDS,
  }, rounds);
}

/** List all completed games for a player (lightweight — no replay data). */
export function getCompletedGames(playerId) {
  return db.completedGames.listForPlayer(playerId);
}

/** List all completed battle games (newest first, up to `limit`). */
export function getCompletedBattles(limit = 20) {
  return db.completedGames.listBattles(limit);
}

/** List completed battle games that a specific player participated in. */
export function getCompletedBattlesForPlayer(playerId, limit = 20) {
  return db.completedGames.listBattlesForPlayer(playerId, limit);
}

/** Return all rounds for a completed game, ordered by round number. */
export function getCompletedGameRounds(gameId) {
  return db.completedGames.listRounds(gameId);
}

/** Get a single completed game record (without rounds). */
export function getCompletedGame(gameId) {
  return db.completedGames.get(gameId);
}

/** Pin or unpin a completed game. Returns true if a row was updated. */
export function pinCompletedGame(gameId, playerId, pinned) {
  return db.completedGames.setPinned({ gameId, playerId, pinned, ttlSeconds: TTL_SECONDS });
}

/** Delete a completed game and all its rounds. Returns true if deleted. */
export function deleteCompletedGame(gameId, playerId) {
  return db.completedGames.delete({ gameId, playerId });
}

/** Remove expired (unpinned, past TTL) completed games and their rounds. */
export function pruneExpiredCompletedGames() {
  return db.completedGames.pruneExpired();
}

/** Return all completed games (admin view — no player filter). */
export function getAllCompletedGames() {
  return db.completedGames.listAllAdmin();
}

// ── Plan persistence (unified multiplayer) ────────────────────────────────────

export function insertPlanStatusRows(roomId, playerIds, round) {
  db.plans.insertMissing(roomId, playerIds, round);
}

export function upsertPlanStatus(roomId, playerId, round, plan) {
  db.plans.upsert({
    roomId,
    playerId,
    round,
    planJson:    JSON.stringify(plan),
    submittedAt: Math.floor(Date.now() / 1000),
  });
}

export function getPlanStatus(roomId, round) {
  return db.plans.listForRound(roomId, round);
}

/** Whether every player in `playerIds` has submitted a plan for `round`. */
export function allPlansSubmitted(roomId, round, playerIds) {
  const rows = db.plans.listForRound(roomId, round);
  const submitted = new Set(rows.filter(r => r.plan_json !== null).map(r => r.player_id));
  return playerIds.every(pid => submitted.has(pid));
}

export function clearPlanStatus(roomId, round) {
  db.plans.clearRound(roomId, round);
}

export function clearAllPlanStatus(roomId) {
  db.plans.clearRoom(roomId);
}

/** In-progress games with expired turn deadlines (background deadline checker). */
export function getExpiredDeadlineGames() {
  return db.saves.listExpiredDeadlines();
}

export function getApproachingDeadlineGames(windowMs = 600_000) {
  const windowS = Math.floor(windowMs / 1000);
  return db.saves.listApproachingDeadlines(windowS);
}

/** All in-progress games involving a player (hero/witch column OR players_json). */
export function getActiveGamesForPlayer(playerId) {
  return db.saves.listActiveForPlayer(playerId);
}
