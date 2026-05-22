// Pure-helper tests for the 3D renderer's map edge frame (see "Map edge frame"
// banner in src/renderer-3d.js). The renderer itself needs Babylon + a GL
// context node-test can't provide, but the perimeter detection and
// off-map-position enumeration are pure functions of `state.tiles`.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EDGE_FRAME_COLOR,
  EDGE_FRAME_HEIGHT,
  EDGE_FRAME_Y,
  edgeFramePositions,
  missingNeighborDirs,
  perimeterTiles,
} from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';

// Build a Map<"col,row", tile> matching the shape `state.tiles` uses. Tiles
// only need a `col` and `row` field for the pure helpers; type/building are
// irrelevant here.
function buildTilesMap(positions) {
  const m = new Map();
  for (const [col, row] of positions) m.set(hexKey(col, row), { col, row });
  return m;
}

describe('Renderer3D — missingNeighborDirs', () => {
  test('a tile with all 6 neighbours in the map has no missing dirs', () => {
    // Centre tile at (1, 1) surrounded by neighbours via odd-r offset deltas.
    const tiles = buildTilesMap([
      [1, 1],
      // Row 1 is odd → DIRS_ODD = [[-1,0],[0,-1],[1,-1],[1,0],[1,1],[0,1]]
      [0, 1], [1, 0], [2, 0], [2, 1], [2, 2], [1, 2],
    ]);
    const tile = tiles.get(hexKey(1, 1));
    assert.deepEqual(missingNeighborDirs(tile, tiles), []);
  });

  test('an isolated tile has all 6 dirs missing', () => {
    const tiles = buildTilesMap([[5, 5]]);
    const tile = tiles.get(hexKey(5, 5));
    assert.deepEqual(missingNeighborDirs(tile, tiles), [0, 1, 2, 3, 4, 5]);
  });

  test('a tile on the west edge of a 3-wide row is missing dir 0 (west)', () => {
    // Row 0 is even; DIRS_EVEN[0] = [-1, 0] → west neighbour.
    const tiles = buildTilesMap([[0, 0], [1, 0], [2, 0]]);
    const west = tiles.get(hexKey(0, 0));
    const missing = missingNeighborDirs(west, tiles);
    assert.ok(missing.includes(0), `expected dir 0 (west) missing, got [${missing}]`);
  });

  test('null tile or tilesMap returns empty', () => {
    assert.deepEqual(missingNeighborDirs(null, new Map()), []);
    assert.deepEqual(missingNeighborDirs({ col: 0, row: 0 }, null), []);
  });
});

describe('Renderer3D — perimeterTiles', () => {
  test('every tile in a 3×3 block (except the centre) is on the perimeter', () => {
    const positions = [];
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) positions.push([c, r]);
    const tiles = buildTilesMap(positions);
    const perim = perimeterTiles(tiles);
    // 8 perimeter cells, 1 interior cell.
    assert.equal(perim.length, 8);
    const perimKeys = new Set(perim.map(t => hexKey(t.col, t.row)));
    assert.ok(!perimKeys.has(hexKey(1, 1)), 'centre tile must not be on the perimeter');
  });

  test('every perimeter entry reports at least one missing direction', () => {
    const tiles = buildTilesMap([[0, 0], [1, 0], [0, 1]]);
    for (const t of perimeterTiles(tiles)) {
      assert.ok(t.missing.length > 0, `tile (${t.col},${t.row}) should have a missing dir`);
    }
  });

  test('a single isolated tile is its own perimeter with 6 missing dirs', () => {
    const tiles = buildTilesMap([[2, 2]]);
    const perim = perimeterTiles(tiles);
    assert.equal(perim.length, 1);
    assert.equal(perim[0].missing.length, 6);
  });

  test('null tilesMap returns empty', () => {
    assert.deepEqual(perimeterTiles(null), []);
  });
});

describe('Renderer3D — edgeFramePositions', () => {
  test('dedupes shared missing-neighbour positions between perimeter tiles', () => {
    // Two adjacent tiles (5,5) and (7,5) on row 5. Both surround the gap at
    // (6,5). The gap should appear once in the result, not twice.
    const tiles = buildTilesMap([[5, 5], [7, 5]]);
    const positions = edgeFramePositions(tiles);
    const gapKey = hexKey(6, 5);
    const matching = positions.filter(p => hexKey(p.col, p.row) === gapKey);
    assert.equal(matching.length, 1, 'shared gap (6,5) should appear exactly once');
  });

  test('a single tile produces 6 edge-frame positions (one per direction)', () => {
    const tiles = buildTilesMap([[3, 4]]);
    const positions = edgeFramePositions(tiles);
    assert.equal(positions.length, 6);
    const uniq = new Set(positions.map(p => hexKey(p.col, p.row)));
    assert.equal(uniq.size, 6, 'all 6 positions must be unique');
  });

  test('no edge-frame position coincides with a real tile', () => {
    const positions = [];
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) positions.push([c, r]);
    const tiles = buildTilesMap(positions);
    const frame = edgeFramePositions(tiles);
    for (const p of frame) {
      assert.ok(!tiles.has(hexKey(p.col, p.row)), `(${p.col},${p.row}) overlaps a playable tile`);
    }
  });

  test('empty map produces no frame positions', () => {
    assert.deepEqual(edgeFramePositions(new Map()), []);
    assert.deepEqual(edgeFramePositions(null), []);
  });

  test('a 3×3 block produces a frame ring with positions on all four sides', () => {
    const positions = [];
    for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) positions.push([c, r]);
    const tiles = buildTilesMap(positions);
    const frame = edgeFramePositions(tiles);
    // We expect frame entries with col < 0 (west side) and col > 2 (east side)
    // and row < 0 (north side) and row > 2 (south side).
    assert.ok(frame.some(p => p.col < 0),  'west side');
    assert.ok(frame.some(p => p.col > 2),  'east side');
    assert.ok(frame.some(p => p.row < 0),  'north side');
    assert.ok(frame.some(p => p.row > 2),  'south side');
  });
});

describe('Renderer3D — edge-frame geometry constants', () => {
  test('frame Y sits below playable cylinder top so the frame reads as subordinate', () => {
    // Playable cylinder top is at y=+0.075. Frame prism top is at
    // EDGE_FRAME_Y + EDGE_FRAME_HEIGHT/2 — must come out below 0.075.
    const frameTop = EDGE_FRAME_Y + EDGE_FRAME_HEIGHT / 2;
    assert.ok(frameTop < 0.075, `frame prism top ${frameTop} should be below playable cylinder top 0.075`);
  });

  test('frame height is non-trivial so the prism actually reads as a tile', () => {
    assert.ok(EDGE_FRAME_HEIGHT > 0.05);
  });

  test('frame colour is a dark hex string', () => {
    assert.match(EDGE_FRAME_COLOR, /^#[0-9a-fA-F]{6}$/);
    // Crude darkness check — sum of RGB bytes well under (0xff * 3) / 2.
    const r = parseInt(EDGE_FRAME_COLOR.slice(1, 3), 16);
    const g = parseInt(EDGE_FRAME_COLOR.slice(3, 5), 16);
    const b = parseInt(EDGE_FRAME_COLOR.slice(5, 7), 16);
    assert.ok(r + g + b < 0xff * 3 / 2, `${EDGE_FRAME_COLOR} should be dark (subordinate to playable tiles)`);
  });
});
