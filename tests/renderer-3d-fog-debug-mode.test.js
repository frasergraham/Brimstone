// Fog DISPLAY-mode debug override (T-key).
//
// `_fogDebugMode` is a renderer-level override of how fog DISPLAYS, independent
// of the game's actual fogOfWar state. It is a simple two-state toggle
// normal ↔ off:
//   • normal → veil the real (game-driven) fogged set
//   • off    → suppress the veil entirely (everything visible)
//
// The pure helpers `nextFogDebugMode` (toggle) and `foggedSetForMode`
// (override → fogged set) are unit-tested directly; the override wiring into
// `_applyFogVeil` is exercised through a stubbed renderer (no Babylon context),
// asserting `_fogActiveSet` membership per mode.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  nextFogDebugMode,
  foggedSetForMode,
  FOG_DEBUG_MODES,
} from '../src/renderer-3d.js';

describe('nextFogDebugMode — T-key toggle', () => {
  test('flips normal ↔ off', () => {
    assert.equal(nextFogDebugMode('normal'), 'off');
    assert.equal(nextFogDebugMode('off'), 'normal');
  });

  test('is a two-state toggle', () => {
    assert.deepEqual([...FOG_DEBUG_MODES], ['normal', 'off']);
  });

  test('a full round-trip returns to the start', () => {
    let m = 'normal';
    for (let i = 0; i < FOG_DEBUG_MODES.length; i++) m = nextFogDebugMode(m);
    assert.equal(m, 'normal');
  });

  test('unknown input falls back to off → normal on the next flip', () => {
    // Anything that isn't 'off' is treated as 'normal' and flips to 'off'.
    assert.equal(nextFogDebugMode(undefined), 'off');
    assert.equal(nextFogDebugMode('bogus'), 'off');
  });
});

describe('foggedSetForMode — override → fogged set mapping', () => {
  const real = new Set(['1,1', '2,2']);

  test('off → empty set (suppress the veil)', () => {
    const got = foggedSetForMode('off', real);
    assert.equal(got.size, 0);
  });

  test('normal → the real computed set (unchanged ref)', () => {
    assert.equal(foggedSetForMode('normal', real), real);
  });

  test('does not mutate the real set', () => {
    const r = new Set(['1,1']);
    foggedSetForMode('off', r);
    foggedSetForMode('normal', r);
    assert.deepEqual([...r], ['1,1']);
  });
});

// ── Override wiring into _applyFogVeil ────────────────────────────────────────

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  const r = new Renderer3D(fakeCanvas, {});
  r._scene = {};
  r._tileMaterialFor = (_tile, { fogged = false } = {}) => ({ tag: fogged ? 'FOG' : 'CLEAR' });
  r._materialFor     = () => ({ tag: 'CLEAR' });
  r._fogMaterialFor  = () => ({ tag: 'FOG' });
  r.state = { tiles: new Map(), fogOfWar: 'partial' };
  r._observerOwner = () => 'hero';
  return r;
}

function addTile(r, col, row) {
  const key = col + ',' + row;
  const mesh = {
    metadata: { baseColor: '#404040', col, row },
    material: { tag: 'CLEAR' },
    isDisposed() { return false; },
  };
  r._tileMeshByKey.set(key, mesh);
  r.state.tiles.set(key, { col, row, type: 'grass' });
  return mesh;
}

describe('Renderer3D._applyFogVeil — fog display-mode override', () => {
  // Board: 2,2 visible / 3,3 out of sight. Real fog set = {3,3}.
  function setup(mode) {
    const r = makeRenderer();
    addTile(r, 2, 2);
    addTile(r, 3, 3);
    r._buildFogVisibleHexes = () => new Set(['2,2']);
    r._fogDebugMode = mode;
    r._applyFogVeil();
    return r;
  }

  test('normal → veils only the real fogged hex', () => {
    const r = setup('normal');
    assert.equal(r._fogActiveSet.has('3,3'), true);
    assert.equal(r._fogActiveSet.has('2,2'), false);
  });

  test('off → nothing fogged (everything visible)', () => {
    const r = setup('off');
    assert.equal(r._fogActiveSet.size, 0);
  });

  test('toggling off then back to normal restores the real veil', () => {
    const r = makeRenderer();
    addTile(r, 2, 2);
    addTile(r, 3, 3);
    r._buildFogVisibleHexes = () => new Set(['2,2']);

    r._fogDebugMode = 'off';
    r._applyFogVeil();
    assert.equal(r._fogActiveSet.size, 0, 'off: nothing fogged');

    r._fogDebugMode = 'normal';
    r._applyFogVeil();
    assert.deepEqual([...r._fogActiveSet], ['3,3'], 'normal: only the real fogged hex');
  });

  test('_cycleFogDebugMode toggles the mode and re-applies the veil', () => {
    const r = makeRenderer();
    addTile(r, 2, 2);
    addTile(r, 3, 3);
    r._buildFogVisibleHexes = () => new Set(['2,2']);
    assert.equal(r._fogDebugMode, 'normal');

    r._cycleFogDebugMode(); // → off
    assert.equal(r._fogDebugMode, 'off');
    assert.equal(r._fogActiveSet.size, 0);

    r._cycleFogDebugMode(); // → normal
    assert.equal(r._fogDebugMode, 'normal');
    assert.deepEqual([...r._fogActiveSet], ['3,3']);
  });
});
