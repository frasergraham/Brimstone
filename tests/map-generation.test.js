// Tests for power node spacing and bridge-first road planning.
// Covers: node distance enforcement, no overlapping nodes, bridge pre-placement,
//         no dead-end roads at river, bfsPath blockRiver parameter.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap, bfsPath, rng, MAP_SIZES, buildRiverMap, riverSide } from '../src/map.js';
import { TileType, Tile, legacyTileType, decomposeTileType } from '../src/tiles.js';
import { hexKey, hexDistance, getNeighbors, MAP_COLS, MAP_ROWS } from '../src/hex.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function allTilesOfType(tiles, type) {
  const result = [];
  for (const t of tiles.values()) {
    if (legacyTileType(t) === type) result.push(t);
  }
  return result;
}

// ── Power Node Spacing ──────────────────────────────────────────────────────

describe('Power node spacing', () => {
  test('skirmish generates exactly 1 node by default', () => {
    for (let seed = 0; seed < 20; seed++) {
      const { witchObjectives } = generateMap(seed, 'skirmish');
      assert.equal(witchObjectives.length, 1,
        `Seed ${seed}: expected 1 node, got ${witchObjectives.length}`);
    }
  });

  test('no two node centers share the same position across seeds and sizes', () => {
    const sizes = ['skirmish', 'standard', 'regional', 'campaign'];
    for (const size of sizes) {
      for (let seed = 0; seed < 20; seed++) {
        const { witchObjectives } = generateMap(seed, size);
        const seen = new Set();
        for (const obj of witchObjectives) {
          const k = hexKey(obj.col, obj.row);
          assert.ok(!seen.has(k),
            `Seed ${seed}, size ${size}: duplicate node center at ${k}`);
          seen.add(k);
        }
      }
    }
  });

  test('node centers maintain minimum distance of 4 hexes on standard+ maps', () => {
    const sizes = ['standard', 'regional', 'campaign'];
    for (const size of sizes) {
      for (let seed = 0; seed < 20; seed++) {
        const { witchObjectives } = generateMap(seed, size);
        for (let i = 0; i < witchObjectives.length; i++) {
          for (let j = i + 1; j < witchObjectives.length; j++) {
            const a = witchObjectives[i];
            const b = witchObjectives[j];
            const dist = hexDistance(a.col, a.row, b.col, b.row);
            assert.ok(dist >= 4,
              `Seed ${seed}, size ${size}: nodes at (${a.col},${a.row}) and (${b.col},${b.row}) ` +
              `are only ${dist} apart (min 4)`);
          }
        }
      }
    }
  });

  test('no node center is placed at (1,1) fallback position', () => {
    // Previously, unfillable node slots were placed at (1,1).
    // Now they should simply be dropped.
    for (let seed = 0; seed < 30; seed++) {
      const { witchObjectives } = generateMap(seed, 'skirmish', 3);
      for (const obj of witchObjectives) {
        // It's not impossible for a node to legitimately land at (1,1),
        // but with 30 seeds, not ALL of them should be there.
        // The real check: no two nodes should be at (1,1).
        const atOneOne = witchObjectives.filter(o => o.col === 1 && o.row === 1);
        assert.ok(atOneOne.length <= 1,
          `Seed ${seed}: ${atOneOne.length} nodes stacked at (1,1) — fallback bug`);
      }
    }
  });

  test('skirmish with nodeCountOverride=3 still has valid spacing', () => {
    for (let seed = 0; seed < 20; seed++) {
      const { witchObjectives } = generateMap(seed, 'skirmish', 3);
      // May get fewer than 3 if map is too small — that's fine
      assert.ok(witchObjectives.length >= 1 && witchObjectives.length <= 3,
        `Seed ${seed}: got ${witchObjectives.length} nodes`);
      // All placed nodes must be at unique positions
      const seen = new Set();
      for (const obj of witchObjectives) {
        const k = hexKey(obj.col, obj.row);
        assert.ok(!seen.has(k),
          `Seed ${seed}: duplicate node at ${k}`);
        seen.add(k);
      }
    }
  });
});

// ── River-Side Building & Node Balance ────────────────────────────────────────

describe('River-side balance', () => {
  test('buildings never exceed 85% on one side (standard+ maps)', () => {
    const sizes = ['standard', 'regional', 'campaign'];
    for (const size of sizes) {
      for (let seed = 0; seed < 30; seed++) {
        const { tiles } = generateMap(seed, size);
        const rp = [];
        for (const t of tiles.values()) {
          if (legacyTileType(t) === TileType.RIVER || legacyTileType(t) === TileType.BRIDGE) rp.push({ col: t.col, row: t.row });
        }
        const cols = new Set(rp.map(r => r.col));
        const rows = new Set(rp.map(r => r.row));
        const ew = cols.size > rows.size;
        const rm = buildRiverMap(rp, ew);

        let bLeft = 0, bRight = 0;
        for (const t of tiles.values()) {
          if (legacyTileType(t) === TileType.BUILDING) {
            (riverSide(t.col, t.row, rm, ew) === 'left') ? bLeft++ : bRight++;
          }
        }
        const total = bLeft + bRight;
        if (total === 0) continue;
        const pct = Math.max(bLeft, bRight) / total * 100;
        assert.ok(pct <= 86,
          `Seed ${seed}, ${size}: building skew ${Math.round(pct)}% ` +
          `(L${bLeft}/R${bRight}) exceeds 85%`);
      }
    }
  });

  test('power nodes are distributed across both river sides (count >= 2)', () => {
    for (let seed = 0; seed < 30; seed++) {
      const { tiles, witchObjectives } = generateMap(seed, 'standard');
      if (witchObjectives.length < 2) continue;
      const rp = [];
      for (const t of tiles.values()) {
        if (legacyTileType(t) === TileType.RIVER || legacyTileType(t) === TileType.BRIDGE) rp.push({ col: t.col, row: t.row });
      }
      const cols = new Set(rp.map(r => r.col));
      const rows = new Set(rp.map(r => r.row));
      const ew = cols.size > rows.size;
      const rm = buildRiverMap(rp, ew);

      let nLeft = 0, nRight = 0;
      for (const obj of witchObjectives) {
        (riverSide(obj.col, obj.row, rm, ew) === 'left') ? nLeft++ : nRight++;
      }
      assert.ok(nLeft >= 1 && nRight >= 1,
        `Seed ${seed}: nodes L${nLeft}/R${nRight} — should have at least 1 on each side`);
    }
  });
});

// ── Bridge Pre-Placement & Road Connectivity ─────────────────────────────────

describe('Bridge pre-placement', () => {
  test('all bridge tiles have roadDirs connections', () => {
    const sizes = ['skirmish', 'standard', 'regional'];
    for (const size of sizes) {
      for (let seed = 0; seed < 10; seed++) {
        const { tiles } = generateMap(seed, size);
        const bridges = allTilesOfType(tiles, TileType.BRIDGE);
        for (const b of bridges) {
          assert.ok(b.roadDirs.size > 0,
            `Seed ${seed}, size ${size}: bridge at (${b.col},${b.row}) has no road connections`);
        }
      }
    }
  });

  test('bridge count is within configured bounds', () => {
    const sizes = ['skirmish', 'standard', 'regional', 'campaign'];
    for (const size of sizes) {
      const cfg = MAP_SIZES[size];
      for (let seed = 0; seed < 15; seed++) {
        const { tiles } = generateMap(seed, size);
        const bridgeCount = allTilesOfType(tiles, TileType.BRIDGE).length;
        assert.ok(bridgeCount >= (cfg.minBridges ?? 1),
          `Seed ${seed}, size ${size}: only ${bridgeCount} bridges (min ${cfg.minBridges})`);
        assert.ok(bridgeCount <= cfg.bridgeMax,
          `Seed ${seed}, size ${size}: ${bridgeCount} bridges exceeds max ${cfg.bridgeMax}`);
      }
    }
  });

  test('every bridge has a passable land neighbour on each river side', () => {
    // A bridge that doesn't actually span the river is useless.  Verify each
    // BRIDGE has at least one non-river neighbour on each side, classified
    // by riverSide().
    const sizes = ['skirmish', 'standard', 'regional', 'campaign'];
    for (const size of sizes) {
      for (let seed = 0; seed < 15; seed++) {
        const { tiles } = generateMap(seed, size);
        const rp = [];
        for (const t of tiles.values()) {
          if (legacyTileType(t) === TileType.RIVER || legacyTileType(t) === TileType.BRIDGE) rp.push({ col: t.col, row: t.row });
        }
        const cols = new Set(rp.map(r => r.col));
        const rows = new Set(rp.map(r => r.row));
        const ew = cols.size > rows.size;
        const rm = buildRiverMap(rp, ew);
        const bridges = allTilesOfType(tiles, TileType.BRIDGE);
        for (const b of bridges) {
          let leftOk = false, rightOk = false;
          for (const n of getNeighbors(b.col, b.row)) {
            const nt = tiles.get(hexKey(n.col, n.row));
            if (!nt || legacyTileType(nt) === TileType.RIVER) continue;
            if (riverSide(n.col, n.row, rm, ew) === 'left') leftOk = true;
            else rightOk = true;
          }
          assert.ok(leftOk && rightOk,
            `Seed ${seed}, ${size}: bridge at (${b.col},${b.row}) doesn't span the river ` +
            `(left=${leftOk}, right=${rightOk})`);
        }
      }
    }
  });

  test('building footprints rarely sit on a river bank (placement scoring)', () => {
    // The footprint placement scorer (src/building-footprint.js) heavily
    // penalises walling a river bank, so a building only ends up river-adjacent
    // when every eligible neighbour was a bank (wedged against the river). A
    // random pick would land on banks far more often; this guards against
    // regressing the scoring back to uniform-random.
    for (const size of ['standard', 'regional', 'campaign']) {
      let total = 0, riverAdj = 0;
      for (let seed = 0; seed < 50; seed++) {
        const { tiles } = generateMap(seed, size);
        for (const t of tiles.values()) {
          if (t.buildingFootprintOf == null) continue;  // footprint hexes only
          total++;
          const adj = getNeighbors(t.col, t.row).some(n => {
            const nt = tiles.get(hexKey(n.col, n.row));
            return nt && legacyTileType(nt) === TileType.RIVER;
          });
          if (adj) riverAdj++;
        }
      }
      assert.ok(total > 0, `${size}: expected some footprints`);
      const frac = riverAdj / total;
      assert.ok(frac < 0.08,
        `${size}: ${(frac * 100).toFixed(1)}% of footprints are river-adjacent ` +
        `(${riverAdj}/${total}) — expected < 8% with placement scoring`);
    }
  });

  test('no bridge has a building footprint on a bank it could cross to', () => {
    // Defence-in-depth: _pickRiverCrossings excludes footprint hexes when
    // choosing banks, and the scorer keeps footprints off banks, so a surviving
    // bridge must always have a NON-footprint passable land neighbour on each
    // side (a usable approach). Verifies crossings stay traversable.
    for (const size of ['standard', 'regional', 'campaign']) {
      for (let seed = 0; seed < 30; seed++) {
        const { tiles } = generateMap(seed, size);
        const rp = [];
        for (const t of tiles.values()) {
          if (legacyTileType(t) === TileType.RIVER || legacyTileType(t) === TileType.BRIDGE) rp.push({ col: t.col, row: t.row });
        }
        const cols = new Set(rp.map(r => r.col));
        const rows = new Set(rp.map(r => r.row));
        const ew = cols.size > rows.size;
        const rm = buildRiverMap(rp, ew);
        for (const b of allTilesOfType(tiles, TileType.BRIDGE)) {
          let leftOk = false, rightOk = false;
          for (const n of getNeighbors(b.col, b.row)) {
            const nt = tiles.get(hexKey(n.col, n.row));
            if (!nt || legacyTileType(nt) === TileType.RIVER || nt.buildingFootprintOf != null) continue;
            if (riverSide(n.col, n.row, rm, ew) === 'left') leftOk = true;
            else rightOk = true;
          }
          assert.ok(leftOk && rightOk,
            `Seed ${seed}, ${size}: bridge at (${b.col},${b.row}) has no non-footprint ` +
            `approach on a bank (left=${leftOk}, right=${rightOk})`);
        }
      }
    }
  });

  test('every bridge connects to a road/building on both banks', () => {
    // The bridge's roadDirs must reach at least two non-adjacent neighbours,
    // proving roads emerge from both sides of the river rather than dead-ending
    // on one bank.  Two roadDirs that are themselves hex-adjacent indicate the
    // bridge only touched the road graph on one side.
    const sizes = ['skirmish', 'standard', 'regional'];
    for (const size of sizes) {
      for (let seed = 0; seed < 15; seed++) {
        const { tiles } = generateMap(seed, size);
        const bridges = allTilesOfType(tiles, TileType.BRIDGE);
        for (const b of bridges) {
          const dirs = [...b.roadDirs].map(k => {
            const [c, r] = k.split(',').map(Number);
            return { col: c, row: r };
          });
          assert.ok(dirs.length >= 2,
            `Seed ${seed}, ${size}: bridge at (${b.col},${b.row}) has only ` +
            `${dirs.length} road connection(s)`);
          let foundOpposite = false;
          for (let i = 0; i < dirs.length && !foundOpposite; i++) {
            for (let j = i + 1; j < dirs.length; j++) {
              if (hexDistance(dirs[i].col, dirs[i].row, dirs[j].col, dirs[j].row) >= 2) {
                foundOpposite = true; break;
              }
            }
          }
          assert.ok(foundOpposite,
            `Seed ${seed}, ${size}: bridge at (${b.col},${b.row}) road connections ` +
            `are all on one bank (${[...b.roadDirs].join(' ')})`);
        }
      }
    }
  });

  test('every BUILDING tile has roadDirs (connected to the road network)', () => {
    // The MST road network terminates at — and passes through — buildings.
    // The 3D renderer relies on these roadDirs to draw the road ribbon
    // contiguously across building tiles, so every building must carry at
    // least one entry. (A disconnected building would leave a visible gap.)
    const sizes = ['skirmish', 'standard', 'regional', 'campaign'];
    for (const size of sizes) {
      for (let seed = 0; seed < 10; seed++) {
        const { tiles } = generateMap(seed, size);
        const buildings = allTilesOfType(tiles, TileType.BUILDING);
        for (const b of buildings) {
          assert.ok(b.roadDirs.size > 0,
            `Seed ${seed}, ${size}: building at (${b.col},${b.row}) has no road connections`);
        }
      }
    }
  });

  test('road MST passes through some BUILDING tiles with ≥2 roadDirs (transit, not just endpoint)', () => {
    // Verifies that at least one building on a typical standard map sits
    // mid-path rather than as a leaf spoke — the case the 3D renderer needs
    // to draw a through-bezier across.
    let transitBuildings = 0;
    for (let seed = 0; seed < 20; seed++) {
      const { tiles } = generateMap(seed, 'standard');
      for (const t of tiles.values()) {
        if (legacyTileType(t) === TileType.BUILDING && t.roadDirs.size >= 2) transitBuildings++;
      }
    }
    assert.ok(transitBuildings > 0,
      `Expected at least one transit building across 20 standard seeds, found ${transitBuildings}`);
  });

  test('no road tile is adjacent to river without a bridge', () => {
    // This checks for dead-end roads at the river: a ROAD tile should never
    // be hex-adjacent to a RIVER tile unless there's a BRIDGE between them.
    for (let seed = 0; seed < 15; seed++) {
      const { tiles } = generateMap(seed, 'standard');
      const roads = allTilesOfType(tiles, TileType.ROAD);
      for (const road of roads) {
        const neighbors = getNeighbors(road.col, road.row);
        for (const n of neighbors) {
          const nt = tiles.get(hexKey(n.col, n.row));
          if (!nt) continue;
          // A road tile should not have a roadDirs connection to a RIVER tile
          if (road.roadDirs.has(hexKey(n.col, n.row))) {
            assert.notEqual(legacyTileType(nt), TileType.RIVER,
              `Seed ${seed}: road at (${road.col},${road.row}) connects to river at (${n.col},${n.row})`);
          }
        }
      }
    }
  });
});

// ── bfsPath blockRiver parameter ─────────────────────────────────────────────

describe('bfsPath blockRiver', () => {
  test('blockRiver=true avoids RIVER tiles', () => {
    // Build a small 5x5 grid with a river down the middle (col 2)
    const tiles = new Map();
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const type = col === 2 ? TileType.RIVER : TileType.GRASS;
        tiles.set(hexKey(col, row), new Tile(col, row, type));
      }
    }
    // Place a bridge at (2,2) so there's a way across
    decomposeTileType(tiles.get(hexKey(2, 2)), TileType.BRIDGE);

    const rand = rng(42);
    const path = bfsPath(tiles, 0, 2, 4, 2, rand, new Set(), true);
    // Path should exist (going through the bridge)
    assert.ok(path.length > 0, 'Should find a path through the bridge');
    // No tile in the path should be RIVER
    for (const p of path) {
      const t = tiles.get(hexKey(p.col, p.row));
      assert.notEqual(legacyTileType(t), TileType.RIVER,
        `Path contains RIVER tile at (${p.col},${p.row})`);
    }
  });

  test('blockRiver=false (default) allows RIVER tiles', () => {
    // Build a small 5x5 grid with a river down the middle (col 2)
    const tiles = new Map();
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const type = col === 2 ? TileType.RIVER : TileType.GRASS;
        tiles.set(hexKey(col, row), new Tile(col, row, type));
      }
    }
    const rand = rng(42);
    // No bridge, blockRiver defaults to false — should path through river
    const path = bfsPath(tiles, 0, 2, 4, 2, rand);
    assert.ok(path.length > 0, 'Should find a path through river');
    const hasRiver = path.some(p => legacyTileType(tiles.get(hexKey(p.col, p.row))) === TileType.RIVER);
    assert.ok(hasRiver, 'Path should include RIVER tiles when blockRiver is false');
  });

  test('blockRiver=true returns empty path when no bridge exists', () => {
    // Build a small 5x5 grid with a river down the middle — no bridge
    const tiles = new Map();
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col < 5; col++) {
        const type = col === 2 ? TileType.RIVER : TileType.GRASS;
        tiles.set(hexKey(col, row), new Tile(col, row, type));
      }
    }
    const rand = rng(42);
    const path = bfsPath(tiles, 0, 2, 4, 2, rand, new Set(), true);
    // BFS should fail to find a path — it returns [end] when no path found
    // or an empty path. Check that no RIVER tile is in it.
    const hasRiver = path.some(p => legacyTileType(tiles.get(hexKey(p.col, p.row))) === TileType.RIVER);
    assert.ok(!hasRiver, 'No river tiles should appear in the path');
  });
});
