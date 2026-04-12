// Magic link tokens — Postgres implementation.
import { query, runMutation } from './client.js';

export const magicTokens = {
  create({ token, email, playerId, expiresAt }) {
    runMutation(
      'INSERT INTO magic_tokens (token, email, player_id, expires_at) VALUES ($1, $2, $3, $4)',
      [token, email, playerId, expiresAt]
    );
  },
  getUnused(token) {
    return query(
      'SELECT * FROM magic_tokens WHERE token = $1 AND used = 0',
      [token]
    )[0] ?? null;
  },
  markUsed(token) {
    runMutation('UPDATE magic_tokens SET used = 1 WHERE token = $1', [token]);
  },
  prune(nowMs) {
    runMutation(
      'DELETE FROM magic_tokens WHERE expires_at < $1 OR used = 1',
      [nowMs]
    );
  },
};
