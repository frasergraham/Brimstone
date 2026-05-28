// Stage C — splat-terrain fog migration.
//
// With the flag ON, `_applyFogVeil` rewrites the merged ground's `aFog` vertex
// attribute once (via `_writeFogWeights`) instead of swapping per-tile
// materials, and hides/darkens props via `_setTilePropsFogged`. Existing
// (flag-off) fog behaviour is unchanged.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';
import { hexFogWeights, neighborDeltas } from '../src/terrain-splat.js';

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  return new Renderer3D(fakeCanvas, {});
}

// Stand up the minimum splat-ground state `_writeFogWeights` needs: a fog
// buffer, a vertex-range map, a stub ground mesh that records updateVerticesData.
function withSplatGround(r, tileKeys) {
  const buf = new Float32Array(tileKeys.length * 7);
  const range = new Map();
  tileKeys.forEach((k, i) => range.set(k, i * 7));
  const updates = [];
  r._splatFogBuf = buf;
  r._hexVertexRange = range;
  r._splatGround = {
    updateVerticesData(kind, data) { updates.push({ kind, data: data.slice() }); },
  };
  return { buf, range, updates };
}

function tilesFrom(keys) {
  const tiles = new Map();
  for (const k of keys) {
    const [c, rr] = k.split(',').map(Number);
    tiles.set(k, { col: c, row: rr });
  }
  return tiles;
}

describe('Renderer3D splat fog — _writeFogWeights', () => {
  test('rewrites aFog per hex from hexFogWeights and pushes one update', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    const keys = [];
    for (let row = 1; row <= 3; row++) for (let col = 1; col <= 3; col++) keys.push(hexKey(col, row));
    r.state = { tiles: tilesFrom(keys) };
    const { buf, range, updates } = withSplatGround(r, keys);

    const fogged = new Set(['2,2']);
    r._writeFogWeights(fogged);

    assert.equal(updates.length, 1, 'one updateVerticesData call');
    assert.equal(updates[0].kind, 'aFog');

    // Spot-check: the slice for 2,2 matches hexFogWeights with present-neighbour keys.
    const baseV = range.get('2,2');
    const nKeys = neighborDeltas(2).map(([dc, dr]) => {
      const nk = hexKey(2 + dc, 2 + dr);
      return r.state.tiles.has(nk) ? nk : null;
    });
    const expected = hexFogWeights('2,2', nKeys, fogged);
    for (let v = 0; v < 7; v++) {
      assert.ok(Math.abs(buf[baseV + v] - expected[v]) < 1e-6, `vertex ${v}`);
    }
    // centre of 2,2 fully fogged
    assert.equal(buf[baseV], 1);
  });

  test('no-op without a ground / buffer (node-test, flag off)', () => {
    const r = makeRenderer();
    // nothing set up — must not throw
    assert.doesNotThrow(() => r._writeFogWeights(new Set(['0,0'])));
  });
});

describe('Renderer3D splat fog — _setTilePropsFogged', () => {
  test('hides tactical props, skips permanent geometry, tracks _fogActiveSet', () => {
    const r = makeRenderer();
    const hexK = '4,4';
    const tree = { isVisible: true, metadata: { respectsFog: false } };
    const disc = { isVisible: true };
    r._tilePropsByKey.set(hexK, [tree, disc]);

    r._setTilePropsFogged(hexK, true);
    assert.equal(tree.isVisible, true, 'permanent geometry stays visible');
    assert.equal(disc.isVisible, false, 'tactical prop hidden');
    assert.ok(r._fogActiveSet.has(hexK));

    r._setTilePropsFogged(hexK, false);
    assert.equal(disc.isVisible, true, 'tactical prop revealed');
    assert.ok(!r._fogActiveSet.has(hexK));
  });

  test("'building-instance' props darken via the per-instance `fogDarken` buffer", async () => {
    // GLB buildings are hardware instances of a shared template — toggling
    // the template material would dim every building at once, so each
    // instance carries its own `fogDarken` value in an instanced buffer.
    const { FOG_HIDDEN_DARKEN } = await import('../src/renderer-3d.js');
    const r = makeRenderer();
    const hexK = '6,2';
    const bldgA = {
      isVisible: true,
      instancedBuffers: { fogDarken: 1.0 },
      metadata: { respectsFog: 'building-instance' },
    };
    const bldgB = {
      isVisible: true,
      instancedBuffers: { fogDarken: 1.0 },
      metadata: { respectsFog: 'building-instance' },
    };
    // Both buildings share a template; only A is on the fogged tile.
    r._tilePropsByKey.set(hexK,        [bldgA]);
    r._tilePropsByKey.set('99,99',     [bldgB]);
    r._setTilePropsFogged(hexK, true);
    assert.equal(bldgA.instancedBuffers.fogDarken, FOG_HIDDEN_DARKEN,
      'fogged building darkens');
    assert.equal(bldgB.instancedBuffers.fogDarken, 1.0,
      'sibling building on a different tile is untouched');
    assert.equal(bldgA.isVisible, true, 'building stays visible');
    r._setTilePropsFogged(hexK, false);
    assert.equal(bldgA.instancedBuffers.fogDarken, 1.0, 'restored on un-fog');
  });

  test("'darken' props tint to FOG_HIDDEN_DARKEN cap on both texture level + colour", async () => {
    // Fog darken on roads/rivers must hit the TEXTURE level (outside the
    // lighting clamp) so it survives bright phases — same fix the terrain
    // fog veil relies on. And it clamps to FOG_HIDDEN_DARKEN so the ribbon
    // reads as "occluded" not "lightly tinted".
    const { FOG_HIDDEN_DARKEN } = await import('../src/renderer-3d.js');
    const r = makeRenderer();
    r._fogTileDarken = 0.7; // mild phase value — should clamp down to the cap
    const hexK = '5,5';
    const road = {
      isVisible: true,
      material: {
        diffuseColor: { r: 1, g: 1, b: 1 },
        diffuseTexture: { level: 1 },
      },
      metadata: { respectsFog: 'darken', baseDiffuse: { r: 1, g: 1, b: 1 } },
    };
    r._tilePropsByKey.set(hexK, [road]);
    r._setTilePropsFogged(hexK, true);
    assert.equal(road.isVisible, true, 'road stays visible under fog');
    assert.equal(road.material.diffuseTexture.level, FOG_HIDDEN_DARKEN,
      'texture level darkened past the lighting clamp');
    assert.equal(road.material.diffuseColor.r, FOG_HIDDEN_DARKEN,
      'diffuse colour darkened too (belt-and-braces for texture-less mats)');
    r._setTilePropsFogged(hexK, false);
    assert.equal(road.material.diffuseTexture.level, 1, 'level restored on un-fog');
    assert.equal(road.material.diffuseColor.r, 1.0, 'colour restored on un-fog');
  });
});

describe('Renderer3D splat fog — _applyFogVeil integration', () => {
  test('flag on routes through _writeFogWeights + _setTilePropsFogged', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r._scene = {};
    const keys = ['1,1', '2,1', '1,2', '2,2'];
    r.state = { tiles: tilesFrom(keys), fogOfWar: 'standard' };
    withSplatGround(r, keys);

    // Force a known fogged set by stubbing the observer-derived computation.
    r._observerOwner = () => 'hero';
    r._buildFogVisibleHexes = () => new Set(['1,1', '2,1']); // 1,2 & 2,2 fogged

    let wrote = false;
    const realWrite = r._writeFogWeights.bind(r);
    r._writeFogWeights = (fogged) => { wrote = true; realWrite(fogged); };

    r._applyFogVeil();
    assert.ok(wrote, '_writeFogWeights invoked');
    assert.ok(r._fogActiveSet.has('1,2') && r._fogActiveSet.has('2,2'));
    assert.ok(!r._fogActiveSet.has('1,1'));
  });

  test('setFogTint drives the plugin uFogDarken, capped at FOG_HIDDEN_DARKEN', async () => {
    // The splat plugin's uFogDarken is clamped to FOG_HIDDEN_DARKEN so fogged
    // hexes always read as occluded vision, never a mild atmospheric tint.
    // setFogTint still records the raw phase value in _fogTileDarken for the
    // legacy / prop-fog paths.
    const { FOG_HIDDEN_DARKEN } = await import('../src/renderer-3d.js');
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r._splatPlugin = { uFogDarken: 1.0 };
    r._scene = null; // setFogTint guards _applyFogVeil on _scene
    // High phase value (golden-hour mild fog) clamps to the strong cap.
    r.setFogTint(0.7);
    assert.equal(r._splatPlugin.uFogDarken, FOG_HIDDEN_DARKEN);
    assert.equal(r._fogTileDarken, 0.7, 'raw phase value preserved for other paths');
    // Below the cap, the phase value passes through unchanged.
    r.setFogTint(0.1);
    assert.equal(r._splatPlugin.uFogDarken, 0.1);
  });
});
