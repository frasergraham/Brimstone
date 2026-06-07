// Tests for GameState.finalizeRound() — the shared post-resolution sequence
// extracted so the offline (src/main.js) and online (server/lobby.js)
// orchestrators cannot drift. It must run exactly:
//   updateNodeDiscovery → checkAndLogNodeControlChanges → updateExploredHexes
//   → endRound
// in that order, every time.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState } from '../src/game.js';

describe('GameState.finalizeRound', () => {
  test('invokes the four post-resolution steps in the fixed order', () => {
    const state = new GameState(true, true);
    const calls = [];
    // Spy by replacing the instance methods (prototype untouched).
    for (const name of ['updateNodeDiscovery', 'checkAndLogNodeControlChanges',
                        'updateExploredHexes', 'endRound']) {
      state[name] = () => { calls.push(name); };
    }
    state.finalizeRound();
    assert.deepEqual(calls, [
      'updateNodeDiscovery',
      'checkAndLogNodeControlChanges',
      'updateExploredHexes',
      'endRound',
    ]);
  });

  test('endRound runs last and advances the round', () => {
    const state = new GameState(true, true);
    const before = state.round;
    state.finalizeRound();
    assert.equal(state.round, before + 1, 'finalizeRound should advance the round via endRound');
  });
});
