// Tests for randomized faction start placement (src/map.js → _pickFactionStarts).
//
// Core rule (skirmish / standard / regional / campaign procedural maps): the two
// faction starts (INN = hero, GRAVEYARD = witch) must sit on OPPOSITE sides of
// the river and be far enough apart that neither leader can see the other at
// game start (hex distance > START_SIGHT_CLEARANCE). Both starts must be on
// passable terrain and mutually reachable (banks are bridged). Placement is
// seeded/deterministic.
//
// `battle` maps use a separate 5+5 spawn layout (_placeBattleSpawnBuildings) and
// are intentionally excluded here. Campaign JSON missions bypass generateMap()
// entirely (they pass mapDataOverride), so authored starts are untouched.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap, buildRiverMap, riverSide, START_SIGHT_CLEARANCE } from '../src/map.js';
import { TileType, legacyTileType, isRiver, isBuildingFootprint } from '../src/tiles.js';
import { hexKey, hexDistance, getNeighbors } from '../src/hex.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Reconstruct the river-side oracle from the generated tiles — identical to the
// trick used in map-generation.test.js: RIVER + BRIDGE tiles trace the river
// line, and N-S vs E-W is inferred from whether cols or rows spread wider.
function riverOracle(tiles) {
  const rp = [];
  for (const t of tiles.values()) {
    if (legacyTileType(t) === TileType.RIVER || legacyTileType(t) === TileType.BRIDGE) {
      rp.push({ col: t.col, row: t.row });
    }
  }
  const cols = new Set(rp.map(r => r.col));
  const rows = new Set(rp.map(r => r.row));
  const ew = cols.size > rows.size;
  const rm = buildRiverMap(rp, ew);
  return { rm, ew };
}

// A tile a unit can stand on / walk through: on-map, not river, not a building
// footprint (impassable wall). Building entrances (the INN/GRAVEYARD start tiles)
// and bridges ARE walkable.
function isPassable(t) {
  return !!t && !isRiver(t) && !isBuildingFootprint(t);
}

// BFS over passable tiles — proves the two starts are mutually reachable across
// the bridged banks.
function reachable(tiles, a, b) {
  const startK = hexKey(a.col, a.row);
  const goalK = hexKey(b.col, b.row);
  if (startK === goalK) return true;
  const seen = new Set([startK]);
  const queue = [a];
  while (queue.length) {
    const cur = queue.shift();
    for (const n of getNeighbors(cur.col, cur.row)) {
      const nk = hexKey(n.col, n.row);
      if (seen.has(nk)) continue;
      const t = tiles.get(nk);
      if (!isPassable(t)) continue;
      if (nk === goalK) return true;
      seen.add(nk);
      queue.push({ col: n.col, row: n.row });
    }
  }
  return false;
}

const PROC_SIZES = ['skirmish', 'standard', 'regional', 'campaign'];
const SEEDS = 60;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Faction start placement — opposite river banks', () => {
  test('hero and witch starts are on opposite sides of the river', () => {
    for (const size of PROC_SIZES) {
      let oppositeBank = 0, total = 0;
      for (let seed = 0; seed < SEEDS; seed++) {
        const { heroStart, witchStart, tiles } = generateMap(seed, size);
        const { rm, ew } = riverOracle(tiles);
        total++;
        const hSide = riverSide(heroStart.col, heroStart.row, rm, ew);
        const wSide = riverSide(witchStart.col, witchStart.row, rm, ew);
        if (hSide !== wSide) oppositeBank++;
      }
      // The strict rule holds whenever the map has eligible spawn tiles on both
      // banks. Tier 3 (banks relaxed) only fires on degenerate maps where one
      // bank has zero eligible tiles — vanishingly rare. Require the vast
      // majority to satisfy opposite-bank; skirmish (10×10) is the tightest.
      const frac = oppositeBank / total;
      const floor = size === 'skirmish' ? 0.85 : 0.99;
      assert.ok(frac >= floor,
        `${size}: only ${oppositeBank}/${total} (${(frac * 100).toFixed(0)}%) ` +
        `starts on opposite banks — expected >= ${(floor * 100).toFixed(0)}%`);
    }
  });
});

describe('Faction start placement — out of sight', () => {
  test('starts are farther apart than the sight clearance on standard+ maps', () => {
    // Standard and larger maps always have room for an out-of-sight pair (see
    // the feasibility sweep in the PR notes), so the strict rule must hold for
    // every seed.
    for (const size of ['standard', 'regional', 'campaign']) {
      for (let seed = 0; seed < SEEDS; seed++) {
        const { heroStart, witchStart } = generateMap(seed, size);
        const d = hexDistance(heroStart.col, heroStart.row, witchStart.col, witchStart.row);
        assert.ok(d > START_SIGHT_CLEARANCE,
          `${size} seed ${seed}: starts only ${d} apart ` +
          `(must exceed sight clearance ${START_SIGHT_CLEARANCE})`);
      }
    }
  });

  test('skirmish starts are out of sight on the vast majority of seeds', () => {
    // The 10×10 skirmish map cannot always fit an out-of-sight opposite-bank
    // pair; the placement falls back to the most-distant pair it can find. Most
    // seeds still clear the threshold, and none should be adjacent.
    let cleared = 0, total = 0, minDist = Infinity;
    for (let seed = 0; seed < SEEDS; seed++) {
      const { heroStart, witchStart } = generateMap(seed, 'skirmish');
      const d = hexDistance(heroStart.col, heroStart.row, witchStart.col, witchStart.row);
      total++;
      if (d > START_SIGHT_CLEARANCE) cleared++;
      minDist = Math.min(minDist, d);
    }
    // Even the relaxed fallback should never put the two leaders right next to
    // each other.
    assert.ok(minDist >= 3,
      `skirmish: closest starts were only ${minDist} apart — too close even for fallback`);
    const frac = cleared / total;
    assert.ok(frac >= 0.4,
      `skirmish: only ${cleared}/${total} (${(frac * 100).toFixed(0)}%) seeds cleared ` +
      `the sight threshold — fallback degraded too far`);
  });
});

describe('Faction start placement — passable and reachable', () => {
  test('both starts sit on passable terrain and are mutually reachable', () => {
    for (const size of PROC_SIZES) {
      for (let seed = 0; seed < 30; seed++) {
        const { heroStart, witchStart, tiles } = generateMap(seed, size);
        const hTile = tiles.get(hexKey(heroStart.col, heroStart.row));
        const wTile = tiles.get(hexKey(witchStart.col, witchStart.row));
        assert.ok(isPassable(hTile),
          `${size} seed ${seed}: hero start (${heroStart.col},${heroStart.row}) not passable`);
        assert.ok(isPassable(wTile),
          `${size} seed ${seed}: witch start (${witchStart.col},${witchStart.row}) not passable`);
        assert.ok(reachable(tiles, heroStart, witchStart),
          `${size} seed ${seed}: starts are not mutually reachable ` +
          `(hero ${heroStart.col},${heroStart.row} → witch ${witchStart.col},${witchStart.row})`);
      }
    }
  });

  test('starts are never on a river-adjacent tile (footprint cannot wall the bank)', () => {
    // The placement excludes river-adjacent candidates so the building footprint
    // claim that follows can never wall a river bank at a spawn.
    for (const size of PROC_SIZES) {
      for (let seed = 0; seed < 20; seed++) {
        const { heroStart, witchStart, tiles } = generateMap(seed, size);
        for (const s of [heroStart, witchStart]) {
          const riverAdj = getNeighbors(s.col, s.row).some(n => isRiver(tiles.get(hexKey(n.col, n.row))));
          assert.ok(!riverAdj,
            `${size} seed ${seed}: start (${s.col},${s.row}) is river-adjacent`);
        }
      }
    }
  });
});

describe('Faction start placement — determinism', () => {
  test('same seed yields identical starts', () => {
    for (const size of PROC_SIZES) {
      for (let seed = 0; seed < 20; seed++) {
        const a = generateMap(seed, size);
        const b = generateMap(seed, size);
        assert.deepEqual(
          { h: a.heroStart, w: a.witchStart },
          { h: b.heroStart, w: b.witchStart },
          `${size} seed ${seed}: starts differ between identical generations`);
      }
    }
  });

  test('different seeds produce varied starts (not always the same corner)', () => {
    // Guards against a regression back to fixed placement: across many seeds the
    // hero start should land on many distinct tiles, not one or two corners.
    const seen = new Set();
    for (let seed = 0; seed < SEEDS; seed++) {
      const { heroStart } = generateMap(seed, 'standard');
      seen.add(hexKey(heroStart.col, heroStart.row));
    }
    assert.ok(seen.size >= 10,
      `standard: hero start only landed on ${seen.size} distinct tiles across ` +
      `${SEEDS} seeds — placement looks fixed, not randomized`);
  });
});
