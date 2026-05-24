// Loading-reveal coordinator — regression guard for the "scene comes in and
// then goes back to the loading screen for forest" bug.
//
// All three init paths (local / online / spectator) drive the SAME
// #loading-overlay + #game-canvas. They are fire-and-forget, so two can run at
// once — the everyday trigger is a double-tap on "Start". Whichever renderer
// loads faster reveals the scene; the slower one, still mid-load, used to
// re-show the overlay over the revealed scene with its stale last-asset label
// ("forest", the heaviest GLB). The coordinator serializes reveals with a
// monotonic token: only the latest reveal may touch the shared overlay.

import { describe, test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeShowLoadingAndReveal } from '../src/loading-reveal.js';

// ── Minimal DOM doubles ────────────────────────────────────────────────────
class FakeClassList {
  constructor() { this._set = new Set(); }
  add(c) { this._set.add(c); }
  remove(c) { this._set.delete(c); }
  contains(c) { return this._set.has(c); }
}
class FakeEl {
  constructor() {
    this.hidden = false;
    this.classList = new FakeClassList();
    this.style = {};
    this._children = new Map();
    this.textContent = '';
  }
  querySelector(sel) {
    if (!this._children.has(sel)) this._children.set(sel, new FakeEl());
    return this._children.get(sel);
  }
}
function makeDoc() {
  const overlay = new FakeEl();
  overlay.hidden = true;            // index.html ships `hidden`
  const canvas = new FakeEl();
  const byId = { 'loading-overlay': overlay, 'game-canvas': canvas };
  return {
    getElementById: (id) => byId[id] ?? null,
    overlay, canvas,
    fill: overlay.querySelector('.loading-bar-fill'),
    label: overlay.querySelector('.loading-label'),
  };
}

// Deferred promise helper for controlling whenReady() resolution order.
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

// A renderer double whose load completion we control via `ready`.
function makeRenderer() {
  const ready = deferred();
  return {
    onProgress: null,
    beginLoadCalls: 0,
    drawCalls: 0,
    beginLoad() { this.beginLoadCalls += 1; },
    whenReady() { return ready.promise; },
    draw() { this.drawCalls += 1; },
    _finishLoad: ready.resolve,
  };
}

// Synchronous raf/setTimer so reveals complete deterministically once their
// whenReady() resolves (no real timers, no real frames).
const syncOpts = (doc) => ({
  doc,
  raf: (cb) => { cb(); },
  setTimer: (cb) => { cb(); },
  hideDelayMs: 0,
});

describe('loading-reveal coordinator', () => {
  let doc;
  beforeEach(() => { doc = makeDoc(); });

  test('single reveal: shows the overlay, then reveals canvas and hides overlay', async () => {
    const show = makeShowLoadingAndReveal(syncOpts(doc));
    const r = makeRenderer();

    const p = show(r);
    // Synchronous show phase ran before any await.
    assert.equal(doc.overlay.hidden, false, 'overlay shown at start');
    assert.equal(doc.canvas.classList.contains('canvas-ready'), false, 'canvas hidden until ready');
    assert.equal(r.beginLoadCalls, 1, 'beginLoad invoked');

    r._finishLoad();
    await p;

    assert.equal(doc.canvas.classList.contains('canvas-ready'), true, 'canvas revealed');
    assert.equal(doc.overlay.hidden, true, 'overlay hidden after reveal');
    assert.equal(doc.overlay.classList.contains('fading-out'), false, 'fading-out cleared');
    assert.equal(r.drawCalls, 1, 'first full-quality frame drawn');
  });

  test('progress drives the shared bar + label for the current reveal', async () => {
    const show = makeShowLoadingAndReveal(syncOpts(doc));
    const r = makeRenderer();
    const p = show(r);

    r.onProgress(3, 5, 'forest');
    assert.equal(doc.fill.style.width, '60%', 'bar width tracks loaded/total');
    assert.equal(doc.label.textContent, 'Loading forest…', 'label tracks the asset');

    r._finishLoad();
    await p;
  });

  // The core regression: two concurrent reveals (double-tap Start). The first
  // to finish must NOT win if a newer reveal has superseded it, and the stale
  // reveal must never re-show the overlay after the winner has hidden it.
  test('concurrent reveals: the latest wins; the superseded one never re-shows the overlay', async () => {
    const show = makeShowLoadingAndReveal(syncOpts(doc));
    const rA = makeRenderer(); // first tap
    const rB = makeRenderer(); // second tap — the renderer the game actually uses

    const pA = show(rA);
    const pB = show(rB);

    // Stale renderer A finishes FIRST. It is no longer current (B claimed the
    // latest token), so it must not reveal the canvas or hide the overlay.
    rA._finishLoad();
    await pA;
    assert.equal(rA.drawCalls, 0, 'superseded reveal does not draw/reveal');
    assert.equal(doc.canvas.classList.contains('canvas-ready'), false, 'canvas not revealed by stale reveal');
    assert.equal(doc.overlay.hidden, false, 'overlay still up — B is still loading');

    // The current renderer B finishes: it reveals and hides the overlay.
    rB._finishLoad();
    await pB;
    assert.equal(doc.canvas.classList.contains('canvas-ready'), true, 'canvas revealed by the latest reveal');
    assert.equal(doc.overlay.hidden, true, 'overlay hidden once the latest reveal completes');
  });

  test('a stale renderer that finishes LAST cannot re-cover the revealed scene', async () => {
    const show = makeShowLoadingAndReveal(syncOpts(doc));
    const rA = makeRenderer();
    const rB = makeRenderer();

    const pA = show(rA);
    const pB = show(rB);

    // Winner (B) completes and hides the overlay first.
    rB._finishLoad();
    await pB;
    assert.equal(doc.overlay.hidden, true, 'overlay hidden by winner');

    // The stale A now finishes — it must leave the overlay hidden.
    rA._finishLoad();
    await pA;
    assert.equal(doc.overlay.hidden, true, 'stale reveal did not re-show the overlay');
    assert.equal(rA.drawCalls, 0, 'stale reveal drew nothing');
  });

  test('a stale renderer\'s progress does not drive the shared bar/label', async () => {
    const show = makeShowLoadingAndReveal(syncOpts(doc));
    const rA = makeRenderer();
    const rB = makeRenderer();

    show(rA);
    show(rB); // B now current

    rB.onProgress(1, 5, 'engine');
    assert.equal(doc.label.textContent, 'Loading engine…');

    // Stale A's progress must be ignored — no flicker back to A's labels.
    rA.onProgress(4, 5, 'forest');
    assert.equal(doc.label.textContent, 'Loading engine…', 'stale progress ignored');
    assert.equal(doc.fill.style.width, '20%', 'stale progress did not move the bar');
  });
});
