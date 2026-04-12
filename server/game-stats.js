// Game stats recording and aggregate queries — thin facade over db.gameStats.
import db from './db.js';

export function recordGameStats(stats) {
  db.gameStats.insert(stats);
}

/**
 * Query game stats with optional filters.
 * @param {{ mode?, map_size?, winner?, game_version?, limit? }} filters
 */
export function getGameStats(filters = {}) {
  return db.gameStats.query(filters);
}

/**
 * Return aggregate summary stats for the admin dashboard.
 */
export function getAggregateStats() {
  const totalGames = db.gameStats.countTotal();
  const byWinner   = db.gameStats.byWinner();
  const byWinReason = db.gameStats.byReason();
  const byMode     = db.gameStats.byMode();
  const byMapSize  = db.gameStats.byMapSize();
  const avgRounds  = db.gameStats.roundStats();
  const byVersion  = db.gameStats.byVersion();
  const byPersonality = db.gameStats.byPersonality();
  const avgKills   = db.gameStats.avgKills();

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
