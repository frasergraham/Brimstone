// Tests for getPlayersByGameCenterIds() in server/auth.js

import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  registerOrLogin, getOrCreateByGameCenter, getPlayersByGameCenterIds,
} from '../server/auth.js';

const GC_PREFIX = 'GC:test-gcfriends-';

function cleanUp() {
  db.prepare('DELETE FROM player_identities WHERE provider = ? AND provider_id LIKE ?')
    .run('gamecenter', `${GC_PREFIX}%`);
  db.prepare('DELETE FROM players WHERE username LIKE ?').run('test-gcf-%');
}

beforeEach(cleanUp);
after(cleanUp);

describe('getPlayersByGameCenterIds', () => {
  test('returns empty array for empty input', () => {
    const result = getPlayersByGameCenterIds([]);
    assert.deepEqual(result, []);
  });

  test('returns empty array for non-array input', () => {
    const result = getPlayersByGameCenterIds(null);
    assert.deepEqual(result, []);
  });

  test('matches known GC IDs to player records', () => {
    const gc1 = getOrCreateByGameCenter(`${GC_PREFIX}friend1`, 'test-gcf-Alice');
    const gc2 = getOrCreateByGameCenter(`${GC_PREFIX}friend2`, 'test-gcf-Bob');
    assert.ok(gc1.ok && gc2.ok);

    const matches = getPlayersByGameCenterIds([
      `${GC_PREFIX}friend1`,
      `${GC_PREFIX}friend2`,
    ]);

    assert.equal(matches.length, 2);
    const ids = matches.map(m => m.gamePlayerID).sort();
    assert.deepEqual(ids, [`${GC_PREFIX}friend1`, `${GC_PREFIX}friend2`]);
  });

  test('does not return unmatched IDs', () => {
    getOrCreateByGameCenter(`${GC_PREFIX}known1`, 'test-gcf-Known');

    const matches = getPlayersByGameCenterIds([
      `${GC_PREFIX}known1`,
      `${GC_PREFIX}unknown1`,
    ]);

    assert.equal(matches.length, 1);
    assert.equal(matches[0].gamePlayerID, `${GC_PREFIX}known1`);
  });

  test('returns correct shape: gamePlayerID, playerId, username', () => {
    const gc = getOrCreateByGameCenter(`${GC_PREFIX}shape1`, 'test-gcf-Shape');
    assert.ok(gc.ok);

    const [match] = getPlayersByGameCenterIds([`${GC_PREFIX}shape1`]);
    assert.ok(match);
    assert.equal(match.gamePlayerID, `${GC_PREFIX}shape1`);
    assert.equal(match.playerId, gc.player.id);
    assert.equal(match.username, 'test-gcf-Shape');
  });

  test('caps input to 100 IDs', () => {
    // Should not throw even with >100 IDs
    const ids = Array.from({ length: 150 }, (_, i) => `${GC_PREFIX}bulk-${i}`);
    const result = getPlayersByGameCenterIds(ids);
    assert.ok(Array.isArray(result));
  });
});
