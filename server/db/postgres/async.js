// Async (play-by-mail) games — Postgres implementation.
import { query, runMutation } from './client.js';

export const async_ = {
  create(row) {
    runMutation(`
      INSERT INTO async_games
        (room_id, code, host_player_id, host_faction,
         hero_player_id, witch_player_id, hero_name, witch_name,
         turn_interval_ms, game_version, config_json, invitee_email, status)
      VALUES
        ($1, $2, $3, $4,
         $5, $6, $7, $8,
         $9, $10, $11, $12, 'waiting')
    `, [
      row.roomId, row.code, row.hostPlayerId, row.hostFaction,
      row.heroPlayerId, row.witchPlayerId, row.heroName, row.witchName,
      row.turnIntervalMs, row.gameVersion, row.configJson, row.inviteeEmail,
    ]);
  },
  get(roomId) {
    return query('SELECT * FROM async_games WHERE room_id = $1', [roomId])[0] ?? null;
  },
  getByCode(code) {
    return query(
      `SELECT * FROM async_games WHERE code = $1 AND status = 'waiting'`,
      [code]
    )[0] ?? null;
  },
  codeExists(code) {
    return query('SELECT 1 FROM async_games WHERE code = $1', [code]).length > 0;
  },
  listForPlayer(playerId) {
    return query(`
      SELECT room_id, code, hero_player_id, witch_player_id,
             hero_name, witch_name, host_player_id, host_faction,
             round, phase, turn_deadline, turn_interval_ms,
             status, winner, win_reason, config_json, updated_at, created_at
      FROM   async_games
      WHERE  (hero_player_id = $1 OR witch_player_id = $1 OR host_player_id = $1)
             AND status IN ('waiting', 'playing')
      ORDER  BY updated_at DESC
    `, [playerId]);
  },
  activate(row) {
    runMutation(`
      UPDATE async_games SET
        hero_player_id = $1,
        witch_player_id = $2,
        hero_name = $3,
        witch_name = $4,
        state_json = $5,
        round = $6,
        phase = $7,
        turn_deadline = $8,
        status = 'playing',
        updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE room_id = $9 AND status = 'waiting'
    `, [row.heroPlayerId, row.witchPlayerId, row.heroName, row.witchName,
        row.stateJson, row.round, row.phase, row.turnDeadline, row.roomId]);
  },
  update(row) {
    runMutation(`
      UPDATE async_games SET
        state_json = $1,
        round = $2,
        phase = $3,
        turn_deadline = $4,
        consecutive_timeout_rounds = $5,
        updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE room_id = $6
    `, [row.stateJson, row.round, row.phase, row.turnDeadline,
        row.consecutiveTimeoutRounds, row.roomId]);
  },
  finish(row) {
    runMutation(`
      UPDATE async_games SET
        status = $1,
        winner = $2,
        win_reason = $3,
        state_json = $4,
        updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE room_id = $5
    `, [row.status, row.winner, row.winReason, row.stateJson, row.roomId]);
  },
  delete(roomId) {
    runMutation('DELETE FROM async_notifications WHERE room_id = $1', [roomId]);
    runMutation('DELETE FROM async_plan_status WHERE room_id = $1', [roomId]);
    runMutation('DELETE FROM async_games WHERE room_id = $1', [roomId]);
  },
  pruneStale(cutoffUnixSeconds, currentVersion) {
    const stale = query(`
      SELECT room_id FROM async_games
      WHERE (status IN ('finished', 'abandoned') AND updated_at < $1)
         OR (game_version <> $2)
    `, [cutoffUnixSeconds, currentVersion]);
    for (const { room_id } of stale) {
      runMutation('DELETE FROM async_plan_status WHERE room_id = $1', [room_id]);
      runMutation('DELETE FROM async_notifications WHERE room_id = $1', [room_id]);
    }
    const { changes } = runMutation(`
      DELETE FROM async_games
      WHERE (status IN ('finished', 'abandoned') AND updated_at < $1)
         OR (game_version <> $2)
    `, [cutoffUnixSeconds, currentVersion]);
    runMutation(`
      DELETE FROM async_plan_status
      WHERE room_id NOT IN (SELECT room_id FROM async_games)
    `);
    // NOTE: async_notifications is shared between the legacy async_games system
    // and the unified game_saves system. This prune must preserve rows for
    // rooms that live in EITHER table or every server restart wipes dedup
    // records for unified multiplayer games.
    runMutation(`
      DELETE FROM async_notifications
      WHERE room_id NOT IN (SELECT room_id FROM async_games)
        AND room_id NOT IN (SELECT room_id FROM game_saves)
    `);
    return { found: stale.length, deleted: changes };
  },
  insertPlanRow({ roomId, playerId, round }) {
    runMutation(`
      INSERT INTO async_plan_status (room_id, player_id, round)
      VALUES ($1, $2, $3)
    `, [roomId, playerId, round]);
  },
  submitPlan({ roomId, playerId, round, planJson }) {
    const { changes } = runMutation(`
      UPDATE async_plan_status SET
        plan_json = $1,
        submitted_at = EXTRACT(EPOCH FROM NOW())::BIGINT
      WHERE room_id = $2 AND player_id = $3 AND round = $4
            AND plan_json IS NULL
    `, [planJson, roomId, playerId, round]);
    return changes > 0;
  },
  listPlanStatusForRound(roomId, round) {
    return query(`
      SELECT player_id,
             (plan_json IS NOT NULL)::int AS submitted,
             plan_json
      FROM   async_plan_status
      WHERE  room_id = $1 AND round = $2
    `, [roomId, round]);
  },
  countPendingPlans(roomId, round) {
    const r = query(`
      SELECT COUNT(*)::int AS pending
      FROM   async_plan_status
      WHERE  room_id = $1 AND round = $2 AND plan_json IS NULL
    `, [roomId, round])[0];
    return r ? r.pending : 0;
  },
  listExpiredDeadlineRooms() {
    return query(`
      SELECT room_id FROM async_games
      WHERE  turn_deadline < EXTRACT(EPOCH FROM NOW())::BIGINT
        AND  status = 'playing'
    `);
  },
  listCurrentRoundPlanStatus() {
    return query(`
      SELECT room_id, player_id, (plan_json IS NOT NULL)::int AS submitted
      FROM   async_plan_status AS ps
      WHERE  ps.round = (SELECT round FROM async_games WHERE async_games.room_id = ps.room_id)
    `);
  },
  listForMigration() {
    try {
      return query(`SELECT * FROM async_games WHERE status IN ('playing', 'waiting')`);
    } catch {
      return [];
    }
  },
  listPlansForRoom(roomId) {
    try {
      return query('SELECT * FROM async_plan_status WHERE room_id = $1', [roomId]);
    } catch {
      return [];
    }
  },
  markMigrated(roomId) {
    try {
      runMutation(`UPDATE async_games SET status = 'migrated' WHERE room_id = $1`, [roomId]);
    } catch {}
  },
};
