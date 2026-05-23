// Additional coverage for src/hex.js to harden the foundations the 3D
// renderer leans on (offset↔axial conversions, pixel positioning, MAP_SIZES).
//
// The existing tests/hex.test.js already covers the obvious round-trips and
// distance properties for small interior coordinates. This file extends that
// to:
//   - negative and large coordinates
//   - neighbour-count contract (0 or 6 for interior hexes once bounds are
//     widened, never anything else)
//   - hexRange ring sizes match the analytic formula
//   - hexToPixel reference values for fixed inputs (the values the 3D renderer
//     will rely on to align entities/glyphs with the 2D layout)
//   - MAP_SIZES presets carry every field the generator + renderer require,
//     and the sizes increase monotonically

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  offsetToAxial, axialToOffset, hexDistance, hexRange,
  getNeighbors, hexKey, hexToPixel, pixelToHex,
  HEX_SIZE, SQRT3, setMapDimensions, MAP_COLS, MAP_ROWS,
} from '../src/hex.js';
import { MAP_SIZES } from '../src/map.js';

// ── offsetToAxial / axialToOffset — broader inputs ────────────────────────────

describe('offsetToAxial / axialToOffset — broad inputs', () => {
  test('round-trip identity for negative coords', () => {
    for (const col of [-5, -3, -1, 0, 1, 3, 5]) {
      for (const row of [-5, -3, -1, 0, 1, 3, 5]) {
        const { q, r } = offsetToAxial(col, row);
        const { col: c2, row: r2 } = axialToOffset(q, r);
        assert.equal(c2, col, `col mismatch at (${col},${row})`);
        assert.equal(r2, row, `row mismatch at (${col},${row})`);
      }
    }
  });

  test('round-trip identity for large coords (campaign-sized maps)', () => {
    for (const col of [0, 10, 20, 41, 100]) {
      for (const row of [0, 10, 20, 41, 100]) {
        const { q, r } = offsetToAxial(col, row);
        const { col: c2, row: r2 } = axialToOffset(q, r);
        assert.equal(c2, col);
        assert.equal(r2, row);
      }
    }
  });

  test('output is always integer for integer input', () => {
    for (const col of [-3, 0, 7, 41]) {
      for (const row of [-3, 0, 7, 41]) {
        const { q, r } = offsetToAxial(col, row);
        assert.equal(q, Math.round(q), `q non-integer at (${col},${row})`);
        assert.equal(r, Math.round(r), `r non-integer at (${col},${row})`);
      }
    }
  });
});

// ── hexDistance — extended properties ─────────────────────────────────────────

describe('hexDistance — extended properties', () => {
  test('triangle inequality across a 20-pair sample', () => {
    const pts = [
      [0,0],[3,1],[5,5],[7,2],[12,10],
      [1,9],[8,8],[2,0],[11,3],[4,7],
    ];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        for (let k = j + 1; k < pts.length; k++) {
          const A = pts[i], B = pts[j], C = pts[k];
          const ab = hexDistance(...A, ...B);
          const bc = hexDistance(...B, ...C);
          const ac = hexDistance(...A, ...C);
          assert.ok(ac <= ab + bc,
            `triangle inequality failed for ${A}/${B}/${C}: ${ac} > ${ab}+${bc}`);
        }
      }
    }
  });

  test('distance works with negative coords', () => {
    // Distance is well-defined for the math even outside any map.
    const d = hexDistance(-2, -1, 2, 1);
    assert.ok(d > 0, 'expected positive distance');
    assert.equal(d, Math.round(d), 'expected integer distance');
  });
});

// ── getNeighbors — contract ───────────────────────────────────────────────────

describe('getNeighbors — contract', () => {
  test('any hex strictly inside [1..M-2] × [1..N-2] yields exactly 6 neighbours', () => {
    // With both col and row at least 1, neither -1 offset crosses 0 → no filtering.
    for (const col of [1, 5, 10, 25]) {
      for (const row of [1, 5, 10, 25]) {
        assert.equal(getNeighbors(col, row).length, 6,
          `expected 6 neighbours at (${col},${row})`);
      }
    }
  });

  test('neighbours of (0,0) are filtered to non-negative coords only', () => {
    const ns = getNeighbors(0, 0);
    for (const n of ns) {
      assert.ok(n.col >= 0, `neighbour col=${n.col} is negative`);
      assert.ok(n.row >= 0, `neighbour row=${n.row} is negative`);
    }
    // (0,0) is in the top-left corner: even-row deltas give -1 cols and -1 rows,
    // so only 2 (right + below) neighbours remain.
    assert.ok(ns.length >= 2 && ns.length <= 4,
      `unexpected corner neighbour count: ${ns.length}`);
  });

  test('odd-row vs even-row neighbour offsets are mirrored consistently', () => {
    // Pick an interior hex on an odd row and an even row; verify symmetry —
    // if B is a neighbour of A, then A is a neighbour of B, for both parities.
    for (const [col, row] of [[5, 4], [5, 5]]) {
      for (const n of getNeighbors(col, row)) {
        const back = getNeighbors(n.col, n.row);
        assert.ok(
          back.some(b => b.col === col && b.row === row),
          `neighbour symmetry failed at (${col},${row}) ↔ (${n.col},${n.row})`,
        );
      }
    }
  });
});

// ── hexRange — ring sizes ────────────────────────────────────────────────────

describe('hexRange — analytic ring sizes', () => {
  test('on a sufficiently wide map, |hexRange(center, r)| = 3r^2 + 3r + 1 for r in [0..3]', () => {
    // Widen MAP_COLS/MAP_ROWS so the ring isn't clipped by bounds.
    setMapDimensions(40, 40);
    try {
      const cx = 20, cy = 20;
      for (const r of [0, 1, 2, 3]) {
        const range = hexRange(cx, cy, r);
        const expected = 3 * r * r + 3 * r + 1;
        assert.equal(range.length, expected,
          `radius ${r}: expected ${expected} hexes, got ${range.length}`);
      }
    } finally {
      // Restore defaults the rest of the suite assumes.
      setMapDimensions(13, 11);
    }
  });

  test('hexRange clips to map bounds at the edge', () => {
    setMapDimensions(13, 11);
    const range = hexRange(0, 0, 2);
    // All returned hexes must lie within bounds.
    for (const h of range) {
      assert.ok(h.col >= 0 && h.col < MAP_COLS, `col ${h.col} out of bounds`);
      assert.ok(h.row >= 0 && h.row < MAP_ROWS, `row ${h.row} out of bounds`);
    }
    // And the size must be strictly less than the unbounded ring of radius 2 (=19).
    assert.ok(range.length < 19, `corner range should be clipped, got ${range.length}`);
  });
});

// ── hexToPixel — reference values & params ────────────────────────────────────

describe('hexToPixel — reference values', () => {
  // These values are what src/renderer.js relies on when it draws the 2D map.
  // The 3D renderer (Phase 2+) must place tile meshes at the same 2D positions
  // before applying its iso projection. If these change, both renderers must
  // be re-aligned together.

  test('origin (0,0) maps to pixel (0,0) at default size', () => {
    const { x, y } = hexToPixel(0, 0);
    assert.equal(x, 0);
    assert.equal(y, 0);
  });

  test('row stride is 1.5 × HEX_SIZE (pointy-top, odd-r offset)', () => {
    const { y: y0 } = hexToPixel(0, 0);
    const { y: y1 } = hexToPixel(0, 1);
    const { y: y2 } = hexToPixel(0, 2);
    assert.equal(y1 - y0, HEX_SIZE * 1.5);
    assert.equal(y2 - y1, HEX_SIZE * 1.5);
  });

  test('column stride is SQRT3 × HEX_SIZE within the same row', () => {
    const { x: x0 } = hexToPixel(0, 0);
    const { x: x1 } = hexToPixel(1, 0);
    const { x: x2 } = hexToPixel(2, 0);
    assert.equal(x1 - x0, HEX_SIZE * SQRT3);
    assert.equal(x2 - x1, HEX_SIZE * SQRT3);
  });

  test('odd rows are shifted by 0.5 × SQRT3 × HEX_SIZE in x (offset stagger)', () => {
    const { x: evenX } = hexToPixel(3, 2);   // even row
    const { x: oddX }  = hexToPixel(3, 3);   // odd row
    // Allow tiny float drift — the implementation factors the multiplication
    // differently than we do here, producing the same value to ~14 digits.
    assert.ok(Math.abs((oddX - evenX) - 0.5 * HEX_SIZE * SQRT3) < 1e-9);
  });

  test('custom size param scales output linearly', () => {
    const { x: x1, y: y1 } = hexToPixel(2, 3);
    const { x: x2, y: y2 } = hexToPixel(2, 3, HEX_SIZE * 2);
    assert.equal(x2, x1 * 2);
    assert.equal(y2, y1 * 2);
  });

  test('hexToPixel ↔ pixelToHex round-trip at non-default sizes', () => {
    for (const size of [10, 30, 64, 96]) {
      for (const col of [0, 3, 7]) {
        for (const row of [0, 2, 6]) {
          const { x, y } = hexToPixel(col, row, size);
          const { col: c2, row: r2 } = pixelToHex(x, y, size);
          assert.equal(c2, col, `col mismatch at size ${size}, (${col},${row})`);
          assert.equal(r2, row, `row mismatch at size ${size}, (${col},${row})`);
        }
      }
    }
  });
});

// ── hexKey — formatting & length ──────────────────────────────────────────────

describe('hexKey — corner cases', () => {
  test('handles negative-zero edge', () => {
    assert.equal(hexKey(-0, -0), '0,0');
  });

  test('handles large coords without precision loss', () => {
    assert.equal(hexKey(41, 41), '41,41');
    assert.equal(hexKey(100, 200), '100,200');
  });
});

// ── MAP_SIZES — preset shape & ordering ──────────────────────────────────────

describe('MAP_SIZES — preset contract', () => {
  const REQUIRED_FIELDS = [
    'label', 'cols', 'rows', 'villages', 'minVillageDist',
    'forestSeeds', 'nodeCount', 'nodeCountMin', 'nodeCountMax',
    'survivorCounts', 'bridgeMax', 'minBridges',
  ];

  test('every preset has all required fields with correct types', () => {
    for (const [key, cfg] of Object.entries(MAP_SIZES)) {
      for (const field of REQUIRED_FIELDS) {
        assert.ok(
          Object.prototype.hasOwnProperty.call(cfg, field),
          `MAP_SIZES.${key} missing required field: ${field}`,
        );
      }
      assert.equal(typeof cfg.label, 'string');
      assert.equal(typeof cfg.cols, 'number');
      assert.equal(typeof cfg.rows, 'number');
      assert.ok(Array.isArray(cfg.villages), `MAP_SIZES.${key}.villages should be an array`);
      assert.ok(Array.isArray(cfg.forestSeeds), `MAP_SIZES.${key}.forestSeeds should be an array`);
      assert.ok(cfg.forestSeeds.length > 0, `MAP_SIZES.${key}.forestSeeds is empty`);
      assert.equal(typeof cfg.survivorCounts.buildings, 'number');
      assert.equal(typeof cfg.survivorCounts.terrain, 'number');
      assert.ok(cfg.nodeCount >= cfg.nodeCountMin && cfg.nodeCount <= cfg.nodeCountMax,
        `MAP_SIZES.${key}: nodeCount ${cfg.nodeCount} outside [${cfg.nodeCountMin}, ${cfg.nodeCountMax}]`);
      assert.ok(cfg.bridgeMax >= cfg.minBridges,
        `MAP_SIZES.${key}: bridgeMax (${cfg.bridgeMax}) < minBridges (${cfg.minBridges})`);
    }
  });

  test('forestSeeds are all within their preset bounds', () => {
    for (const [key, cfg] of Object.entries(MAP_SIZES)) {
      for (const seed of cfg.forestSeeds) {
        assert.ok(seed.col >= 0 && seed.col < cfg.cols,
          `MAP_SIZES.${key}: forest seed col ${seed.col} out of bounds`);
        assert.ok(seed.row >= 0 && seed.row < cfg.rows,
          `MAP_SIZES.${key}: forest seed row ${seed.row} out of bounds`);
      }
    }
  });

  test('sizes increase monotonically: skirmish < standard < regional < campaign < battle', () => {
    const order = ['skirmish', 'standard', 'regional', 'campaign', 'battle'];
    for (let i = 1; i < order.length; i++) {
      const a = MAP_SIZES[order[i - 1]];
      const b = MAP_SIZES[order[i]];
      assert.ok(b.cols >= a.cols,
        `${order[i]} cols (${b.cols}) should be >= ${order[i - 1]} (${a.cols})`);
      assert.ok(b.rows >= a.rows,
        `${order[i]} rows (${b.rows}) should be >= ${order[i - 1]} (${a.rows})`);
      // Strictly larger from one tier to the next (battle is 2× campaign).
      assert.ok(b.cols * b.rows > a.cols * a.rows,
        `${order[i]} area should be strictly larger than ${order[i - 1]}`);
    }
  });
});
