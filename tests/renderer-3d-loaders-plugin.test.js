// Tests for `_ensureBabylonLoaders` — the helper that registers Babylon's
// glTF loader plugin so SceneLoader can parse `.glb` files. The previous
// implementation used `await import('https://…/@babylonjs/loaders/+esm')`,
// which bundles its own copy of @babylonjs/core and registers the plugin on
// the wrong BABYLON instance — Babylon then falls back to the JSON `.babylon`
// loader and rejects GLB files with "importMesh has failed JSON parse".
//
// The fix swaps to the UMD bundle via a <script> tag (mirroring the existing
// inspector loader at renderer-3d.js:~1785). This test pins:
//   • idempotent — never injects a duplicate script
//   • resolves true on script load, false on error
//   • returns false (no throw) when there's no DOM
//   • _loadHouseModel awaits this helper before calling ImportMeshAsync
//
// Task: t-87dced06. Consumers: t-cfee95e5 (house), t-6bf7942e (paladin).

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

/** Minimal fake `document` — only the surface `_ensureBabylonLoaders` touches.
 *  Returns { document, scripts } so the test can poke at the recorded scripts. */
function makeFakeDocument() {
  const scripts = [];
  let queryHits = [];
  const makeScript = () => {
    const listeners = { load: [], error: [] };
    const dataset = {};
    return {
      tagName: 'SCRIPT',
      dataset,
      async: false,
      src: '',
      addEventListener(type, fn) { (listeners[type] || []).push(fn); },
      _fire(type) {
        for (const fn of (listeners[type] || []).slice()) fn(new Event(type));
      },
      _listeners: listeners,
    };
  };
  // Stub Event constructor for the node environment.
  if (typeof globalThis.Event === 'undefined') {
    globalThis.Event = class Event { constructor(t) { this.type = t; } };
  }
  const document = {
    createElement(tag) {
      assert.equal(tag, 'script');
      const s = makeScript();
      return s;
    },
    head: {
      appendChild(node) { scripts.push(node); },
    },
    querySelector(selector) {
      // Return the first matching script from `queryHits`, popped after use
      // so successive calls can return different results (or null).
      if (queryHits.length === 0) return null;
      // Only respond to the loader-specific selector.
      if (selector === 'script[data-babylon-loaders]') return queryHits.shift();
      return null;
    },
    _setQueryHits(arr) { queryHits = arr; },
  };
  return { document, scripts };
}

let savedDocument;
beforeEach(() => { savedDocument = globalThis.document; });
afterEach(() => {
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
});

describe('_ensureBabylonLoaders — script injection', () => {
  test('returns false (no throw) when document is undefined', async () => {
    delete globalThis.document;
    const r = newInst();
    r._babylon = {};
    const ok = await r._ensureBabylonLoaders();
    assert.equal(ok, false);
    assert.equal(r._babylonLoadersReady, undefined);
  });

  test('injects a <script> tag pointing at the babylon UMD loaders bundle', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    const r = newInst();
    r._babylon = { SceneLoader: { IsPluginForExtensionAvailable: () => false } };

    const pending = r._ensureBabylonLoaders();
    // Script must be injected immediately (synchronously, before the await).
    assert.equal(scripts.length, 1);
    const s = scripts[0];
    // Pin: loaders bundle MUST come from the local `assets/vendor/` path so
    // the packaged Electron / iOS build has zero runtime CDN dependencies.
    assert.equal(s.src, '/assets/vendor/babylonjs/babylonjs.loaders.min.js');
    assert.equal(s.async, true);
    assert.equal(s.dataset.babylonLoaders, 'true');

    // Once load fires AND the plugin reports available, resolve true.
    r._babylon.SceneLoader.IsPluginForExtensionAvailable = (ext) => ext === '.glb';
    s._fire('load');
    const ok = await pending;
    assert.equal(ok, true);
    assert.equal(s.dataset.loaded, 'true');
    assert.equal(r._babylonLoadersReady, true);
  });

  test('resolves false when the script errors out (CDN unreachable)', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    const r = newInst();
    r._babylon = { SceneLoader: { IsPluginForExtensionAvailable: () => false } };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const pending = r._ensureBabylonLoaders();
      scripts[0]._fire('error');
      const ok = await pending;
      assert.equal(ok, false);
      assert.equal(r._babylonLoadersReady, undefined);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('resolves false when the script loads but no .glb plugin registers', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    const r = newInst();
    // Plugin check stays false even after load — simulates the script landing
    // but failing to register on our BABYLON (the exact bug this fix addresses).
    r._babylon = { SceneLoader: { IsPluginForExtensionAvailable: () => false } };

    const originalWarn = console.warn;
    let warned = false;
    console.warn = (msg) => { if (/plugin not registered/.test(String(msg))) warned = true; };
    try {
      const pending = r._ensureBabylonLoaders();
      scripts[0]._fire('load');
      const ok = await pending;
      assert.equal(ok, false);
      assert.equal(warned, true, 'must warn so operator sees the registration failure');
    } finally {
      console.warn = originalWarn;
    }
  });

  test('idempotent — second call does not inject a duplicate script', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    const r = newInst();
    r._babylon = { SceneLoader: { IsPluginForExtensionAvailable: () => true } };

    // First call fast-paths through the plugin-already-available check.
    const ok1 = await r._ensureBabylonLoaders();
    assert.equal(ok1, true);
    assert.equal(scripts.length, 0, 'no script needed when plugin is already present');

    // Second call is a no-op via the _babylonLoadersReady flag.
    const ok2 = await r._ensureBabylonLoaders();
    assert.equal(ok2, true);
    assert.equal(scripts.length, 0);
  });

  test('concurrent callers share one in-flight script load', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    const r = newInst();
    let pluginRegistered = false;
    r._babylon = {
      SceneLoader: { IsPluginForExtensionAvailable: () => pluginRegistered },
    };

    const a = r._ensureBabylonLoaders();
    const b = r._ensureBabylonLoaders();
    assert.equal(scripts.length, 1, 'only one script tag despite concurrent calls');

    pluginRegistered = true;
    scripts[0]._fire('load');
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, true);
    assert.equal(rb, true);
  });

  test('re-uses an existing <script data-babylon-loaders> that another instance injected', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    // Pre-existing script already in the DOM, not yet loaded.
    const existing = {
      tagName: 'SCRIPT',
      dataset: { babylonLoaders: 'true' },
      _listeners: { load: [], error: [] },
      addEventListener(type, fn) { this._listeners[type].push(fn); },
      _fire(type) { for (const fn of this._listeners[type].slice()) fn(new Event(type)); },
    };
    document._setQueryHits([existing]);

    const r = newInst();
    r._babylon = { SceneLoader: { IsPluginForExtensionAvailable: () => true } };

    const pending = r._ensureBabylonLoaders();
    assert.equal(scripts.length, 0, 'must not inject a second script when one already exists');

    existing._fire('load');
    const ok = await pending;
    assert.equal(ok, true);
  });
});

describe('_loadHouseModel — invokes the loaders helper', () => {
  test('awaits _ensureBabylonLoaders BEFORE calling ImportMeshAsync', async () => {
    const r = newInst();
    r._scene = {};
    const calls = [];

    // Track ordering: helper must finish before import starts.
    let helperResolved = false;
    r._ensureBabylonLoaders = async () => {
      calls.push('ensure');
      await Promise.resolve(); // simulate one tick of async work
      helperResolved = true;
      return true;
    };

    r._babylon = {
      Vector3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      Mesh: { MergeMeshes: () => null },
      SceneLoader: {
        ImportMeshAsync: async () => {
          calls.push('import');
          assert.equal(helperResolved, true, 'helper must resolve before import is called');
          return { meshes: [] };
        },
      },
    };

    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      await r._loadHouseModel('assets');
    } finally {
      console.warn = originalWarn;
    }
    assert.deepEqual(calls, ['ensure', 'import']);
  });

  test('still proceeds with ImportMeshAsync when the helper returns false (test/stub path)', async () => {
    // This is the headless test path: SceneLoader.ImportMeshAsync is stubbed
    // directly on the fake BABYLON, so even though the helper can't inject a
    // <script> tag (no DOM), the import succeeds against the stub.
    const r = newInst();
    r._scene = {};
    r._ensureBabylonLoaders = async () => false;

    const fakeMesh = {
      name: 'house', isPickable: true, metadata: null, isEnabled: true,
      renderingGroupId: 7, position: { x: 0, y: 0, z: 0 }, scaling: null, rotation: null,
      getTotalVertices: () => 36, getTotalIndices: () => 36,
      setEnabled(b) { this.isEnabled = b; }, dispose() {},
      createInstance() { return null; },
    };
    r._babylon = {
      Vector3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } },
      Mesh: { MergeMeshes: () => null },
      SceneLoader: { ImportMeshAsync: async () => ({ meshes: [fakeMesh] }) },
    };
    const loaded = await r._loadHouseModel('assets');
    assert.equal(loaded, fakeMesh, 'house loads against the test stub even without a real loaders plugin');
  });
});
