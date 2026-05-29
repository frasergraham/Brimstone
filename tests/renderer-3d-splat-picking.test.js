// Stage C — splat-terrain picking (canvasToHex via ray→Y=0 plane inverse).
//
// With the flag ON there are no per-tile meshes, so `canvasToHex` intersects
// the ground plane with the screen ray and inverts world→hex, validating the
// result against the playable tiles. Entity picks still win first. Legacy
// (flag-off) picking is unchanged.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D, hexToWorld, HEX_RADIUS_WORLD } from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';
import { Tile, TileType } from '../src/tiles.js';

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  return new Renderer3D(fakeCanvas, {});
}

function rectState(cols, rows) {
  const tiles = new Map();
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    tiles.set(hexKey(c, r), new Tile(c, r, TileType.GRASS));
  }
  return { tiles };
}

// Fake scene whose createPickingRay returns a straight-down ray through a
// target world (x,z): origin above, direction (0,-1,0). `pick` returns no hit
// unless an entity is registered for the queried pixel.
function makeScene({ entityHit = null } = {}) {
  return {
    createPickingRay(localX, localZ) {
      // Encode the desired world point directly in the pixel args for the test.
      return {
        origin: { x: localX, y: 10, z: localZ },
        direction: { x: 0, y: -1, z: 0 },
      };
    },
    pick(_x, _y, predicate) {
      if (!entityHit) return { hit: false };
      // Simulate an entity mesh matching the predicate.
      const mesh = { metadata: { kind: 'entity', col: entityHit.col, row: entityHit.row } };
      if (predicate && !predicate(mesh)) return { hit: false };
      return { hit: true, pickedMesh: mesh };
    },
  };
}

describe('Renderer3D splat picking — canvasToHex', () => {
  test('ground ray resolves to the hex under the world point', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r._babylon = { Matrix: { Identity: () => ({}) } };
    r.state = rectState(6, 6);
    r._scene = makeScene();
    r._camera = {};

    for (const [col, row] of [[0, 0], [3, 2], [5, 5], [2, 4]]) {
      const { x, z } = hexToWorld(col, row, HEX_RADIUS_WORLD);
      // pixel args encode the world x/z (see fake createPickingRay)
      const got = r.canvasToHex(x, z);
      assert.deepEqual(got, { col, row }, `pick at hex (${col},${row})`);
    }
  });

  test('a point off the playable map returns the miss sentinel', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r._babylon = { Matrix: { Identity: () => ({}) } };
    r.state = rectState(3, 3);
    r._scene = makeScene();
    r._camera = {};
    // Far outside the 3×3 patch.
    const { x, z } = hexToWorld(40, 40, HEX_RADIUS_WORLD);
    assert.deepEqual(r.canvasToHex(x, z), { col: -1, row: -1 });
  });

  test('entity pick wins over the ground ray', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r._babylon = { Matrix: { Identity: () => ({}) } };
    r.state = rectState(4, 4);
    r._scene = makeScene({ entityHit: { col: 1, row: 1 } });
    r._camera = {};
    // Even though the ground ray would resolve elsewhere, the entity wins.
    const { x, z } = hexToWorld(3, 3, HEX_RADIUS_WORLD);
    assert.deepEqual(r.canvasToHex(x, z), { col: 1, row: 1 });
  });

  test('no scene → miss sentinel', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    assert.deepEqual(r.canvasToHex(10, 10), { col: -1, row: -1 });
  });

  test('_screenToGround returns null on an upward / parallel ray', () => {
    const r = makeRenderer();
    r._babylon = { Matrix: { Identity: () => ({}) } };
    r._camera = {};
    r._scene = {
      createPickingRay: () => ({ origin: { x: 0, y: 5, z: 0 }, direction: { x: 0, y: 0.5, z: 0 } }),
    };
    assert.equal(r._screenToGround(1, 1), null);
  });

  test('legacy (flag off) still uses mesh pick, ignores ground ray', () => {
    const r = makeRenderer();
    r._useSplatTerrain = false;
    r._scene = makeScene({ entityHit: { col: 2, row: 2 } });
    // legacy predicate accepts 'tile' too — entity here still resolves
    assert.deepEqual(r.canvasToHex(0, 0), { col: 2, row: 2 });
  });
});
