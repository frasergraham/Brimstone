// Tests for email identity linking, magic link tokens, and auth extensions.

import { describe, test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import {
  registerOrLogin, getPlayerByToken, getPlayerById,
  linkEmail, getPlayerByEmail, getPlayerIdentities, loginByEmail,
} from '../server/auth.js';
import { generateToken, verifyToken } from '../server/magic-link.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanUp() {
  db.prepare('DELETE FROM magic_tokens WHERE email LIKE ?').run('%@test-brimstone.com');
  db.prepare('DELETE FROM player_identities WHERE provider_id LIKE ?').run('%@test-brimstone.com');
  db.prepare('DELETE FROM players WHERE username LIKE ?').run('test-email-%');
}

function createPlayer(suffix) {
  const result = registerOrLogin({ username: `test-email-${suffix}` });
  assert.ok(result.ok, `Failed to create player: ${result.error}`);
  return result.player;
}

// ── Setup / teardown ─────────────────────────────────────────────────────────

beforeEach(cleanUp);
after(cleanUp);

// ── Magic token generation and verification ──────────────────────────────────

describe('generateToken / verifyToken', () => {
  test('generates a token that can be verified', () => {
    const player = createPlayer('token1');
    const token = generateToken('user1@test-brimstone.com', player.id);
    assert.ok(token, 'Should return a token string');
    assert.equal(typeof token, 'string');

    const result = verifyToken(token);
    assert.ok(result, 'Token should verify successfully');
    assert.equal(result.email, 'user1@test-brimstone.com');
    assert.equal(result.playerId, player.id);
  });

  test('token can only be used once', () => {
    const player = createPlayer('token2');
    const token = generateToken('user2@test-brimstone.com', player.id);

    const first = verifyToken(token);
    assert.ok(first, 'First verification should succeed');

    const second = verifyToken(token);
    assert.equal(second, null, 'Second verification should fail (token already used)');
  });

  test('expired token cannot be verified', () => {
    const player = createPlayer('token3');
    const token = generateToken('user3@test-brimstone.com', player.id);

    // Manually expire the token
    db.prepare('UPDATE magic_tokens SET expires_at = ? WHERE token = ?')
      .run(Date.now() - 1000, token);

    const result = verifyToken(token);
    assert.equal(result, null, 'Expired token should not verify');
  });

  test('invalid token returns null', () => {
    const result = verifyToken('nonexistent-token-id');
    assert.equal(result, null);
  });

  test('normalises email to lowercase', () => {
    const player = createPlayer('token4');
    const token = generateToken('USER4@TEST-BRIMSTONE.COM', player.id);

    const result = verifyToken(token);
    assert.ok(result);
    assert.equal(result.email, 'user4@test-brimstone.com');
  });

  test('token with null playerId works (login flow)', () => {
    const token = generateToken('login@test-brimstone.com', null);
    const result = verifyToken(token);
    assert.ok(result);
    assert.equal(result.email, 'login@test-brimstone.com');
    assert.equal(result.playerId, null);
  });
});

// ── Email identity linking ───────────────────────────────────────────────────

describe('linkEmail', () => {
  test('links an email to a player', () => {
    const player = createPlayer('link1');
    const result = linkEmail(player.id, 'link1@test-brimstone.com');
    assert.ok(result.ok);

    const found = getPlayerByEmail('link1@test-brimstone.com');
    assert.ok(found);
    assert.equal(found.id, player.id);
  });

  test('is idempotent for same player + email', () => {
    const player = createPlayer('link2');
    linkEmail(player.id, 'link2@test-brimstone.com');
    const result = linkEmail(player.id, 'link2@test-brimstone.com');
    assert.ok(result.ok, 'Re-linking same email should succeed');
  });

  test('rejects linking an email already used by another player', () => {
    const p1 = createPlayer('link3a');
    const p2 = createPlayer('link3b');

    linkEmail(p1.id, 'shared@test-brimstone.com');
    const result = linkEmail(p2.id, 'shared@test-brimstone.com');
    assert.equal(result.ok, false);
    assert.ok(result.error.includes('already linked'));
  });

  test('normalises email to lowercase', () => {
    const player = createPlayer('link4');
    linkEmail(player.id, 'UPPER@TEST-BRIMSTONE.COM');

    const found = getPlayerByEmail('upper@test-brimstone.com');
    assert.ok(found);
    assert.equal(found.id, player.id);
  });

  test('returns error for nonexistent player', () => {
    const result = linkEmail('nonexistent-player-id', 'nobody@test-brimstone.com');
    assert.equal(result.ok, false);
  });
});

// ── getPlayerByEmail ─────────────────────────────────────────────────────────

describe('getPlayerByEmail', () => {
  test('returns null for unlinked email', () => {
    const result = getPlayerByEmail('noone@test-brimstone.com');
    assert.equal(result, null);
  });

  test('returns the player after linking', () => {
    const player = createPlayer('byemail1');
    linkEmail(player.id, 'byemail1@test-brimstone.com');

    const found = getPlayerByEmail('byemail1@test-brimstone.com');
    assert.ok(found);
    assert.equal(found.id, player.id);
    assert.equal(found.username, player.username);
  });
});

// ── getPlayerIdentities ──────────────────────────────────────────────────────

describe('getPlayerIdentities', () => {
  test('returns empty array for player with no linked identities', () => {
    const player = createPlayer('ident1');
    const ids = getPlayerIdentities(player.id);
    assert.ok(Array.isArray(ids));
    assert.equal(ids.length, 0);
  });

  test('returns linked identity after linkEmail', () => {
    const player = createPlayer('ident2');
    linkEmail(player.id, 'ident2@test-brimstone.com');

    const ids = getPlayerIdentities(player.id);
    assert.equal(ids.length, 1);
    assert.equal(ids[0].provider, 'email');
    assert.equal(ids[0].provider_id, 'ident2@test-brimstone.com');
  });
});

// ── loginByEmail ─────────────────────────────────────────────────────────────

describe('loginByEmail', () => {
  test('returns the player for a valid player ID', () => {
    const player = createPlayer('login1');
    const result = loginByEmail(player.id);
    assert.ok(result.ok);
    assert.equal(result.player.id, player.id);
  });

  test('returns error for nonexistent player', () => {
    const result = loginByEmail('nonexistent-player-id');
    assert.equal(result.ok, false);
  });
});

// ── Full magic link flow (integration) ───────────────────────────────────────

describe('full magic link flow', () => {
  test('link email → verify → login from new device', () => {
    // Step 1: Player registers anonymously
    const player = createPlayer('flow1');

    // Step 2: Player requests to link their email
    const linkToken = generateToken('flow1@test-brimstone.com', player.id);

    // Step 3: Player clicks magic link — verify token
    const verified = verifyToken(linkToken);
    assert.ok(verified);
    assert.equal(verified.playerId, player.id);

    // Step 4: Link the email to their account
    const linked = linkEmail(player.id, verified.email);
    assert.ok(linked.ok);

    // Step 5: On a new device, request login by email
    const foundPlayer = getPlayerByEmail('flow1@test-brimstone.com');
    assert.ok(foundPlayer);
    assert.equal(foundPlayer.id, player.id);

    // Step 6: Generate login token for the found player
    const loginToken = generateToken('flow1@test-brimstone.com', foundPlayer.id);

    // Step 7: Verify login token
    const loginVerified = verifyToken(loginToken);
    assert.ok(loginVerified);
    assert.equal(loginVerified.playerId, player.id);

    // Step 8: Log in
    const loginResult = loginByEmail(loginVerified.playerId);
    assert.ok(loginResult.ok);
    assert.equal(loginResult.player.id, player.id);
    assert.equal(loginResult.player.username, player.username);
  });

  test('existing registerOrLogin still works unchanged', () => {
    // Anonymous registration
    const reg = registerOrLogin({ username: 'test-email-compat1' });
    assert.ok(reg.ok);

    // Token login
    const login = registerOrLogin({ token: reg.player.token });
    assert.ok(login.ok);
    assert.equal(login.player.id, reg.player.id);

    // Invalid token with no username
    const expired = registerOrLogin({ token: 'bogus-token-value' });
    assert.equal(expired.ok, false);
  });
});
