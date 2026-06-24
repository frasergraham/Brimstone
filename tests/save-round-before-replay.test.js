// Regression: an offline round must be DURABLY PERSISTED the instant it is
// computed (replay-ready), NOT after the player finishes watching the replay.
// Closing/crashing mid-replay used to lose the just-computed round because both
// offline saves (single-player + campaign mid-mission) were gated behind the
// blocking `await _animateResolutionSteps(...)` watch.
//
// Two layers of proof:
//   1. The extracted `finalizeAndPersistRound` helper runs its Sim + persist
//      sequence in the fixed order, and the saves fire as part of it (decoupled
//      from any animation).
//   2. A source-level guard over `_runLocalResolution` in src/main.js: the
//      finalize + save now happen BEFORE the first-watch `_animateResolutionSteps`
//      call. RED on the old ordering (save after animate), GREEN after the fix.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { GameState } from '../src/game.js';
import { finalizeAndPersistRound } from '../src/round-finalize.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MAIN_JS = join(__dirname, '..', 'src', 'main.js');

describe('finalizeAndPersistRound — Sim + persist ordering', () => {
  test('runs summary → finalizeRound → roundHistory → saves, in that order', () => {
    const state = new GameState(true, true);
    const order = [];
    const realFinalize = state.finalizeRound.bind(state);
    state.finalizeRound = () => { order.push('finalize'); realFinalize(); };

    const result = finalizeAndPersistRound({
      state,
      compileSummary:     () => { order.push('summary'); return []; },
      renderLog:          () => order.push('renderLog'),
      appendRoundHistory: () => order.push('roundHistory'),
      saveSp:             () => order.push('saveSp'),
      saveCampaign:       () => order.push('saveCampaign'),
    });

    // summary must precede finalize (its log line goes in before phase entries);
    // roundHistory must precede the saves (saveSp serializes the history);
    // and both saves are part of this synchronous unit — no animation involved.
    assert.deepEqual(order, ['summary', 'finalize', 'roundHistory', 'saveSp', 'saveCampaign']);
    assert.equal(typeof result.roundPhase, 'string');
    assert.ok(result.prevScore && 'hero' in result.prevScore && 'witch' in result.prevScore);
  });

  test('roundHistory is appended BEFORE saveSp (persisted history stays in lockstep)', () => {
    const state = new GameState(true, true);
    const order = [];
    finalizeAndPersistRound({
      state,
      compileSummary:     () => [],
      appendRoundHistory: () => order.push('roundHistory'),
      saveSp:             () => order.push('saveSp'),
      saveCampaign:       () => {},
    });
    assert.ok(order.indexOf('roundHistory') < order.indexOf('saveSp'),
      'roundHistory must be pushed before saveSp serializes it');
  });

  test('prevScore + roundPhase are captured BEFORE finalizeRound advances them', () => {
    const state = new GameState(true, true);
    const phaseBefore = state.phase;
    const scoreBefore = { hero: state.nodeScore.hero, witch: state.nodeScore.witch };
    const { prevScore, roundPhase } = finalizeAndPersistRound({
      state,
      compileSummary:     () => [],
      appendRoundHistory: () => {},
      saveSp:             () => {},
      saveCampaign:       () => {},
    });
    assert.equal(roundPhase, phaseBefore, 'roundPhase = the round\'s fought phase, pre-advance');
    assert.deepEqual(prevScore, scoreBefore, 'prevScore = pre-finalizeRound node score');
  });
});

describe('_runLocalResolution — save happens before the replay watch (source guard)', () => {
  // Extract the body of `async function _runLocalResolution(...)` so the guard
  // only inspects the offline first-watch path (not the online/full-replay
  // siblings elsewhere in main.js).
  function localResolutionBody() {
    const src = readFileSync(MAIN_JS, 'utf8');
    const start = src.indexOf('async function _runLocalResolution');
    assert.ok(start >= 0, '_runLocalResolution should exist');
    // Walk braces from the function\'s opening { to its matching }.
    const open = src.indexOf('{', start);
    let depth = 0, i = open;
    for (; i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') { depth--; if (depth === 0) break; }
    }
    return src.slice(open, i + 1);
  }

  test('finalize + persist is wired BEFORE the first _animateResolutionSteps watch', () => {
    const body = localResolutionBody();

    const idxFinalize = body.indexOf('finalizeAndPersistRound');
    assert.ok(idxFinalize >= 0,
      '_runLocalResolution should call finalizeAndPersistRound (the extracted Sim+persist unit)');

    // The first-watch animation: the do/while loop driving the inline replay.
    const idxFirstWatch = body.indexOf('_animateResolutionSteps');
    assert.ok(idxFirstWatch >= 0, '_runLocalResolution should animate the resolution');

    assert.ok(idxFinalize < idxFirstWatch,
      'the round must be finalized + saved BEFORE the player watches the replay; ' +
      'otherwise a mid-replay close/crash loses the just-computed round');
  });

  test('the first watch is phase-pinned (replay matches the round\'s fought phase)', () => {
    const body = localResolutionBody();
    // After finalizeRound advances the phase, the first watch must pin back to
    // the round\'s fought phase — same mechanism the re-watch uses.
    const idxPin = body.indexOf('withPinnedPhase');
    const idxFirstWatch = body.indexOf('_animateResolutionSteps');
    assert.ok(idxPin >= 0 && idxPin < idxFirstWatch,
      'the first watch must run inside withPinnedPhase(state, roundPhase, ...)');
  });
});
