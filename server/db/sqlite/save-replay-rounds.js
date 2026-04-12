// Per-round replay data for in-progress saves (save_replay_rounds table).
import { prepare } from './client.js';

const _insert = prepare(`
  INSERT OR REPLACE INTO save_replay_rounds (room_id, round_num, pre_state_json, steps_json)
  VALUES (@roomId, @roundNum, @preStateJson, @stepsJson)
`);

const _listForRoom = prepare(`
  SELECT round_num, pre_state_json, steps_json
  FROM   save_replay_rounds
  WHERE  room_id = ?
  ORDER  BY round_num ASC
`);

const _getLast = prepare(`
  SELECT round_num, pre_state_json, steps_json
  FROM   save_replay_rounds
  WHERE  room_id = ?
  ORDER  BY round_num DESC
  LIMIT  1
`);

const _getForRound = prepare(`
  SELECT round_num, pre_state_json, steps_json
  FROM   save_replay_rounds
  WHERE  room_id = ? AND round_num = ?
`);

const _deleteForRoom = prepare(
  'DELETE FROM save_replay_rounds WHERE room_id = ?'
);

export const saveReplayRounds = {
  append({ roomId, roundNum, preStateJson, stepsJson }) {
    _insert.run({ roomId, roundNum, preStateJson, stepsJson });
  },
  listForRoom(roomId) {
    return _listForRoom.all(roomId);
  },
  getLast(roomId) {
    return _getLast.get(roomId) ?? null;
  },
  getForRound(roomId, roundNum) {
    return _getForRound.get(roomId, roundNum) ?? null;
  },
  deleteForRoom(roomId) {
    _deleteForRoom.run(roomId);
  },
};
