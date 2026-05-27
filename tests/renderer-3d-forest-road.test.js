// Tests for the road-through-forest 3D fixes:
//   PART 1 — forest cones must not sit on the road deck. A forest tile that
//            carries a road excludes the tile-slots the road footprint crosses
//            (roadBlockedTreeSlots), so no cone overlaps the ribbon.
//   PART 2 — a road laid through a FOREST-base tile renders 20% narrower
//            (roadTileRibbonWidth → FOREST_ROAD_WIDTH_FACTOR); non-forest roads
//            and rivers keep full width.
//
// All pure-helper level — no Babylon. Geometry is {x,z} in world units.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { TileType, PathType, Tile } from '../src/tiles.js';
import { hexKey, getNeighbors } from '../src/hex.js';

import {
  TILE_SLOTS,
  CENTRE_SLOT_INDEX,
  BUILDING_SLOT_INDEX,
  ROAD_RIBBON_WIDTH,
  FOREST_ROAD_WIDTH_FACTOR,
  FOREST_ROAD_HALF_WIDTH,
  FOREST_ROAD_TREE_REACH,
  assignTileSlotIndices,
  forestTreesForHex,
  networkStrokesForTile,
  roadBlockedTreeSlots,
  roadTileRibbonWidth,
  _pointSegmentDistanceXZ,
  hexToWorld,
  FOREST_TREES_MIN,
  FOREST_TREES_MAX,
  FOREST_DENSITY_SCALE,
  scaledForestTreeCount,
} from '../src/renderer-3d.js';

// Build a forest tile with a straight road across it (two opposite neighbours).
function mkForestRoadTile(col, row, nbrs) {
  const t = new Tile(col, row, TileType.FOREST); // base = forest, path = null
  t.path = PathType.ROAD;
  t.roadDirs = new Set(nbrs.map((n) => hexKey(n.col, n.row)));
  return t;
}

// Min distance from a world point to any segment of any road stroke.
function distToRoad(px, pz, strokes) {
  let min = Infinity;
  for (const stroke of strokes) {
    for (let s = 0; s + 1 < stroke.length; s++) {
      const a = stroke[s], b = stroke[s + 1];
      const d = _pointSegmentDistanceXZ(px, pz, a.x, a.z, b.x, b.z);
      if (d < min) min = d;
    }
  }
  return min;
}

describe('_pointSegmentDistanceXZ', () => {
  test('point on the segment → 0', () => {
    assert.equal(_pointSegmentDistanceXZ(0.5, 0, 0, 0, 1, 0), 0);
  });
  test('perpendicular offset → that offset', () => {
    assert.ok(Math.abs(_pointSegmentDistanceXZ(0.5, 0.3, 0, 0, 1, 0) - 0.3) < 1e-9);
  });
  test('past an endpoint → distance to the endpoint, not the infinite line', () => {
    // (2,0) projects beyond the (0,0)-(1,0) segment; nearest point is (1,0).
    assert.ok(Math.abs(_pointSegmentDistanceXZ(2, 0, 0, 0, 1, 0) - 1) < 1e-9);
  });
  test('degenerate zero-length segment → distance to the point', () => {
    assert.ok(Math.abs(_pointSegmentDistanceXZ(3, 4, 0, 0, 0, 0) - 5) < 1e-9);
  });
});

describe('roadBlockedTreeSlots — geometric exclusion', () => {
  // An east-west road through (5,5): neighbours to the +col / -col side.
  const col = 5, row = 5;
  const nbrs = [{ col: 6, row: 5 }, { col: 4, row: 5 }];
  const tile = mkForestRoadTile(col, row, nbrs);
  const strokes = networkStrokesForTile(tile, nbrs, { kind: 'road' });
  const center = hexToWorld(col, row);

  test('road produces a through-stroke', () => {
    assert.ok(strokes.length >= 1);
    assert.ok(strokes[0].length >= 2);
  });

  test('blocks the slots sitting on the deck, keeps the rest', () => {
    const blocked = roadBlockedTreeSlots(strokes, center);
    // At least one slot must be excluded (the road crosses the tile centre).
    assert.ok(blocked.size > 0, 'expected the road to block at least one slot');
    // Centre slot (0) is never returned — reserved for a standee.
    assert.ok(!blocked.has(CENTRE_SLOT_INDEX));
    // Some outer slots must survive so the tile still shows trees.
    assert.ok(blocked.size < TILE_SLOTS.length - 1,
      'road should not block every outer slot for a simple straight crossing');
    // Every blocked slot genuinely sits within reach of the deck; every
    // surviving outer slot genuinely sits clear of it.
    for (let i = 1; i < TILE_SLOTS.length; i++) {
      const px = center.x + TILE_SLOTS[i].x;
      const pz = center.z + TILE_SLOTS[i].z;
      const d = distToRoad(px, pz, strokes);
      if (blocked.has(i)) {
        assert.ok(d <= FOREST_ROAD_TREE_REACH, `slot ${i} blocked but d=${d} > reach`);
      } else {
        assert.ok(d > FOREST_ROAD_TREE_REACH, `slot ${i} kept but d=${d} <= reach`);
      }
    }
  });

  test('no strokes / no center → empty set', () => {
    assert.equal(roadBlockedTreeSlots([], center).size, 0);
    assert.equal(roadBlockedTreeSlots(strokes, null).size, 0);
  });
});

describe('assignTileSlotIndices — reservedSlots', () => {
  test('trees skip reserved slots', () => {
    const occ = [
      { id: 'tree_a', kind: 'tree' },
      { id: 'tree_b', kind: 'tree' },
    ];
    const { slotByOccupantId } = assignTileSlotIndices(occ, {
      reservedSlots: new Set([2, 3, 4]),
    });
    for (const [, slotIdx] of slotByOccupantId) {
      assert.ok(![2, 3, 4].includes(slotIdx), `tree landed in reserved slot ${slotIdx}`);
    }
  });

  test('a building keeps slot 1 even when reservedSlots also names slot 1', () => {
    const occ = [
      { id: 'building', kind: 'building' },
      { id: 'tree_a', kind: 'tree' },
    ];
    const { slotByOccupantId } = assignTileSlotIndices(occ, {
      reservedSlots: new Set([BUILDING_SLOT_INDEX]),
    });
    assert.equal(slotByOccupantId.get('building'), BUILDING_SLOT_INDEX);
  });

  test('reserving the centre is ignored (centre always available to standees)', () => {
    const occ = [{ id: 'standee_1', kind: 'standee' }];
    const { slotByOccupantId } = assignTileSlotIndices(occ, {
      reservedSlots: new Set([CENTRE_SLOT_INDEX]),
    });
    assert.equal(slotByOccupantId.get('standee_1'), CENTRE_SLOT_INDEX);
  });

  test('omitting reservedSlots preserves the original behaviour', () => {
    const occ = [{ id: 'tree_a', kind: 'tree' }, { id: 'tree_b', kind: 'tree' }];
    const a = assignTileSlotIndices(occ);
    const b = assignTileSlotIndices(occ, {});
    assert.deepEqual([...a.slotByOccupantId], [...b.slotByOccupantId]);
  });
});

describe('forestTreesForHex — blockedSlots (road through forest)', () => {
  test('plain forest tile (no blockedSlots) uses the full outer ring', () => {
    const trees = forestTreesForHex(7, 3, 'summer');
    const lo = scaledForestTreeCount(FOREST_TREES_MIN, FOREST_DENSITY_SCALE);
    const hi = scaledForestTreeCount(FOREST_TREES_MAX, FOREST_DENSITY_SCALE);
    assert.ok(trees.length >= lo && trees.length <= hi);
    for (const t of trees) {
      assert.notEqual(t.slotIdx, CENTRE_SLOT_INDEX); // never the centre
      assert.ok(t.slotIdx >= 1 && t.slotIdx < TILE_SLOTS.length);
    }
    // No two trees share a slot.
    const slots = new Set(trees.map((t) => t.slotIdx));
    assert.equal(slots.size, trees.length);
  });

  test('no returned tree lands in a blocked slot', () => {
    const blocked = new Set([3, 6]);
    const trees = forestTreesForHex(7, 3, 'summer', { blockedSlots: blocked });
    for (const t of trees) {
      assert.ok(!blocked.has(t.slotIdx), `tree placed in blocked slot ${t.slotIdx}`);
      assert.notEqual(t.slotIdx, CENTRE_SLOT_INDEX);
    }
  });

  test('surplus trees are dropped (never piled on the centre) when slots run out', () => {
    // Leave only slots {1, 6} free for trees → at most 2 trees can be placed.
    const blocked = new Set([2, 3, 4, 5]);
    const trees = forestTreesForHex(11, 11, 'summer', { blockedSlots: blocked });
    assert.ok(trees.length <= 2, `expected ≤2 trees, got ${trees.length}`);
    for (const t of trees) {
      assert.notEqual(t.slotIdx, CENTRE_SLOT_INDEX);
      assert.ok([1, 6].includes(t.slotIdx));
    }
  });

  test('integration: cones on a forest+road tile clear the road deck', () => {
    const col = 5, row = 5;
    const nbrs = [{ col: 6, row: 5 }, { col: 4, row: 5 }];
    const tile = mkForestRoadTile(col, row, nbrs);
    const strokes = networkStrokesForTile(tile, nbrs, { kind: 'road' });
    const center = hexToWorld(col, row);
    const blocked = roadBlockedTreeSlots(strokes, center);

    const trees = forestTreesForHex(col, row, 'summer', { blockedSlots: blocked });
    assert.ok(trees.length > 0, 'forest+road tile should still show some trees');
    for (const t of trees) {
      const px = center.x + t.x;
      const pz = center.z + t.z;
      const d = distToRoad(px, pz, strokes);
      // No cone within the (narrowed) road half-width — i.e. nothing on the deck.
      assert.ok(d > FOREST_ROAD_HALF_WIDTH,
        `tree at slot ${t.slotIdx} overlaps the road deck (d=${d} ≤ ${FOREST_ROAD_HALF_WIDTH})`);
    }
  });
});

describe('roadTileRibbonWidth — PART 2 forest road narrowing', () => {
  test('FOREST_ROAD_WIDTH_FACTOR is 0.8 (operator-tunable 20% narrower)', () => {
    assert.equal(FOREST_ROAD_WIDTH_FACTOR, 0.8);
  });

  test('road on a forest tile is 0.8× the normal road width', () => {
    const forest = new Tile(0, 0, TileType.FOREST);
    forest.path = PathType.ROAD;
    const w = roadTileRibbonWidth('road', forest, ROAD_RIBBON_WIDTH);
    assert.ok(Math.abs(w - ROAD_RIBBON_WIDTH * 0.8) < 1e-9);
  });

  test('road on a non-forest (grass) tile keeps full width', () => {
    const grass = new Tile(0, 0, TileType.GRASS);
    grass.path = PathType.ROAD;
    const w = roadTileRibbonWidth('road', grass, ROAD_RIBBON_WIDTH);
    assert.equal(w, ROAD_RIBBON_WIDTH);
  });

  test('road on a dirt tile keeps full width', () => {
    const dirt = new Tile(0, 0, TileType.DIRT);
    dirt.path = PathType.ROAD;
    assert.equal(roadTileRibbonWidth('road', dirt, ROAD_RIBBON_WIDTH), ROAD_RIBBON_WIDTH);
  });

  test('river network never narrows, even over a forest base', () => {
    const forest = new Tile(0, 0, TileType.FOREST);
    assert.equal(roadTileRibbonWidth('river', forest, ROAD_RIBBON_WIDTH), ROAD_RIBBON_WIDTH);
  });

  test('forest→grass road: each tile keeps its own width (per-tile rule)', () => {
    const forest = new Tile(0, 0, TileType.FOREST); forest.path = PathType.ROAD;
    const grass  = new Tile(1, 0, TileType.GRASS);  grass.path  = PathType.ROAD;
    const wf = roadTileRibbonWidth('road', forest, ROAD_RIBBON_WIDTH);
    const wg = roadTileRibbonWidth('road', grass,  ROAD_RIBBON_WIDTH);
    assert.ok(wf < wg, 'forest stroke should be narrower than the grass stroke');
    assert.equal(wg, ROAD_RIBBON_WIDTH);
    assert.equal(wf, ROAD_RIBBON_WIDTH * FOREST_ROAD_WIDTH_FACTOR);
  });
});
