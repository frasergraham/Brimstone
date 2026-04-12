// Player identities (email, gamecenter) — Postgres implementation.
import { query, runMutation } from './client.js';

export const identities = {
  insert({ playerId, provider, providerId }) {
    runMutation(
      `INSERT INTO player_identities (player_id, provider, provider_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (provider, provider_id) DO NOTHING`,
      [playerId, provider, providerId]
    );
  },
  get({ provider, providerId }) {
    return query(
      'SELECT * FROM player_identities WHERE provider = $1 AND provider_id = $2',
      [provider, providerId]
    )[0] ?? null;
  },
  listForPlayer(playerId) {
    return query(
      'SELECT provider, provider_id, created_at FROM player_identities WHERE player_id = $1',
      [playerId]
    );
  },
  listAll() {
    return query('SELECT player_id, provider, provider_id, created_at FROM player_identities');
  },
  getEmailForPlayer(playerId) {
    const row = query(
      `SELECT provider_id FROM player_identities
       WHERE  player_id = $1 AND provider = 'email'
       LIMIT  1`,
      [playerId]
    )[0];
    return row ? row.provider_id : null;
  },
  hasGameCenter(playerId) {
    return query(
      `SELECT 1 FROM player_identities
       WHERE  player_id = $1 AND provider = 'gamecenter'
       LIMIT  1`,
      [playerId]
    ).length > 0;
  },
  lookupGameCenterBatch(ids) {
    if (!Array.isArray(ids) || ids.length === 0) return [];
    return query(`
      SELECT pi.provider_id AS "gamePlayerID", p.id AS "playerId", p.username
      FROM   player_identities pi
      JOIN   players p ON p.id = pi.player_id
      WHERE  pi.provider = 'gamecenter' AND pi.provider_id = ANY($1::text[])
    `, [ids]);
  },
};
