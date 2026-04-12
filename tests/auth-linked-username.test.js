// Tests for the "username linked to email" squat-prevention check.
// When a player has linked an email to their account, nobody else can
// register with the same username — they must sign in via email instead.

import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  registerOrLogin, linkEmail, isUsernameLinkedToEmail,
} from '../server/auth.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEST_PREFIX = 'test-link-';

function cleanUp() {
  db.prepare('DELETE FROM player_identities WHERE provider_id LIKE ?').run('%@test-linked-brimstone.com');
  db.prepare('DELETE FROM players WHERE username LIKE ?').run(`${TEST_PREFIX}%`);
}

function createPlayer(suffix) {
  const result = registerOrLogin({ username: `${TEST_PREFIX}${suffix}` });
  assert.ok(result.ok, `Failed to create player: ${result.error}`);
  return result.player;
}

beforeEach(cleanUp);
after(cleanUp);

// ── isUsernameLinkedToEmail ──────────────────────────────────────────────────

describe('isUsernameLinkedToEmail', () => {
  test('returns false when no player with that username exists', () => {
    assert.equal(isUsernameLinkedToEmail(`${TEST_PREFIX}nobody`), false);
  });

  test('returns false when username exists but has no linked email', () => {
    createPlayer('nomail');
    assert.equal(isUsernameLinkedToEmail(`${TEST_PREFIX}nomail`), false);
  });

  test('returns true when matching player has a linked email', () => {
    const p = createPlayer('hasmail');
    linkEmail(p.id, 'hasmail@test-linked-brimstone.com');
    assert.equal(isUsernameLinkedToEmail(`${TEST_PREFIX}hasmail`), true);
  });

  test('is case-insensitive', () => {
    const p = createPlayer('case');
    linkEmail(p.id, 'case@test-linked-brimstone.com');
    assert.equal(isUsernameLinkedToEmail(`${TEST_PREFIX}CASE`), true);
    assert.equal(isUsernameLinkedToEmail(`${TEST_PREFIX}case`), true);
  });

  test('returns true when ANY of several same-username players has a linked email', () => {
    const p1 = createPlayer('shared');
    const p2 = createPlayer('shared');
    // Only p2 has an email linked
    linkEmail(p2.id, 'shared@test-linked-brimstone.com');
    assert.equal(isUsernameLinkedToEmail(`${TEST_PREFIX}shared`), true);
    // Confirm both players exist with the same username
    assert.equal(p1.username, p2.username);
    assert.notEqual(p1.discriminator, p2.discriminator);
  });

  test('returns false for empty/whitespace input', () => {
    assert.equal(isUsernameLinkedToEmail(''), false);
    assert.equal(isUsernameLinkedToEmail('   '), false);
    assert.equal(isUsernameLinkedToEmail(null), false);
    assert.equal(isUsernameLinkedToEmail(undefined), false);
  });
});

// ── registerOrLogin squat-prevention ────────────────────────────────────────

describe('registerOrLogin — username_linked squat prevention', () => {
  test('blocks registering a username that is linked to an email', () => {
    const owner = createPlayer('ownA');
    linkEmail(owner.id, 'owna@test-linked-brimstone.com');

    const attempt = registerOrLogin({ username: `${TEST_PREFIX}ownA` });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.err_code, 'username_linked');
    assert.ok(attempt.error, 'should include human-readable error message');
    // Per user decision: no email hint exposed
    assert.equal(attempt.linkedEmail, undefined);
  });

  test('blocks registration case-insensitively', () => {
    const owner = createPlayer('ownB');
    linkEmail(owner.id, 'ownb@test-linked-brimstone.com');

    const attempt = registerOrLogin({ username: `${TEST_PREFIX}OWNB` });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.err_code, 'username_linked');
  });

  test('still allows registering a new username that is not linked', () => {
    // Ensure an unrelated linked player doesn't poison unrelated names
    const other = createPlayer('other');
    linkEmail(other.id, 'other@test-linked-brimstone.com');

    const result = registerOrLogin({ username: `${TEST_PREFIX}fresh` });
    assert.ok(result.ok);
    assert.ok(result.player);
    assert.equal(result.err_code, undefined);
  });

  test('allows duplicate usernames when none of the existing ones is linked', () => {
    createPlayer('dup');
    const result = registerOrLogin({ username: `${TEST_PREFIX}dup` });
    assert.ok(result.ok, 'duplicate non-linked usernames should still use discriminators');
    assert.ok(result.player);
  });

  test('token-based login is unaffected even if username happens to be linked', () => {
    const owner = createPlayer('tok');
    linkEmail(owner.id, 'tok@test-linked-brimstone.com');

    // The owner should still be able to log in using their token
    const relogin = registerOrLogin({ token: owner.token });
    assert.ok(relogin.ok);
    assert.equal(relogin.player.id, owner.id);
  });
});
