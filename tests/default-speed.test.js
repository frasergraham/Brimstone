// Tests for the default game speed option.
//
// The combat-detail controls (#replay-detail-btn + the Options "Default Game
// Speed" section) are HIDDEN for now — playback is pinned to 'fast' (Summary)
// and the stored preference is IGNORED, so a stale saved mode can't invisibly
// lock a player into a presentation they have no UI to leave. These tests
// mirror UIController._loadDefaultSpeed; if the controls come back, restore
// the localStorage-honouring variants from git history.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Minimal localStorage shim for Node.js tests
const _store = {};
globalThis.localStorage = {
  getItem(k)    { return _store[k] ?? null; },
  setItem(k, v) { _store[k] = String(v); },
  removeItem(k) { delete _store[k]; },
};

// Clear store between tests
beforeEach(() => {
  for (const k of Object.keys(_store)) delete _store[k];
});

// Mirror the logic from UIController._loadDefaultSpeed (pinned while the
// detail controls are hidden).
function loadDefaultSpeed() {
  return 'fast';
}

describe('default game speed (pinned while detail controls are hidden)', () => {
  test('returns fast (Summary) when nothing is stored', () => {
    assert.equal(loadDefaultSpeed(), 'fast');
  });

  test('ignores a stored cinematic preference', () => {
    localStorage.setItem('brimstone-default-speed', 'cinematic');
    assert.equal(loadDefaultSpeed(), 'fast');
  });

  test('ignores a stored vfast preference', () => {
    localStorage.setItem('brimstone-default-speed', 'vfast');
    assert.equal(loadDefaultSpeed(), 'fast');
  });

  test('ignores legacy/invalid stored values', () => {
    localStorage.setItem('brimstone-default-speed', 'step');
    assert.equal(loadDefaultSpeed(), 'fast');
    localStorage.setItem('brimstone-default-speed', 'turbo');
    assert.equal(loadDefaultSpeed(), 'fast');
  });
});
