#!/usr/bin/env node
/**
 * AI personality matrix — pits every hero personality against every witch
 * personality and reports win rates + game-length statistics.
 *
 * Usage:
 *   node scripts/ai-matrix.js [games-per-matchup]
 *   node scripts/ai-matrix.js 200
 *
 * Each cell in the 4×4 matrix (hero personality × witch personality) shows:
 *   hero-win% / witch-win%  (avg rounds)
 */

import { GameState }        from '../src/game.js';
import { resolvePlans, ResEventType } from '../server/resolver.js';
import { HERO_PERSONALITIES, WITCH_PERSONALITIES } from '../src/ai.js';
import '../src/ai-engine.js'; // side-effect: registers witch personalities
import { WIN_REASON }       from '../src/game.js';

const N = parseInt(process.argv[2] ?? '200', 10);
if (isNaN(N) || N < 1) { console.error('Usage: node ai-matrix.js [games]'); process.exit(1); }

const MAX_ROUNDS = 48;

// ── Per-game runner ────────────────────────────────────────────────────────────

function runGame(HeroClass, WitchClass) {
  const state   = new GameState(true, true);
  const heroAI  = new HeroClass(state,  () => {}, 0);
  const witchAI = new WitchClass(state, () => {}, 0);

  let kills = { hero: 0, witch: 0 };

  while (!state.gameOver && state.round <= MAX_ROUNDS) {
    state.startPlanning();
    const heroPlan  = heroAI.generatePlan();
    const witchPlan = witchAI.generatePlan();
    state.submitPlan('hero',  heroPlan);
    state.submitPlan('witch', witchPlan);

    const steps = resolvePlans(state, state.heroPlan, state.witchPlan);
    for (const step of steps) {
      for (const ev of [...(step.heroEvents ?? []), ...(step.witchEvents ?? [])]) {
        if (ev.type === ResEventType.ACTION_OK && ev.result?.killed) {
          if (ev.faction === 'hero')  kills.hero++;
          else                        kills.witch++;
        }
      }
    }
    state.endRound();
  }

  let winner    = state.winner;
  let winReason = state.winReason ?? '';

  if (!winner) {
    const ws = state.nodeScore.witch, hs = state.nodeScore.hero;
    winner    = ws !== hs ? (ws > hs ? 'witch' : 'hero') : 'draw';
    winReason = winner === 'draw' ? 'draw' : 'score tiebreak';
  }

  const isKill   = winReason === WIN_REASON.WITCH_SLAIN || winReason === WIN_REASON.HERO_SLAIN;
  const isNode   = !isKill && !winReason.includes('tiebreak') && !winReason.includes('draw');
  return { winner, isKill, isNode, rounds: state.round, kills };
}

// ── Matrix run ─────────────────────────────────────────────────────────────────

const heroNames  = Object.keys(HERO_PERSONALITIES);
const witchNames = Object.keys(WITCH_PERSONALITIES);

// results[heroName][witchName] = { heroWins, witchWins, draws, rounds[], killWins, nodeWins }
const results = {};
for (const h of heroNames)  results[h] = {};
for (const h of heroNames) {
  for (const w of witchNames) {
    results[h][w] = { heroWins: 0, witchWins: 0, draws: 0, rounds: [], killWins: 0, nodeWins: 0, errors: 0 };
  }
}

const total = heroNames.length * witchNames.length * N;
let done = 0;

process.stdout.write(`\nBrimstone AI matrix — ${heroNames.length}×${witchNames.length} matchups × ${N} games = ${total} total\n\n`);

for (const h of heroNames) {
  const HClass = HERO_PERSONALITIES[h];
  for (const w of witchNames) {
    const WClass = WITCH_PERSONALITIES[w];
    process.stdout.write(`  ${h.padEnd(10)} vs ${w.padEnd(10)} `);

    const cell = results[h][w];
    for (let i = 0; i < N; i++) {
      try {
        const r = runGame(HClass, WClass);
        if (r.winner === 'hero')       cell.heroWins++;
        else if (r.winner === 'witch') cell.witchWins++;
        else                           cell.draws++;
        cell.rounds.push(r.rounds);
        if (r.isKill)  cell.killWins++;
        if (r.isNode)  cell.nodeWins++;
      } catch (err) {
        cell.errors++;
      }
      done++;
      if (done % Math.max(1, Math.floor(total / 60)) === 0) process.stdout.write('█');
    }
    const avgR = (cell.rounds.reduce((s, v) => s + v, 0) / cell.rounds.length || 0).toFixed(1);
    process.stdout.write(`  H${((cell.heroWins/N)*100).toFixed(0)}% W${((cell.witchWins/N)*100).toFixed(0)}%  ${avgR}r\n`);
  }
}
process.stdout.write('\n');

// ── Render matrix table ────────────────────────────────────────────────────────

const CW = 16; // cell width
const HW = 11; // header width

function pad(s, w) { return String(s).padStart(w); }
function pct(n) { return `${((n/N)*100).toFixed(0)}%`; }
function avg(arr) { return arr.length ? (arr.reduce((s,v)=>s+v,0)/arr.length).toFixed(1) : '—'; }
function cell(h, w) {
  const c = results[h][w];
  const hw = pct(c.heroWins), ww = pct(c.witchWins);
  const r  = avg(c.rounds);
  // Hero% shown in gold-ish (brightens >50%), witch in purple (brightens >50%)
  const heroFlag  = c.heroWins  > c.witchWins ? '▲' : ' ';
  const witchFlag = c.witchWins > c.heroWins  ? '▲' : ' ';
  return `H${hw}${heroFlag}/W${ww}${witchFlag}`;
}

// Header
const divider = '─'.repeat(HW + witchNames.length * (CW + 1) + 2);
console.log('\n' + '╔' + divider + '╗');
const header = ' '.repeat(HW) + '│' + witchNames.map(w => w.padEnd(CW)).join('│');
console.log(`║ ${header.padEnd(divider.length - 2)} ║`);
console.log('╠' + divider + '╣');

for (const h of heroNames) {
  const rowLabel = h.padEnd(HW - 1);
  const cells    = witchNames.map(w => cell(h, w).padEnd(CW)).join('│');
  console.log(`║ ${rowLabel}│${cells} ║`);
}
console.log('╚' + divider + '╝');

// ── Per-personality win-rate summary ──────────────────────────────────────────

console.log('\n── Hero personality summary (avg win rate vs all witch styles) ──');
for (const h of heroNames) {
  const wins = witchNames.reduce((s, w) => s + results[h][w].heroWins, 0);
  const total = witchNames.length * N;
  const avgRnd = avg(witchNames.flatMap(w => results[h][w].rounds));
  const kills  = witchNames.reduce((s, w) => s + results[h][w].killWins, 0);
  const nodes  = witchNames.reduce((s, w) => s + results[h][w].nodeWins, 0);
  console.log(`  ${h.padEnd(10)}  win ${((wins/total)*100).toFixed(1)}%   avg ${avgRnd}r   kill-wins ${((kills/total)*100).toFixed(1)}%   node-wins ${((nodes/total)*100).toFixed(1)}%`);
}

console.log('\n── Witch personality summary (avg win rate vs all hero styles) ──');
for (const w of witchNames) {
  const wins  = heroNames.reduce((s, h) => s + results[h][w].witchWins, 0);
  const total = heroNames.length * N;
  const avgRnd = avg(heroNames.flatMap(h => results[h][w].rounds));
  const kills  = heroNames.reduce((s, h) => s + results[h][w].killWins, 0);
  const nodes  = heroNames.reduce((s, h) => s + results[h][w].nodeWins, 0);
  console.log(`  ${w.padEnd(10)}  win ${((wins/total)*100).toFixed(1)}%   avg ${avgRnd}r   kill-wins ${((kills/total)*100).toFixed(1)}%   node-wins ${((nodes/total)*100).toFixed(1)}%`);
}
console.log();
