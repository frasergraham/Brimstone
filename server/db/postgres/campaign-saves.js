// Campaign saves — Postgres implementation.
import { query, runMutation } from './client.js';

export const campaignSaves = {
  upsert({ playerId, saveSlot, stateJson, gameVersion }) {
    runMutation(`
      INSERT INTO campaign_saves (player_id, save_slot, state_json, game_version, updated_at)
      VALUES ($1, $2, $3, $4, EXTRACT(EPOCH FROM NOW())::BIGINT)
      ON CONFLICT (player_id, save_slot) DO UPDATE SET
        state_json   = EXCLUDED.state_json,
        game_version = EXCLUDED.game_version,
        updated_at   = EXTRACT(EPOCH FROM NOW())::BIGINT
    `, [playerId, saveSlot, stateJson, gameVersion]);
  },
  get(playerId, saveSlot) {
    return query(`
      SELECT state_json, game_version, updated_at, created_at
      FROM   campaign_saves
      WHERE  player_id = $1 AND save_slot = $2
    `, [playerId, saveSlot])[0] ?? null;
  },
  list(playerId) {
    return query(`
      SELECT save_slot, game_version, updated_at, created_at
      FROM   campaign_saves
      WHERE  player_id = $1
      ORDER  BY updated_at DESC
    `, [playerId]);
  },
  delete(playerId, saveSlot) {
    runMutation(
      'DELETE FROM campaign_saves WHERE player_id = $1 AND save_slot = $2',
      [playerId, saveSlot]
    );
  },
};
