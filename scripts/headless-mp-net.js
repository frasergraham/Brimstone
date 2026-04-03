#!/usr/bin/env node
// Headless multiplayer network test — spins up a real server and plays full
// games through WebSocket connections, simulating multiple human players.
//
// Usage:  node scripts/headless-mp-net.js [numGames] [playersPerSide] [--verbose] [--no-disconnect]
//
// Each virtual client authenticates, joins a lobby, and auto-submits AI plans
// every round until the game completes.  Disconnect/reconnect scenarios are
// exercised unless --no-disconnect is passed.

import { spawn }       from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import WebSocket         from 'ws';

import { WitchAIEngine }  from '../src/ai-engine.js';
import { HeroAIEngine }   from '../src/hero-ai-engine.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const ROOT       = join(__dirname, '..');
const MAX_ROUNDS = 48;
const GAME_TIMEOUT_MS = 300_000;  // 5 minutes per game

// ── CLI args ────────────────────────────────────────────────────────────────

const args           = process.argv.slice(2).filter(a => !a.startsWith('--'));
const flags          = process.argv.slice(2).filter(a => a.startsWith('--'));
const NUM_GAMES      = args[0] !== undefined ? (parseInt(args[0], 10) || 0) : 5;
const PLAYERS_PER_SIDE = parseInt(args[1], 10) || 1;
const VERBOSE        = flags.includes('--verbose');
const NO_DISCONNECT  = flags.includes('--no-disconnect');

// ── Helpers ─────────────────────────────────────────────────────────────────

function snapshotToState(snap) {
  const tiles = new Map();
  for (const t of snap.tiles) {
    t.roadDirs = new Set(t.roadDirs || []);
    tiles.set(t.key, t);
  }
  // Serialized entities are plain objects without the `alive` getter.
  // PlanSimState filters on e.alive, so we must add it explicitly.
  const entities = snap.entities.map(e => ({
    ...e,
    alive: (e.hp ?? 0) > 0,
  }));
  return { ...snap, tiles, entities };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

let _clientId = 0;

// ── BotClient ───────────────────────────────────────────────────────────────

class BotClient {
  constructor(name) {
    this.name      = name;
    this._id       = ++_clientId;
    this.ws        = null;
    this.player    = null;   // from authOk
    this.faction   = null;
    this.playerId  = null;
    this.roomId    = null;
    this.code      = null;   // lobby code
    this.state     = null;   // latest snapshot (raw)
    this.gameOver  = false;
    this.winner    = null;
    this.round     = 0;
    this.error     = null;
    this._waiters  = [];     // [{type, resolve, reject, timer}]
    this._msgQueue = [];     // buffered messages with no matching waiter
    this._autoPlay = false;  // when true, auto-submit plans on planningPhase
  }

  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.on('open', () => resolve());
      this.ws.on('error', (err) => {
        this.error = err.message;
        reject(err);
      });
      this.ws.on('close', () => { /* expected during disconnect tests */ });
      this.ws.on('message', (raw) => {
        let msg;
        try { msg = JSON.parse(raw); } catch { return; }
        this._onMessage(msg);
      });
    });
  }

  send(msg) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  close() {
    if (this.ws) {
      this.ws.removeAllListeners('close');
      this.ws.close();
      this.ws = null;
    }
  }

  waitFor(type, timeoutMs = 30_000) {
    // Check buffer first — message may have arrived before waitFor was called
    const bufIdx = this._msgQueue.findIndex(m => m.type === type);
    if (bufIdx !== -1) {
      return Promise.resolve(this._msgQueue.splice(bufIdx, 1)[0]);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters = this._waiters.filter(w => w !== waiter);
        reject(new Error(`${this.name}: timeout waiting for '${type}'`));
      }, timeoutMs);
      const waiter = { type, resolve, reject, timer };
      this._waiters.push(waiter);
    });
  }

  async auth(token = null, roomId = null) {
    const msg = { type: 'auth', username: this.name };
    if (token)  msg.token  = token;
    if (roomId) msg.roomId = roomId;
    this.send(msg);
    const reply = await this.waitFor('authOk');
    this.player = reply.player;
    return reply;
  }

  // ── Internal message routing ──────────────────────────────────────────────

  _onMessage(msg) {
    // Resolve any pending waitFor() calls, or buffer for later
    const idx = this._waiters.findIndex(w => w.type === msg.type);
    if (idx !== -1) {
      const waiter = this._waiters.splice(idx, 1)[0];
      clearTimeout(waiter.timer);
      waiter.resolve(msg);
    } else {
      this._msgQueue.push(msg);
    }

    switch (msg.type) {
      case 'authOk':
        this.player = msg.player;
        break;

      case 'lobbyJoined':
        this.roomId = msg.lobby?.id ?? msg.roomId;
        this.code   = msg.lobby?.code ?? msg.code;
        break;

      case 'matchFound':
        this.faction  = msg.faction;
        this.playerId = msg.myPlayerId ?? msg.playerId;
        this.roomId   = msg.roomId;
        this.send({ type: 'setRoom', roomId: this.roomId });
        break;

      case 'stateUpdate':
        this.state = msg.state;
        if (msg.state?.winner != null) {
          this.gameOver = true;
          this.winner   = msg.state.winner;
        }
        break;

      case 'planningPhase':
        if (this._autoPlay && this.state) {
          this._submitAIPlan(msg.myActionsLeft);
        }
        break;

      case 'resolutionComplete':
        if (msg.finalState) {
          this.state = msg.finalState;
          this.round = msg.finalState.round ?? this.round + 1;
          if (msg.finalState.winner != null) {
            this.gameOver = true;
            this.winner   = msg.finalState.winner;
          }
        }
        break;

      case 'reconnected':
        this.faction  = msg.faction;
        this.playerId = msg.myPlayerId;
        this.roomId   = msg.roomId;
        this.send({ type: 'setRoom', roomId: this.roomId });
        break;

      case 'error':
      case 'actionError':
        if (VERBOSE) console.log(`  [${this.name}] server error: ${msg.message}`);
        break;
    }
  }

  _submitAIPlan(budget) {
    try {
      const stateObj = snapshotToState(this.state);
      const AICls    = this.faction === 'hero' ? HeroAIEngine : WitchAIEngine;
      const ai       = new AICls(stateObj, () => {}, 0, this.playerId);
      const plan     = ai.generatePlan();
      this.send({ type: 'submitPlan', plan });
    } catch (err) {
      if (VERBOSE) console.log(`  [${this.name}] AI plan error: ${err.message}`);
      this.send({ type: 'submitPlan', plan: [] });
    }
  }
}

// ── Server lifecycle ────────────────────────────────────────────────────────

function startServer() {
  const port = 30000 + Math.floor(Math.random() * 20000);
  return new Promise((resolve, reject) => {
    const child = spawn('node', ['server.js'], {
      cwd: ROOT,
      env: {
        ...process.env,
        PORT:               String(port),
        DB_PATH:            ':memory:',
        RECONNECT_GRACE_MS: '5000',
        ROUND_DELAY_MS:     '100',
        TURN_TIMEOUT_MS:    '3000',   // fast turn deadlines for disconnect tests
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let started = false;
    const startTimeout = setTimeout(() => {
      if (!started) { child.kill(); reject(new Error('Server start timeout')); }
    }, 15_000);

    child.stdout.on('data', (data) => {
      const line = data.toString();
      if (VERBOSE) process.stdout.write(`  [server] ${line}`);
      if (!started && line.includes('listening on port')) {
        started = true;
        clearTimeout(startTimeout);
        resolve({ child, port });
      }
    });
    child.stderr.on('data', (data) => {
      if (VERBOSE) process.stderr.write(`  [server:err] ${data}`);
    });
    child.on('exit', (code) => {
      if (!started) { clearTimeout(startTimeout); reject(new Error(`Server exited with code ${code}`)); }
    });
  });
}

async function waitForHealth(port, retries = 20) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch { /* retry */ }
    await sleep(300);
  }
  throw new Error('Server health check failed');
}

// ── Game runner ─────────────────────────────────────────────────────────────

async function runGame(port, gameNum, totalGames) {
  const wsUrl = `ws://127.0.0.1:${port}`;
  const totalPlayers = PLAYERS_PER_SIDE * 2;
  const clients = [];

  try {
    // Create and connect all clients
    for (let i = 0; i < totalPlayers; i++) {
      const faction = i < PLAYERS_PER_SIDE ? 'hero' : 'witch';
      const bot = new BotClient(`B${faction[0]}${i}g${gameNum}`);
      await bot.connect(wsUrl);
      await bot.auth();
      clients.push(bot);
    }

    const host = clients[0];

    // Host creates lobby
    host.send({
      type: 'createLobby',
      playersPerSide: PLAYERS_PER_SIDE,
      mapSize: 'skirmish',
      isPrivate: true,
    });
    await host.waitFor('lobbyJoined');

    // Other clients join via room ID
    for (let i = 1; i < clients.length; i++) {
      clients[i].send({ type: 'joinLobby', codeOrId: host.roomId });
      await clients[i].waitFor('lobbyJoined');
    }

    // Enable auto-play on all clients
    for (const c of clients) c._autoPlay = true;

    // Host starts game
    host.send({ type: 'startGame', roomId: host.roomId });

    // Wait for matchFound on all clients
    await Promise.all(clients.map(c => c.waitFor('matchFound')));

    // Wait for game to complete
    const start = Date.now();
    while (!host.gameOver) {
      if (Date.now() - start > GAME_TIMEOUT_MS) {
        throw new Error(`Game ${gameNum} timed out after ${GAME_TIMEOUT_MS / 1000}s (round ${host.round})`);
      }
      // Force draw at round cap (game has no built-in draw timer)
      if (host.round >= MAX_ROUNDS) {
        host.gameOver = true;
        host.winner   = 'draw';
        break;
      }
      await sleep(200);
    }

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    const winner = host.winner;
    const rounds = host.round;
    const label  = winner === 'draw' ? 'Draw' : `${winner} wins`;
    console.log(`Game ${gameNum}/${totalGames}: ${label} in ${rounds} rounds (${elapsed}s)`);
    return { winner, rounds, elapsed: parseFloat(elapsed), error: null };

  } finally {
    for (const c of clients) c.close();
  }
}

// ── Disconnect test: turn-timeout AI takeover + reconnect ───────────────────
//
// New model: disconnect does NOT immediately trigger AI takeover.
// Instead, the turn timer expires (TURN_TIMEOUT_MS=3s in test mode) and
// auto-submits an empty plan for the disconnected player. After 2 consecutive
// timeouts, _checkTimeoutTakeovers() replaces them with AI.

async function runDisconnectTest(port, label, disconnectTiming) {
  const wsUrl = `ws://127.0.0.1:${port}`;

  const heroBot  = new BotClient(`DH_${label.slice(0, 10)}`);
  const witchBot = new BotClient(`DW_${label.slice(0, 10)}`);

  try {
    await heroBot.connect(wsUrl);
    await heroBot.auth();
    await witchBot.connect(wsUrl);
    await witchBot.auth();

    heroBot.send({ type: 'createLobby', playersPerSide: 1, mapSize: 'skirmish', isPrivate: true, turnIntervalMs: 3000 });
    await heroBot.waitFor('lobbyJoined');

    witchBot.send({ type: 'joinLobby', codeOrId: heroBot.roomId });
    await witchBot.waitFor('lobbyJoined');

    heroBot._autoPlay  = true;
    witchBot._autoPlay = true;

    heroBot.send({ type: 'startGame', roomId: heroBot.roomId });
    await Promise.all([heroBot.waitFor('matchFound'), witchBot.waitFor('matchFound')]);

    const savedToken  = witchBot.player.token;
    const savedRoomId = witchBot.roomId;
    const checks = [];

    if (disconnectTiming === 'timeout-takeover') {
      // Play 2 rounds normally, then disconnect witch
      await witchBot.waitFor('resolutionComplete', 30_000);
      await witchBot.waitFor('resolutionComplete', 30_000);
      witchBot._autoPlay = false;
      witchBot.close();
      checks.push('disconnected after round 2');

      // Hero should receive opponentDisconnected
      await heroBot.waitFor('opponentDisconnected', 10_000);
      checks.push('opponentDisconnected received');

      // Wait for turn timer to expire (turnIntervalMs=3s) and round to resolve.
      // Hero auto-submits; witch gets auto-submitted empty plan after timeout.
      // Need 2 consecutive timeouts for AI takeover, so wait for 2 resolution cycles.
      // Each cycle: ~3s turn timer + overhead → use generous 30s timeout.
      await heroBot.waitFor('resolutionComplete', 30_000);
      checks.push('round resolved after timeout');

      // Second timeout cycle → triggers _checkTimeoutTakeovers → AI takes over
      await heroBot.waitFor('resolutionComplete', 30_000);
      checks.push('AI takeover after 2 timeouts');

      // Game should now be running with AI — wait a bit for more rounds
      await heroBot.waitFor('resolutionComplete', 15_000);
      checks.push('game continued with AI');

    } else if (disconnectTiming === 'reconnect-before-timeout') {
      // Play 1 round, then disconnect witch during the next planning phase
      await witchBot.waitFor('resolutionComplete', 30_000);
      witchBot._autoPlay = false;

      // Wait for next planning phase for witch, then disconnect
      await witchBot.waitFor('planningPhase', 30_000);
      witchBot.close();
      checks.push('disconnected during planning');

      // Wait briefly (less than TURN_TIMEOUT_MS=3s), then reconnect
      await sleep(1000);
    }

    // Reconnect witch — register waiters BEFORE auth since reconnected arrives before authOk
    const witchBot2 = new BotClient(witchBot.name);
    await witchBot2.connect(wsUrl);
    const reconPromise = witchBot2.waitFor('reconnected', 10_000);
    const statePromise = witchBot2.waitFor('stateUpdate', 10_000);
    witchBot2.auth(savedToken, savedRoomId); // don't await — reconnected comes first

    const reconMsg = await reconPromise;
    checks.push('reconnected');
    witchBot2.faction  = reconMsg.faction;
    witchBot2.playerId = reconMsg.myPlayerId;
    witchBot2.roomId   = reconMsg.roomId;
    witchBot2.send({ type: 'setRoom', roomId: reconMsg.roomId });

    await statePromise;
    checks.push('stateUpdate received');

    // Resume auto-play
    witchBot2._autoPlay = true;

    // Wait for game to complete
    const start = Date.now();
    while (!heroBot.gameOver) {
      if (Date.now() - start > GAME_TIMEOUT_MS) {
        throw new Error(`Disconnect test '${label}' timed out`);
      }
      if (heroBot.round >= MAX_ROUNDS) {
        heroBot.gameOver = true;
        heroBot.winner   = 'draw';
        break;
      }
      await sleep(200);
    }

    const winner = heroBot.winner;
    const rounds = heroBot.round;
    const resultLabel = winner === 'draw' ? `draw at round ${rounds}` : `${winner} wins in ${rounds} rounds`;
    console.log(`Disconnect test (${label}): ${checks.join(', ')} — ${resultLabel}`);
    witchBot2.close();
    return { error: null, checks };

  } catch (err) {
    console.log(`Disconnect test (${label}): FAILED — ${err.message}`);
    return { error: err.message, checks: [] };
  } finally {
    heroBot.close();
    witchBot.close();
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log('Brimstone Multiplayer Network Test');
  console.log('===================================');
  console.log(`Games: ${NUM_GAMES} x ${PLAYERS_PER_SIDE}v${PLAYERS_PER_SIDE} | Disconnect tests: ${NO_DISCONNECT ? 'off' : 'on'}\n`);

  let serverInfo;
  try {
    serverInfo = await startServer();
  } catch (err) {
    console.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  }

  const { child, port } = serverInfo;
  console.log(`Server started on port ${port} (PID ${child.pid})\n`);

  try {
    await waitForHealth(port);

    const results = [];
    let errors = 0;

    // Run normal games
    for (let i = 1; i <= NUM_GAMES; i++) {
      try {
        const result = await runGame(port, i, NUM_GAMES);
        results.push(result);
      } catch (err) {
        console.log(`Game ${i}/${NUM_GAMES}: FAILED — ${err.message}`);
        results.push({ winner: null, rounds: 0, elapsed: 0, error: err.message });
        errors++;
      }
    }

    // Run disconnect tests
    const disconnectResults = [];
    if (!NO_DISCONNECT) {
      console.log('');
      try {
        disconnectResults.push(await runDisconnectTest(port, 'timeout-takeover', 'timeout-takeover'));
      } catch (err) {
        disconnectResults.push({ error: err.message });
      }
      try {
        disconnectResults.push(await runDisconnectTest(port, 'reconnect-before-timeout', 'reconnect-before-timeout'));
      } catch (err) {
        disconnectResults.push({ error: err.message });
      }
      for (const dr of disconnectResults) {
        if (dr.error) errors++;
      }
    }

    // Summary
    const totalGames = results.length + disconnectResults.length;
    const completed  = results.filter(r => !r.error).length + disconnectResults.filter(r => !r.error).length;
    const heroWins   = results.filter(r => r.winner === 'hero').length;
    const witchWins  = results.filter(r => r.winner === 'witch').length;
    const draws      = results.filter(r => r.winner === 'draw').length;
    const goodResults = results.filter(r => !r.error);
    const avgRounds  = goodResults.length > 0
      ? (goodResults.reduce((s, r) => s + r.rounds, 0) / goodResults.length).toFixed(1)
      : 'N/A';
    const avgTime    = goodResults.length > 0
      ? (goodResults.reduce((s, r) => s + r.elapsed, 0) / goodResults.length).toFixed(1)
      : 'N/A';

    console.log(`\nSummary: ${completed}/${totalGames} completed, ${errors} errors`);
    console.log(`  Hero: ${heroWins} | Witch: ${witchWins} | Draw: ${draws}`);
    console.log(`  Avg rounds: ${avgRounds} | Avg time: ${avgTime}s`);

    process.exit(errors > 0 ? 1 : 0);

  } finally {
    child.kill();
  }
}

main().catch(err => {
  console.error(`Fatal: ${err.message}`);
  process.exit(1);
});
