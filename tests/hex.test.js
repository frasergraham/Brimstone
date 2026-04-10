// Spec-based tests for src/hex.js — pure hex math.
// Tests assert correct behaviour regardless of current implementation.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  offsetToAxial, axialToOffset, hexDistance,
  getNeighbors, hexRange, hexKey,
  hexToPixel, pixelToHex,
  MAP_COLS, MAP_ROWS,
} from '../src/hex.js';

// ── offsetToAxial / axialToOffset ────────────────────────────────────────────

describe('offsetToAxial / axialToOffset', () => {
  test('round-trip: offset → axial → offset should be identity', () => {
    for (const col of [0, 1, 5, 6, 12]) {
      for (const row of [0, 1, 5, 6, 10]) {
        const { q, r } = offsetToAxial(col, row);
        const { col: c2, row: r2 } = axialToOffset(q, r);
        assert.equal(c2, col, `col round-trip failed at (${col},${row})`);
        assert.equal(r2, row, `row round-trip failed at (${col},${row})`);
      }
    }
  });

  test('axial r should equal offset row for all hexes', () => {
    // In odd-r offset, the r (axial) equals the row
    for (const row of [0, 3, 7, 10]) {
      const { r } = offsetToAxial(5, row);
      assert.equal(r, row);
    }
  });
});

// ── hexDistance ───────────────────────────────────────────────────────────────

describe('hexDistance', () => {
  test('distance from any hex to itself is 0', () => {
    for (const col of [0, 6, 12]) {
      for (const row of [0, 5, 10]) {
        assert.equal(hexDistance(col, row, col, row), 0);
      }
    }
  });

  test('distance is symmetric', () => {
    const pairs = [
      [0, 0, 5, 3],
      [2, 1, 7, 4],
      [12, 10, 0, 0],
      [3, 3, 3, 6],
    ];
    for (const [c1, r1, c2, r2] of pairs) {
      assert.equal(
        hexDistance(c1, r1, c2, r2),
        hexDistance(c2, r2, c1, r1),
        `asymmetric between (${c1},${r1}) and (${c2},${r2})`
      );
    }
  });

  test('all neighbors are exactly distance 1 from their source', () => {
    const interiorHexes = [[3, 3], [6, 5], [9, 7]];
    for (const [col, row] of interiorHexes) {
      const neighbors = getNeighbors(col, row);
      for (const n of neighbors) {
        assert.equal(
          hexDistance(col, row, n.col, n.row), 1,
          `Neighbor (${n.col},${n.row}) of (${col},${row}) should be distance 1`
        );
      }
    }
  });

  test('distance is always a non-negative integer', () => {
    const pairs = [[0, 0, 12, 10], [1, 0, 1, 2], [5, 5, 7, 7]];
    for (const [c1, r1, c2, r2] of pairs) {
      const d = hexDistance(c1, r1, c2, r2);
      assert.ok(d >= 0, `distance should be non-negative, got ${d}`);
      assert.equal(d, Math.round(d), `distance should be an integer, got ${d}`);
    }
  });

  test('triangle inequality: d(A,C) <= d(A,B) + d(B,C)', () => {
    const A = [0, 0], B = [4, 3], C = [12, 10];
    const dAB = hexDistance(...A, ...B);
    const dBC = hexDistance(...B, ...C);
    const dAC = hexDistance(...A, ...C);
    assert.ok(dAC <= dAB + dBC, `Triangle inequality violated: ${dAC} > ${dAB} + ${dBC}`);
  });
});

// ── getNeighbors ──────────────────────────────────────────────────────────────

describe('getNeighbors', () => {
  test('interior hex returns exactly 6 neighbors', () => {
    // Any hex at least 1 away from all edges
    assert.equal(getNeighbors(6, 5).length, 6);
    assert.equal(getNeighbors(5, 5).length, 6);
    assert.equal(getNeighbors(4, 4).length, 6);
  });

  test('origin hex returns fewer than 6 neighbors (negative coords filtered)', () => {
    assert.ok(getNeighbors(0, 0).length < 6);
  });

  test('all neighbors have non-negative coordinates', () => {
    for (const col of [0, 3, 6, 9, 12]) {
      for (const row of [0, 3, 5, 7, 10]) {
        for (const n of getNeighbors(col, row)) {
          assert.ok(n.col >= 0, `col ${n.col} is negative`);
          assert.ok(n.row >= 0, `row ${n.row} is negative`);
        }
      }
    }
  });

  test('all neighbors are distance 1', () => {
    for (const n of getNeighbors(4, 4)) {
      assert.equal(hexDistance(4, 4, n.col, n.row), 1);
    }
  });

  test('no duplicate neighbors', () => {
    const neighbors = getNeighbors(5, 5);
    const keys = neighbors.map(n => hexKey(n.col, n.row));
    assert.equal(new Set(keys).size, keys.length, 'duplicate neighbors found');
  });

  test('neighbor relationship is symmetric: if B is neighbor of A then A is neighbor of B', () => {
    const col = 6, row = 5;
    const neighbors = getNeighbors(col, row);
    for (const n of neighbors) {
      const backNeighbors = getNeighbors(n.col, n.row);
      assert.ok(
        backNeighbors.some(b => b.col === col && b.row === row),
        `(${col},${row}) should be a neighbor of (${n.col},${n.row})`
      );
    }
  });
});

// ── hexRange ──────────────────────────────────────────────────────────────────

describe('hexRange', () => {
  test('radius 0 returns exactly the center hex', () => {
    const range = hexRange(5, 5, 0);
    assert.equal(range.length, 1);
    assert.equal(range[0].col, 5);
    assert.equal(range[0].row, 5);
  });

  test('radius 1 includes center and all neighbors', () => {
    const col = 6, row = 5;
    const range = hexRange(col, row, 1);
    const neighbors = getNeighbors(col, row);
    assert.ok(range.some(h => h.col === col && h.row === row), 'center should be included');
    for (const n of neighbors) {
      assert.ok(
        range.some(h => h.col === n.col && h.row === n.row),
        `Neighbor (${n.col},${n.row}) should be in radius-1 range`
      );
    }
  });

  test('every hex in range is within the stated max distance', () => {
    const col = 6, row = 5;
    for (const radius of [1, 2, 3]) {
      const range = hexRange(col, row, radius);
      for (const h of range) {
        assert.ok(
          hexDistance(col, row, h.col, h.row) <= radius,
          `(${h.col},${h.row}) is at distance ${hexDistance(col, row, h.col, h.row)}, exceeds radius ${radius}`
        );
      }
    }
  });

  test('all hexes in range are within map bounds', () => {
    for (const [col, row] of [[0, 0], [12, 10], [6, 5]]) {
      const range = hexRange(col, row, 3);
      for (const h of range) {
        assert.ok(h.col >= 0 && h.col < MAP_COLS, `col ${h.col} out of bounds`);
        assert.ok(h.row >= 0 && h.row < MAP_ROWS, `row ${h.row} out of bounds`);
      }
    }
  });

  test('radius 2 range contains no duplicates', () => {
    const range = hexRange(5, 5, 2);
    const keys = range.map(h => hexKey(h.col, h.row));
    assert.equal(new Set(keys).size, keys.length, 'duplicates found in hexRange');
  });
});

// ── hexKey ────────────────────────────────────────────────────────────────────

describe('hexKey', () => {
  test('format is "col,row"', () => {
    assert.equal(hexKey(3, 7), '3,7');
    assert.equal(hexKey(0, 0), '0,0');
    assert.equal(hexKey(12, 10), '12,10');
  });

  test('is injective: different coordinates produce different keys', () => {
    const seen = new Set();
    for (let col = 0; col < MAP_COLS; col++) {
      for (let row = 0; row < MAP_ROWS; row++) {
        const k = hexKey(col, row);
        assert.ok(!seen.has(k), `Duplicate key ${k} at (${col},${row})`);
        seen.add(k);
      }
    }
  });
});

// ── hexToPixel / pixelToHex ───────────────────────────────────────────────────

describe('hexToPixel / pixelToHex', () => {
  test('round-trip: center pixel of a hex maps back to same hex', () => {
    for (const col of [1, 5, 11]) {
      for (const row of [1, 5, 9]) {
        const { x, y } = hexToPixel(col, row);
        const { col: c2, row: r2 } = pixelToHex(x, y);
        assert.equal(c2, col, `col round-trip failed for (${col},${row})`);
        assert.equal(r2, row, `row round-trip failed for (${col},${row})`);
      }
    }
  });

  test('pixel position increases with column (x grows right)', () => {
    const { x: x1 } = hexToPixel(0, 0);
    const { x: x2 } = hexToPixel(1, 0);
    const { x: x3 } = hexToPixel(2, 0);
    assert.ok(x2 > x1, 'x should increase with col');
    assert.ok(x3 > x2, 'x should increase with col');
  });

  test('pixel position increases with row (y grows down)', () => {
    const { y: y1 } = hexToPixel(0, 0);
    const { y: y2 } = hexToPixel(0, 1);
    const { y: y3 } = hexToPixel(0, 2);
    assert.ok(y2 > y1, 'y should increase with row');
    assert.ok(y3 > y2, 'y should increase with row');
  });
});
