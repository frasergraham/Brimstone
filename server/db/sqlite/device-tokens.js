// Device tokens (push notification registration) domain.
import { prepare } from './client.js';

const _upsert = prepare(`
  INSERT INTO device_tokens (player_id, token, platform, updated_at)
  VALUES (?, ?, ?, unixepoch())
  ON CONFLICT (player_id, token)
  DO UPDATE SET platform = excluded.platform, updated_at = unixepoch()
`);

const _delete = prepare(
  'DELETE FROM device_tokens WHERE player_id = ? AND token = ?'
);

const _listForPlayer = prepare(
  'SELECT token, platform FROM device_tokens WHERE player_id = ?'
);

const _prune = prepare(
  'DELETE FROM device_tokens WHERE updated_at < ?'
);

const _listDistinct = prepare(
  'SELECT DISTINCT player_id FROM device_tokens'
);

const _listAll = prepare(
  'SELECT player_id, token AS device_token, platform, updated_at FROM device_tokens'
);

export const deviceTokens = {
  upsert({ playerId, token, platform = 'ios' }) {
    _upsert.run(playerId, token, platform);
  },
  delete(playerId, token) {
    _delete.run(playerId, token);
  },
  listForPlayer(playerId) {
    return _listForPlayer.all(playerId);
  },
  prune(cutoffUnixSeconds) {
    const result = _prune.run(cutoffUnixSeconds);
    return result.changes;
  },
  listDistinctPlayers() {
    return _listDistinct.all().map(r => r.player_id);
  },
  listAll() {
    return _listAll.all();
  },
};
