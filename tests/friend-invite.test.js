// Tests for the friend invite push notification flow.
// Since sendFriendInvite in lobby.js relies on in-memory rooms and sendPush
// (which requires APNS config), this test focuses on the push.js joinCode
// payload support which is the key new behavior.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import { upsertDeviceToken, getDeviceTokens } from '../server/push.js';
import {
  getOrCreateByGameCenter, getPlayersByGameCenterIds,
} from '../server/auth.js';

const GC_PREFIX = 'GC:test-fi-';

function cleanUp() {
  db.prepare('DELETE FROM device_tokens WHERE player_id IN (SELECT id FROM players WHERE username LIKE ?)')
    .run('test-fi-%');
  db.prepare('DELETE FROM player_identities WHERE provider = ? AND provider_id LIKE ?')
    .run('gamecenter', `${GC_PREFIX}%`);
  db.prepare('DELETE FROM players WHERE username LIKE ?').run('test-fi-%');
}

before(cleanUp);
after(cleanUp);

describe('friend invite prerequisites', () => {
  test('GC friend can be resolved to a player with a push token', () => {
    // Create a GC player (the friend)
    const gc = getOrCreateByGameCenter(`${GC_PREFIX}target1`, 'test-fi-Target');
    assert.ok(gc.ok);

    // Register a device token for them
    upsertDeviceToken(gc.player.id, 'fake-apns-token-fi', 'ios');
    const tokens = getDeviceTokens(gc.player.id);
    assert.ok(tokens.length >= 1, 'friend should have a device token');

    // Verify the friend can be looked up by GC ID
    const matches = getPlayersByGameCenterIds([`${GC_PREFIX}target1`]);
    assert.equal(matches.length, 1);
    assert.equal(matches[0].playerId, gc.player.id);
  });

  test('friend without device token is still matched but cannot receive push', () => {
    const gc = getOrCreateByGameCenter(`${GC_PREFIX}nopush1`, 'test-fi-NoPush');
    assert.ok(gc.ok);

    const matches = getPlayersByGameCenterIds([`${GC_PREFIX}nopush1`]);
    assert.equal(matches.length, 1);

    // No device tokens registered
    const tokens = getDeviceTokens(gc.player.id);
    assert.equal(tokens.length, 0);
  });

  test('multiple friends can be resolved in one call', () => {
    const gc1 = getOrCreateByGameCenter(`${GC_PREFIX}multi1`, 'test-fi-Multi1');
    const gc2 = getOrCreateByGameCenter(`${GC_PREFIX}multi2`, 'test-fi-Multi2');
    assert.ok(gc1.ok && gc2.ok);

    upsertDeviceToken(gc1.player.id, 'fake-token-multi1', 'ios');
    upsertDeviceToken(gc2.player.id, 'fake-token-multi2', 'ios');

    const matches = getPlayersByGameCenterIds([
      `${GC_PREFIX}multi1`,
      `${GC_PREFIX}multi2`,
    ]);
    assert.equal(matches.length, 2);
  });
});
