// Behavioral tests for WebSocket reconnect with exponential backoff
// (MultiplayerClient in src/multiplayer.js).
//
// Uses a fake global WebSocket and node:test mock timers — no network, no
// real waits. Verifies: backoff delays actually double, max retries are
// enforced, a successful open resets the attempt counter, intentional
// disconnect cancels the pending retry, and the reconnect overlay only
// hides on the server's `reconnected` message (not on raw socket open).

import { describe, test, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// multiplayer.js → platform.js guards all browser globals, but provide a
// localStorage + window stub so authOk routing is side-effect-free in Node.
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
};
globalThis.window ??= { addEventListener() {}, removeEventListener() {} };
globalThis.document ??= { addEventListener() {}, removeEventListener() {}, hidden: false };

// Dynamic import — static imports are hoisted above the global stubs, and
// platform.js (imported by multiplayer.js) touches `window` at module init.
const { MultiplayerClient } = await import('../src/multiplayer.js');

// Backoff constants under test (mirrored from src/multiplayer.js).
const BASE_MS   = 3000;
const MAX_TRIES = 3;

// ── Fake WebSocket ───────────────────────────────────────────────────────────

class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this._listeners = new Map();
    FakeWebSocket.instances.push(this);
  }
  addEventListener(event, fn) {
    const arr = this._listeners.get(event) ?? [];
    arr.push(fn);
    this._listeners.set(event, arr);
  }
  removeEventListener(event, fn) {
    const arr = this._listeners.get(event) ?? [];
    const i = arr.indexOf(fn);
    if (i !== -1) arr.splice(i, 1);
  }
  send(data) { this.sent.push(data); }
  // Real close events arrive asynchronously — tests fire them explicitly.
  close() { this.readyState = 3; }
  _fire(event, arg) { for (const fn of [...(this._listeners.get(event) ?? [])]) fn(arg); }
  open() { this.readyState = 1; this._fire('open'); }
  static get last() { return FakeWebSocket.instances.at(-1); }
}

function makeClient(extraOpts = {}) {
  const calls = { disconnected: 0, fatal: [], reconnected: 0, errors: [] };
  const client = new MultiplayerClient({
    onDisconnected()     { calls.disconnected++; },
    onDisconnectFatal(m) { calls.fatal.push(m); },
    onReconnected()      { calls.reconnected++; },
    onError(m)           { calls.errors.push(m); },
    ...extraOpts,
  });
  return { client, calls };
}

/** Connect, open the socket, authenticate, and join a game room. */
function connectInGame(client) {
  client.connect('ws://game.test');
  const ws = FakeWebSocket.last;
  ws.open();
  client._route({ type: 'authOk', player: { id: 'p1', username: 'u', token: 'tok' } });
  client._route({ type: 'matchFound', faction: 'hero', roomId: 'r1', myPlayerId: 'p1' });
  return ws;
}

beforeEach(() => {
  FakeWebSocket.instances = [];
  globalThis.WebSocket = FakeWebSocket;
  mock.timers.enable({ apis: ['setTimeout'] });
});

afterEach(() => {
  mock.timers.reset();
});

// ── Backoff & retry behavior ─────────────────────────────────────────────────

describe('reconnect backoff — MultiplayerClient', () => {
  test('in-game disconnect schedules reconnects with doubling delays', () => {
    const { client, calls } = makeClient();
    const ws1 = connectInGame(client);
    assert.equal(FakeWebSocket.instances.length, 1);

    ws1._fire('close');
    assert.equal(calls.disconnected, 1, 'overlay callback fires on disconnect');

    // Attempt 1: base delay (3000ms) — not a tick earlier
    mock.timers.tick(BASE_MS - 1);
    assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect before base delay');
    mock.timers.tick(1);
    assert.equal(FakeWebSocket.instances.length, 2, 'reconnect after base delay');
    assert.equal(FakeWebSocket.last.url, 'ws://game.test', 'reconnects to same URL');

    // Attempt 2: delay doubles to 6000ms
    FakeWebSocket.last._fire('close');
    mock.timers.tick(2 * BASE_MS - 1);
    assert.equal(FakeWebSocket.instances.length, 2, 'second delay must be doubled');
    mock.timers.tick(1);
    assert.equal(FakeWebSocket.instances.length, 3);

    // Attempt 3: delay doubles again to 12000ms
    FakeWebSocket.last._fire('close');
    mock.timers.tick(4 * BASE_MS - 1);
    assert.equal(FakeWebSocket.instances.length, 3, 'third delay must be doubled again');
    mock.timers.tick(1);
    assert.equal(FakeWebSocket.instances.length, 4);
    assert.equal(calls.fatal.length, 0, 'no give-up while retries remain');
  });

  test('gives up with a fatal error after max retries — no further attempts', () => {
    const { client, calls } = makeClient();
    connectInGame(client)._fire('close');

    for (let i = 0; i < MAX_TRIES; i++) {
      mock.timers.tick(BASE_MS * 2 ** i);     // let attempt i+1 fire
      FakeWebSocket.last._fire('close');      // ...and fail
    }

    assert.equal(calls.fatal.length, 1, 'fatal callback fires once when retries are exhausted');
    assert.match(calls.fatal[0], /Unable to reconnect/);

    const count = FakeWebSocket.instances.length;
    mock.timers.tick(10 * 60 * 1000);
    assert.equal(FakeWebSocket.instances.length, count,
      'no further connection attempts after giving up');
  });

  test('successful reconnect re-authenticates and resets the attempt counter', () => {
    const { client } = makeClient();
    connectInGame(client)._fire('close');

    mock.timers.tick(BASE_MS);
    const ws2 = FakeWebSocket.last;
    ws2.open();

    // The queued re-auth must flush on open, carrying token + room for rejoin
    const auth = ws2.sent.map(s => JSON.parse(s)).find(m => m.type === 'auth');
    assert.ok(auth, 'reconnect must send auth');
    assert.equal(auth.token, 'tok');
    assert.equal(auth.roomId, 'r1');

    // Counter reset: the next disconnect starts back at the base delay
    // (without the reset, the next attempt would wait 6000ms, not 3000ms).
    ws2._fire('close');
    mock.timers.tick(BASE_MS);
    assert.equal(FakeWebSocket.instances.length, 3,
      'attempt counter must reset after a successful open');
  });

  test('disconnect() cancels a pending reconnect timer', () => {
    const { client, calls } = makeClient();
    connectInGame(client)._fire('close');

    client.disconnect();                        // intentional close
    mock.timers.tick(10 * 60 * 1000);
    assert.equal(FakeWebSocket.instances.length, 1, 'no reconnect after intentional disconnect');
    assert.equal(calls.fatal.length, 0);
  });

  test('menu-level disconnect (authenticated, not in game) reconnects silently', () => {
    const { client, calls } = makeClient();
    client.connect('ws://game.test');
    FakeWebSocket.last.open();
    client._route({ type: 'authOk', player: { id: 'p1', username: 'u', token: 'tok' } });

    FakeWebSocket.last._fire('close');
    assert.equal(FakeWebSocket.instances.length, 2,
      'silent reconnect happens immediately for menu-level drops');
    assert.equal(calls.disconnected, 0, 'no reconnect overlay for menu-level drops');
  });

  test('reconnectNow() without a player or URL fails fatally instead of silently', () => {
    const { client, calls } = makeClient();
    client.reconnectNow();
    assert.equal(calls.fatal.length, 1, '_reconnect must surface the failure');
    assert.match(calls.fatal[0], /Unable to reconnect/);
  });
});

// ── Overlay lifecycle: open vs server confirmation ───────────────────────────

describe('reconnect overlay lifecycle', () => {
  test('_onOpen does NOT fire onReconnected on first connect', () => {
    const { client, calls } = makeClient();
    client.connect('ws://game.test');
    FakeWebSocket.last.open();
    assert.equal(calls.reconnected, 0,
      'overlay must stay until the server confirms with a reconnected message');
  });

  test('server reconnected message fires onReconnected and restores game state', () => {
    const { client, calls } = makeClient();
    client.connect('ws://game.test');
    FakeWebSocket.last.open();

    client._route({ type: 'reconnected', faction: 'witch', roomId: 'r9', myPlayerId: 'p1' });
    assert.equal(calls.reconnected, 1);
    assert.equal(client.active, true);
    assert.equal(client.roomId, 'r9');
    assert.equal(client.myFaction, 'witch');
  });

  test('authError while in a game is fatal (session expired mid-reconnect)', () => {
    const { client, calls } = makeClient();
    connectInGame(client);

    client._route({ type: 'authError', message: 'bad token' });
    assert.equal(calls.fatal.length, 1);
    assert.match(calls.fatal[0], /sign in/i);
    assert.equal(client.active, false);
  });

  test('authError outside a game routes to onError, not the fatal path', () => {
    const { client, calls } = makeClient();
    client._route({ type: 'authError', message: 'bad credentials' });
    assert.deepEqual(calls.errors, ['bad credentials']);
    assert.equal(calls.fatal.length, 0);
  });
});

// ── main.js wiring (source-level) ────────────────────────────────────────────
//
// src/main.js is an 8.6k-line entry script with top-level DOM side effects —
// it cannot be imported under node:test without a full browser environment,
// so the handler-wiring invariants below (each guarding a past regression:
// users stuck on the reconnect overlay, or yanked out of unrelated menus by a
// stray error during silent reconnect) are kept as minimal source checks.

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const mainSource = readFileSync(join(__dirname, '..', 'src', 'main.js'), 'utf8');

describe('reconnect stuck-state prevention — main.js wiring (source-level)', () => {
  test('onError detects in-game reconnection failure and escapes to the online screen', () => {
    const idx = mainSource.search(/onError\(msg(?:,\s*raw)?\)\s*\{/);
    assert.ok(idx !== -1, 'onError handler must exist');
    const body = mainSource.slice(idx, idx + 1500);
    assert.ok(body.includes('reconnect-overlay'),
      'onError must check reconnect overlay visibility to detect reconnection failures');
    assert.ok(body.includes('_showOnlineScreen'),
      'onError must offer an escape hatch back to the online screen');
    assert.ok(body.includes('_isOnOnlineFlow'),
      'navigation must be gated so silent-reconnect errors do not eject the user from unrelated menus');
  });

  test('authError handler gates navigation and still refreshes the session bar', () => {
    const idx = mainSource.indexOf("if (msg.type === 'authError')");
    assert.ok(idx !== -1, 'authError handler must exist in patched _route');
    const body = mainSource.slice(idx, idx + 800);
    assert.ok(body.includes('_isOnOnlineFlow') && body.includes('_isOnAsyncFlow'),
      'authError must check the current menu flow before navigating');
    assert.ok(body.includes('_updateSessionBar'),
      'authError must update the session bar when not navigating');
  });
});
