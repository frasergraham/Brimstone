// Player identities (email, gamecenter) domain.
import { prepare } from './client.js';

const _insert = prepare(
  'INSERT OR IGNORE INTO player_identities (player_id, provider, provider_id) VALUES (?, ?, ?)'
);
const _get = prepare(
  'SELECT * FROM player_identities WHERE provider = ? AND provider_id = ?'
);
const _listForPlayer = prepare(
  'SELECT provider, provider_id, created_at FROM player_identities WHERE player_id = ?'
);
const _listAll = prepare(
  'SELECT player_id, provider, provider_id, created_at FROM player_identities'
);
const _hasEmail = prepare(`
  SELECT provider_id FROM player_identities
  WHERE  player_id = ? AND provider = 'email'
  LIMIT  1
`);
const _hasGameCenter = prepare(`
  SELECT 1 FROM player_identities
  WHERE  player_id = ? AND provider = 'gamecenter'
  LIMIT  1
`);

export const identities = {
  insert({ playerId, provider, providerId }) {
    _insert.run(playerId, provider, providerId);
  },
  get({ provider, providerId }) {
    return _get.get(provider, providerId) ?? null;
  },
  listForPlayer(playerId) {
    return _listForPlayer.all(playerId);
  },
  listAll() {
    return _listAll.all();
  },
  getEmailForPlayer(playerId) {
    const row = _hasEmail.get(playerId);
    return row ? row.provider_id : null;
  },
  hasGameCenter(playerId) {
    return !!_hasGameCenter.get(playerId);
  },
  /** Look up Brimstone players for a list of Game Center IDs.
   *  Returns [{ gamePlayerID, playerId, username }]. */
  lookupGameCenterBatch(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    const placeholders = ids.map(() => '?').join(',');
    return prepare(`
      SELECT pi.provider_id AS gamePlayerID, p.id AS playerId, p.username
      FROM   player_identities pi
      JOIN   players p ON p.id = pi.player_id
      WHERE  pi.provider = 'gamecenter' AND pi.provider_id IN (${placeholders})
    `).all(...ids);
  },
};
