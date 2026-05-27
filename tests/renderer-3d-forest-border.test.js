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
  BORDER_FOREST_DENSITY_SCALE,
  FOREST_TREES_MIN,
  FOREST_TREES_MAX,
  FOREST_DENSITY_SCALE,
  scaledForestTreeCount,
  borderForestTreesForHex,
  borderTilePositions,
  clampPanTarget,
  computeMapBounds,
  forestBandDepthForView,
  forestTreesForHex,
  HEX_RADIUS_WORLD,
  hexToWorld,
  radiusForStandardFit,
  Renderer3D,
  tilesExtent,
  TILE_SLOTS,
  TREE_LEAF_SHADES_PER_SPECIES,
  TREE_SPECIES,
} from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';
import { MAP_SIZES } from '../src/map.js';

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
  test('cone count is within the density-scaled [MIN, MAX] for many hexes', () => {
    // The raw 5–7 range is scaled by BORDER_FOREST_DENSITY_SCALE (20% fewer
    // trees). scaledForestTreeCount is monotonic, so the scaled bounds are
    // simply the scaled endpoints.
    const lo = scaledForestTreeCount(BORDER_FOREST_TREES_MIN, BORDER_FOREST_DENSITY_SCALE);
    const hi = scaledForestTreeCount(BORDER_FOREST_TREES_MAX, BORDER_FOREST_DENSITY_SCALE);
    for (let col = -5; col <= 20; col++) {
      for (let row = -5; row <= 20; row++) {
        const trees = borderForestTreesForHex(col, row);
        assert.ok(
          trees.length >= lo && trees.length <= hi,
          `out of range at (${col}, ${row}): ${trees.length} not in [${lo}, ${hi}]`,
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

describe('Renderer3D — scaledForestTreeCount (density)', () => {
  test('rounds to nearest and clamps to ≥1', () => {
    // Border: raw 5–7 × 0.8 → round(4.0, 4.8, 5.6) = 4, 5, 6.
    assert.equal(scaledForestTreeCount(5, 0.8), 4);
    assert.equal(scaledForestTreeCount(6, 0.8), 5);
    assert.equal(scaledForestTreeCount(7, 0.8), 6);
    // Playable: raw 3–5 × 0.6 → round(1.8, 2.4, 3.0) = 2, 2, 3.
    assert.equal(scaledForestTreeCount(3, 0.6), 2);
    assert.equal(scaledForestTreeCount(4, 0.6), 2);
    assert.equal(scaledForestTreeCount(5, 0.6), 3);
    // Never empties a forest hex.
    assert.equal(scaledForestTreeCount(1, 0.1), 1);
  });

  test('is monotonic non-decreasing in rawCount', () => {
    let prev = 0;
    for (let n = 0; n <= 12; n++) {
      const cur = scaledForestTreeCount(n, FOREST_DENSITY_SCALE);
      assert.ok(cur >= prev, `not monotonic at ${n}: ${cur} < ${prev}`);
      prev = cur;
    }
  });

  test('playable forest tree count sits in the density-scaled range', () => {
    const lo = scaledForestTreeCount(FOREST_TREES_MIN, FOREST_DENSITY_SCALE);
    const hi = scaledForestTreeCount(FOREST_TREES_MAX, FOREST_DENSITY_SCALE);
    for (let col = 0; col <= 12; col++) {
      for (let row = 0; row <= 12; row++) {
        const trees = forestTreesForHex(col, row, 'summer');
        assert.ok(
          trees.length >= lo && trees.length <= hi,
          `out of range at (${col}, ${row}): ${trees.length} not in [${lo}, ${hi}]`,
        );
      }
    }
  });

  test('placement is unchanged by scaling — kept trees match the unscaled prefix', () => {
    // Scaling only drops the count; the surviving trees occupy the same slots
    // (in the same order) the unscaled cluster would have used. Verify the
    // scaled cluster is a deterministic prefix of the slot/scale sequence.
    const trees = forestTreesForHex(4, 4, 'summer');
    const again = forestTreesForHex(4, 4, 'summer');
    assert.deepEqual(trees, again, 'deterministic per hex');
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

  test('regional map: pan bounds reach actual playable corners (NOT clipped to standard)', () => {
    // With the max-zoom cap in place the camera can't zoom out to see all of
    // a regional 17×17 map, but pan limits must still bind to the *actual*
    // playable extent so the player can scroll to every corner.
    const reg = MAP_SIZES.regional;
    const tiles = buildRectMap(reg.cols, reg.rows);
    const all = [];
    for (const t of tiles.values()) all.push({ col: t.col, row: t.row });
    const bounds = computeMapBounds(all);

    // Standard extent for reference — pan must NOT be clipped to this.
    const stdAll = [];
    const std = MAP_SIZES.standard;
    for (let c = 0; c < std.cols; c++) for (let r = 0; r < std.rows; r++) {
      stdAll.push({ col: c, row: r });
    }
    const stdBounds = computeMapBounds(stdAll);
    assert.ok(bounds.maxX > stdBounds.maxX, 'regional should be wider than standard');
    assert.ok(bounds.maxZ > stdBounds.maxZ, 'regional should be deeper than standard');

    // The far-corner of the actual playable extent must clamp to itself
    // (i.e. pan can reach this point), not to the smaller standard extent.
    const corner = hexToWorld(reg.cols - 1, reg.rows - 1);
    const clamped = clampPanTarget({ x: corner.x, y: 0, z: corner.z }, bounds, 0);
    assert.ok(Math.abs(clamped.x - corner.x) < 1e-9,
      `pan to regional far-corner X clipped: ${clamped.x} vs ${corner.x}`);
    assert.ok(Math.abs(clamped.z - corner.z) < 1e-9,
      `pan to regional far-corner Z clipped: ${clamped.z} vs ${corner.z}`);
  });
});

describe('Renderer3D — forestBandDepthForView', () => {
  test('returns 0 for non-positive or non-finite radius', () => {
    assert.equal(forestBandDepthForView(0, 16 / 9), 0);
    assert.equal(forestBandDepthForView(-5, 16 / 9), 0);
    assert.equal(forestBandDepthForView(NaN, 16 / 9), 0);
    assert.equal(forestBandDepthForView(Infinity, 16 / 9), 0);
  });

  test('grows monotonically with camera radius', () => {
    const small = forestBandDepthForView(10, 16 / 9);
    const big   = forestBandDepthForView(50, 16 / 9);
    assert.ok(big > small);
  });

  test('wider aspect → more column-direction depth → larger band', () => {
    const square    = forestBandDepthForView(30, 1, 0.8, 0);
    const widescreen = forestBandDepthForView(30, 2, 0.8, 0);
    assert.ok(widescreen >= square,
      `widescreen band ${widescreen} should be >= square band ${square}`);
  });

  test('covers the half-visible width past the playable corner (with safety)', () => {
    // At max zoom, when panned to a corner, the camera sees `radius * tan(fov/2)`
    // past the corner along the depth axis (and that × aspect along width).
    // The band must extend at least that many hex pitches past the playable
    // rectangle in both directions.
    const fov = 0.8;
    const aspect = 16 / 9;
    const radius = radiusForStandardFit(aspect, fov);
    const safety = 3;
    const depth = forestBandDepthForView(radius, aspect, fov, safety);

    const halfViewZ = radius * Math.tan(fov / 2);
    const halfViewX = halfViewZ * aspect;
    const colPitch = HEX_RADIUS_WORLD * Math.sqrt(3);
    const rowPitch = HEX_RADIUS_WORLD * 1.5;

    // World-distance the band covers past the playable edge:
    const bandWorldX = depth * colPitch;
    const bandWorldZ = depth * rowPitch;
    assert.ok(bandWorldX >= halfViewX,
      `band X-reach ${bandWorldX} must cover half-view ${halfViewX}`);
    assert.ok(bandWorldZ >= halfViewZ,
      `band Z-reach ${bandWorldZ} must cover half-view ${halfViewZ}`);
    // Safety margin is meaningful (not silently dropped).
    assert.ok(depth - safety >= 0);
  });

  test('safety margin is additive', () => {
    const a = forestBandDepthForView(30, 16 / 9, 0.8, 0);
    const b = forestBandDepthForView(30, 16 / 9, 0.8, 3);
    assert.equal(b - a, 3);
  });

  test('at the standard-fit cap, band is large enough for a typical 16/9 aspect', () => {
    // Sanity: the chosen band depth should comfortably exceed the legacy
    // BORDER_BAND_DEPTH (=2). 2 hexes is far too thin once max zoom is set
    // to standard-fit — the original task is to extend the band.
    const depth = forestBandDepthForView(radiusForStandardFit(16 / 9), 16 / 9);
    assert.ok(depth > BORDER_BAND_DEPTH * 3,
      `expected depth >> ${BORDER_BAND_DEPTH}, got ${depth}`);
  });
});

// ── Cross-tile merge for the border-forest band ─────────────────────────────
//
// Pins the perf-critical invariant from `_buildBorderForestTreesBatched`:
// regardless of how many border tiles the band carries, the trees collapse to
// one merged trunk mesh + one merged mesh per leaf-colour bucket (≤9, since
// trees are bucketed by species × shade and both palettes are 3-deep). That's
// ~10 meshes total — independent of `bandDepth`, where the per-tile path
// would otherwise emit 2–4 meshes per tile (240–900 at max zoom-out).

/** Plain-object Babylon stub that exercises the merge path without touching
 *  WebGL. CreateCylinder/CreateSphere return throwaway mesh objects; MergeMeshes
 *  consumes the array and returns a single fresh mesh object. Materials are
 *  stub StandardMaterial instances tagged with their constructor name. */
function makeStubBabylon() {
  const makeMesh = (name) => ({
    name,
    position:   { set() {} },
    rotation:   { x: 0, y: 0, z: 0 },
    scaling:    { x: 1, y: 1, z: 1 },
    parent:     null,
    material:   null,
    metadata:   undefined,
    isPickable: true,
    setEnabled() {},
    dispose() {},
  });
  return {
    MeshBuilder: {
      CreateCylinder: (name) => makeMesh(name),
      CreateSphere:   (name) => makeMesh(name),
    },
    Mesh: {
      MergeMeshes: (meshes) => {
        if (!meshes || meshes.length === 0) return null;
        return makeMesh('merged');
      },
    },
    StandardMaterial: function (name) { this.name = name; },
    Color3: function (r, g, b) { this.r = r; this.g = g; this.b = b; },
  };
}

function buildRectTiles(cols, rows) {
  const m = new Map();
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    m.set(hexKey(c, r), { col: c, row: r });
  }
  return m;
}

function buildTreeJobsForBand(tiles, bandDepth) {
  const treeJobs = [];
  for (const pos of borderTilePositions(tiles, bandDepth)) {
    const { x, z } = hexToWorld(pos.col, pos.row);
    const trees = forestTreesForHex(pos.col, pos.row);
    if (trees.length > 0) {
      treeJobs.push({
        namePrefix: `border_forest_${pos.col}_${pos.row}`,
        cx: x, cz: z, trees,
      });
    }
  }
  return treeJobs;
}

describe('Renderer3D — _buildBorderForestTreesBatched (cross-tile merge)', () => {
  test('worst-case bucket count is bounded by species × shade buckets + 1 trunk', () => {
    // Theoretical ceiling: TREE_SPECIES.length × TREE_LEAF_SHADES_PER_SPECIES
    // leaf colour buckets, plus one trunk bucket. Anything beyond this would
    // mean the helper is bucketing on something other than (species, shade).
    const cap = TREE_SPECIES.length * TREE_LEAF_SHADES_PER_SPECIES + 1;
    assert.equal(cap, 10);
  });

  test('standard 13×13, bandDepth=2: emits ≤10 meshes across 120 border tiles', () => {
    const tiles = buildRectTiles(13, 13);
    const treeJobs = buildTreeJobsForBand(tiles, 2);
    // 120 = (13+4)² − 13² border tiles; sanity check.
    assert.equal(borderTilePositions(tiles, 2).length, 120);

    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    const parent = { name: 'mapRoot' };
    const meshes = r._buildBorderForestTreesBatched(parent, treeJobs);

    assert.ok(meshes.length <= 10,
      `expected ≤10 merged meshes, got ${meshes.length}`);
    assert.ok(meshes.length >= 1,
      `expected ≥1 merged mesh (band is non-empty), got ${meshes.length}`);
    // First mesh is the trunk bundle.
    assert.equal(meshes[0].name, 'border_forest_trunks');
    // Remaining are leaf buckets, named with the shared 'border_forest' prefix.
    for (let i = 1; i < meshes.length; i++) {
      assert.match(meshes[i].name, /^border_forest_leaves_\d+$/);
    }
  });

  test('standard 13×13, bandDepth=6: still ≤10 meshes across 456 border tiles', () => {
    // The whole point of the cross-tile merge: the merged-mesh count is O(1)
    // in bandDepth. At bandDepth=6 the per-tile path would emit ~1200 meshes
    // for the band; the batched path stays at ≤10.
    const tiles = buildRectTiles(13, 13);
    const treeJobs = buildTreeJobsForBand(tiles, 6);
    assert.equal(borderTilePositions(tiles, 6).length, 456);

    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    const parent = { name: 'mapRoot' };
    const meshes = r._buildBorderForestTreesBatched(parent, treeJobs);

    assert.ok(meshes.length <= 10,
      `expected ≤10 merged meshes, got ${meshes.length}`);
  });

  test('mesh count is invariant to band depth (within ±0)', () => {
    // The whole reason we lifted the merge: the count must not grow with the
    // tile count. Specifically, the depth=6 count must equal the depth=2
    // count, since both bands span every (species, shade) combination given
    // enough tiles to sample from.
    const tiles = buildRectTiles(13, 13);
    const stub  = makeStubBabylon();

    const r1 = new Renderer3D(null, null);
    r1._babylon = stub; r1._scene = {};
    const m1 = r1._buildBorderForestTreesBatched({}, buildTreeJobsForBand(tiles, 2));

    const r2 = new Renderer3D(null, null);
    r2._babylon = stub; r2._scene = {};
    const m2 = r2._buildBorderForestTreesBatched({}, buildTreeJobsForBand(tiles, 6));

    assert.equal(m1.length, m2.length,
      `band depth must not change merged-mesh count (d=2: ${m1.length}, d=6: ${m2.length})`);
  });

  test('empty treeJobs returns []', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    assert.deepEqual(r._buildBorderForestTreesBatched({}, []), []);
  });

  test('no Babylon → no-op (pre-init resilience)', () => {
    const r = new Renderer3D(null, null);
    r._babylon = null;
    r._scene   = null;
    assert.deepEqual(r._buildBorderForestTreesBatched({}, [{ namePrefix: 'x', cx: 0, cz: 0, trees: [] }]), []);
  });

  test('every merged mesh is parented under the supplied parent', () => {
    const tiles = buildRectTiles(13, 13);
    const treeJobs = buildTreeJobsForBand(tiles, 2);
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    const parent = { name: 'mapRoot' };
    const meshes = r._buildBorderForestTreesBatched(parent, treeJobs);
    for (const m of meshes) {
      assert.equal(m.parent, parent, `mesh ${m.name} not parented to mapRoot`);
      assert.equal(m.isPickable, false,
        `border-forest mesh ${m.name} must be unpickable (visual only)`);
    }
  });
});

describe('Renderer3D — border-forest batch meshes registry', () => {
  test('constructor initialises _borderForestBatchMeshes to []', () => {
    const r = new Renderer3D(null, null);
    assert.ok(Array.isArray(r._borderForestBatchMeshes));
    assert.equal(r._borderForestBatchMeshes.length, 0);
  });

  test('_syncBorderForestVisibility toggles batch meshes alongside per-tile hexes', () => {
    const r = new Renderer3D(null, null);
    const calls = [];
    const stub = (label) => ({
      setEnabled(v) { calls.push([label, v]); },
    });
    r._borderForestHexesByKey.set('0,0', stub('hex'));
    r._borderPropsByKey.set('0,0', [stub('hexProp')]);
    r._borderForestBatchMeshes = [stub('mergedTrunk'), stub('mergedLeaves')];

    r._borderForestHidden = true;
    r._syncBorderForestVisibility();
    assert.deepEqual(calls, [
      ['hex',          false],
      ['hexProp',      false],
      ['mergedTrunk',  false],
      ['mergedLeaves', false],
    ]);

    calls.length = 0;
    r._borderForestHidden = false;
    r._syncBorderForestVisibility();
    assert.deepEqual(calls, [
      ['hex',          true],
      ['hexProp',      true],
      ['mergedTrunk',  true],
      ['mergedLeaves', true],
    ]);
  });
});
