// Pure-helper tests for the impassable forest border around the playable
// map. The renderer itself can't run in node-test (Babylon + WebGL), but the
// position enumeration and cone-count layout are pure functions of the
// tiles map.
//
// Also pins a regression: `_mapPanBounds` is computed from playable tiles
// only, so the camera pan clamp must not expand to include the visual-only
// forest band — otherwise the user could pan into the sea of trees.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BORDER_BAND_DEPTH,
  BORDER_FOREST_TREES_MIN,
  BORDER_FOREST_TREES_MAX,
  borderForestTreesForHex,
  borderTilePositions,
  clampPanTarget,
  computeMapBounds,
  HEX_RADIUS_WORLD,
  hexToWorld,
  tilesExtent,
  TILE_SLOTS,
} from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';

function buildRectMap(cols, rows) {
  const m = new Map();
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    m.set(hexKey(c, r), { col: c, row: r });
  }
  return m;
}

describe('Renderer3D — tilesExtent', () => {
  test('null/empty returns null', () => {
    assert.equal(tilesExtent(null), null);
    assert.equal(tilesExtent(new Map()), null);
  });

  test('rectangular map returns 0..C-1, 0..R-1', () => {
    const ext = tilesExtent(buildRectMap(13, 13));
    assert.deepEqual(ext, { minCol: 0, maxCol: 12, minRow: 0, maxRow: 12 });
  });

  test('non-zero-origin map returns min/max correctly', () => {
    const m = new Map();
    m.set(hexKey(-2, -3), { col: -2, row: -3 });
    m.set(hexKey(5, 7), { col: 5, row: 7 });
    m.set(hexKey(1, 1), { col: 1, row: 1 });
    assert.deepEqual(tilesExtent(m), { minCol: -2, maxCol: 5, minRow: -3, maxRow: 7 });
  });
});

describe('Renderer3D — borderTilePositions', () => {
  test('null/empty returns []', () => {
    assert.deepEqual(borderTilePositions(null), []);
    assert.deepEqual(borderTilePositions(new Map()), []);
  });

  test('non-positive depth returns []', () => {
    const tiles = buildRectMap(5, 5);
    assert.deepEqual(borderTilePositions(tiles, 0), []);
    assert.deepEqual(borderTilePositions(tiles, -1), []);
  });

  test('default depth equals BORDER_BAND_DEPTH (2)', () => {
    assert.equal(BORDER_BAND_DEPTH, 2);
    const tiles = buildRectMap(3, 3);
    const withDefault = borderTilePositions(tiles);
    const withExplicit = borderTilePositions(tiles, BORDER_BAND_DEPTH);
    assert.equal(withDefault.length, withExplicit.length);
  });

  test('count matches formula (C+2d)(R+2d) − C·R for various sizes', () => {
    for (const [cols, rows, depth] of [
      [9, 9, 2],
      [13, 13, 2],
      [17, 17, 2],
      [21, 17, 3],
      [5, 5, 1],
    ]) {
      const tiles = buildRectMap(cols, rows);
      const band = borderTilePositions(tiles, depth);
      const expected = (cols + 2 * depth) * (rows + 2 * depth) - cols * rows;
      assert.equal(
        band.length, expected,
        `expected ${expected} border tiles for ${cols}×${rows} band-depth ${depth}, got ${band.length}`,
      );
    }
  });

  test('zero overlap with playable hexes', () => {
    const tiles = buildRectMap(13, 13);
    const band  = borderTilePositions(tiles, 2);
    for (const p of band) {
      assert.equal(
        tiles.has(hexKey(p.col, p.row)),
        false,
        `border tile (${p.col}, ${p.row}) overlaps the playable map`,
      );
    }
  });

  test('band positions are inside the (extent ± depth) rectangle', () => {
    const cols = 13, rows = 13, depth = 2;
    const tiles = buildRectMap(cols, rows);
    const band  = borderTilePositions(tiles, depth);
    for (const p of band) {
      assert.ok(p.col >= -depth && p.col <= cols - 1 + depth, `col out of range: ${p.col}`);
      assert.ok(p.row >= -depth && p.row <= rows - 1 + depth, `row out of range: ${p.row}`);
    }
  });

  test('band is contiguous — every band cell has at least one neighbour in band∪playable', () => {
    const cols = 7, rows = 7, depth = 2;
    const tiles = buildRectMap(cols, rows);
    const band  = borderTilePositions(tiles, depth);
    const all = new Set();
    for (const p of band) all.add(`${p.col},${p.row}`);
    for (const t of tiles.values()) all.add(`${t.col},${t.row}`);
    // Use simple axis-aligned (col±1, row), (col, row±1) plus row-parity diagonals.
    // For contiguity it's enough that the band rectangle is filled solid.
    for (const p of band) {
      let touches = false;
      for (const [dc, dr] of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[1,-1],[-1,1],[1,1]]) {
        if (all.has(`${p.col + dc},${p.row + dr}`)) { touches = true; break; }
      }
      assert.ok(touches, `band tile (${p.col}, ${p.row}) is isolated`);
    }
  });

  test('all 4 corners of the outer ring are included', () => {
    const cols = 5, rows = 5, depth = 2;
    const tiles = buildRectMap(cols, rows);
    const band  = borderTilePositions(tiles, depth);
    const set = new Set(band.map((p) => `${p.col},${p.row}`));
    const minC = -depth, maxC = cols - 1 + depth;
    const minR = -depth, maxR = rows - 1 + depth;
    assert.ok(set.has(`${minC},${minR}`), 'top-left corner missing');
    assert.ok(set.has(`${maxC},${minR}`), 'top-right corner missing');
    assert.ok(set.has(`${minC},${maxR}`), 'bottom-left corner missing');
    assert.ok(set.has(`${maxC},${maxR}`), 'bottom-right corner missing');
  });
});

describe('Renderer3D — borderForestTreesForHex', () => {
  test('cone count is within [MIN, MAX] for many hexes', () => {
    for (let col = -5; col <= 20; col++) {
      for (let row = -5; row <= 20; row++) {
        const trees = borderForestTreesForHex(col, row);
        assert.ok(
          trees.length >= BORDER_FOREST_TREES_MIN && trees.length <= BORDER_FOREST_TREES_MAX,
          `out of range at (${col}, ${row}): ${trees.length}`,
        );
      }
    }
  });

  test('range is denser than in-map forest (3–5)', () => {
    // The in-map forest helper goes 3–5; border goes ≥5 so a border hex is
    // never sparser than the densest playable forest tile.
    assert.ok(BORDER_FOREST_TREES_MIN >= 5);
    assert.ok(BORDER_FOREST_TREES_MAX <= TILE_SLOTS.length);
  });

  test('deterministic — same (col, row) yields same trees', () => {
    const a = borderForestTreesForHex(3, 7);
    const b = borderForestTreesForHex(3, 7);
    assert.deepEqual(a, b);
  });

  test('different hexes yield different layouts (at least sometimes)', () => {
    const a = borderForestTreesForHex(3, 7);
    const b = borderForestTreesForHex(8, 2);
    // It's overwhelmingly likely that (count, slot indices, scales) differ.
    const asKey = (ts) => JSON.stringify(ts.map((t) => [t.slotIdx, +t.scale.toFixed(3)]));
    assert.notEqual(asKey(a), asKey(b));
  });

  test('every tree uses a valid TILE_SLOT', () => {
    const trees = borderForestTreesForHex(0, 0);
    for (const t of trees) {
      assert.ok(t.slotIdx >= 0 && t.slotIdx < TILE_SLOTS.length);
      const slot = TILE_SLOTS[t.slotIdx];
      assert.equal(t.x, slot.x);
      assert.equal(t.z, slot.z);
    }
  });
});

describe('Renderer3D — pan clamp regression: bounded to playable extent', () => {
  // The renderer caches `_mapPanBounds = computeMapBounds(allHexes)` where
  // `allHexes` is built from `state.tiles` only. The visual-only forest
  // border is NOT in `state.tiles`, so it can't widen the clamp rectangle.
  // This test exercises the same computeMapBounds path the renderer uses.

  test('computeMapBounds on playable-only tiles returns the playable extent', () => {
    const cols = 13, rows = 13;
    const tiles = buildRectMap(cols, rows);
    const all = [];
    for (const t of tiles.values()) all.push({ col: t.col, row: t.row });
    const bounds = computeMapBounds(all);
    assert.ok(bounds, 'expected non-null bounds');

    // Centre of the playable rectangle (in world XZ).
    const cx = (hexToWorld(0, 0).x + hexToWorld(cols - 1, rows - 1).x) / 2;
    const cz = (hexToWorld(0, 0).z + hexToWorld(cols - 1, rows - 1).z) / 2;
    assert.ok(bounds.minX < cx && bounds.maxX > cx);
    assert.ok(bounds.minZ < cz && bounds.maxZ > cz);

    // Bounds do NOT include the 2-deep border band. Pick a clearly-in-border
    // hex (2 past the playable extent) and confirm its centre sits outside
    // the bounds rectangle by a healthy margin (≥ 1 hex radius).
    const farBorder = hexToWorld(cols - 1 + BORDER_BAND_DEPTH, rows - 1 + BORDER_BAND_DEPTH);
    assert.ok(farBorder.x - bounds.maxX > HEX_RADIUS_WORLD,
      `border hex X (${farBorder.x}) too close to bounds.maxX (${bounds.maxX})`);
    assert.ok(farBorder.z - bounds.maxZ > HEX_RADIUS_WORLD,
      `border hex Z (${farBorder.z}) too close to bounds.maxZ (${bounds.maxZ})`);
  });

  test('clampPanTarget rejects pan into the forest band', () => {
    const cols = 13, rows = 13, depth = 2;
    const tiles = buildRectMap(cols, rows);
    const all = [];
    for (const t of tiles.values()) all.push({ col: t.col, row: t.row });
    const bounds = computeMapBounds(all);

    // Try to pan to the centre of a hex deep in the forest band.
    const farInBorder = hexToWorld(cols - 1 + depth, rows - 1 + depth);
    const clamped = clampPanTarget(
      { x: farInBorder.x, y: 0, z: farInBorder.z },
      bounds,
      0,
    );
    // Clamped X must land at maxX (snapped back) — i.e. NOT at the requested
    // forest-band X.
    assert.ok(clamped.x < farInBorder.x, `pan clamp failed: ${clamped.x} vs ${farInBorder.x}`);
    assert.ok(clamped.z < farInBorder.z, `pan clamp failed: ${clamped.z} vs ${farInBorder.z}`);
    assert.equal(clamped.x, bounds.maxX);
    assert.equal(clamped.z, bounds.maxZ);
  });
});
