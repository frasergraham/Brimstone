// Tests for admin access control: is_admin column, admin email allow list,
// grantAdminIfEligible, seed user, and linkEmail auto-grant.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import db from '../server/db.js';
import {
  registerOrLogin, getPlayerByToken, linkEmail,
  isAdminEmail, grantAdminIfEligible, getPlayerIdentities, setAdmin,
} from '../server/auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

// ── Helpers ──────────────────────────────────────────────────────────────────

function cleanUp() {
  db.prepare('DELETE FROM player_identities WHERE player_id IN (SELECT id FROM players WHERE username LIKE ?)').run('test-acl-%');
  db.prepare('DELETE FROM players WHERE username LIKE ?').run('test-acl-%');
}

function createTestPlayer(suffix) {
  const result = registerOrLogin({ username: `test-acl-${suffix}` });
  assert.ok(result.ok, `Failed to create test player: ${result.error}`);
  return result.player;
}

// ── is_admin defaults to 0 ───────────────────────────────────────────────────

describe('is_admin column', () => {
  beforeEach(cleanUp);

  test('defaults to 0 for new players', () => {
    const player = createTestPlayer('default1');
    assert.equal(player.is_admin, 0);
  });

  test('is included in player row from getPlayerByToken', () => {
    const player = createTestPlayer('token1');
    const fetched = getPlayerByToken(player.token);
    assert.ok('is_admin' in fetched, 'is_admin field should be present');
    assert.equal(fetched.is_admin, 0);
  });
});

// ── Seed admin was removed — verify cleanup ──────────────────────────────────

describe('seed admin cleanup', () => {
  test('seed-admin-twisted-weasel no longer exists', () => {
    const player = db.prepare('SELECT * FROM players WHERE id = ?').get('seed-admin-twisted-weasel');
    assert.equal(player, undefined, 'seed admin should be deleted on startup');
  });
});

// ── isAdminEmail ─────────────────────────────────────────────────────────────

describe('isAdminEmail', () => {
  test('returns true for admin email', () => {
    assert.equal(isAdminEmail('frasergraham@me.com'), true);
  });

  test('returns true for admin email with different case', () => {
    assert.equal(isAdminEmail('FraserGraham@Me.Com'), true);
  });

  test('returns false for non-admin email', () => {
    assert.equal(isAdminEmail('nobody@example.com'), false);
  });
});

// ── grantAdminIfEligible ─────────────────────────────────────────────────────

describe('grantAdminIfEligible', () => {
  beforeEach(cleanUp);

  test('sets is_admin = 1 for player with admin email linked', () => {
    const player = createTestPlayer('grant1');
    db.prepare('DELETE FROM player_identities WHERE provider_id = ?').run('frasergraham@me.com');
    db.prepare(
      'INSERT INTO player_identities (player_id, provider, provider_id) VALUES (?, ?, ?)'
    ).run(player.id, 'email', 'frasergraham@me.com');

    grantAdminIfEligible(player.id);

    const updated = getPlayerByToken(player.token);
    assert.equal(updated.is_admin, 1);

    // Clean up
    db.prepare('DELETE FROM player_identities WHERE player_id = ?').run(player.id);
  });

  test('does NOT set is_admin for player with non-admin email', () => {
    const player = createTestPlayer('grant2');
    db.prepare(
      'INSERT INTO player_identities (player_id, provider, provider_id) VALUES (?, ?, ?)'
    ).run(player.id, 'email', 'nobody@example.com');

    grantAdminIfEligible(player.id);

    const updated = getPlayerByToken(player.token);
    assert.equal(updated.is_admin, 0);
  });

  test('does nothing for player with no identities', () => {
    const player = createTestPlayer('grant3');
    grantAdminIfEligible(player.id);
    const updated = getPlayerByToken(player.token);
    assert.equal(updated.is_admin, 0);
  });
});

// ── linkEmail auto-grants admin ──────────────────────────────────────────────

describe('linkEmail auto-grants admin', () => {
  beforeEach(cleanUp);

  test('grants admin when linking an admin email', () => {
    const player = createTestPlayer('link1');
    assert.equal(player.is_admin, 0);

    db.prepare('DELETE FROM player_identities WHERE provider_id = ?').run('frasergraham@me.com');

    const result = linkEmail(player.id, 'frasergraham@me.com');
    assert.ok(result.ok);

    const updated = getPlayerByToken(player.token);
    assert.equal(updated.is_admin, 1);

    // Clean up
    db.prepare('DELETE FROM player_identities WHERE player_id = ?').run(player.id);
  });

  test('does NOT grant admin when linking a non-admin email', () => {
    const player = createTestPlayer('link2');
    const result = linkEmail(player.id, 'someone@example.com');
    assert.ok(result.ok);

    const updated = getPlayerByToken(player.token);
    assert.equal(updated.is_admin, 0);
  });
});

// ── Admin link visibility ────────────────────────────────────────────────────

describe('admin link in index.html', () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');

  test('admin link is hidden by default', () => {
    assert.ok(
      html.includes('id="admin-link"'),
      'Admin link should have id="admin-link"'
    );
    assert.ok(
      html.includes('style="display:none"'),
      'Admin link should be hidden by default'
    );
  });
});

// ── Admin HTML page has auth gate ────────────────────────────────────────────

describe('admin HTML page auth gate', () => {
  test('admin.html checks /api/me/admin before loading', () => {
    const html = readFileSync(resolve(root, 'admin.html'), 'utf8');
    assert.ok(
      html.includes('/api/me/admin'),
      'admin.html should contain an auth gate calling /api/me/admin'
    );
  });

  test('admin.html has a Back to main menu link', () => {
    const html = readFileSync(resolve(root, 'admin.html'), 'utf8');
    assert.ok(
      html.includes('Back to main menu'),
      'admin.html should have a "Back to main menu" link'
    );
  });

  test('old admin-stats.html and admin-campaign-stats.html are removed', () => {
    for (const file of ['admin-stats.html', 'admin-campaign-stats.html']) {
      let exists = true;
      try { readFileSync(resolve(root, file), 'utf8'); } catch { exists = false; }
      assert.equal(exists, false, `${file} should no longer exist`);
    }
  });
});

// ── Admin toggle via setAdmin ───────────────────────────────────────────────

describe('setAdmin toggle', () => {
  beforeEach(cleanUp);

  test('setAdmin(playerId, true) sets is_admin = 1', () => {
    const player = createTestPlayer('toggle1');
    assert.equal(player.is_admin, 0);

    setAdmin(player.id, true);
    const updated = getPlayerByToken(player.token);
    assert.equal(updated.is_admin, 1);
  });

  test('setAdmin(playerId, false) sets is_admin = 0', () => {
    const player = createTestPlayer('toggle2');
    setAdmin(player.id, true);
    assert.equal(getPlayerByToken(player.token).is_admin, 1);

    setAdmin(player.id, false);
    assert.equal(getPlayerByToken(player.token).is_admin, 0);
  });
});
