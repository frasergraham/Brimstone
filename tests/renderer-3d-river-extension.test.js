// Tests for the river-extension helpers — river endpoints continue past the
// playable map edge in a straight line through the forest band, so water
// doesn't visually dead-end at the playable boundary.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TileType, Tile } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import {
  riverExitPoints,
  riverExtensionRibbon,
  hexToWorld,
  RIVER_RIBBON_WIDTH,
} from '../src/renderer-3d.js';

// Real layered Tile so the isRiver/isBridge predicates resolve from the path
// layer (plain `{type}` objects carry no path layer).
function mkTile(col, row, type) {
  const t = new Tile(col, row, type);
  t.roadDirs = new Set();
  return t;
}

/** Build a tiles map where a river crosses horizontally through (0..N, row).
 *  Endpoints at col=0 and col=N each have exactly one water neighbour, so
 *  they should be detected as river exits. */
function makeRiverAcross(cols, row = 2) {
  const tiles = new Map();
  for (let c = 0; c < cols; c++) {
    tiles.set(hexKey(c, row), mkTile(c, row, TileType.RIVER));
  }
  return tiles;
}

describe('riverExitPoints', () => {
  test('a river crossing the map has exactly two exits — one per endpoint', () => {
    const tiles = makeRiverAcross(5, 2);
    const exits = riverExitPoints(tiles);
    assert.equal(exits.length, 2);
    const cols = exits.map(e => e.tile.col).sort((a, b) => a - b);
    assert.deepEqual(cols, [0, 4]);
  });

  test('a river-tile in the middle (2 water neighbours) is NOT an exit', () => {
    const tiles = makeRiverAcross(5, 2);
    const exits = riverExitPoints(tiles);
    assert.ok(exits.every(e => e.tile.col !== 1 && e.tile.col !== 2 && e.tile.col !== 3));
  });

  test('the west endpoint points outward (-X) and the east endpoint outward (+X)', () => {
    const tiles = makeRiverAcross(5, 2);
    const exits = riverExitPoints(tiles);
    const west = exits.find(e => e.tile.col === 0);
    const east = exits.find(e => e.tile.col === 4);
    assert.ok(west.tangent.x < -0.9, `west tangent x ${west.tangent.x} should be ~-1`);
    assert.ok(Math.abs(west.tangent.z) < 1e-9);
    assert.ok(east.tangent.x > 0.9, `east tangent x ${east.tangent.x} should be ~+1`);
    assert.ok(Math.abs(east.tangent.z) < 1e-9);
  });

  test('exit point sits one apothem outboard of the endpoint tile centre', () => {
    const tiles = makeRiverAcross(5, 2);
    const exits = riverExitPoints(tiles);
    const apo = Math.sqrt(3) / 2;
    for (const e of exits) {
      const here = hexToWorld(e.tile.col, e.tile.row);
      // |point - here| ≈ apo, along the tangent.
      const dx = e.point.x - here.x;
      const dz = e.point.z - here.z;
      assert.ok(Math.abs(Math.hypot(dx, dz) - apo) < 1e-9,
        `|exit-centre| ${Math.hypot(dx, dz)} should equal apothem ${apo}`);
    }
  });

  test('exit tangent is a unit vector', () => {
    const tiles = makeRiverAcross(5, 2);
    for (const e of riverExitPoints(tiles)) {
      const len = Math.hypot(e.tangent.x, e.tangent.z);
      assert.ok(Math.abs(len - 1) < 1e-9, `tangent length ${len} should be 1`);
    }
  });

  test('isolated river tile (no water neighbours) is NOT an exit', () => {
    const tiles = new Map();
    tiles.set(hexKey(5, 5), mkTile(5, 5, TileType.RIVER));
    assert.equal(riverExitPoints(tiles).length, 0);
  });

  test('non-water tiles never appear as exits', () => {
    const tiles = new Map();
    tiles.set(hexKey(0, 0), mkTile(0, 0, TileType.GRASS));
    tiles.set(hexKey(1, 0), mkTile(1, 0, TileType.FOREST));
    assert.equal(riverExitPoints(tiles).length, 0);
  });

  test('BRIDGE tiles count as water — a river ending at a bridge still exits', () => {
    const tiles = new Map();
    // River → bridge → off-map. The bridge is a 1-water-neighbour tile → exit.
    tiles.set(hexKey(0, 0), mkTile(0, 0, TileType.RIVER));
    tiles.set(hexKey(1, 0), mkTile(1, 0, TileType.BRIDGE));
    const exits = riverExitPoints(tiles);
    assert.equal(exits.length, 2);
    // Both endpoints (river @ col=0, bridge @ col=1) qualify since each has
    // exactly one water neighbour. Verify they point in opposite directions.
    const sumX = exits[0].tangent.x + exits[1].tangent.x;
    assert.ok(Math.abs(sumX) < 1e-9, 'opposite-endpoint tangents should cancel');
  });

  test('null / empty / non-iterable input returns []', () => {
    assert.deepEqual(riverExitPoints(null), []);
    assert.deepEqual(riverExitPoints(undefined), []);
    assert.deepEqual(riverExitPoints({}), []);
    assert.deepEqual(riverExitPoints(new Map()), []);
  });
});

describe('riverExtensionRibbon', () => {
  test('produces a ribbon whose centreline endpoints are `length` apart along the tangent', () => {
    const exit = {
      tile: { col: 0, row: 0 },
      point: { x: 0, z: 0 },
      tangent: { x: 1, z: 0 },
    };
    const { left, right } = riverExtensionRibbon(exit, 3.0, RIVER_RIBBON_WIDTH, 4);
    assert.equal(left.length, 5);
    assert.equal(right.length, 5);
    // Centreline = midpoint of left/right at each sample. Start ≈ exit.point;
    // end ≈ exit.point + tangent * length.
    const mid = (i) => ({
      x: (left[i].x + right[i].x) / 2,
      z: (left[i].z + right[i].z) / 2,
    });
    const start = mid(0);
    const end   = mid(left.length - 1);
    assert.ok(Math.abs(start.x - 0) < 1e-9);
    assert.ok(Math.abs(start.z - 0) < 1e-9);
    assert.ok(Math.abs(end.x - 3.0) < 1e-9);
    assert.ok(Math.abs(end.z - 0) < 1e-9);
  });

  test('left and right paths are separated by exactly RIVER_RIBBON_WIDTH perpendicular to the tangent', () => {
    const exit = {
      tile: { col: 0, row: 0 },
      point: { x: 0, z: 0 },
      tangent: { x: 1, z: 0 }, // +X tangent → +/- Z perpendicular
    };
    const { left, right } = riverExtensionRibbon(exit, 2.0, RIVER_RIBBON_WIDTH, 4);
    for (let i = 0; i < left.length; i++) {
      const sep = Math.hypot(left[i].x - right[i].x, left[i].z - right[i].z);
      assert.ok(Math.abs(sep - RIVER_RIBBON_WIDTH) < 1e-9,
        `sample ${i} separation ${sep} should equal width ${RIVER_RIBBON_WIDTH}`);
      // Perpendicular: tangent is +X, so the offset should be purely in Z.
      assert.ok(Math.abs(left[i].x - right[i].x) < 1e-9);
    }
  });

  test('default segment count yields ≥2 samples per side', () => {
    const exit = {
      tile: { col: 0, row: 0 },
      point: { x: 0, z: 0 },
      tangent: { x: 0, z: 1 },
    };
    const { left, right } = riverExtensionRibbon(exit, 1.0);
    assert.ok(left.length >= 2);
    assert.ok(right.length >= 2);
  });

  test('zero length / missing exit returns empty paths', () => {
    assert.deepEqual(riverExtensionRibbon(null, 1.0).left, []);
    assert.deepEqual(riverExtensionRibbon({ point: { x: 0, z: 0 } }, 1.0).left, []);
    const exit = { point: { x: 0, z: 0 }, tangent: { x: 1, z: 0 } };
    assert.deepEqual(riverExtensionRibbon(exit, 0).left, []);
  });

  test('diagonal tangent (e.g. NE) still produces a ribbon of the right length', () => {
    const t = { x: Math.SQRT1_2, z: Math.SQRT1_2 };
    const exit = { point: { x: 1, z: 1 }, tangent: t };
    const length = 5.0;
    const { left, right } = riverExtensionRibbon(exit, length, RIVER_RIBBON_WIDTH, 4);
    const mid = (i) => ({
      x: (left[i].x + right[i].x) / 2,
      z: (left[i].z + right[i].z) / 2,
    });
    const end = mid(left.length - 1);
    const span = Math.hypot(end.x - 1, end.z - 1);
    assert.ok(Math.abs(span - length) < 1e-9,
      `diagonal extension span ${span} should equal length ${length}`);
  });
});
