// Campaign game stats — separate from game_stats so balance data stays clean.
import { prepare } from './client.js';

const _insert = prepare(`
  INSERT INTO campaign_game_stats (
    id, campaign_id, mission_id, mission_title,
    winner, win_reason, rounds, final_phase,
    hero_kills, witch_kills,
    survivors_deployed, survivors_lost, enemies_spawned,
    has_witch, ai_personality, map_size,
    game_version, duration_ms
  ) VALUES (
    @id, @campaign_id, @mission_id, @mission_title,
    @winner, @win_reason, @rounds, @final_phase,
    @hero_kills, @witch_kills,
    @survivors_deployed, @survivors_lost, @enemies_spawned,
    @has_witch, @ai_personality, @map_size,
    @game_version, @duration_ms
  )
`);

const _countTotal = prepare('SELECT COUNT(*) AS count FROM campaign_game_stats');

const _byMission = prepare(`
  SELECT mission_id, mission_title,
         COUNT(*) AS attempts,
         SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END) AS losses,
         ROUND(AVG(rounds), 1) AS avg_rounds,
         ROUND(AVG(hero_kills), 1) AS avg_hero_kills,
         ROUND(AVG(survivors_lost), 1) AS avg_survivors_lost,
         MIN(rounds) AS fastest_win_rounds,
         ROUND(AVG(duration_ms), 0) AS avg_duration_ms
  FROM campaign_game_stats
  GROUP BY mission_id
  ORDER BY MIN(created_at)
`);

const _byCampaign = prepare(`
  SELECT campaign_id,
         COUNT(*) AS total_attempts,
         SUM(CASE WHEN winner = 'hero' THEN 1 ELSE 0 END) AS total_wins,
         SUM(CASE WHEN winner = 'witch' THEN 1 ELSE 0 END) AS total_losses,
         COUNT(DISTINCT mission_id) AS missions_attempted
  FROM campaign_game_stats
  GROUP BY campaign_id
`);

const _byReason = prepare(`
  SELECT win_reason, COUNT(*) AS count
  FROM campaign_game_stats
  GROUP BY win_reason
  ORDER BY count DESC
`);

const _averages = prepare(`
  SELECT ROUND(AVG(rounds), 1) AS avg_rounds,
         ROUND(AVG(hero_kills), 1) AS avg_hero_kills,
         ROUND(AVG(witch_kills), 1) AS avg_witch_kills,
         ROUND(AVG(survivors_deployed), 1) AS avg_survivors_deployed,
         ROUND(AVG(survivors_lost), 1) AS avg_survivors_lost,
         ROUND(AVG(enemies_spawned), 1) AS avg_enemies_spawned
  FROM campaign_game_stats
`);

const _recent = prepare(`
  SELECT id, campaign_id, mission_id, mission_title, winner, win_reason,
         rounds, hero_kills, survivors_deployed, survivors_lost, duration_ms, created_at
  FROM campaign_game_stats
  ORDER BY created_at DESC
  LIMIT 20
`);

const _listAll = prepare('SELECT * FROM campaign_game_stats');
const _truncate = prepare('DELETE FROM campaign_game_stats');

export const campaignStats = {
  insert(stats) {
    _insert.run(stats);
  },
  query(filters = {}) {
    const clauses = [];
    const params  = {};
    if (filters.campaign_id) { clauses.push('campaign_id = @campaign_id'); params.campaign_id = filters.campaign_id; }
    if (filters.mission_id)  { clauses.push('mission_id = @mission_id');   params.mission_id = filters.mission_id; }
    if (filters.winner)      { clauses.push('winner = @winner');           params.winner = filters.winner; }
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const limit = Number(filters.limit ?? 100);
    return prepare(
      `SELECT * FROM campaign_game_stats ${where} ORDER BY created_at DESC LIMIT ${limit}`
    ).all(params);
  },
  countTotal() { return _countTotal.get().count; },
  byMission()  { return _byMission.all(); },
  byCampaign() { return _byCampaign.all(); },
  byReason()   { return _byReason.all(); },
  averages()   { return _averages.get(); },
  recent()     { return _recent.all(); },
  listAll()    { return _listAll.all(); },
  truncate()   { _truncate.run(); },
};
