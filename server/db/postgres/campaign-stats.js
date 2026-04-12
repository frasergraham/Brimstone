// Campaign game stats — Postgres implementation.
import { query, runMutation } from './client.js';

export const campaignStats = {
  insert(stats) {
    runMutation(`
      INSERT INTO campaign_game_stats (
        id, campaign_id, mission_id, mission_title,
        winner, win_reason, rounds, final_phase,
        hero_kills, witch_kills,
        survivors_deployed, survivors_lost, enemies_spawned,
        has_witch, ai_personality, map_size,
        game_version, duration_ms
      ) VALUES (
        $1, $2, $3, $4,
        $5, $6, $7, $8,
        $9, $10,
        $11, $12, $13,
        $14, $15, $16,
        $17, $18
      )
    `, [
      stats.id, stats.campaign_id, stats.mission_id, stats.mission_title,
      stats.winner, stats.win_reason, stats.rounds, stats.final_phase,
      stats.hero_kills, stats.witch_kills,
      stats.survivors_deployed, stats.survivors_lost, stats.enemies_spawned,
      stats.has_witch, stats.ai_personality, stats.map_size,
      stats.game_version, stats.duration_ms,
    ]);
  },
  query(filters = {}) {
    const clauses = [];
    const params  = [];
    if (filters.campaign_id) { params.push(filters.campaign_id); clauses.push(`campaign_id = $${params.length}`); }
    if (filters.mission_id)  { params.push(filters.mission_id);  clauses.push(`mission_id = $${params.length}`); }
    if (filters.winner)      { params.push(filters.winner);      clauses.push(`winner = $${params.length}`); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Number(filters.limit ?? 100));
    return query(
      `SELECT * FROM campaign_game_stats ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
  },
  countTotal() {
    return Number(query('SELECT COUNT(*) AS count FROM campaign_game_stats')[0].count);
  },
  byMission() {
    return query(`
      SELECT mission_id, mission_title,
             COUNT(*)::int AS attempts,
             SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END)::int AS wins,
             SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END)::int AS losses,
             ROUND(AVG(rounds)::numeric, 1)::float AS avg_rounds,
             ROUND(AVG(hero_kills)::numeric, 1)::float AS avg_hero_kills,
             ROUND(AVG(survivors_lost)::numeric, 1)::float AS avg_survivors_lost,
             MIN(rounds)::int AS fastest_win_rounds,
             ROUND(AVG(duration_ms)::numeric, 0)::float AS avg_duration_ms
      FROM campaign_game_stats
      GROUP BY mission_id
      ORDER BY MIN(created_at)
    `);
  },
  byCampaign() {
    return query(`
      SELECT campaign_id,
             COUNT(*)::int AS total_attempts,
             SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END)::int AS total_wins,
             SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END)::int AS total_losses,
             COUNT(DISTINCT mission_id)::int AS missions_attempted
      FROM campaign_game_stats
      GROUP BY campaign_id
    `);
  },
  byReason() {
    return query(`
      SELECT win_reason, COUNT(*)::int AS count
      FROM campaign_game_stats
      GROUP BY win_reason
      ORDER BY count DESC
    `);
  },
  averages() {
    return query(`
      SELECT ROUND(AVG(rounds)::numeric, 1)::float AS avg_rounds,
             ROUND(AVG(hero_kills)::numeric, 1)::float AS avg_hero_kills,
             ROUND(AVG(witch_kills)::numeric, 1)::float AS avg_witch_kills,
             ROUND(AVG(survivors_deployed)::numeric, 1)::float AS avg_survivors_deployed,
             ROUND(AVG(survivors_lost)::numeric, 1)::float AS avg_survivors_lost,
             ROUND(AVG(enemies_spawned)::numeric, 1)::float AS avg_enemies_spawned
      FROM campaign_game_stats
    `)[0];
  },
  recent() {
    return query(`
      SELECT id, campaign_id, mission_id, mission_title, winner, win_reason,
             rounds, hero_kills, survivors_deployed, survivors_lost, duration_ms, created_at
      FROM campaign_game_stats
      ORDER BY created_at DESC
      LIMIT 20
    `);
  },
  listAll() {
    return query('SELECT * FROM campaign_game_stats');
  },
  truncate() {
    runMutation('DELETE FROM campaign_game_stats');
  },
};
