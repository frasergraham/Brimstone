// Tests for WebSocket heartbeat (ping/pong) mechanism.
//
// Verifies that server.js includes the standard `ws` library heartbeat
// pattern: ws._isAlive flag, pong listener, periodic ping, and terminate
// on missed pong.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root      = join(__dirname, '..');

const serverSource = readFileSync(join(root, 'server.js'), 'utf8');

describe('WebSocket heartbeat — server.js', () => {
  test('sets _isAlive = true on new connections', () => {
    assert.ok(
      serverSource.includes('ws._isAlive = true'),
      'server.js should set ws._isAlive = true on connection',
    );
  });

  test('listens for pong frames and resets _isAlive', () => {
    assert.ok(
      serverSource.includes("on('pong'") || serverSource.includes('on("pong"'),
      'server.js should listen for pong frames',
    );
    assert.ok(
      serverSource.includes('ws._isAlive = true'),
      'pong handler should reset _isAlive to true',
    );
  });

  test('defines HEARTBEAT_INTERVAL_MS constant', () => {
    assert.ok(
      serverSource.includes('HEARTBEAT_INTERVAL_MS'),
      'server.js should define HEARTBEAT_INTERVAL_MS',
    );
    // Verify it's a reasonable value (10-30 seconds)
    const match = serverSource.match(/HEARTBEAT_INTERVAL_MS\s*=\s*(\d[\d_]*)/);
    assert.ok(match, 'HEARTBEAT_INTERVAL_MS should be a numeric constant');
    const ms = parseInt(match[1].replace(/_/g, ''), 10);
    assert.ok(ms >= 10_000 && ms <= 30_000,
      `HEARTBEAT_INTERVAL_MS should be 10-30s, got ${ms}ms`);
  });

  test('calls ws.ping() in the heartbeat interval', () => {
    assert.ok(
      serverSource.includes('ws.ping()'),
      'heartbeat interval should call ws.ping()',
    );
  });

  test('terminates connections that miss a pong', () => {
    assert.ok(
      serverSource.includes('ws.terminate()'),
      'heartbeat should terminate connections that miss a pong',
    );
    // Verify the pattern: check _isAlive false → terminate
    assert.ok(
      serverSource.includes('!ws._isAlive'),
      'heartbeat should check !ws._isAlive before terminating',
    );
  });

  test('cleans up heartbeat interval on server close', () => {
    assert.ok(
      serverSource.includes("wss.on('close'") || serverSource.includes('wss.on("close"'),
      'server.js should clean up heartbeat on wss close',
    );
    assert.ok(
      serverSource.includes('clearInterval'),
      'server.js should clearInterval the heartbeat',
    );
  });
});
