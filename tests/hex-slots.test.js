// Sub-hex slot model: slot↔face mapping, road-face derivation, unit-slot
// picking, and alignment of the renderer's TILE_SLOTS geometry to the real
// hex face normals.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getNeighbors, neighborDirIndex } from '../src/hex.js';
import {
  SLOT_CENTER, SLOT_COUNT, OUTER_SLOTS, BUILDING_SLOT_INDEX,
  slotToDir, dirToSlot, roadFaceSlots, pickUnitSlot,
} from '../src/hex-slots.js';
import { TILE_SLOTS, hexToWorld } from '../src/renderer-3d.js';

describe('slot ↔ direction mapping', () => {
  test('slotToDir / dirToSlot are inverse over all outer slots', () => {
    for (const s of OUTER_SLOTS) {
      assert.equal(dirToSlot(slotToDir(s)), s, `slot ${s} round-trip`);
    }
    for (let d = 0; d < 6; d++) {
      assert.equal(slotToDir(dirToSlot(d)), d, `dir ${d} round-trip`);
    }
  });

  test('the 6 outer slots map onto all 6 distinct directions', () => {
    const dirs = new Set(OUTER_SLOTS.map(slotToDir));
    assert.equal(dirs.size, 6);
    for (let d = 0; d < 6; d++) assert.ok(dirs.has(d));
  });

  test('centre slot has no face direction', () => {
    assert.equal(slotToDir(SLOT_CENTER), -1);
    assert.equal(dirToSlot(-1), -1);
  });

  test('building anchor (slot 1) is the NE face (dir 2)', () => {
    assert.equal(slotToDir(BUILDING_SLOT_INDEX), 2);
  });
});

describe('neighborDirIndex is stable across even/odd rows', () => {
  test('the E neighbour is direction 3 on both an even and an odd row', () => {
    assert.equal(neighborDirIndex(5, 4, 6, 4), 3); // even row
    assert.equal(neighborDirIndex(5, 5, 6, 5), 3); // odd row
  });

  test('returns -1 for a non-adjacent hex', () => {
    assert.equal(neighborDirIndex(5, 5, 9, 9), -1);
  });

  test('every getNeighbors entry resolves to a unique 0..5 index', () => {
    for (const [c, r] of [[4, 4], [4, 5]]) {
      const seen = new Set();
      for (const n of getNeighbors(c, r)) {
        const d = neighborDirIndex(c, r, n.col, n.row);
        assert.ok(d >= 0 && d < 6);
        assert.ok(!seen.has(d), `duplicate dir ${d}`);
        seen.add(d);
      }
      assert.equal(seen.size, 6);
    }
  });
});

describe('roadFaceSlots', () => {
  test('maps a road neighbour to the slot adjacent to that face', () => {
    // (5,4) even row: E neighbour (6,4) is dir 3 → slot 6.
    const tile = { col: 5, row: 4, roadDirs: new Set(['6,4']) };
    const faces = roadFaceSlots(tile);
    assert.deepEqual([...faces], [6]);
  });

  test('handles multiple road faces and an array roadDirs', () => {
    // (5,4): W (4,4)→dir0→slot3, E (6,4)→dir3→slot6.
    const tile = { col: 5, row: 4, roadDirs: ['4,4', '6,4'] };
    const faces = roadFaceSlots(tile);
    assert.deepEqual([...faces].sort((a, b) => a - b), [3, 6]);
  });

  test('empty / missing roadDirs → empty set', () => {
    assert.equal(roadFaceSlots({ col: 0, row: 0 }).size, 0);
    assert.equal(roadFaceSlots({ col: 0, row: 0, roadDirs: new Set() }).size, 0);
  });
});

describe('pickUnitSlot', () => {
  test('prefers the centre when free', () => {
    assert.equal(pickUnitSlot([], []), SLOT_CENTER);
  });
  test('takes the lowest free, non-blocked slot', () => {
    assert.equal(pickUnitSlot([], [0]), 1);
    assert.equal(pickUnitSlot([1, 2, 3], [0]), 4);
  });
  test('never returns a blocked or occupied slot when one is free', () => {
    const s = pickUnitSlot([2, 4], [0, 1, 3]);
    assert.ok(![0, 1, 2, 3, 4].includes(s));
    assert.equal(s, 5);
  });
  test('overflows to the centre when everything is taken', () => {
    assert.equal(pickUnitSlot([1, 2, 3, 4, 5, 6], [0]), SLOT_CENTER);
  });
});

describe('TILE_SLOTS geometry aligns to face normals', () => {
  test('exposes the centre + 6 outer slots', () => {
    assert.equal(TILE_SLOTS.length, SLOT_COUNT);
  });

  test('each outer slot points along its mapped face direction', () => {
    // Use an even-row hex; compare the world vector to each neighbour against
    // the slot offset the slot model maps that face to.
    const col = 4, row = 4;
    const c = hexToWorld(col, row);
    for (const n of getNeighbors(col, row)) {
      const d = neighborDirIndex(col, row, n.col, n.row);
      const slot = TILE_SLOTS[dirToSlot(d)];
      const nw = hexToWorld(n.col, n.row);
      // Normalised face direction vs normalised slot offset.
      const fx = nw.x - c.x, fz = nw.z - c.z;
      const fl = Math.hypot(fx, fz), sl = Math.hypot(slot.x, slot.z);
      const dot = (fx / fl) * (slot.x / sl) + (fz / fl) * (slot.z / sl);
      assert.ok(dot > 0.999, `slot ${dirToSlot(d)} misaligned with dir ${d} (dot ${dot})`);
    }
  });
});
