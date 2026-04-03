// Tests for Game Center identity linking, auth, and account merging.

import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  registerOrLogin, getPlayerByToken, getPlayerIdentities,
  getOrCreateByGameCenter, linkGameCenter,
} from '../server/auth.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const GC_PREFIX = 'GC:test-gc-';

function cleanUp() {
  db.prepare('DELETE FROM player_identities WHERE provider = ? AND provider_id LIKE ?')
    .run('gamecenter', `${GC_PREFIX}%`);
  db.prepare('DELETE FROM players WHERE username LIKE ?').run('test-gc-%');
}

function createPlayer(suffix) {
  const result = registerOrLogin({ username: `test-gc-${suffix}` });
  assert.ok(result.ok, `Failed to create player: ${result.error}`);
  return result.player;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(cleanUp);
after(cleanUp);

// ── getOrCreateByGameCenter ─────────────────────────────────────────────────

describe('getOrCreateByGameCenter', () => {
  test('creates a new player for unknown Game Center ID', () => {
    const result = getOrCreateByGameCenter(`${GC_PREFIX}new1`, 'TestPlayer One');
    assert.ok(result.ok);
    assert.ok(result.isNew);
    assert.ok(result.player.id);
    assert.ok(result.player.token);
    assert.equal(result.player.username, 'TestPlayer One');
  });

  test('returns existing player for known Game Center ID', () => {
    const first = getOrCreateByGameCenter(`${GC_PREFIX}return1`, 'Returner');
    assert.ok(first.ok && first.isNew);

    const second = getOrCreateByGameCenter(`${GC_PREFIX}return1`, 'Returner');
    assert.ok(second.ok);
    assert.equal(second.isNew, false);
    assert.equal(second.player.id, first.player.id);
  });

  test('syncs display name on returning login', () => {
    const first = getOrCreateByGameCenter(`${GC_PREFIX}sync1`, 'test-gc-OldName');
    assert.ok(first.ok);
    assert.equal(first.player.username, 'test-gc-OldName');

    const second = getOrCreateByGameCenter(`${GC_PREFIX}sync1`, 'test-gc-NewName');
    assert.ok(second.ok);
    assert.equal(second.player.username, 'test-gc-NewName');
  });

  test('does not sync name if taken by another player', () => {
    const other = createPlayer('taken1');
    const gc = getOrCreateByGameCenter(`${GC_PREFIX}taken1`, 'test-gc-initial');
    assert.ok(gc.ok);

    // Try to sync to the other player's username
    const synced = getOrCreateByGameCenter(`${GC_PREFIX}taken1`, other.username);
    assert.ok(synced.ok);
    // Should keep original name since the new one is taken
    assert.equal(synced.player.username, 'test-gc-initial');
  });

  test('sanitizes invalid characters from display name', () => {
    const result = getOrCreateByGameCenter(`${GC_PREFIX}special1`, 'P@yer!123#');
    assert.ok(result.ok);
    // Only letters, numbers, spaces, hyphens, underscores survive
    assert.equal(result.player.username, 'Pyer123');
  });

  test('deduplicates username with numeric suffix', () => {
    createPlayer('dup1');
    const result = getOrCreateByGameCenter(`${GC_PREFIX}dup1`, 'test-gc-dup1');
    assert.ok(result.ok);
    // Should get a suffixed name since test-gc-dup1 is taken
    assert.ok(result.player.username.startsWith('test-gc-dup1'));
    assert.notEqual(result.player.username, 'test-gc-dup1');
  });

  test('creates gamecenter identity record', () => {
    const result = getOrCreateByGameCenter(`${GC_PREFIX}ident1`, 'test-gc-ident1');
    assert.ok(result.ok);

    const ids = getPlayerIdentities(result.player.id);
    assert.equal(ids.length, 1);
    assert.equal(ids[0].provider, 'gamecenter');
    assert.equal(ids[0].provider_id, `${GC_PREFIX}ident1`);
  });

  test('handles empty display name gracefully', () => {
    const result = getOrCreateByGameCenter(`${GC_PREFIX}empty1`, '');
    assert.ok(result.ok);
    // Falls back to 'player' base name
    assert.ok(result.player.username.startsWith('player'));
  });
});

// ── linkGameCenter ──────────────────────────────────────────────────────────

describe('linkGameCenter', () => {
  test('links a Game Center ID to an existing player', () => {
    const player = createPlayer('link1');
    const result = linkGameCenter(player.id, `${GC_PREFIX}link1`);
    assert.ok(result.ok);

    const ids = getPlayerIdentities(player.id);
    const gc = ids.find(i => i.provider === 'gamecenter');
    assert.ok(gc);
    assert.equal(gc.provider_id, `${GC_PREFIX}link1`);
  });

  test('is idempotent for same player + Game Center ID', () => {
    const player = createPlayer('link2');
    linkGameCenter(player.id, `${GC_PREFIX}link2`);
    const result = linkGameCenter(player.id, `${GC_PREFIX}link2`);
    assert.ok(result.ok);
  });

  test('rejects linking a Game Center ID already used by another player', () => {
    const p1 = createPlayer('link3a');
    const p2 = createPlayer('link3b');

    linkGameCenter(p1.id, `${GC_PREFIX}link3`);
    const result = linkGameCenter(p2.id, `${GC_PREFIX}link3`);
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('already linked'));
  });

  test('returns error for nonexistent player', () => {
    const result = linkGameCenter('nonexistent-player-id', `${GC_PREFIX}link4`);
    assert.equal(result.ok, false);
  });
});

// ── Account merging flow ────────────────────────────────────────────────────

describe('account merging', () => {
  test('existing username player can link Game Center and then auth via GC', () => {
    // Step 1: Player registers with username
    const player = createPlayer('merge1');

    // Step 2: Link Game Center
    const linked = linkGameCenter(player.id, `${GC_PREFIX}merge1`);
    assert.ok(linked.ok);

    // Step 3: Auth via Game Center on a new device
    const gcAuth = getOrCreateByGameCenter(`${GC_PREFIX}merge1`, player.username);
    assert.ok(gcAuth.ok);
    assert.equal(gcAuth.isNew, false);
    assert.equal(gcAuth.player.id, player.id);
  });

  test('Game Center player token remains valid after identity link', () => {
    const gc = getOrCreateByGameCenter(`${GC_PREFIX}merge2`, 'test-gc-merge2');
    assert.ok(gc.ok);

    const found = getPlayerByToken(gc.player.token);
    assert.ok(found);
    assert.equal(found.id, gc.player.id);
  });
});
