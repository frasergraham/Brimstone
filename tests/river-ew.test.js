import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../src/map.js';
import { TileType, legacyTileType } from '../src/tiles.js';
import { hexKey, getNeighbors, MAP_COLS, MAP_ROWS } from '../src/hex.js';

// Extract river tiles from a generated map (BRIDGE tiles are river crossings,
// still part of the river path for detection purposes).
function getRiverTiles(tiles) {
  const river = [];
  for (const t of tiles.values()) {
    if (legacyTileType(t) === TileType.RIVER || legacyTileType(t) === TileType.BRIDGE) river.push({ col: t.col, row: t.row });
  }
  return river;
}

// Generate maps until we get an E-W river (river spans all columns)
function generateEWRiverMap(startSeed) {
  for (let seed = startSeed; seed < startSeed + 200; seed++) {
    const { tiles } = generateMap(seed, 'standard');
    const river = getRiverTiles(tiles);
    const cols = new Set(river.map(t => t.col));
    // E-W river should span all columns
    if (cols.size === MAP_COLS) return { tiles, river, seed };
  }
  return null;
}

describe('E-W river generation', () => {
  test('all river tiles are hex-adjacent to at least one other river tile', () => {
    const result = generateEWRiverMap(1);
    assert.ok(result, 'should find an E-W river within 200 seeds');
    const { river } = result;
    const riverSet = new Set(river.map(t => hexKey(t.col, t.row)));

    for (const t of river) {
      const nbrs = getNeighbors(t.col, t.row);
      const riverNbrs = nbrs.filter(n => riverSet.has(hexKey(n.col, n.row)));
      assert.ok(riverNbrs.length >= 1,
        `River tile (${t.col},${t.row}) has no river neighbors`);
    }
  });

  test('river spans all columns', () => {
    const result = generateEWRiverMap(1);
    assert.ok(result);
    const cols = new Set(result.river.map(t => t.col));
    for (let c = 0; c < MAP_COLS; c++) {
      assert.ok(cols.has(c), `Column ${c} should have a river tile`);
    }
  });

  test('endpoints have 1 river neighbor, interior tiles have 2', () => {
    const result = generateEWRiverMap(1);
    assert.ok(result);
    const { river } = result;
    const riverSet = new Set(river.map(t => hexKey(t.col, t.row)));

    for (const t of river) {
      const nbrs = getNeighbors(t.col, t.row);
      const riverNbrs = nbrs.filter(n => riverSet.has(hexKey(n.col, n.row)));
      assert.ok(riverNbrs.length >= 1 && riverNbrs.length <= 2,
        `River tile (${t.col},${t.row}) has ${riverNbrs.length} river neighbors, expected 1-2`);
    }
  });

  test('river tiles stay within safe bounds', () => {
    for (let seed = 1; seed < 500; seed += 7) {
      const { tiles } = generateMap(seed, 'standard');
      const river = getRiverTiles(tiles);
      const cols = new Set(river.map(t => t.col));
      if (cols.size !== MAP_COLS) continue; // skip N-S rivers
      for (const t of river) {
        assert.ok(t.row >= 0 && t.row < MAP_ROWS,
          `seed ${seed}: tile (${t.col},${t.row}) out of bounds`);
      }
    }
  });

  test('E-W rivers have meaningful row variance (not straight)', () => {
    const variances = [];
    for (let seed = 1; seed < 2000; seed++) {
      const { tiles } = generateMap(seed, 'standard');
      const river = getRiverTiles(tiles);
      const cols = new Set(river.map(t => t.col));
      if (cols.size !== MAP_COLS) continue; // skip N-S rivers

      const rows = river.map(t => t.row);
      const mean = rows.reduce((a, b) => a + b, 0) / rows.length;
      const variance = rows.reduce((s, r) => s + (r - mean) ** 2, 0) / rows.length;
      variances.push(variance);
      if (variances.length >= 30) break;
    }
    assert.ok(variances.length >= 10, 'should find enough E-W rivers to test');
    const avgVariance = variances.reduce((a, b) => a + b, 0) / variances.length;
    assert.ok(avgVariance > 0.3,
      `Average row variance ${avgVariance.toFixed(3)} is too low — rivers are too straight`);
  });
});
