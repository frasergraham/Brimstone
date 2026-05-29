// Tests for the shared MST road-network builder (src/road-network.js).
// Covers: Kruskal MST edge count/connectivity, symmetric roadDirs, bridges only
//         over river tiles, the maxBridges cap, and roadTiles bookkeeping.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMST, placeRoadPath, buildRoadNetwork } from '../src/road-network.js';
import { TileType, Tile, PathType, StructureType, baseOf, pathOf, hasBuilding, legacyTileType, decomposeTileType } from '../src/tiles.js';
import { hexKey, setMapDimensions } from '../src/hex.js';

// Build a flat all-grass grid of the given size.
function gridTiles(cols, rows) {
  setMapDimensions(cols, rows);
  const tiles = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.set(hexKey(col, row), new Tile(col, row, TileType.GRASS));
    }
  }
  return tiles;
}

function tilesOfType(tiles, type) {
  const out = [];
  for (const t of tiles.values()) if (legacyTileType(t) === type) out.push(t);
  return out;
}

// ── buildMST ─────────────────────────────────────────────────────────────────

describe('buildMST', () => {
  test('returns n-1 edges for n nodes', () => {
    const nodes = [
      { col: 0, row: 0 }, { col: 4, row: 0 },
      { col: 0, row: 4 }, { col: 4, row: 4 },
    ];
    assert.equal(buildMST(nodes).length, nodes.length - 1);
  });

  test('empty for fewer than 2 nodes', () => {
    assert.deepEqual(buildMST([]), []);
    assert.deepEqual(buildMST([{ col: 1, row: 1 }]), []);
  });

  test('spanning tree connects every node', () => {
    const nodes = [
      { col: 0, row: 0 }, { col: 8, row: 1 }, { col: 3, row: 6 },
      { col: 7, row: 7 }, { col: 1, row: 4 },
    ];
    const edges = buildMST(nodes);
    const idx = new Map(nodes.map((n, i) => [n, i]));
    const parent = nodes.map((_, i) => i);
    const find = i => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (const { from, to } of edges) parent[find(idx.get(from))] = find(idx.get(to));
    const root = find(0);
    for (let i = 1; i < nodes.length; i++) {
      assert.equal(find(i), root, `node ${i} not connected to the tree`);
    }
  });

  test('edges reference the original node objects', () => {
    const nodes = [{ col: 0, row: 0 }, { col: 3, row: 3 }];
    const [edge] = buildMST(nodes);
    assert.ok(nodes.includes(edge.from) && nodes.includes(edge.to));
  });
});

// ── placeRoadPath ──────────────────────────────────────────────────────────

describe('placeRoadPath', () => {
  test('converts grass/dirt/forest tiles to ROAD and records them', () => {
    const tiles = gridTiles(5, 1);
    decomposeTileType(tiles.get(hexKey(1, 0)), TileType.DIRT);
    decomposeTileType(tiles.get(hexKey(2, 0)), TileType.FOREST);
    const path = [
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 },
    ];
    const roadTiles = new Set();
    placeRoadPath(tiles, path, roadTiles);
    for (const p of path) {
      assert.equal(legacyTileType(tiles.get(hexKey(p.col, p.row))), TileType.ROAD);
      assert.ok(roadTiles.has(hexKey(p.col, p.row)));
    }
  });

  test('roadDirs are symmetric between consecutive path tiles', () => {
    const tiles = gridTiles(5, 1);
    const path = [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }];
    placeRoadPath(tiles, path, new Set());
    for (let i = 1; i < path.length; i++) {
      const a = tiles.get(hexKey(path[i - 1].col, path[i - 1].row));
      const b = tiles.get(hexKey(path[i].col, path[i].row));
      assert.ok(a.roadDirs.has(hexKey(b.col, b.row)), 'forward link missing');
      assert.ok(b.roadDirs.has(hexKey(a.col, a.row)), 'reverse link missing');
    }
  });

  test('bridges are only placed over RIVER tiles, never plain terrain', () => {
    const tiles = gridTiles(5, 1);
    decomposeTileType(tiles.get(hexKey(2, 0)), TileType.RIVER);
    const path = [
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 },
    ];
    const placed = placeRoadPath(tiles, path, new Set(), { convertRiverToBridge: true, maxBridges: 2 });
    assert.equal(placed, 1);
    const bridges = tilesOfType(tiles, TileType.BRIDGE);
    assert.equal(bridges.length, 1);
    assert.equal(bridges[0].col, 2);
    // Every bridge sits on a former river tile — no land tile became a bridge.
    for (const b of bridges) {
      assert.notEqual(legacyTileType(b), TileType.ROAD);
    }
  });

  test('maxBridges cap stops further river-to-bridge conversion', () => {
    const tiles = gridTiles(6, 1);
    decomposeTileType(tiles.get(hexKey(2, 0)), TileType.RIVER);
    decomposeTileType(tiles.get(hexKey(4, 0)), TileType.RIVER);
    const path = [
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 },
      { col: 3, row: 0 }, { col: 4, row: 0 }, { col: 5, row: 0 },
    ];
    const placed = placeRoadPath(tiles, path, new Set(), { convertRiverToBridge: true, maxBridges: 1 });
    assert.equal(placed, 1);
    assert.equal(tilesOfType(tiles, TileType.BRIDGE).length, 1);
    // The second river crossing stays a RIVER (budget exhausted).
    assert.equal(legacyTileType(tiles.get(hexKey(4, 0))), TileType.RIVER);
  });

  test('pre-placed BRIDGE mode records the bridge without converting rivers', () => {
    const tiles = gridTiles(5, 1);
    decomposeTileType(tiles.get(hexKey(2, 0)), TileType.BRIDGE);
    const path = [
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }, { col: 3, row: 0 },
    ];
    const roadTiles = new Set();
    const placed = placeRoadPath(tiles, path, roadTiles, { convertRiverToBridge: false });
    assert.equal(placed, 0);
    assert.equal(legacyTileType(tiles.get(hexKey(2, 0))), TileType.BRIDGE);
    assert.ok(roadTiles.has(hexKey(2, 0)), 'pre-placed bridge should join the road grid');
  });
});

// ── placeRoadPath: layer preservation (P2 of the tile-model refactor) ────────
// The road/bridge is a PATH overlay laid on top of the base material — laying a
// road must NOT clobber the underlying base (e.g. forest cover survives roads),
// and a building tile records road-through via roadDirs only, never `path`.

describe('placeRoadPath — layer preservation', () => {
  test('road over forest keeps base=forest, path=road', () => {
    const tiles = gridTiles(4, 1);
    const forest = tiles.get(hexKey(1, 0));
    forest.base = TileType.FOREST; // force a forest base under the road
    const path = [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }];
    placeRoadPath(tiles, path, new Set());
    // Derived legacy type still reports ROAD (back-compat) …
    assert.equal(legacyTileType(forest), TileType.ROAD);
    // … but the explicit layers preserve the forest base under the road.
    assert.equal(baseOf(forest), TileType.FOREST);
    assert.equal(pathOf(forest), PathType.ROAD);
  });

  test('road over dirt keeps base=dirt, path=road', () => {
    const tiles = gridTiles(4, 1);
    const dirt = tiles.get(hexKey(1, 0));
    dirt.base = TileType.DIRT;
    placeRoadPath(tiles, [{ col: 0, row: 0 }, { col: 1, row: 0 }], new Set());
    assert.equal(legacyTileType(dirt), TileType.ROAD);
    assert.equal(baseOf(dirt), TileType.DIRT);
    assert.equal(pathOf(dirt), PathType.ROAD);
  });

  test('bridge over river preserves the base under the water', () => {
    const tiles = gridTiles(4, 1);
    const river = tiles.get(hexKey(1, 0));
    river.path = PathType.RIVER; // river path over a grass base
    const placed = placeRoadPath(tiles, [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }],
      new Set(), { convertRiverToBridge: true, maxBridges: 1 });
    assert.equal(placed, 1);
    assert.equal(legacyTileType(river), TileType.BRIDGE);
    assert.equal(pathOf(river), PathType.BRIDGE);
    assert.equal(baseOf(river), TileType.GRASS); // base under the water intact
  });

  test('building tile gets roadDirs but never a path layer', () => {
    const tiles = gridTiles(4, 1);
    const bldg = tiles.get(hexKey(1, 0));
    bldg.structure = StructureType.BUILDING; // a building sitting on the road MST
    const path = [{ col: 0, row: 0 }, { col: 1, row: 0 }, { col: 2, row: 0 }];
    placeRoadPath(tiles, path, new Set());
    // The building still reports BUILDING (path never set on it) …
    assert.equal(legacyTileType(bldg), TileType.BUILDING);
    assert.equal(pathOf(bldg), null, 'building must not gain a path layer');
    assert.ok(hasBuilding(bldg));
    // … but road-through is recorded via symmetric roadDirs to both neighbours.
    assert.ok(bldg.roadDirs.has(hexKey(0, 0)));
    assert.ok(bldg.roadDirs.has(hexKey(2, 0)));
  });
});

// ── buildRoadNetwork (campaign composition) ──────────────────────────────────

describe('buildRoadNetwork', () => {
  test('no bridges and no roads with fewer than 2 nodes', () => {
    const tiles = gridTiles(5, 5);
    assert.equal(buildRoadNetwork(tiles, [{ col: 1, row: 1 }], () => 0.5, 2), 0);
    assert.equal(tilesOfType(tiles, TileType.ROAD).length, 0);
  });

  test('connects buildings and lays a contiguous road graph', () => {
    const tiles = gridTiles(9, 9);
    const nodes = [
      { col: 1, row: 1 }, { col: 7, row: 1 }, { col: 1, row: 7 }, { col: 7, row: 7 },
    ];
    // Mark the node tiles as buildings (as the real maps do).
    for (const n of nodes) {
      const t = tiles.get(hexKey(n.col, n.row));
      decomposeTileType(t, TileType.BUILDING);
    }
    const rand = () => 0.5;
    buildRoadNetwork(tiles, nodes, rand, 2);
    // Roads were laid between the buildings.
    assert.ok(tilesOfType(tiles, TileType.ROAD).length > 0);
    // Every road tile's roadDirs are symmetric.
    for (const t of tiles.values()) {
      for (const k of t.roadDirs) {
        assert.ok(tiles.get(k).roadDirs.has(hexKey(t.col, t.row)),
          `roadDirs asymmetry: ${hexKey(t.col, t.row)} → ${k}`);
      }
    }
  });

  test('places bridges only over river tiles, within the cap', () => {
    const tiles = gridTiles(9, 9);
    // A vertical river down column 4.
    for (let row = 0; row < 9; row++) decomposeTileType(tiles.get(hexKey(4, row)), TileType.RIVER);
    const nodes = [{ col: 1, row: 4 }, { col: 7, row: 4 }];
    const rand = () => 0.5;
    const bridges = buildRoadNetwork(tiles, nodes, rand, 2);
    assert.ok(bridges >= 1 && bridges <= 2, `expected 1-2 bridges, got ${bridges}`);
    // Each bridge tile must lie on the former river column.
    for (const b of tilesOfType(tiles, TileType.BRIDGE)) {
      assert.equal(b.col, 4, `bridge at (${b.col},${b.row}) is not on the river`);
    }
  });
});
