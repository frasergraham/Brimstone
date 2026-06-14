// Admin API helpers — query functions for the admin panel.
// All SQL delegated to server/db/*.
import db from './db.js';
import { writeFileSync, readdirSync } from 'fs';
import { dirname, join } from 'path';
import { getRooms, getRoom, getRoomChronicle } from './lobby.js';
import { getSave, getSaveRounds, getCompletedGame, getCompletedGameRounds } from './saves.js';

// ── Asset listing (for the admin asset viewer) ───────────────────────────────

/**
 * Recursively list every .glb model file under `modelsDir`, returned as
 * sorted paths relative to that dir using POSIX ('/') separators. Powers the
 * asset viewer's live model list so it shows ALL models in the game, not the
 * old hardcoded handful. Dotfiles (e.g. .DS_Store) are skipped; an unreadable
 * directory yields no entries rather than throwing.
 */
export function listModelFiles(modelsDir) {
  const out = [];
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); }
    catch { return; }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue;
      const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(join(dir, ent.name), rel);
      else if (ent.name.toLowerCase().endsWith('.glb')) out.push(rel);
    }
  };
  walk(modelsDir, '');
  return out.sort();
}

// ── Existing queries ────────────────────────────────────────────────────────

/** All registered players with full stats, newest first. */
export function getAllPlayers(limit = 500) {
  return db.players.listTop(limit);
}

/** All persisted saves — lightweight rows (no state_json), newest-first. */
export function getAllSaves() {
  return db.saves.listAdmin();
}

/** Full save row for a specific room, with state_json parsed to an object. */
export function getSaveWithState(roomId) {
  return getSave(roomId);
}

// ── Paginated all-games query ───────────────────────────────────────────────

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
        players:      r.players.map(p => ({ name: p.name, faction: p.faction, isAI: !!p.isAI })),
        human_players: humanPlayers,
        total_players: totalPlayers,
        updated_at:   Math.floor(r.createdAt / 1000),
        created_at:   Math.floor(r.createdAt / 1000),
      };
    });
  }

  // 'saved' returns the same as 'active' since all games are now loaded into memory
  if (source === 'active' || source === 'saved') {
    return { games: activeGames, total: activeGames.length, page: 1, limit };
  }

  // Only 'completed_mp' remains for DB queries
  if (source !== 'all' && source !== 'completed_mp') {
    return { games: activeGames, total: activeGames.length, page: 1, limit };
  }

  const rawGames = db.admin.listCompletedPage({ limit, offset });
  const games = rawGames.map(g => {
    if (g.players_json) {
      try {
        g.players = JSON.parse(g.players_json);
        g.human_players = g.players.filter(p => !p.isAI).length;
        g.total_players = g.players.length;
      } catch { g.players = []; }
    }
    delete g.players_json;
    g.players ??= [];
    g.human_players ??= null;
    g.total_players ??= null;
    return g;
  });
  const dbTotal = db.admin.countCompleted();

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
      const room = getRoom(id);
      if (room) {
        const summary = getRooms().find(r => r.id === id);
        const chronicle = getRoomChronicle(id) ?? [];
        return { game: summary, rounds: chronicle, canSpectate: true };
      }
      const save = getSave(id);
      if (!save) return null;
      const rounds = getSaveRounds(id);
      const { state_json, ...meta } = save;
      return { game: meta, rounds, canSpectate: false };
    }
    case 'completed_mp': {
      const game = getCompletedGame(id);
      if (!game) return null;
      const rounds = getCompletedGameRounds(id);
      return { game, rounds, canSpectate: false };
    }
    default:
      return null;
  }
}

// ── Detailed player list (absorbs /debug/players) ───────────────────────────

/**
 * All players with identities and device tokens.
 */
export function getAllPlayersDetailed() {
  const players = db.players.listDetailed();
  const identities = db.identities.listAll();
  const deviceTokens = db.deviceTokens.listAll();

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
  const gameStats = db.gameStats.listAll();
  const campaignStats = db.campaignStats.listAll();

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

  db.gameStats.truncate();
  db.campaignStats.truncate();

  return { dumped: true, file: filename, gameStatsCount: gameStats.length, campaignStatsCount: campaignStats.length };
}
