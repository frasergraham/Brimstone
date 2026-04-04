// Admin API helpers — query functions for the admin panel.
import db from './db.js';
import { writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { getRooms, getRoom, getRoomChronicle } from './lobby.js';
import { getSave, getSaveRounds, getCompletedGame, getCompletedGameRounds,
         getSpCompletedGame, getSpCompletedGameRounds } from './saves.js';

// ── Existing queries ────────────────────────────────────────────────────────

/** All registered players with full stats, newest first. */
export function getAllPlayers(limit = 500) {
  return db.prepare(`
    SELECT id, username, wins, losses, draws, created_at,
           ROUND(CAST(wins AS REAL) / MAX(wins + losses + draws, 1) * 100, 1) AS win_pct
    FROM   players
    ORDER  BY wins DESC, created_at DESC
    LIMIT  ?
  `).all(limit);
}

/** All persisted saves — lightweight rows (no state_json), newest-first. */
export function getAllSaves() {
  return db.prepare(`
    SELECT room_id, hero_player_id, witch_player_id, hero_name, witch_name,
           round, phase, game_version, updated_at, created_at
    FROM   game_saves
    ORDER  BY updated_at DESC
  `).all();
}

/** Full save row for a specific room, with state_json parsed to an object. */
export function getSaveWithState(roomId) {
  return getSave(roomId);
}

// ── Paginated all-games query ───────────────────────────────────────────────

const _SOURCE_QUERIES = {
  saved: {
    select: `SELECT room_id AS id, 'saved' AS source, hero_name, witch_name, round, phase,
                    NULL AS winner, NULL AS win_reason, game_version, NULL AS mode,
                    NULL AS players_json, updated_at, created_at
             FROM game_saves`,
    count:  `SELECT COUNT(*) AS cnt FROM game_saves`,
  },
  completed_mp: {
    select: `SELECT game_id AS id, 'completed_mp' AS source, hero_name, witch_name,
                    total_rounds AS round, NULL AS phase, winner, win_reason,
                    game_version, mode, players_json,
                    created_at AS updated_at, created_at
             FROM completed_games`,
    count:  `SELECT COUNT(*) AS cnt FROM completed_games`,
  },
  completed_sp: {
    select: `SELECT game_id AS id, 'completed_sp' AS source, hero_name, witch_name,
                    total_rounds AS round, NULL AS phase, winner, win_reason,
                    game_version, mode, NULL AS players_json,
                    created_at AS updated_at, created_at
             FROM sp_completed_games`,
    count:  `SELECT COUNT(*) AS cnt FROM sp_completed_games`,
  },
};

/**
 * Paginated listing of all games across sources.
 * Active in-memory games are returned separately (always small set).
 */
export function getAllGamesPaginated({ page = 1, limit = 50, source = 'all' } = {}) {
  const offset = (page - 1) * limit;

  // Active in-memory games (always returned, not paginated from DB)
  let activeGames = [];
  if (source === 'all' || source === 'active') {
    activeGames = getRooms().map(r => {
      const totalPlayers = r.players.length;
      const humanPlayers = r.players.filter(p => !p.isAI).length;
      return {
        id:           r.id,
        source:       'active',
        hero_name:    r.players.find(p => p.faction === 'hero')?.name ?? '',
        witch_name:   r.players.find(p => p.faction === 'witch')?.name ?? '',
        round:        r.round,
        phase:        r.phase,
        winner:       r.winner,
        win_reason:   null,
        game_version: null,
        mode:         null,
        human_players: humanPlayers,
        total_players: totalPlayers,
        updated_at:   Math.floor(r.createdAt / 1000),
        created_at:   Math.floor(r.createdAt / 1000),
      };
    });
  }

  if (source === 'active') {
    return { games: activeGames, total: activeGames.length, page: 1, limit };
  }

  // Build DB query from selected sources
  const sources = source === 'all'
    ? ['saved', 'completed_mp', 'completed_sp']
    : [source];

  const selects = sources.map(s => _SOURCE_QUERIES[s]?.select).filter(Boolean);
  const counts  = sources.map(s => _SOURCE_QUERIES[s]?.count).filter(Boolean);

  if (selects.length === 0) {
    return { games: activeGames, total: activeGames.length, page: 1, limit };
  }

  const unionSelect = selects.join(' UNION ALL ') + ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  const unionCount  = counts.join(' UNION ALL ');

  const rawGames = db.prepare(unionSelect).all(limit, offset);
  const games = rawGames.map(g => {
    if (g.players_json) {
      try {
        const players = JSON.parse(g.players_json);
        g.human_players = players.filter(p => !p.isAI).length;
        g.total_players = players.length;
      } catch { /* ignore parse errors */ }
    }
    delete g.players_json;
    g.human_players ??= null;
    g.total_players ??= null;
    return g;
  });
  const countRows = db.prepare(`SELECT SUM(cnt) AS total FROM (${unionCount})`).get();
  const dbTotal = countRows?.total ?? 0;

  // On page 1, prepend active games
  const allGames = page === 1 ? [...activeGames, ...games] : games;
  const total = dbTotal + activeGames.length;

  return { games: allGames, total, page, limit };
}

// ── Game detail ─────────────────────────────────────────────────────────────

/**
 * Get full detail for a single game, dispatching based on source type.
 * Returns { game, rounds, canSpectate } or null.
 */
export function getGameDetail(id, source) {
  switch (source) {
    case 'active': {
      const room = getRoom(id);
      if (!room) return null;
      const summary = getRooms().find(r => r.id === id);
      const chronicle = getRoomChronicle(id) ?? [];
      return { game: summary, rounds: chronicle, canSpectate: true };
    }
    case 'saved': {
      const save = getSave(id);
      if (!save) return null;
      const rounds = getSaveRounds(id);
      // Strip state_json from the response (can be huge)
      const { state_json, ...meta } = save;
      return { game: meta, rounds, canSpectate: false };
    }
    case 'completed_mp': {
      const game = getCompletedGame(id);
      if (!game) return null;
      const rounds = getCompletedGameRounds(id);
      return { game, rounds, canSpectate: false };
    }
    case 'completed_sp': {
      const game = getSpCompletedGame(id);
      if (!game) return null;
      const rounds = getSpCompletedGameRounds(id);
      return { game, rounds, canSpectate: false };
    }
    default:
      return null;
  }
}

// ── Detailed player list (absorbs /debug/players) ───────────────────────────

/**
 * All players with identities and device tokens.
 * Replaces the old unauthenticated /debug/players route.
 */
export function getAllPlayersDetailed() {
  const players = db.prepare(`
    SELECT p.id, p.username, p.discriminator, p.token, p.wins, p.losses, p.draws,
           p.is_admin, p.created_at,
           ROUND(CAST(p.wins AS REAL) / MAX(p.wins + p.losses + p.draws, 1) * 100, 1) AS win_pct
    FROM players p
    ORDER BY p.created_at DESC
  `).all();

  const identities = db.prepare(`
    SELECT player_id, provider, provider_id, created_at
    FROM player_identities
  `).all();

  const deviceTokens = db.prepare(`
    SELECT player_id, token AS device_token, platform, updated_at
    FROM device_tokens
  `).all();

  // Group by player
  const idMap = new Map();
  const dtMap = new Map();
  for (const i of identities) {
    if (!idMap.has(i.player_id)) idMap.set(i.player_id, []);
    idMap.get(i.player_id).push(i);
  }
  for (const dt of deviceTokens) {
    if (!dtMap.has(dt.player_id)) dtMap.set(dt.player_id, []);
    dtMap.get(dt.player_id).push(dt);
  }

  return players.map(p => ({
    ...p,
    token_short: p.token?.slice(0, 8) ?? '',
    identities: idMap.get(p.id) ?? [],
    device_tokens: dtMap.get(p.id) ?? [],
  }));
}

// ── Stats reset with dump ──────────────────────────────────────────────────

/**
 * Dump game_stats and campaign_game_stats to a JSON file alongside the DB,
 * then truncate both tables. Returns the dump file path.
 */
export function resetStats(version) {
  const gameStats = db.prepare('SELECT * FROM game_stats').all();
  const campaignStats = db.prepare('SELECT * FROM campaign_game_stats').all();

  if (gameStats.length === 0 && campaignStats.length === 0) {
    return { dumped: false, reason: 'No stats to reset.' };
  }

  // Build dump filename: stats-dump-<version>-<YYYY-MM-DD-HHmmss>.json
  const now = new Date();
  const ts = now.toISOString().replace(/[T:]/g, '-').replace(/\..+/, '');
  const filename = `stats-dump-${version}-${ts}.json`;

  // Resolve DB file path to place dump alongside it
  const dbPath = process.env.DB_PATH || join(dirname(new URL(import.meta.url).pathname), '..', 'data', 'brimstone.db');
  const dumpPath = join(dirname(dbPath), filename);

  const dump = {
    version,
    dumpedAt: now.toISOString(),
    gameStats,
    campaignStats,
  };

  writeFileSync(dumpPath, JSON.stringify(dump, null, 2));

  db.prepare('DELETE FROM game_stats').run();
  db.prepare('DELETE FROM campaign_game_stats').run();

  return { dumped: true, file: filename, gameStatsCount: gameStats.length, campaignStatsCount: campaignStats.length };
}
