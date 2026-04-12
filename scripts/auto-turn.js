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
 *   node scripts/auto-turn.js abc123 --llm ollama:llama3              # use local LLM
 *   node scripts/auto-turn.js abc123 --llm claude:sonnet              # use Claude API
 *   node scripts/auto-turn.js abc123 --llm openai:gpt-4              # use OpenAI-compatible API
 *   node scripts/auto-turn.js --all
 */

import WebSocket from 'ws';
import { deserializeState } from '../server/state-sync.js';
import { WitchAIEngine } from '../src/ai-engine.js';
import { HeroAIEngine } from '../src/hero-ai-engine.js';
import { serializeGameStateForLLM, serializePlanForLLM, parsePlanFromLLM } from './training-data.js';
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

// ── LLM plan generation ───────────────────────────────────────────────────

const LLM_PROMPT_FILE = path.join(__dirname, 'llm-prompt.txt');
let _llmSystemPrompt = null;

function getLLMSystemPrompt() {
  if (!_llmSystemPrompt) {
    _llmSystemPrompt = fs.readFileSync(LLM_PROMPT_FILE, 'utf8');
  }
  return _llmSystemPrompt;
}

/**
 * Generate a plan using an LLM backend.
 * @param {string} provider - 'ollama', 'claude', or 'openai'
 * @param {string} model - model name (e.g. 'llama3', 'sonnet', 'gpt-4')
 * @param {object} gameState - deserialized GameState
 * @param {string} faction - 'hero' or 'witch'
 * @param {Array} history - previous turn history entries
 * @returns {Promise<import('../src/planner.js').PlanAction[]>}
 */
async function llmGeneratePlan(provider, model, gameState, faction, history = []) {
  const systemPrompt = getLLMSystemPrompt();
  const statePrompt = serializeGameStateForLLM(gameState, faction);

  // Build history context from previous turns
  let historySection = '';
  if (history.length > 0) {
    const historyLines = [];
    for (const h of history) {
      historyLines.push(`--- Round ${h.round} (${h.phase}) ---`);
      historyLines.push(`Your plan:\n${h.plan}`);
      if (h.log?.length > 0) {
        historyLines.push(`What happened:\n${h.log.join('\n')}`);
      }
    }
    historySection = `\n--- PREVIOUS TURNS ---\n\n${historyLines.join('\n')}\n`;
  }

  const fullPrompt = `${systemPrompt}\n${historySection}\n--- CURRENT GAME STATE ---\n\n${statePrompt}\n\nYou are playing as ${faction.toUpperCase()}. Plan your actions:`;

  let responseText;

  if (provider === 'ollama') {
    const url = process.env.OLLAMA_URL ?? 'http://localhost:11434';
    const res = await fetch(`${url}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, prompt: fullPrompt, stream: false }),
    });
    if (!res.ok) throw new Error(`Ollama error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    responseText = data.response;

  } else if (provider === 'claude') {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY env var required for claude provider');
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: model === 'sonnet' ? 'claude-sonnet-4-20250514' :
               model === 'haiku'  ? 'claude-haiku-4-5-20251001' :
               model === 'opus'   ? 'claude-opus-4-20250514' : model,
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: `${statePrompt}\n\nYou are playing as ${faction.toUpperCase()}. Plan your actions:` }],
      }),
    });
    if (!res.ok) throw new Error(`Claude API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    responseText = data.content?.[0]?.text ?? '';

  } else if (provider === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY env var required for openai provider');
    const baseUrl = process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1';
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `${statePrompt}\n\nYou are playing as ${faction.toUpperCase()}. Plan your actions:` },
        ],
        max_tokens: 1024,
      }),
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
    const data = await res.json();
    responseText = data.choices?.[0]?.message?.content ?? '';

  } else {
    throw new Error(`Unknown LLM provider: ${provider}. Use ollama, claude, or openai.`);
  }

  // Show strategy and reasoning (everything before PLAN:)
  const planIdx = responseText.indexOf('PLAN:');
  if (planIdx >= 0) {
    console.log(`\n[llm] Strategy & reasoning:\n${responseText.slice(0, planIdx).trim()}\n`);
    console.log(`[llm] Plan:\n${responseText.slice(planIdx + 5).trim()}\n`);
  } else {
    console.log(`[llm] Raw response:\n${responseText}\n`);
  }
  return parsePlanFromLLM(responseText, gameState, faction);
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

function upsertEntry(entries, { server, gameId, username, token, playerId, faction, status, round, turnHistory }) {
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
    // Append turn history if provided (don't overwrite existing)
    if (turnHistory) {
      if (!entries[idx].turnHistory) entries[idx].turnHistory = [];
      entries[idx].turnHistory.push(...turnHistory);
      // Keep last 10 rounds of history to prevent unbounded growth
      if (entries[idx].turnHistory.length > 10) {
        entries[idx].turnHistory = entries[idx].turnHistory.slice(-10);
      }
    }
  } else {
    if (turnHistory) entry.turnHistory = turnHistory;
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
const VALUE_FLAGS = new Set(['--name', '--token', '--llm']);

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
  const llmFlag = getFlag('--llm');  // e.g. "ollama:llama3", "claude:sonnet"

  if (!gameId) {
    console.error('Usage: node scripts/auto-turn.js <game-id> [server-url] [--name <name>] [--token <token>] [--llm provider:model]');
    console.error('       node scripts/auto-turn.js --all');
    console.error('       node scripts/auto-turn.js --list');
    process.exit(1);
  }

  runSingle({ serverUrl, gameId, playerName, savedToken, llmFlag }).catch(err => {
    console.error(`[auto-turn] Fatal: ${err.message}`);
    process.exit(1);
  });
}

// ── Core logic ──────────────────────────────────────────────────────────────

function runSingle({ serverUrl, gameId, playerName, savedToken, llmFlag = null }) {
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

    function updateFile(status, round, turnHistory = null) {
      const entries = upsertEntry(loadEntries(), {
        server: serverUrl,
        gameId: roomId,
        username,
        token: authToken,
        playerId,
        faction,
        status,
        round,
        turnHistory,
      });
      saveEntries(entries);
    }

    /** Load turn history from .auto-turn for this game */
    function loadTurnHistory() {
      const entries = loadEntries();
      const entry = entries.find(e => e.server === serverUrl && e.token === (savedToken ?? authToken));
      return entry?.turnHistory ?? [];
    }

    async function submitPlanAndExit(ws) {
      if (!gameState || !faction || planSubmitted) return;
      planSubmitted = true;  // set immediately to prevent duplicate calls during async LLM wait

      let plan;
      let planText = null;
      if (llmFlag) {
        const [provider, model] = llmFlag.split(':');
        if (!provider || !model) {
          log(`Invalid --llm flag: ${llmFlag} (expected provider:model)`);
          ws.close();
          return;
        }
        try {
          const history = loadTurnHistory();
          log(`Generating plan via ${provider}:${model} (${history.length} turns of history) ...`);
          plan = await llmGeneratePlan(provider, model, gameState, faction, history);
          planText = serializePlanForLLM(plan, gameState);
        } catch (err) {
          log(`LLM error: ${err.message} — falling back to built-in AI`);
          plan = buildAI(gameState).generatePlan();
        }
      } else {
        plan = buildAI(gameState).generatePlan();
      }

      log(`Submitting plan with ${plan.length} actions (round ${gameState.round})`);
      send(ws, { type: 'submitPlan', plan });

      // Save turn history for LLM context in future turns
      const turnEntry = {
        round: gameState.round,
        phase: gameState.phase,
        plan: planText ?? serializePlanForLLM(plan, gameState),
        // Include recent game log entries (last ~10 lines from this session)
        log: (gameState.log ?? []).slice(-10),
      };
      updateFile('active', gameState.round, [turnEntry]);
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
          // When reconnecting with a saved token, don't fall through to joinBattle
          // (which auto-assigns to a random room) — the game is just gone.
          if (msg.message === 'Game is no longer active.' && savedToken && !joinedLobby) {
            log('Game no longer active — marking as gone.');
            updateFile('gone', null);
            ws.close();
          } else if (msg.message === 'Game is no longer active.' && !savedToken) {
            log('Game not active — trying joinLobby...');
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
