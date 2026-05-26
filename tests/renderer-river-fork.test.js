// Tests for the 2D renderer's pure river-branch planner, `planRiverTileBranches`.
// A branching river (a RIVER tile with 3+ RIVER neighbours — a junction/fork)
// is something the procedural generator never makes but a human-edited mission
// map can. The planner generalises the old "exactly 2 endpoints" assumption so
// 2-way tiles render the same smooth through-bezier while 3/4-way junctions
// connect every branch at the tile centre.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { planRiverTileBranches } from '../src/renderer.js';

// Six pointy-top neighbour directions at unit distance from a centre. Exact
// positions don't matter for the planner (it normalises), only relative dirs.
const APO = 10; // arbitrary apothem
function at(cx, cy, dx, dy) { return { x: cx + dx, y: cy + dy }; }

describe('planRiverTileBranches — exit set by neighbour count', () => {
  test('0 neighbours → nothing to draw', () => {
    const p = planRiverTileBranches(0, 0, [], APO);
    assert.equal(p.through, null);
    assert.deepEqual(p.edgeMids, []);
    assert.deepEqual(p.spokes, []);
    assert.equal(p.endpoint, null);
  });

  test('1 neighbour → endpoint extension, one through index, no spokes', () => {
    const p = planRiverTileBranches(0, 0, [at(0, 0, 1, 0)], APO);
    assert.deepEqual(p.through, [0]);
    assert.deepEqual(p.spokes, []);
    assert.equal(p.edgeMids.length, 1);
    // Edge midpoint sits one apothem toward the neighbour (east).
    assert.ok(Math.abs(p.edgeMids[0].x - APO) < 1e-9);
    assert.ok(Math.abs(p.edgeMids[0].y - 0) < 1e-9);
    // Endpoint extends one apothem the OTHER way (west) for the off-tile fade.
    assert.ok(p.endpoint && Math.abs(p.endpoint.x + APO) < 1e-9);
    assert.ok(Math.abs(p.endpoint.y - 0) < 1e-9);
  });

  test('2 neighbours → single smooth through-bezier pair, no spokes (unchanged look)', () => {
    // Opposing E + W neighbours.
    const p = planRiverTileBranches(0, 0, [at(0, 0, 1, 0), at(0, 0, -1, 0)], APO);
    assert.equal(p.endpoint, null);
    assert.deepEqual(p.spokes, []);
    assert.equal(p.through.length, 2);
    assert.deepEqual([...p.through].sort(), [0, 1]);
    assert.equal(p.edgeMids.length, 2);
  });

  test('3-way fork → through-bezier on the opposing pair + exactly 1 spoke', () => {
    // E + W are diametrically opposed (dot = -1); N is the branch spoke.
    const p = planRiverTileBranches(0, 0, [
      at(0, 0, 1, 0),   // 0: E
      at(0, 0, -1, 0),  // 1: W
      at(0, 0, 0, -1),  // 2: N (branch)
    ], APO);
    assert.equal(p.endpoint, null);
    assert.deepEqual([...p.through].sort(), [0, 1], 'through pair is the opposing E/W');
    assert.deepEqual(p.spokes, [2], 'the N branch is the lone spoke');
    assert.equal(p.edgeMids.length, 3);
    // The spoke's edge midpoint points north (negative y) at one apothem.
    assert.ok(Math.abs(p.edgeMids[2].y + APO) < 1e-9);
  });

  test('4-way junction → through-bezier pair + 2 spokes (all branches connected)', () => {
    const p = planRiverTileBranches(0, 0, [
      at(0, 0, 1, 0),   // 0: E
      at(0, 0, -1, 0),  // 1: W
      at(0, 0, 0, 1),   // 2: S
      at(0, 0, 0, -1),  // 3: N
    ], APO);
    assert.equal(p.endpoint, null);
    assert.equal(p.through.length, 2);
    assert.equal(p.spokes.length, 2, 'two of four branches become spokes');
    // Every branch is accounted for exactly once across through + spokes.
    const covered = [...p.through, ...p.spokes].sort();
    assert.deepEqual(covered, [0, 1, 2, 3]);
  });

  test('through pair is the most-opposing pair when branches are uneven', () => {
    // E + W opposed (dot -1); the other two are NE-ish, so they must end up as
    // spokes, not the through-channel.
    const p = planRiverTileBranches(0, 0, [
      at(0, 0, 1, 0),    // 0: E
      at(0, 0, -1, 0),   // 1: W
      at(0, 0, 0.7, -0.7), // 2: NE
      at(0, 0, -0.7, -0.7),// 3: NW
    ], APO);
    assert.deepEqual([...p.through].sort(), [0, 1]);
    assert.deepEqual(p.spokes.sort(), [2, 3]);
  });

  test('edge midpoints lie one apothem from the centre regardless of neighbour distance', () => {
    // Far-away neighbour centres normalise to the same edge midpoint.
    const near = planRiverTileBranches(5, 5, [at(5, 5, 1, 0)], APO);
    const far  = planRiverTileBranches(5, 5, [at(5, 5, 100, 0)], APO);
    assert.ok(Math.abs(near.edgeMids[0].x - far.edgeMids[0].x) < 1e-9);
    assert.ok(Math.abs(near.edgeMids[0].x - (5 + APO)) < 1e-9);
  });
});
