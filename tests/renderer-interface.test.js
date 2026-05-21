// Phase 1 of the 3D renderer initiative — interface conformance.
//
// Renderer3D must expose every method that the 2D Renderer exposes so
// the toggle in main.js can swap implementations without main.js or
// ui.js needing to branch on which one is active. This test pins that
// contract two ways:
//   1. Every public method on Renderer (the source of truth) must
//      exist on Renderer3D.
//   2. Every method actually invoked as `*.renderer.<name>(` from any
//      file under src/ must exist on Renderer3D — including
//      underscore-prefixed methods (e.g. _clampPan, _buildFogVisibleHexes)
//      that callers reach into despite being "private" on the 2D class.
//
// (2) is the important one: it auto-discovers external call sites, so
// any future drift — a new ui.js call into a Renderer internal — is
// caught without anyone remembering to update this test.
//
// We deliberately only check methods (not properties). Property slots
// on the 3D renderer are initialised inside the constructor — they're
// not enumerable on the prototype — and many are written by callers
// regardless of whether the renderer declared the slot.
//
// The Renderer3D import must succeed without Babylon being available,
// since Babylon is loaded via CDN dynamic import inside draw(). If this
// test starts failing on import, the lazy-load contract has been broken.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Renderer }   from '../src/renderer.js';
import { Renderer3D } from '../src/renderer-3d.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR    = path.resolve(__dirname, '..', 'src');
const SERVER_DIR = path.resolve(__dirname, '..', 'server');

function _methodNames(cls) {
  return Object.getOwnPropertyNames(cls.prototype)
    .filter(n => n !== 'constructor' && typeof cls.prototype[n] === 'function');
}

function _walkJsFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) out.push(..._walkJsFiles(full));
    else if (st.isFile() && full.endsWith('.js')) out.push(full);
  }
  return out;
}

// Find every method name `*.renderer.<name>(` invoked from any file under src/
// or server/. We allow any identifier preceding `.renderer.` so
// `this.renderer.foo()`, `ui.renderer.foo()`, and bare `renderer.foo()` all
// match. server/ is included so any future drift — backend code reaching into
// a renderer-like object — is caught even though today there shouldn't be any.
function _externalRendererMethodCallSites(dirs = [SRC_DIR, SERVER_DIR]) {
  const callRe = /(?:\.|\b)renderer\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
  const names = new Set();
  for (const dir of dirs) {
    for (const file of _walkJsFiles(dir)) {
      // Don't scan the renderers themselves — internal `this._foo()` calls aren't external.
      const base = path.basename(file);
      if (base === 'renderer.js' || base === 'renderer-3d.js') continue;
      const src = readFileSync(file, 'utf8');
      let m;
      while ((m = callRe.exec(src)) !== null) names.add(m[1]);
    }
  }
  return names;
}

describe('Renderer3D — interface conformance with 2D Renderer', () => {
  test('every public method on Renderer is also on Renderer3D', () => {
    const r2d = _methodNames(Renderer).filter(n => !n.startsWith('_'));
    const r3d = new Set(_methodNames(Renderer3D));

    const missing = r2d.filter(name => !r3d.has(name));
    assert.deepEqual(
      missing,
      [],
      `Renderer3D is missing ${missing.length} public method(s): ${missing.join(', ')}\n` +
      `Add stubs in src/renderer-3d.js so callers can swap renderers.`,
    );
  });

  test('every method invoked as *.renderer.X(...) in src/ or server/ is on Renderer3D', () => {
    const called = _externalRendererMethodCallSites();
    const r3d    = new Set(_methodNames(Renderer3D));

    const missing = [...called].filter(name => !r3d.has(name)).sort();
    assert.deepEqual(
      missing,
      [],
      `Renderer3D is missing ${missing.length} method(s) called from src/ or server/: ${missing.join(', ')}\n` +
      `Add stubs in src/renderer-3d.js so callers can swap renderers.`,
    );
  });

  test('no server/ file reaches into a renderer object today', () => {
    // The backend has no DOM and no renderer instance — pin that there are
    // currently no `.renderer.<method>(...)` call sites under server/, so any
    // future leak is caught by this test.
    const callsFromServer = _externalRendererMethodCallSites([SERVER_DIR]);
    assert.deepEqual([...callsFromServer].sort(), [],
      `server/ should not reach into a renderer object; found: ${[...callsFromServer].join(', ')}`);
  });

  test('Renderer3D imports without Babylon (lazy-load contract)', () => {
    // Constructing the class must not trigger the Babylon import either.
    // We pass a minimal fake canvas — the constructor must not touch the DOM.
    const fakeCanvas = { parentElement: null, width: 800, height: 600 };
    const inst = new Renderer3D(fakeCanvas, /* state */ {});
    assert.ok(inst, 'Renderer3D constructor returned nothing');
    assert.equal(inst._engine, null, 'Babylon engine should be null until draw() runs');
    assert.equal(inst._scene,  null, 'Babylon scene should be null until draw() runs');
  });

  test('property slots used by main.js/ui.js exist on a fresh Renderer3D', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600 };
    const inst = new Renderer3D(fakeCanvas, {});
    // Spot-check the slots assigned externally by main.js / ui.js.
    const slots = [
      'onImagesLoaded', 'aiDebugOverlay', 'insetLeft', 'insetRight',
      'hoveredHex', 'selectedHex', 'selectedEntityId', 'highlightHexes',
      'planGhostSteps', 'viewLocked', 'zoomLevel', 'hexSize',
      'useTileImages', '_zoomAnim', '_panX', '_panY',
    ];
    for (const slot of slots) {
      assert.ok(slot in inst, `Renderer3D missing slot '${slot}' that main.js/ui.js writes`);
    }
  });

  test('stub methods do not throw when invoked with reasonable args', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600 };
    const inst = new Renderer3D(fakeCanvas, {});
    // These are the hottest paths from main.js animation orchestration.
    assert.doesNotThrow(() => inst.addAttackAnim(0, 0, 1, 1));
    assert.doesNotThrow(() => inst.addLungeAnim(1, 0, 0, 1, 1, 'hero', 'hero'));
    assert.doesNotThrow(() => inst.addProjectileAnim('bolt', 0, 0, 1, 1, {}));
    assert.doesNotThrow(() => inst.addFlash(0, 0, '-1'));
    assert.doesNotThrow(() => inst.addMoveAnim(1, 0, 0, 1, 1, 'hero', 'hero'));
    assert.doesNotThrow(() => inst.clearAnimations());
    assert.doesNotThrow(() => inst.frameHexes([{ col: 1, row: 1 }], {}));
    assert.equal(inst.getFadeOutOpacity(42), 1);
    assert.deepEqual(inst.canvasToHex(10, 10), { col: -1, row: -1 });
  });

  // Structural smoke test — exercises the surface listed in the renderer-3d.js
  // header comment so a future phase that renames or removes one of these
  // stubs is caught immediately.
  test('every documented animation/utility hook is callable with its documented arg shape', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600 };
    const inst = new Renderer3D(fakeCanvas, {});

    // ── add* animation hooks ──────────────────────────────────────────────
    assert.doesNotThrow(() => inst.addAttackAnim(0, 0, 1, 1));
    assert.doesNotThrow(() => inst.addLungeAnim('eid', 0, 0, 1, 1, 'hero', 'hero', 'Hero'));
    assert.doesNotThrow(() => inst.addProjectileAnim('bolt', 0, 0, 1, 1, {}));
    assert.doesNotThrow(() => inst.addMoveAnim('eid', 0, 0, 1, 1, 'hero', 'hero', 'Hero'));
    assert.doesNotThrow(() => inst.addFlash(0, 0, '-1', '#fff', 800, 0.85, '#000'));
    assert.doesNotThrow(() => inst.addDeathAnim(0, 0, '#f00'));
    assert.doesNotThrow(() => inst.addFadeOutAnim('eid', 500));
    assert.doesNotThrow(() => inst.addNodeRevealAnim([{ col: 0, row: 0 }], '#fff', {}));
    assert.doesNotThrow(() => inst.addSpawnAnim(1, 1, '#aaa'));
    assert.doesNotThrow(() => inst.addHpChangeFlash(1, 1, -2));

    // ── clear*/return* hooks ──────────────────────────────────────────────
    assert.doesNotThrow(() => inst.clearAllLungeAnims());
    assert.doesNotThrow(() => inst.clearAllProjectileAnims());
    assert.doesNotThrow(() => inst.clearAnimations());
    assert.doesNotThrow(() => inst.clearBattleHighlights());
    assert.doesNotThrow(() => inst.clearFlashes());
    assert.doesNotThrow(() => inst.returnAllLungeAnims());
    assert.doesNotThrow(() => inst.setBattleHighlights([{ col: 0, row: 0 }], [{ col: 1, row: 1 }]));

    // ── async hooks ───────────────────────────────────────────────────────
    return Promise.all([
      // loadImages must resolve immediately and invoke onImagesLoaded.
      new Promise((resolve, reject) => {
        let fired = false;
        inst.onImagesLoaded = () => { fired = true; };
        inst.loadImages()
          .then(() => {
            try {
              assert.ok(fired, 'loadImages did not invoke onImagesLoaded callback');
              resolve();
            } catch (e) { reject(e); }
          })
          .catch(reject);
      }),
      // waitForAnimations must resolve without queued work.
      inst.waitForAnimations(),
    ]);
  });

  test('getEntity*/getPortrait*/getTile* return null/empty before Babylon loads', () => {
    const fakeCanvas = { parentElement: null, width: 800, height: 600 };
    const inst = new Renderer3D(fakeCanvas, {});
    assert.deepEqual(inst.getEntityScreenPositions(0, 0, [], {}), []);
    assert.equal(inst.getEntityScreenPos(0, 0, 'id', 0, 1, {}), null);
    assert.equal(inst.getPortraitDataURL('asset', 64), null);
    assert.equal(inst.getTileDataURL({}, 0, 0, 64), null);
    assert.deepEqual(inst.hexToCanvasPos(0, 0), { x: 0, y: 0 });
  });
});
