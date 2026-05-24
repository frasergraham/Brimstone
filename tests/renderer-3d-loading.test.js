// Loading-screen asset bundle — Renderer3D.beginLoad / whenReady / onProgress.
//
// The 3D renderer fires several heavy loads (Babylon engine, tilemap atlas,
// house GLB, paladin GLB, tree pack). main.js hides the canvas behind a loading
// overlay until `whenReady()` resolves, ticking a progress bar from
// `onProgress`. These tests pin the bundle mechanics without a real Babylon
// (the loaders are stubbed with controllable promises):
//   - beginLoad() is idempotent
//   - whenReady() resolves only after every bundle item settles
//   - onProgress fires once per item regardless of resolve order
//   - a rejected item still ticks progress and doesn't reject whenReady
//   - a hung item is released by the safety timeout

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';

const FAKE_CANVAS = { parentElement: null, width: 800, height: 600 };

/** Build a Renderer3D whose five loads are deferred promises we resolve by
 *  hand. `_scene` is set truthy so the scene-dependent loaders (chained behind
 *  the engine promise) actually invoke our stubs. Returns the instance plus a
 *  `settle` map of resolve/reject fns keyed by bundle label. */
function makeStubbedRenderer() {
  const r = new Renderer3D(FAKE_CANVAS, {});
  r._scene = {}; // truthy → afterInit() invokes the GLB loader stubs
  const settle = {};
  const defer = (key) => new Promise((resolve, reject) => {
    settle[key] = { resolve, reject };
  });
  r._initBabylon          = () => defer('engine');
  r.loadImages            = () => defer('sprites');
  r._loadHouseModel       = () => defer('houses');
  r._loadPaladinModel     = () => defer('paladin');
  r._loadTreePackManifest = () => defer('forest');
  return { r, settle };
}

/** Flush the microtask queue so chained `.then`/`.finally` handlers run. */
const tick = () => new Promise(r => setTimeout(r, 0));

describe('Renderer3D loading bundle', () => {
  test('beginLoad() is idempotent — second call does not rebuild the bundle', () => {
    const { r } = makeStubbedRenderer();
    let initCalls = 0;
    r._initBabylon = () => { initCalls += 1; return Promise.resolve(); };

    r.beginLoad();
    const firstBundle = r._assetBundle;
    assert.equal(firstBundle.length, 5, 'bundle should have 5 items');
    assert.equal(initCalls, 1, '_initBabylon should run exactly once');

    r.beginLoad();
    assert.equal(r._assetBundle, firstBundle, 'second beginLoad must not replace the bundle');
    assert.equal(initCalls, 1, 'second beginLoad must not re-init Babylon');
  });

  test('whenReady() resolves only after every bundle item settles', async () => {
    const { r, settle } = makeStubbedRenderer();
    r.beginLoad();

    let resolved = false;
    const ready = r.whenReady().then(() => { resolved = true; });

    // Engine must resolve first — the GLB loaders are chained behind it.
    settle.engine.resolve();
    settle.sprites.resolve();
    await tick();
    assert.equal(resolved, false, 'whenReady resolved before house/paladin/forest settled');

    settle.houses.resolve();
    settle.paladin.resolve();
    await tick();
    assert.equal(resolved, false, 'whenReady resolved before forest settled');

    settle.forest.resolve();
    await ready;
    assert.equal(resolved, true, 'whenReady should resolve once all five settle');
  });

  test('onProgress fires once per item regardless of resolve order', async () => {
    const { r, settle } = makeStubbedRenderer();
    const ticks = [];
    r.onProgress = (loaded, total, label) => ticks.push({ loaded, total, label });

    r.beginLoad();
    // Engine first (others chain on it), then scramble the rest.
    settle.engine.resolve();
    await tick();
    settle.forest.resolve();
    settle.sprites.resolve();
    settle.paladin.resolve();
    settle.houses.resolve();
    await r.whenReady();

    assert.equal(ticks.length, 5, 'onProgress should fire exactly 5 times');
    // loaded counter is monotonic 1..5 and total is always 5.
    assert.deepEqual(ticks.map(t => t.loaded), [1, 2, 3, 4, 5]);
    assert.ok(ticks.every(t => t.total === 5), 'total should always be 5');
    // Every label was reported.
    assert.deepEqual(
      ticks.map(t => t.label).sort(),
      ['engine', 'forest', 'houses', 'paladin', 'sprites'],
    );
  });

  test('a rejected item still ticks progress and does not reject whenReady', async () => {
    const { r, settle } = makeStubbedRenderer();
    let count = 0;
    r.onProgress = () => { count += 1; };

    r.beginLoad();
    settle.engine.resolve();
    await tick();
    settle.sprites.resolve();
    settle.houses.reject(new Error('house.glb 404'));   // simulated GLB failure
    settle.paladin.reject(new Error('paladin.glb 404'));
    settle.forest.resolve();

    // whenReady must resolve (not reject) despite two rejected items.
    await assert.doesNotReject(r.whenReady());
    assert.equal(count, 5, 'progress should tick for failed items too');
  });

  test('safety timeout releases whenReady when an item hangs', async () => {
    const { r, settle } = makeStubbedRenderer();
    r._loadTimeoutMs = 40; // short override instead of the 30s default

    r.beginLoad();
    // Resolve nothing — the engine promise hangs forever, so the chained GLB
    // loaders never even start. Only the safety timeout can release whenReady.
    settle.sprites.resolve();

    const start = Date.now();
    await r.whenReady(); // must resolve via the timeout, not hang the test
    assert.ok(Date.now() - start >= 30, 'whenReady should have waited for the safety timeout');
  });

  test('whenReady() before beginLoad() resolves immediately', async () => {
    const r = new Renderer3D(FAKE_CANVAS, {});
    await assert.doesNotReject(r.whenReady());
  });
});
