// Game stats recording + aggregate queries.
import { prepare } from './client.js';

const _insert = prepare(`
  INSERT INTO game_stats (
    id, mode, map_size, winner, win_reason, rounds, final_phase,
    hero_score, witch_score, hero_kills, witch_kills,
    hero_survivors, witch_summons,
    hero_personality, witch_personality,
    hero_player_id, witch_player_id,
    game_version, fog_of_war, duration_ms
  ) VALUES (
    @id, @mode, @map_size, @winner, @win_reason, @rounds, @final_phase,
    @hero_score, @witch_score, @hero_kills, @witch_kills,
    @hero_survivors, @witch_summons,
    @hero_personality, @witch_personality,
    @hero_player_id, @witch_player_id,
    @game_version, @fog_of_war, @duration_ms
  )
`);

const _countTotal = prepare('SELECT COUNT(*) AS count FROM game_stats');

const _byWinner = prepare(`
  SELECT winner, COUNT(*) AS count FROM game_stats GROUP BY winner
`);

const _byReason = prepare(`
  SELECT win_reason, COUNT(*) AS count
  FROM game_stats GROUP BY win_reason ORDER BY count DESC
`);

const _byMode = prepare(`
  SELECT mode, COUNT(*) AS count FROM game_stats GROUP BY mode
`);

const _byMapSize = prepare(`
  SELECT map_size, COUNT(*) AS count
  FROM game_stats GROUP BY map_size ORDER BY count DESC
`);

const _roundStats = prepare(`
  SELECT ROUND(AVG(rounds), 1) AS avg_rounds,
         MIN(rounds) AS min_rounds,
         MAX(rounds) AS max_rounds
  FROM game_stats
`);

const _byVersion = prepare(`
  SELECT game_version, COUNT(*) AS count,
         SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END) AS hero_wins,
         SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END) AS witch_wins,
         ROUND(AVG(rounds), 1) AS avg_rounds
  FROM game_stats GROUP BY game_version ORDER BY game_version DESC
`);

const _byPersonality = prepare(`
  SELECT
    COALESCE(hero_personality, 'human') AS hero_personality,
    COALESCE(witch_personality, 'human') AS witch_personality,
    COUNT(*) AS count,
    SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END) AS hero_wins,
    SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END) AS witch_wins
  FROM game_stats
  GROUP BY hero_personality, witch_personality
  ORDER BY count DESC
`);

const _avgKills = prepare(`
  SELECT ROUND(AVG(hero_kills), 1) AS avg_hero_kills,
         ROUND(AVG(witch_kills), 1) AS avg_witch_kills,
         ROUND(AVG(hero_survivors), 1) AS avg_hero_survivors,
         ROUND(AVG(witch_summons), 1) AS avg_witch_summons
  FROM game_stats
`);

const _listAll = prepare('SELECT * FROM game_stats');
const _truncate = prepare('DELETE FROM game_stats');

export const gameStats = {
  insert(stats) {
    _insert.run(stats);
  },
  /** Query stats with optional filters { mode, map_size, winner, game_version, limit }. */
  query(filters = {}) {
    const clauses = [];
    const params  = {};
    if (filters.mode)         { clauses.push('mode = @mode');                 params.mode = filters.mode; }
    if (filters.map_size)     { clauses.push('map_size = @map_size');         params.map_size = filters.map_size; }
    if (filters.winner)       { clauses.push('winner = @winner');             params.winner = filters.winner; }
    if (filters.game_version) { clauses.push('game_version = @game_version'); params.game_version = filters.game_version; }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number(filters.limit ?? 100);
    return prepare(
      `SELECT * FROM game_stats ${where} ORDER BY created_at DESC LIMIT ${limit}`
    ).all(params);
  },
  countTotal()    { return _countTotal.get().count; },
  byWinner()      { return _byWinner.all(); },
  byReason()      { return _byReason.all(); },
  byMode()        { return _byMode.all(); },
  byMapSize()     { return _byMapSize.all(); },
  roundStats()    { return _roundStats.get(); },
  byVersion()     { return _byVersion.all(); },
  byPersonality() { return _byPersonality.all(); },
  avgKills()      { return _avgKills.get(); },
  listAll()       { return _listAll.all(); },
  truncate()      { _truncate.run(); },
};
