// 3D-renderer tile clustering.
//
// `_bakeTileClusters` collapses per-tile flat-hex meshes into one merged mesh
// per (material × 4×4 spatial cluster). The merged mesh handles rendering;
// the source meshes stay in the scene as invisible-but-pickable proxies so
// `canvasToHex` keeps resolving clicks back to a tile.
//
// These tests exercise:
//   • the pure helpers (`clusterIdForTile`, `assignTilesToClusters`)
//   • the Renderer3D bake path with a stubbed Babylon (MergeMeshes,
//     getVerticesData/setVerticesData), verifying source-mesh state,
//     cluster registration, vertex-color offset tracking, and the
//     1-tile-bucket short-circuit
//   • the fog veil's vertex-color path (`_applyFogVertexColors`)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  clusterIdForTile,
  assignTilesToClusters,
  CLUSTER_HEX_SIZE,
} from '../src/renderer-3d.js';

// ─── Pure helpers ─────────────────────────────────────────────────────────

describe('clusterIdForTile — bucket (col,row) into 4×4 cluster regions', () => {
  test('default cluster size is 4', () => {
    assert.equal(CLUSTER_HEX_SIZE, 4);
  });

  test('floors col/row into cluster grid coordinates', () => {
    assert.equal(clusterIdForTile(0, 0), '0,0');
    assert.equal(clusterIdForTile(3, 3), '0,0');
    assert.equal(clusterIdForTile(4, 0), '1,0');
    assert.equal(clusterIdForTile(0, 4), '0,1');
    assert.equal(clusterIdForTile(7, 11), '1,2');
    assert.equal(clusterIdForTile(12, 12), '3,3');
  });

  test('negative cols/rows still go through Math.floor (border tiles)', () => {
    assert.equal(clusterIdForTile(-1, -1), '-1,-1');
    assert.equal(clusterIdForTile(-4, 0), '-1,0');
    assert.equal(clusterIdForTile(-5, 0), '-2,0');
  });

  test('honours a non-default cluster size', () => {
    assert.equal(clusterIdForTile(5, 5, 2), '2,2');
    assert.equal(clusterIdForTile(15, 0, 8), '1,0');
  });
});

describe('assignTilesToClusters — buckets tiles by cluster id', () => {
  test('groups co-located tiles into the same bucket', () => {
    const tiles = [
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 },
      { col: 4, row: 0 }, { col: 5, row: 1 },
      { col: 0, row: 5 },
    ];
    const m = assignTilesToClusters(tiles);
    assert.equal(m.size, 3);
    assert.equal(m.get('0,0').length, 3);
    assert.equal(m.get('1,0').length, 2);
    assert.equal(m.get('0,1').length, 1);
  });

  test('returns an empty map when given no tiles', () => {
    const m = assignTilesToClusters([]);
    assert.equal(m.size, 0);
  });

  test('respects the clusterSize argument', () => {
    const tiles = [{ col: 0, row: 0 }, { col: 3, row: 3 }, { col: 4, row: 4 }];
    const m = assignTilesToClusters(tiles, 2);
    // cluster ids at size 2: (0,0), (1,1), (2,2) → all different
    assert.equal(m.size, 3);
  });
});

// ─── Renderer3D._bakeTileClusters with a stub Babylon ─────────────────────

function fakeFlatHex(col, row, materialRef, opts = {}) {
  // Mirrors what `_buildFlatHexMesh` produces: 7 vertices, COLOR_0 buffer
  // present, metadata carries (col, row), and the picked material reference
  // is what _bakeTileClusters buckets on.
  const colors = new Array(7 * 4).fill(1);
  const hex = {
    name: `tile_${col}_${row}`,
    material: materialRef,
    metadata: { kind: 'tile', col, row, baseColor: '#000' },
    isVisible:  true,
    isPickable: true,
    isWorldMatrixFrozen: false,
    doNotSyncBoundingInfo: false,
    _colors: colors,
    getTotalVertices() { return 7; },
    getVerticesData(kind) {
      if (kind === 'color') return this._colors;
      return null;
    },
    setVerticesData(kind, data /* , updatable */) {
      if (kind === 'color') this._colors = data;
    },
    freezeWorldMatrix() { this.isWorldMatrixFrozen = true; return this; },
    ...opts,
  };
  return hex;
}

function fakeBabylon() {
  return {
    VertexBuffer: { ColorKind: 'color' },
    Mesh: {
      MergeMeshes(meshes, disposeSource /* , ... */) {
        // Concatenate the source meshes' COLOR_0 buffers in pass order so
        // _bakeTileClusters' offset tracking can be verified end-to-end.
        const colors = [];
        let totalVerts = 0;
        for (const m of meshes) {
          const src = m.getVerticesData('color');
          for (let i = 0; i < src.length; i++) colors.push(src[i]);
          totalVerts += m.getTotalVertices();
        }
        return {
          name: 'mergedStub',
          parent: null,
          material: null,
          isVisible: true,
          isPickable: true,
          isWorldMatrixFrozen: false,
          doNotSyncBoundingInfo: false,
          _colors: colors,
          _verts: totalVerts,
          getTotalVertices() { return this._verts; },
          getVerticesData(kind) {
            if (kind === 'color') return this._colors;
            return null;
          },
          setVerticesData(kind, data) {
            if (kind === 'color') this._colors = data;
          },
          dispose() { this._disposed = true; },
          freezeWorldMatrix() { this.isWorldMatrixFrozen = true; return this; },
        };
      },
    },
  };
}

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  const inst = new Renderer3D(fakeCanvas, {});
  inst._babylon = fakeBabylon();
  inst._scene = {};
  inst._mapRoot = { isFakeMapRoot: true };
  // No-op shadow registration in the stub world.
  inst._setShadowReceiver = () => {};
  return inst;
}

describe('Renderer3D._bakeTileClusters — merges per-tile flat hexes', () => {
  test('groups tiles by (material × cluster id) and merges multi-tile buckets', () => {
    const inst = newInst();
    const grassMat  = { id: 'grass',  uniqueId: 1 };
    const forestMat = { id: 'forest', uniqueId: 2 };
    // All tiles inside cluster region (0,0): cols 0–3 × rows 0–3.
    inst._tileMeshByKey.set('0,0', fakeFlatHex(0, 0, grassMat));
    inst._tileMeshByKey.set('1,0', fakeFlatHex(1, 0, grassMat));
    inst._tileMeshByKey.set('2,0', fakeFlatHex(2, 0, grassMat));
    inst._tileMeshByKey.set('3,3', fakeFlatHex(3, 3, forestMat));
    inst._tileMeshByKey.set('0,1', fakeFlatHex(0, 1, grassMat));

    inst._bakeTileClusters();

    // Two buckets total: 4 grass tiles in (0,0) → merged; 1 forest tile in
    // (0,0) → kept as-is (1-bucket short-circuit).
    assert.equal(inst._tileClusterMeshes.length, 1, 'one merged cluster');
    const merged = inst._tileClusterMeshes[0];
    assert.equal(merged.material, grassMat, 'cluster material = grass');
    assert.equal(merged.isPickable, false);
    assert.equal(merged.parent, inst._mapRoot);

    // All four grass source meshes should now be invisible (rendering goes
    // through the cluster) but still pickable (clicks resolve back to tile).
    for (const key of ['0,0', '1,0', '2,0', '0,1']) {
      const hex = inst._tileMeshByKey.get(key);
      assert.equal(hex.isVisible, false, `${key} → invisible`);
      assert.equal(hex.isPickable, true,  `${key} → pickable`);
    }
    // The lone forest source stays visible+pickable (no cluster created).
    const forest = inst._tileMeshByKey.get('3,3');
    assert.equal(forest.isVisible, true);
    assert.equal(forest.isPickable, true);
  });

  test('records each tile’s vertex range in _tileVertexColorRef', () => {
    const inst = newInst();
    const mat = { id: 'grass', uniqueId: 1 };
    inst._tileMeshByKey.set('0,0', fakeFlatHex(0, 0, mat));
    inst._tileMeshByKey.set('1,0', fakeFlatHex(1, 0, mat));
    inst._tileMeshByKey.set('2,2', fakeFlatHex(2, 2, mat));

    inst._bakeTileClusters();

    const merged = inst._tileClusterMeshes[0];
    // Vertex offsets reflect insertion order into the bucket.
    let total = 0;
    for (const k of ['0,0', '1,0', '2,2']) {
      const ref = inst._tileVertexColorRef.get(k);
      assert.ok(ref, `${k} → ref present`);
      assert.equal(ref.mesh, merged);
      assert.equal(ref.vertexCount, 7);
      assert.equal(ref.vertexStart, total);
      total += 7;
    }
  });

  test('1-tile bucket → ref points at the source mesh itself', () => {
    const inst = newInst();
    const matA = { id: 'a', uniqueId: 1 };
    const matB = { id: 'b', uniqueId: 2 };
    inst._tileMeshByKey.set('0,0', fakeFlatHex(0, 0, matA));
    inst._tileMeshByKey.set('1,0', fakeFlatHex(1, 0, matB)); // alone in its bucket

    inst._bakeTileClusters();

    const ref = inst._tileVertexColorRef.get('1,0');
    assert.ok(ref);
    assert.equal(ref.mesh, inst._tileMeshByKey.get('1,0'),
      'lone-tile ref points at the source flat-hex');
    assert.equal(ref.vertexStart, 0);
    assert.equal(ref.vertexCount, 7);
  });

  test('re-running _bakeTileClusters disposes old clusters and rebuilds', () => {
    const inst = newInst();
    const mat = { id: 'grass', uniqueId: 1 };
    for (let c = 0; c < 3; c++) {
      inst._tileMeshByKey.set(`${c},0`, fakeFlatHex(c, 0, mat));
    }
    inst._bakeTileClusters();
    const first = inst._tileClusterMeshes[0];
    assert.ok(first);

    // Second bake — first cluster should be disposed and a fresh merge
    // produced.
    inst._bakeTileClusters();
    assert.equal(first._disposed, true, 'old cluster disposed');
    assert.equal(inst._tileClusterMeshes.length, 1);
    assert.notEqual(inst._tileClusterMeshes[0], first, 'new cluster mesh');
  });

  test('tiles in different spatial regions don’t merge even with same material', () => {
    const inst = newInst();
    const mat = { id: 'grass', uniqueId: 1 };
    // Tiles in different 4×4 regions — (0,0) and (1,0).
    inst._tileMeshByKey.set('0,0', fakeFlatHex(0, 0, mat));
    inst._tileMeshByKey.set('1,0', fakeFlatHex(1, 0, mat));
    inst._tileMeshByKey.set('4,0', fakeFlatHex(4, 0, mat)); // region (1,0)
    inst._tileMeshByKey.set('5,0', fakeFlatHex(5, 0, mat));

    inst._bakeTileClusters();

    assert.equal(inst._tileClusterMeshes.length, 2, 'one merged mesh per region');
  });
});

// ─── Fog vertex-color path ────────────────────────────────────────────────

describe('Renderer3D._applyFogVertexColors — writes COLOR_0 subrange', () => {
  test('darkens only the tile’s vertex range, leaves neighbours alone', () => {
    const inst = newInst();
    const mat = { id: 'grass', uniqueId: 1 };
    inst._tileMeshByKey.set('0,0', fakeFlatHex(0, 0, mat));
    inst._tileMeshByKey.set('1,0', fakeFlatHex(1, 0, mat));
    inst._tileMeshByKey.set('2,0', fakeFlatHex(2, 0, mat));
    inst._fogTileDarken = 0.4;

    inst._bakeTileClusters();
    inst._applyFogVertexColors('1,0', true);

    const merged = inst._tileClusterMeshes[0];
    const colors = merged.getVerticesData('color');
    // Tile (0,0) range — vertices 0–6 → still 1.0
    for (let i = 0; i < 7; i++) {
      assert.equal(colors[i * 4 + 0], 1.0);
      assert.equal(colors[i * 4 + 1], 1.0);
      assert.equal(colors[i * 4 + 2], 1.0);
    }
    // Tile (1,0) range — vertices 7–13 → darkened to 0.4
    for (let i = 7; i < 14; i++) {
      assert.equal(colors[i * 4 + 0], 0.4);
      assert.equal(colors[i * 4 + 1], 0.4);
      assert.equal(colors[i * 4 + 2], 0.4);
      assert.equal(colors[i * 4 + 3], 1.0);
    }
    // Tile (2,0) range — still 1.0
    for (let i = 14; i < 21; i++) {
      assert.equal(colors[i * 4 + 0], 1.0);
    }
  });

  test('fog clear restores RGB=1 on the tile’s vertex range', () => {
    const inst = newInst();
    const mat = { id: 'grass', uniqueId: 1 };
    inst._tileMeshByKey.set('0,0', fakeFlatHex(0, 0, mat));
    inst._tileMeshByKey.set('1,0', fakeFlatHex(1, 0, mat));
    inst._fogTileDarken = 0.3;
    inst._bakeTileClusters();

    inst._applyFogVertexColors('0,0', true);
    inst._applyFogVertexColors('0,0', false);

    const colors = inst._tileClusterMeshes[0].getVerticesData('color');
    for (let i = 0; i < 7; i++) {
      assert.equal(colors[i * 4 + 0], 1.0);
      assert.equal(colors[i * 4 + 1], 1.0);
      assert.equal(colors[i * 4 + 2], 1.0);
    }
  });

  test('no-op when the tile has no ref entry', () => {
    const inst = newInst();
    // Nothing in _tileVertexColorRef → call should not throw.
    assert.doesNotThrow(() => inst._applyFogVertexColors('99,99', true));
  });

  test('1-tile bucket fog write lands on the source flat-hex itself', () => {
    const inst = newInst();
    const matA = { id: 'a', uniqueId: 1 };
    const matB = { id: 'b', uniqueId: 2 };
    inst._tileMeshByKey.set('0,0', fakeFlatHex(0, 0, matA));
    inst._tileMeshByKey.set('1,0', fakeFlatHex(1, 0, matB)); // alone
    inst._fogTileDarken = 0.25;
    inst._bakeTileClusters();

    inst._applyFogVertexColors('1,0', true);

    const lone = inst._tileMeshByKey.get('1,0');
    const colors = lone.getVerticesData('color');
    for (let i = 0; i < 7; i++) {
      assert.equal(colors[i * 4 + 0], 0.25);
      assert.equal(colors[i * 4 + 1], 0.25);
      assert.equal(colors[i * 4 + 2], 0.25);
    }
  });
});

// ─── Picking integrity — sources keep isPickable=true ────────────────────

describe('Renderer3D._bakeTileClusters — picking proxies', () => {
  test('clusters are non-pickable; sources stay pickable for canvasToHex', () => {
    const inst = newInst();
    const mat = { id: 'grass', uniqueId: 1 };
    for (let c = 0; c < 5; c++) {
      inst._tileMeshByKey.set(`${c},0`, fakeFlatHex(c, 0, mat));
    }
    inst._bakeTileClusters();

    // Every merged cluster mesh is non-pickable.
    for (const m of inst._tileClusterMeshes) {
      assert.equal(m.isPickable, false);
    }
    // Every source flat-hex remains pickable, even after going invisible.
    for (const hex of inst._tileMeshByKey.values()) {
      assert.equal(hex.isPickable, true, `${hex.name} → pickable`);
      // (col,row) metadata is what canvasToHex returns — must be intact.
      assert.equal(typeof hex.metadata.col, 'number');
      assert.equal(typeof hex.metadata.row, 'number');
      assert.equal(hex.metadata.kind, 'tile');
    }
  });
});
