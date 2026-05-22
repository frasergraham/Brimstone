// Tests for `_ensureBabylonReady` — the unified Babylon CORE + LOADERS UMD
// bridge. Previously the renderer loaded core via ESM (`@babylonjs/core/+esm`)
// and loaders via UMD <script>; that produced two distinct BABYLON instances:
// the ESM one the renderer used, and the UMD one the loaders bundle attached
// its glTF plugin to. Two failure modes followed:
//   • "Unable to find a plugin to load .glb files" — ImportMeshAsync ran on
//     the ESM BABYLON which never saw the plugin registration.
//   • "Cannot read properties of undefined (reading 'ANIMATIONLOOPMODE_CYCLE')"
//     — the loaders bundle parses GLB animation tracks via
//     `BABYLON.Animation.ANIMATIONLOOPMODE_CYCLE` but `window.BABYLON.Animation`
//     was undefined because core had only been loaded as ESM.
//
// `_ensureBabylonReady` fixes both by loading core + loaders as UMD <script>
// tags so they share a single `window.BABYLON`. This file pins:
//   • core script injected BEFORE loaders (order matters — loaders reads
//     `window.BABYLON.Animation` at script-eval time)
//   • plugin-availability check is the final gate before returning
//   • idempotent — second call injects no duplicate scripts
//   • throws when core fails to load
//   • throws when loaders fail to register
//   • returns the same `window.BABYLON` the renderer's `_babylon` points at
//
// Task: t-3e24a29f.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

function makeFakeDocument() {
  const scripts = [];
  const makeScript = () => {
    const listeners = { load: [], error: [] };
    const dataset = {};
    return {
      tagName: 'SCRIPT', dataset, async: false, src: '',
      addEventListener(type, fn) { (listeners[type] || []).push(fn); },
      _fire(type) { for (const fn of (listeners[type] || []).slice()) fn(new Event(type)); },
      _listeners: listeners,
    };
  };
  if (typeof globalThis.Event === 'undefined') {
    globalThis.Event = class Event { constructor(t) { this.type = t; } };
  }
  const document = {
    createElement(tag) { assert.equal(tag, 'script'); return makeScript(); },
    head: { appendChild(node) { scripts.push(node); } },
    querySelector() { return null; },
  };
  return { document, scripts };
}

let savedDocument, savedWindow;
beforeEach(() => {
  savedDocument = globalThis.document;
  savedWindow   = globalThis.window;
});
afterEach(() => {
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
  if (savedWindow === undefined) delete globalThis.window;
  else globalThis.window = savedWindow;
});

describe('_ensureBabylonReady — combined core + loaders UMD bridge', () => {
  test('injects core script BEFORE loaders script', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    // No window.BABYLON yet — both scripts must inject.
    globalThis.window = {};

    const r = newInst();
    const pending = r._ensureBabylonReady();

    // The core script must be injected first; loaders waits for core load.
    assert.equal(scripts.length, 1, 'only the core script is injected before its load fires');
    assert.match(scripts[0].src, /babylon\.js$/);
    assert.equal(scripts[0].dataset.babylonCore, 'true');

    // Simulate core script finishing — loaders bundle attaches to window.BABYLON.
    globalThis.window.BABYLON = {
      Engine: function () {},
      Animation: { ANIMATIONLOOPMODE_CYCLE: 1 },
      SceneLoader: { IsPluginForExtensionAvailable: () => false },
    };
    scripts[0]._fire('load');

    // Let the microtask queue advance so _ensureBabylonReady can chain into
    // _ensureBabylonLoaders and inject the second script.
    await Promise.resolve();
    await Promise.resolve();

    assert.equal(scripts.length, 2, 'loaders script must be injected only AFTER core load');
    assert.match(scripts[1].src, /babylonjs\.loaders\.min\.js$/);
    assert.equal(scripts[1].dataset.babylonLoaders, 'true');

    // Now flip the plugin-availability check (simulating the UMD bundle's
    // RegisterPlugin side-effect) and fire the loaders load event.
    globalThis.window.BABYLON.SceneLoader.IsPluginForExtensionAvailable = (ext) => ext === '.glb';
    scripts[1]._fire('load');

    const BABYLON = await pending;
    // Returns the SAME window.BABYLON the renderer's _babylon points at.
    assert.equal(BABYLON, globalThis.window.BABYLON);
    assert.equal(r._babylon, globalThis.window.BABYLON);
  });

  test('plugin-availability check is the final gate — throws if .glb never registers', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    globalThis.window = {};

    const r = newInst();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const pending = r._ensureBabylonReady();
      // Core lands successfully.
      globalThis.window.BABYLON = {
        Engine: function () {},
        SceneLoader: { IsPluginForExtensionAvailable: () => false },
      };
      scripts[0]._fire('load');
      await Promise.resolve(); await Promise.resolve();
      // Loaders script lands but plugin never registers — pathological CDN /
      // BABYLON-mismatch scenario. Helper must throw, not silently succeed.
      scripts[1]._fire('load');
      await assert.rejects(pending, /loaders plugin failed to register/);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('throws when core script errors out', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    globalThis.window = {};

    const r = newInst();
    const pending = r._ensureBabylonReady();
    scripts[0]._fire('error');
    await assert.rejects(pending, /Babylon core script failed to load/);
  });

  test('idempotent — second call injects no duplicate scripts', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    // Pre-populated BABYLON (host page loaded it itself, or a previous
    // renderer instance did). Both code paths should fast-path through.
    globalThis.window = {
      BABYLON: {
        Engine: function () {},
        SceneLoader: { IsPluginForExtensionAvailable: (ext) => ext === '.glb' },
      },
    };

    const r = newInst();
    const BABYLON = await r._ensureBabylonReady();
    assert.equal(scripts.length, 0, 'no scripts needed when core + plugin are already present');
    assert.equal(BABYLON, globalThis.window.BABYLON);

    // Second call must not re-inject.
    const BABYLON2 = await r._ensureBabylonReady();
    assert.equal(scripts.length, 0);
    assert.equal(BABYLON2, BABYLON);
  });

  test('concurrent callers share the in-flight core load', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    globalThis.window = {};

    const r = newInst();
    const a = r._ensureBabylonReady();
    const b = r._ensureBabylonReady();
    // Both calls must share ONE core script, not race to inject two.
    assert.equal(scripts.length, 1);
    assert.equal(scripts[0].dataset.babylonCore, 'true');

    globalThis.window.BABYLON = {
      Engine: function () {},
      SceneLoader: { IsPluginForExtensionAvailable: (ext) => ext === '.glb' },
    };
    scripts[0]._fire('load');
    await Promise.resolve(); await Promise.resolve();
    // After core lands the loaders helper sees the plugin already available
    // (the fake BABYLON has it baked in) so no loaders script is injected.
    assert.equal(scripts.length, 1);

    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, globalThis.window.BABYLON);
    assert.equal(rb, globalThis.window.BABYLON);
  });

  test('throws with a clear message when document is unavailable (headless)', async () => {
    delete globalThis.document;
    delete globalThis.window;
    const r = newInst();
    await assert.rejects(r._ensureBabylonReady(), /requires a browser DOM/);
  });
});
