// Tests pinning that Babylon core + glTF loaders are loaded from the local
// `assets/vendor/babylonjs/` directory rather than any CDN. The packaged
// Electron / iOS app must run with zero runtime CDN dependencies; previously
// core was pulled in via `await import('https://cdn.jsdelivr.net/...+esm')`
// and loaders from `cdn.babylonjs.com`, which broke the offline guarantee
// and also created two BABYLON instances (the ESM-bundled internal copy vs
// the UMD `window.BABYLON`) — the glTF plugin registered on the wrong one,
// so SceneLoader rejected GLB files with "Unable to find a plugin to load
// .glb".
//
// This file pins:
//   • `_ensureBabylonCore` injects a <script> tag pointing at the local UMD
//   • `_ensureBabylonCore` is idempotent (no duplicate scripts)
//   • concurrent callers share the same in-flight promise
//   • `_ensureBabylonReady` calls core BEFORE loaders (composition order)
//   • the renderer-3d.js source contains NO CDN URLs (regex on file body)
//
// Task: t-712490e3.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { Renderer3D } from '../src/renderer-3d.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RENDERER_SOURCE = readFileSync(
  resolve(__dirname, '..', 'src', 'renderer-3d.js'),
  'utf8',
);

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

function makeFakeDocument() {
  const scripts = [];
  let queryHits = new Map();
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
  if (typeof globalThis.Event === 'undefined') {
    globalThis.Event = class Event { constructor(t) { this.type = t; } };
  }
  const document = {
    createElement(tag) {
      assert.equal(tag, 'script');
      return makeScript();
    },
    head: {
      appendChild(node) { scripts.push(node); },
    },
    querySelector(selector) {
      const hit = queryHits.get(selector);
      if (Array.isArray(hit)) return hit.shift() || null;
      return hit || null;
    },
    _setQueryHit(selector, value) { queryHits.set(selector, value); },
  };
  return { document, scripts };
}

let savedDocument;
let savedWindow;
beforeEach(() => {
  savedDocument = globalThis.document;
  savedWindow = globalThis.window;
});
afterEach(() => {
  if (savedDocument === undefined) delete globalThis.document;
  else globalThis.document = savedDocument;
  if (savedWindow === undefined) delete globalThis.window;
  else globalThis.window = savedWindow;
});

describe('_ensureBabylonCore — script injection from local vendor path', () => {
  test('returns null (no throw) when document is undefined', async () => {
    delete globalThis.document;
    delete globalThis.window;
    const r = newInst();
    const result = await r._ensureBabylonCore();
    assert.equal(result, null);
  });

  test('returns existing window.BABYLON without injecting a script', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    const fakeBabylon = { Engine: function () {}, Scene: function () {} };
    globalThis.window = { BABYLON: fakeBabylon };

    const r = newInst();
    const result = await r._ensureBabylonCore();
    assert.equal(result, fakeBabylon);
    assert.equal(scripts.length, 0, 'must not inject when BABYLON is already present');
  });

  test('injects a <script> pointing at the local core UMD bundle', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    globalThis.window = { BABYLON: undefined };

    const r = newInst();
    const pending = r._ensureBabylonCore();
    assert.equal(scripts.length, 1, 'script tag must be injected synchronously');
    const s = scripts[0];
    // Pin: core MUST come from the packaged `assets/vendor/` path — no CDN —
    // and RELATIVE (no leading slash) so it resolves under the static itch.io
    // zip sub-path root as well as capacitor://localhost/ and the Electron root.
    assert.equal(s.src, 'assets/vendor/babylonjs/babylon.js');
    assert.equal(s.async, true);
    assert.equal(s.dataset.babylonCore, 'true');

    // Simulate the UMD bundle finishing: populates window.BABYLON, fires load.
    const fakeBabylon = { Engine: function () {}, Scene: function () {} };
    globalThis.window.BABYLON = fakeBabylon;
    s._fire('load');
    const result = await pending;
    assert.equal(result, fakeBabylon);
    assert.equal(s.dataset.loaded, 'true');
  });

  test('resolves null when the script errors out', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    globalThis.window = { BABYLON: undefined };

    const r = newInst();
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
      const pending = r._ensureBabylonCore();
      scripts[0]._fire('error');
      const result = await pending;
      assert.equal(result, null);
    } finally {
      console.warn = originalWarn;
    }
  });

  test('concurrent callers share one in-flight script load', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    globalThis.window = { BABYLON: undefined };

    const r = newInst();
    const a = r._ensureBabylonCore();
    const b = r._ensureBabylonCore();
    assert.equal(scripts.length, 1, 'only one script tag despite concurrent calls');

    const fakeBabylon = { Engine: function () {} };
    globalThis.window.BABYLON = fakeBabylon;
    scripts[0]._fire('load');
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(ra, fakeBabylon);
    assert.equal(rb, fakeBabylon);
  });

  test('re-uses an existing <script data-babylon-core> from a prior instance', async () => {
    const { document, scripts } = makeFakeDocument();
    globalThis.document = document;
    globalThis.window = { BABYLON: undefined };

    const existing = {
      tagName: 'SCRIPT',
      dataset: { babylonCore: 'true' },
      _listeners: { load: [], error: [] },
      addEventListener(type, fn) { this._listeners[type].push(fn); },
      _fire(type) { for (const fn of this._listeners[type].slice()) fn(new Event(type)); },
    };
    document._setQueryHit('script[data-babylon-core]', existing);

    const r = newInst();
    const pending = r._ensureBabylonCore();
    assert.equal(scripts.length, 0, 'must not inject a second script when one already exists');

    const fakeBabylon = { Engine: function () {} };
    globalThis.window.BABYLON = fakeBabylon;
    existing._fire('load');
    const result = await pending;
    assert.equal(result, fakeBabylon);
  });
});

describe('_ensureBabylonReady — composition order', () => {
  test('calls core BEFORE loaders', async () => {
    const r = newInst();
    const calls = [];
    const fakeBabylon = { _tag: 'fake' };
    r._ensureBabylonCore = async () => {
      calls.push('core');
      // Loaders helper must not have been invoked yet at this point.
      assert.deepEqual(calls, ['core']);
      return fakeBabylon;
    };
    r._ensureBabylonLoaders = async () => {
      calls.push('loaders');
      // By the time loaders runs, core has resolved and `this._babylon` is set.
      assert.equal(r._babylon, fakeBabylon);
      return true;
    };
    const result = await r._ensureBabylonReady();
    assert.deepEqual(calls, ['core', 'loaders']);
    assert.equal(result, fakeBabylon);
  });

  test('returns null and skips loaders when core fails', async () => {
    const r = newInst();
    let loadersCalled = false;
    r._ensureBabylonCore = async () => null;
    r._ensureBabylonLoaders = async () => { loadersCalled = true; return true; };
    const result = await r._ensureBabylonReady();
    assert.equal(result, null);
    assert.equal(loadersCalled, false);
  });

  test('returns BABYLON even when loaders fail (GLB fallback is silent)', async () => {
    const r = newInst();
    const fakeBabylon = { _tag: 'fake' };
    r._ensureBabylonCore = async () => fakeBabylon;
    r._ensureBabylonLoaders = async () => false;
    const result = await r._ensureBabylonReady();
    // Loaders failure is non-fatal: core still works, GLB consumers fall back
    // to procedural geometry.
    assert.equal(result, fakeBabylon);
  });
});

describe('renderer-3d.js source — no CDN URLs', () => {
  test('contains no "cdn.babylonjs.com" substring', () => {
    assert.equal(
      RENDERER_SOURCE.includes('cdn.babylonjs.com'),
      false,
      'renderer-3d.js must not reference cdn.babylonjs.com — packaged builds must run offline',
    );
  });

  test('contains no "cdn.jsdelivr.net" substring', () => {
    assert.equal(
      RENDERER_SOURCE.includes('cdn.jsdelivr.net'),
      false,
      'renderer-3d.js must not reference cdn.jsdelivr.net — packaged builds must run offline',
    );
  });

  test('references the local babylon core path (relative — itch sub-path safe)', () => {
    assert.ok(
      RENDERER_SOURCE.includes('assets/vendor/babylonjs/babylon.js'),
      'renderer-3d.js must load babylon core from the local vendor path',
    );
    assert.ok(
      !RENDERER_SOURCE.includes('/assets/vendor/babylonjs/babylon.js'),
      'must be RELATIVE (no leading slash) — a leading slash 404s on the itch zip sub-path root',
    );
  });

  test('references the local babylon loaders path (relative — itch sub-path safe)', () => {
    assert.ok(
      RENDERER_SOURCE.includes('assets/vendor/babylonjs/babylonjs.loaders.min.js'),
      'renderer-3d.js must load babylon glTF loaders from the local vendor path',
    );
    assert.ok(
      !RENDERER_SOURCE.includes('/assets/vendor/babylonjs/babylonjs.loaders.min.js'),
      'must be RELATIVE (no leading slash) — a leading slash 404s on the itch zip sub-path root',
    );
  });

  test('contains no `await import(` of any Babylon URL', () => {
    // Pattern: `await import(... BABYLON ...)` or any dynamic ESM import of
    // babylon — the file should only use <script> tag injection now.
    assert.equal(
      /await\s+import\s*\(\s*\/\*\s*@vite-ignore\s*\*\/\s*BABYLON/.test(RENDERER_SOURCE),
      false,
      'renderer-3d.js must not use `await import(BABYLON_...)` — UMD via <script> only',
    );
  });
});
