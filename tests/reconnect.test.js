// Tests for WebSocket reconnect with exponential backoff.
//
// Verifies the MultiplayerClient retry logic: backoff delays, max retries,
// reset on successful open, cleanup on intentional disconnect, and
// reconnection stuck-state prevention.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

const mpSource   = readFileSync(join(root, 'src', 'multiplayer.js'), 'utf8');
const mainSource = readFileSync(join(root, 'src', 'main.js'), 'utf8');

// ── Source-level checks ──────────────────────────────────────────────────────

describe('reconnect backoff — source inspection', () => {
  test('RECONNECT_MAX_TRIES is defined', () => {
    assert.ok(
      mpSource.includes('RECONNECT_MAX_TRIES'),
      'multiplayer.js must define RECONNECT_MAX_TRIES',
    );
  });

  test('RECONNECT_BASE_MS is defined', () => {
    assert.ok(
      mpSource.includes('RECONNECT_BASE_MS'),
      'multiplayer.js must define RECONNECT_BASE_MS',
    );
  });

  test('_scheduleReconnect method exists', () => {
    assert.ok(
      mpSource.includes('_scheduleReconnect'),
      'multiplayer.js must define _scheduleReconnect',
    );
  });

  test('exponential backoff formula is used', () => {
    assert.ok(
      mpSource.includes('2 ** this._reconnectAttempt') ||
      mpSource.includes('Math.pow(2, this._reconnectAttempt)'),
      '_scheduleReconnect must use exponential backoff',
    );
  });

  test('_onClose delegates to _scheduleReconnect', () => {
    // Find the _onClose method definition (not the arrow reference in the constructor)
    const idx = mpSource.indexOf('_onClose() {');
    assert.ok(idx !== -1, '_onClose method must exist');
    const body = mpSource.slice(idx, idx + 200);
    assert.ok(
      body.includes('_scheduleReconnect'),
      '_onClose should call _scheduleReconnect',
    );
  });

  test('_onOpen resets reconnect state', () => {
    const idx = mpSource.indexOf('_onOpen() {');
    assert.ok(idx !== -1, '_onOpen method must exist');
    const body = mpSource.slice(idx, idx + 300);
    assert.ok(
      body.includes('_reconnectAttempt = 0'),
      '_onOpen should reset _reconnectAttempt to 0',
    );
  });

  test('disconnect() clears reconnect timer', () => {
    const idx = mpSource.indexOf('disconnect()');
    assert.ok(idx !== -1, 'disconnect must exist');
    const body = mpSource.slice(idx, idx + 300);
    assert.ok(
      body.includes('clearTimeout(this._reconnectTimer)'),
      'disconnect should clear the reconnect timer',
    );
  });

  test('connect() detaches old close listener to prevent recursive _onClose', () => {
    const idx = mpSource.indexOf('connect(serverUrl)');
    assert.ok(idx !== -1, 'connect must exist');
    const body = mpSource.slice(idx, idx + 500);
    assert.ok(
      body.includes('removeEventListener'),
      'connect should remove the old close listener before closing the previous WebSocket',
    );
  });

  test('max retries produces a give-up error', () => {
    assert.ok(
      mpSource.includes('Unable to reconnect') || mpSource.includes('Please refresh'),
      '_scheduleReconnect should show a final error when retries are exhausted',
    );
  });

  // ── Fix 1: overlay hiding moved to server confirmation ─────────────────────

  test('_onOpen does NOT call onReconnected (overlay stays until server confirms)', () => {
    const idx = mpSource.indexOf('_onOpen() {');
    assert.ok(idx !== -1, '_onOpen method must exist');
    const body = mpSource.slice(idx, idx + 400);
    assert.ok(
      !body.includes('onReconnected'),
      '_onOpen must NOT call onReconnected — overlay should stay visible until server sends reconnected message',
    );
  });

  test('reconnected message handler calls onReconnected', () => {
    const idx = mpSource.indexOf("case 'reconnected':");
    assert.ok(idx !== -1, 'reconnected case must exist in _route');
    const body = mpSource.slice(idx, idx + 500);
    assert.ok(
      body.includes('onReconnected'),
      'reconnected message handler must call onReconnected to hide the overlay',
    );
  });

  // ── Fix 3: auth failure during reconnect ───────────────────────────────────

  test('authError while active triggers onDisconnectFatal', () => {
    const idx = mpSource.indexOf("case 'authError':");
    assert.ok(idx !== -1, 'authError case must exist');
    const body = mpSource.slice(idx, idx + 400);
    assert.ok(
      body.includes('this.active') && body.includes('onDisconnectFatal'),
      'authError must check this.active and call onDisconnectFatal for in-game auth failures',
    );
  });

  // ── Fix 4: silent _reconnect() failures ────────────────────────────────────

  test('_reconnect fires onDisconnectFatal when player or URL is missing', () => {
    const idx = mpSource.indexOf('_reconnect() {');
    assert.ok(idx !== -1, '_reconnect method must exist');
    const body = mpSource.slice(idx, idx + 400);
    assert.ok(
      body.includes('onDisconnectFatal'),
      '_reconnect must call onDisconnectFatal when it cannot proceed (no player or URL)',
    );
  });

  // ── Fix 5: hard timeout safety net ─────────────────────────────────────────

  test('RECONNECT_HARD_TIMEOUT is defined', () => {
    assert.ok(
      mpSource.includes('RECONNECT_HARD_TIMEOUT'),
      'multiplayer.js must define RECONNECT_HARD_TIMEOUT',
    );
  });

  test('_reconnectDeadline is initialized in constructor', () => {
    const idx = mpSource.indexOf('constructor(');
    assert.ok(idx !== -1, 'constructor must exist');
    const body = mpSource.slice(idx, idx + 800);
    assert.ok(
      body.includes('_reconnectDeadline'),
      'constructor must initialize _reconnectDeadline',
    );
  });

  test('_scheduleReconnect checks hard deadline', () => {
    const idx = mpSource.indexOf('_scheduleReconnect() {');
    assert.ok(idx !== -1, '_scheduleReconnect must exist');
    const body = mpSource.slice(idx, idx + 600);
    assert.ok(
      body.includes('_reconnectDeadline'),
      '_scheduleReconnect must check the hard timeout deadline',
    );
  });

  test('reconnected message clears _reconnectDeadline', () => {
    const idx = mpSource.indexOf("case 'reconnected':");
    assert.ok(idx !== -1);
    const body = mpSource.slice(idx, idx + 500);
    assert.ok(
      body.includes('_reconnectDeadline = 0'),
      'reconnected handler must clear _reconnectDeadline',
    );
  });

  // ── Fix 6: menu-level silent reconnection ──────────────────────────────────

  test('_onClose attempts silent reconnect when not active but authenticated', () => {
    const idx = mpSource.indexOf('_onClose() {');
    assert.ok(idx !== -1, '_onClose method must exist');
    const body = mpSource.slice(idx, idx + 400);
    assert.ok(
      body.includes('this._player') && body.includes('_reconnect'),
      '_onClose should attempt silent reconnect for menu-level disconnects when player exists',
    );
  });
});

// ── Fix 2: in-game error escape hatch (main.js) ─────────────────────────────

describe('reconnect stuck-state prevention — main.js', () => {
  test('onError checks reconnect overlay visibility for in-game errors', () => {
    const idx = mainSource.search(/onError\(msg(?:,\s*raw)?\)\s*\{/);
    assert.ok(idx !== -1, 'onError handler must exist');
    const body = mainSource.slice(idx, idx + 1200);
    assert.ok(
      body.includes('reconnect-overlay'),
      'onError must check reconnect overlay visibility to detect reconnection failures',
    );
  });

  test('onError calls _showOnlineScreen when reconnection fails in-game', () => {
    const idx = mainSource.search(/onError\(msg(?:,\s*raw)?\)\s*\{/);
    assert.ok(idx !== -1);
    const body = mainSource.slice(idx, idx + 1200);
    assert.ok(
      body.includes('_showOnlineScreen'),
      'onError must call _showOnlineScreen to wipe state and return to menu on reconnection failure',
    );
  });
});
