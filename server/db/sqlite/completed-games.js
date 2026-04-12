// Completed games domain (completed_games + game_replay_rounds tables).
import { prepare, transaction } from './client.js';

const _insertCompleted = prepare(`
  INSERT OR IGNORE INTO completed_games
    (game_id, room_id, hero_player_id, witch_player_id, hero_name, witch_name,
     winner, win_reason, total_rounds, game_version, mode, players_json, pinned, created_at, expires_at)
  VALUES
    (@gameId, @roomId, @heroPlayerId, @witchPlayerId, @heroName, @witchName,
     @winner, @winReason, @totalRounds, @gameVersion, @mode, @playersJson, 0,
     unixepoch(), unixepoch() + @ttlSeconds)
`);

const _insertReplayRound = prepare(`
  INSERT OR IGNORE INTO game_replay_rounds (game_id, round_num, pre_state_json, steps_json, final_entities_json)
  VALUES (@gameId, @roundNum, @preStateJson, @stepsJson, @finalEntitiesJson)
`);

const _listByPlayer = prepare(`
  SELECT game_id, room_id, hero_player_id, witch_player_id, hero_name, witch_name,
         winner, win_reason, total_rounds, game_version, mode, players_json, pinned, created_at, expires_at
  FROM   completed_games
  WHERE  hero_player_id = ? OR witch_player_id = ?
         OR players_json LIKE '%' || ? || '%'
  ORDER  BY created_at DESC
`);

const _listRounds = prepare(`
  SELECT round_num, pre_state_json, steps_json, final_entities_json
  FROM   game_replay_rounds
  WHERE  game_id = ?
  ORDER  BY round_num ASC
`);

const _getGame = prepare('SELECT * FROM completed_games WHERE game_id = ?');

const _setPinned = prepare(`
  UPDATE completed_games
  SET pinned = @pinned,
      expires_at = CASE WHEN @pinned = 1 THEN NULL ELSE unixepoch() + @ttlSeconds END
  WHERE game_id = @gameId AND (hero_player_id = @playerId OR witch_player_id = @playerId
        OR players_json LIKE '%' || @playerId || '%')
`);

const _deleteByOwner = prepare(`
  DELETE FROM completed_games
  WHERE game_id = @gameId AND (hero_player_id = @playerId OR witch_player_id = @playerId
        OR players_json LIKE '%' || @playerId || '%')
`);

const _deleteRoundsForGame = prepare(
  'DELETE FROM game_replay_rounds WHERE game_id = ?'
);

const _findExpired = prepare(`
  SELECT game_id FROM completed_games
  WHERE pinned = 0 AND expires_at IS NOT NULL AND expires_at < unixepoch()
`);

const _deleteExpired = prepare(
  'DELETE FROM completed_games WHERE game_id = ?'
);

const _listBattles = prepare(`
  SELECT game_id, room_id, hero_name, witch_name,
         winner, win_reason, total_rounds, game_version, mode,
         players_json, created_at
  FROM   completed_games
  WHERE  mode = 'battle'
  ORDER  BY created_at DESC
  LIMIT  ?
`);

const _listBattlesForPlayer = prepare(`
  SELECT game_id, room_id, hero_name, witch_name,
         winner, win_reason, total_rounds, game_version, mode,
         players_json, created_at
  FROM   completed_games
  WHERE  mode = 'battle'
    AND  (hero_player_id = ? OR witch_player_id = ?
          OR players_json LIKE '%' || ? || '%')
  ORDER  BY created_at DESC
  LIMIT  ?
`);

const _listAllAdmin = prepare(`
  SELECT game_id, room_id, hero_player_id, witch_player_id,
         hero_name, witch_name, winner, win_reason, total_rounds,
         game_version, mode, players_json, pinned, created_at, expires_at
  FROM   completed_games
  ORDER  BY created_at DESC
`);

export const completedGames = {
  /** Persist a completed game and its round-by-round replay data. */
  create(meta, rounds) {
    const run = transaction(() => {
      _insertCompleted.run(meta);
      for (const r of rounds) {
        _insertReplayRound.run({
          gameId:            meta.gameId,
          roundNum:          r.roundNum,
          preStateJson:      r.preStateJson,
          stepsJson:         r.stepsJson,
          finalEntitiesJson: r.finalEntitiesJson ?? null,
        });
      }
    });
    run();
  },
  listForPlayer(playerId) {
    return _listByPlayer.all(playerId, playerId, playerId);
  },
  listRounds(gameId) {
    return _listRounds.all(gameId);
  },
  get(gameId) {
    return _getGame.get(gameId) ?? null;
  },
  setPinned({ gameId, playerId, pinned, ttlSeconds }) {
    const { changes } = _setPinned.run({
      gameId, playerId, ttlSeconds,
      pinned: pinned ? 1 : 0,
    });
    return changes > 0;
  },
  delete({ gameId, playerId }) {
    const { changes } = _deleteByOwner.run({ gameId, playerId });
    if (changes > 0) _deleteRoundsForGame.run(gameId);
    return changes > 0;
  },
  /** Remove unpinned games past their TTL. Returns the count pruned. */
  pruneExpired() {
    const expired = _findExpired.all();
    const run = transaction(() => {
      for (const { game_id } of expired) {
        _deleteExpired.run(game_id);
        _deleteRoundsForGame.run(game_id);
      }
    });
    run();
    return expired.length;
  },
  listBattles(limit) {
    return _listBattles.all(limit);
  },
  listBattlesForPlayer(playerId, limit) {
    return _listBattlesForPlayer.all(playerId, playerId, playerId, limit);
  },
  listAllAdmin() {
    return _listAllAdmin.all();
  },
};
