// Tests for P2 of the building-footprint rework:
//   • src/building-footprint.js — the shared eligibility helper
//     (eligibleFootprintNeighbors / pickFootprintNeighbor), incl. road exclusion.
//   • src/map.js — procedural generation claims one footprint hex per building
//     and rolls back any building that can't (so the map is one fewer building).
//
// The P0+P1 model/serialization/migration tests live in
// tests/building-footprint-model.test.js.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { getNeighbors, hexKey, setMapDimensions } from '../src/hex.js';
import {
  Tile, TileType, BuildingType, PathType, StructureType,
  hasBuilding, isBuildingEntrance, isBuildingFootprint,
} from '../src/tiles.js';
import {
  eligibleFootprintNeighbors, pickFootprintNeighbor,
} from '../src/building-footprint.js';
import { generateMap } from '../src/map.js';

// Build a small all-grass tiles Map (cols × rows). Returns { tiles } so it can
// be passed straight to the helper as a `state`-like object.
function grassWorld(cols, rows) {
  const tiles = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.set(hexKey(c, r), new Tile(c, r, TileType.GRASS));
    }
  }
  return tiles;
}

// ── Helper: eligibility rules ────────────────────────────────────────────────
describe('building-footprint helper — eligibleFootprintNeighbors', () => {
  test('all-grass interior tile → every odd-r neighbour eligible, in direction order', () => {
    const tiles = grassWorld(11, 11);
    const got = eligibleFootprintNeighbors(tiles, 5, 5);
    const expected = getNeighbors(5, 5); // odd-r direction order 0..5
    assert.deepEqual(got, expected, 'eligible neighbours match getNeighbors order exactly');
    assert.equal(got.length, 6, 'interior tile has all 6 neighbours');
  });

  test('excludes river / bridge / road paths', () => {
    const tiles = grassWorld(11, 11);
    // Neighbours of (5,5) in odd-r order — tag three of them.
    const nb = getNeighbors(5, 5);
    tiles.get(hexKey(nb[0].col, nb[0].row)).path = PathType.RIVER;
    tiles.get(hexKey(nb[1].col, nb[1].row)).path = PathType.BRIDGE;
    tiles.get(hexKey(nb[2].col, nb[2].row)).path = PathType.ROAD;
    const got = eligibleFootprintNeighbors(tiles, 5, 5);
    const keys = got.map(p => hexKey(p.col, p.row));
    assert.ok(!keys.includes(hexKey(nb[0].col, nb[0].row)), 'river excluded');
    assert.ok(!keys.includes(hexKey(nb[1].col, nb[1].row)), 'bridge excluded');
    assert.ok(!keys.includes(hexKey(nb[2].col, nb[2].row)), 'road excluded');
    assert.equal(got.length, 3, 'remaining 3 neighbours still eligible');
  });

  test('excludes river base material (defensive)', () => {
    const tiles = grassWorld(11, 11);
    const nb = getNeighbors(5, 5);
    tiles.get(hexKey(nb[0].col, nb[0].row)).base = TileType.RIVER;
    const got = eligibleFootprintNeighbors(tiles, 5, 5);
    assert.ok(!got.some(p => p.col === nb[0].col && p.row === nb[0].row));
  });

  test('excludes another building entrance and an already-claimed footprint', () => {
    const tiles = grassWorld(11, 11);
    const nb = getNeighbors(5, 5);
    tiles.get(hexKey(nb[0].col, nb[0].row)).building = BuildingType.INN;
    tiles.get(hexKey(nb[1].col, nb[1].row)).buildingFootprintOf = '9,9';
    const got = eligibleFootprintNeighbors(tiles, 5, 5);
    const keys = got.map(p => hexKey(p.col, p.row));
    assert.ok(!keys.includes(hexKey(nb[0].col, nb[0].row)), 'building entrance excluded');
    assert.ok(!keys.includes(hexKey(nb[1].col, nb[1].row)), 'claimed footprint excluded');
  });

  test('excludes power-node hexes via opts.nodeKeySet', () => {
    const tiles = grassWorld(11, 11);
    const nb = getNeighbors(5, 5);
    const nodeKey = hexKey(nb[0].col, nb[0].row);
    const got = eligibleFootprintNeighbors(tiles, 5, 5, { nodeKeySet: new Set([nodeKey]) });
    assert.ok(!got.some(p => hexKey(p.col, p.row) === nodeKey), 'node hex excluded');
  });

  test('excludes power-node hexes derived from state.witchObjectives', () => {
    const tiles = grassWorld(11, 11);
    const nb = getNeighbors(5, 5);
    const node = nb[0];
    const state = { tiles, witchObjectives: [{ col: node.col, row: node.row, hexes: [{ col: node.col, row: node.row }] }] };
    const got = eligibleFootprintNeighbors(state, 5, 5);
    assert.ok(!got.some(p => p.col === node.col && p.row === node.row));
  });

  test('excludes out-of-bounds / missing tiles', () => {
    const tiles = grassWorld(11, 11);
    // Corner tile (0,0): its negative-direction neighbours don't exist as tiles.
    const got = eligibleFootprintNeighbors(tiles, 0, 0);
    for (const p of got) {
      assert.ok(tiles.has(hexKey(p.col, p.row)), 'every returned hex exists in the map');
    }
    // None should be off the 11×11 grid.
    for (const p of got) {
      assert.ok(p.col >= 0 && p.row >= 0 && p.col < 11 && p.row < 11);
    }
  });

  test('surrounded entrance (all neighbours river) → no eligible neighbours', () => {
    const tiles = grassWorld(11, 11);
    for (const n of getNeighbors(5, 5)) tiles.get(hexKey(n.col, n.row)).path = PathType.RIVER;
    assert.deepEqual(eligibleFootprintNeighbors(tiles, 5, 5), []);
  });

  test('accepts a GameState-like {tiles} object and a raw Map equivalently', () => {
    const tiles = grassWorld(11, 11);
    const viaMap   = eligibleFootprintNeighbors(tiles, 5, 5);
    const viaState = eligibleFootprintNeighbors({ tiles }, 5, 5);
    assert.deepEqual(viaState, viaMap);
  });
});

// ── Helper: pickFootprintNeighbor ─────────────────────────────────────────────
describe('building-footprint helper — pickFootprintNeighbor', () => {
  test('no rand → returns the FIRST eligible neighbour (deterministic)', () => {
    const tiles = grassWorld(11, 11);
    const first = eligibleFootprintNeighbors(tiles, 5, 5)[0];
    assert.deepEqual(pickFootprintNeighbor(tiles, 5, 5), first);
  });

  test('with rand → returns the rand-indexed eligible neighbour', () => {
    const tiles = grassWorld(11, 11);
    const eligible = eligibleFootprintNeighbors(tiles, 5, 5);
    // rand = 0.5 → index floor(0.5 * 6) = 3
    const rand = () => 0.5;
    assert.deepEqual(pickFootprintNeighbor(tiles, 5, 5, rand), eligible[3]);
    // rand just under 1 → last index, never out of range
    assert.deepEqual(pickFootprintNeighbor(tiles, 5, 5, () => 0.999), eligible[eligible.length - 1]);
    // rand = 0 → first
    assert.deepEqual(pickFootprintNeighbor(tiles, 5, 5, () => 0), eligible[0]);
  });

  test('returns null when nothing is eligible (does not call rand)', () => {
    const tiles = grassWorld(11, 11);
    for (const n of getNeighbors(5, 5)) tiles.get(hexKey(n.col, n.row)).path = PathType.RIVER;
    let called = false;
    const rand = () => { called = true; return 0; };
    assert.equal(pickFootprintNeighbor(tiles, 5, 5, rand), null);
    assert.equal(called, false, 'rand is not consumed when no neighbour is eligible');
  });
});

// ── map.js: generated maps wire footprints correctly ──────────────────────────
describe('building-footprint procgen — generated map invariants', () => {
  const SIZES = ['skirmish', 'standard', 'regional'];

  test('every building is an entrance with a valid, unique footprint', () => {
    for (const size of SIZES) {
      for (let seed = 1; seed <= 25; seed++) {
        const { tiles } = generateMap(seed, size);
        const claimedFootprints = new Set();
        for (const t of tiles.values()) {
          if (!hasBuilding(t)) continue;
          // Buildings are entrances with a non-empty footprint list.
          assert.ok(isBuildingEntrance(t),
            `${size}/${seed}: building at ${t.col},${t.row} must be an entrance`);
          assert.equal(t.footprintHexes.length, 1,
            `${size}/${seed}: entrance carries exactly one footprint hex`);
          const fpKey = t.footprintHexes[0];
          const fp = tiles.get(fpKey);
          assert.ok(fp, `${size}/${seed}: footprint hex ${fpKey} exists in-bounds`);
          // Back-pointer matches the entrance.
          assert.equal(fp.buildingFootprintOf, hexKey(t.col, t.row),
            `${size}/${seed}: footprint back-points at its entrance`);
          assert.ok(isBuildingFootprint(fp));
          // Footprint is not itself a building, not river/bridge/road.
          assert.equal(fp.building, null, `${size}/${seed}: footprint is not a building`);
          assert.notEqual(fp.path, PathType.RIVER);
          assert.notEqual(fp.path, PathType.BRIDGE);
          // No two buildings share a footprint hex.
          assert.ok(!claimedFootprints.has(fpKey),
            `${size}/${seed}: footprint ${fpKey} claimed by two buildings`);
          claimedFootprints.add(fpKey);
        }
      }
    }
  });

  test('no building entrance is left without a footprint (rolled-back ones are gone)', () => {
    for (const size of SIZES) {
      for (let seed = 1; seed <= 25; seed++) {
        const { tiles } = generateMap(seed, size);
        for (const t of tiles.values()) {
          if (hasBuilding(t)) {
            assert.ok(t.footprintHexes.length > 0,
              `${size}/${seed}: a building survived with an empty footprint`);
          }
        }
      }
    }
  });

  test('a wedged building rolls back and fully restores its tile', () => {
    // The footprint scorer steers footprints away from one another, which also
    // frees later buildings' neighbours — so natural rollbacks are now rare. The
    // rollback path must still fire and FULLY restore the tile when a building is
    // wedged with no eligible footprint neighbour. These skirmish seeds were
    // observed to surface exactly one such wedged building. (If placement density
    // or the scorer is retuned these may shift — find new ones via
    // `generateMap(seed, 'skirmish').buildingRollbacks > 0`.)
    const ROLLBACK_SEEDS = [1812, 1871];
    for (const seed of ROLLBACK_SEEDS) {
      assert.ok(generateMap(seed, 'skirmish').buildingRollbacks > 0,
        `skirmish/${seed}: expected at least one building rollback`);
    }

    // A rolled-back entrance must have its FULL pre-pass-1 terrain restored —
    // base/structure/path AND building/footprint metadata reverted together, not
    // merely `building` cleared. Assert the whole map stays internally consistent
    // so a half-reverted tile (structure still BUILDING, a stale footprintHexes
    // list, or an invalid base/path) is caught. Run on the rollback seeds (where
    // the restore path actually executes) plus a wide range for general integrity.
    const TERRAIN_BASES = new Set([TileType.GRASS, TileType.DIRT, TileType.FOREST, TileType.RIVER]);
    const VALID_PATHS   = new Set([null, PathType.ROAD, PathType.BRIDGE, PathType.RIVER]);
    const cases = [
      ...ROLLBACK_SEEDS.map(seed => ({ size: 'skirmish', seed })),
    ];
    for (const size of ['skirmish', 'standard', 'regional', 'campaign']) {
      for (let seed = 0; seed < 30; seed++) cases.push({ size, seed });
    }
    for (const { size, seed } of cases) {
      const { tiles } = generateMap(seed, size);
      for (const t of tiles.values()) {
        // structure===BUILDING and building!=null are set/reverted as a pair.
        assert.equal(t.structure === StructureType.BUILDING, t.building != null,
          `${size}/${seed}: tile ${t.col},${t.row} has mismatched structure/building (partial rollback)`);
        if (!hasBuilding(t)) {
          assert.equal((t.footprintHexes ?? []).length, 0,
            `${size}/${seed}: non-building tile ${t.col},${t.row} kept stale footprintHexes`);
          assert.ok(TERRAIN_BASES.has(t.base),
            `${size}/${seed}: tile ${t.col},${t.row} left with invalid base ${t.base}`);
          assert.ok(VALID_PATHS.has(t.path),
            `${size}/${seed}: tile ${t.col},${t.row} left with invalid path ${t.path}`);
        }
      }
    }
  });

  test('deterministic — same seed yields an identical building + footprint layout', () => {
    const snapshot = (tiles) => {
      const rows = [];
      for (const t of tiles.values()) {
        if (!hasBuilding(t) && !isBuildingFootprint(t)) continue;
        rows.push({
          col: t.col, row: t.row,
          building: t.building ?? null,
          footprintHexes: [...(t.footprintHexes ?? [])],
          buildingFootprintOf: t.buildingFootprintOf ?? null,
        });
      }
      rows.sort((a, b) => a.row - b.row || a.col - b.col);
      return rows;
    };
    for (const size of ['skirmish', 'standard']) {
      const a = snapshot(generateMap(12345, size).tiles);
      const b = snapshot(generateMap(12345, size).tiles);
      assert.deepEqual(a, b, `${size}: same seed → identical footprint layout`);
    }
  });

  test('100-map regression — mean building count within 30% of the pre-P2 baseline', () => {
    // Pre-P2 mean (dev tip, 100 standard maps, seeds s*1000+7) measured at 13.10.
    // Footprints land on open terrain on standard maps, so rollback is rare and
    // the mean should barely move; assert it stays ≥ 70% of the baseline.
    const PRE_P2_MEAN = 13.10;
    let total = 0;
    const N = 100;
    for (let s = 1; s <= N; s++) {
      const { tiles } = generateMap(s * 1000 + 7, 'standard');
      let c = 0;
      for (const t of tiles.values()) if (hasBuilding(t)) c++;
      total += c;
    }
    const mean = total / N;
    assert.ok(mean >= 0.70 * PRE_P2_MEAN,
      `mean building count ${mean.toFixed(2)} dropped >30% below baseline ${PRE_P2_MEAN}`);
  });
});

// ── map.js: footprints excluded from nodes & roads ───────────────────────────
// P2 revision (Reviewer Quinn): a node center/satellite on an impassable
// footprint would be unreachable/uncontestable once P3 lands; a road drawn over
// a footprint hex is severed and visually wrong. Both must never happen.
describe('building-footprint procgen — node & road exclusions', () => {
  // 50-seed sweep of standard (roomy) + skirmish (tight maps where rollback and
  // wedged placements are most likely to surface an edge case).
  const SWEEP = [
    { size: 'standard', seeds: 50 },
    { size: 'skirmish', seeds: 50 },
  ];

  test('no generated tile is both a footprint and a node center/satellite', () => {
    for (const { size, seeds } of SWEEP) {
      for (let seed = 1; seed <= seeds; seed++) {
        const { tiles, witchObjectives } = generateMap(seed, size);
        for (const obj of witchObjectives) {
          // The cluster `hexes` already includes the center as its first entry,
          // but assert the center explicitly too for belt-and-braces.
          const nodeHexes = [{ col: obj.col, row: obj.row }, ...(obj.hexes ?? [])];
          for (const h of nodeHexes) {
            const t = tiles.get(hexKey(h.col, h.row));
            assert.ok(t, `${size}/${seed}: node hex ${h.col},${h.row} exists`);
            assert.ok(!isBuildingFootprint(t),
              `${size}/${seed}: node hex ${h.col},${h.row} landed on a building footprint`);
          }
        }
      }
    }
  });

  test('no generated tile is both a footprint and a road/bridge path', () => {
    for (const { size, seeds } of SWEEP) {
      for (let seed = 1; seed <= seeds; seed++) {
        const { tiles } = generateMap(seed, size);
        for (const t of tiles.values()) {
          if (!isBuildingFootprint(t)) continue;
          assert.notEqual(t.path, PathType.ROAD,
            `${size}/${seed}: footprint ${t.col},${t.row} has a ROAD path`);
          assert.notEqual(t.path, PathType.BRIDGE,
            `${size}/${seed}: footprint ${t.col},${t.row} has a BRIDGE path`);
        }
      }
    }
  });

  test('deterministic — same seed yields a byte-identical full map (tiles + nodes + roads)', () => {
    // The footprint exclusions reshape WHERE roads/nodes go, so a same-seed map
    // may differ from the pre-fix output (expected). What must hold: running the
    // SAME seed twice AFTER the fix produces an identical map — tile terrain,
    // road links, footprints, and node placement all reproducible.
    const fullSnapshot = (result) => {
      const rows = [];
      for (const t of result.tiles.values()) {
        rows.push({
          col: t.col, row: t.row,
          base: t.base ?? null,
          structure: t.structure ?? null,
          path: t.path ?? null,
          building: t.building ?? null,
          footprintHexes: [...(t.footprintHexes ?? [])].sort(),
          buildingFootprintOf: t.buildingFootprintOf ?? null,
          roadDirs: [...(t.roadDirs ?? [])].sort(),
        });
      }
      rows.sort((a, b) => a.row - b.row || a.col - b.col);
      const nodes = result.witchObjectives.map(o => ({
        col: o.col, row: o.row,
        hexes: (o.hexes ?? []).map(h => `${h.col},${h.row}`),
      }));
      return { rows, nodes };
    };
    for (const size of ['standard', 'skirmish']) {
      const a = fullSnapshot(generateMap(98765, size));
      const b = fullSnapshot(generateMap(98765, size));
      assert.deepEqual(a, b, `${size}: same seed → byte-identical full map`);
    }
  });
});

// Restore a sane default map dimension after generateMap mutated the global.
setMapDimensions(13, 13);
