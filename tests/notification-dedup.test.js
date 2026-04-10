// Tests for server-side notification deduplication windows.
//
// The bug: checkApproachingDeadlines() runs every 60s, but the dedup window
// was only 10s.  That means every poll cycle fires a new push notification,
// producing ~60 notifications/hour for battle mode and ~10 for standard async.
//
// These tests verify that deadline-related notification types use dedup windows
// wide enough to suppress repeated sends within their approach windows.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import db from '../server/db.js';
import { DEDUP_WINDOWS } from '../server/notifications.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

const TEST_ROOM   = 'test-dedup-room';
const TEST_PLAYER = 'test-dedup-player';

function cleanUp() {
  db.prepare("DELETE FROM async_notifications WHERE room_id = ?").run(TEST_ROOM);
}

const recentNotif = db.prepare(`
  SELECT 1 FROM async_notifications
  WHERE  room_id = ? AND player_id = ? AND type = ? AND sent_at > ?
  LIMIT  1
`);

function insertNotif(type, sentSecondsAgo) {
  const sentAt = Math.floor(Date.now() / 1000) - sentSecondsAgo;
  db.prepare(`
    INSERT INTO async_notifications (room_id, player_id, type, sent_at)
    VALUES (?, ?, ?, ?)
  `).run(TEST_ROOM, TEST_PLAYER, type, sentAt);
}

/** Simulate _shouldSend: returns true if no recent notification within windowS. */
function shouldSend(type, windowS) {
  const cutoff = Math.floor(Date.now() / 1000) - windowS;
  return !recentNotif.get(TEST_ROOM, TEST_PLAYER, type, cutoff);
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe('notification dedup windows', () => {
  beforeEach(cleanUp);

  describe('DEDUP_WINDOWS export', () => {
    test('deadline_approaching window is at least 10 minutes (600s)', () => {
      assert.ok(DEDUP_WINDOWS.deadline_approaching >= 600,
        `deadline_approaching window should be >= 600s, got ${DEDUP_WINDOWS.deadline_approaching}`);
    });

    test('battle_deadline window is at least 60 minutes (3600s)', () => {
      assert.ok(DEDUP_WINDOWS.battle_deadline >= 3600,
        `battle_deadline window should be >= 3600s, got ${DEDUP_WINDOWS.battle_deadline}`);
    });

    test('default window is short (for non-deadline notifications)', () => {
      const def = DEDUP_WINDOWS.default;
      assert.ok(def > 0 && def <= 60,
        `default window should be short, got ${def}`);
    });
  });

  describe('deadline_approaching dedup behavior', () => {
    test('suppresses repeat within approach window', () => {
      // Simulate: a deadline_approaching notification was sent 2 minutes ago
      insertNotif('deadline_approaching', 120);
      const window = DEDUP_WINDOWS.deadline_approaching;
      // With a proper window (>=600s), 120s ago should still be suppressed
      assert.equal(shouldSend('deadline_approaching', window), false,
        'should suppress notification sent 2 minutes ago');
    });

    test('allows notification after window expires', () => {
      // Simulate: notification sent 11 minutes ago — outside a 10-minute window
      insertNotif('deadline_approaching', 660);
      const window = DEDUP_WINDOWS.deadline_approaching;
      assert.equal(shouldSend('deadline_approaching', window), true,
        'should allow notification after window expires');
    });
  });

  describe('battle_deadline dedup behavior', () => {
    test('suppresses repeat within 1-hour approach window', () => {
      // Simulate: battle_deadline notification sent 30 minutes ago
      insertNotif('battle_deadline', 1800);
      const window = DEDUP_WINDOWS.battle_deadline;
      assert.equal(shouldSend('battle_deadline', window), false,
        'should suppress battle notification sent 30 minutes ago');
    });

    test('allows notification after window expires', () => {
      // Simulate: notification sent 61 minutes ago
      insertNotif('battle_deadline', 3660);
      const window = DEDUP_WINDOWS.battle_deadline;
      assert.equal(shouldSend('battle_deadline', window), true,
        'should allow notification after window expires');
    });
  });

  describe('non-deadline types use short dedup', () => {
    test('round_ready allows resend after short window', () => {
      insertNotif('round_ready', 30); // 30 seconds ago
      const window = DEDUP_WINDOWS.default;
      // With a short default window (e.g. 10s), 30s ago is outside it
      assert.equal(shouldSend('round_ready', window), true,
        'round_ready should allow resend after short dedup window');
    });
  });
});
