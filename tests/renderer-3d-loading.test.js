// Loading-screen asset bundle — Renderer3D.beginLoad / whenReady / onProgress.
//
// The 3D renderer fires several heavy loads (Babylon engine, tilemap atlas,
// house GLB, paladin GLB, tree pack). main.js hides the canvas behind a loading
// overlay until `whenReady()` resolves, ticking a progress bar from
// `onProgress(progress01, label)` — a smoothed aggregate (mean of every item's
// 0..1 fraction) rather than a discrete N-of-M counter. These tests pin the
// bundle mechanics without a real Babylon (the loaders are stubbed with
// controllable promises):
//   - beginLoad() is idempotent
//   - whenReady() resolves only after every bundle item settles
//   - onProgress emits the aggregate fraction; settling each item adds 1/N
//   - byte-level ImportMeshAsync ticks smooth the aggregate (monotonic)
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
  r._initBabylon                  = () => defer('engine');
  r.loadImages                    = () => defer('sprites');
  r._loadBuildingModels           = () => defer('buildings');
  // Hero rig is pre-warmed through the generic cascade now (paladin-idle.glb).
  r._loadFallbackRig              = () => defer('paladin');
  r._loadTreePackManifest         = () => defer('forest');
  r._preloadTerrainDetailTextures = () => defer('terrain');
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
    assert.equal(firstBundle.length, 6, 'bundle should have 6 items');
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

    settle.buildings.resolve();
    settle.paladin.resolve();
    await tick();
    assert.equal(resolved, false, 'whenReady resolved before forest+terrain settled');

    settle.forest.resolve();
    settle.terrain.resolve();
    await ready;
    assert.equal(resolved, true, 'whenReady should resolve once all six settle');
  });

  test('onProgress emits the aggregate fraction as each item settles', async () => {
    const { r, settle } = makeStubbedRenderer();
    const ticks = [];
    r.onProgress = (progress01, label) => ticks.push({ progress01, label });

    r.beginLoad();
    // Engine first (others chain on it), then scramble the rest.
    settle.engine.resolve();
    await tick();
    settle.forest.resolve();
    settle.sprites.resolve();
    settle.paladin.resolve();
    settle.buildings.resolve();
    settle.terrain.resolve();
    await r.whenReady();

    assert.equal(ticks.length, 6, 'onProgress should fire exactly 6 times (once per settle)');
    // Each settled item adds 1/6 to the aggregate, monotonically to 1.0.
    // Approximate compare — floating-point summation order produces sub-ULP
    // differences vs. `i × (1/6)` after the 5th tick (0.833…3 vs 0.833…4).
    const SIXTH = 1 / 6;
    const expected = [1, 2, 3, 4, 5, 6].map(i => i * SIXTH);
    ticks.forEach((t, i) => assert.ok(Math.abs(t.progress01 - expected[i]) < 1e-9,
      `tick ${i} = ${t.progress01}, expected ~${expected[i]}`));
    // Every label was reported as the item that advanced.
    assert.deepEqual(
      ticks.map(t => t.label).sort(),
      ['buildings', 'engine', 'forest', 'paladin', 'sprites', 'terrain'],
    );
  });

  test('byte-level progress smooths the aggregate (monotonic; ignores non-computable)', () => {
    const { r } = makeStubbedRenderer();
    const ticks = [];
    r.onProgress = (progress01, label) => ticks.push({ progress01, label });
    r.beginLoad();

    // buildings at 50% of its bytes → 0.5 of one of six items ≈ 0.0833 aggregate.
    r._glbProgressHandler('buildings')({ lengthComputable: true, loaded: 50, total: 100 });
    assert.equal(ticks.at(-1).progress01, 0.5 / 6);
    assert.equal(ticks.at(-1).label, 'buildings');

    // A regressing fraction is ignored — the bar never goes backwards.
    const beforeRegress = ticks.length;
    r._glbProgressHandler('buildings')({ lengthComputable: true, loaded: 10, total: 100 });
    assert.equal(ticks.length, beforeRegress, 'regressing byte progress is ignored');

    // A non-computable event (no Content-Length) is ignored — .finally pins it.
    r._glbProgressHandler('buildings')({ lengthComputable: false, loaded: 0, total: 0 });
    assert.equal(ticks.length, beforeRegress, 'non-computable progress is ignored');

    // Advancing further re-emits a higher aggregate.
    r._glbProgressHandler('buildings')({ lengthComputable: true, loaded: 100, total: 100 });
    assert.equal(ticks.at(-1).progress01, 1 / 6, 'buildings fully streamed → 1/6 of the bundle');

    // An unknown id is a no-op (no crash, no emit).
    const beforeUnknown = ticks.length;
    r._glbProgressHandler('nope')({ lengthComputable: true, loaded: 1, total: 1 });
    assert.equal(ticks.length, beforeUnknown, 'unknown item id is ignored');
  });

  test('a rejected item still ticks progress to 1.0 and does not reject whenReady', async () => {
    const { r, settle } = makeStubbedRenderer();
    let last = 0;
    let count = 0;
    r.onProgress = (progress01) => { last = progress01; count += 1; };

    r.beginLoad();
    settle.engine.resolve();
    await tick();
    settle.sprites.resolve();
    settle.buildings.reject(new Error('buildings church.glb 404'));   // simulated GLB failure
    settle.paladin.reject(new Error('paladin.glb 404'));
    settle.forest.resolve();
    settle.terrain.resolve();

    // whenReady must resolve (not reject) despite two rejected items.
    await assert.doesNotReject(r.whenReady());
    assert.equal(count, 6, 'progress should tick for failed items too');
    assert.equal(last, 1.0, 'aggregate reaches 1.0 even when items fail');
  });

  test('safety timeout releases whenReady when an item hangs', async () => {
    const { r, settle } = makeStubbedRenderer();
    r._loadTimeoutMs = 40; // short override instead of the 30s default

    r.beginLoad();
    // Resolve nothing — the engine promise hangs forever, so the chained GLB
    // loaders never even start. Only the safety timeout can release whenReady.
    settle.sprites.resolve();

    // whenReady's safety timer is unref()'d so it never keeps a real process
    // alive (correct for production, where Babylon's render loop holds the loop
    // open). This test has no such loop, so without a ref'd keep-alive Node can
    // drain the event loop before the unref'd 40ms timer fires and cancel the
    // test ("Promise resolution is still pending but the event loop has already
    // resolved"). Hold the loop open until whenReady settles, then release it.
    const keepAlive = setInterval(() => {}, 10);
    const start = Date.now();
    try {
      await r.whenReady(); // must resolve via the timeout, not hang the test
    } finally {
      clearInterval(keepAlive);
    }
    assert.ok(Date.now() - start >= 30, 'whenReady should have waited for the safety timeout');
  });

  test('whenReady() before beginLoad() resolves immediately', async () => {
    const r = new Renderer3D(FAKE_CANVAS, {});
    await assert.doesNotReject(r.whenReady());
  });
});
