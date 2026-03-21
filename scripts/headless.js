#!/usr/bin/env node
// Headless game runner — plays N AI vs AI games and reports stats.
// Usage:  node scripts/headless.js [count]   (default 1000)
//
// No browser APIs needed: game.js, entities.js, tiles.js, hex.js, map.js,
// actions.js, and ai.js are all pure JS and load fine in Node.

import { GameState, WIN_REASON } from '../src/game.js';
import { WitchAI, HeroAI }      from '../src/ai.js';

const N = parseInt(process.argv[2] ?? '1000', 10);
if (isNaN(N) || N < 1) { console.error('Usage: node scripts/headless.js [count]'); process.exit(1); }

// ── Per-game runner ───────────────────────────────────────────────────────────

async function runGame() {
  const state   = new GameState(true, true);

  // thinkDelay=0: AI still uses await delay(0) so the event loop stays alive,
  // but there's no real wait between actions.
  const witchAI = new WitchAI(state, () => {}, 0);
  const heroAI  = new HeroAI(state,  () => {}, 0);

  // Resolve battle dialogs immediately (no UI)
  const noop = () => Promise.resolve();
  witchAI.onBattleResult = noop;
  heroAI.onBattleResult  = noop;

  // Safety cap: after 80 rounds declare a draw (tie).
  const MAX_ROUNDS = 80;

  while (!state.gameOver && state.round <= MAX_ROUNDS) {
    if (state.activePlayer === 'witch') {
      await witchAI.takeTurn();
    } else {
      await heroAI.takeTurn();
    }
  }

  return {
    winner:    state.winner ?? 'draw',
    winReason: state.winReason ?? 'exceeded max rounds',
    rounds:    state.round,
    phase:     state.phase,
  };
}

// ── Stat helpers ──────────────────────────────────────────────────────────────

function median(sorted) {
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[m - 1] + sorted[m]) / 2
    : sorted[m];
}

function percentile(sorted, p) {
  const idx = Math.ceil(sorted.length * p / 100) - 1;
  return sorted[Math.max(0, idx)];
}

function bar(count, total, width = 20) {
  const filled = Math.round((count / total) * width);
  return '█'.repeat(filled) + '░'.repeat(width - filled);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log(`\nBrimstone headless runner — playing ${N} games…\n`);

const results = [];
const startMs = Date.now();

// Run games sequentially (simplest; avoids shared-state issues)
for (let i = 0; i < N; i++) {
  const r = await runGame();
  results.push(r);
  const winnerLabel = r.winner === 'draw' ? 'draw ' : r.winner.padEnd(5);
  console.log(`  game ${String(i + 1).padStart(4)}  ${winnerLabel}  rounds=${String(r.rounds).padStart(3)}  ${r.winReason}`);
}
process.stdout.write('\r' + ' '.repeat(40) + '\r'); // clear progress line

const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);

// ── Aggregate ─────────────────────────────────────────────────────────────────

const heroWins  = results.filter(r => r.winner === 'hero').length;
const witchWins = results.filter(r => r.winner === 'witch').length;
const draws     = results.filter(r => r.winner === 'draw').length;

// Win condition breakdown
const conditionCounts = {};
for (const r of results) {
  conditionCounts[r.winReason] = (conditionCounts[r.winReason] ?? 0) + 1;
}

// Game length
const rounds = results.map(r => r.rounds).sort((a, b) => a - b);
const minR   = rounds[0];
const maxR   = rounds[rounds.length - 1];
const meanR  = (rounds.reduce((s, v) => s + v, 0) / rounds.length).toFixed(1);
const medR   = median(rounds);
const p25    = percentile(rounds, 25);
const p75    = percentile(rounds, 75);
const p95    = percentile(rounds, 95);

// Round-length histogram (buckets of 5)
const bucketSize = 5;
const buckets    = {};
for (const r of rounds) {
  const b = Math.floor(r / bucketSize) * bucketSize;
  buckets[b] = (buckets[b] ?? 0) + 1;
}
const bucketKeys = Object.keys(buckets).map(Number).sort((a, b) => a - b);

// ── Report ────────────────────────────────────────────────────────────────────

// Box is W chars wide between the ║ borders
const W    = 62;
const line = '─'.repeat(W);
const row  = s => `║ ${s.padEnd(W - 2)} ║`;

console.log(`╔${line}╗`);
console.log(row(`BRIMSTONE HEADLESS REPORT — ${N} games in ${elapsed}s`));
console.log(`╠${line}╣`);

console.log(row('WINNERS'));
console.log(row(` Hero  ${bar(heroWins,  N)}  ${heroWins.toString().padStart(5)}  (${(heroWins  / N * 100).toFixed(1)}%)`));
console.log(row(` Witch ${bar(witchWins, N)}  ${witchWins.toString().padStart(5)}  (${(witchWins / N * 100).toFixed(1)}%)`));
if (draws > 0)
  console.log(row(` Draw  ${bar(draws, N)}  ${draws.toString().padStart(5)}  (${(draws / N * 100).toFixed(1)}%)`));

console.log(`╠${line}╣`);
console.log(row('WIN CONDITIONS'));

const winLabels = {
  [WIN_REASON.WITCH_SLAIN]: 'Witch slain      ',
  [WIN_REASON.HERO_SLAIN]:  'Hero slain       ',
  [WIN_REASON.NODES_WITCH]: 'Witch holds nodes',
  [WIN_REASON.NODES_HERO]:  'Hero holds nodes ',
};
for (const [reason, count] of Object.entries(conditionCounts).sort((a, b) => b[1] - a[1])) {
  const label = winLabels[reason] ?? reason.slice(0, 17).padEnd(17);
  console.log(row(` ${label}  ${bar(count, N)}  ${count.toString().padStart(5)}  (${(count / N * 100).toFixed(1)}%)`));
}

console.log(`╠${line}╣`);
console.log(row('GAME LENGTH (rounds)'));
console.log(row(`  Min ${minR}  /  Max ${maxR}  /  Mean ${meanR}  /  Median ${medR}`));
console.log(row(`  p25=${p25}  p75=${p75}  p95=${p95}`));

console.log(`╠${line}╣`);
console.log(row(`LENGTH HISTOGRAM (bucket = ${bucketSize} rounds)`));
for (const b of bucketKeys) {
  const count  = buckets[b];
  const label  = `${String(b).padStart(3)}–${String(b + bucketSize - 1).padStart(3)}`;
  const filled = Math.round((count / results.length) * 30);
  const pct    = (count / results.length * 100).toFixed(1);
  console.log(row(`  ${label}  ${'█'.repeat(filled)}${'░'.repeat(30 - filled)}  ${pct.padStart(5)}%`));
}

console.log(`╚${line}╝`);
console.log();
