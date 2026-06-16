// Behavioral tests for the WebSocket heartbeat (ping/pong) mechanism in
// server/heartbeat.js (wired into server.js).
//
// Verifies, with fake sockets and injected timers:
//   - new connections are marked alive
//   - a pong resets the alive flag (socket survives consecutive sweeps)
//   - a missed pong gets the connection terminated (and not pinged again)
//   - the periodic interval is started with the configured period and is
//     cleared when the WebSocketServer closes

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEARTBEAT_INTERVAL_MS, attachHeartbeat, heartbeatTick, startHeartbeat,
} from '../server/heartbeat.js';

// ── Fakes ────────────────────────────────────────────────────────────────────

function fakeWs() {
  const ws = {
    pings: 0,
    terminated: false,
    _handlers: new Map(),
    on(event, fn) {
      const arr = ws._handlers.get(event) ?? [];
      arr.push(fn);
      ws._handlers.set(event, arr);
    },
    emit(event, ...args) {
      for (const fn of ws._handlers.get(event) ?? []) fn(...args);
    },
    ping()      { ws.pings++; },
    terminate() { ws.terminated = true; },
  };
  return ws;
}

function fakeWss(...sockets) {
  const wss = {
    clients: new Set(sockets),
    _handlers: new Map(),
    on(event, fn) {
      const arr = wss._handlers.get(event) ?? [];
      arr.push(fn);
      wss._handlers.set(event, arr);
    },
    emit(event, ...args) {
      for (const fn of wss._handlers.get(event) ?? []) fn(...args);
    },
  };
  return wss;
}

/** Injectable fake timers — records setInterval/clearInterval calls. */
function fakeTimers() {
  const t = {
    intervals: [],   // { fn, ms, handle, cleared }
    setInterval(fn, ms) {
      const entry = { fn, ms, handle: Symbol('interval'), cleared: false };
      t.intervals.push(entry);
      return entry.handle;
    },
    clearInterval(handle) {
      const entry = t.intervals.find(i => i.handle === handle);
      if (entry) entry.cleared = true;
    },
  };
  return t;
}

// ── attachHeartbeat ──────────────────────────────────────────────────────────

describe('attachHeartbeat', () => {
  test('marks a new connection alive', () => {
    const ws = fakeWs();
    attachHeartbeat(ws);
    assert.equal(ws._isAlive, true);
  });

  test('pong resets the alive flag after a sweep cleared it', () => {
    const ws  = fakeWs();
    const wss = fakeWss(ws);
    attachHeartbeat(ws);

    heartbeatTick(wss);            // sweep clears _isAlive and pings
    assert.equal(ws._isAlive, false);
    ws.emit('pong');               // client answered the ping
    assert.equal(ws._isAlive, true);
  });
});

// ── heartbeatTick ────────────────────────────────────────────────────────────

describe('heartbeatTick', () => {
  test('pings live connections and marks them pending', () => {
    const ws  = fakeWs();
    const wss = fakeWss(ws);
    attachHeartbeat(ws);

    heartbeatTick(wss);
    assert.equal(ws.pings, 1, 'live socket should be pinged');
    assert.equal(ws.terminated, false);
    assert.equal(ws._isAlive, false, 'alive flag cleared until pong arrives');
  });

  test('a responsive socket survives many sweeps', () => {
    const ws  = fakeWs();
    const wss = fakeWss(ws);
    attachHeartbeat(ws);

    for (let i = 0; i < 5; i++) {
      heartbeatTick(wss);
      ws.emit('pong');
    }
    assert.equal(ws.terminated, false);
    assert.equal(ws.pings, 5);
  });

  test('a missed pong terminates the connection on the next sweep', () => {
    const ws  = fakeWs();
    const wss = fakeWss(ws);
    attachHeartbeat(ws);

    heartbeatTick(wss);            // ping sent, no pong follows
    heartbeatTick(wss);            // missed pong → terminate
    assert.equal(ws.terminated, true);
    assert.equal(ws.pings, 1, 'dead socket must not be pinged again');
  });

  test('terminating one socket does not affect responsive peers', () => {
    const dead = fakeWs();
    const live = fakeWs();
    const wss  = fakeWss(dead, live);
    attachHeartbeat(dead);
    attachHeartbeat(live);

    heartbeatTick(wss);
    live.emit('pong');             // only `live` answers
    heartbeatTick(wss);

    assert.equal(dead.terminated, true);
    assert.equal(live.terminated, false);
    assert.equal(live.pings, 2);
  });

  test('invokes onAlive only for surviving sockets (state-sync heartbeat hook)', () => {
    const dead = fakeWs();
    const live = fakeWs();
    const wss  = fakeWss(dead, live);
    attachHeartbeat(live);         // `dead` never attached → _isAlive undefined

    const seen = [];
    heartbeatTick(wss, ws => seen.push(ws));
    assert.deepEqual(seen, [live], 'onAlive must fire for live sockets only');
  });
});

// ── startHeartbeat ───────────────────────────────────────────────────────────

describe('startHeartbeat', () => {
  test('schedules the sweep at the configured interval', () => {
    const timers = fakeTimers();
    const wss    = fakeWss();
    startHeartbeat(wss, null, 5000, timers);

    assert.equal(timers.intervals.length, 1);
    assert.equal(timers.intervals[0].ms, 5000);
  });

  test('defaults to HEARTBEAT_INTERVAL_MS (10–30s zombie-detection window)', () => {
    const timers = fakeTimers();
    startHeartbeat(fakeWss(), null, undefined, timers);
    assert.equal(timers.intervals[0].ms, HEARTBEAT_INTERVAL_MS);
    assert.ok(HEARTBEAT_INTERVAL_MS >= 10_000 && HEARTBEAT_INTERVAL_MS <= 30_000,
      `HEARTBEAT_INTERVAL_MS should be 10-30s, got ${HEARTBEAT_INTERVAL_MS}ms`);
  });

  test('each interval firing runs a sweep over wss.clients', () => {
    const timers = fakeTimers();
    const ws     = fakeWs();
    const wss    = fakeWss(ws);
    attachHeartbeat(ws);
    startHeartbeat(wss, null, 1000, timers);

    timers.intervals[0].fn();      // simulate the interval firing
    assert.equal(ws.pings, 1);
    timers.intervals[0].fn();      // no pong in between → terminated
    assert.equal(ws.terminated, true);
  });

  test('clears the interval when the WebSocketServer closes', () => {
    const timers = fakeTimers();
    const wss    = fakeWss();
    const handle = startHeartbeat(wss, null, 1000, timers);

    assert.equal(timers.intervals[0].cleared, false);
    wss.emit('close');
    assert.equal(timers.intervals[0].cleared, true);
    assert.equal(timers.intervals[0].handle, handle, 'returned handle is the scheduled interval');
  });
});
