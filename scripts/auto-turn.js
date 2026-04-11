#!/usr/bin/env node
/**
 * Auto-turn bot — connects to a game server, authenticates with a generated
 * player name, and takes a single pending turn using the AI engine, then exits.
 *
 * Tracks all bot entries in .auto-turn (JSON) at the project root so you can
 * later replay all active games with --all.
 *
 * Usage:
 *   node scripts/auto-turn.js <game-id> [server-url] [--name <name>] [--token <token>]
 *   node scripts/auto-turn.js --all              # step through every active entry
 *   node scripts/auto-turn.js --list             # print the .auto-turn table
 *
 * Server defaults to wss://calebshollow.com (production).
 * Name defaults to a random pick from a built-in bot name list.
 *
 * Examples:
 *   node scripts/auto-turn.js abc123                                  # prod, random name
 *   node scripts/auto-turn.js abc123 ws://localhost:3000              # local server
 *   node scripts/auto-turn.js abc123 --name MyBot                     # prod, custom name
 *   node scripts/auto-turn.js abc123 ws://localhost:3000 --token T    # local, saved token
 *   node scripts/auto-turn.js --all
 */

import WebSocket from 'ws';
import { deserializeState } from '../server/state-sync.js';
import { WitchAIEngine } from '../src/ai-engine.js';
import { HeroAIEngine } from '../src/hero-ai-engine.js';
import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, '..', '.auto-turn');

const DEFAULT_SERVER = 'wss://calebshollow.com';

const BOT_NAMES = [
  'Ashwick',      'Brambleshade',  'Cindermaw',     'Duskhollow',
  'Emberveil',    'Foxglove',      'Grimthorn',     'Hollowmere',
  'Ironbark',     'Juniperseed',   'Kettlecrow',    'Lanternwick',
  'Moldspore',    'Nightsoil',     'Owlstone',      'Pinecask',
  'Quartzvein',   'Rootwarden',    'Saltmarsh',     'Thorngage',
  'Undercroft',   'Vinerot',       'Wormwood',      'Yarrowtide',
];

function pickBotName() {
  return BOT_NAMES[Math.floor(Math.random() * BOT_NAMES.length)];
}

// ── .auto-turn persistence ─────────────────────────────────────────────────

function loadEntries() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return [];
  }
}

function saveEntries(entries) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(entries, null, 2) + '\n');
}

function upsertEntry(entries, { server, gameId, username, token, playerId, faction, status, round }) {
  // Dedup by token — each bot has a unique token tied to one game.
  // This lets us upgrade gameId from a CLI alias (e.g. "-h") to the real room UUID.
  const idx = entries.findIndex(e => e.server === server && e.token === token);
  const entry = {
    server,
    gameId,
    username,
    token,
    playerId,
    faction: faction ?? null,
    status: status ?? 'active',
    round: round ?? null,
    lastTurn: new Date().toISOString(),
  };
  if (idx >= 0) {
    entries[idx] = { ...entries[idx], ...entry };
  } else {
    entries.push(entry);
  }
  return entries;
}

// ── CLI args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const hasFlag = (name) => args.includes(name);

function getFlag(name) {
  const idx = args.indexOf(name);
  if (idx === -1) return null;
  return args[idx + 1] ?? null;
}

/** Flags that consume the next arg as their value. */
const VALUE_FLAGS = new Set(['--name', '--token']);

function getPositional() {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      if (VALUE_FLAGS.has(args[i])) i++; // skip the value
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

// ── --list mode ─────────────────────────────────────────────────────────────

if (hasFlag('--list')) {
  const entries = loadEntries();
  if (entries.length === 0) {
    console.log('No entries in .auto-turn');
  } else {
    console.log(`${'Status'.padEnd(10)} ${'Username'.padEnd(20)} ${'Faction'.padEnd(8)} ${'Round'.padEnd(6)} ${'Game ID'.padEnd(38)} ${'Server'}`);
    console.log('-'.repeat(120));
    for (const e of entries) {
      console.log(
        `${(e.status ?? '?').padEnd(10)} ${(e.username ?? '?').padEnd(20)} ${(e.faction ?? '?').padEnd(8)} ${String(e.round ?? '?').padEnd(6)} ${e.gameId.padEnd(38)} ${e.server}`
      );
    }
  }
  process.exit(0);
}

// ── --all mode ──────────────────────────────────────────────────────────────

if (hasFlag('--all')) {
  const entries = loadEntries();
  const active = entries.filter(e => e.status === 'active');
  if (active.length === 0) {
    console.log('[auto-turn] No active entries in .auto-turn');
    process.exit(0);
  }
  console.log(`[auto-turn] Processing ${active.length} active entries...\n`);

  let idx = 0;
  function next() {
    if (idx >= active.length) {
      console.log(`\n[auto-turn] Done — processed ${active.length} entries.`);
      process.exit(0);
    }
    const e = active[idx++];
    console.log(`\n[auto-turn] ── ${e.username} @ ${e.server} game ${e.gameId} ──`);
    runSingle({
      serverUrl: e.server,
      gameId: e.gameId,
      playerName: e.username,
      savedToken: e.token,
    }).then(next).catch(err => {
      console.error(`[auto-turn] Error: ${err.message}`);
      next();
    });
  }
  next();
} else {
  // ── Single-game mode ────────────────────────────────────────────────────

  const positional = getPositional();
  // First positional is game ID; second (optional) is server URL
  const gameId = positional[0];
  const serverUrl = positional[1] ?? DEFAULT_SERVER;
  const playerName = getFlag('--name') ?? pickBotName();
  const savedToken = getFlag('--token');

  if (!gameId) {
    console.error('Usage: node scripts/auto-turn.js <game-id> [server-url] [--name <name>] [--token <token>]');
    console.error('       node scripts/auto-turn.js --all');
    console.error('       node scripts/auto-turn.js --list');
    process.exit(1);
  }

  runSingle({ serverUrl, gameId, playerName, savedToken }).catch(err => {
    console.error(`[auto-turn] Fatal: ${err.message}`);
    process.exit(1);
  });
}

// ── Core logic ──────────────────────────────────────────────────────────────

function runSingle({ serverUrl, gameId, playerName, savedToken }) {
  return new Promise((resolve, reject) => {
    let playerId = null;
    let authToken = savedToken ?? null;
    let faction = null;
    let gameState = null;
    let planSubmitted = false;
    let username = playerName;
    let roomId = gameId;   // upgraded to canonical UUID once matchFound/reconnected arrives
    let joinedLobby = false;

    function log(msg) {
      console.log(`[auto-turn] ${msg}`);
    }

    function send(ws, msg) {
      ws.send(JSON.stringify(msg));
    }

    function buildAI(state) {
      if (faction === 'witch') {
        return new WitchAIEngine(state, null, 0, playerId);
      } else {
        return new HeroAIEngine(state, null, 0, playerId);
      }
    }

    function updateFile(status, round) {
      const entries = upsertEntry(loadEntries(), {
        server: serverUrl,
        gameId: roomId,
        username,
        token: authToken,
        playerId,
        faction,
        status,
        round,
      });
      saveEntries(entries);
    }

    function submitPlanAndExit(ws) {
      if (!gameState || !faction || planSubmitted) return;

      const plan = buildAI(gameState).generatePlan();
      log(`Submitting plan with ${plan.length} actions (round ${gameState.round})`);
      send(ws, { type: 'submitPlan', plan });
      planSubmitted = true;
      updateFile('active', gameState.round);
      log('Plan submitted. Disconnecting.');
      ws.close();
    }

    log(`Connecting to ${serverUrl} ...`);
    const ws = new WebSocket(serverUrl);

    ws.on('open', () => {
      log(`Connected. Authenticating as "${playerName}" ...`);
      const authMsg = { type: 'auth' };
      if (savedToken) {
        authMsg.token = savedToken;
        authMsg.roomId = gameId;
      } else {
        authMsg.username = playerName;
      }
      send(ws, authMsg);
    });

    function tryJoin() {
      if (savedToken) {
        // Returning player — try reconnecting to an active game first
        log(`Resuming game ${gameId} ...`);
        send(ws, { type: 'resumeSave', roomId: gameId });
      } else {
        // New player — try joining the lobby
        log(`Joining lobby ${gameId} ...`);
        send(ws, { type: 'joinLobby', codeOrId: gameId });
      }
    }

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }

      switch (msg.type) {

        case 'authOk': {
          playerId = msg.player.id;
          authToken = msg.player.token;
          username = msg.player.username;
          log(`Authenticated as ${username}#${msg.player.discriminator} (id: ${playerId})`);
          log(`Token: ${authToken}  (reuse with --token to reconnect)`);
          tryJoin();
          break;
        }

        case 'authError': {
          log(`Auth failed: ${msg.message}`);
          ws.close();
          reject(new Error(msg.message));
          return;
        }

        // ── Lobby flow ──────────────────────────────────────────────────

        case 'lobbyJoined': {
          const lobby = msg.lobby;
          roomId = lobby.id;
          joinedLobby = true;

          // Find first empty slot and claim it
          const emptyIdx = lobby.slots.findIndex(s => s.status === 'empty');
          const mySlot = lobby.slots.find(s => s.playerId === playerId);

          if (mySlot) {
            log(`Already in slot: ${mySlot.faction} seat ${mySlot.seatIndex}`);
          } else if (emptyIdx >= 0) {
            const slot = lobby.slots[emptyIdx];
            log(`Claiming slot ${emptyIdx} (${slot.faction} seat ${slot.seatIndex}) ...`);
            send(ws, { type: 'claimSlot', roomId: lobby.id, slotIndex: emptyIdx });
          } else {
            log('No empty slots available in lobby.');
            ws.close();
          }

          log('Waiting for game to start ...');
          break;
        }

        case 'lobbyUpdate': {
          // Ignore subsequent lobby broadcasts — we already claimed our slot
          break;
        }

        // ── Game flow ───────────────────────────────────────────────────

        case 'matchFound':
        case 'reconnected': {
          faction = msg.faction;
          playerId = msg.myPlayerId ?? playerId;
          roomId = msg.roomId ?? roomId;
          log(`Joined game as ${faction} (room: ${roomId})`);
          break;
        }

        case 'stateUpdate': {
          gameState = deserializeState(msg.state);
          log(`State received — round ${gameState.round}, phase: ${gameState.phase}`);

          if (gameState.gameOver) {
            log(`Game is already over. Winner: ${gameState.winner ?? 'draw'}`);
            updateFile('game-over', gameState.round);
            ws.close();
            return;
          }
          break;
        }

        case 'planningPhase': {
          const budget = msg.myActionsLeft;
          log(`Planning phase — round ${gameState?.round ?? '?'}, budget: ${budget} actions`);

          // Already submitted this round
          if (msg.submittedPlan) {
            log(`Turn already submitted (${msg.submittedPlan.length} actions). Nothing to do.`);
            updateFile('active', gameState?.round);
            ws.close();
            return;
          }

          // Submit a plan and exit
          if (gameState) {
            if (faction === 'hero') gameState.heroActionsLeft = msg.heroActionsLeft;
            else gameState.witchActionsLeft = msg.witchActionsLeft;
            if (msg.myActionsLeft !== undefined && gameState.playerActionsLeft) {
              gameState.playerActionsLeft.set(playerId, msg.myActionsLeft);
            }
            submitPlanAndExit(ws);
          }
          break;
        }

        case 'heartbeat':
        case 'gamesUpdate':
        case 'playerPresence':
        case 'playerSubmitted':
        case 'opponentReady': {
          break;
        }

        case 'error': {
          log(`Server error: ${msg.message}`);
          // Chain fallbacks: resumeSave → joinLobby → joinBattle → joinGame
          if (msg.message === 'Game is no longer active.' && savedToken && !joinedLobby) {
            log('Resume failed — trying joinLobby...');
            send(ws, { type: 'joinLobby', codeOrId: gameId });
          } else if (msg.message === 'Lobby not found or already started.' ||
                     msg.message === 'No open slots available.') {
            log('Lobby join failed — trying joinBattle...');
            send(ws, { type: 'joinBattle', roomId: gameId });
          } else if (msg.message === 'No active Battle found.') {
            log('Battle join failed — trying joinGame (late join)...');
            send(ws, { type: 'joinGame', codeOrId: gameId });
          } else if (msg.message === 'Game not found.' || msg.message === 'Game not found or already ended.') {
            log('Game not found — marking as gone.');
            updateFile('gone', null);
            ws.close();
          }
          break;
        }

        default: {
          log(`Unhandled message: ${msg.type}`);
          break;
        }
      }
    });

    ws.on('close', () => {
      log('Disconnected.');
      resolve();
    });

    ws.on('error', (err) => {
      reject(err);
    });
  });
}
