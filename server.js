// Brimstone multiplayer server — Express (static files) + WebSocket (game protocol)
import express    from 'express';
import { WebSocketServer } from 'ws';
import { createServer }    from 'http';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

import { VERSION } from './src/version.js';
import { registerOrLogin, getPlayerByToken } from './server/auth.js';
import { getLeaderboard }                    from './server/leaderboard.js';
import { getActiveSaves, pruneStaleAndIncompatibleSaves } from './server/saves.js';
import {
  joinQueue, leaveQueue,
  createPrivateRoom, joinPrivateRoom,
  joinAIGame,
  handleAction, handleEndTurn, handlePlanSubmit,
  handleDisconnect, handleReconnect,
  resumeGame,
  getRoom,
  getRooms, getQueue,
  subscribeSpectator, unsubscribeSpectator, getRoomChronicle,
} from './server/lobby.js';
import {
  requireAdmin, isValidAdminKey,
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

// ── Admin REST API ────────────────────────────────────────────────────────────
// All endpoints require ADMIN_KEY (via ?key= query param or X-Admin-Key header).

app.get('/admin/api/stats', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    version:      VERSION,
    uptime:       Math.floor(process.uptime()),
    connections:  clients.size,
    activeRooms:  getRooms().length,
    queueSize:    getQueue().length,
  });
});

app.get('/admin/api/rooms', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(getRooms());
});

app.get('/admin/api/rooms/:id', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const room = getRoom(req.params.id);
  if (!room) { res.status(404).json({ error: 'Room not found.' }); return; }
  const summary = getRooms().find(r => r.id === req.params.id);
  res.json({ ...summary, state: serializeState(room.state) });
});

app.get('/admin/api/rooms/:id/chronicle', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const chronicle = getRoomChronicle(req.params.id);
  if (chronicle === null) { res.status(404).json({ error: 'Room not found.' }); return; }
  res.json(chronicle);
});

app.get('/admin/api/queue', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(getQueue());
});

app.get('/admin/api/players', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(getAllPlayers());
});

app.get('/admin/api/saves', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json(getAllSaves());
});

app.get('/admin/api/saves/:roomId', (req, res) => {
  if (!requireAdmin(req, res)) return;
  const save = getSaveWithState(req.params.roomId);
  if (!save) { res.status(404).json({ error: 'Save not found.' }); return; }
  res.json(save);
});

// ── HTTP + WS server ─────────────────────────────────────────────────────────

const server = createServer(app);
const wss    = new WebSocketServer({ server });

// Per-connection state
const clients = new Map(); // ws → { player, roomId, cancelQueue?, isAdmin, spectatingRooms }

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function clientState(ws) {
  if (!clients.has(ws)) clients.set(ws, {
    player: null, roomId: null, cancelQueue: null,
    isAdmin: false, spectatingRooms: new Set(),
  });
  return clients.get(ws);
}

// ── WebSocket message router ──────────────────────────────────────────────────

wss.on('connection', ws => {
  const cs = clientState(ws);

  ws.on('message', raw => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    route(ws, cs, msg);
  });

  ws.on('close', () => {
    if (cs.cancelQueue) { cs.cancelQueue(); cs.cancelQueue = null; }
    if (cs.player && cs.roomId) {
      handleDisconnect(cs.player.id, cs.roomId);
    }
    // Clean up any admin spectator subscriptions
    if (cs.isAdmin && cs.spectatingRooms.size > 0) {
      unsubscribeSpectator(ws);
    }
    clients.delete(ws);
  });

  ws.on('error', () => ws.terminate());
});

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

    // ── Matchmaking ───────────────────────────────────────────────────────
    case 'joinQueue': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      if (cs.cancelQueue) cs.cancelQueue();
      cs.cancelQueue = joinQueue(cs.player.id, cs.player.username, ws, msg.fog ?? true, msg.playersPerSide ?? 1);
      break;
    }

    case 'leaveQueue': {
      if (cs.cancelQueue) { cs.cancelQueue(); cs.cancelQueue = null; }
      leaveQueue(cs.player?.id);
      break;
    }

    case 'playAI': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      joinAIGame(cs.player.id, cs.player.username, ws, msg.fog ?? true, msg.playersPerSide ?? 1);
      break;
    }

    case 'createRoom': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      createPrivateRoom(cs.player.id, cs.player.username, ws, msg.fog ?? true, msg.playersPerSide ?? 1);
      break;
    }

    case 'joinRoom': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      joinPrivateRoom(cs.player.id, cs.player.username, ws, msg.code);
      break;
    }

    // ── Room ID registration (sent by client after matchFound) ────────────
    case 'setRoom': {
      if (!cs.player) return;
      const room = getRoom(msg.roomId);
      if (room && room.players.some(s => s.playerId === cs.player.id)) {
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
    case 'adminAuth': {
      if (!isValidAdminKey(msg.key)) {
        send(ws, { type: 'adminAuthError', message: 'Invalid admin key.' });
        return;
      }
      cs.isAdmin = true;
      send(ws, { type: 'adminAuthOk' });
      break;
    }

    case 'adminGetRooms': {
      if (!cs.isAdmin) { send(ws, { type: 'error', message: 'Admin auth required.' }); return; }
      send(ws, { type: 'adminRooms', rooms: getRooms() });
      break;
    }

    case 'adminGetQueue': {
      if (!cs.isAdmin) { send(ws, { type: 'error', message: 'Admin auth required.' }); return; }
      send(ws, { type: 'adminQueue', queue: getQueue() });
      break;
    }

    case 'adminSpectateRoom': {
      if (!cs.isAdmin) { send(ws, { type: 'error', message: 'Admin auth required.' }); return; }
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
      if (!cs.isAdmin) return;
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
});
