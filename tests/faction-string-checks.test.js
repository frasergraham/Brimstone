// Guardrail: prevent new `=== 'hero'` / `=== 'witch'` string-literal faction
// checks from creeping into the codebase.
//
// The codebase is mid-refactor toward N-faction support (see
// `docs/design/refactor.md`). The `Faction` abstraction in `src/factions.js`
// is the intended vocabulary for faction-specific behavior — polymorphic
// methods, capability predicates, etc. Every `x === 'hero'` check added to
// fresh code is a small step backwards.
//
// This test locks the current count per file. If a new check is added,
// the test fails with a pointer. If a file is removed or the count goes
// down, update the allowlist below (and celebrate).
//
// Patterns tracked:
//   `foo === 'hero'`, `foo === 'witch'`
//   `foo !== 'hero'`, `foo !== 'witch'`
//
// Excluded (false positives):
//   `e.type === 'hero'`, `.type === 'witch'` — these compare against
//   `EntityType.HERO` / `EntityType.WITCH` values which happen to share
//   the same string literal as the faction ids. Not a faction check.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');

const PATTERN = /[!=]==\s*['"](hero|witch)['"]/g;

// Files allowed to contain faction string checks, and their current
// permitted count. Numbers lock the post-2026-04-21 state after the
// Track A sweep. They should ratchet DOWN as god classes get extracted
// and new code uses `Faction` methods. Never increase a count without
// documenting why.
const ALLOWLIST = Object.freeze({
  // Pre-existing god classes — refactored separately (see Track B).
  'server/lobby.js':             73,
  'src/main.js':                 44,
  'src/ui.js':                   24,

  // Pre-existing core modules — generalized in Finding 1, residual checks
  // are legacy and can be cleaned up opportunistically.
  'src/game.js':                 24,
  'src/ai-engine.js':            18,
  'src/hero-ai-engine.js':       15,
  'src/actions.js':               7,
  'src/renderer.js':              8,
  'server/async-game-rooms.js':   8,
  'src/ai.js':                    6,
  'server/async-game.js':         6,

  // Display-layer dispatch (CSS classes, glyphs, node-control branches).
  'src/ui-render.js':             4,

  // Inherent to 2-faction battle-room protocol — legitimately faction-keyed.
  'server/battle-scheduler.js':   4,

  // Small pre-existing tails.
  'server/notifications.js':      3,
  'src/ai-debug.js':              2,  // debug glyph + summary rows
  'src/map.js':                   2,
  'src/planner.js':               2,
  'server/admin.js':              2,
  'server/game-stats.js':         2,
  'server/resolver.js':           2,

  // Hardcoded tutorial scenarios (2-faction by design).
  'src/tutorial/tutorial-config.js': 1,
  'src/tutorial.js':                 1,
});

function walkJs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    // Don't recurse into node_modules or dot-dirs.
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkJs(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function isFalsePositive(lineBefore) {
  // Exclude `e.type ===`, `.type ===`, `type ===` (EntityType comparisons).
  return /\.type\s*$/.test(lineBefore) || /\btype\s*$/.test(lineBefore);
}

function countFactionChecks(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const hits = [];
  const lines = text.split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    const line = lines[lineNo];
    for (const m of line.matchAll(PATTERN)) {
      const before = line.slice(0, m.index);
      if (isFalsePositive(before)) continue;
      hits.push({ line: lineNo + 1, text: line.trim() });
    }
  }
  return hits;
}

test('faction string-check allowlist is not exceeded', () => {
  const roots = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'server')];
  const files = roots.flatMap(r => walkJs(r));

  const violations = [];
  const unexpectedHits = [];
  const drifts = [];

  for (const f of files) {
    const rel = relative(REPO_ROOT, f);
    const hits = countFactionChecks(f);
    const allowed = ALLOWLIST[rel] ?? 0;

    if (hits.length > allowed) {
      violations.push({ file: rel, allowed, actual: hits.length, hits });
    } else if (allowed > 0 && hits.length < allowed) {
      drifts.push({ file: rel, allowed, actual: hits.length });
    } else if (allowed === 0 && hits.length > 0) {
      unexpectedHits.push({ file: rel, hits });
    }
  }

  // Stale entries — files in allowlist that don't exist anymore.
  const fileSet = new Set(files.map(f => relative(REPO_ROOT, f)));
  const staleEntries = Object.keys(ALLOWLIST).filter(f => !fileSet.has(f));

  const lines = [];
  if (violations.length > 0) {
    lines.push('New faction string checks detected:');
    for (const v of violations) {
      lines.push(`  ${v.file}: ${v.actual} (allowed: ${v.allowed})`);
      for (const h of v.hits.slice(0, 5)) lines.push(`    L${h.line}: ${h.text}`);
      if (v.hits.length > 5) lines.push(`    … ${v.hits.length - 5} more`);
    }
    lines.push('');
    lines.push('Prefer `getFaction(id)` / `allFactions()` / Faction methods over literal');
    lines.push('checks. See docs/design/refactor.md for context.');
  }
  if (unexpectedHits.length > 0) {
    lines.push('Files not in ALLOWLIST contain faction string checks:');
    for (const u of unexpectedHits) {
      lines.push(`  ${u.file}: ${u.hits.length}`);
      for (const h of u.hits.slice(0, 3)) lines.push(`    L${h.line}: ${h.text}`);
    }
  }
  if (staleEntries.length > 0) {
    lines.push('Stale ALLOWLIST entries (files no longer exist):');
    for (const s of staleEntries) lines.push(`  ${s}`);
  }

  assert.equal(
    lines.length,
    0,
    '\n' + lines.join('\n') + '\n',
  );

  // Drift-down is not a failure, but surface it so the allowlist stays
  // current. Node's test runner prints this only on --verbose; that's fine.
  if (drifts.length > 0) {
    const msg = drifts.map(d =>
      `  ${d.file}: ${d.actual} (allowed: ${d.allowed}) — ratchet down`
    ).join('\n');
    // Write directly so it's visible without extra reporters.
    process.stdout.write(`\n[faction-string-checks] allowlist drifted lower:\n${msg}\n`);
  }
});
