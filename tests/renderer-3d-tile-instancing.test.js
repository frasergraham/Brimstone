// Hardware-instanced hex tiles.
//
// Each playable tile gets TWO InstancedMesh instances — one off the "unfogged"
// master source and one off the "fogged" master — sharing the same world
// position. The fog veil toggles which instance is enabled per tile, so the
// whole map renders in ≤ N_source-buckets draw calls instead of one per tile.
//
// These tests cover:
//   • the two pure helpers (`tileSourceKey`, `worldToHexKey`) match the
//     contract callers depend on.
//   • `_setTileFogged` flips the correct instance when an instance pair is
//     registered, and leaves the legacy material-swap path alone otherwise
//     (so existing fog-terrain tests keep passing).
//   • the pair count tracked by `_tileInstancePairs` matches the brief's
//     "every tile → 2 instances" invariant.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  tileSourceKey,
  worldToHex,
  worldToHexKey,
  hexToWorld,
} from '../src/renderer-3d.js';
import { TileType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';

function newRenderer() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

function fakeInstance() {
  return {
    enabled: true,
    setEnabled(v) { this.enabled = v; },
  };
}

describe('tileSourceKey — pure helper', () => {
  test('combines tileType + textureVariant into a stable string id', () => {
    assert.equal(tileSourceKey(TileType.GRASS, 'grass_1'),  'grass:grass_1');
    assert.equal(tileSourceKey(TileType.FOREST, 'forest_3'), 'forest:forest_3');
    assert.equal(tileSourceKey(TileType.DIRT, 'dirt_5'),    'dirt:dirt_5');
  });

  test('falls back to "solid" when textureVariant is null/undefined', () => {
    assert.equal(tileSourceKey(TileType.ROAD, null),       'road:solid');
    assert.equal(tileSourceKey(TileType.RIVER, undefined), 'river:solid');
  });

  test('two tiles that share (type, variant) collide on the same key', () => {
    // Same bucket → must reuse the same source mesh in the renderer.
    assert.equal(
      tileSourceKey(TileType.GRASS, 'grass_2'),
      tileSourceKey(TileType.GRASS, 'grass_2'),
    );
    // Different variant → different bucket.
    assert.notEqual(
      tileSourceKey(TileType.GRASS, 'grass_1'),
      tileSourceKey(TileType.GRASS, 'grass_2'),
    );
    // Different type → different bucket even on same variant string.
    assert.notEqual(
      tileSourceKey(TileType.GRASS, 'grass_1'),
      tileSourceKey(TileType.FOREST, 'grass_1'),
    );
  });
});

describe('worldToHex / worldToHexKey — invert hexToWorld', () => {
  test('a round trip through hexToWorld → worldToHex returns the original (col, row)', () => {
    // Spot-check across odd/even rows + non-zero cols, since the offset shift
    // depends on `row & 1` — both branches must round-trip cleanly.
    const samples = [
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 5, row: 4 },
      { col: 7, row: 3 }, { col: 12, row: 10 }, { col: 2, row: 7 },
    ];
    for (const { col, row } of samples) {
      const { x, z } = hexToWorld(col, row);
      const back = worldToHex(x, z);
      assert.deepEqual(back, { col, row },
        `hexToWorld → worldToHex failed at (${col}, ${row}) → (${x}, ${z}) → ${JSON.stringify(back)}`);
    }
  });

  test('worldToHexKey returns the same "col,row" string as hexKey', () => {
    const { x, z } = hexToWorld(6, 4);
    assert.equal(worldToHexKey(x, z), hexKey(6, 4));
  });

  test('points slightly off-centre still resolve to the containing hex', () => {
    // Wiggle the hit point ±0.2 world units away from the hex centre.
    const { x, z } = hexToWorld(5, 3);
    for (const dx of [-0.2, 0, 0.2]) {
      for (const dz of [-0.2, 0, 0.2]) {
        const { col, row } = worldToHex(x + dx, z + dz);
        assert.equal(col, 5, `off-centre hit at (${x + dx}, ${z + dz}) → col`);
        assert.equal(row, 3, `off-centre hit at (${x + dx}, ${z + dz}) → row`);
      }
    }
  });
});

describe('_setTileFogged — instance-pair toggle', () => {
  test('flips enabled state on the right instance when a pair is registered', () => {
    const r = newRenderer();
    const k = '4,2';
    const ufInst = fakeInstance();
    const fgInst = fakeInstance();
    // Initial state: unfogged tile.
    ufInst.enabled = true;
    fgInst.enabled = false;
    r._tileInstancePairs.set(k, { unfogged: ufInst, fogged: fgInst });
    // Stub the prop registry so the loop after the toggle is a no-op.
    r._tilePropsByKey.delete(k);

    // Fog the tile → unfogged hides, fogged shows.
    r._setTileFogged(k, { metadata: { baseColor: '#404040' } }, true);
    assert.equal(ufInst.enabled, false, 'fogged hex: unfogged instance must hide');
    assert.equal(fgInst.enabled, true,  'fogged hex: fogged instance must show');
    assert.ok(r._fogActiveSet.has(k), 'fog-active set should track the hex');

    // Un-fog the tile → the toggle reverses.
    r._setTileFogged(k, { metadata: { baseColor: '#404040' } }, false);
    assert.equal(ufInst.enabled, true,  'visible hex: unfogged instance must show');
    assert.equal(fgInst.enabled, false, 'visible hex: fogged instance must hide');
    assert.ok(!r._fogActiveSet.has(k), 'fog-active set should clear the hex');
  });

  test('falls back to material-swap when no instance pair exists (legacy path)', () => {
    // Mirrors `tests/renderer-3d-fog-terrain.test.js`: the simpler
    // `tileMesh.material = ...` path must still work for tile meshes built
    // without instancing (test stubs, headless environments without Babylon
    // `createInstance` support).
    const r = newRenderer();
    const k = '0,1';
    const tileMesh = { metadata: { baseColor: '#404040' }, material: null };
    const fogMat   = { name: 'fog' };
    const baseMat  = { name: 'base' };
    r._fogMaterialFor = () => fogMat;
    r._materialFor    = () => baseMat;

    r._setTileFogged(k, tileMesh, true);
    assert.equal(tileMesh.material, fogMat,
      'legacy path: tile material should become the fog variant');

    r._setTileFogged(k, tileMesh, false);
    assert.equal(tileMesh.material, baseMat,
      'legacy path: tile material should restore to the base variant');
  });

  test('toggling a hex with no pair AND no baseColor metadata is a no-op (defensive)', () => {
    const r = newRenderer();
    const tileMesh = { metadata: {}, material: null };
    // Should not throw, should not touch material.
    r._setTileFogged('1,1', tileMesh, true);
    assert.equal(tileMesh.material, null);
  });
});

describe('_tileInstancePairs — invariant: one pair per playable hex', () => {
  test('after manual registration, pair count tracks the registered hexes', () => {
    const r = newRenderer();
    // Sanity: starts empty.
    assert.equal(r._tileInstancePairs.size, 0);

    // Two hexes registered → two pairs.
    r._tileInstancePairs.set('0,0', { unfogged: fakeInstance(), fogged: fakeInstance() });
    r._tileInstancePairs.set('1,0', { unfogged: fakeInstance(), fogged: fakeInstance() });
    assert.equal(r._tileInstancePairs.size, 2);

    // Every pair carries exactly two instances (one of each fog state).
    for (const pair of r._tileInstancePairs.values()) {
      assert.ok(pair.unfogged, 'pair must include the unfogged instance');
      assert.ok(pair.fogged,   'pair must include the fogged instance');
      assert.notEqual(pair.unfogged, pair.fogged,
        'the two instances must be distinct objects');
    }
  });
});

describe('_freezeStaticMeshes — also freezes fogged twin instances', () => {
  test('walks _tileInstancePairs and freezes the fogged instance', () => {
    const r = newRenderer();
    // Both unfogged AND fogged should end up frozen. The unfogged one is
    // already in `_tileMeshes`; the freeze pass should additionally pick
    // up the fogged twin via `_tileInstancePairs`.
    function fakeMesh(name) {
      return {
        name,
        isWorldMatrixFrozen: false,
        doNotSyncBoundingInfo: false,
        freezeWorldMatrix() { this.isWorldMatrixFrozen = true; return this; },
      };
    }
    const uf = fakeMesh('tileU');
    const fg = fakeMesh('tileF');
    r._tileMeshes = [uf];
    r._tileInstancePairs.set('2,3', { unfogged: uf, fogged: fg });

    const n = r._freezeStaticMeshes();
    assert.ok(n >= 2, `expected at least 2 freezes, got ${n}`);
    assert.equal(uf.isWorldMatrixFrozen, true, 'unfogged twin should be frozen');
    assert.equal(fg.isWorldMatrixFrozen, true, 'fogged twin should be frozen');
  });
});
