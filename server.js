// Brimstone multiplayer server — Express (static files) + WebSocket (game protocol)
import express    from 'express';
import { WebSocketServer } from 'ws';
import { createServer }    from 'http';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

import { VERSION } from './src/version.js';
import { registerOrLogin, getPlayerByToken } from './server/auth.js';
import { getLeaderboard }                    from './server/leaderboard.js';
import { recordGameStats, getGameStats, getAggregateStats } from './server/game-stats.js';
import { getActiveSaves, pruneStaleAndIncompatibleSaves,
         getCompletedGames, getCompletedGame, getCompletedGameRounds,
         pinCompletedGame, deleteCompletedGame,
         pruneExpiredCompletedGames, getAllCompletedGames,
         createSpCompletedGame, getAllSpCompletedGames,
         getSpCompletedGame, getSpCompletedGameRounds }    from './server/saves.js';
import {
  createLobby, joinLobby, browseLobby,
  setSlotAI, removeSlotAI, fillAllWithAI, startGame, leaveLobby,
  handleAction, handleEndTurn, handlePlanSubmit,
  handleDisconnect, handleReconnect,
  resumeGame, adminResumeGame,
  getRoom,
  getRooms, getQueue,
  subscribeSpectator, unsubscribeSpectator, getRoomChronicle,
} from './server/lobby.js';
import {
  getAllPlayers, getAllSaves, getSaveWithState,
} from './server/admin.js';
import { serializeState } from './server/state-sync.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT      = process.env.PORT || 3000;

// ── Express ──────────────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(join(__dirname)));   // serve game files from repo root

// Health check — Railway pings this to confirm the service is up
app.get('/health', (_req, res) => {
  res.json({
    status:      'ok',
    version:     VERSION,
    uptime:      Math.floor(process.uptime()),
    connections: clients.size,
  });
});

// REST: leaderboard (also exposed over WS, but handy for embedding)
app.get('/api/leaderboard', (_req, res) => {
  res.json(getLeaderboard(20));
});

// REST: saved games for a player (token passed as query param or header)
app.get('/api/saves', (req, res) => {
  const token = req.query.token || req.headers['x-token'];
  if (!token) { res.status(401).json({ error: 'Token required.' }); return; }
  const player = getPlayerByToken(token);
  if (!player) { res.status(401).json({ error: 'Invalid token.' }); return; }
  res.json(getActiveSaves(player.id));
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

// ── Admin pages ───────────────────────────────────────────────────────────────

app.get('/admin',       (_req, res) => res.sendFile(join(__dirname, 'admin.html')));
app.get('/admin/stats', (_req, res) => res.sendFile(join(__dirname, 'admin-stats.html')));
app.get('/spectate', (_req, res) => res.sendFile(join(__dirname, 'index.html')));
app.get('/replay',   (_req, res) => res.sendFile(join(__dirname, 'index.html')));

// ── Admin REST API ────────────────────────────────────────────────────────────

app.get('/admin/api/stats', (_req, res) => {
  res.json({
    version:      VERSION,
    uptime:       Math.floor(process.uptime()),
    connections:  clients.size,
    activeRooms:  getRooms().length,
    queueSize:    getQueue().length,
  });
});

app.get('/admin/api/rooms', (_req, res) => {
  res.json(getRooms());
});

app.get('/admin/api/rooms/:id', (req, res) => {
  const room = getRoom(req.params.id);
  if (!room) { res.status(404).json({ error: 'Room not found.' }); return; }
  const summary = getRooms().find(r => r.id === req.params.id);
  res.json({ ...summary, state: serializeState(room.state) });
});

app.get('/admin/api/rooms/:id/chronicle', (req, res) => {
  const chronicle = getRoomChronicle(req.params.id);
  if (chronicle === null) { res.status(404).json({ error: 'Room not found.' }); return; }
  res.json(chronicle);
});

app.get('/admin/api/queue', (_req, res) => {
  res.json(getQueue());
});

app.get('/admin/api/players', (_req, res) => {
  res.json(getAllPlayers());
});

app.get('/admin/api/saves', (_req, res) => {
  res.json(getAllSaves());
});

app.get('/admin/api/saves/:roomId', (req, res) => {
  const save = getSaveWithState(req.params.roomId);
  if (!save) { res.status(404).json({ error: 'Save not found.' }); return; }
  res.json(save);
});

app.get('/admin/api/game-stats', (req, res) => {
  res.json(getGameStats({
    mode:         req.query.mode         || undefined,
    map_size:     req.query.map_size     || undefined,
    winner:       req.query.winner       || undefined,
    game_version: req.query.game_version || undefined,
    limit:        req.query.limit ? parseInt(req.query.limit, 10) : 100,
  }));
});

app.get('/admin/api/game-stats/summary', (_req, res) => {
  res.json(getAggregateStats());
});

app.post('/admin/api/saves/:roomId/activate', (req, res) => {
  const roomId = req.params.roomId;
  const result = adminResumeGame(roomId);
  if (!result.ok) {
    res.status(result.status ?? 400).json({ error: result.error });
    return;
  }
  res.json({ ok: true, roomId: result.roomId });
});

app.get('/admin/api/completed-games', (_req, res) => {
  res.json(getAllCompletedGames());
});

app.get('/admin/api/completed-games/:gameId', (req, res) => {
  const game = getCompletedGame(req.params.gameId);
  if (!game) { res.status(404).json({ error: 'Not found.' }); return; }
  res.json(game);
});

app.get('/admin/api/completed-games/:gameId/rounds', (req, res) => {
  res.json(getCompletedGameRounds(req.params.gameId));
});

// ── SP game uploads ───────────────────────────────────────────────────────────

app.post('/api/sp/completed-games', (req, res) => {
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

app.get('/admin/api/sp/completed-games', (_req, res) => {
  res.json(getAllSpCompletedGames());
});

app.get('/admin/api/sp/completed-games/:gameId', (req, res) => {
  const game = getSpCompletedGame(req.params.gameId);
  if (!game) { res.status(404).json({ error: 'Not found.' }); return; }
  res.json(game);
});

app.get('/admin/api/sp/completed-games/:gameId/rounds', (req, res) => {
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
    player: null, roomId: null,
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

    // ── Admin / spectator ─────────────────────────────────────────────────
    case 'adminSpectateRoom': {
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
  };
}

// ── Start ─────────────────────────────────────────────────────────────────────

server.listen(PORT, () => {
  console.log(`Brimstone v${VERSION} listening on port ${PORT}`);
  const pruned = pruneStaleAndIncompatibleSaves(VERSION);
  if (pruned > 0) console.log(`Pruned ${pruned} stale/incompatible save(s).`);
  const prunedCompleted = pruneExpiredCompletedGames();
  if (prunedCompleted > 0) console.log(`Pruned ${prunedCompleted} expired completed game(s).`);
});
