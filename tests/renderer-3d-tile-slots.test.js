// Tests for the Item-8 tile-slot system: deterministic assignment of multiple
// occupants (buildings, trees, standees) to fixed slots on a hex so silhouettes
// don't pile up at the centre, and the +N overflow badge for hexes that exceed
// the 7-slot capacity.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  TILE_SLOTS,
  CENTRE_SLOT_INDEX,
  BUILDING_SLOT_INDEX,
  BUILDING_OFFSET,
  assignTileSlotIndices,
  tileSlotWorldPositions,
  hexToWorld,
  forestTreesForHex,
} from '../src/renderer-3d.js';

describe('TILE_SLOTS layout', () => {
  test('exposes 7 slots (1 centre + 6 outer)', () => {
    assert.equal(TILE_SLOTS.length, 7);
  });

  test('centre slot is at origin', () => {
    assert.deepEqual(TILE_SLOTS[CENTRE_SLOT_INDEX], { x: 0, z: 0 });
  });

  test('every outer slot sits within the hex (distance ≤ 1, well above 0)', () => {
    for (let i = 1; i < TILE_SLOTS.length; i++) {
      const d = Math.hypot(TILE_SLOTS[i].x, TILE_SLOTS[i].z);
      assert.ok(d > 0.4 && d < 1, `slot ${i} distance ${d} outside (0.4, 1)`);
    }
  });

  test('every outer slot is distinct (no two slots overlap)', () => {
    const keys = new Set();
    for (let i = 1; i < TILE_SLOTS.length; i++) {
      const k = `${TILE_SLOTS[i].x.toFixed(3)},${TILE_SLOTS[i].z.toFixed(3)}`;
      assert.ok(!keys.has(k), `duplicate slot at ${k}`);
      keys.add(k);
    }
  });

  test('building slot offset matches BUILDING_OFFSET (legacy alias)', () => {
    // Building boxes still consult BUILDING_OFFSET; we keep them aligned with
    // TILE_SLOTS[BUILDING_SLOT_INDEX] so the slot system can claim the slot
    // without moving the building visually.
    assert.equal(TILE_SLOTS[BUILDING_SLOT_INDEX].x, BUILDING_OFFSET.x);
    assert.equal(TILE_SLOTS[BUILDING_SLOT_INDEX].z, BUILDING_OFFSET.z);
  });

  test('TILE_SLOTS itself is frozen', () => {
    assert.ok(Object.isFrozen(TILE_SLOTS));
    for (const slot of TILE_SLOTS) assert.ok(Object.isFrozen(slot));
  });
});

describe('assignTileSlotIndices — priority & determinism', () => {
  test('building always claims slot 1', () => {
    const { slotByOccupantId, overflow } = assignTileSlotIndices([
      { id: 'bldg', kind: 'building' },
    ]);
    assert.equal(slotByOccupantId.get('bldg'), BUILDING_SLOT_INDEX);
    assert.equal(overflow, 0);
  });

  test('single standee on an empty hex lands at centre', () => {
    const { slotByOccupantId } = assignTileSlotIndices([
      { id: 's1', kind: 'standee' },
    ]);
    assert.equal(slotByOccupantId.get('s1'), CENTRE_SLOT_INDEX);
  });

  test('trees only use outer slots — centre stays free', () => {
    const occ = [];
    for (let i = 0; i < 5; i++) occ.push({ id: `t${i}`, kind: 'tree' });
    const { slotByOccupantId } = assignTileSlotIndices(occ);
    for (const t of occ) {
      const idx = slotByOccupantId.get(t.id);
      assert.notEqual(idx, CENTRE_SLOT_INDEX, `${t.id} took the centre slot`);
      assert.ok(idx >= 1 && idx < TILE_SLOTS.length, `${t.id} index ${idx} out of range`);
    }
  });

  test('trees never collide with the building slot when both are present', () => {
    const occ = [
      { id: 'bldg', kind: 'building' },
      ...[0, 1, 2, 3, 4].map(i => ({ id: `t${i}`, kind: 'tree' })),
    ];
    const { slotByOccupantId } = assignTileSlotIndices(occ);
    const treeSlots = occ.filter(o => o.kind === 'tree')
      .map(o => slotByOccupantId.get(o.id));
    assert.ok(!treeSlots.includes(BUILDING_SLOT_INDEX),
      `tree took the building slot: ${treeSlots.join(',')}`);
    assert.ok(!treeSlots.includes(CENTRE_SLOT_INDEX),
      'tree took the centre slot');
  });

  test('standee prefers centre over outer when centre is free', () => {
    const { slotByOccupantId } = assignTileSlotIndices([
      { id: 'bldg', kind: 'building' },
      { id: 's1',   kind: 'standee' },
    ]);
    assert.equal(slotByOccupantId.get('s1'), CENTRE_SLOT_INDEX);
    assert.equal(slotByOccupantId.get('bldg'), BUILDING_SLOT_INDEX);
  });

  test('extra standees take outer slots in id order, no two share a slot', () => {
    const occ = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(id => ({ id, kind: 'standee' }));
    const { slotByOccupantId, overflow } = assignTileSlotIndices(occ);
    assert.equal(overflow, 0); // 7 standees exactly fit
    const used = new Set();
    for (const o of occ) used.add(slotByOccupantId.get(o.id));
    assert.equal(used.size, 7, 'every standee got a distinct slot');
  });

  test('standees beyond capacity are reported as overflow (still mapped to centre)', () => {
    const occ = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].map(id => ({ id, kind: 'standee' }));
    const { slotByOccupantId, overflow } = assignTileSlotIndices(occ);
    assert.equal(overflow, 2); // 7 fit, 2 overflow
    // Overflow standees are still in the map (so the renderer can position
    // them all), pointed at centre.
    assert.equal(slotByOccupantId.get('h'), CENTRE_SLOT_INDEX);
    assert.equal(slotByOccupantId.get('i'), CENTRE_SLOT_INDEX);
  });

  test('building + 5 trees + 1 standee: standee gets centre, trees fill rest', () => {
    const occ = [
      { id: 'bldg', kind: 'building' },
      ...[0, 1, 2, 3, 4].map(i => ({ id: `t${i}`, kind: 'tree' })),
      { id: 's1', kind: 'standee' },
    ];
    const { slotByOccupantId, overflow } = assignTileSlotIndices(occ);
    assert.equal(overflow, 0);
    assert.equal(slotByOccupantId.get('s1'), CENTRE_SLOT_INDEX);
    assert.equal(slotByOccupantId.get('bldg'), BUILDING_SLOT_INDEX);
  });

  test('assignment is deterministic — same input twice → same output', () => {
    const make = () => [
      { id: 'b', kind: 'building' },
      { id: 't0', kind: 'tree' },
      { id: 't1', kind: 'tree' },
      { id: 's0', kind: 'standee' },
      { id: 's1', kind: 'standee' },
    ];
    const a = assignTileSlotIndices(make());
    const b = assignTileSlotIndices(make());
    for (const id of ['b', 't0', 't1', 's0', 's1']) {
      assert.equal(a.slotByOccupantId.get(id), b.slotByOccupantId.get(id),
        `non-deterministic assignment for ${id}`);
    }
  });

  test('empty or non-array input returns an empty map', () => {
    assert.equal(assignTileSlotIndices([]).slotByOccupantId.size, 0);
    assert.equal(assignTileSlotIndices(null).slotByOccupantId.size, 0);
    assert.equal(assignTileSlotIndices(undefined).slotByOccupantId.size, 0);
  });

  test('ignores occupants with unknown kind', () => {
    const { slotByOccupantId } = assignTileSlotIndices([
      { id: 'x', kind: 'mystery' },
      { id: 's', kind: 'standee' },
    ]);
    assert.equal(slotByOccupantId.has('x'), false);
    assert.equal(slotByOccupantId.get('s'), CENTRE_SLOT_INDEX);
  });
});

describe('tileSlotWorldPositions', () => {
  test('returns absolute world (x, z) positions on the named hex', () => {
    const col = 3, row = 5;
    const { positionByOccupantId, overflow } = tileSlotWorldPositions(col, row, [
      { id: 'bldg', kind: 'building' },
      { id: 's1',   kind: 'standee' },
    ]);
    assert.equal(overflow, 0);
    const centre = hexToWorld(col, row);
    const sPos = positionByOccupantId.get('s1');
    assert.ok(Math.abs(sPos.x - centre.x) < 1e-9);
    assert.ok(Math.abs(sPos.z - centre.z) < 1e-9);
    const bPos = positionByOccupantId.get('bldg');
    assert.ok(Math.abs(bPos.x - (centre.x + BUILDING_OFFSET.x)) < 1e-9);
    assert.ok(Math.abs(bPos.z - (centre.z + BUILDING_OFFSET.z)) < 1e-9);
  });

  test('overflow propagates to the returned tuple', () => {
    const occ = ['a','b','c','d','e','f','g','h'].map(id => ({ id, kind: 'standee' }));
    const { overflow } = tileSlotWorldPositions(0, 0, occ);
    assert.equal(overflow, 1);
  });
});

describe('forestTreesForHex — building-slot reservation (building-on-forest clip fix)', () => {
  // Scan a grid of hexes so the assertions cover the full range of per-hex
  // tree counts and slot rotations, not just one layout.
  const HEXES = [];
  for (let col = 0; col < 12; col++) {
    for (let row = 0; row < 12; row++) HEXES.push([col, row]);
  }

  test('on a building tile, NO tree takes BUILDING_SLOT_INDEX', () => {
    for (const [col, row] of HEXES) {
      const trees = forestTreesForHex(col, row, null, { reserveBuildingSlot: true });
      for (const t of trees) {
        assert.notEqual(t.slotIdx, BUILDING_SLOT_INDEX,
          `tree ${t.id} on building tile (${col},${row}) clips the building slot`);
        assert.notEqual(t.slotIdx, CENTRE_SLOT_INDEX,
          `tree ${t.id} on (${col},${row}) took the centre slot`);
      }
    }
  });

  test('on a plain forest tile, trees DO use the full outer ring (incl. slot 1)', () => {
    // Without reservation the building slot is just another outer slot, so at
    // least one tree somewhere must land on BUILDING_SLOT_INDEX — proving the
    // fix is gated on the building flag and plain forests are unchanged.
    let sawBuildingSlot = false;
    for (const [col, row] of HEXES) {
      const trees = forestTreesForHex(col, row, null);
      for (const t of trees) {
        if (t.slotIdx === BUILDING_SLOT_INDEX) sawBuildingSlot = true;
        assert.notEqual(t.slotIdx, CENTRE_SLOT_INDEX,
          `tree ${t.id} on (${col},${row}) took the centre slot`);
      }
    }
    assert.ok(sawBuildingSlot,
      'no plain-forest tree ever used slot 1 — reservation may be leaking');
  });

  test('reservation re-slots the SAME cluster — same tree ids and count', () => {
    // The building flag must only move trees off slot 1, never change which
    // trees exist (count, ids, scale, species are all hex-stable).
    for (const [col, row] of HEXES) {
      const plain    = forestTreesForHex(col, row, null);
      const reserved = forestTreesForHex(col, row, null, { reserveBuildingSlot: true });
      assert.equal(reserved.length, plain.length,
        `tree count changed on (${col},${row})`);
      assert.deepEqual(
        reserved.map(t => t.id).sort(),
        plain.map(t => t.id).sort(),
        `tree id set changed on (${col},${row})`);
    }
  });
});
