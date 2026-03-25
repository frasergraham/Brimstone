#!/usr/bin/env node
/**
 * Brimstone — Project Validation Script
 *
 * Runs fast enough for a deploy step:
 *   1. Unit tests (node:test, all tests/*.test.js)
 *   2. Quick AI-vs-AI simulation (50 games) for balance sanity check
 *
 * Usage:  node scripts/validate.js [--sim-count N]
 * Exit:   0 on pass, 1 on any failure
 */

import { spawnSync }    from 'node:child_process';
import { glob }         from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── Config ────────────────────────────────────────────────────────────────────

const __dir   = dirname(fileURLToPath(import.meta.url));
const ROOT    = join(__dir, '..');
const SIM_COUNT = parseInt(
  process.argv[process.argv.indexOf('--sim-count') + 1] ?? '50', 10
) || 50;

let passed = 0;
let failed = 0;

// ── Helpers ───────────────────────────────────────────────────────────────────

function section(title) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`  ${title}`);
  console.log('─'.repeat(60));
}

function pass(label) {
  passed++;
  console.log(`  ✓  ${label}`);
}

function fail(label, detail = '') {
  failed++;
  console.log(`  ✗  ${label}`);
  if (detail) console.log(`     ${detail.replace(/\n/g, '\n     ')}`);
}

// ── 1. Unit tests ─────────────────────────────────────────────────────────────

section('Unit tests');

const testFiles = (await Array.fromAsync(glob(join(ROOT, 'tests', '*.test.js')))).sort();

if (testFiles.length === 0) {
  fail('No test files found in tests/');
} else {
  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...testFiles],
    { cwd: ROOT, encoding: 'utf8' }
  );

  // Parse TAP output for ok / not ok lines
  const lines = (result.stdout ?? '').split('\n');
  let unitPass = 0, unitFail = 0;
  const failures = [];

  for (const line of lines) {
    if (/^ok \d+/.test(line)) {
      unitPass++;
    } else if (/^not ok \d+/.test(line)) {
      unitFail++;
      failures.push(line.trim());
    }
  }

  // Also check for test runner exit status
  if (result.status !== 0 && unitPass === 0 && unitFail === 0) {
    // Likely a syntax/import error — print stderr
    fail('Unit test runner crashed', (result.stderr ?? '').slice(0, 600));
  } else {
    const total = unitPass + unitFail;
    if (unitFail === 0) {
      pass(`${total} unit test(s) passed`);
    } else {
      fail(`${unitFail}/${total} unit test(s) failed`);
      for (const f of failures.slice(0, 10)) {
        console.log(`       ${f}`);
      }
      if (failures.length > 10) {
        console.log(`       … and ${failures.length - 10} more`);
      }
    }
    // Print stderr (includes failure details from node:test)
    if (result.stderr) {
      const errLines = result.stderr.split('\n').filter(l =>
        l.includes('AssertionError') || l.includes('Error:') || l.includes('BUG')
      );
      if (errLines.length) {
        console.log('\n  Failure details:');
        for (const l of errLines.slice(0, 20)) console.log(`    ${l}`);
      }
    }
  }
}

// ── 2. Simulation sanity check ────────────────────────────────────────────────

section(`AI-vs-AI simulation (${SIM_COUNT} games)`);

const simResult = spawnSync(
  process.execPath,
  [join(ROOT, 'scripts', 'headless.js'), String(SIM_COUNT)],
  { cwd: ROOT, encoding: 'utf8', timeout: 60_000 }
);

if (simResult.status !== 0 || simResult.error) {
  fail('Simulation failed to run', simResult.stderr?.slice(0, 400) ?? String(simResult.error));
} else {
  const out = simResult.stdout ?? '';

  // Extract key metrics from headless output
  const heroWinMatch    = out.match(/Hero wins.*?(\d+\.?\d*)%/);
  const witchWinMatch   = out.match(/Witch wins.*?(\d+\.?\d*)%/);
  const avgRoundsMatch  = out.match(/Avg(?:erage)? (?:game )?length.*?(\d+\.?\d*)/i);

  const heroWin   = heroWinMatch   ? parseFloat(heroWinMatch[1])   : null;
  const witchWin  = witchWinMatch  ? parseFloat(witchWinMatch[1])  : null;
  const avgRounds = avgRoundsMatch ? parseFloat(avgRoundsMatch[1]) : null;

  // Balance targets from design doc:
  //   Hero win rate: 45–55%
  //   Average game length: 15–25 rounds
  // We relax these bounds slightly for small sample sizes.

  const HERO_WIN_LOW  = 30; // generous low bound at 50 games
  const HERO_WIN_HIGH = 70; // generous high bound at 50 games
  const ROUNDS_LOW    = 10;
  const ROUNDS_HIGH   = 40;

  let simOk = true;

  if (heroWin !== null) {
    if (heroWin < HERO_WIN_LOW || heroWin > HERO_WIN_HIGH) {
      fail(`Hero win rate ${heroWin.toFixed(1)}% is outside ${HERO_WIN_LOW}–${HERO_WIN_HIGH}% (balance concern)`);
      simOk = false;
    }
  }

  if (avgRounds !== null) {
    if (avgRounds < ROUNDS_LOW || avgRounds > ROUNDS_HIGH) {
      fail(`Average game length ${avgRounds.toFixed(1)} rounds is outside ${ROUNDS_LOW}–${ROUNDS_HIGH} (pacing concern)`);
      simOk = false;
    }
  }

  if (simOk) {
    const summary = [
      heroWin   !== null ? `hero wins ${heroWin.toFixed(1)}%` : null,
      witchWin  !== null ? `witch wins ${witchWin.toFixed(1)}%` : null,
      avgRounds !== null ? `avg ${avgRounds.toFixed(1)} rounds` : null,
    ].filter(Boolean).join(', ');
    pass(`Simulation completed — ${summary || 'see output for details'}`);
  }

  // Always print sim summary lines regardless
  const summaryLines = out.split('\n').filter(l =>
    /win|round|kill|score|attrition/i.test(l)
  ).slice(0, 12);
  for (const l of summaryLines) console.log(`  ${l}`);
}

// ── 3. Final verdict ──────────────────────────────────────────────────────────

section('Results');
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);

if (failed > 0) {
  console.log('\n  ✗ Validation FAILED\n');
  process.exit(1);
} else {
  console.log('\n  ✓ Validation PASSED\n');
  process.exit(0);
}
