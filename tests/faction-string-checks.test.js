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
  // server/lobby.js bumped from 73 → 74 in PR 5 of the faction-expansion
  // work: stub-faction wiring needs a `faction === 'hero'` branch in
  // `_swapStubLeader` to look up the side-default leader on state.
  // See docs/design/faction-expansion.md.
  'server/lobby.js':             74,
  // src/main.js bumped 45 → 46 (2026-06-11): the scenario dev-loader's
  // `pov: 'hero'` flag (initScenario) selects which side is human-controlled
  // so fog-of-war repros have an observer — a loader config check, not a
  // faction-behavior branch.
  // src/main.js bumped 46 → 47 (2026-06-17, campaign start party-cap): the
  // final START-cap guard counts hero-faction survivors at mission start via
  // `e.owner === 'hero'` to trim any over-cap party down to ≤3. This mirrors the
  // adjacent min/max balancing filter's established `owner === 'hero' && type
  // === SURVIVOR` style (campaign is hero-only single-player, so it's a genuine
  // player-faction count). Ratchet down if a Faction.side helper is adopted here.
  // src/main.js bumped 47 → 50 (2026-06-18, Ledger menu): _collectReplayRows
  // (the ledger's completed-games feed) duplicates the winner/faction labelling
  // already in _renderReplaysList (the 3 `g.winner === 'hero'` / `faction ===
  // 'hero'` checks). Temporary duplication — at cutover _renderReplaysList
  // delegates to _collectReplayRows and this ratchets back to 47.
  // src/main.js bumped 50 → 51 (2026-06-22, Mission 1 stuck-replay fix):
  // _runLocalResolution reads the PRE-resolution snapshot for whether the witch
  // side fielded any unit this round (`e.owner === 'witch'`), so peekVictory()'s
  // mission-logic "all enemies dead" proxy can tell a real wipe (the prologue
  // golem) from a hero-only mission. A genuine night-side count on a plain JSON
  // snapshot (no Entity/Faction methods available there). Ratchet down if a
  // snapshot-side helper is adopted.
  'src/main.js':                 52,   // +1: captain reinforcement spawn-anim color keys on ev.faction
  'src/ui.js':                   25,

  // Pre-existing core modules — generalized in Finding 1, residual checks
  // are legacy and can be cleaned up opportunistically.
  //
  // Bumps during faction-expansion stub-parity sweep (documented inline):
  //   src/actions.js   7 → 10: added `actor.owner === 'hero'/'witch'`
  //     guards around Summon / Sound Horn / Sound-Horn-execute so stub
  //     leaders (Rogue/Captain/Necromancer/Brute) inherit the action.
  //   src/ai.js        6 →  7: PlanSimState enemyOwner ternary — looks
  //     up the opposing side's owner string to find enemy leaders
  //     regardless of stub-faction leader type.
  //   src/factions.js  0 →  4: HeroFaction end-of-round healing loops
  //     and WitchFaction.canExplore now match all leaders on the side
  //     via `owner === '…' && isLeaderType(type)` rather than a fixed
  //     entity type.
  //   src/ui.js       24 → 25: summon-picker rendering widened to any
  //     night-side leader.
  // src/entities.js 0 → 1 (2026-06-15, Phase C campaign XP): awardXP() gates
  //   veterancy to player-faction (hero) units via `owner !== 'hero'`. XP is a
  //   hero-only mechanic (only hero units persist across missions), so this is a
  //   real faction-behavior branch. The faction `side` abstraction would be the
  //   N-faction-correct vocabulary, but entities.js cannot import factions.js
  //   (factions.js already imports entities.js — circular), so the literal owner
  //   check matches the established style in actions.js. Ratchet down if the
  //   import direction is ever inverted.
  'src/entities.js':              1,
  'src/game.js':                 25,
  'src/ai-engine.js':            18,
  'src/hero-ai-engine.js':       17,
  'src/actions.js':              10,
  'src/renderer.js':              8,
  'server/async-game-rooms.js':   8,
  'src/ai.js':                    7,
  'server/async-game.js':         6,
  'src/factions.js':              4,

  // Display-layer dispatch (CSS classes, glyphs, node-control branches).
  'src/ui-render.js':             4,

  // Inherent to 2-faction battle-room protocol — legitimately faction-keyed.
  'server/battle-scheduler.js':   4,

  // Small pre-existing tails.
  'server/notifications.js':      3,
  'src/ai-debug.js':              2,  // debug glyph + summary rows
  'src/map.js':                   2,
  'src/planner.js':               4,   // +2: captain SUMMON ghost/projected-inventory branch on the day side
  'server/admin.js':              2,
  'server/game-stats.js':         2,
  'server/resolver.js':           2,

  // Hardcoded tutorial scenarios (2-faction by design).
  'src/tutorial/tutorial-config.js': 1,
  'src/tutorial.js':                 1,

  // Debug/admin tooling — cosmetic faction-keyed colour in the combat tester's
  // death-flash (hero gold vs witch purple). Not shipped game logic; low value
  // to abstract. Ratchet down opportunistically if the tool is reworked.
  'src/tools/combat-tester-ui.js':   1,
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
