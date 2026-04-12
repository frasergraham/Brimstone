// Per-round replay data for in-progress saves — Postgres implementation.
import { query, runMutation } from './client.js';

export const saveReplayRounds = {
  append({ roomId, roundNum, preStateJson, stepsJson }) {
    runMutation(`
      INSERT INTO save_replay_rounds (room_id, round_num, pre_state_json, steps_json)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (room_id, round_num) DO UPDATE SET
        pre_state_json = EXCLUDED.pre_state_json,
        steps_json     = EXCLUDED.steps_json
    `, [roomId, roundNum, preStateJson, stepsJson]);
  },
  listForRoom(roomId) {
    return query(`
      SELECT round_num, pre_state_json, steps_json
      FROM   save_replay_rounds
      WHERE  room_id = $1
      ORDER  BY round_num ASC
    `, [roomId]);
  },
  getLast(roomId) {
    return query(`
      SELECT round_num, pre_state_json, steps_json
      FROM   save_replay_rounds
      WHERE  room_id = $1
      ORDER  BY round_num DESC
      LIMIT  1
    `, [roomId])[0] ?? null;
  },
  getForRound(roomId, roundNum) {
    return query(`
      SELECT round_num, pre_state_json, steps_json
      FROM   save_replay_rounds
      WHERE  room_id = $1 AND round_num = $2
    `, [roomId, roundNum])[0] ?? null;
  },
  deleteForRoom(roomId) {
    runMutation('DELETE FROM save_replay_rounds WHERE room_id = $1', [roomId]);
  },
};
