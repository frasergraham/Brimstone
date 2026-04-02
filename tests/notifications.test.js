// Tests for src/notifications.js — browser notification wrapper for async games.
//
// The module is client-side (uses Notification API and document.visibilitychange).
// We mock the globals before importing so the module sees our fakes.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock globals ──────────────────────────────────────────────────────────────

let permissionState = 'default';
let requestedPermission = false;
let createdNotifications = [];
let documentHidden = false;
let visibilityListeners = [];
let windowFocused = false;

class FakeNotification {
  constructor(title, opts = {}) {
    this.title = title;
    this.body  = opts.body;
    this.tag   = opts.tag;
    this.onclick = null;
    this._closed = false;
    createdNotifications.push(this);
  }
  close() { this._closed = true; }
  static get permission() { return permissionState; }
  static requestPermission() {
    requestedPermission = true;
    permissionState = 'granted';
    return Promise.resolve('granted');
  }
}

// Install mocks on globalThis before import
globalThis.Notification = FakeNotification;
globalThis.window = globalThis.window || {};
globalThis.window.focus = () => { windowFocused = true; };

// Minimal document mock for visibilitychange
if (!globalThis.document) {
  globalThis.document = {};
}
Object.defineProperty(globalThis.document, 'hidden', { get: () => documentHidden, configurable: true });
const origAddEventListener = globalThis.document.addEventListener?.bind(globalThis.document);
globalThis.document.addEventListener = (type, fn, ...rest) => {
  if (type === 'visibilitychange') visibilityListeners.push(fn);
  if (origAddEventListener) origAddEventListener(type, fn, ...rest);
};

// ── Import (after mocks) ─────────────────────────────────────────────────────

const {
  requestNotificationPermission,
  canNotify,
  notifyTurnReady,
  notifyOpponentSubmitted,
  notifyGameOver,
} = await import('../src/notifications.js');

// ── Tests ────────────────────────────────────────────────────────────────────

describe('notifications', () => {
  beforeEach(() => {
    permissionState = 'granted';
    requestedPermission = false;
    createdNotifications = [];
    documentHidden = true;      // tab hidden by default (notifications should fire)
    windowFocused = false;
    // Simulate visibilitychange so module picks up hidden state
    for (const fn of visibilityListeners) fn();
  });

  describe('requestNotificationPermission()', () => {
    test('calls Notification.requestPermission when permission is default', () => {
      permissionState = 'default';
      requestNotificationPermission();
      assert.ok(requestedPermission, 'should have called requestPermission()');
    });

    test('does not call requestPermission when already granted', () => {
      permissionState = 'granted';
      requestNotificationPermission();
      assert.ok(!requestedPermission, 'should not re-request when granted');
    });

    test('does not call requestPermission when denied', () => {
      permissionState = 'denied';
      requestNotificationPermission();
      assert.ok(!requestedPermission, 'should not re-request when denied');
    });
  });

  describe('canNotify()', () => {
    test('returns true when permission is granted', () => {
      permissionState = 'granted';
      assert.ok(canNotify());
    });

    test('returns false when permission is denied', () => {
      permissionState = 'denied';
      assert.ok(!canNotify());
    });

    test('returns false when permission is default', () => {
      permissionState = 'default';
      assert.ok(!canNotify());
    });
  });

  describe('notifyTurnReady()', () => {
    test('creates notification with round number when tab hidden', () => {
      const n = notifyTurnReady(5);
      assert.ok(n, 'should return a notification');
      assert.equal(n.title, 'Your Turn');
      assert.ok(n.body.includes('5'), 'body should mention round number');
      assert.equal(n.tag, 'brimstone-turn-ready');
    });

    test('suppressed when tab is visible', () => {
      documentHidden = false;
      for (const fn of visibilityListeners) fn();
      const n = notifyTurnReady(3);
      assert.equal(n, null, 'should not notify when tab is visible');
    });

    test('suppressed when permission not granted', () => {
      permissionState = 'denied';
      const n = notifyTurnReady(3);
      assert.equal(n, null, 'should not notify without permission');
    });
  });

  describe('notifyOpponentSubmitted()', () => {
    test('creates notification when tab hidden and permitted', () => {
      const n = notifyOpponentSubmitted();
      assert.ok(n);
      assert.equal(n.title, 'Opponent Submitted');
      assert.equal(n.tag, 'brimstone-opponent-submitted');
    });
  });

  describe('notifyGameOver()', () => {
    test('shows victory message when won', () => {
      const n = notifyGameOver(true);
      assert.ok(n);
      assert.equal(n.title, 'Game Over');
      assert.ok(n.body.includes('Victory'), 'body should say Victory');
    });

    test('shows defeat message when lost', () => {
      const n = notifyGameOver(false);
      assert.ok(n.body.includes('Defeat'), 'body should say Defeat');
    });
  });

  describe('onclick handler', () => {
    test('focuses window and closes notification on click', () => {
      const n = notifyTurnReady(1);
      assert.ok(n.onclick, 'onclick should be set');
      n.onclick();
      assert.ok(windowFocused, 'should have called window.focus()');
      assert.ok(n._closed, 'should have closed the notification');
    });
  });
});

// ── Server-side notification suppression ────────────────────────────────────

import { shouldNotify } from '../server/notifications.js';

describe('shouldNotify (server-side suppression)', () => {
  test('suppresses for short-timeout games', () => {
    assert.equal(shouldNotify('r1', 'p1', { turnIntervalMs: 90_000 }), false);
  });

  test('allows for long-timeout games when disconnected', () => {
    assert.equal(
      shouldNotify('r1', 'p1', { turnIntervalMs: 86_400_000, isConnected: () => false }),
      true,
    );
  });

  test('suppresses when player is connected even for long-timeout', () => {
    assert.equal(
      shouldNotify('r1', 'p1', { turnIntervalMs: 86_400_000, isConnected: () => true }),
      false,
    );
  });

  test('allows at exactly the 1-hour threshold', () => {
    assert.equal(
      shouldNotify('r1', 'p1', { turnIntervalMs: 3_600_000, isConnected: () => false }),
      true,
    );
  });

  test('suppresses just under the 1-hour threshold', () => {
    assert.equal(shouldNotify('r1', 'p1', { turnIntervalMs: 3_599_999 }), false);
  });
});
