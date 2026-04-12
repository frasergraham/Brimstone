// Async notification ledger (dedup window tracking).
import { prepare } from './client.js';

const _recent = prepare(`
  SELECT 1 FROM async_notifications
  WHERE  room_id = ? AND player_id = ? AND type = ? AND sent_at > ?
  LIMIT  1
`);

const _insert = prepare(`
  INSERT INTO async_notifications (room_id, player_id, type)
  VALUES (?, ?, ?)
`);

const _deleteForRoom = prepare(
  'DELETE FROM async_notifications WHERE room_id = ?'
);

export const notifications = {
  /** Was a notification of this type sent to this player+room after `sinceUnixSeconds`? */
  hasRecent({ roomId, playerId, type, sinceUnixSeconds }) {
    return !!_recent.get(roomId, playerId, type, sinceUnixSeconds);
  },
  record({ roomId, playerId, type }) {
    _insert.run(roomId, playerId, type);
  },
  deleteForRoom(roomId) {
    _deleteForRoom.run(roomId);
  },
};
