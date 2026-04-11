// Unit tests for ReplayCache (src/replay-cache.js).
//
// The cache is keyed by roundNum. Historically, the client grabbed
// _onlineRoundHistory[length-1] without validating the round number,
// which could silently return the wrong replay after a desync.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ReplayCache } from '../src/replay-cache.js';

describe('ReplayCache', () => {
  test('starts empty', () => {
    const c = new ReplayCache();
    assert.equal(c.size, 0);
    assert.equal(c.get(1), null);
    assert.equal(c.has(1), false);
  });

  test('set and get by roundNum', () => {
    const c = new ReplayCache();
    const entry = { roundNum: 3, preStateJson: '{"round":3}', stepsJson: '[]' };
    assert.equal(c.set(entry), true);
    assert.equal(c.size, 1);
    assert.equal(c.has(3), true);
    const got = c.get(3);
    assert.equal(got.roundNum, 3);
    assert.equal(got.preStateJson, '{"round":3}');
    assert.equal(got.stepsJson, '[]');
  });

  test('get returns null for missing round', () => {
    const c = new ReplayCache();
    c.set({ roundNum: 2, preStateJson: '{}', stepsJson: '[]' });
    assert.equal(c.get(1), null);
    assert.equal(c.get(3), null);
  });

  test('set replaces entries on duplicate roundNum', () => {
    const c = new ReplayCache();
    c.set({ roundNum: 1, preStateJson: '{"v":1}', stepsJson: '[]' });
    c.set({ roundNum: 1, preStateJson: '{"v":2}', stepsJson: '[1]' });
    assert.equal(c.size, 1);
    assert.equal(c.get(1).preStateJson, '{"v":2}');
    assert.equal(c.get(1).stepsJson, '[1]');
  });

  test('set rejects invalid entries', () => {
    const c = new ReplayCache();
    assert.equal(c.set(null), false);
    assert.equal(c.set({}), false);
    assert.equal(c.set({ roundNum: 'bad', preStateJson: '{}', stepsJson: '[]' }), false);
    assert.equal(c.set({ roundNum: 1, preStateJson: null, stepsJson: '[]' }), false);
    assert.equal(c.set({ roundNum: 1, preStateJson: '{}', stepsJson: 42 }), false);
    assert.equal(c.size, 0);
  });

  test('clear removes all entries', () => {
    const c = new ReplayCache();
    c.set({ roundNum: 1, preStateJson: '{}', stepsJson: '[]' });
    c.set({ roundNum: 2, preStateJson: '{}', stepsJson: '[]' });
    assert.equal(c.size, 2);
    c.clear();
    assert.equal(c.size, 0);
    assert.equal(c.get(1), null);
    assert.equal(c.get(2), null);
  });

  test('entries stored by value (not reference)', () => {
    const c = new ReplayCache();
    const input = { roundNum: 5, preStateJson: '{}', stepsJson: '[]', extra: 'junk' };
    c.set(input);
    const got = c.get(5);
    // Only the three known fields should make it into the cache
    assert.equal(got.extra, undefined);
    // Mutating the original doesn't affect the cached entry
    input.preStateJson = 'MUTATED';
    assert.equal(c.get(5).preStateJson, '{}');
  });
});
