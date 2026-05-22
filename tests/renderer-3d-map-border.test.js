// Pure-helper tests for the rectangular map-border wedges introduced to
// replace the raw zig-zag hex silhouette with a clean rectangle. The renderer
// itself can't run without a Babylon + WebGL context, but the polygon
// generation and clipping math are pure functions of `state.tiles` and the
// hex world coordinate system.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BORDER_WEDGE_Y,
  borderWedgePolygons,
  borderWedgeSourceTile,
  clipPolygonToRect,
  HEX_RADIUS_WORLD,
  hexPolygonVertices,
  hexToWorld,
  mapBoundingRect,
  polygonArea,
  TERRAIN_DISC_Y_OFFSET,
} from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';
import { TileType } from '../src/tiles.js';

const SQRT3 = Math.sqrt(3);

function buildTilesMap(positions, typeFn = null) {
  const m = new Map();
  for (const [col, row] of positions) {
    const tile = { col, row, type: typeFn ? typeFn(col, row) : TileType.GRASS };
    m.set(hexKey(col, row), tile);
  }
  return m;
}

function buildRectMap(cols, rows, typeFn = null) {
  const positions = [];
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) positions.push([c, r]);
  return buildTilesMap(positions, typeFn);
}

describe('Renderer3D — mapBoundingRect', () => {
  test('null/empty inputs return null', () => {
    assert.equal(mapBoundingRect(null), null);
    assert.equal(mapBoundingRect(new Map()), null);
  });

  test('single hex bounds equal one hex extent (pointy-top, unit radius)', () => {
    const tiles = buildTilesMap([[0, 0]]);
    const rect = mapBoundingRect(tiles);
    assert.ok(Math.abs(rect.minX - (-SQRT3 / 2)) < 1e-9);
    assert.ok(Math.abs(rect.maxX -  (SQRT3 / 2)) < 1e-9);
    assert.ok(Math.abs(rect.minZ - (-1))         < 1e-9);
    assert.ok(Math.abs(rect.maxZ -  (1))         < 1e-9);
  });

  test('3×3 grid bounds match the expected rectangle, not the raw hex zig-zag', () => {
    const tiles = buildRectMap(3, 3);
    const rect = mapBoundingRect(tiles);
    // Left edge: even-row col 0 hex centre at x=0, left vertex at x=-SQRT3/2.
    // Right edge: odd-row col 2 hex centre at x=2.5*SQRT3, right vertex at x=3*SQRT3.
    assert.ok(Math.abs(rect.minX - (-SQRT3 / 2)) < 1e-9, `minX=${rect.minX}`);
    assert.ok(Math.abs(rect.maxX - (3 * SQRT3))  < 1e-9, `maxX=${rect.maxX}`);
    // Top: row 0 top vertex at z=-1. Bottom: row 2 centre at z=3, bottom vertex at z=4.
    assert.ok(Math.abs(rect.minZ - (-1)) < 1e-9);
    assert.ok(Math.abs(rect.maxZ - (4))  < 1e-9);
  });
});

describe('Renderer3D — hexPolygonVertices', () => {
  test('returns 6 vertices in CCW order around the hex centre', () => {
    const verts = hexPolygonVertices(2, 3);
    assert.equal(verts.length, 6);
    // First vertex (30°) should be upper-right of centre (positive x, negative z relative offset).
    const { x: cx, z: cz } = hexToWorld(2, 3);
    assert.ok(verts[0].x > cx, 'first vertex must be right of centre (upper-right)');
    assert.ok(verts[0].z < cz, 'first vertex must be above centre (upper-right)');
    // Top vertex (90°) lies directly above centre, on the centre x-line.
    assert.ok(Math.abs(verts[1].x - cx) < 1e-9);
    assert.ok(verts[1].z < cz);
  });

  test('all 6 vertices sit on the radius-1 circle around centre', () => {
    const verts = hexPolygonVertices(0, 0);
    for (const v of verts) {
      const r2 = v.x * v.x + v.z * v.z;
      assert.ok(Math.abs(r2 - 1) < 1e-9, `vertex ${JSON.stringify(v)} not on unit circle (r²=${r2})`);
    }
  });
});

describe('Renderer3D — clipPolygonToRect', () => {
  test('a polygon fully inside the rectangle is returned unchanged', () => {
    const square = [
      { x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 },
    ];
    const rect = { minX: -1, maxX: 2, minZ: -1, maxZ: 2 };
    const clipped = clipPolygonToRect(square, rect);
    assert.equal(clipped.length, 4);
  });

  test('a polygon fully outside the rectangle clips to empty', () => {
    const square = [
      { x: 10, z: 10 }, { x: 11, z: 10 }, { x: 11, z: 11 }, { x: 10, z: 11 },
    ];
    const rect = { minX: -1, maxX: 1, minZ: -1, maxZ: 1 };
    const clipped = clipPolygonToRect(square, rect);
    assert.equal(clipped.length, 0);
  });

  test('clipping a hex straddling the top edge yields the bottom-half polygon', () => {
    // Hex centred at (0, -1.5) — vertex layout puts its bottom 3 vertices below
    // z=-1 (the clip line). Clipping at z >= -1 should leave a 3-vertex
    // downward triangle: lower-left (210°), bottom (270°), lower-right (330°).
    const hex = hexPolygonVertices(0, -1);
    // Hex at (0, -1) is offset by (SQRT3/2, -1.5) — its top three vertices
    // (30°, 90°, 150°) are above z=-1 (smaller z); bottom three are below.
    const rect = { minX: -10, maxX: 10, minZ: -1, maxZ: 10 };
    const clipped = clipPolygonToRect(hex, rect);
    assert.equal(clipped.length, 3, 'expected a triangular sliver');
    // All three vertices should be at z >= -1.
    for (const v of clipped) assert.ok(v.z >= -1 - 1e-9, `z=${v.z}`);
  });
});

describe('Renderer3D — polygonArea', () => {
  test('unit square has area 1', () => {
    const sq = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }, { x: 0, z: 1 }];
    assert.ok(Math.abs(polygonArea(sq) - 1) < 1e-9);
  });

  test('degenerate (collinear) polygon has zero area', () => {
    const line = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    assert.ok(polygonArea(line) < 1e-9);
  });

  test('hex polygon area is 1.5 * SQRT3 * radius² (≈2.598 at unit radius)', () => {
    const hex = hexPolygonVertices(0, 0);
    const expected = 1.5 * SQRT3; // standard pointy-top hex area at r=1
    assert.ok(Math.abs(polygonArea(hex) - expected) < 1e-9);
  });
});

describe('Renderer3D — borderWedgeSourceTile', () => {
  test('returns the first in-map neighbour found via odd-r deltas', () => {
    const tiles = buildTilesMap([[0, 0], [1, 0], [0, 1]]);
    // (1, 1) is off-map; its DIRS_ODD neighbours include (0, 1) which exists.
    const src = borderWedgeSourceTile(1, 1, tiles);
    assert.ok(src, 'expected a source tile');
    assert.ok(src.col >= 0 && src.row >= 0);
  });

  test('returns null when no neighbour is in-map', () => {
    const tiles = buildTilesMap([[0, 0]]);
    assert.equal(borderWedgeSourceTile(100, 100, tiles), null);
  });

  test('returns null for empty/null inputs', () => {
    assert.equal(borderWedgeSourceTile(0, 0, null), null);
    assert.equal(borderWedgeSourceTile(0, 0, new Map()), null);
  });

  test('terrain kind is correctly read from the chosen source tile', () => {
    const tiles = buildTilesMap(
      [[0, 0], [1, 0], [0, 1]],
      (c, r) => (c === 0 && r === 0) ? TileType.FOREST : TileType.GRASS,
    );
    // The off-map position (-1, 0) has (0, 0) as its first in-map neighbour
    // via DIRS_EVEN[3] = [1, 0]. Verify the source carries the FOREST kind.
    const src = borderWedgeSourceTile(-1, 0, tiles);
    assert.equal(src.type, TileType.FOREST);
  });
});

describe('Renderer3D — borderWedgePolygons (rectangular outline)', () => {
  test('empty/null map produces no wedges', () => {
    assert.deepEqual(borderWedgePolygons(null), []);
    assert.deepEqual(borderWedgePolygons(new Map()), []);
  });

  test('every wedge polygon vertex lies inside the playable map bounding rect', () => {
    const tiles = buildRectMap(5, 5);
    const rect = mapBoundingRect(tiles);
    const wedges = borderWedgePolygons(tiles);
    assert.ok(wedges.length > 0);
    for (const w of wedges) {
      for (const v of w.vertices) {
        assert.ok(v.x >= rect.minX - 1e-9, `wedge (${w.col},${w.row}) vertex x=${v.x} < minX=${rect.minX}`);
        assert.ok(v.x <= rect.maxX + 1e-9, `wedge (${w.col},${w.row}) vertex x=${v.x} > maxX=${rect.maxX}`);
        assert.ok(v.z >= rect.minZ - 1e-9, `wedge (${w.col},${w.row}) vertex z=${v.z} < minZ=${rect.minZ}`);
        assert.ok(v.z <= rect.maxZ + 1e-9, `wedge (${w.col},${w.row}) vertex z=${v.z} > maxZ=${rect.maxZ}`);
      }
    }
  });

  test('union of playable hexes + wedges reaches every corner of the rectangle', () => {
    // At least one wedge vertex must lie at each of the four corners (or
    // arbitrarily close). Without the corner wedges, the rectangular outline
    // collapses back to a zig-zag silhouette.
    const tiles = buildRectMap(5, 5);
    const rect = mapBoundingRect(tiles);
    const wedges = borderWedgePolygons(tiles);
    const allVerts = wedges.flatMap(w => w.vertices);
    // Playable hex corners reach minZ (top edge) and maxZ (bottom edge) at the
    // top-of-row-0 / bottom-of-row-4 vertices, but the LEFT edge corners
    // (minX, minZ) and (minX, maxZ) are only reachable via wedge geometry.
    const hasTopLeftCorner    = allVerts.some(v => Math.abs(v.x - rect.minX) < 1e-6 && Math.abs(v.z - rect.minZ) < 1e-6);
    const hasBottomLeftCorner = allVerts.some(v => Math.abs(v.x - rect.minX) < 1e-6 && Math.abs(v.z - rect.maxZ) < 1e-6);
    assert.ok(hasTopLeftCorner,    'top-left corner missing from wedge vertices');
    assert.ok(hasBottomLeftCorner, 'bottom-left corner missing from wedge vertices');
  });

  test('3×3 map produces the expected wedge composition', () => {
    // Top edge:    cols=3 downward-triangle slivers (col=0..2 at row=-1).
    // Bottom edge: cols=3 upward-triangle slivers (col=0..2 at row=3).
    // Left edge:   1 half-hex on odd row (row=1) + 2 corner quarters
    //              (at row=-1 and row=3).
    // Right edge:  2 half-hexes on even rows (row=0, row=2).
    // Total: 3 + 3 + 3 + 2 = 11 non-degenerate wedges.
    const tiles = buildRectMap(3, 3);
    const wedges = borderWedgePolygons(tiles);
    assert.equal(wedges.length, 11, `expected 11 wedges, got ${wedges.length}`);
  });

  test('wedges count scales with map size — 5×5 produces more wedges than 3×3', () => {
    const w3 = borderWedgePolygons(buildRectMap(3, 3));
    const w5 = borderWedgePolygons(buildRectMap(5, 5));
    assert.ok(w5.length > w3.length);
  });

  test('every wedge carries a non-null sourceTile from the playable map', () => {
    const tiles = buildRectMap(4, 4);
    const wedges = borderWedgePolygons(tiles);
    for (const w of wedges) {
      assert.ok(w.sourceTile, `wedge (${w.col},${w.row}) missing sourceTile`);
      assert.ok(tiles.has(hexKey(w.sourceTile.col, w.sourceTile.row)),
        `wedge sourceTile (${w.sourceTile.col},${w.sourceTile.row}) is not a playable tile`);
    }
  });

  test('wedges carry a polygon with at least 3 vertices and non-trivial area', () => {
    const tiles = buildRectMap(4, 4);
    const wedges = borderWedgePolygons(tiles);
    for (const w of wedges) {
      assert.ok(w.vertices.length >= 3, `wedge (${w.col},${w.row}) has ${w.vertices.length} verts`);
      assert.ok(polygonArea(w.vertices) > 1e-6, `wedge (${w.col},${w.row}) has near-zero area`);
    }
  });

  test('wedges do not overlap playable hex centres (they sit OUTSIDE the playable tiles)', () => {
    const tiles = buildRectMap(5, 5);
    const wedges = borderWedgePolygons(tiles);
    for (const w of wedges) {
      assert.ok(!tiles.has(hexKey(w.col, w.row)),
        `wedge at (${w.col},${w.row}) overlaps a playable tile`);
    }
  });
});

describe('Renderer3D — BORDER_WEDGE_Y', () => {
  test('sits at or just above the terrain disc so wedges read flush with terrain', () => {
    // Both must be positive (above the cylinder body) and the wedge must not
    // dip below the disc, or it z-fights from above and looks recessed.
    assert.ok(BORDER_WEDGE_Y > 0);
    assert.ok(BORDER_WEDGE_Y >= TERRAIN_DISC_Y_OFFSET - 1e-9,
      `wedge Y=${BORDER_WEDGE_Y} must be >= terrain disc Y=${TERRAIN_DISC_Y_OFFSET}`);
    // But the bump is tiny — sub-millimetre at the world's unit scale — so
    // the wedge doesn't visibly hover above the terrain.
    assert.ok(BORDER_WEDGE_Y - TERRAIN_DISC_Y_OFFSET < 0.01);
  });
});
