// Regression: the 3D fog veil must PERSIST across turns.
//
// `_applyFogVeil` is diff-based — it only swaps a tile's material when the
// tile's fog state changes relative to `_fogActiveSet`. That's an
// optimisation, but it means the set and the mesh's actual material must
// never drift apart: if some other code writes a tile's material between
// draws WITHOUT updating `_fogActiveSet`, the next diff sees "already in the
// right state" and skips the repaint — leaving the tile stuck.
//
// The one writer that does this is `_flashTile` (battle/attack tile flash).
// It captures the tile's material at flash-time and restores it via a delayed
// setTimeout. If the fog state changes during that ~220ms window (e.g. the
// turn resolves and the flashed hex falls out of sight as the round advances),
// the restore slams the STALE pre-flash material back on, contradicting
// `_fogActiveSet`. A hex that should now read as fogged is stuck showing its
// bright pre-flash material, and every later veil pass skips it.
//
// These tests exercise `_flashTile` against `_applyFogVeil` directly with
// plain stub meshes/materials so no Babylon context is needed.

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  const r = new Renderer3D(fakeCanvas, {});
  // These tests exercise the legacy per-hex flash + material-swap fog path
  // (which lives behind the splat-terrain flag). Pin it off so the assertions
  // about per-tile material tags hold regardless of the default flag value.
  r._useSplatTerrain = false;
  r._scene = {};
  // Material lookups return a tagged plain object so we can assert which
  // variant a tile ended up displaying without touching Babylon.
  r._tileMaterialFor = (_tile, { fogged = false } = {}) => ({ tag: fogged ? 'FOG' : 'CLEAR' });
  r._materialFor     = () => ({ tag: 'CLEAR' });
  r._fogMaterialFor  = () => ({ tag: 'FOG' });
  // Minimal Babylon stub so _flashTile can build + dispose its flash material.
  r._babylon = {
    StandardMaterial: class { constructor(n) { this.name = n; } dispose() {} },
    Color3:           class { constructor(a, b, c) { this.r = a; this.g = b; this.b = c; } clone() { return this; } },
  };
  return r;
}

function addTile(r, col, row) {
  const key = col + ',' + row;
  const mesh = {
    metadata: { baseColor: '#404040', col, row },
    material: { tag: 'CLEAR' },
    isDisposed() { return false; },
    diffuseColor: { clone() { return this; } },
  };
  r._tileMeshByKey.set(key, mesh);
  r._tileMeshes.push(mesh);
  r.state.tiles.set(key, { col, row, type: 'grass' });
  return mesh;
}

describe('Renderer3D — fog veil persists across a flash + turn advance', () => {
  let realSetTimeout;
  let pendingRestores;

  beforeEach(() => {
    realSetTimeout = global.setTimeout;
    pendingRestores = [];
    // Capture the flash-restore callback instead of firing it on a timer so
    // the test can deterministically advance "time" relative to the veil.
    global.setTimeout = (fn) => { pendingRestores.push(fn); return 0; };
  });
  afterEach(() => { global.setTimeout = realSetTimeout; });

  function flushRestores() {
    for (const fn of pendingRestores.splice(0)) fn();
  }

  test('a flashed hex that falls out of sight stays fogged after the flash restores', () => {
    const r = makeRenderer();
    r.state = { tiles: new Map(), fogOfWar: 'partial' };
    r._tileMeshes = [];
    const mesh = addTile(r, 2, 2);
    r._observerOwner = () => 'hero';

    // Turn 1: the hex is in sight → unfogged.
    let visible = new Set(['2,2']);
    r._buildFogVisibleHexes = () => visible;
    r._applyFogVeil();
    assert.equal(mesh.material.tag, 'CLEAR', 'turn 1: in-sight hex is clear');
    assert.equal(r._fogActiveSet.has('2,2'), false);

    // A battle on this hex flashes it (captures the CLEAR material).
    r._flashTile(2, 2, [0.5, 0.1, 0.1]);

    // Turn 2: the hex is now out of sight → the veil fogs it.
    visible = new Set();
    r._applyFogVeil();
    assert.equal(mesh.material.tag, 'FOG', 'turn 2: out-of-sight hex is fogged by the veil');
    assert.equal(r._fogActiveSet.has('2,2'), true);

    // The delayed flash restore now fires. It must NOT resurrect the stale
    // pre-flash CLEAR material — the hex is fogged now.
    flushRestores();
    assert.equal(mesh.material.tag, 'FOG',
      'flash restore must respect current fog state, not the stale captured material');

    // And a subsequent veil pass (diff sees no change) must leave it fogged.
    r._applyFogVeil();
    assert.equal(mesh.material.tag, 'FOG',
      'fog must persist: the diff-based veil must not leave the hex stuck unfogged');
  });

  test('a flashed hex that comes into sight is cleared after the flash restores', () => {
    const r = makeRenderer();
    r.state = { tiles: new Map(), fogOfWar: 'partial' };
    r._tileMeshes = [];
    const mesh = addTile(r, 4, 4);
    r._observerOwner = () => 'hero';

    // Turn 1: the hex is out of sight → fogged.
    let visible = new Set();
    r._buildFogVisibleHexes = () => visible;
    r._applyFogVeil();
    assert.equal(mesh.material.tag, 'FOG');
    assert.equal(r._fogActiveSet.has('4,4'), true);

    // Flash captures the FOG material.
    r._flashTile(4, 4, [0.5, 0.1, 0.1]);

    // Turn 2: the hex comes into sight → veil clears it.
    visible = new Set(['4,4']);
    r._applyFogVeil();
    assert.equal(mesh.material.tag, 'CLEAR');
    assert.equal(r._fogActiveSet.has('4,4'), false);

    // Restore must not slam the stale FOG material back on a now-visible hex.
    flushRestores();
    assert.equal(mesh.material.tag, 'CLEAR',
      'flash restore must respect current fog state, not the stale fogged material');
  });
});
