// Tests for the Item-2 bezier road/river network builders. These pure helpers
// take the state's tiles map (or a synthetic equivalent) and emit per-tile
// bezier strokes that the renderer turns into a single merged tube mesh per
// network. No Babylon dependency here — strokes are arrays of {x,z} samples.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TileType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';
import {
  sampleQuadBezier,
  networkStrokesForTile,
  buildRiverNetworkStrokes,
  buildRoadNetworkStrokes,
  RIVER_TUBE_RADIUS,
  ROAD_TUBE_RADIUS,
  RIVER_TUBE_Y,
  ROAD_TUBE_Y,
  NETWORK_BEZIER_SEGMENTS,
  hexToWorld,
} from '../src/renderer-3d.js';

describe('Item 2 — bezier visual constants', () => {
  test('river is wider than road (matches 2D path strokeWidth ratio)', () => {
    assert.ok(RIVER_TUBE_RADIUS > ROAD_TUBE_RADIUS,
      `river ${RIVER_TUBE_RADIUS} should exceed road ${ROAD_TUBE_RADIUS}`);
  });

  test('road sits slightly above the river so over-bridge crossings layer cleanly', () => {
    assert.ok(ROAD_TUBE_Y > RIVER_TUBE_Y,
      `road Y ${ROAD_TUBE_Y} should exceed river Y ${RIVER_TUBE_Y}`);
  });

  test('both tubes sit above the tile prism top (y=0.075)', () => {
    assert.ok(RIVER_TUBE_Y > 0.075);
    assert.ok(ROAD_TUBE_Y  > 0.075);
  });

  test('segment count is reasonable (smooth without ballooning the vertex budget)', () => {
    assert.ok(NETWORK_BEZIER_SEGMENTS >= 6 && NETWORK_BEZIER_SEGMENTS <= 32);
  });
});

describe('sampleQuadBezier', () => {
  test('returns segments+1 points', () => {
    const pts = sampleQuadBezier({ x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 0 }, 8);
    assert.equal(pts.length, 9);
  });

  test('starts at p0 and ends at p2', () => {
    const p0 = { x: 0, z: 0 }, p1 = { x: 1, z: 1 }, p2 = { x: 2, z: 0 };
    const pts = sampleQuadBezier(p0, p1, p2, 8);
    assert.ok(Math.abs(pts[0].x - p0.x) < 1e-9);
    assert.ok(Math.abs(pts[0].z - p0.z) < 1e-9);
    assert.ok(Math.abs(pts[pts.length - 1].x - p2.x) < 1e-9);
    assert.ok(Math.abs(pts[pts.length - 1].z - p2.z) < 1e-9);
  });

  test('midpoint sample matches the quadratic bezier formula', () => {
    const p0 = { x: 0, z: 0 }, p1 = { x: 2, z: 4 }, p2 = { x: 4, z: 0 };
    const pts = sampleQuadBezier(p0, p1, p2, 2);
    // t=0.5: B = 0.25*p0 + 0.5*p1 + 0.25*p2 = (2, 2)
    assert.ok(Math.abs(pts[1].x - 2) < 1e-9);
    assert.ok(Math.abs(pts[1].z - 2) < 1e-9);
  });
});

describe('networkStrokesForTile — per-tile geometry', () => {
  test('isolated tile (no neighbours) emits no strokes', () => {
    const strokes = networkStrokesForTile({ col: 0, row: 0 }, []);
    assert.deepEqual(strokes, []);
  });

  test('single-neighbour tile emits one through-bezier extending off-tile', () => {
    const strokes = networkStrokesForTile({ col: 0, row: 0 }, [{ col: 1, row: 0 }]);
    assert.equal(strokes.length, 1);
    assert.ok(strokes[0].length >= 3, 'expected ≥3 samples for a curve');
  });

  test('two-neighbour tile emits one smooth through-bezier between edges', () => {
    const strokes = networkStrokesForTile({ col: 1, row: 0 },
      [{ col: 0, row: 0 }, { col: 2, row: 0 }]);
    assert.equal(strokes.length, 1);
    const pts = strokes[0];
    // Symmetric pair → midpoint sits at the hex centre.
    const mid = pts[Math.floor(pts.length / 2)];
    const centre = hexToWorld(1, 0);
    assert.ok(Math.abs(mid.x - centre.x) < 1e-9);
    assert.ok(Math.abs(mid.z - centre.z) < 1e-9);
  });

  test('three-neighbour junction emits a through-bezier plus 1 spoke', () => {
    // Pick three neighbours; one pair is most-opposing, one is the branch.
    const strokes = networkStrokesForTile({ col: 1, row: 1 }, [
      { col: 0, row: 1 }, { col: 2, row: 1 }, // E + W: opposing
      { col: 1, row: 0 },                      // N branch
    ]);
    assert.equal(strokes.length, 2, 'expected through-bezier + 1 spoke');
    // The spoke is a 2-point line, the bezier is multi-sample.
    const byLen = [...strokes].sort((a, b) => a.length - b.length);
    assert.equal(byLen[0].length, 2);
    assert.ok(byLen[1].length > 2);
  });

  test('multi-neighbour through-bezier picks the most-opposing pair', () => {
    // Edges to E and W are diametrically opposed (dot = -1); the NE branch is
    // not in the through-bezier. Verify by checking which spoke is the short
    // 2-point segment.
    const strokes = networkStrokesForTile({ col: 2, row: 2 }, [
      { col: 1, row: 2 }, { col: 3, row: 2 }, // W + E
      { col: 2, row: 1 },                      // N
    ]);
    const spokes = strokes.filter(s => s.length === 2);
    assert.equal(spokes.length, 1);
    // The lone spoke goes from centre toward N — verify its second point's z
    // is north (smaller) of centre.
    const centre = hexToWorld(2, 2);
    const tip = spokes[0][1];
    assert.ok(tip.z < centre.z, `spoke tip z ${tip.z} should be north of centre ${centre.z}`);
  });

  test('sample points include the start and end edge midpoints (curve is on-edge)', () => {
    const strokes = networkStrokesForTile({ col: 0, row: 0 }, [
      { col: 1, row: 0 }, { col: -1, row: 0 },
    ]);
    const pts = strokes[0];
    const apo = Math.sqrt(3) / 2;
    // Curve starts at left-edge midpoint and ends at right-edge midpoint.
    const first = pts[0];
    const last  = pts[pts.length - 1];
    const leftMidX  = -apo, rightMidX = apo;
    const minX = Math.min(first.x, last.x);
    const maxX = Math.max(first.x, last.x);
    assert.ok(Math.abs(minX - leftMidX) < 1e-9);
    assert.ok(Math.abs(maxX - rightMidX) < 1e-9);
  });
});

describe('buildRiverNetworkStrokes', () => {
  /** Build a tiny tiles map: a 3-tile horizontal river through (0,1)→(1,1)→(2,1)
   *  with bridge in the middle, surrounded by grass. */
  function makeTiles() {
    const tiles = new Map();
    const add = (col, row, type) => {
      tiles.set(hexKey(col, row), { col, row, type, roadDirs: new Set() });
    };
    add(0, 1, TileType.RIVER);
    add(1, 1, TileType.BRIDGE);
    add(2, 1, TileType.RIVER);
    // Filler grass — never appears in the river network.
    for (let c = 0; c < 3; c++) {
      add(c, 0, TileType.GRASS);
      add(c, 2, TileType.GRASS);
    }
    return tiles;
  }

  test('emits one segment per RIVER+BRIDGE tile that has a water neighbour', () => {
    const segs = buildRiverNetworkStrokes(makeTiles());
    assert.equal(segs.length, 3, 'three water tiles, all have neighbours');
    for (const s of segs) {
      assert.ok(Array.isArray(s.strokes));
      assert.ok(s.strokes.length >= 1);
    }
  });

  test('isolated water tile (no water neighbours) is skipped', () => {
    const tiles = new Map();
    tiles.set(hexKey(5, 5),
      { col: 5, row: 5, type: TileType.RIVER, roadDirs: new Set() });
    assert.equal(buildRiverNetworkStrokes(tiles).length, 0);
  });

  test('grass tiles are not part of the river network', () => {
    const tiles = new Map();
    tiles.set(hexKey(0, 0),
      { col: 0, row: 0, type: TileType.GRASS, roadDirs: new Set() });
    assert.equal(buildRiverNetworkStrokes(tiles).length, 0);
  });
});

describe('buildRoadNetworkStrokes', () => {
  /** 3 road tiles in a row, using roadDirs to declare connectivity. */
  function makeTiles() {
    const tiles = new Map();
    const add = (col, row, type, roadDirs = []) => {
      tiles.set(hexKey(col, row),
        { col, row, type, roadDirs: new Set(roadDirs) });
    };
    add(0, 1, TileType.ROAD, [hexKey(1, 1)]);
    add(1, 1, TileType.ROAD, [hexKey(0, 1), hexKey(2, 1)]);
    add(2, 1, TileType.ROAD, [hexKey(1, 1)]);
    return tiles;
  }

  test('emits one segment per ROAD tile with a recorded roadDir', () => {
    const segs = buildRoadNetworkStrokes(makeTiles());
    assert.equal(segs.length, 3);
  });

  test('tiles without roadDirs are skipped (no phantom junctions)', () => {
    const tiles = new Map();
    tiles.set(hexKey(0, 0),
      { col: 0, row: 0, type: TileType.ROAD, roadDirs: new Set() });
    assert.equal(buildRoadNetworkStrokes(tiles).length, 0);
  });

  test('BRIDGE tiles with roadDirs participate in the road network', () => {
    const tiles = new Map();
    tiles.set(hexKey(0, 0),
      { col: 0, row: 0, type: TileType.ROAD, roadDirs: new Set([hexKey(1, 0)]) });
    tiles.set(hexKey(1, 0),
      { col: 1, row: 0, type: TileType.BRIDGE, roadDirs: new Set([hexKey(0, 0), hexKey(2, 0)]) });
    tiles.set(hexKey(2, 0),
      { col: 2, row: 0, type: TileType.ROAD, roadDirs: new Set([hexKey(1, 0)]) });
    const segs = buildRoadNetworkStrokes(tiles);
    assert.equal(segs.length, 3);
    // The bridge segment should contribute one through-bezier
    const bridge = segs.find(s => s.tile.row === 0 && s.tile.col === 1);
    assert.ok(bridge && bridge.strokes.length === 1);
  });

  test('null or empty tiles input returns []', () => {
    assert.deepEqual(buildRoadNetworkStrokes(null), []);
    assert.deepEqual(buildRoadNetworkStrokes(new Map()), []);
  });
});
