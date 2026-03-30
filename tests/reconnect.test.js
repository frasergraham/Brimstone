// Tests for WebSocket reconnect with exponential backoff.
//
// Verifies the MultiplayerClient retry logic: backoff delays, max retries,
// reset on successful open, and cleanup on intentional disconnect.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

const mpSource = readFileSync(join(root, 'src', 'multiplayer.js'), 'utf8');

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
});
