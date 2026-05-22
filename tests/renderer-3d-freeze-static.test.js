// 3D-renderer static-mesh freeze pass.
//
// `_buildMap` builds hundreds-to-thousands of meshes (tile cylinders, terrain
// props, buildings, road/river ribbons, border-forest cones, …) that never
// move post-build. We call `mesh.freezeWorldMatrix()` + set
// `doNotSyncBoundingInfo = true` on all of them so Babylon stops walking them
// every frame for world-matrix and bounding-info updates.
//
// These tests drive `_freezeStaticMeshes` with stubbed mesh objects on the
// Renderer3D instance — no Babylon import required.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
} from '../src/renderer-3d.js';

function fakeMesh(name) {
  return {
    name,
    isWorldMatrixFrozen: false,
    doNotSyncBoundingInfo: false,
    freezeWorldMatrix() { this.isWorldMatrixFrozen = true; return this; },
  };
}

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

describe('Renderer3D — GlowLayer removed', () => {
  test('instance has no `_glowLayer` field (bloom layer was retired — added noise)', () => {
    const inst = newInst();
    assert.equal(inst._glowLayer, undefined,
      'Renderer3D should not carry a GlowLayer reference any more');
  });
});

describe('_freezeStaticMeshes — locks world matrices of build-time meshes', () => {
  test('walks _tileMeshes and freezes each entry', () => {
    const inst = newInst();
    const a = fakeMesh('tile_a');
    const b = fakeMesh('tile_b');
    inst._tileMeshes = [a, b];
    const n = inst._freezeStaticMeshes();
    assert.equal(n, 2);
    assert.equal(a.isWorldMatrixFrozen, true);
    assert.equal(b.isWorldMatrixFrozen, true);
    assert.equal(a.doNotSyncBoundingInfo, true);
    assert.equal(b.doNotSyncBoundingInfo, true);
  });

  test('walks every prop list in _tilePropsByKey', () => {
    const inst = newInst();
    inst._tileMeshes = [];
    const tree = fakeMesh('tree');
    const bldg = fakeMesh('bldg');
    const roof = fakeMesh('roof');
    inst._tilePropsByKey.set('0,0', [tree]);
    inst._tilePropsByKey.set('1,1', [bldg, roof]);
    const n = inst._freezeStaticMeshes();
    assert.equal(n, 3);
    for (const m of [tree, bldg, roof]) {
      assert.equal(m.isWorldMatrixFrozen, true);
      assert.equal(m.doNotSyncBoundingInfo, true);
    }
  });

  test('walks _borderForestHexesByKey and _borderPropsByKey', () => {
    const inst = newInst();
    inst._tileMeshes = [];
    const borderHex = fakeMesh('border_hex');
    const borderTree = fakeMesh('border_tree');
    const riverExt = fakeMesh('river_ext');
    inst._borderForestHexesByKey.set('-1,0', borderHex);
    inst._borderPropsByKey.set('-1,0', [borderTree]);
    inst._borderPropsByKey.set('river-ext:5,5', [riverExt]);
    const n = inst._freezeStaticMeshes();
    assert.equal(n, 3);
    for (const m of [borderHex, borderTree, riverExt]) {
      assert.equal(m.isWorldMatrixFrozen, true);
    }
  });

  test('walks _borderForestBatchMeshes — cross-tile merged border-forest trees', () => {
    // The cross-tile merge collapses ~240–900 per-tile cone clusters into ≤10
    // merged meshes. These are the biggest static payoff on the map, so the
    // freeze pass MUST cover them — otherwise the merge wins are silently
    // halved by per-frame world-matrix syncs on the merged meshes.
    const inst = newInst();
    inst._tileMeshes = [];
    const merged0 = fakeMesh('borderForestBatch_0');
    const merged1 = fakeMesh('borderForestBatch_1');
    inst._borderForestBatchMeshes = [merged0, merged1];
    const n = inst._freezeStaticMeshes();
    assert.equal(n, 2);
    for (const m of [merged0, merged1]) {
      assert.equal(m.isWorldMatrixFrozen, true);
      assert.equal(m.doNotSyncBoundingInfo, true);
    }
  });

  test('walks _nodeGlowMeshes (ring tubes built lazily on first draw)', () => {
    const inst = newInst();
    inst._tileMeshes = [];
    const ring = fakeMesh('node_ring');
    inst._nodeGlowMeshes = [{ disc: ring, glowColor: {} }];
    const n = inst._freezeStaticMeshes();
    assert.equal(n, 1);
    assert.equal(ring.isWorldMatrixFrozen, true);
  });

  test('skips meshes that are already frozen (idempotent across calls)', () => {
    const inst = newInst();
    const a = fakeMesh('a');
    const b = fakeMesh('b');
    inst._tileMeshes = [a, b];
    const first = inst._freezeStaticMeshes();
    assert.equal(first, 2);
    // Second invocation must report zero freshly-frozen — the lazily-built
    // node-glow path relies on this when it re-runs _freezeStaticMeshes
    // after the map's static meshes are already locked.
    const second = inst._freezeStaticMeshes();
    assert.equal(second, 0);
  });

  test('safe on a freshly-constructed instance (empty registries)', () => {
    const inst = newInst();
    inst._tileMeshes = [];
    assert.equal(inst._freezeStaticMeshes(), 0);
  });

  test('gracefully ignores entries with no freezeWorldMatrix method', () => {
    const inst = newInst();
    inst._tileMeshes = [
      fakeMesh('ok'),
      null,
      undefined,
      { name: 'bad', /* no freezeWorldMatrix */ },
    ];
    const n = inst._freezeStaticMeshes();
    assert.equal(n, 1);
  });

  test('does NOT touch _entityStandees (dynamic — move with units)', () => {
    const inst = newInst();
    inst._tileMeshes = [];
    const plane = fakeMesh('standee_plane');
    const base  = fakeMesh('standee_base');
    inst._entityStandees.set(42, { plane, base });
    inst._freezeStaticMeshes();
    assert.equal(plane.isWorldMatrixFrozen, false,
      'entity standee planes must stay unfrozen — they move with the unit');
    assert.equal(base.isWorldMatrixFrozen, false,
      'entity standee bases must stay unfrozen — they move with the unit');
  });

  test('does NOT touch _buildingLabelsByKey (billboarded planes — billboard mode requires per-frame world-matrix update)', () => {
    const inst = newInst();
    inst._tileMeshes = [];
    const labelPlane = fakeMesh('bldgLabel');
    inst._buildingLabelsByKey.set('3,3', { plane: labelPlane, mat: null, tex: null });
    inst._freezeStaticMeshes();
    assert.equal(labelPlane.isWorldMatrixFrozen, false,
      'building hover labels are billboarded — freezing locks their rotation');
  });
});

describe('_freezeStaticMeshes — wiring contract', () => {
  test('exists as an instance method on Renderer3D', () => {
    assert.equal(typeof Renderer3D.prototype._freezeStaticMeshes, 'function');
  });

  test('returns a numeric count of freshly-frozen meshes (for diagnostics)', () => {
    const inst = newInst();
    inst._tileMeshes = [fakeMesh('one')];
    const n = inst._freezeStaticMeshes();
    assert.equal(typeof n, 'number');
    assert.ok(n >= 0);
  });
});
