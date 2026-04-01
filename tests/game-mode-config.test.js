// Tests for server/game-mode-config.js — environment-variable-driven game mode visibility.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// We need to re-import after mutating env, so use dynamic import with cache busting.
// Instead, we import once and rely on the function reading process.env each call.
import { getGameModeConfig, MODE_ENV_KEYS, VALID_STATES } from '../server/game-mode-config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const ALL_MODES = Object.keys(MODE_ENV_KEYS);
let savedEnv;

function saveEnv() {
  savedEnv = {};
  for (const key of Object.values(MODE_ENV_KEYS)) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv() {
  for (const [key, val] of Object.entries(savedEnv)) {
    if (val === undefined) delete process.env[key];
    else process.env[key] = val;
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('getGameModeConfig', () => {
  beforeEach(saveEnv);
  afterEach(restoreEnv);

  test('all modes default to enabled when no env vars are set', () => {
    const config = getGameModeConfig();
    for (const mode of ALL_MODES) {
      assert.equal(config[mode], 'enabled', `${mode} should default to enabled`);
    }
  });

  test('respects "disabled" env var', () => {
    process.env.BRIMSTONE_MODE_TUTORIAL = 'disabled';
    const config = getGameModeConfig();
    assert.equal(config.tutorial, 'disabled');
    assert.equal(config.singleplayer, 'enabled');
  });

  test('respects "hidden" env var', () => {
    process.env.BRIMSTONE_MODE_MULTIPLAYER = 'hidden';
    const config = getGameModeConfig();
    assert.equal(config.multiplayer, 'hidden');
  });

  test('is case-insensitive', () => {
    process.env.BRIMSTONE_MODE_STORY = 'DISABLED';
    process.env.BRIMSTONE_MODE_LOCAL = 'Hidden';
    const config = getGameModeConfig();
    assert.equal(config.story, 'disabled');
    assert.equal(config.local, 'hidden');
  });

  test('trims whitespace', () => {
    process.env.BRIMSTONE_MODE_QUICKPLAY = '  disabled  ';
    const config = getGameModeConfig();
    assert.equal(config.quickplay, 'disabled');
  });

  test('invalid values fall back to enabled', () => {
    process.env.BRIMSTONE_MODE_SINGLEPLAYER = 'banana';
    process.env.BRIMSTONE_MODE_TUTORIAL = '';
    const config = getGameModeConfig();
    assert.equal(config.singleplayer, 'enabled');
    assert.equal(config.tutorial, 'enabled');
  });

  test('multiple modes can be configured independently', () => {
    process.env.BRIMSTONE_MODE_SINGLEPLAYER = 'disabled';
    process.env.BRIMSTONE_MODE_MULTIPLAYER = 'hidden';
    process.env.BRIMSTONE_MODE_TUTORIAL = 'disabled';
    const config = getGameModeConfig();
    assert.equal(config.singleplayer, 'disabled');
    assert.equal(config.multiplayer, 'hidden');
    assert.equal(config.tutorial, 'disabled');
    assert.equal(config.story, 'enabled');
    assert.equal(config.quickplay, 'enabled');
    assert.equal(config.local, 'enabled');
    assert.equal(config.async, 'enabled');
  });

  test('respects async mode env var', () => {
    process.env.BRIMSTONE_MODE_ASYNC = 'disabled';
    const config = getGameModeConfig();
    assert.equal(config.async, 'disabled');
  });

  test('returns all expected mode keys', () => {
    const config = getGameModeConfig();
    const keys = Object.keys(config).sort();
    const expected = ALL_MODES.sort();
    assert.deepEqual(keys, expected);
  });

  test('VALID_STATES contains expected values', () => {
    assert.deepEqual(VALID_STATES, ['enabled', 'disabled', 'hidden']);
  });
});
