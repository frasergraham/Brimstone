// Unified-multiplayer plan status domain (game_plan_status table).
import { prepare } from './client.js';

const _upsert = prepare(`
  INSERT INTO game_plan_status (room_id, player_id, round, plan_json, submitted_at)
  VALUES (@roomId, @playerId, @round, @planJson, @submittedAt)
  ON CONFLICT(room_id, player_id, round) DO UPDATE SET
    plan_json    = excluded.plan_json,
    submitted_at = excluded.submitted_at
`);

const _insertIfMissing = prepare(`
  INSERT OR IGNORE INTO game_plan_status (room_id, player_id, round, plan_json, submitted_at)
  VALUES (@roomId, @playerId, @round, NULL, NULL)
`);

const _listForRound = prepare(`
  SELECT player_id, plan_json, submitted_at
  FROM   game_plan_status
  WHERE  room_id = ? AND round = ?
`);

const _clearRound = prepare(
  'DELETE FROM game_plan_status WHERE room_id = ? AND round = ?'
);

const _clearRoom = prepare(
  'DELETE FROM game_plan_status WHERE room_id = ?'
);

export const plans = {
  upsert({ roomId, playerId, round, planJson, submittedAt }) {
    _upsert.run({ roomId, playerId, round, planJson, submittedAt });
  },
  insertMissing(roomId, playerIds, round) {
    for (const playerId of playerIds) {
      _insertIfMissing.run({ roomId, playerId, round });
    }
  },
  listForRound(roomId, round) {
    return _listForRound.all(roomId, round);
  },
  clearRound(roomId, round) {
    _clearRound.run(roomId, round);
  },
  clearRoom(roomId) {
    _clearRoom.run(roomId);
  },
};
