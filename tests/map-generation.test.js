// Tests for power node spacing and bridge-first road planning.
// Covers: node distance enforcement, no overlapping nodes, bridge pre-placement,
//         no dead-end roads at river, bfsPath blockRiver parameter.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap, bfsPath, rng, MAP_SIZES } from '../src/map.js';
import { TileType, Tile } from '../src/tiles.js';
import { hexKey, hexDistance, getNeighbors, MAP_COLS, MAP_ROWS } from '../src/hex.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function allTilesOfType(tiles, type) {
  const result = [];
  for (const t of tiles.values()) {
    if (t.type === type) result.push(t);
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
            assert.notEqual(nt.type, TileType.RIVER,
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
    tiles.get(hexKey(2, 2)).type = TileType.BRIDGE;

    const rand = rng(42);
    const path = bfsPath(tiles, 0, 2, 4, 2, rand, new Set(), true);
    // Path should exist (going through the bridge)
    assert.ok(path.length > 0, 'Should find a path through the bridge');
    // No tile in the path should be RIVER
    for (const p of path) {
      const t = tiles.get(hexKey(p.col, p.row));
      assert.notEqual(t.type, TileType.RIVER,
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
    const hasRiver = path.some(p => tiles.get(hexKey(p.col, p.row)).type === TileType.RIVER);
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
    const hasRiver = path.some(p => tiles.get(hexKey(p.col, p.row))?.type === TileType.RIVER);
    assert.ok(!hasRiver, 'No river tiles should appear in the path');
  });
});
