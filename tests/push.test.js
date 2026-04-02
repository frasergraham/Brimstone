// Tests for server/push.js — device token DB helpers.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import {
  upsertDeviceToken, deleteDeviceToken, getDeviceTokens, pruneStaleTokens,
} from '../server/push.js';
import db from '../server/db.js';

// Seed test players and clean up any leftover tokens
before(() => {
  db.prepare(`
    INSERT OR IGNORE INTO players (id, username, token) VALUES (?, ?, ?)
  `).run('push-test-player', 'pushuser', 'push-tok-1');
  db.prepare(`
    INSERT OR IGNORE INTO players (id, username, token) VALUES (?, ?, ?)
  `).run('push-test-player-2', 'pushuser2', 'push-tok-2');
  db.prepare(`DELETE FROM device_tokens WHERE player_id IN (?, ?)`).run('push-test-player', 'push-test-player-2');
});

describe('device token DB helpers', () => {
  test('upsertDeviceToken inserts a new token', () => {
    upsertDeviceToken('push-test-player', 'device-aaa', 'ios');
    const tokens = getDeviceTokens('push-test-player');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].token, 'device-aaa');
    assert.equal(tokens[0].platform, 'ios');
  });

  test('upsertDeviceToken updates existing token', () => {
    upsertDeviceToken('push-test-player', 'device-aaa', 'ios');
    const tokens = getDeviceTokens('push-test-player');
    assert.equal(tokens.length, 1, 'should not duplicate');
  });

  test('multiple devices per player', () => {
    upsertDeviceToken('push-test-player', 'device-bbb', 'ios');
    const tokens = getDeviceTokens('push-test-player');
    assert.equal(tokens.length, 2);
    const tokenValues = tokens.map(t => t.token).sort();
    assert.deepEqual(tokenValues, ['device-aaa', 'device-bbb']);
  });

  test('deleteDeviceToken removes a specific token', () => {
    deleteDeviceToken('push-test-player', 'device-aaa');
    const tokens = getDeviceTokens('push-test-player');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].token, 'device-bbb');
  });

  test('getDeviceTokens returns empty array for unknown player', () => {
    const tokens = getDeviceTokens('nonexistent-player');
    assert.equal(tokens.length, 0);
  });

  test('tokens are scoped to player', () => {
    upsertDeviceToken('push-test-player-2', 'device-ccc', 'ios');
    const p1 = getDeviceTokens('push-test-player');
    const p2 = getDeviceTokens('push-test-player-2');
    assert.ok(!p1.some(t => t.token === 'device-ccc'), 'player 1 should not see player 2 tokens');
    assert.ok(p2.some(t => t.token === 'device-ccc'), 'player 2 should see own token');
  });

  test('pruneStaleTokens removes old tokens', () => {
    // Insert a token with an old updated_at
    db.prepare(`
      INSERT OR REPLACE INTO device_tokens (player_id, token, platform, updated_at)
      VALUES (?, ?, ?, ?)
    `).run('push-test-player', 'device-old', 'ios', 1000);

    const before = getDeviceTokens('push-test-player');
    assert.ok(before.some(t => t.token === 'device-old'));

    pruneStaleTokens(90);

    const after = getDeviceTokens('push-test-player');
    assert.ok(!after.some(t => t.token === 'device-old'), 'old token should be pruned');
    assert.ok(after.some(t => t.token === 'device-bbb'), 'recent token should remain');
  });
});
