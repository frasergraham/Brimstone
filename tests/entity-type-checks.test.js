// Guardrail: prevent new `=== EntityType.HERO` / `=== EntityType.WITCH`
// (and `!==` variants) from creeping into the codebase.
//
// `EntityType.HERO` is kept as a legacy alias of `EntityType.PALADIN`
// (both resolve to 'paladin') so the faction-expansion rename didn't
// touch every caller. But every `=== EntityType.HERO` check now means
// "specifically the Paladin leader", which silently misses Rogue /
// Captain stub leaders on the day side — and likewise
// `=== EntityType.WITCH` misses Necromancer / Brute stubs on the night
// side. Those turned into correctness bugs in `ai-engine.js` and
// `hero-ai-engine.js` that shipped in the first pass of this PR.
//
// The right replacement depends on intent:
//   - "is this any leader?"           → `isLeaderType(type)`
//   - "is this specifically a Paladin?" → `=== EntityType.PALADIN`
//
// This test locks the current count per file. Adding a new comparison
// fails the test with a pointer; removing/replacing one lets you
// ratchet the number down.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = join(__dirname, '..');

// `EntityType.HERO`, `EntityType.WITCH`, `EntityType.hero`, etc. preceded
// by `===` or `!==`. The lowercase form shouldn't appear, but matching
// case-sensitively keeps the regex tight.
const PATTERN = /[!=]==\s*EntityType\.(HERO|WITCH)\b/g;

// Files allowed to retain `=== EntityType.HERO/WITCH` checks, and their
// permitted count. Narrow to specific semantics when possible — most
// leader-ish checks should use `isLeaderType()` instead.
const ALLOWLIST = Object.freeze({
  // Tutorial scenarios are hardcoded 2-faction by design.
  'src/tutorial.js':                 1,
  'src/tutorial/tutorial-config.js': 1,

  // scripts/game-render.js is an offline screenshot renderer keyed to
  // the default side leaders; the stubs render via a separate path.
  // Three lines, but L453's compound `HERO || WITCH` counts as two hits.
  'scripts/game-render.js':          4,
});

function walkJs(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walkJs(p, acc);
    else if (p.endsWith('.js')) acc.push(p);
  }
  return acc;
}

function countHits(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const hits = [];
  const lines = text.split('\n');
  for (let lineNo = 0; lineNo < lines.length; lineNo++) {
    for (const m of lines[lineNo].matchAll(PATTERN)) {
      hits.push({ line: lineNo + 1, text: lines[lineNo].trim(), match: m[0] });
    }
  }
  return hits;
}

test('EntityType.HERO/WITCH comparison ratchet is not exceeded', () => {
  const roots = [join(REPO_ROOT, 'src'), join(REPO_ROOT, 'server'), join(REPO_ROOT, 'scripts')];
  const files = roots.flatMap(r => walkJs(r));

  const violations = [];
  const unexpectedHits = [];

  for (const f of files) {
    const rel = relative(REPO_ROOT, f);
    const hits = countHits(f);
    const allowed = ALLOWLIST[rel] ?? 0;

    if (hits.length > allowed) {
      violations.push({ file: rel, allowed, actual: hits.length, hits });
    } else if (allowed === 0 && hits.length > 0) {
      unexpectedHits.push({ file: rel, hits });
    }
  }

  const lines = [];
  if (violations.length > 0) {
    lines.push('New EntityType.HERO/WITCH equality checks detected:');
    for (const v of violations) {
      lines.push(`  ${v.file}: ${v.actual} (allowed: ${v.allowed})`);
      for (const h of v.hits.slice(0, 5)) lines.push(`    L${h.line}: ${h.text}`);
      if (v.hits.length > 5) lines.push(`    … ${v.hits.length - 5} more`);
    }
    lines.push('');
    lines.push('Prefer `isLeaderType(type)` for "any side leader",');
    lines.push('or `=== EntityType.PALADIN` when you specifically mean the Paladin entity.');
    lines.push('See docs/design/faction-expansion.md for context.');
  }
  if (unexpectedHits.length > 0) {
    lines.push('Files not in ALLOWLIST contain EntityType.HERO/WITCH equality checks:');
    for (const u of unexpectedHits) {
      lines.push(`  ${u.file}: ${u.hits.length}`);
      for (const h of u.hits.slice(0, 3)) lines.push(`    L${h.line}: ${h.text}`);
    }
  }

  assert.equal(lines.length, 0, '\n' + lines.join('\n') + '\n');
});
