#!/usr/bin/env node
/**
 * Headless game runner — plays N AI vs AI games and reports balance stats.
 * Supports 1v1 through 4v4 on any map size, plus 10v10 battle mode.
 *
 * Usage:
 *   node scripts/headless.js [count] [size] [--players N]
 *   node scripts/headless.js --render [size] [--players N] [outfile.gif]
 *
 * Examples:
 *   node scripts/headless.js 200 standard              → 200 1v1 games on standard
 *   node scripts/headless.js 50 campaign --players 4    → 50 4v4 games on campaign
 *   node scripts/headless.js 10 battle --players 10     → 10 10v10 games on battle (42×42)
 *   node scripts/headless.js --render campaign --players 4  → render 4v4 campaign GIF
 *   node scripts/headless.js --render skirmish out.gif  → render 1v1 skirmish GIF
 *
 * Sizes: skirmish | standard | regional | campaign | battle
 */

import { GameState, GameMode, WIN_REASON, nodeController } from '../src/game.js';
import { HeroAIEngine }          from '../src/hero-ai-engine.js';
import { WitchAIEngine }        from '../src/ai-engine.js';
import { resolvePlansMP, ResEventType } from '../server/resolver.js';
import { PlanActionType }         from '../src/planner.js';
import { generateMultipleStarts, generateBattleStarts, MAP_SIZES } from '../src/map.js';
import { HERO_PLAYER_COLORS, WITCH_PLAYER_COLORS, EntityType } from '../src/entities.js';
import { getFaction, getFactionsForSide } from '../src/factions.js';
import { serializeState }         from '../server/state-sync.js';
import { VERSION }                from '../src/version.js';
import { serializeGameStateForLLM, serializePlanForLLM } from './training-data.js';
import { randomUUID }             from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Optional: record stats to DB if available (fails silently if DB module not loadable)
let recordGameStats = null;
try {
  const mod = await import('../server/game-stats.js');
  recordGameStats = mod.recordGameStats;
} catch { /* running without server deps — skip stats recording */ }

// ── CLI parsing ───────────────────────────────────────────────────────────────

const RENDER_MODE = process.argv.includes('--render');
const TRAINING_DATA_IDX = process.argv.indexOf('--training-data');
const TRAINING_DATA_FILE = TRAINING_DATA_IDX !== -1 ? process.argv[TRAINING_DATA_IDX + 1] : null;

// Extract --players N (validated after MAP_SIZE is known — battle allows up to 10)
let PER_SIDE = 1;
let PER_SIDE_EXPLICIT = false;
const playersIdx = process.argv.indexOf('--players');
if (playersIdx !== -1 && process.argv[playersIdx + 1]) {
  PER_SIDE = parseInt(process.argv[playersIdx + 1], 10);
  PER_SIDE_EXPLICIT = true;
}

// Per-side faction selection: --day=<factionId> / --night=<factionId>.
// Defaults: 'hero' (Paladin) for day, 'witch' for night. Stub factions
// (rogue/captain/necromancer/brute) are accepted; they swap the leader's
// stats via state.swapLeaderToFaction after each game's state is built.
let DAY_FACTION   = 'hero';
let NIGHT_FACTION = 'witch';
const _kvFlag = (prefix) => {
  const arg = process.argv.find(a => a.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : null;
};
DAY_FACTION   = _kvFlag('--day=')   ?? DAY_FACTION;
NIGHT_FACTION = _kvFlag('--night=') ?? NIGHT_FACTION;

// Positional args (everything that isn't a flag or flag value)
const flagSet = new Set(['--render', '--players', '--training-data']);
const positionalArgs = [];
for (let i = 2; i < process.argv.length; i++) {
  if (flagSet.has(process.argv[i])) { if (process.argv[i] === '--players') i++; continue; }
  if (process.argv[i].startsWith('--day=') || process.argv[i].startsWith('--night=')) continue;
  positionalArgs.push(process.argv[i]);
}

let N, MAP_SIZE, RENDER_OUT;
if (RENDER_MODE) {
  MAP_SIZE   = positionalArgs[0] ?? 'standard';
  RENDER_OUT = positionalArgs[1] ?? path.join(__dirname, `renders/game_${PER_SIDE}v${PER_SIDE}_${MAP_SIZE}_${Date.now()}.gif`);
  N = 1;
} else {
  N        = parseInt(positionalArgs[0] ?? '200', 10);
  MAP_SIZE = positionalArgs[1] ?? 'standard';
  if (isNaN(N) || N < 1) {
    console.error('Usage: node scripts/headless.js [count] [size] [--players N]');
    console.error('       node scripts/headless.js --render [size] [--players N] [outfile.gif]');
    process.exit(1);
  }
}

if (!MAP_SIZES[MAP_SIZE]) {
  console.error(`Unknown map size "${MAP_SIZE}". Valid: ${Object.keys(MAP_SIZES).join(', ')}`);
  process.exit(1);
}

// Validate --day / --night picks against the registered factions for each side.
const _dayIds   = getFactionsForSide('day').map(f => f.id);
const _nightIds = getFactionsForSide('night').map(f => f.id);
if (!_dayIds.includes(DAY_FACTION)) {
  console.error(`Unknown --day faction "${DAY_FACTION}". Valid: ${_dayIds.join(', ')}`);
  process.exit(1);
}
if (!_nightIds.includes(NIGHT_FACTION)) {
  console.error(`Unknown --night faction "${NIGHT_FACTION}". Valid: ${_nightIds.join(', ')}`);
  process.exit(1);
}
const _STUB_DAY   = getFaction(DAY_FACTION).isStub();
const _STUB_NIGHT = getFaction(NIGHT_FACTION).isStub();

const IS_BATTLE = MAP_SIZE === 'battle';

// Default battle mode to 10v10 if --players not specified
if (IS_BATTLE && !PER_SIDE_EXPLICIT) PER_SIDE = 10;

// Validate player count against map mode
const maxPPS = IS_BATTLE ? 10 : 4;
if (PER_SIDE < 1 || PER_SIDE > maxPPS) {
  console.error(`--players must be 1–${maxPPS} for ${MAP_SIZE} maps`);
  process.exit(1);
}

const TOTAL_PLAYERS = PER_SIDE * 2;
const IS_MP = PER_SIDE > 1;
const { cols, rows } = MAP_SIZES[MAP_SIZE];
const MAX_ROUNDS = Math.ceil(48 * (cols * rows) / (13 * 11));
const label = IS_MP
  ? `${TOTAL_PLAYERS}-player (${PER_SIDE}v${PER_SIDE}) ${MAP_SIZES[MAP_SIZE].label}`
  : `${MAP_SIZES[MAP_SIZE].label}`;

// ── Game state builder ────────────────────────────────────────────────────────

function buildGameState() {
  const state = new GameState(true, true, MAP_SIZE);

  if (IS_BATTLE) {
    // Battle mode: set game mode and config (mirrors lobby.js createBattle)
    state.gameMode     = GameMode.BATTLE;
    state.battleConfig = { endsAt: 0, maxPlayersPerSide: PER_SIDE };

    // Remove default hero/witch from constructor — battle adds all players via addPlayer
    state.entities.length = 0;
    state.players.length  = 0;
    state.hero  = null;
    state.witch = null;

    // Generate start positions using battle-specific placement (faction edge columns)
    const heroStarts  = generateBattleStarts(state.tiles, 'hero',  PER_SIDE, 2);
    const witchStarts = generateBattleStarts(state.tiles, 'witch', PER_SIDE, 2);

    for (let i = 0; i < PER_SIDE; i++) {
      const hp = heroStarts[i] ?? heroStarts[0];
      state.addPlayer(randomUUID(), `Hero${i + 1}`, 'hero', hp.col, hp.row, true);
    }
    for (let i = 0; i < PER_SIDE; i++) {
      const wp = witchStarts[i] ?? witchStarts[0];
      state.addPlayer(randomUUID(), `Witch${i + 1}`, 'witch', wp.col, wp.row, true);
    }
  } else if (IS_MP) {
    // Standard multiplayer: patch synthetic players and add extras
    const p0 = state.players[0]; // hero
    const p1 = state.players[1]; // witch
    const heroId0  = randomUUID();
    const witchId0 = randomUUID();
    p0.id = heroId0;  state.entities.find(e => e.id === p0.leaderId && e.owner === 'hero').ownerId  = heroId0;
    p1.id = witchId0; state.entities.find(e => e.id === p1.leaderId && e.owner === 'witch').ownerId = witchId0;

    const heroStart  = { col: state.hero.col,  row: state.hero.row  };
    const witchStart = { col: state.witch.col, row: state.witch.row };

    if (PER_SIDE > 1) {
      const heroPositions = generateMultipleStarts(state.tiles, heroStart, PER_SIDE, 2, 6);
      for (let i = 1; i < PER_SIDE; i++) {
        const pos = heroPositions[i] ?? heroStart;
        state.addPlayer(randomUUID(), `Hero${i + 1}`, 'hero', pos.col, pos.row, true);
      }
      const witchPositions = generateMultipleStarts(state.tiles, witchStart, PER_SIDE, 2, 6);
      for (let i = 1; i < PER_SIDE; i++) {
        const pos = witchPositions[i] ?? witchStart;
        state.addPlayer(randomUUID(), `Witch${i + 1}`, 'witch', pos.col, pos.row, true);
      }
    }
  }

  // Assign per-player colors to leader entities (mirrors lobby.js _addSeat)
  let heroIdx = 0, witchIdx = 0;
  for (const p of state.players) {
    const colors = p.faction === 'hero' ? HERO_PLAYER_COLORS : WITCH_PLAYER_COLORS;
    const idx    = p.faction === 'hero' ? heroIdx++ : witchIdx++;
    const leader = state.entities.find(e => e.id === p.leaderId);
    if (leader) leader.color = colors[idx % colors.length];
  }

  // Stub factions: re-stat every leader on a side that picked a non-default
  // faction. swapLeaderToFaction handles state.hero / state.witch (the side
  // singletons); for extra players we apply the same in-place mutation
  // pattern manually so all leaders on a side share the picked stats.
  if (_STUB_DAY)   _applyStubToSide(state, 'day',   DAY_FACTION);
  if (_STUB_NIGHT) _applyStubToSide(state, 'night', NIGHT_FACTION);

  return state;
}

/** Apply a stub faction's stats to every leader on a side. */
function _applyStubToSide(state, sideId, factionId) {
  const def = getFaction(factionId);
  // The side singleton hero/witch first — same path the lobby and offline
  // init() use.
  state.swapLeaderToFaction(sideId, factionId);

  // Then mutate any extra-seat leaders on the same side.
  const sideOwner = sideId === 'day' ? 'hero' : 'witch';
  const sidePrimaryType = getFactionsForSide(sideId)[0].leaderType;
  for (const e of state.entities) {
    if (!e.alive || e.owner !== sideOwner) continue;
    if (e.type !== sidePrimaryType) continue; // already swapped or not a leader
    if (e === state.hero || e === state.witch) continue; // singleton already handled
    const fresh = def.createLeader(e.col, e.row, e.ownerId, state);
    e.type      = fresh.type;
    e.maxHp     = fresh.maxHp;
    e.hp        = fresh.maxHp;
    e.attack    = fresh.attack;
    e.defense   = fresh.defense;
    e.agility   = fresh.agility;
    e.factionId = fresh.factionId;
    e.name      = null; // let displayName fall through to the new type default
  }
}

// ── Ally context helpers (MP planning) ────────────────────────────────────────

function buildAllyContext() {
  return { claimedNodes: new Set(), allyPositions: [] };
}

function updateAllyContext(ctx, plan, leader) {
  if (leader) ctx.allyPositions.push({ col: leader.col, row: leader.row });
}

// ── Per-round step: generate plans and resolve ────────────────────────────────

function playRound(state, playerAIs, trainingExamples = null) {
  state.startPlanning();

  const heroCtx  = buildAllyContext();
  const witchCtx = buildAllyContext();
  const playerEntries = [];
  const ordered = [
    ...state.players.filter(p => p.faction === 'hero'),
    ...state.players.filter(p => p.faction === 'witch'),
  ];

  // ── Plan generation (timed) ───────────────────────────────────────────────
  const planGenStart = performance.now();
  for (const p of ordered) {
    // Battle mode: skip dead players (auto-readied by startPlanning)
    if (state.playerReady.get(p.id)) continue;

    // Capture pre-plan state for training data (before plan changes any projections)
    const statePrompt = trainingExamples ? serializeGameStateForLLM(state, p.faction) : null;

    const ai  = playerAIs.get(p.id);
    const ctx = p.faction === 'hero' ? heroCtx : witchCtx;
    const leader = state.entities.find(e => e.alive && e.ownerId === p.id &&
      (e.type === EntityType.PALADIN || e.type === EntityType.WITCH));
    const plan = ai.generatePlan(IS_MP ? ctx : undefined);
    updateAllyContext(ctx, plan, leader);
    state.submitPlayerPlan(p.id, plan);
    playerEntries.push({ playerId: p.id, faction: p.faction, plan });

    // Store training example (winner/total_rounds filled in after game ends)
    if (trainingExamples && plan.length > 0) {
      trainingExamples.push({
        prompt: statePrompt,
        completion: serializePlanForLLM(plan, state),
        metadata: {
          round: state.round,
          faction: p.faction,
          phase: state.phase,
          budget: state.playerActionsLeft.get(p.id) ?? 0,
          actions: plan.length,
        },
      });
    }
  }
  const planGenMs = performance.now() - planGenStart;

  // ── Resolution (timed) ────────────────────────────────────────────────────
  const resolveStart = performance.now();
  let steps;
  try {
    steps = resolvePlansMP(state, playerEntries);
  } catch (err) {
    console.error(`Round ${state.round} resolution error:`, err.message);
    steps = [];
  }
  const resolveMs = performance.now() - resolveStart;

  // ── Measure payload size (serialized state + steps = what the server sends) ─
  const payloadBytes = Buffer.byteLength(JSON.stringify(steps), 'utf8');
  const stateBytes   = Buffer.byteLength(JSON.stringify(serializeState(state)), 'utf8');

  state.endRound();
  return { steps, planGenMs, resolveMs, payloadBytes, stateBytes, totalPlans: playerEntries.length };
}

// ── Per-game runner ───────────────────────────────────────────────────────────

function runGame() {
  const state = buildGameState();

  const playerAIs = new Map();
  for (const p of state.players) {
    const AIClass = p.faction === 'hero' ? HeroAIEngine : WitchAIEngine;
    playerAIs.set(p.id, new AIClass(state, () => {}, 0, IS_MP ? p.id : undefined));
  }

  const metrics = {
    actionCounts: {},
    battlesHero: 0, battlesWitch: 0,
    killsByHero: 0, killsByWitch: 0,
    exploresHero: 0, exploresWitch: 0,
    found: { wood:0, metal:0, herbs:0, food:0, silver:0, scripture:0, weapons:0, horses:0, nothing:0 },
    foodConsumedHero: 0, foodConsumedWitch: 0,
    summons: 0, fortifies: 0,
    peakSurvivors: 0, peakMinions: 0,
    leaderDeaths: { hero: 0, witch: 0 },
    firstBattleRound: null,  // round when first battle action occurs
    // Per-node tracking: how many rounds each node was held by each faction
    nodeHistory:     [],    // populated at end of game
    // Performance metrics (per-round arrays)
    planGenTimes:    [],   // ms to generate all plans for a round
    resolveTimes:    [],   // ms to resolve all plans for a round
    stepsPayloads:   [],   // bytes: JSON-serialized resolution steps
    statePayloads:   [],   // bytes: JSON-serialized full state snapshot
    peakEntities:    0,    // max entity count observed
  };

  function analyseEvents(events, faction) {
    for (const ev of events) {
      if (ev.type !== ResEventType.ACTION_OK) continue;
      const { action, result } = ev;

      metrics.actionCounts[action.type] = (metrics.actionCounts[action.type] ?? 0) + 1;

      switch (action.type) {
        case PlanActionType.BATTLE_UNIT:
        case PlanActionType.BATTLE_HEX:
          if (faction === 'hero') metrics.battlesHero++; else metrics.battlesWitch++;
          if (result?.killed) {
            if (faction === 'hero') metrics.killsByHero++; else metrics.killsByWitch++;
          }
          if (metrics.firstBattleRound === null) metrics.firstBattleRound = state.round;
          break;

        case PlanActionType.EXPLORE: {
          if (faction === 'hero') metrics.exploresHero++; else metrics.exploresWitch++;
          const log = (result?.log ?? []).join(' ').toLowerCase();
          const enc = (result?.encounterLog ?? []).join(' ').toLowerCase();
          const txt = log + ' ' + enc;
          if (txt.includes('nothing') || txt.includes('empty'))  metrics.found.nothing++;
          else if (txt.includes('wood'))      metrics.found.wood++;
          else if (txt.includes('metal'))     metrics.found.metal++;
          else if (txt.includes('herbs'))     metrics.found.herbs++;
          else if (txt.includes('food'))      metrics.found.food++;
          else if (txt.includes('silver'))    metrics.found.silver++;
          else if (txt.includes('scripture')) metrics.found.scripture++;
          else if (txt.match(/sword|axe|bow|staff|dagger|shield/)) metrics.found.weapons++;
          else if (txt.includes('horse'))     metrics.found.horses++;
          break;
        }

        case PlanActionType.SUMMON:  metrics.summons++;  break;
        case PlanActionType.FORTIFY: metrics.fortifies++; break;
        default: break;
      }

      const logTxt = (result?.log ?? []).join(' ');
      if (logTxt.includes('Rations consumed')) {
        if (faction === 'hero') metrics.foodConsumedHero++; else metrics.foodConsumedWitch++;
      }
    }
  }

  const nodeRoundCtrl = {};  // nodeIndex → { hero, witch, neutral, contested, firstContested }
  const trainingExamples = TRAINING_DATA_FILE ? [] : null;

  while (!state.gameOver && state.round <= MAX_ROUNDS) {
    const roundResult = playRound(state, playerAIs, trainingExamples);

    // Collect performance metrics
    metrics.planGenTimes.push(roundResult.planGenMs);
    metrics.resolveTimes.push(roundResult.resolveMs);
    metrics.stepsPayloads.push(roundResult.payloadBytes);
    metrics.statePayloads.push(roundResult.stateBytes);

    for (const step of roundResult.steps) {
      for (const pe of (step.playerEvents ?? [])) {
        analyseEvents(pe.events ?? [], pe.faction);
      }
    }

    // Ecology snapshot
    const entityCount = state.entities.filter(e => e.alive).length;
    if (entityCount > metrics.peakEntities) metrics.peakEntities = entityCount;
    const surv = state.entities.filter(e => e.alive && e.type === 'survivor').length;
    const mini = state.entities.filter(e => e.alive && e.owner === 'witch' && e.type !== 'witch').length;
    if (surv > metrics.peakSurvivors) metrics.peakSurvivors = surv;
    if (mini > metrics.peakMinions)   metrics.peakMinions   = mini;

    // Node control snapshot
    for (let ni = 0; ni < state.witchObjectives.length; ni++) {
      if (!nodeRoundCtrl[ni]) nodeRoundCtrl[ni] = { hero: 0, witch: 0, neutral: 0, contested: 0, firstContested: null };
      const ctrl = nodeController(state.witchObjectives[ni], state.entities);
      nodeRoundCtrl[ni][ctrl]++;
      if (ctrl !== 'neutral' && nodeRoundCtrl[ni].firstContested === null) {
        nodeRoundCtrl[ni].firstContested = state.round;
      }
    }
  }

  // Store node history
  metrics.nodeHistory = Object.values(nodeRoundCtrl);

  // Count leader deaths (MP)
  if (IS_MP) {
    for (const p of state.players) {
      const leaderAlive = state.entities.some(e => e.id === p.leaderId && e.alive);
      if (!leaderAlive) {
        if (p.faction === 'hero') metrics.leaderDeaths.hero++;
        else                      metrics.leaderDeaths.witch++;
      }
    }
  }

  // Tiebreak
  let winner    = state.winner;
  let winReason = state.winReason;

  if (!winner) {
    const ws = state.nodeScore.witch;
    const hs = state.nodeScore.hero;
    if (ws !== hs) {
      winner    = ws > hs ? 'witch' : 'hero';
      winReason = `score tiebreak (Witch ${ws}–Hero ${hs})`;
    } else {
      const wn = state.witchObjectives.filter(o =>
        state.entities.some(e => e.alive && e.owner === 'witch' && e.col === o.col && e.row === o.row)
      ).length;
      const hn = state.witchObjectives.filter(o =>
        state.entities.some(e => e.alive && e.owner === 'hero'  && e.col === o.col && e.row === o.row)
      ).length;
      if (wn !== hn) {
        winner    = wn > hn ? 'witch' : 'hero';
        winReason = `node majority tiebreak (W${wn}–H${hn})`;
      } else {
        winner    = 'draw';
        winReason = `draw at cap (nodes ${wn}–${hn}, score ${ws}–${hs})`;
      }
    }
  }

  // Record to DB if available
  if (recordGameStats && winner !== 'draw') {
    try {
      recordGameStats({
        id:                randomUUID(),
        mode:              'headless',
        map_size:          MAP_SIZE,
        winner,
        win_reason:        winReason,
        rounds:            state.round,
        final_phase:       state.phase,
        hero_score:        state.nodeScore?.hero  || 0,
        witch_score:       state.nodeScore?.witch || 0,
        hero_kills:        state.heroKills  || 0,
        witch_kills:       state.witchKills || 0,
        hero_survivors:    state.entities.filter(e => e.owner === 'hero' && e.type === 'survivor').length,
        witch_summons:     state.witchSummonCount || 0,
        hero_personality:  null,
        witch_personality: null,
        hero_player_id:    null,
        witch_player_id:   null,
        game_version:      VERSION,
        fog_of_war:        0,
        duration_ms:       null,
      });
    } catch { /* non-critical — skip */ }
  }

  // Write training data examples for this game
  if (trainingExamples && trainingExamples.length > 0) {
    const gameId = randomUUID();
    for (const ex of trainingExamples) {
      ex.metadata.game_id = gameId;
      ex.metadata.winner = winner;
      ex.metadata.total_rounds = state.round;
      fs.appendFileSync(TRAINING_DATA_FILE, JSON.stringify(ex) + '\n');
    }
  }

  return {
    winner, winReason,
    rounds: state.round,
    heroHp: state.hero?.hp ?? 0,
    witchHp: state.witch?.hp ?? 0,
    nodeScore: { ...state.nodeScore },
    metrics,
    hitCap: state.round > MAX_ROUNDS,
  };
}

// ── Render mode ───────────────────────────────────────────────────────────────

if (RENDER_MODE) {
  const { renderGameState, loadTilemap } = await import('./game-render.js');
  const { createCanvas, loadImage } = await import('canvas');
  const { default: GIFEncoder } = await import('gif-encoder-2');

  await loadTilemap(path.join(__dirname, '..', 'assets', 'tilemap.png'));

  console.log(`\nBrimstone render — ${label} — cap=${MAX_ROUNDS}r\n`);

  const state = buildGameState();
  const playerAIs = new Map();
  for (const p of state.players) {
    const AIClass = p.faction === 'hero' ? HeroAIEngine : WitchAIEngine;
    playerAIs.set(p.id, new AIClass(state, () => {}, 0, IS_MP ? p.id : undefined));
  }

  const frames = [];
  frames.push(renderGameState(state, { chronicle: [...state.log] }));

  while (!state.gameOver && state.round <= MAX_ROUNDS) {
    const logBefore = state.log.length;
    playRound(state, playerAIs);  // ignore perf metrics in render mode
    const roundLog = state.log.slice(logBefore);
    frames.push(renderGameState(state, { chronicle: roundLog }));
    process.stdout.write(`  Round ${state.round}… \r`);
  }

  // Final frame — hold longer
  const lastLog = state.log.slice(-15);
  frames.push(renderGameState(state, { chronicle: lastLog }));

  console.log(`\n  ${frames.length} frames captured. Encoding GIF…`);

  const firstImg = await loadImage(frames[0]);
  const w = firstImg.width;
  const h = firstImg.height;

  const encoder = new GIFEncoder(w, h);
  encoder.setDelay(800);
  encoder.setRepeat(0);
  encoder.setQuality(10);
  encoder.start();

  for (let i = 0; i < frames.length; i++) {
    if (i === frames.length - 1) encoder.setDelay(3000);
    const img    = await loadImage(frames[i]);
    const canvas = createCanvas(w, h);
    const ctx    = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);
    encoder.addFrame(ctx);
  }

  encoder.finish();

  fs.mkdirSync(path.dirname(RENDER_OUT), { recursive: true });
  fs.writeFileSync(RENDER_OUT, encoder.out.getData());
  console.log(`  GIF saved → ${RENDER_OUT}  (${(fs.statSync(RENDER_OUT).size / 1024).toFixed(0)} KB)\n`);

  process.exit(0);
}

// ── Stat helpers ──────────────────────────────────────────────────────────────

function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function median(sorted) {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}
function pct(n, total) { return total ? (n / total * 100).toFixed(1) : '0.0'; }
function fmt(n, dp = 1) { return typeof n === 'number' ? n.toFixed(dp) : String(n); }
function bar(count, total, width = 22) {
  const filled = total ? Math.round((count / total) * width) : 0;
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}
function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil(sorted.length * p / 100) - 1)];
}

// ── Balance run ───────────────────────────────────────────────────────────────

console.log(`\nBrimstone headless — ${label} — ${N} games · cap=${MAX_ROUNDS}r…\n`);

const results = [];
const errors  = [];
const startMs = Date.now();

if (DAY_FACTION !== 'hero' || NIGHT_FACTION !== 'witch') {
  console.log(`  Factions: day=${DAY_FACTION}${_STUB_DAY ? ' (stub)' : ''}  night=${NIGHT_FACTION}${_STUB_NIGHT ? ' (stub)' : ''}`);
}
process.stdout.write('  Running ');
for (let i = 0; i < N; i++) {
  try {
    results.push(runGame());
  } catch (err) {
    errors.push({ game: i + 1, message: err.message, stack: err.stack });
    results.push({ winner: 'error', winReason: err.message, rounds: 0, nodeScore: {}, metrics: {}, hitCap: false });
  }
  if ((i + 1) % Math.max(1, Math.floor(N / 40)) === 0) process.stdout.write('█');
}
process.stdout.write('\n\n');

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

// ── Aggregate ─────────────────────────────────────────────────────────────────

const valid     = results.filter(r => r.winner !== 'error');
const nErrors   = results.length - valid.length;
const heroWins  = valid.filter(r => r.winner === 'hero').length;
const witchWins = valid.filter(r => r.winner === 'witch').length;
const draws     = valid.filter(r => r.winner === 'draw').length;

function classify(r) {
  const wr = r.winReason ?? '';
  if (wr === WIN_REASON.WITCH_SLAIN || wr === WIN_REASON.HERO_SLAIN) return 'kill';
  if (wr.includes('tiebreak') || wr.includes('draw') || wr.includes('majority')) return 'tiebreak';
  return 'nodes';
}
const killWins = valid.filter(r => classify(r) === 'kill').length;
const nodeWins = valid.filter(r => classify(r) === 'nodes').length;
const tieWins  = valid.filter(r => classify(r) === 'tiebreak').length;

const conditionCounts = {};
for (const r of valid) {
  const key = r.winReason ?? 'unknown';
  conditionCounts[key] = (conditionCounts[key] ?? 0) + 1;
}

const roundArr   = valid.map(r => r.rounds).sort((a, b) => a - b);
const meanRounds = avg(roundArr);
const medRounds  = median(roundArr);

function avgM(fn) { return avg(valid.map(fn)); }

const avgExploresHero  = avgM(r => r.metrics.exploresHero  ?? 0);
const avgExploresWitch = avgM(r => r.metrics.exploresWitch ?? 0);
const avgBattlesHero   = avgM(r => r.metrics.battlesHero   ?? 0);
const avgBattlesWitch  = avgM(r => r.metrics.battlesWitch  ?? 0);
const avgKillsHero     = avgM(r => r.metrics.killsByHero   ?? 0);
const avgKillsWitch    = avgM(r => r.metrics.killsByWitch  ?? 0);
const avgSummons       = avgM(r => r.metrics.summons       ?? 0);
const avgFortifies     = avgM(r => r.metrics.fortifies     ?? 0);
const avgPeakSurv      = avgM(r => r.metrics.peakSurvivors ?? 0);
const avgPeakMini      = avgM(r => r.metrics.peakMinions   ?? 0);
const avgFoodH         = avgM(r => r.metrics.foodConsumedHero  ?? 0);
const avgFoodW         = avgM(r => r.metrics.foodConsumedWitch ?? 0);

const resKeys  = ['wood','metal','herbs','food','silver','scripture','weapons','horses','nothing'];
const avgFound = {};
for (const k of resKeys) avgFound[k] = avgM(r => r.metrics.found?.[k] ?? 0);

const actTypeTotals = {};
for (const r of valid) {
  for (const [type, n] of Object.entries(r.metrics.actionCounts ?? {})) {
    actTypeTotals[type] = (actTypeTotals[type] ?? 0) + n;
  }
}
const totalActions = Object.values(actTypeTotals).reduce((s, v) => s + v, 0);

const bucketSize = 5;
const buckets = {};
for (const r of roundArr) {
  const b = Math.floor(r / bucketSize) * bucketSize;
  buckets[b] = (buckets[b] ?? 0) + 1;
}
const bucketKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);

// ── Performance metrics aggregation ──────────────────────────────────────────

// Flatten all per-round arrays across games
const allPlanGenMs   = valid.flatMap(r => r.metrics.planGenTimes  ?? []);
const allResolveMs   = valid.flatMap(r => r.metrics.resolveTimes  ?? []);
const allStepsBytes  = valid.flatMap(r => r.metrics.stepsPayloads ?? []);
const allStateBytes  = valid.flatMap(r => r.metrics.statePayloads ?? []);
const allPeakEnts    = valid.map(r => r.metrics.peakEntities ?? 0);

function sortedCopy(arr) { return [...arr].sort((a, b) => a - b); }

const planGenSorted   = sortedCopy(allPlanGenMs);
const resolveSorted   = sortedCopy(allResolveMs);
const stepsBytesSorted = sortedCopy(allStepsBytes);
const stateBytesSorted = sortedCopy(allStateBytes);

function fmtKB(bytes) { return (bytes / 1024).toFixed(1); }

// ── Report ────────────────────────────────────────────────────────────────────

const W    = 66;
const line = '─'.repeat(W);
const row  = s => `║ ${s.padEnd(W - 2)} ║`;
const hdr  = s => { console.log(`╠${line}╣`); console.log(row(s)); };

console.log(`╔${line}╗`);
console.log(row(`BRIMSTONE BALANCE REPORT — ${label} — ${N} games · ${elapsed}s · cap=${MAX_ROUNDS}r`));

if (nErrors > 0) {
  hdr('ERRORS');
  console.log(row(`  ⚠ ${nErrors} game(s) crashed`));
  for (const e of errors.slice(0, 3)) {
    console.log(row(`  Game ${e.game}: ${e.message.slice(0, 55)}`));
  }
}

hdr('WIN RATES');
console.log(row(` Hero  ${bar(heroWins,  valid.length)}  ${String(heroWins).padStart(4)}  (${pct(heroWins,  valid.length)}%)`));
console.log(row(` Witch ${bar(witchWins, valid.length)}  ${String(witchWins).padStart(4)}  (${pct(witchWins, valid.length)}%)`));
if (draws > 0)
  console.log(row(` Draw  ${bar(draws, valid.length)}  ${String(draws).padStart(4)}  (${pct(draws, valid.length)}%)`));

hdr('WIN CONDITION MIX');
console.log(row(` By kill  ${bar(killWins, valid.length)}  ${String(killWins).padStart(4)}  (${pct(killWins, valid.length)}%)`));
console.log(row(` By nodes ${bar(nodeWins, valid.length)}  ${String(nodeWins).padStart(4)}  (${pct(nodeWins, valid.length)}%)`));
console.log(row(` Tiebreak ${bar(tieWins,  valid.length)}  ${String(tieWins).padStart(4)}  (${pct(tieWins,  valid.length)}%)`));

hdr('WIN REASON DETAIL');
const winLabels = {
  [WIN_REASON.WITCH_SLAIN]:      'Hero kills witch         ',
  [WIN_REASON.HERO_SLAIN]:       'Witch kills hero         ',
  [WIN_REASON.NODES_WITCH]:      'Witch sweeps nodes (dawn)',
  [WIN_REASON.NODES_HERO]:       'Hero sweeps nodes (dawn) ',
  [WIN_REASON.NODES_WITCH_DUSK]: 'Witch sweeps nodes (dusk)',
  [WIN_REASON.NODES_HERO_DUSK]:  'Hero sweeps nodes (dusk) ',
  [WIN_REASON.SCORE_WITCH]:      'Witch 3-point score      ',
  [WIN_REASON.SCORE_HERO]:       'Hero 3-point score       ',
};
for (const [reason, count] of Object.entries(conditionCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
  const rlabel = winLabels[reason] ?? reason.slice(0, 25).padEnd(25);
  console.log(row(` ${rlabel}  ${bar(count, valid.length, 16)}  ${String(count).padStart(4)}  (${pct(count, valid.length)}%)`));
}

hdr('GAME LENGTH (rounds)');
if (roundArr.length > 0) {
  console.log(row(`  Mean ${fmt(meanRounds)}  /  Median ${medRounds}  /  Min ${roundArr[0]}  /  Max ${roundArr[roundArr.length-1]}`));
  console.log(row(`  p25=${percentile(roundArr,25)}  p50=${percentile(roundArr,50)}  p75=${percentile(roundArr,75)}  p95=${percentile(roundArr,95)}`));
  console.log(row(`  Games hitting round cap (${MAX_ROUNDS}): ${valid.filter(r=>r.hitCap).length}  (${pct(valid.filter(r=>r.hitCap).length, valid.length)}%)`));
}

hdr(`LENGTH HISTOGRAM  (bucket=${bucketSize}r)`);
for (const b of bucketKeys) {
  const count = buckets[b];
  const blabel = `${String(b).padStart(3)}–${String(b + bucketSize - 1).padStart(3)}`;
  const filled = Math.round((count / valid.length) * 28);
  console.log(row(`  ${blabel}  ${'█'.repeat(filled)}${'░'.repeat(28 - filled)}  ${pct(count, valid.length).padStart(5)}%`));
}

// Multi-leader mortality (MP only)
if (IS_MP) {
  hdr('MULTI-LEADER MORTALITY (avg per game)');
  const avgHD = avg(valid.map(r => r.metrics.leaderDeaths?.hero  ?? 0));
  const avgWD = avg(valid.map(r => r.metrics.leaderDeaths?.witch ?? 0));
  console.log(row(`  Hero  leaders dead at end: ${fmt(avgHD)}  / ${PER_SIDE}  (${pct(avgHD, PER_SIDE)}%)`));
  console.log(row(`  Witch leaders dead at end: ${fmt(avgWD)}  / ${PER_SIDE}  (${pct(avgWD, PER_SIDE)}%)`));
}

hdr('COMBAT (avg per game)');
console.log(row(`  Hero battles   ${fmt(avgBattlesHero)}   kills ${fmt(avgKillsHero)}`));
console.log(row(`  Witch battles  ${fmt(avgBattlesWitch)}   kills ${fmt(avgKillsWitch)}`));
console.log(row(`  Total battles  ${fmt(avgBattlesHero + avgBattlesWitch)}   total kills ${fmt(avgKillsHero + avgKillsWitch)}`));
console.log(row(`  Avg hero HP at end:   ${fmt(avg(valid.map(r => r.heroHp)))}`));
console.log(row(`  Avg witch HP at end:  ${fmt(avg(valid.map(r => r.witchHp)))}`));

// First battle timing
const firstBattleRounds = valid.map(r => r.metrics.firstBattleRound).filter(r => r !== null);
if (firstBattleRounds.length > 0) {
  const fbSorted = [...firstBattleRounds].sort((a, b) => a - b);
  console.log(row(`  First battle on round: mean ${fmt(avg(firstBattleRounds))}  median ${median(fbSorted)}  min ${fbSorted[0]}  max ${fbSorted[fbSorted.length-1]}`));
  const neverFought = valid.length - firstBattleRounds.length;
  if (neverFought > 0) console.log(row(`  Games with zero battles: ${neverFought}`));
}

// Node contestation
{
  const nodeCount = valid[0]?.metrics.nodeHistory?.length ?? 0;
  if (nodeCount > 0) {
    hdr(`NODE CONTESTATION  (${nodeCount} nodes)`);
    // Per-node: what % of rounds was it held by hero/witch/neutral/contested
    const avgNodeStats = [];
    for (let ni = 0; ni < nodeCount; ni++) {
      const stats = { hero: [], witch: [], neutral: [], contested: [], firstContested: [] };
      for (const r of valid) {
        const nh = r.metrics.nodeHistory?.[ni];
        if (!nh) continue;
        const total = nh.hero + nh.witch + nh.neutral + nh.contested;
        if (total === 0) continue;
        stats.hero.push(nh.hero / total);
        stats.witch.push(nh.witch / total);
        stats.neutral.push(nh.neutral / total);
        stats.contested.push(nh.contested / total);
        if (nh.firstContested !== null) stats.firstContested.push(nh.firstContested);
      }
      avgNodeStats.push({
        hero:      avg(stats.hero),
        witch:     avg(stats.witch),
        neutral:   avg(stats.neutral),
        contested: avg(stats.contested),
        avgFirstContested: stats.firstContested.length ? avg(stats.firstContested) : null,
        everContested: stats.firstContested.length / valid.length,
      });
    }

    for (let ni = 0; ni < nodeCount; ni++) {
      const s = avgNodeStats[ni];
      const fc = s.avgFirstContested !== null ? `first reached r${Math.round(s.avgFirstContested)}` : 'never reached';
      console.log(row(`  Node ${ni + 1}: hero ${pct(s.hero,1)}%  witch ${pct(s.witch,1)}%  neutral ${pct(s.neutral,1)}%  contested ${pct(s.contested,1)}%`));
      console.log(row(`         ${fc} · reached in ${pct(s.everContested,1)}% of games`));
    }

    // Summary: how many nodes see action
    const avgNodesReached = avg(valid.map(r => {
      return (r.metrics.nodeHistory ?? []).filter(nh => nh.firstContested !== null).length;
    }));
    const allNodesReached = valid.filter(r => {
      return (r.metrics.nodeHistory ?? []).every(nh => nh.firstContested !== null);
    }).length;
    console.log(row(``));
    console.log(row(`  Avg nodes reached per game: ${fmt(avgNodesReached)} / ${nodeCount}`));
    console.log(row(`  Games where ALL nodes reached: ${allNodesReached} / ${valid.length}  (${pct(allNodesReached, valid.length)}%)`));
  }
}

hdr('EXPLORATION (avg per game)');
console.log(row(`  Hero explores   ${fmt(avgExploresHero)}   Witch explores   ${fmt(avgExploresWitch)}`));

hdr('RESOURCES FOUND (avg per game)');
for (const k of resKeys.filter(k => k !== 'nothing')) {
  const a = avgFound[k];
  const filledN = Math.round(a * 3);
  console.log(row(`  ${k.padEnd(10)}  ${'█'.repeat(Math.min(filledN,28))}  ${fmt(a)}`));
}
console.log(row(`  nothing     ${fmt(avgFound.nothing)} (empty explores)`));

hdr('UNIT ECOLOGY (avg per game)');
console.log(row(`  Peak hero survivors   ${fmt(avgPeakSurv)}`));
console.log(row(`  Peak witch minions    ${fmt(avgPeakMini)}`));
console.log(row(`  Witch summons         ${fmt(avgSummons)}`));
console.log(row(`  Hero fortifies        ${fmt(avgFortifies)}`));

hdr('FOOD & OVER-BUDGET ACTIONS (avg per game)');
console.log(row(`  Hero food-powered extra actions   ${fmt(avgFoodH)}`));
console.log(row(`  Witch food-powered extra actions  ${fmt(avgFoodW)}`));

hdr('ACTION MIX (% of all actions)');
for (const [type, count] of Object.entries(actTypeTotals).sort((a, b) => b[1] - a[1])) {
  if (!count) continue;
  const filledN = Math.round((count / totalActions) * 28);
  console.log(row(`  ${type.padEnd(14)}  ${'█'.repeat(filledN)}${'░'.repeat(28-filledN)}  ${pct(count, totalActions)}%`));
}

// ── Performance metrics ──────────────────────────────────────────────────────

if (planGenSorted.length > 0) {
  hdr(`TURN PROCESSING TIME  (${allPlanGenMs.length} rounds across ${valid.length} games)`);
  console.log(row(`  Plan generation (${TOTAL_PLAYERS} AI plans per round):`));
  console.log(row(`    Mean ${fmt(avg(allPlanGenMs))}ms  Median ${fmt(median(planGenSorted))}ms  p95 ${fmt(percentile(planGenSorted,95))}ms  Max ${fmt(planGenSorted[planGenSorted.length-1])}ms`));
  console.log(row(`  Resolution (lockstep execution):`));
  console.log(row(`    Mean ${fmt(avg(allResolveMs))}ms  Median ${fmt(median(resolveSorted))}ms  p95 ${fmt(percentile(resolveSorted,95))}ms  Max ${fmt(resolveSorted[resolveSorted.length-1])}ms`));
  const totalPerRound = allPlanGenMs.map((p, i) => p + allResolveMs[i]);
  const totalSorted = sortedCopy(totalPerRound);
  console.log(row(`  Total per round (plan + resolve):`));
  console.log(row(`    Mean ${fmt(avg(totalPerRound))}ms  Median ${fmt(median(totalSorted))}ms  p95 ${fmt(percentile(totalSorted,95))}ms  Max ${fmt(totalSorted[totalSorted.length-1])}ms`));

  hdr('ROUND PAYLOAD SIZE');
  console.log(row(`  Resolution steps (per round):`));
  console.log(row(`    Mean ${fmtKB(avg(allStepsBytes))} KB  Median ${fmtKB(median(stepsBytesSorted))} KB  p95 ${fmtKB(percentile(stepsBytesSorted,95))} KB  Max ${fmtKB(stepsBytesSorted[stepsBytesSorted.length-1])} KB`));
  console.log(row(`  Full state snapshot (per round):`));
  console.log(row(`    Mean ${fmtKB(avg(allStateBytes))} KB  Median ${fmtKB(median(stateBytesSorted))} KB  p95 ${fmtKB(percentile(stateBytesSorted,95))} KB  Max ${fmtKB(stateBytesSorted[stateBytesSorted.length-1])} KB`));
  const totalPayload = allStepsBytes.map((s, i) => s + allStateBytes[i]);
  const totalPayloadSorted = sortedCopy(totalPayload);
  console.log(row(`  Combined (steps + state):`));
  console.log(row(`    Mean ${fmtKB(avg(totalPayload))} KB  Median ${fmtKB(median(totalPayloadSorted))} KB  p95 ${fmtKB(percentile(totalPayloadSorted,95))} KB  Max ${fmtKB(totalPayloadSorted[totalPayloadSorted.length-1])} KB`));
  console.log(row(`  Peak live entities (across all games): ${Math.max(...allPeakEnts)}`));
}

// ── Balance analysis ──────────────────────────────────────────────────────────

hdr('BALANCE ANALYSIS');

const issues = [];
const suggestions = [];

if (nErrors > 0)
  issues.push(`⚠ ${nErrors} game(s) crashed (${pct(nErrors, N)}%)`);

if (valid.length >= 10) {
  const heroPctW  = heroWins / valid.length;
  const witchPctW = witchWins / valid.length;
  const tieRatio  = (tieWins + draws) / valid.length;

  if (Math.abs(heroPctW - witchPctW) > 0.12) {
    const favoured = heroPctW > witchPctW ? 'Hero' : 'Witch';
    const loser    = heroPctW > witchPctW ? 'Witch' : 'Hero';
    issues.push(`⚠ Win rate imbalanced: ${favoured} wins ${pct(Math.max(heroPctW,witchPctW)*valid.length,valid.length)}% vs ${loser} ${pct(Math.min(heroPctW,witchPctW)*valid.length,valid.length)}%`);
    if (heroPctW > witchPctW + 0.12) {
      suggestions.push('• Hero too strong: reduce hero base ATK, or reduce survivor action bonus');
      suggestions.push('• Or buff witch: lower minion threshold, or raise minion HP');
    } else {
      suggestions.push('• Witch too strong: reduce witch base actions, or increase summon cost');
      suggestions.push('• Or buff hero: increase hero base HP, or reduce fatigue');
    }
  }

  if (tieRatio > 0.10) {
    issues.push(`⚠ Too many tiebreaks: ${pct(tieRatio * valid.length, valid.length)}% (target <10%)`);
    suggestions.push('• Increase attrition or reduce MAX_ROUNDS');
  }

  if (killWins / valid.length < 0.20) {
    issues.push(`⚠ Too few kill victories: ${pct(killWins, valid.length)}% (want ≥20%)`);
    suggestions.push('• Lower HP pools or increase attack stats');
  }

  if (meanRounds < 15) {
    issues.push(`⚠ Games too short: mean ${fmt(meanRounds)} rounds`);
  }
  if (meanRounds > 35) {
    issues.push(`⚠ Games too long: mean ${fmt(meanRounds)} rounds`);
    suggestions.push('• Increase attrition damage or reduce round cap');
  }
}

if (issues.length === 0) {
  console.log(row('  ✓ Balance looks healthy within all targets.'));
} else {
  for (const issue of issues) console.log(row(`  ${issue}`));
  if (suggestions.length > 0) {
    console.log(row(''));
    console.log(row('  Suggestions:'));
    for (const s of suggestions) console.log(row(`    ${s}`));
  }
}

console.log(`╚${line}╝`);
console.log();
