// Brimstone multiplayer server — Express (static files) + WebSocket (game protocol)
import express    from 'express';
import { WebSocketServer } from 'ws';
import { createServer }    from 'http';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

import { VERSION, BUILD_VERSION, SAVE_VERSION } from './src/version.js';
import {
  registerOrLogin, getPlayerByToken, getPlayerByEmail,
  linkEmail, loginByEmail, getPlayerIdentities, changeUsername,
  getOrCreateByEmail, getOrCreateByGameCenter, linkGameCenter,
  getPlayersByGameCenterIds, setAdmin,
} from './server/auth.js';
import { generateToken, verifyToken, sendMagicLinkEmail } from './server/magic-link.js';
import { getLeaderboard }                    from './server/leaderboard.js';
import db                                    from './server/db.js';
import { recordGameStats, getGameStats, getAggregateStats } from './server/game-stats.js';
import { recordCampaignGameStats, getCampaignGameStats, getCampaignAggregateStats } from './server/campaign-game-stats.js';
import { upsertCampaignSave, getCampaignSave, getCampaignSaves, deleteCampaignSave } from './server/campaign-saves.js';
import { pruneStaleAndIncompatibleSaves,
         getCompletedGames, getCompletedGame, getCompletedGameRounds,
         pinCompletedGame, deleteCompletedGame,
         pruneExpiredCompletedGames, getAllCompletedGames,
         getSaveRounds, getCompletedBattles,
         getCompletedBattlesForPlayer }                    from './server/saves.js';
import {
  createLobby, joinLobby, joinGame, browseLobby, claimSlot, setFaction,
  setSlotAI, removeSlotAI, fillAllWithAI, startGame, leaveLobby, resignGame,
  sendSlotInvite as sendSlotInviteHandler, sendFriendInvite as sendFriendInviteHandler,
  handleAction, handleEndTurn, handlePlanSubmit, handleNudge,
  handleDisconnect, handleReconnect,
  resumeGame, adminResumeGame,
  getRoom,
  getRooms, getQueue, getActiveRoomsForPlayer,
  subscribeSpectator, unsubscribeSpectator, getRoomChronicle,
  // Async game support (legacy — kept for migration)
  createAsyncGameRoom, joinAsyncGameRoom,
  connectToAsyncGame, handleAsyncPlanSubmit, handleAsyncDisconnect,
  checkAsyncDeadlines, pruneAsyncGames,
  getAsyncGamesForPlayer,
  // Unified system
  checkDeadlines, checkApproachingDeadlines, migrateAsyncGames,
  pruneOrphanedRooms,
  broadcastPresenceForPlayer,
  setSendToPlayer,
  joinBattle, getBattleStatus,
  forceEndGame, loadAllRooms, nukeGame, adminKickPlayer,
  getReplayForRound,
} from './server/lobby.js';
import { ensureBattleExists, checkBattleLifecycle, endBattleEarly } from './server/battle-scheduler.js';
import {
  getAllPlayers, getAllSaves, getSaveWithState,
  getAllGamesPaginated, getGameDetail, getAllPlayersDetailed, resetStats,
} from './server/admin.js';
import { deleteAsyncGame as _deleteAsyncGame,
         getAsyncGame as _getAsyncGame,
         getAsyncGameByCode }                  from './server/async-game.js';
import { serializeState } from './server/state-sync.js';
import { getGameModeConfig, getDevMode } from './server/game-mode-config.js';
import {
  getPersonalities as getRemoteBattlePersonalities,
  listBattleRooms as listRemoteBattleRooms,
  addPlayer as addRemoteBattlePlayer,
  takeTurn as takeRemoteBattleTurn,
  takeAllTurns as takeAllRemoteBattleTurns,
  submitPlan as submitRemoteBattlePlan,
  resignPlayer as resignRemoteBattlePlayer,
  getRemoteAIStatus,
  getRoomRemoteStatus,
} from './server/remote-battle.js';
import { upsertDeviceToken, deleteDeviceToken, pruneStaleTokens } from './server/push.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3000;
const ADMIN_OPEN = process.env.ADMIN_OPEN === '1' || process.env.ADMIN_OPEN === 'true';

/** Set to true once all saved games have been loaded into memory. */
let _serverReady = false;

// ── Express ──────────────────────────────────────────────────────────────────

const app = express();

// CORS — allow Capacitor native shells (capacitor://localhost, http://localhost, calebshollow://)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (
    origin.startsWith('capacitor://') ||
    origin.startsWith('calebshollow://') ||
    origin.startsWith('http://localhost')
  )) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-token');
  }
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

app.use(express.json());

// Readiness gate — reject game API requests until all games are loaded into memory.
// Admin endpoints and auth checks pass through so the admin panel works during startup.
app.use((req, res, next) => {
  if (_serverReady) { next(); return; }
  // Allow through: health, admin panel, auth, static assets
  if (req.path === '/health' || req.path.startsWith('/admin/api/') ||
      req.path === '/api/me/admin' || req.path === '/api/config' ||
      !req.path.startsWith('/api/')) {
    next();
    return;
  }
  res.status(503).json({ error: 'Server is starting up. Please try again shortly.' });
});

// Block direct static access to admin HTML files — they're served via auth-gated routes
app.use((req, res, next) => {
  if (/^\/admin.*\.html$/i.test(req.path)) {
    res.status(403).send('Forbidden');
    return;
  }
  next();
});

// Apple App Site Association must be served as application/json
app.get('/.well-known/apple-app-site-association', (_req, res) => {
  const filePath = join(__dirname, '.well-known', 'apple-app-site-association');
  res.sendFile(filePath, { headers: { 'Content-Type': 'application/json' } }, (err) => {
    if (err && !res.headersSent) res.status(404).end();
  });
});

app.use(express.static(join(__dirname)));   // serve game files from repo root

// Health check — Railway pings this to confirm the service is up
app.get('/health', (_req, res) => {
  res.json({
    status:      'ok',
    version:     BUILD_VERSION,
    uptime:      Math.floor(process.uptime()),
    connections: clients.size,
  });
});

// REST: client configuration (game mode visibility, etc.)
app.get('/api/config', (_req, res) => {
  const payload = { modes: getGameModeConfig() };
  if (getDevMode()) payload.devMode = true;
  res.json(payload);
});

// REST: Battle for Caleb's Hollow status
app.get('/api/battle-status', (req, res) => {
  // Try to extract player ID from session token for player-specific fields
  let playerId = null;
  const token = req.query.token || req.headers['x-session-token'];
  if (token) {
    try {
      const row = db.prepare('SELECT id FROM players WHERE token = ?').get(token);
      if (row) playerId = row.id;
    } catch { /* ignore */ }
  }
  res.json(getBattleStatus(playerId));
});

// REST: Past battle replays — only shows battles the requesting player participated in
app.get('/api/battle-history', (req, res) => {
  try {
    let playerId = null;
    const token = req.query.token || req.headers['x-session-token'];
    if (token) {
      try {
        const row = db.prepare('SELECT id FROM players WHERE token = ?').get(token);
        if (row) playerId = row.id;
      } catch { /* ignore */ }
    }
    if (!playerId) { res.json([]); return; }
    const battles = getCompletedBattlesForPlayer(playerId, 20);
    // Annotate each battle with the requesting player's faction
    for (const b of battles) {
      if (b.players_json) {
        try {
          const players = JSON.parse(b.players_json);
          const me = players.find(p => p.playerId === playerId);
          if (me) b._myFaction = me.faction;
        } catch { /* ignore */ }
      }
    }
    res.json(battles);
  } catch { res.json([]); }
});

// REST: Railway environment auto-discovery for the server selector
// Requires RAILWAY_API_TOKEN + RAILWAY_PROJECT_ID env vars.
let _envCache = null;
let _envCacheTime = 0;
const ENV_CACHE_TTL = 60_000; // 60 s

app.get('/api/environments', async (_req, res) => {
  if (!getDevMode()) { res.json([]); return; }

  const token     = process.env.RAILWAY_API_TOKEN;
  const projectId = process.env.RAILWAY_PROJECT_ID;
  if (!token || !projectId) { res.json([]); return; }

  // Serve from cache if fresh
  if (_envCache && Date.now() - _envCacheTime < ENV_CACHE_TTL) {
    res.json(_envCache);
    return;
  }

  try {
    const query = `
      query ($projectId: String!) {
        environments(projectId: $projectId) {
          edges { node { id name deployments(first: 1) {
            edges { node { staticUrl } }
          } } }
        }
      }`;
    const resp = await fetch('https://backboard.railway.app/graphql/v2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ query, variables: { projectId } }),
    });
    const json = await resp.json();
    const edges = json?.data?.environments?.edges || [];
    const envs = edges
      .map(e => {
        const staticUrl = e.node.deployments?.edges?.[0]?.node?.staticUrl;
        if (!staticUrl) return null;
        return { label: e.node.name, url: `https://${staticUrl}` };
      })
      .filter(Boolean);

    _envCache = envs;
    _envCacheTime = Date.now();
    res.json(envs);
  } catch (err) {
    console.warn('[environments] Railway API query failed:', err.message);
    res.json(_envCache || []);
  }
});

// REST: leaderboard (also exposed over WS, but handy for embedding)
app.get('/api/leaderboard', (_req, res) => {
  res.json(getLeaderboard(20));
});

// REST: all in-progress games for a player (unified — in-memory + hibernated)
app.get('/api/games', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  res.json(getActiveRoomsForPlayer(player.id));
});

// Legacy alias — same data
app.get('/api/saves', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  res.json(getActiveRoomsForPlayer(player.id));
});

// REST: async games for a player
app.get('/api/async-games', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  const games = getAsyncGamesForPlayer(player.id);
  // Enrich with player-relative fields
  const enriched = games.map(g => {
    const myFaction = g.hero_player_id === player.id ? 'hero' : (g.witch_player_id === player.id ? 'witch' : g.host_faction);
    const oppName = myFaction === 'hero' ? (g.witch_name || 'Witch') : (g.hero_name || 'Hero');
    return { ...g, state_json: undefined, my_faction: myFaction, opponent_name: oppName };
  });
  res.json(enriched);
});

app.post('/api/async-games', (req, res) => {
  const token = req.body?.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  const result = createAsyncGameRoom(player.id, player.username, req.body);
  if (result.error) { res.status(400).json(result); return; }
  res.json(result);
});

app.post('/api/async-games/join', (req, res) => {
  const token = req.body?.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  const code = (req.body?.code || '').toUpperCase().trim();
  if (!code) { res.status(400).json({ error: 'Game code required.' }); return; }
  const result = joinAsyncGameRoom(player.id, player.username, code);
  if (result.error) { res.status(400).json(result); return; }
  res.json(result);
});

app.delete('/api/async-games/:roomId', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  const game = _getAsyncGame(req.params.roomId);
  if (!game) { res.status(404).json({ error: 'Not found.' }); return; }
  if (game.hero_player_id !== player.id && game.witch_player_id !== player.id && game.host_player_id !== player.id) {
    res.status(403).json({ error: 'Forbidden.' }); return;
  }
  _deleteAsyncGame(req.params.roomId);
  res.json({ ok: true });
});

// REST: replay rounds for an async game
app.get('/api/async-games/:roomId/rounds', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  const game = _getAsyncGame(req.params.roomId);
  if (!game) { res.status(404).json({ error: 'Not found.' }); return; }
  if (game.hero_player_id !== player.id && game.witch_player_id !== player.id && game.host_player_id !== player.id) {
    res.status(403).json({ error: 'Forbidden.' }); return;
  }
  res.json(getSaveRounds(req.params.roomId));
});

// REST: completed games for a player
app.get('/api/completed-games', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  res.json(getCompletedGames(player.id));
});

app.get('/api/completed-games/:gameId/rounds', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  const game = getCompletedGame(req.params.gameId);
  if (!game) { res.status(404).json({ error: 'Not found.' }); return; }
  const isParticipant = game.hero_player_id === player.id
    || game.witch_player_id === player.id
    || (game.players_json || '').includes(player.id);
  if (!isParticipant) {
    res.status(403).json({ error: 'Forbidden.' }); return;
  }
  res.json(getCompletedGameRounds(req.params.gameId));
});

app.post('/api/completed-games/:gameId/pin', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  const pinned = !!req.body?.pinned;
  const ok = pinCompletedGame(req.params.gameId, player.id, pinned);
  if (!ok) { res.status(404).json({ error: 'Not found or forbidden.' }); return; }
  res.json({ ok: true, pinned });
});

app.delete('/api/completed-games/:gameId', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  const ok = deleteCompletedGame(req.params.gameId, player.id);
  if (!ok) { res.status(404).json({ error: 'Not found or forbidden.' }); return; }
  res.json({ ok: true });
});

// REST: record game stats (used by local/offline mode)
app.post('/api/game-stats', (req, res) => {
  try {
    const stats = req.body;
    if (!stats?.id || !stats?.winner || !stats?.win_reason) {
      res.status(400).json({ error: 'Missing required fields.' });
      return;
    }
    recordGameStats(stats);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/game-stats error:', err);
    res.status(500).json({ error: 'Failed to record stats.' });
  }
});

// REST: record campaign game stats
app.post('/api/campaign-game-stats', (req, res) => {
  try {
    const stats = req.body;
    if (!stats?.id || !stats?.campaign_id || !stats?.mission_id || !stats?.winner) {
      res.status(400).json({ error: 'Missing required fields.' });
      return;
    }
    recordCampaignGameStats(stats);
    res.json({ ok: true });
  } catch (err) {
    console.error('POST /api/campaign-game-stats error:', err);
    res.status(500).json({ error: 'Failed to record campaign stats.' });
  }
});

// ── Auth: magic link endpoints ────────────────────────────────────────────────

// Link an email to an existing account (authenticated player)
app.post('/auth/link-email', async (req, res) => {
  const { token, email } = req.body || {};
  if (!token || !email) {
    res.status(400).json({ error: 'Token and email are required.' });
    return;
  }

  const player = getPlayerByToken(token);
  if (!player) {
    console.warn('[link-email] Token lookup failed — likely stale client session');
    res.status(401).json({ error: 'Invalid session.' });
    return;
  }

  // Validate email format (basic)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email address.' });
    return;
  }

  // Check if already linked to another account
  const existing = getPlayerByEmail(email);
  if (existing && existing.id !== player.id) {
    res.status(409).json({ error: 'This email is already linked to another account.' });
    return;
  }
  if (existing && existing.id === player.id) {
    res.json({ ok: true, message: 'Email already linked.' });
    return;
  }

  const magicToken = generateToken(email, player.id);
  const result = await sendMagicLinkEmail(email, magicToken, { isLink: true });
  if (!result.ok) { res.status(500).json({ error: result.error }); return; }

  res.json({ ok: true, message: 'Magic link sent! Check your email.' });
});

// Request a login link for an existing account (from a new device)
app.post('/auth/login-email', async (req, res) => {
  const { email } = req.body || {};
  if (!email) { res.status(400).json({ error: 'Email is required.' }); return; }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    res.status(400).json({ error: 'Invalid email address.' });
    return;
  }

  const player = getPlayerByEmail(email);
  if (!player) {
    // Don't reveal whether the email exists — still return success
    res.json({ ok: true, message: 'If an account exists for this email, a login link has been sent.' });
    return;
  }

  const magicToken = generateToken(email, player.id);
  const result = await sendMagicLinkEmail(email, magicToken, { isLink: false });
  if (!result.ok) { res.status(500).json({ error: result.error }); return; }

  res.json({ ok: true, message: 'If an account exists for this email, a login link has been sent.' });
});

// Verify a magic link token — redirect to game with session
app.get('/auth/verify', (req, res) => {
  const { token } = req.query;
  if (!token) { res.status(400).send('Missing token.'); return; }

  const result = verifyToken(token);
  if (!result) {
    res.status(400).send('Invalid or expired link. Please request a new one.');
    return;
  }

  const { email, playerId } = result;

  if (playerId) {
    // Link email to account (or login for existing linked account)
    const linkResult = linkEmail(playerId, email);
    if (!linkResult.ok) { res.status(400).send(linkResult.error); return; }

    const player = loginByEmail(playerId);
    if (!player.ok) { res.status(400).send(player.error); return; }

    // Redirect to game with the player's session token in the URL
    res.redirect(`/?email_token=${encodeURIComponent(player.player.token)}`);
  } else {
    // Should not happen — we always set playerId. But handle gracefully.
    res.status(400).send('Invalid link.');
  }
});

// Invite link: auto-create/login account and join game
app.get('/invite', (req, res) => {
  const code = (req.query.code || '').toUpperCase().trim();
  if (!code) { res.status(400).send('Missing game code.'); return; }

  // Try unified lobby first, fall back to legacy async game
  const game = getAsyncGameByCode(code);
  if (!game) {
    // May be a unified lobby — redirect with code for client-side join
    res.redirect(`/#invite=${encodeURIComponent(code)}`);
    return;
  }

  const inviteeEmail = game.invitee_email;

  // If the game has a specific invitee email, auto-create/login that account
  if (inviteeEmail) {
    const authResult = getOrCreateByEmail(inviteeEmail);
    if (!authResult.ok) { res.status(500).send('Failed to create account.'); return; }

    const player = authResult.player;
    const joinResult = joinAsyncGameRoom(player.id, player.username, code);
    if (joinResult.error) {
      // Game may have been joined already — redirect with token so they can see it
      res.redirect(`/?email_token=${encodeURIComponent(player.token)}#game=${game.room_id}`);
      return;
    }

    // Successfully joined — redirect with session token and deep-link to the game
    res.redirect(`/?email_token=${encodeURIComponent(player.token)}#game=${joinResult.roomId}`);
  } else {
    // No invitee email — just redirect to the async join screen with the code pre-filled
    res.redirect(`/#invite=${encodeURIComponent(code)}`);
  }
});

// Join link: redirect to hash-based deep link for client-side lobby join
app.get('/join', (req, res) => {
  const code = (req.query.code || '').trim();
  if (!code) { res.status(400).send('Missing game code.'); return; }
  const slot = req.query.slot;
  let hash = `#join=${encodeURIComponent(code)}`;
  if (slot != null && slot !== '') hash += `&slot=${encodeURIComponent(slot)}`;
  res.redirect(`/${hash}`);
});

// Get linked identities for the authenticated player
app.get('/api/identities', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  res.json(getPlayerIdentities(player.id));
});

// Match Game Center friend IDs to registered Brimstone players
app.post('/api/gc-friends', (req, res) => {
  const token = req.body?.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }

  const { gamePlayerIDs } = req.body || {};
  if (!Array.isArray(gamePlayerIDs)) {
    res.status(400).json({ error: 'gamePlayerIDs array required.' });
    return;
  }
  res.json(getPlayersByGameCenterIds(gamePlayerIDs));
});

// Change username (authenticated player)
app.post('/api/account/username', (req, res) => {
  const token = req.body?.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }

  const result = changeUsername(player.id, req.body?.username);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  res.json({ ok: true, player: { id: result.player.id, username: result.player.username } });
});

// ── Campaign saves (cloud backup for verified users) ──────────────────────────

function _requireAuth(req, res) {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return null; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return null; }
  return player;
}

function _requireVerifiedEmail(player, res) {
  const identities = getPlayerIdentities(player.id);
  if (!identities.some(i => i.provider === 'email')) {
    res.status(403).json({ error: 'Link a verified email to enable cloud saves.' });
    return false;
  }
  return true;
}

function _requireAdmin(req, res) {
  if (ADMIN_OPEN) return { id: 'open', is_admin: 1 };
  const player = _requireAuth(req, res);
  if (!player) return null;
  if (!player.is_admin) {
    res.status(403).json({ error: 'Admin access required.' });
    return null;
  }
  return player;
}

// ── Admin status check (used by client to show/hide admin link) ──────────────

app.get('/api/me/admin', (req, res) => {
  if (ADMIN_OPEN) { res.json({ isAdmin: true }); return; }
  const player = _requireAuth(req, res);
  if (!player) return;
  res.json({ isAdmin: !!player.is_admin });
});

app.get('/api/campaign-saves', (req, res) => {
  const player = _requireAuth(req, res);
  if (!player) return;
  res.json(getCampaignSaves(player.id));
});

app.get('/api/campaign-saves/:slot', (req, res) => {
  const player = _requireAuth(req, res);
  if (!player) return;
  const save = getCampaignSave(player.id, req.params.slot);
  if (!save) { res.status(404).json({ error: 'No campaign save found.' }); return; }
  res.json(save);
});

app.put('/api/campaign-saves/:slot', (req, res) => {
  const player = _requireAuth(req, res);
  if (!player) return;
  if (!_requireVerifiedEmail(player, res)) return;
  const { state } = req.body || {};
  if (!state) { res.status(400).json({ error: 'Missing state.' }); return; }
  upsertCampaignSave(player.id, req.params.slot, JSON.stringify(state), VERSION);
  res.json({ ok: true });
});

app.delete('/api/campaign-saves/:slot', (req, res) => {
  const player = _requireAuth(req, res);
  if (!player) return;
  deleteCampaignSave(player.id, req.params.slot);
  res.json({ ok: true });
});

// ── Device token registration (push notifications) ───────────────────────────

app.put('/api/device-token', (req, res) => {
  const player = _requireAuth(req, res);
  if (!player) return;
  const { deviceToken, platform } = req.body || {};
  if (!deviceToken || typeof deviceToken !== 'string') {
    return res.status(400).json({ error: 'deviceToken required.' });
  }
  console.log(`[Push] PUT device-token player=${player.id} name=${player.username} token=${deviceToken.slice(0, 8)}… platform=${platform || 'ios'}`);
  upsertDeviceToken(player.id, deviceToken, platform || 'ios');
  res.json({ ok: true });
});

app.delete('/api/device-token', (req, res) => {
  const player = _requireAuth(req, res);
  if (!player) return;
  const { deviceToken } = req.body || {};
  if (!deviceToken || typeof deviceToken !== 'string') {
    return res.status(400).json({ error: 'deviceToken required.' });
  }
  deleteDeviceToken(player.id, deviceToken);
  res.json({ ok: true });
});

// ── Admin pages ───────────────────────────────────────────────────────────────
// HTML shells are served freely — each page has a client-side auth gate that
// checks /api/me/admin and redirects non-admins.  The actual security boundary
// is on the /admin/api/* endpoints (all require _requireAdmin).

app.get('/admin',               (_req, res) => res.sendFile(join(__dirname, 'admin.html')));
app.get('/admin/stats',         (_req, res) => res.redirect('/admin'));
app.get('/admin/campaign-stats',(_req, res) => res.redirect('/admin'));
app.get('/admin/lighting',      (_req, res) => res.sendFile(join(__dirname, 'admin-lighting.html')));
app.get('/spectate', (_req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get('/replay',   (_req, res) => res.sendFile(join(__dirname, 'index.html')));

// ── Admin REST API ────────────────────────────────────────────────────────────

app.get('/admin/api/stats', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json({
    version:      BUILD_VERSION,
    uptime:       Math.floor(process.uptime()),
    connections:  clients.size,
    activeRooms:  getRooms().length,
    queueSize:    getQueue().length,
  });
});

app.get('/admin/api/rooms', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getRooms());
});

app.get('/admin/api/rooms/:id', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const room = getRoom(req.params.id);
  if (!room) { res.status(404).json({ error: 'Room not found.' }); return; }
  const summary = getRooms().find(r => r.id === req.params.id);
  res.json({ ...summary, state: serializeState(room.state) });
});

app.get('/admin/api/rooms/:id/chronicle', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const chronicle = getRoomChronicle(req.params.id);
  if (chronicle === null) { res.status(404).json({ error: 'Room not found.' }); return; }
  res.json(chronicle);
});

// Battle admin endpoints
app.get('/admin/api/battle', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const status = getBattleStatus();
  if (!status) { res.json(null); return; }
  // Enrich each battle summary with full player list
  const enriched = status.battles.map(b => {
    const room = getRoom(b.roomId);
    const players = room ? room.players.map(s => ({
      playerId: s.playerId, name: s.name, faction: s.faction, isAI: s.isAI,
      connected: !!(s.ws?.readyState === 1),
      submitted: !!room.state?.playerReady?.get(s.playerId),
    })) : [];
    return { ...b, planningPhase: !!room?.state?.planningPhase, players };
  });
  res.json({ ...status, battles: enriched });
});

app.post('/admin/api/battle/end', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const newRoomId = endBattleEarly();
  res.json({ ended: true, newRoomId });
});

app.post('/admin/api/battle/kick', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const { roomId, playerId } = req.body;
  if (!roomId || !playerId) { res.status(400).json({ error: 'roomId and playerId required.' }); return; }
  const result = adminKickPlayer(roomId, playerId);
  if (!result.ok) { res.status(400).json({ error: result.error }); return; }
  res.json({ ok: true });
});

app.get('/admin/api/queue', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getQueue());
});

app.get('/admin/api/players', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getAllPlayers());
});

app.get('/admin/api/saves', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getAllSaves());
});

app.get('/admin/api/saves/:roomId', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const save = getSaveWithState(req.params.roomId);
  if (!save) { res.status(404).json({ error: 'Save not found.' }); return; }
  res.json(save);
});

app.get('/admin/api/game-stats', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getGameStats({
    mode:         req.query.mode         || undefined,
    map_size:     req.query.map_size     || undefined,
    winner:       req.query.winner       || undefined,
    game_version: req.query.game_version || undefined,
    limit:        req.query.limit ? parseInt(req.query.limit, 10) : 100,
  }));
});

app.get('/admin/api/game-stats/summary', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getAggregateStats());
});

app.get('/admin/api/campaign-game-stats', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getCampaignGameStats({
    campaign_id: req.query.campaign_id || undefined,
    mission_id:  req.query.mission_id  || undefined,
    winner:      req.query.winner      || undefined,
    limit:       req.query.limit ? parseInt(req.query.limit, 10) : 100,
  }));
});

app.get('/admin/api/campaign-game-stats/summary', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getCampaignAggregateStats());
});

app.post('/admin/api/saves/:roomId/activate', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const roomId = req.params.roomId;
  const result = adminResumeGame(roomId);
  if (!result.ok) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, roomId: result.roomId });
});

app.post('/admin/api/games/:id/force-end', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const id     = req.params.id;
  const source = req.query.source ?? 'active';
  const winner = req.query.winner ?? 'draw';
  const result = forceEndGame(id, source, winner);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

app.delete('/admin/api/games/:id/nuke', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const result = nukeGame(req.params.id);
  if (!result.ok) {
    res.status(400).json({ error: result.error });
    return;
  }
  res.json({ ok: true });
});

app.get('/admin/api/completed-games', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getAllCompletedGames());
});

app.get('/admin/api/completed-games/:gameId', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const game = getCompletedGame(req.params.gameId);
  if (!game) { res.status(404).json({ error: 'Not found.' }); return; }
  res.json(game);
});

app.get('/admin/api/completed-games/:gameId/rounds', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getCompletedGameRounds(req.params.gameId));
});

// ── Admin: paginated all-games, game detail, player detail, admin toggle ─────

app.get('/admin/api/all-games', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const page   = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit  = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
  const source = req.query.source || 'all';
  res.json(getAllGamesPaginated({ page, limit, source }));
});

app.get('/admin/api/game-detail/:id', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const source = req.query.source;
  if (!source) { res.status(400).json({ error: 'source query parameter required.' }); return; }
  const detail = getGameDetail(req.params.id, source);
  if (!detail) { res.status(404).json({ error: 'Game not found.' }); return; }
  res.json(detail);
});

app.get('/admin/api/players/detail', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getAllPlayersDetailed());
});

app.post('/admin/api/players/:playerId/admin', express.json(), (req, res) => {
  const admin = _requireAdmin(req, res);
  if (!admin) return;
  const { playerId } = req.params;
  const { isAdmin } = req.body ?? {};
  if (typeof isAdmin !== 'boolean') {
    res.status(400).json({ error: 'isAdmin (boolean) required.' });
    return;
  }
  if (!isAdmin && playerId === admin.id) {
    res.status(400).json({ error: 'Cannot remove your own admin status.' });
    return;
  }
  setAdmin(playerId, isAdmin);
  res.json({ ok: true });
});

app.post('/admin/api/reset-stats', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const result = resetStats(VERSION);
  res.json(result);
});

// Map preview — generates a map and returns a PNG render.
// Used by the admin "Map Test" tab for visual spot-checking of map generation.
app.get('/admin/api/map-render', async (req, res) => {
  if (!_requireAdmin(req, res)) return;
  try {
    const { renderMapToBuffer } = await import('./scripts/map-render.js');
    const seed = parseInt(req.query.seed, 10) || Date.now();
    const size = (req.query.size && typeof req.query.size === 'string') ? req.query.size : 'standard';
    const buf = renderMapToBuffer(seed, size);
    res.set('Content-Type', 'image/png');
    res.set('Cache-Control', 'no-store');
    res.send(buf);
  } catch (e) {
    console.error('map-render error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── Remote AI Battle admin endpoints ─────────────────────────────────────────
// Add admin-controlled AI players to existing battle rooms.

app.get('/admin/api/remote-battle/personalities', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json({
    hero:  getRemoteBattlePersonalities('hero'),
    witch: getRemoteBattlePersonalities('witch'),
  });
});

app.get('/admin/api/remote-battle/rooms', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(listRemoteBattleRooms());
});

app.get('/admin/api/remote-battle/status', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getRemoteAIStatus());
});

app.get('/admin/api/remote-battle/:roomId', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const status = getRoomRemoteStatus(req.params.roomId);
  if (!status) { res.status(404).json({ error: 'Battle room not found.' }); return; }
  res.json(status);
});

app.post('/admin/api/remote-battle/:roomId/add-player', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const { faction, type, personality, name, llmEndpoint, llmPrompt } = req.body;
  const result = addRemoteBattlePlayer(req.params.roomId, {
    faction, type, personality, name, llmEndpoint, llmPrompt,
  });
  res.json(result);
});

app.post('/admin/api/remote-battle/:roomId/take-turn/:playerId', async (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const result = await takeRemoteBattleTurn(req.params.roomId, req.params.playerId);
  res.json(result);
});

app.post('/admin/api/remote-battle/:roomId/take-all-turns', async (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const result = await takeAllRemoteBattleTurns(req.params.roomId);
  res.json(result);
});

app.post('/admin/api/remote-battle/:roomId/submit-plan/:playerId', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const { plan } = req.body;
  if (!Array.isArray(plan)) { res.status(400).json({ ok: false, error: 'plan must be an array.' }); return; }
  const result = submitRemoteBattlePlan(req.params.roomId, req.params.playerId, plan);
  res.json(result);
});

app.post('/admin/api/remote-battle/:roomId/resign/:playerId', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const result = resignRemoteBattlePlayer(req.params.roomId, req.params.playerId);
  res.json(result);
});

// ── HTTP + WS server ─────────────────────────────────────────────────────────

const server = createServer(app);
const wss    = new WebSocketServer({ server });

// Per-connection state
const clients = new Map(); // ws → { player, roomId, spectatingRooms }

// Player → WebSocket(s) lookup (a player may have multiple tabs open)
const playerWsMap = new Map(); // playerId → Set<ws>

function _registerPlayerWs(playerId, ws) {
  let sockets = playerWsMap.get(playerId);
  if (!sockets) { sockets = new Set(); playerWsMap.set(playerId, sockets); }
  sockets.add(ws);
}

function _unregisterPlayerWs(playerId, ws) {
  const sockets = playerWsMap.get(playerId);
  if (!sockets) return;
  sockets.delete(ws);
  if (sockets.size === 0) playerWsMap.delete(playerId);
}

function sendToPlayer(playerId, msg) {
  const sockets = playerWsMap.get(playerId);
  if (!sockets) return;
  const json = JSON.stringify(msg);
  for (const ws of sockets) {
    if (ws.readyState === 1) ws.send(json);
  }
}

// Inject into lobby.js so it can notify players without a circular import
setSendToPlayer(sendToPlayer);

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function clientState(ws) {
  if (!clients.has(ws)) clients.set(ws, {
    player: null, roomId: null, asyncRoomId: null,
    spectatingRooms: new Set(),
    inactive: false,
  });
  return clients.get(ws);
}

// ── WebSocket message router ──────────────────────────────────────────────────

wss.on('connection', ws => {
  if (!_serverReady) {
    ws.send(JSON.stringify({ type: 'error', message: 'Server is starting up.' }));
    ws.close(1013, 'Server starting');
    return;
  }
  const cs = clientState(ws);
  ws._isAlive = true;
  ws.on('pong', () => { ws._isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    route(ws, cs, msg);
  });

  ws.on('close', () => {
    if (cs.player) _unregisterPlayerWs(cs.player.id, ws);
    if (cs.player && cs.roomId) {
      handleDisconnect(cs.player.id, cs.roomId);
    }
    // Clean up async session if present
    if (cs.player && cs.asyncRoomId) {
      handleAsyncDisconnect(cs.player.id, cs.asyncRoomId);
    }
    // Clean up any spectator subscriptions
    if (cs.spectatingRooms.size > 0) {
      unsubscribeSpectator(ws);
    }
    clients.delete(ws);
  });

  ws.on('error', () => ws.terminate());
});

// ── Heartbeat — detect zombie connections within ~30s ────────────────────────

const HEARTBEAT_INTERVAL_MS = 15_000;

const _heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws._isAlive) { ws.terminate(); continue; }
    ws._isAlive = false;
    ws.ping();

    // Send state-sync heartbeat to clients in active games
    const cs = clients.get(ws);
    if (cs?.roomId) {
      const room = getRoom(cs.roomId);
      if (room?.state) {
        const ready = [];
        for (const [pid, r] of room.state.playerReady ?? []) { if (r) ready.push(pid); }
        send(ws, {
          type: 'heartbeat',
          roomId: cs.roomId,
          round: room.state.round,
          planningPhase: !!room.state.planningPhase,
          gameOver: !!room.state.gameOver,
          playersReady: ready,
        });
      }
    }
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(_heartbeat));

function route(ws, cs, msg) {
  switch (msg.type) {

    // ── Auth ──────────────────────────────────────────────────────────────
    case 'auth': {
      const result = registerOrLogin({ username: msg.username, token: msg.token });
      if (!result.ok) {
        send(ws, { type: 'authError', message: result.error, err_code: result.err_code });
        return;
      }
      cs.player = result.player;
      _registerPlayerWs(result.player.id, ws);

      // Check if the player is reconnecting to a room
      if (msg.roomId) {
        const rejoined = handleReconnect(result.player.id, msg.roomId, ws);
        if (rejoined) {
          cs.roomId = msg.roomId;
          send(ws, { type: 'authOk', player: _publicPlayer(result.player) });
          return;
        }
      }

      send(ws, { type: 'authOk', player: _publicPlayer(result.player) });
      break;
    }

    // ── Game Center Auth ─────────────────────────────────────────────────
    case 'authGameCenter': {
      const result = getOrCreateByGameCenter(msg.gameCenterId, msg.displayName);
      if (!result.ok) {
        send(ws, { type: 'authError', message: result.error });
        return;
      }
      cs.player = result.player;
      _registerPlayerWs(result.player.id, ws);

      if (msg.roomId) {
        const rejoined = handleReconnect(result.player.id, msg.roomId, ws);
        if (rejoined) {
          cs.roomId = msg.roomId;
          send(ws, { type: 'authOk', player: _publicPlayer(result.player) });
          return;
        }
      }

      send(ws, { type: 'authOk', player: _publicPlayer(result.player) });
      break;
    }

    case 'linkGameCenter': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      const result = linkGameCenter(cs.player.id, msg.gameCenterId);
      send(ws, { type: 'linkGameCenterResult', ok: result.ok, error: result.error });
      break;
    }

    // ── Leaderboard ───────────────────────────────────────────────────────
    case 'requestLeaderboard': {
      send(ws, { type: 'leaderboard', entries: getLeaderboard(20) });
      break;
    }

    // ── Lobby ─────────────────────────────────────────────────────────────
    case 'createLobby': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      const createdRoomId = createLobby(cs.player.id, cs.player.username, ws, msg);
      if (createdRoomId) { cs.roomId = createdRoomId; ws._roomId = createdRoomId; }
      break;
    }

    case 'joinLobby': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      const joinedRoomId = joinLobby(cs.player.id, cs.player.username, ws, msg.codeOrId, msg.slotIndex);
      if (joinedRoomId) { cs.roomId = joinedRoomId; ws._roomId = joinedRoomId; }
      break;
    }

    case 'claimSlot': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      claimSlot(cs.player.id, msg.roomId, msg.slotIndex, msg.factionId ?? null);
      break;
    }

    case 'setFaction': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      setFaction(cs.player.id, msg.roomId, msg.factionId);
      break;
    }

    case 'joinGame': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      joinGame(cs.player.id, cs.player.username, ws, msg.codeOrId);
      break;
    }

    case 'joinBattle': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      const battleResult = joinBattle(cs.player.id, cs.player.username, ws, msg.roomId);
      if (battleResult) { cs.roomId = battleResult.roomId; ws._roomId = battleResult.roomId; }
      break;
    }

    case 'getBattleStatus': {
      send(ws, { type: 'battleStatus', status: getBattleStatus(cs.player?.id) });
      break;
    }

    case 'browseLobby': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      send(ws, { type: 'lobbyList', rooms: browseLobby() });
      break;
    }

    case 'setSlotAI': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      setSlotAI(cs.player.id, msg.roomId, msg.slotIndex, msg.personality);
      break;
    }

    case 'removeSlotAI': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      removeSlotAI(cs.player.id, msg.roomId, msg.slotIndex);
      break;
    }

    case 'fillAllWithAI': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      fillAllWithAI(cs.player.id, msg.roomId, msg.personality);
      break;
    }

    case 'startGame': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      startGame(cs.player.id, msg.roomId);
      break;
    }

    case 'leaveLobby': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      leaveLobby(cs.player.id, msg.roomId);
      break;
    }

    case 'resignGame': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      resignGame(cs.player.id, msg.roomId, ws);
      break;
    }

    case 'setInactive': {
      cs.inactive = !!msg.inactive;
      ws._inactive = cs.inactive; // also on ws so lobby.js can read it
      if (cs.player) broadcastPresenceForPlayer(cs.player.id);
      break;
    }

    case 'sendSlotInvite': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      sendSlotInviteHandler(cs.player, msg.roomId, msg.slotIndex, msg.email);
      break;
    }

    case 'sendFriendInvite': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      sendFriendInviteHandler(cs.player, msg.roomId, msg.targetPlayerId);
      break;
    }

    // ── State resync (client detected heartbeat mismatch) ─────────────────
    case 'requestState': {
      if (!cs.player || !cs.roomId) return;
      resumeGame(cs.player.id, ws, cs.roomId);
      break;
    }

    // ── Fetch a specific round's replay (for "Replay last turn" cache miss)
    case 'requestReplay': {
      const reqRoundNum = Number(msg.roundNum);
      if (!cs.player || !cs.roomId || cs.roomId !== msg.roomId) {
        send(ws, { type: 'replayError', roomId: msg.roomId, roundNum: reqRoundNum,
                   reason: 'notAuthorized' });
        return;
      }
      const room = getRoom(cs.roomId);
      if (!room) {
        send(ws, { type: 'replayError', roomId: msg.roomId, roundNum: reqRoundNum,
                   reason: 'notFound' });
        return;
      }
      const seat = room.players.find(s => s.playerId === cs.player.id);
      if (!seat) {
        send(ws, { type: 'replayError', roomId: msg.roomId, roundNum: reqRoundNum,
                   reason: 'notAuthorized' });
        return;
      }
      if (!Number.isInteger(reqRoundNum) || reqRoundNum < 1 || reqRoundNum >= (room.state?.round ?? 1)) {
        send(ws, { type: 'replayError', roomId: msg.roomId, roundNum: reqRoundNum,
                   reason: 'invalidRound' });
        return;
      }
      // Battle mode: late-joiners can't fetch rounds from before they joined
      if ((seat.joinedAtRound ?? 0) > reqRoundNum) {
        send(ws, { type: 'replayError', roomId: msg.roomId, roundNum: reqRoundNum,
                   reason: 'notAuthorized' });
        return;
      }
      const entry = getReplayForRound(room, reqRoundNum);
      if (!entry) {
        send(ws, { type: 'replayError', roomId: msg.roomId, roundNum: reqRoundNum,
                   reason: 'notFound' });
        return;
      }
      send(ws, {
        type:         'replayData',
        roomId:       msg.roomId,
        roundNum:     entry.roundNum,
        preStateJson: entry.preStateJson,
        stepsJson:    entry.stepsJson,
      });
      break;
    }

    // ── Room ID registration (sent by client after matchFound) ────────────
    case 'setRoom': {
      if (!cs.player) return;
      const oldRoomId = cs.roomId;
      if (!msg.roomId) {
        // Clearing room (returned to menus)
        cs.roomId = null;
        ws._roomId = null;
        if (oldRoomId) broadcastPresenceForPlayer(cs.player.id);
        break;
      }
      const room = getRoom(msg.roomId);
      if (room && (
        room.players.some(s => s.playerId === cs.player.id) ||
        (room.status === 'lobby' && room.slots.some(s => s.playerId === cs.player.id))
      )) {
        cs.roomId = msg.roomId;
        ws._roomId = msg.roomId;
      }
      // Broadcast presence to both old and new rooms
      if (oldRoomId && oldRoomId !== msg.roomId) broadcastPresenceForPlayer(cs.player.id);
      if (cs.roomId) broadcastPresenceForPlayer(cs.player.id);
      break;
    }

    // ── Game actions ──────────────────────────────────────────────────────
    case 'action': {
      if (!cs.player || !cs.roomId) return;
      handleAction(cs.player.id, cs.roomId, msg.actionType, msg);
      break;
    }

    case 'endTurn': {
      if (!cs.player || !cs.roomId) return;
      handleEndTurn(cs.player.id, cs.roomId);
      break;
    }

    case 'submitPlan': {
      if (!cs.player || !cs.roomId) return;
      handlePlanSubmit(cs.player.id, cs.roomId, msg.plan ?? [], msg.round);
      break;
    }

    case 'nudge': {
      if (!cs.player || !cs.roomId) return;
      if (!msg.targetPlayerId) return;
      handleNudge(cs.player.id, cs.roomId, msg.targetPlayerId);
      break;
    }

    case 'resumeSave': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      if (!msg.roomId) { send(ws, { type: 'error', message: 'roomId required.' }); return; }
      resumeGame(cs.player.id, ws, msg.roomId);
      break;
    }

    // ── Async games ──────────────────────────────────────────────────────
    case 'connectAsync': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      if (!msg.roomId) { send(ws, { type: 'error', message: 'roomId required.' }); return; }
      cs.asyncRoomId = msg.roomId;
      connectToAsyncGame(cs.player.id, ws, msg.roomId);
      break;
    }

    case 'submitAsyncPlan': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      if (!msg.roomId) { send(ws, { type: 'error', message: 'roomId required.' }); return; }
      handleAsyncPlanSubmit(cs.player.id, msg.roomId, msg.plan ?? []);
      break;
    }

    case 'disconnectAsync': {
      if (!cs.player || !cs.asyncRoomId) break;
      handleAsyncDisconnect(cs.player.id, cs.asyncRoomId);
      cs.asyncRoomId = null;
      break;
    }

    // ── Admin / spectator ─────────────────────────────────────────────────
    case 'adminSpectateRoom': {
      if (!ADMIN_OPEN && !cs.player?.is_admin) { send(ws, { type: 'error', message: 'Admin access required.' }); return; }
      if (!msg.roomId) { send(ws, { type: 'error', message: 'roomId required.' }); return; }
      const joined = subscribeSpectator(msg.roomId, ws);
      if (!joined) {
        send(ws, { type: 'error', message: 'Room not found.' });
      } else {
        cs.spectatingRooms.add(msg.roomId);
      }
      break;
    }

    case 'adminUnspectateRoom': {
      if (!ADMIN_OPEN && !cs.player?.is_admin) { send(ws, { type: 'error', message: 'Admin access required.' }); return; }
      const rid = msg.roomId;
      if (rid) {
        unsubscribeSpectator(ws, rid);
        cs.spectatingRooms.delete(rid);
      }
      break;
    }

    default:
      break;
  }
}

// Strip sensitive fields before sending player to client
function _publicPlayer(p) {
  return {
    id:       p.id,
    username: p.username,
    token:    p.token,   // token is returned so client can persist it
    wins:     p.wins,
    losses:   p.losses,
    draws:    p.draws,
    is_admin: !!p.is_admin,
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Caleb's Hollow v${BUILD_VERSION} listening on port ${PORT}`);

  // Phase 1: Prune stale data
  const pruned = pruneStaleAndIncompatibleSaves(VERSION, SAVE_VERSION);
  if (pruned > 0) console.log(`Pruned ${pruned} stale/incompatible save(s).`);
  const prunedCompleted = pruneExpiredCompletedGames();
  if (prunedCompleted > 0) console.log(`Pruned ${prunedCompleted} expired completed game(s).`);

  // Phase 2: Load all saved games into memory
  const loadedCount = loadAllRooms();
  console.log(`Loaded ${loadedCount} game(s) from DB into memory.`);

  // Phase 3: Mark server as ready — clients can now connect
  _serverReady = true;
  console.log('Server ready — accepting connections.');

  // Phase 4: Start periodic maintenance
  // Async game maintenance (legacy — will be fully removed in future)
  pruneAsyncGames();
  checkAsyncDeadlines(); // catch any deadlines that expired while server was down
  setInterval(checkAsyncDeadlines, 60_000); // check every minute

  // Prune stale device tokens once on startup, then daily
  pruneStaleTokens(90);
  setInterval(() => pruneStaleTokens(90), 86_400_000);

  // Unified system: migrate existing async games and start deadline checker
  try { migrateAsyncGames(); } catch (err) { console.error('[migration]', err); }
  checkDeadlines(); // catch any unified deadlines that expired while server was down
  setInterval(checkDeadlines, 30_000); // check every 30 seconds
  setInterval(checkApproachingDeadlines, 60_000); // check approaching deadlines every minute
  setInterval(pruneOrphanedRooms, 30_000); // clean up orphaned rooms every 30 seconds

  // Battle for Caleb's Hollow: ensure a battle exists and check lifecycle
  try { ensureBattleExists(); } catch (err) { console.error('[battle-scheduler]', err); }
  setInterval(checkBattleLifecycle, 30_000);
});
