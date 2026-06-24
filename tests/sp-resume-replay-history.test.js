// Regression: resuming a saved single-player skirmish must restore the previous
// round's replay history so the in-planning "Last Turn" replay button appears,
// exactly as it does right after a normal round resolves.
//
// Root-cause bug this guards: _runLocalResolution() persisted single-player
// progress with _saveSpGame() BEFORE appending the just-resolved round to
// _roundHistory. _saveSpGame() serializes _roundHistory to
// localStorage['brimstone_sp_history_<id>'], so the persisted history always
// lagged one round behind the live game. On resume, _resumeSpSave() read that
// stale history — empty after the first resolved round — so the "Last Turn"
// button stayed hidden (or replayed the wrong turn).
//
// The finalize + persist sequence now lives in the `finalizeAndPersistRound`
// helper (src/round-finalize.js), wired from _runLocalResolution: the round is
// appended to _roundHistory and then saved BEFORE the replay watch, so a
// mid-replay close/crash no longer loses the round. The push-before-save
// ordering is preserved inside the helper's callbacks (asserted below + in
// tests/save-round-before-replay.test.js).
//
// main.js is DOM-heavy and not unit-instantiable here, so these are
// source-level guards (same approach as save-resume-replay-wrapup.test.js):
// they read src/main.js and assert the ordering + resume wiring stay intact.
// The button-visibility contract (enterPlanningMode reads _hasReplayHistory) is
// covered behaviorally in tests/ui/replay-button.test.js.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const MAIN = readFileSync(join(__dirname, '..', 'src', 'main.js'), 'utf8');

/** Slice the body of a top-level `function NAME(` or `async function NAME(` by
 *  brace-matching from its opening brace. */
function functionBody(src, name) {
  const sig = src.includes(`async function ${name}(`)
    ? `async function ${name}(`
    : `function ${name}(`;
  const start = src.indexOf(sig);
  assert.notEqual(start, -1, `expected ${name} in src/main.js`);
  let i = src.indexOf('{', start);
  assert.notEqual(i, -1, `expected an opening brace for ${name}`);
  let depth = 0;
  const from = i;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') { depth--; if (depth === 0) return src.slice(from, i + 1); }
  }
  throw new Error(`unbalanced braces parsing ${name}`);
}

// ── The ordering fix: push the round before persisting it ─────────────────────

test('_runLocalResolution appends the resolved round to _roundHistory BEFORE _saveSpGame', () => {
  // The finalize + persist sequence is driven through finalizeAndPersistRound:
  // the round-history push lives in its `appendRoundHistory` callback and the
  // single-player save is wired as `saveSp: _saveSpGame`. The helper guarantees
  // appendRoundHistory runs before saveSp (covered in round-finalize's own
  // test); here we assert the two call sites are wired in the right textual
  // order so the round is pushed before _saveSpGame serializes it.
  const body = functionBody(MAIN, '_runLocalResolution');

  const pushIdx = body.indexOf('_roundHistory.push({');
  // The persist wiring: `saveSp: _saveSpGame` (a reference handed to the helper).
  const saveIdx = body.search(/saveSp:\s*_saveSpGame/);

  assert.notEqual(pushIdx, -1, '_runLocalResolution must push the resolved round onto _roundHistory');
  assert.notEqual(saveIdx, -1, '_runLocalResolution must persist single-player progress via _saveSpGame()');

  assert.ok(pushIdx < saveIdx,
    'the just-resolved round must be appended to _roundHistory BEFORE _saveSpGame ' +
    'serializes it — otherwise the persisted history lags a round and the resumed ' +
    'save shows no "Last Turn" replay button');
});

test('_runLocalResolution finalizes + persists the round BEFORE the replay watch', () => {
  // The whole point of the change: the round is durably saved the instant it is
  // computed, not after the player watches the (blocking) replay animation.
  const body = functionBody(MAIN, '_runLocalResolution');
  const finalizeIdx = body.indexOf('finalizeAndPersistRound');
  const watchIdx    = body.indexOf('_animateResolutionSteps');
  assert.notEqual(finalizeIdx, -1, '_runLocalResolution must call finalizeAndPersistRound');
  assert.notEqual(watchIdx, -1, '_runLocalResolution must animate the resolution');
  assert.ok(finalizeIdx < watchIdx,
    'finalize + persist must precede the replay watch so a mid-replay close/crash ' +
    'cannot lose the just-computed round');
});

// ── _saveSpGame persists _roundHistory under the per-save key ──────────────────

test('_saveSpGame persists _roundHistory to the brimstone_sp_history_<id> key', () => {
  const body = functionBody(MAIN, '_saveSpGame');

  assert.match(body, /localStorage\.setItem\(\s*['"]brimstone_sp_history_['"]\s*\+\s*_spSaveId\s*,\s*JSON\.stringify\(_roundHistory\)/,
    '_saveSpGame must serialize _roundHistory to localStorage under brimstone_sp_history_<id>');
});

// ── _resumeSpSave reads the stored history back and feeds it into the game ─────

test('_resumeSpSave restores the stored round history on resume', () => {
  const body = functionBody(MAIN, '_resumeSpSave');

  assert.match(body, /localStorage\.getItem\(\s*['"]brimstone_sp_history_['"]\s*\+\s*save\.id\s*\)/,
    '_resumeSpSave must read the persisted history from brimstone_sp_history_<id>');
  assert.match(body, /_startFromState\([^)]*priorHistory/,
    '_resumeSpSave must hand the restored history to _startFromState');
});

test('_startFromState seeds _roundHistory from the restored history', () => {
  const body = functionBody(MAIN, '_startFromState');

  assert.match(body, /_roundHistory\s*=\s*existingHistory/,
    '_startFromState must seed _roundHistory from the restored history so the ' +
    'replay button reflects the resumed game');
});

// ── enterPlanningMode gates the button on history (set from _roundHistory) ─────

test('_enterLocalPlanningMode enables the replay button when history exists, not otherwise', () => {
  const body = functionBody(MAIN, '_enterLocalPlanningMode');

  // The flag is derived from _roundHistory length: non-empty ⇒ button shown
  // (happy path / resume), empty ⇒ button hidden (round 1, never resolved).
  assert.match(body, /ui\._hasReplayHistory\s*=\s*_roundHistory\.length\s*>\s*0/,
    '_enterLocalPlanningMode must gate the "Last Turn" button on _roundHistory ' +
    'length so a resumed save with history shows it and a fresh round-1 save does not');
});
