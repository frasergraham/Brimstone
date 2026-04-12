// Game stats — Postgres implementation.
import { query, runMutation } from './client.js';

export const gameStats = {
  insert(stats) {
    runMutation(`
      INSERT INTO game_stats (
        id, mode, map_size, winner, win_reason, rounds, final_phase,
        hero_score, witch_score, hero_kills, witch_kills,
        hero_survivors, witch_summons,
        hero_personality, witch_personality,
        hero_player_id, witch_player_id,
        game_version, fog_of_war, duration_ms
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7,
        $8, $9, $10, $11,
        $12, $13,
        $14, $15,
        $16, $17,
        $18, $19, $20
      )
    `, [
      stats.id, stats.mode, stats.map_size, stats.winner, stats.win_reason, stats.rounds, stats.final_phase,
      stats.hero_score, stats.witch_score, stats.hero_kills, stats.witch_kills,
      stats.hero_survivors, stats.witch_summons,
      stats.hero_personality, stats.witch_personality,
      stats.hero_player_id, stats.witch_player_id,
      stats.game_version, stats.fog_of_war, stats.duration_ms,
    ]);
  },
  /** Query stats with optional filters { mode, map_size, winner, game_version, limit }. */
  query(filters = {}) {
    const clauses = [];
    const params  = [];
    if (filters.mode)         { params.push(filters.mode);         clauses.push(`mode = $${params.length}`); }
    if (filters.map_size)     { params.push(filters.map_size);     clauses.push(`map_size = $${params.length}`); }
    if (filters.winner)       { params.push(filters.winner);       clauses.push(`winner = $${params.length}`); }
    if (filters.game_version) { params.push(filters.game_version); clauses.push(`game_version = $${params.length}`); }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    params.push(Number(filters.limit ?? 100));
    return query(
      `SELECT * FROM game_stats ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
      params
    );
  },
  countTotal() {
    return Number(query('SELECT COUNT(*) AS count FROM game_stats')[0].count);
  },
  byWinner() {
    return query('SELECT winner, COUNT(*)::int AS count FROM game_stats GROUP BY winner');
  },
  byReason() {
    return query(`
      SELECT win_reason, COUNT(*)::int AS count
      FROM game_stats GROUP BY win_reason ORDER BY count DESC
    `);
  },
  byMode() {
    return query('SELECT mode, COUNT(*)::int AS count FROM game_stats GROUP BY mode');
  },
  byMapSize() {
    return query(`
      SELECT map_size, COUNT(*)::int AS count
      FROM game_stats GROUP BY map_size ORDER BY count DESC
    `);
  },
  roundStats() {
    const r = query(`
      SELECT ROUND(AVG(rounds)::numeric, 1) AS avg_rounds,
             MIN(rounds)::int AS min_rounds,
             MAX(rounds)::int AS max_rounds
      FROM game_stats
    `)[0];
    if (r && r.avg_rounds != null) r.avg_rounds = Number(r.avg_rounds);
    return r;
  },
  byVersion() {
    return query(`
      SELECT game_version, COUNT(*)::int AS count,
             SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END)::int AS hero_wins,
             SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END)::int AS witch_wins,
             ROUND(AVG(rounds)::numeric, 1)::float AS avg_rounds
      FROM game_stats GROUP BY game_version ORDER BY game_version DESC
    `);
  },
  byPersonality() {
    return query(`
      SELECT
        COALESCE(hero_personality, 'human') AS hero_personality,
        COALESCE(witch_personality, 'human') AS witch_personality,
        COUNT(*)::int AS count,
        SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END)::int AS hero_wins,
        SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END)::int AS witch_wins
      FROM game_stats
      GROUP BY hero_personality, witch_personality
      ORDER BY count DESC
    `);
  },
  avgKills() {
    const r = query(`
      SELECT ROUND(AVG(hero_kills)::numeric, 1)::float AS avg_hero_kills,
             ROUND(AVG(witch_kills)::numeric, 1)::float AS avg_witch_kills,
             ROUND(AVG(hero_survivors)::numeric, 1)::float AS avg_hero_survivors,
             ROUND(AVG(witch_summons)::numeric, 1)::float AS avg_witch_summons
      FROM game_stats
    `)[0];
    return r;
  },
  listAll() {
    return query('SELECT * FROM game_stats');
  },
  truncate() {
    runMutation('DELETE FROM game_stats');
  },
};
