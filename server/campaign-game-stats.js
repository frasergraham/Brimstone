// Campaign game stats recording and aggregate queries — facade over db.campaignStats.
// Kept separate from standard game_stats so campaign metrics don't pollute balance data.
import db from './db.js';

export function recordCampaignGameStats(stats) {
  db.campaignStats.insert(stats);
}

/**
 * Query campaign game stats with optional filters.
 * @param {{ campaign_id?, mission_id?, winner?, limit? }} filters
 */
export function getCampaignGameStats(filters = {}) {
  return db.campaignStats.query(filters);
}

/**
 * Return aggregate campaign stats for the dashboard.
 */
export function getCampaignAggregateStats() {
  const totalAttempts = db.campaignStats.countTotal();
  const byMission = db.campaignStats.byMission();
  const byCampaign = db.campaignStats.byCampaign();
  const byWinReason = db.campaignStats.byReason();
  const avgStats = db.campaignStats.averages();
  const recentGames = db.campaignStats.recent();

  return {
    totalAttempts,
    byMission,
    byCampaign,
    byWinReason,
    avgRounds:            avgStats?.avg_rounds ?? 0,
    avgHeroKills:         avgStats?.avg_hero_kills ?? 0,
    avgWitchKills:        avgStats?.avg_witch_kills ?? 0,
    avgSurvivorsDeployed: avgStats?.avg_survivors_deployed ?? 0,
    avgSurvivorsLost:     avgStats?.avg_survivors_lost ?? 0,
    avgEnemiesSpawned:    avgStats?.avg_enemies_spawned ?? 0,
    recentGames,
  };
}
