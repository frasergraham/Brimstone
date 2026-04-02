// Brimstone multiplayer server — Express (static files) + WebSocket (game protocol)
import express    from 'express';
import { WebSocketServer } from 'ws';
import { createServer }    from 'http';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

import { VERSION, BUILD_VERSION } from './src/version.js';
import {
  registerOrLogin, getPlayerByToken, getPlayerByEmail,
  linkEmail, loginByEmail, getPlayerIdentities, changeUsername,
  getOrCreateByEmail,
} from './server/auth.js';
import { generateToken, verifyToken, sendMagicLinkEmail } from './server/magic-link.js';
import { getLeaderboard }                    from './server/leaderboard.js';
import { recordGameStats, getGameStats, getAggregateStats } from './server/game-stats.js';
import { recordCampaignGameStats, getCampaignGameStats, getCampaignAggregateStats } from './server/campaign-game-stats.js';
import { upsertCampaignSave, getCampaignSave, getCampaignSaves, deleteCampaignSave } from './server/campaign-saves.js';
import { pruneStaleAndIncompatibleSaves,
         getCompletedGames, getCompletedGame, getCompletedGameRounds,
         pinCompletedGame, deleteCompletedGame,
         pruneExpiredCompletedGames, getAllCompletedGames,
         createSpCompletedGame, getAllSpCompletedGames,
         getSpCompletedGame, getSpCompletedGameRounds,
         getSaveRounds }                                   from './server/saves.js';
import {
  createLobby, joinLobby, browseLobby,
  setSlotAI, removeSlotAI, fillAllWithAI, startGame, leaveLobby,
  handleAction, handleEndTurn, handlePlanSubmit,
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
  checkDeadlines, migrateAsyncGames,
} from './server/lobby.js';
import {
  getAllPlayers, getAllSaves, getSaveWithState,
} from './server/admin.js';
import { deleteAsyncGame as _deleteAsyncGame,
         getAsyncGame as _getAsyncGame,
         getAsyncGameByCode }                  from './server/async-game.js';
import { serializeState } from './server/state-sync.js';
import { getGameModeConfig } from './server/game-mode-config.js';
import { upsertDeviceToken, deleteDeviceToken, pruneStaleTokens } from './server/push.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3000;

// ── Express ──────────────────────────────────────────────────────────────────

const app = express();

// CORS — allow Capacitor native shells (capacitor://localhost, http://localhost)
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && (
    origin.startsWith('capacitor://') ||
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

// Block direct static access to admin HTML files — they're served via auth-gated routes
app.use((req, res, next) => {
  if (/^\/admin.*\.html$/i.test(req.path)) {
    res.status(403).send('Forbidden');
    return;
  }
  next();
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
  res.json({ modes: getGameModeConfig() });
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
  if (game.hero_player_id !== player.id && game.witch_player_id !== player.id) {
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

// Get linked identities for the authenticated player
app.get('/api/identities', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  res.json(getPlayerIdentities(player.id));
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
app.get('/admin/stats',         (_req, res) => res.sendFile(join(__dirname, 'admin-stats.html')));
app.get('/admin/campaign-stats',(_req, res) => res.sendFile(join(__dirname, 'admin-campaign-stats.html')));
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

// ── SP game uploads ───────────────────────────────────────────────────────────

app.post('/api/sp/completed-games', express.json({ limit: '10mb' }), (req, res) => {
  const { gameId, heroName, witchName, winner, winReason, totalRounds,
          gameVersion, mode, rounds } = req.body ?? {};
  if (!gameId || !winner || !Array.isArray(rounds)) {
    res.status(400).json({ error: 'gameId, winner, and rounds are required.' });
    return;
  }
  try {
    createSpCompletedGame(gameId, { heroName, witchName, winner, winReason,
      totalRounds, gameVersion, mode }, rounds);
    res.json({ ok: true });
  } catch (e) {
    console.error('SP upload error:', e);
    res.status(500).json({ error: 'Failed to store game.' });
  }
});

app.get('/admin/api/sp/completed-games', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getAllSpCompletedGames());
});

app.get('/admin/api/sp/completed-games/:gameId', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  const game = getSpCompletedGame(req.params.gameId);
  if (!game) { res.status(404).json({ error: 'Not found.' }); return; }
  res.json(game);
});

app.get('/admin/api/sp/completed-games/:gameId/rounds', (req, res) => {
  if (!_requireAdmin(req, res)) return;
  res.json(getSpCompletedGameRounds(req.params.gameId));
});

// ── HTTP + WS server ─────────────────────────────────────────────────────────

const server = createServer(app);
const wss    = new WebSocketServer({ server });

// Per-connection state
const clients = new Map(); // ws → { player, roomId, spectatingRooms }

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function clientState(ws) {
  if (!clients.has(ws)) clients.set(ws, {
    player: null, roomId: null, asyncRoomId: null,
    spectatingRooms: new Set(),
  });
  return clients.get(ws);
}

// ── WebSocket message router ──────────────────────────────────────────────────

wss.on('connection', ws => {
  const cs = clientState(ws);
  ws._isAlive = true;
  ws.on('pong', () => { ws._isAlive = true; });

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    route(ws, cs, msg);
  });

  ws.on('close', () => {
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
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on('close', () => clearInterval(_heartbeat));

function route(ws, cs, msg) {
  switch (msg.type) {

    // ── Auth ──────────────────────────────────────────────────────────────
    case 'auth': {
      const result = registerOrLogin({ username: msg.username, token: msg.token });
      if (!result.ok) {
        send(ws, { type: 'authError', message: result.error });
        return;
      }
      cs.player = result.player;

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

    // ── Leaderboard ───────────────────────────────────────────────────────
    case 'requestLeaderboard': {
      send(ws, { type: 'leaderboard', entries: getLeaderboard(20) });
      break;
    }

    // ── Lobby ─────────────────────────────────────────────────────────────
    case 'createLobby': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      createLobby(cs.player.id, cs.player.username, ws, msg);
      break;
    }

    case 'joinLobby': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      joinLobby(cs.player.id, cs.player.username, ws, msg.codeOrId);
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

    // ── Room ID registration (sent by client after matchFound) ────────────
    case 'setRoom': {
      if (!cs.player) return;
      const room = getRoom(msg.roomId);
      if (room && (
        room.players.some(s => s.playerId === cs.player.id) ||
        (room.status === 'lobby' && room.slots.some(s => s.playerId === cs.player.id))
      )) {
        cs.roomId = msg.roomId;
      }
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
      handlePlanSubmit(cs.player.id, cs.roomId, msg.plan ?? []);
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
      if (!cs.player?.is_admin) { send(ws, { type: 'error', message: 'Admin access required.' }); return; }
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
      if (!cs.player?.is_admin) { send(ws, { type: 'error', message: 'Admin access required.' }); return; }
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
  const pruned = pruneStaleAndIncompatibleSaves(VERSION);
  if (pruned > 0) console.log(`Pruned ${pruned} stale/incompatible save(s).`);
  const prunedCompleted = pruneExpiredCompletedGames();
  if (prunedCompleted > 0) console.log(`Pruned ${prunedCompleted} expired completed game(s).`);

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
});
