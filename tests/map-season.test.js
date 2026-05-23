// Tests for the map-level `season` field — picked at procgen time, settable
// by campaign mapData overrides, and round-tripped through state-sync so it
// survives save/resume.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap, SEASONS } from '../src/map.js';
import { GameState } from '../src/game.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

describe('map — season field', () => {
  test('generateMap returns a season from the SEASONS set', () => {
    const result = generateMap(12345, 'standard');
    assert.ok(SEASONS.includes(result.season),
      `expected one of ${[...SEASONS].join('|')}, got ${result.season}`);
  });

  test('same seed → same season (deterministic)', () => {
    const a = generateMap(98765, 'standard');
    const b = generateMap(98765, 'standard');
    assert.equal(a.season, b.season);
  });

  test('different seeds eventually pick different seasons', () => {
    // Pull a handful of seeds — across 12 attempts we should see at least
    // two distinct seasons given a 4-element pool. If this ever fails it
    // means season selection has become constant (a regression).
    const seen = new Set();
    for (let i = 0; i < 12; i++) seen.add(generateMap(1000 + i, 'standard').season);
    assert.ok(seen.size >= 2, `expected ≥2 distinct seasons across 12 seeds, got ${[...seen].join(',')}`);
  });
});

describe('GameState — season propagation', () => {
  test('procgen GameState exposes a season from SEASONS', () => {
    const state = new GameState(true, true, 'standard');
    assert.ok(SEASONS.includes(state.season),
      `expected one of ${[...SEASONS].join('|')}, got ${state.season}`);
  });

  test('mapDataOverride can specify an explicit season (campaign maps)', () => {
    const baseMap = generateMap(1, 'standard');
    const override = { ...baseMap, season: 'winter' };
    const state = new GameState(true, true, 'standard', null, override);
    assert.equal(state.season, 'winter');
  });

  test('mapDataOverride without season leaves state.season null (legacy campaign maps)', () => {
    const baseMap = generateMap(1, 'standard');
    const { season: _drop, ...override } = baseMap;
    const state = new GameState(true, true, 'standard', null, override);
    assert.equal(state.season, null);
  });
});

describe('state-sync — season round-trip', () => {
  test('serialize → deserialize preserves season', () => {
    const state = new GameState(true, true, 'standard');
    const original = state.season;
    assert.ok(SEASONS.includes(original));

    const snap = serializeState(state);
    assert.equal(snap.season, original);

    const restored = deserializeState(snap);
    assert.equal(restored.season, original);
  });

  test('legacy snapshots without a season field hydrate to null', () => {
    const state = new GameState(true, true, 'standard');
    const snap = serializeState(state);
    delete snap.season;
    const restored = deserializeState(snap);
    assert.equal(restored.season, null);
  });
});
