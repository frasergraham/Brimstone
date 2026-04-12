// Campaign saves domain.
import { prepare } from './client.js';

const _upsert = prepare(`
  INSERT INTO campaign_saves (player_id, save_slot, state_json, game_version, updated_at)
  VALUES (?, ?, ?, ?, unixepoch())
  ON CONFLICT(player_id, save_slot) DO UPDATE SET
    state_json   = excluded.state_json,
    game_version = excluded.game_version,
    updated_at   = unixepoch()
`);

const _get = prepare(`
  SELECT state_json, game_version, updated_at, created_at
  FROM   campaign_saves
  WHERE  player_id = ? AND save_slot = ?
`);

const _list = prepare(`
  SELECT save_slot, game_version, updated_at, created_at
  FROM   campaign_saves
  WHERE  player_id = ?
  ORDER  BY updated_at DESC
`);

const _delete = prepare(
  'DELETE FROM campaign_saves WHERE player_id = ? AND save_slot = ?'
);

export const campaignSaves = {
  upsert({ playerId, saveSlot, stateJson, gameVersion }) {
    _upsert.run(playerId, saveSlot, stateJson, gameVersion);
  },
  get(playerId, saveSlot) {
    return _get.get(playerId, saveSlot) ?? null;
  },
  list(playerId) {
    return _list.all(playerId);
  },
  delete(playerId, saveSlot) {
    _delete.run(playerId, saveSlot);
  },
};
