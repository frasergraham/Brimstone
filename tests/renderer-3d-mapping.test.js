// Phase 2 of the 3D renderer — pure-helper unit tests.
//
// The Renderer3D class is split between Babylon glue (untested here — needs
// WebGL) and the pure functions it uses to translate hex coords to world
// space, compute bounds, and map tile types to colours. Those pure pieces
// are exported from src/renderer-3d.js so we can verify them in node-test
// without a browser context.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  HEX_RADIUS_WORLD,
  hexToWorld,
  computeMapBounds,
  cssHexToRgb01,
  tileColorFor,
} from '../src/renderer-3d.js';
import { TileType, TILE_COLOR, BuildingType, BUILDING_COLOR } from '../src/tiles.js';

describe('Renderer3D — hexToWorld', () => {
  test('origin tile sits at (0, 0)', () => {
    const { x, z } = hexToWorld(0, 0);
    assert.equal(x, 0);
    assert.equal(z, 0);
  });

  test('row spacing equals 1.5 × radius (vertical step between rows)', () => {
    const r0 = hexToWorld(0, 0);
    const r2 = hexToWorld(0, 2);
    // Even-to-even rows share the same X; Z advances by 1.5 per row.
    assert.equal(r2.x, r0.x);
    assert.ok(Math.abs(r2.z - (r0.z + 3 * HEX_RADIUS_WORLD)) < 1e-9);
  });

  test('horizontal step between columns equals sqrt(3) × radius', () => {
    const c0 = hexToWorld(0, 0);
    const c1 = hexToWorld(1, 0);
    assert.ok(Math.abs(c1.x - c0.x - Math.sqrt(3) * HEX_RADIUS_WORLD) < 1e-9);
    assert.equal(c0.z, c1.z);
  });

  test('odd rows are shifted half a hex to the right (odd-r offset)', () => {
    const evenRow = hexToWorld(0, 0);
    const oddRow  = hexToWorld(0, 1);
    assert.ok(Math.abs(oddRow.x - evenRow.x - (Math.sqrt(3) / 2) * HEX_RADIUS_WORLD) < 1e-9);
  });

  test('neighbouring tiles are within 1 hex-diameter of each other', () => {
    // Pointy-top hex centres of any two adjacent tiles should be exactly
    // sqrt(3) units apart (the flat-to-flat distance with unit radius).
    const expected = Math.sqrt(3) * HEX_RADIUS_WORLD;
    // row 4 is even → DIRS_EVEN = [[-1,0],[-1,-1],[0,-1],[1,0],[0,1],[-1,1]]
    const pairs = [
      [[5, 4], [6, 4]],   // east  (1, 0)
      [[5, 4], [4, 4]],   // west  (-1, 0)
      [[5, 4], [5, 3]],   // NE    (0, -1)
      [[5, 4], [4, 3]],   // NW    (-1, -1)
      [[5, 4], [5, 5]],   // SE    (0, 1)
      [[5, 4], [4, 5]],   // SW    (-1, 1)
    ];
    for (const [[c1, r1], [c2, r2]] of pairs) {
      const a = hexToWorld(c1, r1);
      const b = hexToWorld(c2, r2);
      const d = Math.hypot(b.x - a.x, b.z - a.z);
      assert.ok(Math.abs(d - expected) < 1e-6,
        `expected ${expected}, got ${d} between (${c1},${r1}) and (${c2},${r2})`);
    }
  });
});

describe('Renderer3D — computeMapBounds', () => {
  test('returns null for empty input', () => {
    assert.equal(computeMapBounds([]), null);
    assert.equal(computeMapBounds(null), null);
  });

  test('single tile yields a bounding box centred on the tile', () => {
    const b = computeMapBounds([{ col: 3, row: 4 }]);
    const { x, z } = hexToWorld(3, 4);
    assert.ok(Math.abs(b.centerX - x) < 1e-9);
    assert.ok(Math.abs(b.centerZ - z) < 1e-9);
    // Width / depth should be the hex's bounding rectangle (~sqrt(3) × 2).
    assert.ok(Math.abs(b.width  - Math.sqrt(3) * HEX_RADIUS_WORLD) < 1e-9);
    assert.ok(Math.abs(b.depth  - 2 * HEX_RADIUS_WORLD) < 1e-9);
  });

  test('small grid bounds enclose every centre and pad by the hex footprint', () => {
    const tiles = [];
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) tiles.push({ col: c, row: r });
    const b = computeMapBounds(tiles);

    // Every centre must lie inside the bounds (strictly inside, not on the edge).
    for (const t of tiles) {
      const { x, z } = hexToWorld(t.col, t.row);
      assert.ok(x > b.minX && x < b.maxX, `x=${x} out of bounds ${b.minX}..${b.maxX}`);
      assert.ok(z > b.minZ && z < b.maxZ, `z=${z} out of bounds ${b.minZ}..${b.maxZ}`);
    }
    // Centre is the midpoint of min/max.
    assert.ok(Math.abs(b.centerX - (b.minX + b.maxX) / 2) < 1e-9);
    assert.ok(Math.abs(b.centerZ - (b.minZ + b.maxZ) / 2) < 1e-9);
  });
});

describe('Renderer3D — cssHexToRgb01', () => {
  test('parses 6-digit hex to 0..1 floats', () => {
    assert.deepEqual(cssHexToRgb01('#000000'), [0, 0, 0]);
    assert.deepEqual(cssHexToRgb01('#ffffff'), [1, 1, 1]);
    const [r, g, b] = cssHexToRgb01('#80c040');
    assert.ok(Math.abs(r - 0x80 / 255) < 1e-9);
    assert.ok(Math.abs(g - 0xc0 / 255) < 1e-9);
    assert.ok(Math.abs(b - 0x40 / 255) < 1e-9);
  });

  test('returns magenta on malformed input (loud failure)', () => {
    assert.deepEqual(cssHexToRgb01('not-a-color'), [1, 0, 1]);
    assert.deepEqual(cssHexToRgb01('#abc'), [1, 0, 1]); // 3-digit not supported
  });
});

describe('Renderer3D — tileColorFor', () => {
  test('returns the tile-type colour for plain terrain', () => {
    for (const type of [TileType.GRASS, TileType.FOREST, TileType.DIRT]) {
      assert.equal(tileColorFor({ type }), TILE_COLOR[type]);
    }
  });

  test('rivers, roads, and bridges render as grass underneath the network overlay', () => {
    // Item 2: the per-tile cylinder colour for ROAD / RIVER / BRIDGE is now
    // GRASS — the visual path is supplied by the bezier network mesh built
    // by Renderer3D._buildRoadRiverNetworks. Locks the new behaviour so a
    // regression to the old "river is a blue tile" approach is caught.
    assert.equal(tileColorFor({ type: TileType.RIVER  }), TILE_COLOR[TileType.GRASS]);
    assert.equal(tileColorFor({ type: TileType.ROAD   }), TILE_COLOR[TileType.GRASS]);
    assert.equal(tileColorFor({ type: TileType.BRIDGE }), TILE_COLOR[TileType.GRASS]);
  });

  test('buildings use BUILDING_COLOR (not the generic building tile colour)', () => {
    assert.equal(
      tileColorFor({ type: TileType.BUILDING, building: BuildingType.INN }),
      BUILDING_COLOR[BuildingType.INN],
    );
    assert.equal(
      tileColorFor({ type: TileType.BUILDING, building: BuildingType.GRAVEYARD }),
      BUILDING_COLOR[BuildingType.GRAVEYARD],
    );
  });

  test('null / unknown tile falls back to grass', () => {
    assert.equal(tileColorFor(null), TILE_COLOR[TileType.GRASS]);
    assert.equal(tileColorFor({ type: 'mystery' }), TILE_COLOR[TileType.GRASS]);
  });
});
