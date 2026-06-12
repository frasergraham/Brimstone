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
//
// Static-markup wiring guard (kept deliberately): src/main.js looks up
// `document.getElementById('admin-link')` and flips its display ON for admins.
// If the id disappears, the reveal silently no-ops; if the element isn't
// hidden inline, non-admins see the link flash before JS runs. The assertions
// target the <a id="admin-link"> tag itself, not the whole file, so unrelated
// markup can't satisfy them.

describe('admin link in index.html', () => {
  const html = readFileSync(resolve(root, 'index.html'), 'utf8');

  test('the #admin-link element exists and is inline-hidden by default', () => {
    const tag = html.match(/<a\b[^>]*\bid="admin-link"[^>]*>/);
    assert.ok(tag, 'index.html should have an <a id="admin-link"> element (main.js reveals it for admins)');
    assert.match(
      tag[0],
      /style="[^"]*display:\s*none[^"]*"/,
      'the admin link element itself must carry display:none so non-admins never see it'
    );
  });
});

// ── Admin HTML page has auth gate ────────────────────────────────────────────
//
// admin.html's auth gate is an inline script (no importable module), so the
// presence of the /api/me/admin call is the wiring we can pin here; the gate's
// behaviour (redirect on 401/non-admin) is exercised in the browser.

describe('admin HTML page auth gate', () => {
  test('admin.html wires the /api/me/admin auth gate', () => {
    const html = readFileSync(resolve(root, 'admin.html'), 'utf8');
    assert.ok(
      html.includes('/api/me/admin'),
      'admin.html should contain an auth gate calling /api/me/admin'
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
