// Unified-multiplayer plan status — Postgres implementation.
import { query, runMutation } from './client.js';

export const plans = {
  upsert({ roomId, playerId, round, planJson, submittedAt }) {
    runMutation(`
      INSERT INTO game_plan_status (room_id, player_id, round, plan_json, submitted_at)
      VALUES ($1, $2, $3, $4, $5)
      ON CONFLICT (room_id, player_id, round) DO UPDATE SET
        plan_json    = EXCLUDED.plan_json,
        submitted_at = EXCLUDED.submitted_at
    `, [roomId, playerId, round, planJson, submittedAt]);
  },
  insertMissing(roomId, playerIds, round) {
    for (const playerId of playerIds) {
      runMutation(`
        INSERT INTO game_plan_status (room_id, player_id, round, plan_json, submitted_at)
        VALUES ($1, $2, $3, NULL, NULL)
        ON CONFLICT (room_id, player_id, round) DO NOTHING
      `, [roomId, playerId, round]);
    }
  },
  listForRound(roomId, round) {
    return query(`
      SELECT player_id, plan_json, submitted_at
      FROM   game_plan_status
      WHERE  room_id = $1 AND round = $2
    `, [roomId, round]);
  },
  clearRound(roomId, round) {
    runMutation(
      'DELETE FROM game_plan_status WHERE room_id = $1 AND round = $2',
      [roomId, round]
    );
  },
  clearRoom(roomId) {
    runMutation('DELETE FROM game_plan_status WHERE room_id = $1', [roomId]);
  },
};
