// Async notification ledger — Postgres implementation.
import { query, runMutation } from './client.js';

export const notifications = {
  hasRecent({ roomId, playerId, type, sinceUnixSeconds }) {
    return query(`
      SELECT 1 FROM async_notifications
      WHERE  room_id = $1 AND player_id = $2 AND type = $3 AND sent_at > $4
      LIMIT  1
    `, [roomId, playerId, type, sinceUnixSeconds]).length > 0;
  },
  record({ roomId, playerId, type }) {
    runMutation(
      'INSERT INTO async_notifications (room_id, player_id, type) VALUES ($1, $2, $3)',
      [roomId, playerId, type]
    );
  },
  deleteForRoom(roomId) {
    runMutation('DELETE FROM async_notifications WHERE room_id = $1', [roomId]);
  },
};
