#!/usr/bin/env node
// Headless game runner — plays N AI vs AI games and reports balance stats.
// Usage:  node scripts/headless.js [count] [size]   (defaults: 200, standard)
// Sizes:  skirmish | standard | regional | campaign
//
// Uses the simultaneous planning model: generatePlan() + resolvePlans() + endRound(),
// matching the actual local-vs-AI game loop exactly.

import { GameState, WIN_REASON } from '../src/game.js';
import { HeroAI }                from '../src/ai.js';
import { WitchAIEngine }        from '../src/ai-engine.js';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { PlanActionType }         from '../src/planner.js';
import { MAP_SIZES }              from '../src/map.js';
import { VERSION }                from '../src/version.js';
import { randomUUID }             from 'crypto';

// Optional: record stats to DB if available (fails silently if DB module not loadable)
let recordGameStats = null;
try {
  const mod = await import('../server/game-stats.js');
  recordGameStats = mod.recordGameStats;
} catch { /* running without server deps — skip stats recording */ }

const N       = parseInt(process.argv[2] ?? '200', 10);
const MAP_SIZE = process.argv[3] ?? 'standard';
if (isNaN(N) || N < 1) { console.error('Usage: node scripts/headless.js [count] [size]'); process.exit(1); }
if (!MAP_SIZES[MAP_SIZE]) {
  console.error(`Unknown map size "${MAP_SIZE}". Valid: ${Object.keys(MAP_SIZES).join(', ')}`);
  process.exit(1);
}

// Round cap scales with map area relative to standard (13×11=143)
const { cols, rows } = MAP_SIZES[MAP_SIZE];
const MAX_ROUNDS = Math.ceil(48 * (cols * rows) / (13 * 11));

// ── Per-game runner ────────────────────────────────────────────────────────────

function runGame() {
  const state   = new GameState(true, true, MAP_SIZE);
  const witchAI = new WitchAIEngine(state, () => {}, 0);
  const heroAI  = new HeroAI(state,  () => {}, 0);

  const metrics = {
    // Action-type tallies
    actionCounts: { hero: {}, witch: {} },
    // Combat
    battlesHero: 0, battlesWitch: 0,
    killsByHero: 0, killsByWitch: 0,
    // Exploration
    exploresHero: 0, exploresWitch: 0,
    hexesExplored: new Set(),
    // Resources found (parsed from explore log lines)
    found: { wood:0, metal:0, herbs:0, food:0, silver:0, scripture:0, weapons:0, horses:0, nothing:0 },
    // Over-budget food consumed
    foodConsumedHero: 0, foodConsumedWitch: 0,
    // Summoning / fortification
    summons: 0, fortifies: 0,
    // Unit ecology — peak counts during the game
    peakSurvivors: 0, peakMinions: 0,
    // Node checkpoints where each side scored
    nodeScoreEvents: [],  // { round, winner: 'hero'|'witch', score }
    // Attrition
    attritionFinal: 0,
  };

  // ── Event analyser ──────────────────────────────────────────────────────────
  function analyseEvents(events) {
    for (const ev of events) {
      if (ev.type !== ResEventType.ACTION_OK) continue;
      const { action, result, faction } = ev;

      // Action-type distribution
      const tally = metrics.actionCounts[faction];
      tally[action.type] = (tally[action.type] ?? 0) + 1;

      switch (action.type) {
        case PlanActionType.BATTLE_UNIT:
        case PlanActionType.BATTLE_HEX:
          if (faction === 'hero') metrics.battlesHero++; else metrics.battlesWitch++;
          if (result?.killed) {
            if (faction === 'hero') metrics.killsByHero++; else metrics.killsByWitch++;
          }
          break;

        case PlanActionType.EXPLORE: {
          if (faction === 'hero') metrics.exploresHero++; else metrics.exploresWitch++;
          metrics.hexesExplored.add(`${action.entityId}@${action.col},${action.row}`);
          // Resource detection from log text
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

        case PlanActionType.SUMMON:
          metrics.summons++;
          break;

        case PlanActionType.FORTIFY:
          metrics.fortifies++;
          break;

        default: break;
      }

      // Over-budget food consumption (logged by resolver)
      const logTxt = (result?.log ?? []).join(' ');
      if (logTxt.includes('Rations consumed')) {
        if (faction === 'hero') metrics.foodConsumedHero++; else metrics.foodConsumedWitch++;
      }
    }
  }

  // ── Main game loop ──────────────────────────────────────────────────────────
  const prevScore = { hero: 0, witch: 0 };

  while (!state.gameOver && state.round <= MAX_ROUNDS) {
    state.startPlanning();
    const heroPlan  = heroAI.generatePlan();
    const witchPlan = witchAI.generatePlan();
    state.submitPlan('hero',  heroPlan);
    state.submitPlan('witch', witchPlan);

    const steps = resolvePlans(state, state.heroPlan, state.witchPlan);

    for (const step of steps) {
      analyseEvents(step.heroEvents  ?? []);
      analyseEvents(step.witchEvents ?? []);
    }

    state.endRound();

    // Sample ecology after each round
    const surv = state.entities.filter(e => e.alive && e.type === 'survivor').length;
    const mini = state.entities.filter(e => e.alive && e.owner === 'witch' && e.type !== 'witch').length;
    if (surv > metrics.peakSurvivors) metrics.peakSurvivors = surv;
    if (mini > metrics.peakMinions)   metrics.peakMinions   = mini;

    // Record node-score events
    if (state.nodeScore.hero > prevScore.hero) {
      metrics.nodeScoreEvents.push({ round: state.round, side: 'hero', total: state.nodeScore.hero });
      prevScore.hero = state.nodeScore.hero;
    }
    if (state.nodeScore.witch > prevScore.witch) {
      metrics.nodeScoreEvents.push({ round: state.round, side: 'witch', total: state.nodeScore.witch });
      prevScore.witch = state.nodeScore.witch;
    }
  }

  metrics.attritionFinal = state.attritionLevel;

  // ── Tiebreak (same as before) ──────────────────────────────────────────────
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
        id:                randomUUID(),  // imported from 'crypto' at top
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
        hero_personality:  heroAI.constructor.name,
        witch_personality: witchAI.constructor.name,
        hero_player_id:    null,
        witch_player_id:   null,
        game_version:      VERSION,
        fog_of_war:        0,
        duration_ms:       null,
      });
    } catch { /* non-critical — skip */ }
  }

  return {
    winner, winReason,
    rounds: state.round,
    heroHp: state.hero.hp,  witchHp: state.witch.hp,
    nodeScore: { ...state.nodeScore },
    metrics,
    hitCap: state.round > MAX_ROUNDS,
  };
}

// ── Stat helpers ───────────────────────────────────────────────────────────────

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

// ── Main ───────────────────────────────────────────────────────────────────────

console.log(`\nBrimstone headless runner — ${N} games (planning model, cap=${MAX_ROUNDS} rounds)…\n`);

const results = [];
const startMs = Date.now();

process.stdout.write('  Running ');
for (let i = 0; i < N; i++) {
  results.push(runGame());
  if ((i + 1) % Math.max(1, Math.floor(N / 40)) === 0) process.stdout.write('█');
}
process.stdout.write('\n\n');

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

// ── Aggregate ──────────────────────────────────────────────────────────────────

const heroWins  = results.filter(r => r.winner === 'hero').length;
const witchWins = results.filter(r => r.winner === 'witch').length;
const draws     = results.filter(r => r.winner === 'draw').length;
const tiebreaks = results.filter(r => r.winReason?.includes('tiebreak') || r.winReason?.includes('draw')).length;

// Win condition categorisation
function classify(r) {
  const wr = r.winReason ?? '';
  if (wr === WIN_REASON.WITCH_SLAIN || wr === WIN_REASON.HERO_SLAIN) return 'kill';
  if (wr.includes('tiebreak') || wr.includes('draw') || wr.includes('majority')) return 'tiebreak';
  return 'nodes';
}
const killWins  = results.filter(r => classify(r) === 'kill').length;
const nodeWins  = results.filter(r => classify(r) === 'nodes').length;
const tieWins   = results.filter(r => classify(r) === 'tiebreak').length;

// Specific win-reason counts
const conditionCounts = {};
for (const r of results) {
  const key = r.winReason ?? 'unknown';
  conditionCounts[key] = (conditionCounts[key] ?? 0) + 1;
}

// Game length
const roundArr = results.map(r => r.rounds).sort((a, b) => a - b);
const meanRounds = avg(roundArr);
const medRounds  = median(roundArr);

// HP at game end
const heroHpArr  = results.map(r => r.heroHp);
const witchHpArr = results.map(r => r.witchHp);

// Metric averages
function avgM(fn) { return avg(results.map(fn)); }

const avgExploresHero  = avgM(r => r.metrics.exploresHero);
const avgExploresWitch = avgM(r => r.metrics.exploresWitch);
const avgBattlesHero   = avgM(r => r.metrics.battlesHero);
const avgBattlesWitch  = avgM(r => r.metrics.battlesWitch);
const avgKillsHero     = avgM(r => r.metrics.killsByHero);
const avgKillsWitch    = avgM(r => r.metrics.killsByWitch);
const avgSummons       = avgM(r => r.metrics.summons);
const avgFortifies     = avgM(r => r.metrics.fortifies);
const avgPeakSurv      = avgM(r => r.metrics.peakSurvivors);
const avgPeakMini      = avgM(r => r.metrics.peakMinions);
const avgFoodH         = avgM(r => r.metrics.foodConsumedHero);
const avgFoodW         = avgM(r => r.metrics.foodConsumedWitch);

// Resource totals (per game)
const resKeys = ['wood','metal','herbs','food','silver','scripture','weapons','horses','nothing'];
const avgFound = {};
for (const k of resKeys) avgFound[k] = avgM(r => r.metrics.found[k]);

// Action distribution (fraction of total actions)
const actTypeTotals = {};
for (const r of results) {
  for (const [side, counts] of Object.entries(r.metrics.actionCounts)) {
    for (const [type, n] of Object.entries(counts)) {
      actTypeTotals[type] = (actTypeTotals[type] ?? 0) + n;
    }
  }
}
const totalActions = Object.values(actTypeTotals).reduce((s, v) => s + v, 0);

// Round length histogram
const bucketSize = 5;
const buckets = {};
for (const r of roundArr) {
  const b = Math.floor(r / bucketSize) * bucketSize;
  buckets[b] = (buckets[b] ?? 0) + 1;
}
const bucketKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);

// ── Report ─────────────────────────────────────────────────────────────────────

const W    = 64;
const line = '─'.repeat(W);
const row  = s => `║ ${s.padEnd(W - 2)} ║`;
const hdr  = s => { console.log(`╠${line}╣`); console.log(row(s)); };

console.log(`╔${line}╗`);
console.log(row(`BRIMSTONE BALANCE REPORT — ${MAP_SIZES[MAP_SIZE].label} — ${N} games · ${elapsed}s · cap=${MAX_ROUNDS}r`));

hdr('WIN RATES');
console.log(row(` Hero  ${bar(heroWins,  N)}  ${String(heroWins).padStart(4)}  (${pct(heroWins,  N)}%)`));
console.log(row(` Witch ${bar(witchWins, N)}  ${String(witchWins).padStart(4)}  (${pct(witchWins, N)}%)`));
if (draws > 0)
  console.log(row(` Draw  ${bar(draws, N)}  ${String(draws).padStart(4)}  (${pct(draws, N)}%)`));

hdr('WIN CONDITION MIX');
console.log(row(` By kill  ${bar(killWins, N)}  ${String(killWins).padStart(4)}  (${pct(killWins, N)}%)`));
console.log(row(` By nodes ${bar(nodeWins, N)}  ${String(nodeWins).padStart(4)}  (${pct(nodeWins, N)}%)`));
console.log(row(` Tiebreak ${bar(tieWins,  N)}  ${String(tieWins).padStart(4)}  (${pct(tieWins,  N)}%)`));

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
for (const [reason, count] of Object.entries(conditionCounts).sort((a, b) => b[1] - a[1])) {
  const label = winLabels[reason] ?? reason.slice(0, 25).padEnd(25);
  console.log(row(` ${label}  ${bar(count, N, 16)}  ${String(count).padStart(4)}  (${pct(count, N)}%)`));
}

hdr('GAME LENGTH (rounds)');
console.log(row(`  Mean ${fmt(meanRounds)}  /  Median ${medRounds}  /  Min ${roundArr[0]}  /  Max ${roundArr[roundArr.length-1]}`));
console.log(row(`  p25=${percentile(roundArr,25)}  p50=${percentile(roundArr,50)}  p75=${percentile(roundArr,75)}  p95=${percentile(roundArr,95)}`));
console.log(row(`  Games hitting round cap (${MAX_ROUNDS}): ${results.filter(r=>r.hitCap).length}  (${pct(results.filter(r=>r.hitCap).length, N)}%)`));

hdr(`LENGTH HISTOGRAM  (bucket=${bucketSize}r, target ≈25r)`);
for (const b of bucketKeys) {
  const count = buckets[b];
  const label = `${String(b).padStart(3)}–${String(b + bucketSize - 1).padStart(3)}`;
  const filled = Math.round((count / N) * 28);
  console.log(row(`  ${label}  ${'█'.repeat(filled)}${'░'.repeat(28 - filled)}  ${pct(count, N).padStart(5)}%`));
}

hdr('COMBAT (avg per game)');
console.log(row(`  Hero battles   ${fmt(avgBattlesHero)}   kills ${fmt(avgKillsHero)}`));
console.log(row(`  Witch battles  ${fmt(avgBattlesWitch)}   kills ${fmt(avgKillsWitch)}`));
console.log(row(`  Avg hero HP at end:   ${fmt(avg(heroHpArr))}`));
console.log(row(`  Avg witch HP at end:  ${fmt(avg(witchHpArr))}`));

hdr('EXPLORATION (avg per game)');
console.log(row(`  Hero explores   ${fmt(avgExploresHero)}   Witch explores   ${fmt(avgExploresWitch)}`));

hdr('RESOURCES FOUND (avg per game across all explores)');
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

hdr('ACTION MIX (% of all actions across all games)');
const actOrder = [
  PlanActionType.MOVE, PlanActionType.BATTLE_UNIT, PlanActionType.BATTLE_HEX,
  PlanActionType.EXPLORE, PlanActionType.FORTIFY, PlanActionType.SUMMON,
  PlanActionType.USE_ITEM, PlanActionType.EQUIP_WEAPON, PlanActionType.USE_ABILITY,
];
for (const type of actOrder) {
  const count = actTypeTotals[type] ?? 0;
  if (!count) continue;
  const filledN = Math.round((count / totalActions) * 28);
  console.log(row(`  ${type.padEnd(14)}  ${'█'.repeat(filledN)}${'░'.repeat(28-filledN)}  ${pct(count, totalActions)}%`));
}

// ── Balance analysis ───────────────────────────────────────────────────────────

hdr('BALANCE ANALYSIS');

const issues = [];
const suggestions = [];

const heroPct  = heroWins / N;
const witchPct = witchWins / N;
const drawPct  = tieWins  / N;
const tieRatio = (tieWins + draws) / N;

if (Math.abs(heroPct - witchPct) > 0.12) {
  const favoured = heroPct > witchPct ? 'Hero' : 'Witch';
  const loser    = heroPct > witchPct ? 'Witch' : 'Hero';
  issues.push(`⚠ Win rate imbalanced: ${favoured} wins ${pct(Math.max(heroPct,witchPct)*N,N)}% vs ${loser} ${pct(Math.min(heroPct,witchPct)*N,N)}%`);
  if (heroPct > witchPct + 0.12) {
    suggestions.push('• Hero too strong: reduce hero base ATK by 1, or reduce survivor action bonus rate');
    suggestions.push('• Or buff witch: lower minion-per-action threshold from 2→1 minions, or raise minion HP to 3');
  } else {
    suggestions.push('• Witch too strong: reduce witch base actions (4→3), or make minion summoning cost 2 actions');
    suggestions.push('• Or buff hero: increase hero base HP to 12, or reduce fatigue threshold');
  }
}

if (tieRatio > 0.10) {
  issues.push(`⚠ Too many tiebreaks: ${pct(tieRatio * N, N)}% (target <10%)`);
  suggestions.push('• Reduce MAX_ROUNDS or make scoring checkpoints more decisive (require 2 nodes not just majority)');
  suggestions.push('• Increase attrition damage to force earlier decisive combat');
}

if (killWins / N < 0.20) {
  issues.push(`⚠ Too few kill victories: ${pct(killWins, N)}% (want ≥20%)`);
  suggestions.push('• Lower hero/witch HP (10→8) to make combat more decisive');
  suggestions.push('• Increase base attack stats or reduce defense');
}
if (nodeWins / N < 0.30) {
  issues.push(`⚠ Too few node victories: ${pct(nodeWins, N)}% (want ≥30%)`);
  suggestions.push('• Reduce score threshold from 3 to 2 cumulative points for faster node wins');
  suggestions.push('• Make sweep-all-3-nodes victory more achievable (reduce node separation requirement)');
}

if (meanRounds < 15) {
  issues.push(`⚠ Games too short: mean ${fmt(meanRounds)} rounds (target ≈25)`);
  suggestions.push('• Increase hero and witch HP pools');
  suggestions.push('• Reduce attrition rate or hazard damage');
}
if (meanRounds > 30) {
  issues.push(`⚠ Games too long: mean ${fmt(meanRounds)} rounds (target ≈25)`);
  suggestions.push('• Reduce MAX_ROUNDS, or increase attrition damage ceiling above 3');
  suggestions.push('• Make scoring checkpoints require fewer points (3→2) for faster decisive wins');
}

if (avgPeakSurv < 1.5) {
  issues.push(`⚠ Survivors rarely recruited: avg peak ${fmt(avgPeakSurv)} (want ≥2)`);
  suggestions.push('• Increase hidden survivor count (12→15), or raise survivor spawn probability at nodes (33%→50%)');
}
if (avgPeakMini < 2.0) {
  issues.push(`⚠ Witch rarely builds a minion army: avg peak ${fmt(avgPeakMini)} (want ≥3)`);
  suggestions.push('• Raise node spawn chance back to 50%, or reduce summon cost to free in NIGHT');
}
if (avgFortifies < 1.0) {
  issues.push(`⚠ Fortification barely used: avg ${fmt(avgFortifies)} per game`);
  suggestions.push('• Increase wood loot weight, or make FORTIFY free during DAY');
}

if (issues.length === 0) {
  console.log(row('  ✓ Balance looks healthy within all targets.'));
} else {
  for (const issue of issues) console.log(row(`  ${issue}`));
  console.log(row(''));
  console.log(row('  Suggestions:'));
  for (const s of suggestions) console.log(row(`    ${s}`));
}

console.log(`╚${line}╝`);
console.log();
