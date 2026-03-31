// Tests for the async game invite flow: auto-account creation and invitee_email storage.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';
import db from '../server/db.js';
import {
  registerOrLogin, getOrCreateByEmail, getPlayerByEmail,
  getPlayerByToken, getPlayerIdentities,
} from '../server/auth.js';
import {
  insertAsyncGame, getAsyncGame, getAsyncGameByCode,
  deleteAsyncGame,
} from '../server/async-game.js';
import { VERSION } from '../src/version.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const createdPlayerIds = [];
const createdRoomIds   = [];

function cleanUp() {
  for (const roomId of createdRoomIds) {
    try { deleteAsyncGame(roomId); } catch { /* ignore */ }
  }
  createdRoomIds.length = 0;
  for (const id of createdPlayerIds) {
    db.prepare('DELETE FROM player_identities WHERE player_id = ?').run(id);
    db.prepare('DELETE FROM players WHERE id = ?').run(id);
  }
  createdPlayerIds.length = 0;
}

function trackPlayer(player) {
  createdPlayerIds.push(player.id);
  return player;
}

function trackRoom(result) {
  createdRoomIds.push(result.roomId);
  return result;
}

// ── getOrCreateByEmail ──────────────────────────────────────────────────────

describe('getOrCreateByEmail', () => {
  afterEach(cleanUp);

  test('creates a new player when email is unknown', () => {
    const email = `test-${randomUUID()}@example.com`;
    const result = getOrCreateByEmail(email);
    assert.ok(result.ok);
    assert.ok(result.isNew, 'should flag as new account');
    assert.ok(result.player.id);
    assert.ok(result.player.token);
    trackPlayer(result.player);

    // Email should be linked
    const identities = getPlayerIdentities(result.player.id);
    assert.ok(identities.some(i => i.provider === 'email' && i.provider_id === email));

    // Lookup by email should find them
    const found = getPlayerByEmail(email);
    assert.equal(found.id, result.player.id);
  });

  test('returns existing player when email is already linked', () => {
    const email = `test-${randomUUID()}@example.com`;

    // First call creates
    const first = getOrCreateByEmail(email);
    assert.ok(first.ok && first.isNew);
    trackPlayer(first.player);

    // Second call finds existing
    const second = getOrCreateByEmail(email);
    assert.ok(second.ok);
    assert.equal(second.isNew, false);
    assert.equal(second.player.id, first.player.id);
  });

  test('derives username from email prefix', () => {
    const email = `coolplayer42@example.com`;
    const result = getOrCreateByEmail(email);
    assert.ok(result.ok);
    trackPlayer(result.player);
    assert.ok(result.player.username.startsWith('coolplayer42'));
  });

  test('deduplicates username if prefix is taken', () => {
    // Create a player with the email prefix as username
    const reg = registerOrLogin({ username: 'dupetest' });
    assert.ok(reg.ok);
    trackPlayer(reg.player);

    const email = `dupetest@example.com`;
    const result = getOrCreateByEmail(email);
    assert.ok(result.ok);
    trackPlayer(result.player);
    // Should get dupetest1, dupetest2, etc. — not 'dupetest'
    assert.notEqual(result.player.username, 'dupetest');
    assert.ok(result.player.username.startsWith('dupetest'));
  });

  test('normalises email to lowercase', () => {
    const email = `TEST-${randomUUID()}@Example.COM`;
    const result = getOrCreateByEmail(email);
    assert.ok(result.ok);
    trackPlayer(result.player);

    const found = getPlayerByEmail(email.toLowerCase());
    assert.equal(found.id, result.player.id);
  });
});

// ── invitee_email on async games ────────────────────────────────────────────

describe('async game invitee_email', () => {
  afterEach(cleanUp);

  const HOST_ID = 'test-invite-host-' + randomUUID();

  // Ensure host player exists
  beforeEach(() => {
    const existing = db.prepare('SELECT 1 FROM players WHERE id = ?').get(HOST_ID);
    if (!existing) {
      db.prepare('INSERT INTO players (id, username, token) VALUES (?, ?, ?)')
        .run(HOST_ID, 'InvHost' + randomUUID().slice(0, 6), randomUUID());
      createdPlayerIds.push(HOST_ID);
    }
  });

  test('stores invitee_email when provided', () => {
    const email = 'invited@example.com';
    const result = insertAsyncGame(HOST_ID, 'Host', 'hero', {}, 3600000, VERSION, email);
    trackRoom(result);

    const game = getAsyncGame(result.roomId);
    assert.equal(game.invitee_email, email);
  });

  test('invitee_email is null when not provided', () => {
    const result = insertAsyncGame(HOST_ID, 'Host', 'hero', {}, 3600000, VERSION);
    trackRoom(result);

    const game = getAsyncGame(result.roomId);
    assert.equal(game.invitee_email, null);
  });

  test('game can be found by code and has invitee_email', () => {
    const email = 'findme@example.com';
    const result = insertAsyncGame(HOST_ID, 'Host', 'witch', {}, 3600000, VERSION, email);
    trackRoom(result);

    const game = getAsyncGameByCode(result.code);
    assert.ok(game);
    assert.equal(game.invitee_email, email);
  });
});
