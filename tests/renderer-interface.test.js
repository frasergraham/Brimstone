// Phase 1 of the 3D renderer initiative — interface conformance.
//
// Renderer3D must expose every method that the 2D Renderer exposes so
// the toggle in main.js can swap implementations without main.js or
// ui.js needing to branch on which one is active. This test pins that
// contract: if a new method lands on Renderer (the source of truth)
// without a matching stub on Renderer3D, this test fails.
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

import { Renderer }   from '../src/renderer.js';
import { Renderer3D } from '../src/renderer-3d.js';

function _methodNames(cls) {
  return Object.getOwnPropertyNames(cls.prototype)
    .filter(n => n !== 'constructor' && typeof cls.prototype[n] === 'function');
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
});
