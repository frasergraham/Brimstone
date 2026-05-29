// 3D renderer — fortification build/refresh/dispose lifecycle.
//
// Babylon can't run under node-test (no WebGL), so `_syncFortifications` is
// exercised against a stubbed `_babylon` namespace — the same approach the
// house-glb / shadow-receiver suites use. We assert the per-edge mesh count
// (adjacency rule), the rebuild-on-level-change path, fog tinting, and that
// dropping to level 0 disposes the meshes + material.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';
import { Tile, TileType } from '../src/tiles.js';

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

function makeFakeBabylon() {
  class Color3 {
    constructor(r = 0, g = 0, b = 0) { this.r = r; this.g = g; this.b = b; }
  }
  class StandardMaterial {
    constructor(name) { this.name = name; this.disposed = false; }
    dispose() { this.disposed = true; }
  }
  const makeMesh = (name) => ({
    name,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    parent: null, material: null, isPickable: true,
    disposed: false,
    dispose() { this.disposed = true; },
  });
  return {
    Color3,
    StandardMaterial,
    MeshBuilder: {
      CreateBox: (name) => makeMesh(name),
      CreateCylinder: (name) => makeMesh(name),
    },
  };
}

// Minimal renderer harness: stubbed Babylon + scene + mapRoot, and a tile Map.
function harness(tileSpecs) {
  const r = newInst();
  r._babylon = makeFakeBabylon();
  r._scene = {};
  r._mapRoot = { name: 'mapRoot' };
  const tiles = new Map();
  for (const { col, row, fort } of tileSpecs) {
    const t = new Tile(col, row, TileType.GRASS);
    t.fortifyLevel = fort;
    tiles.set(`${col},${row}`, t);
  }
  r.state = { tiles };
  return r;
}

describe('_syncFortifications — build + adjacency', () => {
  test('an isolated fortified hex builds one mesh per perimeter edge', () => {
    const r = harness([{ col: 5, row: 5, fort: 3 }]); // level 3 → 'low' wall
    r._syncFortifications();
    const entry = r._fortByKey.get('5,5');
    assert.ok(entry, 'fort entry created');
    // 'low'/'tall' draw one box per edge; isolated hex → all 6 edges.
    assert.equal(entry.meshes.length, 6);
    // Every mesh is parented to the map root with the per-hex material.
    for (const m of entry.meshes) {
      assert.equal(m.parent, r._mapRoot);
      assert.equal(m.material, entry.mat);
      assert.equal(m.isPickable, false);
    }
  });

  test('shared interior edge is skipped — two adjacent forts build 5 walls each', () => {
    const r = harness([
      { col: 5, row: 4, fort: 2 },
      { col: 6, row: 4, fort: 2 }, // East neighbour of (5,4)
    ]);
    r._syncFortifications();
    assert.equal(r._fortByKey.get('5,4').meshes.length, 5);
    assert.equal(r._fortByKey.get('6,4').meshes.length, 5);
  });

  test('level 1 stakes build multiple posts per edge (cylinders)', () => {
    const r = harness([{ col: 5, row: 5, fort: 1 }]);
    r._syncFortifications();
    const entry = r._fortByKey.get('5,5');
    // 3 posts × 6 edges = 18 cylinders.
    assert.equal(entry.meshes.length, 18);
    assert.ok(entry.meshes.every(m => m.name.startsWith('fort_')));
  });
});

describe('_syncFortifications — refresh + dispose lifecycle', () => {
  test('unchanged state on re-sync does NOT rebuild (same mesh objects)', () => {
    const r = harness([{ col: 5, row: 5, fort: 2 }]);
    r._syncFortifications();
    const first = r._fortByKey.get('5,5').meshes.slice();
    r._syncFortifications();
    const second = r._fortByKey.get('5,5').meshes;
    assert.deepEqual(second, first, 'meshes reused (signature unchanged)');
  });

  test('raising the level rebuilds and disposes the old meshes', () => {
    const r = harness([{ col: 5, row: 5, fort: 1 }]); // stakes
    r._syncFortifications();
    const old = r._fortByKey.get('5,5').meshes.slice();
    const oldMat = r._fortByKey.get('5,5').mat;

    r.state.tiles.get('5,5').fortifyLevel = 4; // → 'tall', different signature
    r._syncFortifications();

    for (const m of old) assert.equal(m.disposed, true, 'old wall mesh disposed');
    assert.equal(oldMat.disposed, true, 'old material disposed');
    assert.equal(r._fortByKey.get('5,5').sig.startsWith('tall'), true);
  });

  test('dropping to level 0 disposes everything and forgets the hex', () => {
    const r = harness([{ col: 5, row: 5, fort: 3 }]);
    r._syncFortifications();
    const entry = r._fortByKey.get('5,5');
    const meshes = entry.meshes.slice();

    r.state.tiles.get('5,5').fortifyLevel = 0;
    r._syncFortifications();

    assert.equal(r._fortByKey.has('5,5'), false, 'entry removed');
    for (const m of meshes) assert.equal(m.disposed, true);
    assert.equal(entry.mat.disposed, true);
  });
});

describe('_syncFortifications — fog tinting', () => {
  test('fogged hex darkens the wall material; unfogging restores it', () => {
    const r = harness([{ col: 5, row: 5, fort: 2 }]);
    r._fogTileDarken = 0.5;
    r._syncFortifications();
    const entry = r._fortByKey.get('5,5');
    const base = { ...entry.baseDiffuse };

    // Fog the hex, re-sync → diffuse multiplied by the darken factor.
    r._fogActiveSet.add('5,5');
    r._syncFortifications();
    assert.ok(Math.abs(entry.mat.diffuseColor.r - base.r * 0.5) < 1e-9);

    // Clear fog, re-sync → restored to the anchor colour (no accumulation).
    r._fogActiveSet.delete('5,5');
    r._syncFortifications();
    assert.ok(Math.abs(entry.mat.diffuseColor.r - base.r) < 1e-9);
  });
});
