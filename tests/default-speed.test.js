// Tests for the default game speed option (localStorage persistence).

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

// Mirror the logic from UIController._loadDefaultSpeed
const VALID_SPEEDS = { step: true, cinematic: true, fast: true, vfast: true };
function loadDefaultSpeed() {
  try {
    const saved = localStorage.getItem('brimstone-default-speed');
    if (saved && VALID_SPEEDS[saved]) return saved;
  } catch (_) { /* localStorage unavailable */ }
  return 'cinematic';
}

describe('default game speed', () => {
  test('returns cinematic when nothing is stored', () => {
    assert.equal(loadDefaultSpeed(), 'cinematic');
  });

  test('returns stored speed when valid', () => {
    localStorage.setItem('brimstone-default-speed', 'fast');
    assert.equal(loadDefaultSpeed(), 'fast');
  });

  test('returns stored vfast speed', () => {
    localStorage.setItem('brimstone-default-speed', 'vfast');
    assert.equal(loadDefaultSpeed(), 'vfast');
  });

  test('returns stored step speed', () => {
    localStorage.setItem('brimstone-default-speed', 'step');
    assert.equal(loadDefaultSpeed(), 'step');
  });

  test('falls back to cinematic for invalid value', () => {
    localStorage.setItem('brimstone-default-speed', 'turbo');
    assert.equal(loadDefaultSpeed(), 'cinematic');
  });

  test('falls back to cinematic for empty string', () => {
    localStorage.setItem('brimstone-default-speed', '');
    assert.equal(loadDefaultSpeed(), 'cinematic');
  });
});
