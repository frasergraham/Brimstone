// Brimstone multiplayer server — Express (static files) + WebSocket (game protocol)
import express    from 'express';
import { WebSocketServer } from 'ws';
import { createServer }    from 'http';
import { join, dirname }   from 'path';
import { fileURLToPath }   from 'url';

import { VERSION } from './src/version.js';
import { registerOrLogin, getPlayerByToken } from './server/auth.js';
import { getLeaderboard }                    from './server/leaderboard.js';
import {
  joinQueue, leaveQueue,
  createPrivateRoom, joinPrivateRoom,
  joinAIGame,
  handleAction, handleEndTurn, handlePlanSubmit,
  handleDisconnect, handleReconnect,
  getRoom,
} from './server/lobby.js';

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

// ── HTTP + WS server ─────────────────────────────────────────────────────────

const server = createServer(app);
const wss    = new WebSocketServer({ server });

// Per-connection state
const clients = new Map(); // ws → { player, roomId, cancelQueue? }

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}

function clientState(ws) {
  if (!clients.has(ws)) clients.set(ws, { player: null, roomId: null, cancelQueue: null });
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
      cs.cancelQueue = joinQueue(cs.player.id, cs.player.username, ws, msg.fog ?? true);
      break;
    }

    case 'leaveQueue': {
      if (cs.cancelQueue) { cs.cancelQueue(); cs.cancelQueue = null; }
      leaveQueue(cs.player?.id);
      break;
    }

    case 'playAI': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      joinAIGame(cs.player.id, cs.player.username, ws, msg.fog ?? true);
      break;
    }

    case 'createRoom': {
      if (!cs.player) { send(ws, { type: 'error', message: 'Not authenticated.' }); return; }
      createPrivateRoom(cs.player.id, cs.player.username, ws, msg.fog ?? true);
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
      if (room) {
        const faction = room.heroPlayerId === cs.player.id ? 'hero'
                      : room.witchPlayerId === cs.player.id ? 'witch' : null;
        if (faction) cs.roomId = msg.roomId;
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
});
