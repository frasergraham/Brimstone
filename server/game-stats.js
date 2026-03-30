// Game stats recording and aggregate queries
import db from './db.js';

const _insert = db.prepare(`
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

export function recordGameStats(stats) {
  _insert.run(stats);
}

/**
 * Query game stats with optional filters.
 * @param {{ mode?, map_size?, winner?, game_version?, limit? }} filters
 */
export function getGameStats(filters = {}) {
  const clauses = [];
  const params  = {};

  if (filters.mode)         { clauses.push('mode = @mode');                 params.mode = filters.mode; }
  if (filters.map_size)     { clauses.push('map_size = @map_size');         params.map_size = filters.map_size; }
  if (filters.winner)       { clauses.push('winner = @winner');             params.winner = filters.winner; }
  if (filters.game_version) { clauses.push('game_version = @game_version'); params.game_version = filters.game_version; }

  const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = filters.limit ?? 100;

  return db.prepare(`
    SELECT * FROM game_stats ${where}
    ORDER BY created_at DESC
    LIMIT ${Number(limit)}
  `).all(params);
}

/**
 * Return aggregate summary stats for the admin dashboard.
 */
export function getAggregateStats() {
  const total = db.prepare('SELECT COUNT(*) AS count FROM game_stats').get();

  const byWinner = db.prepare(`
    SELECT winner, COUNT(*) AS count
    FROM game_stats GROUP BY winner
  `).all();

  const byWinReason = db.prepare(`
    SELECT win_reason, COUNT(*) AS count
    FROM game_stats GROUP BY win_reason ORDER BY count DESC
  `).all();

  const byMode = db.prepare(`
    SELECT mode, COUNT(*) AS count
    FROM game_stats GROUP BY mode
  `).all();

  const byMapSize = db.prepare(`
    SELECT map_size, COUNT(*) AS count
    FROM game_stats GROUP BY map_size ORDER BY count DESC
  `).all();

  const avgRounds = db.prepare(`
    SELECT ROUND(AVG(rounds), 1) AS avg_rounds,
           MIN(rounds) AS min_rounds,
           MAX(rounds) AS max_rounds
    FROM game_stats
  `).get();

  const byVersion = db.prepare(`
    SELECT game_version, COUNT(*) AS count,
           SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END) AS hero_wins,
           SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END) AS witch_wins,
           ROUND(AVG(rounds), 1) AS avg_rounds
    FROM game_stats GROUP BY game_version ORDER BY game_version DESC
  `).all();

  const byPersonality = db.prepare(`
    SELECT
      COALESCE(hero_personality, 'human') AS hero_personality,
      COALESCE(witch_personality, 'human') AS witch_personality,
      COUNT(*) AS count,
      SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END) AS hero_wins,
      SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END) AS witch_wins
    FROM game_stats
    GROUP BY hero_personality, witch_personality
    ORDER BY count DESC
  `).all();

  const avgKills = db.prepare(`
    SELECT ROUND(AVG(hero_kills), 1) AS avg_hero_kills,
           ROUND(AVG(witch_kills), 1) AS avg_witch_kills,
           ROUND(AVG(hero_survivors), 1) AS avg_hero_survivors,
           ROUND(AVG(witch_summons), 1) AS avg_witch_summons
    FROM game_stats
  `).get();

  const totalGames = total.count;
  const heroWins  = byWinner.find(r => r.winner === 'hero')?.count  ?? 0;
  const witchWins = byWinner.find(r => r.winner === 'witch')?.count ?? 0;

  return {
    totalGames,
    heroWins,
    witchWins,
    heroWinPct: totalGames > 0 ? Math.round(heroWins / totalGames * 1000) / 10 : 0,
    witchWinPct: totalGames > 0 ? Math.round(witchWins / totalGames * 1000) / 10 : 0,
    byWinReason,
    byMode,
    byMapSize,
    avgRounds: avgRounds?.avg_rounds ?? 0,
    minRounds: avgRounds?.min_rounds ?? 0,
    maxRounds: avgRounds?.max_rounds ?? 0,
    byVersion,
    byPersonality,
    avgHeroKills: avgKills?.avg_hero_kills ?? 0,
    avgWitchKills: avgKills?.avg_witch_kills ?? 0,
    avgHeroSurvivors: avgKills?.avg_hero_survivors ?? 0,
    avgWitchSummons: avgKills?.avg_witch_summons ?? 0,
  };
}
