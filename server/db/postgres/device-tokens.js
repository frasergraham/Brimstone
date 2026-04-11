// Device tokens — Postgres implementation.
import { query, runMutation } from './client.js';

export const deviceTokens = {
  upsert({ playerId, token, platform = 'ios' }) {
    runMutation(`
      INSERT INTO device_tokens (player_id, token, platform, updated_at)
      VALUES ($1, $2, $3, EXTRACT(EPOCH FROM NOW())::BIGINT)
      ON CONFLICT (player_id, token) DO UPDATE SET
        platform   = EXCLUDED.platform,
        updated_at = EXTRACT(EPOCH FROM NOW())::BIGINT
    `, [playerId, token, platform]);
  },
  delete(playerId, token) {
    runMutation(
      'DELETE FROM device_tokens WHERE player_id = $1 AND token = $2',
      [playerId, token]
    );
  },
  listForPlayer(playerId) {
    return query(
      'SELECT token, platform FROM device_tokens WHERE player_id = $1',
      [playerId]
    );
  },
  prune(cutoffUnixSeconds) {
    const { changes } = runMutation(
      'DELETE FROM device_tokens WHERE updated_at < $1',
      [cutoffUnixSeconds]
    );
    return changes;
  },
  listDistinctPlayers() {
    return query('SELECT DISTINCT player_id FROM device_tokens').map(r => r.player_id);
  },
  listAll() {
    return query(
      'SELECT player_id, token AS device_token, platform, updated_at FROM device_tokens'
    );
  },
};
