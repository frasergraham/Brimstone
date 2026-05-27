// 3D renderer — fortification pure-helper unit tests.
//
// Fortifications render as a low wall around a fortified hex's OUTER perimeter.
// Two Babylon-free helpers drive that: `fortifyWallStyle` (level → wall tier)
// and `fortifyEdgeDirs` (which of the 6 edges get a segment, applying the
// "skip shared interior edges between two fortified hexes" adjacency rule).
// `fortNeighborOffset` is the odd-r direction helper they share.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fortifyWallStyle,
  fortifyEdgeDirs,
  fortNeighborOffset,
} from '../src/renderer-3d.js';
import { MAX_FORTIFY_LEVEL } from '../src/tiles.js';

describe('fortifyWallStyle — level → wall tier', () => {
  test('level 0 and below → null (no fortification)', () => {
    assert.equal(fortifyWallStyle(0), null);
    assert.equal(fortifyWallStyle(-1), null);
  });

  test('level 1 → sparse stakes', () => {
    assert.equal(fortifyWallStyle(1).kind, 'stakes');
  });

  test('levels 2–3 → continuous low wall', () => {
    assert.equal(fortifyWallStyle(2).kind, 'low');
    assert.equal(fortifyWallStyle(3).kind, 'low');
  });

  test('levels 4–6 → tall rampart', () => {
    assert.equal(fortifyWallStyle(4).kind, 'tall');
    assert.equal(fortifyWallStyle(5).kind, 'tall');
    assert.equal(fortifyWallStyle(MAX_FORTIFY_LEVEL).kind, 'tall');
  });

  test('taller tiers are not shorter than lower ones', () => {
    assert.ok(fortifyWallStyle(2).height >= fortifyWallStyle(1).height);
    assert.ok(fortifyWallStyle(4).height >= fortifyWallStyle(2).height);
  });

  test('each tier carries a positive height/thickness and a colour', () => {
    for (const lvl of [1, 2, 4]) {
      const s = fortifyWallStyle(lvl);
      assert.ok(s.height > 0);
      assert.ok(s.thickness > 0);
      assert.match(s.color, /^#[0-9a-f]{6}$/i);
    }
  });

  test('non-integer level is floored (1.9 → level 1 → stakes)', () => {
    assert.equal(fortifyWallStyle(1.9).kind, 'stakes');
  });
});

describe('fortNeighborOffset — odd-r direction deltas', () => {
  test('index 0 is always West, index 3 always East (parity-independent)', () => {
    assert.deepEqual(fortNeighborOffset(5, 4, 0), { col: 4, row: 4 }); // even row W
    assert.deepEqual(fortNeighborOffset(5, 4, 3), { col: 6, row: 4 }); // even row E
    assert.deepEqual(fortNeighborOffset(5, 5, 0), { col: 4, row: 5 }); // odd row W
    assert.deepEqual(fortNeighborOffset(5, 5, 3), { col: 6, row: 5 }); // odd row E
  });

  test('may return off-map (negative) coords without filtering', () => {
    // getNeighbors() would drop this; fortNeighborOffset must NOT, so a
    // fortified hex at col 0 still gets its west perimeter wall.
    assert.deepEqual(fortNeighborOffset(0, 4, 0), { col: -1, row: 4 });
  });
});

describe('fortifyEdgeDirs — adjacency rule', () => {
  // Build a lookup over an explicit {("c,r"): level} map; everything absent → 0.
  const lookupFrom = (levels) => (col, row) => levels[`${col},${row}`] || 0;

  test('unfortified hex draws no edges', () => {
    assert.deepEqual(fortifyEdgeDirs(5, 5, lookupFrom({})), []);
  });

  test('isolated fortified hex draws all 6 edges', () => {
    const dirs = fortifyEdgeDirs(5, 5, lookupFrom({ '5,5': 1 }));
    assert.deepEqual(dirs.sort((a, b) => a - b), [0, 1, 2, 3, 4, 5]);
  });

  test('off-map neighbours count as unfortified → perimeter edge IS drawn', () => {
    // Hex at col 0: its West neighbour (dir 0) is off-map → still drawn.
    const dirs = fortifyEdgeDirs(0, 4, lookupFrom({ '0,4': 2 }));
    assert.ok(dirs.includes(0));
    assert.equal(dirs.length, 6);
  });

  test('shared edge between two fortified hexes is SKIPPED on both sides', () => {
    // (5,4) and its East neighbour (6,4) are both fortified.
    const levels = { '5,4': 2, '6,4': 2 };
    const lk = lookupFrom(levels);

    // From (5,4): East is dir 3 → must NOT be drawn.
    const a = fortifyEdgeDirs(5, 4, lk);
    assert.ok(!a.includes(3), 'shared east edge should be skipped');
    assert.equal(a.length, 5);

    // From (6,4): West is dir 0 → the same shared edge, also skipped.
    const b = fortifyEdgeDirs(6, 4, lk);
    assert.ok(!b.includes(0), 'shared west edge should be skipped');
    assert.equal(b.length, 5);
  });

  test('a fortified neighbour at level 1 still counts as fortified (shared edge skipped)', () => {
    const lk = lookupFrom({ '5,4': 3, '6,4': 1 });
    assert.ok(!fortifyEdgeDirs(5, 4, lk).includes(3));
  });

  test('the two skipped edges are geometrically the same edge (mutual neighbours)', () => {
    // For every direction d from (5,4), the neighbour across it, looked at from
    // ITS perspective, points back at (5,4). This is what makes the skip
    // symmetric — verify the round-trip for all 6 directions.
    const c = 5, r = 4;
    for (let d = 0; d < 6; d++) {
      const nb = fortNeighborOffset(c, r, d);
      let back = false;
      for (let e = 0; e < 6; e++) {
        const nn = fortNeighborOffset(nb.col, nb.row, e);
        if (nn.col === c && nn.row === r) { back = true; break; }
      }
      assert.ok(back, `direction ${d} has a reciprocal edge`);
    }
  });
});
