#!/usr/bin/env node
/**
 * Headless N-player balance runner.
 *
 * Usage:
 *   node scripts/headless-mp.js [games] [playersPerSide]
 *
 * Examples:
 *   node scripts/headless-mp.js 100 1     → 2 total (1v1 standard baseline)
 *   node scripts/headless-mp.js 100 2     → 4 total (2v2)
 *   node scripts/headless-mp.js 100 3     → 6 total (3v3)
 *   node scripts/headless-mp.js 100 4     → 8 total (4v4)
 *
 * Each extra player beyond the first per faction is placed near their faction's
 * starting corner.  AIs generate plans scoped to their own entities (by ownerId),
 * using the faction AI as the oracle.  Resolution goes through resolvePlansMP()
 * so the full multiplayer code-path is exercised.
 */

import { GameState }       from '../src/game.js';
import { WitchAI, HeroAI } from '../src/ai.js';
import { resolvePlansMP, ResEventType } from '../server/resolver.js';
import { PlanActionType }  from '../src/planner.js';
import { generateMultipleStarts } from '../src/map.js';
import { randomUUID }      from 'crypto';

// ── CLI args ───────────────────────────────────────────────────────────────────
const N_GAMES       = parseInt(process.argv[2] ?? '200', 10);
const PER_SIDE      = parseInt(process.argv[3] ?? '1',  10);
if (isNaN(N_GAMES) || N_GAMES < 1) { console.error('Usage: node headless-mp.js [games] [playersPerSide]'); process.exit(1); }
if (PER_SIDE < 1 || PER_SIDE > 4)  { console.error('playersPerSide must be 1–4'); process.exit(1); }

const TOTAL_PLAYERS = PER_SIDE * 2;
const MAX_ROUNDS    = 48; // standard map cap

// ── Per-game runner ────────────────────────────────────────────────────────────

function buildMPState() {
  // Start from a fresh 2-player GameState (gives us a valid map + 2 base leaders).
  // We then patch the synthetic 'hero'/'witch' players into real-UUID players and
  // add extra players if PER_SIDE > 1.
  const state = new GameState(true, true); // both AI — we drive plans manually

  // Patch the two synthetic players to real UUIDs.
  const p0 = state.players[0]; // hero
  const p1 = state.players[1]; // witch
  const heroId0  = randomUUID();
  const witchId0 = randomUUID();
  p0.id = heroId0;  state.entities.find(e => e.id === p0.leaderId && e.owner === 'hero').ownerId  = heroId0;
  p1.id = witchId0; state.entities.find(e => e.id === p1.leaderId && e.owner === 'witch').ownerId = witchId0;
  // Fix leaderId refs (entity ids didn't change, only player id did)
  // They already match — entity id != player id.  The leader entity's ownerId is what matters.

  // Herostart / witchStart tiles
  const heroStart  = { col: state.hero.col,  row: state.hero.row  };
  const witchStart = { col: state.witch.col, row: state.witch.row };

  // Add extra heroes
  if (PER_SIDE > 1) {
    const heroPositions = generateMultipleStarts(state.tiles, heroStart, PER_SIDE, 2, 6);
    for (let i = 1; i < PER_SIDE; i++) {
      const pos = heroPositions[i] ?? heroStart;
      const pid = randomUUID();
      state.addPlayer(pid, `Hero${i + 1}`, 'hero', pos.col, pos.row, true);
    }
  }

  // Add extra witches
  if (PER_SIDE > 1) {
    const witchPositions = generateMultipleStarts(state.tiles, witchStart, PER_SIDE, 2, 6);
    for (let i = 1; i < PER_SIDE; i++) {
      const pos = witchPositions[i] ?? witchStart;
      const pid = randomUUID();
      state.addPlayer(pid, `Witch${i + 1}`, 'witch', pos.col, pos.row, true);
    }
  }

  return state;
}

/**
 * Given a faction AI oracle (HeroAI or WitchAI) and a specific playerId,
 * generate a plan scoped only to that player's entities.
 *
 * Strategy: let the oracle produce the full faction plan, then keep only
 * actions whose entityId belongs to this player's entities.
 */
function generateScopedPlan(ai, state, playerId) {
  // Temporarily expose the playerId filter on the state so the AI can work with it.
  const fullPlan = ai.generatePlan();

  const myIds = new Set(
    state.entities
      .filter(e => e.alive && e.ownerId === playerId)
      .map(e => e.id)
  );

  return fullPlan.filter(action => myIds.has(action.entityId));
}

// ── Main game loop ─────────────────────────────────────────────────────────────

function runGame() {
  const state = buildMPState();

  // Create one AI oracle per faction (they read the full faction state).
  // For multiple players of the same faction, they all share the oracle — plans
  // are then scoped to each player's own entities.
  const heroOracle  = new HeroAI(state,  () => {}, 0);
  const witchOracle = new WitchAI(state, () => {}, 0);

  const metrics = {
    actionCounts: {},
    battlesHero: 0, battlesWitch: 0,
    killsByHero: 0, killsByWitch: 0,
    summons: 0, fortifies: 0,
    peakSurvivors: 0, peakMinions: 0,
    leaderDeaths: { hero: 0, witch: 0 },
    budgetByPlayer: {}, // playerId → total budget spent
  };

  function analyseEvents(playerEvents) {
    for (const pe of (playerEvents ?? [])) {
      const { playerId, faction, events } = pe;
      for (const ev of (events ?? [])) {
        if (ev.type !== ResEventType.ACTION_OK) continue;
        const { action, result } = ev;
        metrics.actionCounts[action.type] = (metrics.actionCounts[action.type] ?? 0) + 1;
        metrics.budgetByPlayer[playerId]  = (metrics.budgetByPlayer[playerId]  ?? 0) + 1;

        switch (action.type) {
          case PlanActionType.BATTLE_UNIT:
          case PlanActionType.BATTLE_HEX:
            if (faction === 'hero') metrics.battlesHero++; else metrics.battlesWitch++;
            if (result?.killed) {
              if (faction === 'hero') metrics.killsByHero++; else metrics.killsByWitch++;
            }
            break;
          case PlanActionType.SUMMON:   metrics.summons++;   break;
          case PlanActionType.FORTIFY:  metrics.fortifies++; break;
        }
      }
    }
  }

  // Track how many leaders were alive at start
  const initialHeroLeaders  = state.players.filter(p => p.faction === 'hero').length;
  const initialWitchLeaders = state.players.filter(p => p.faction === 'witch').length;

  while (!state.gameOver && state.round <= MAX_ROUNDS) {
    state.startPlanning();

    // Build per-player plans
    const playerEntries = [];
    for (const p of state.players) {
      const oracle = p.faction === 'hero' ? heroOracle : witchOracle;
      const plan   = generateScopedPlan(oracle, state, p.id);
      state.submitPlayerPlan(p.id, plan);
      playerEntries.push({ playerId: p.id, faction: p.faction, plan });
    }

    let steps;
    try {
      steps = resolvePlansMP(state, playerEntries);
    } catch (err) {
      console.error(`Round ${state.round} resolution error:`, err.message);
      steps = [];
    }

    for (const step of steps) analyseEvents(step.playerEvents ?? []);

    // Ecology snapshot
    const surv = state.entities.filter(e => e.alive && e.type === 'survivor').length;
    const mini = state.entities.filter(e => e.alive && e.owner === 'witch' && e.type !== 'witch').length;
    if (surv > metrics.peakSurvivors) metrics.peakSurvivors = surv;
    if (mini > metrics.peakMinions)   metrics.peakMinions   = mini;

    state.endRound();
  }

  // Count leader deaths
  for (const p of state.players) {
    const leaderAlive = state.entities.some(e => e.id === p.leaderId && e.alive);
    if (!leaderAlive) {
      if (p.faction === 'hero')  metrics.leaderDeaths.hero++;
      else                       metrics.leaderDeaths.witch++;
    }
  }

  let winner    = state.winner;
  let winReason = state.winReason;

  if (!winner) {
    const ws = state.nodeScore.witch, hs = state.nodeScore.hero;
    if (ws !== hs) {
      winner    = ws > hs ? 'witch' : 'hero';
      winReason = `score tiebreak (${ws}–${hs})`;
    } else {
      winner    = 'draw';
      winReason = `draw at cap`;
    }
  }

  return {
    winner, winReason,
    rounds: state.round,
    nodeScore: { ...state.nodeScore },
    metrics,
    hitCap: state.round > MAX_ROUNDS,
    // Did any non-primary leaders die?
    extraLeaderDeaths: metrics.leaderDeaths,
    initialHeroLeaders, initialWitchLeaders,
  };
}

// ── Run ─────────────────────────────────────────────────────────────────────────

const label = `${TOTAL_PLAYERS}-player (${PER_SIDE}v${PER_SIDE})`;
console.log(`\nBrimstone MP headless — ${label} — ${N_GAMES} games…\n`);

const results = [];
const errors  = [];
const startMs = Date.now();

process.stdout.write('  Running ');
for (let i = 0; i < N_GAMES; i++) {
  try {
    results.push(runGame());
  } catch (err) {
    errors.push({ game: i + 1, message: err.message, stack: err.stack });
    results.push({ winner: 'error', winReason: err.message, rounds: 0, nodeScore: {}, metrics: {}, hitCap: false });
  }
  if ((i + 1) % Math.max(1, Math.floor(N_GAMES / 40)) === 0) process.stdout.write('█');
}
process.stdout.write('\n\n');

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

// ── Aggregate ──────────────────────────────────────────────────────────────────

const valid   = results.filter(r => r.winner !== 'error');
const nErrors = results.length - valid.length;
const heroWins  = valid.filter(r => r.winner === 'hero').length;
const witchWins = valid.filter(r => r.winner === 'witch').length;
const draws     = valid.filter(r => r.winner === 'draw').length;

const roundArr  = valid.map(r => r.rounds).sort((a, b) => a - b);
function avg(arr) { return arr.length ? arr.reduce((a, v) => a + v, 0) / arr.length : 0; }
function med(sorted) {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[m - 1] + sorted[m]) / 2 : sorted[m];
}
function pct(n, t) { return t ? (n / t * 100).toFixed(1) : '0.0'; }
function fmt(n) { return typeof n === 'number' ? n.toFixed(1) : String(n); }
function bar(n, t, w = 24) {
  const f = t ? Math.round((n / t) * w) : 0;
  return '█'.repeat(f) + '░'.repeat(w - f);
}

const W    = 66;
const line = '─'.repeat(W);
const row  = s => `║ ${s.padEnd(W - 2)} ║`;
const hdr  = s => { console.log(`╠${line}╣`); console.log(row(s)); };

console.log(`╔${line}╗`);
console.log(row(`BRIMSTONE MP REPORT — ${label} — ${N_GAMES} games · ${elapsed}s`));

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

hdr('WIN REASONS (top 8)');
const reasons = {};
for (const r of valid) reasons[r.winReason ?? 'unknown'] = (reasons[r.winReason ?? 'unknown'] ?? 0) + 1;
for (const [reason, count] of Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(row(`  ${reason.slice(0, 35).padEnd(35)}  ${String(count).padStart(4)}  (${pct(count, valid.length)}%)`));
}

hdr('GAME LENGTH (rounds)');
if (roundArr.length > 0) {
  console.log(row(`  Mean ${fmt(avg(roundArr))}  /  Median ${med(roundArr)}  /  Min ${roundArr[0]}  /  Max ${roundArr[roundArr.length - 1]}`));
  console.log(row(`  Games hitting cap (${MAX_ROUNDS}): ${valid.filter(r => r.hitCap).length}  (${pct(valid.filter(r => r.hitCap).length, valid.length)}%)`));
}

hdr('MULTI-LEADER MORTALITY (avg per game)');
const avgHeroDeaths  = avg(valid.map(r => r.extraLeaderDeaths?.hero  ?? 0));
const avgWitchDeaths = avg(valid.map(r => r.extraLeaderDeaths?.witch ?? 0));
console.log(row(`  Hero  leaders dead at end: ${fmt(avgHeroDeaths)}  / ${PER_SIDE}  (${pct(avgHeroDeaths, PER_SIDE)}%)`));
console.log(row(`  Witch leaders dead at end: ${fmt(avgWitchDeaths)}  / ${PER_SIDE}  (${pct(avgWitchDeaths, PER_SIDE)}%)`));

hdr('COMBAT (avg per game)');
const avgBH = avg(valid.map(r => r.metrics.battlesHero  ?? 0));
const avgBW = avg(valid.map(r => r.metrics.battlesWitch ?? 0));
const avgKH = avg(valid.map(r => r.metrics.killsByHero  ?? 0));
const avgKW = avg(valid.map(r => r.metrics.killsByWitch ?? 0));
console.log(row(`  Hero battles   ${fmt(avgBH)}   kills ${fmt(avgKH)}`));
console.log(row(`  Witch battles  ${fmt(avgBW)}   kills ${fmt(avgKW)}`));

hdr('UNIT ECOLOGY (avg per game)');
console.log(row(`  Peak survivors   ${fmt(avg(valid.map(r => r.metrics.peakSurvivors ?? 0)))}`));
console.log(row(`  Peak witch units ${fmt(avg(valid.map(r => r.metrics.peakMinions   ?? 0)))}`));
console.log(row(`  Summons          ${fmt(avg(valid.map(r => r.metrics.summons       ?? 0)))}`));
console.log(row(`  Fortifies        ${fmt(avg(valid.map(r => r.metrics.fortifies     ?? 0)))}`));

hdr('ACTION MIX (% of all actions)');
const totalActs = Object.values(valid.reduce((acc, r) => {
  for (const [k, v] of Object.entries(r.metrics.actionCounts ?? {})) acc[k] = (acc[k] ?? 0) + v;
  return acc;
}, {})).reduce((s, v) => s + v, 0);
const actTotals = valid.reduce((acc, r) => {
  for (const [k, v] of Object.entries(r.metrics.actionCounts ?? {})) acc[k] = (acc[k] ?? 0) + v;
  return acc;
}, {});
for (const [type, count] of Object.entries(actTotals).sort((a, b) => b[1] - a[1])) {
  const f = totalActs ? Math.round((count / totalActs) * 24) : 0;
  console.log(row(`  ${type.padEnd(16)}  ${'█'.repeat(f)}${'░'.repeat(24 - f)}  ${pct(count, totalActs)}%`));
}

hdr('BALANCE ANALYSIS');
const issues = [];
if (nErrors > 0)
  issues.push(`⚠ ${nErrors} game(s) crashed (${pct(nErrors, N_GAMES)}%) — check stack traces above`);
if (valid.length > 10) {
  const hw = heroWins / valid.length, ww = witchWins / valid.length;
  if (Math.abs(hw - ww) > 0.12)
    issues.push(`⚠ Win rate skew: Hero ${pct(heroWins, valid.length)}% vs Witch ${pct(witchWins, valid.length)}%`);
  if (avg(roundArr) < 10)
    issues.push(`⚠ Games very short (avg ${fmt(avg(roundArr))}r) — extra leaders may be colliding`);
  if (avg(roundArr) > 35)
    issues.push(`⚠ Games very long (avg ${fmt(avg(roundArr))}r) — extra leaders may dilute aggression`);
  if (valid.filter(r => r.hitCap).length / valid.length > 0.15)
    issues.push(`⚠ ${pct(valid.filter(r => r.hitCap).length, valid.length)}% of games hit the round cap`);
}
if (issues.length === 0) {
  console.log(row('  ✓ No stability or balance issues detected.'));
} else {
  for (const issue of issues) console.log(row(`  ${issue}`));
}

console.log(`╚${line}╝`);
console.log();
