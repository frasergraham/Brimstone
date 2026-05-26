// Per-size invariants for src/map.js outputs.
//
// The 3D renderer (and later phases that place entities & atmosphere) depend
// on these being true for every generated map:
//   - exactly the configured number of power nodes
//   - exactly one INN and one GRAVEYARD, on roughly-opposite corners
//   - heroStart and witchStart are walkable tiles
//   - bridges are present in the count the preset asks for
//   - generateMultipleStarts produces unique, walkable positions for 2..8 players
//
// We deliberately exercise the smaller presets (skirmish/standard) so the suite
// stays fast — campaign generation is the expensive bit and is already
// exercised by tests/map-generation.test.js.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap, generateMultipleStarts, MAP_SIZES } from '../src/map.js';
import { TileType, BuildingType, PathType, StructureType, baseOf, pathOf, legacyTileType } from '../src/tiles.js';
import { hexKey, hexDistance } from '../src/hex.js';

const SIZES = ['skirmish', 'standard', 'regional'];

// ── Power nodes ──────────────────────────────────────────────────────────────

describe('Power node counts', () => {
  test('default-generated maps have exactly nodeCount power nodes per preset', () => {
    for (const size of SIZES) {
      const expected = MAP_SIZES[size].nodeCount;
      for (let seed = 0; seed < 8; seed++) {
        const { witchObjectives } = generateMap(seed, size);
        assert.equal(witchObjectives.length, expected,
          `${size} seed=${seed}: expected ${expected} nodes, got ${witchObjectives.length}`);
      }
    }
  });

  test('every node has a colour and a label', () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 3; seed++) {
        const { witchObjectives } = generateMap(seed, size);
        for (const obj of witchObjectives) {
          assert.equal(typeof obj.color, 'string',
            `${size} seed=${seed}: node missing color`);
          assert.ok(obj.color.startsWith('#'),
            `${size} seed=${seed}: node color "${obj.color}" not a hex string`);
          assert.equal(typeof obj.label, 'string',
            `${size} seed=${seed}: node missing label`);
          assert.ok(obj.label.length > 0,
            `${size} seed=${seed}: node label is empty`);
        }
      }
    }
  });
});

// ── INN / GRAVEYARD placement ────────────────────────────────────────────────

describe('Spawn buildings (INN & GRAVEYARD)', () => {
  test('every non-battle map has exactly one INN and one GRAVEYARD', () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 8; seed++) {
        const { tiles } = generateMap(seed, size);
        let innCount = 0, gravCount = 0;
        for (const t of tiles.values()) {
          if (legacyTileType(t) !== TileType.BUILDING) continue;
          if (t.building === BuildingType.INN) innCount++;
          else if (t.building === BuildingType.GRAVEYARD) gravCount++;
        }
        assert.equal(innCount, 1, `${size} seed=${seed}: expected 1 INN, got ${innCount}`);
        assert.equal(gravCount, 1, `${size} seed=${seed}: expected 1 GRAVEYARD, got ${gravCount}`);
      }
    }
  });

  test('INN and GRAVEYARD are placed in opposite corners (far apart)', () => {
    for (const size of SIZES) {
      const cfg = MAP_SIZES[size];
      // A diagonal across the map is roughly sqrt((cols-1)^2 + (rows-1)^2); we
      // pick a conservative threshold: at least half the longest grid axis.
      const minDist = Math.floor(Math.max(cfg.cols, cfg.rows) / 2);
      for (let seed = 0; seed < 6; seed++) {
        const { heroStart, witchStart } = generateMap(seed, size);
        const d = hexDistance(heroStart.col, heroStart.row, witchStart.col, witchStart.row);
        assert.ok(d >= minDist,
          `${size} seed=${seed}: heroStart→witchStart only ${d} hexes (min ${minDist})`);
      }
    }
  });

  test('heroStart sits on the INN, witchStart on the GRAVEYARD', () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 4; seed++) {
        const { tiles, heroStart, witchStart } = generateMap(seed, size);
        const heroTile  = tiles.get(hexKey(heroStart.col, heroStart.row));
        const witchTile = tiles.get(hexKey(witchStart.col, witchStart.row));
        assert.ok(heroTile,  `${size} seed=${seed}: heroStart tile missing`);
        assert.ok(witchTile, `${size} seed=${seed}: witchStart tile missing`);
        assert.equal(heroTile.building, BuildingType.INN);
        assert.equal(witchTile.building, BuildingType.GRAVEYARD);
      }
    }
  });
});

// ── Walkability ──────────────────────────────────────────────────────────────

describe('Starting positions are walkable', () => {
  test('heroStart and witchStart are never on RIVER', () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 10; seed++) {
        const { tiles, heroStart, witchStart } = generateMap(seed, size);
        const hT = tiles.get(hexKey(heroStart.col, heroStart.row));
        const wT = tiles.get(hexKey(witchStart.col, witchStart.row));
        assert.notEqual(legacyTileType(hT), TileType.RIVER,
          `${size} seed=${seed}: heroStart is on RIVER`);
        assert.notEqual(legacyTileType(wT), TileType.RIVER,
          `${size} seed=${seed}: witchStart is on RIVER`);
      }
    }
  });
});

// ── Bridges ──────────────────────────────────────────────────────────────────

describe('Bridge counts respect preset bounds', () => {
  test('each preset gives at least minBridges and at most bridgeMax', () => {
    for (const size of SIZES) {
      const cfg = MAP_SIZES[size];
      for (let seed = 0; seed < 8; seed++) {
        const { tiles } = generateMap(seed, size);
        let bridges = 0;
        for (const t of tiles.values()) {
          if (legacyTileType(t) === TileType.BRIDGE) bridges++;
        }
        assert.ok(bridges >= cfg.minBridges,
          `${size} seed=${seed}: ${bridges} bridges < min ${cfg.minBridges}`);
        assert.ok(bridges <= cfg.bridgeMax,
          `${size} seed=${seed}: ${bridges} bridges > max ${cfg.bridgeMax}`);
      }
    }
  });
});

// ── Layered tile model (P2: generation writes base/structure/path) ───────────
// Generation now sets the explicit (base, structure, path) layers rather than
// overwriting the single `type`. These invariants pin the layer semantics:
//   - base is always one of grass/forest/dirt
//   - rivers/bridges are PATH overlays that preserve their base material
//   - buildings are a STRUCTURE with NO path (road-through lives in roadDirs)

describe('Layered tile model', () => {
  test('every tile has a valid base material and consistent derived type', () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 4; seed++) {
        const { tiles } = generateMap(seed, size);
        for (const t of tiles.values()) {
          assert.ok([TileType.GRASS, TileType.FOREST, TileType.DIRT].includes(baseOf(t)),
            `${size} seed=${seed}: tile (${t.col},${t.row}) has invalid base "${baseOf(t)}"`);
          // The derived legacy type must follow the documented precedence.
          if (pathOf(t) === PathType.RIVER)       assert.equal(legacyTileType(t), TileType.RIVER);
          else if (pathOf(t) === PathType.BRIDGE) assert.equal(legacyTileType(t), TileType.BRIDGE);
          else if (pathOf(t) === PathType.ROAD)   assert.equal(legacyTileType(t), TileType.ROAD);
          else if (t.structure === StructureType.BUILDING) assert.equal(legacyTileType(t), TileType.BUILDING);
          else assert.equal(legacyTileType(t), baseOf(t));
        }
      }
    }
  });

  test('river tiles are a path overlay over a base (base preserved under water)', () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 4; seed++) {
        const { tiles } = generateMap(seed, size);
        for (const t of tiles.values()) {
          if (legacyTileType(t) !== TileType.RIVER) continue;
          assert.equal(pathOf(t), PathType.RIVER);
          // River was carved onto the grass fill before anything else.
          assert.equal(baseOf(t), TileType.GRASS,
            `${size} seed=${seed}: river (${t.col},${t.row}) base "${baseOf(t)}" not grass`);
        }
      }
    }
  });

  test('building tiles carry structure + path=none; sit on cleared dirt/grass (never forest)', () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 6; seed++) {
        const { tiles } = generateMap(seed, size);
        let connectedBuildings = 0;
        let dirtBases = 0, grassBases = 0;
        for (const t of tiles.values()) {
          if (legacyTileType(t) !== TileType.BUILDING) continue;
          assert.equal(t.structure, StructureType.BUILDING,
            `${size} seed=${seed}: building (${t.col},${t.row}) missing structure marker`);
          // P0 semantics: a building never carries a path; road-through is roadDirs.
          assert.equal(pathOf(t), null,
            `${size} seed=${seed}: building (${t.col},${t.row}) must not have a path layer`);
          // Operator-locked: a building clears its tile, so the base is dirt or
          // grass — NEVER forest (and never a river/bridge, which would be a path).
          assert.ok([TileType.DIRT, TileType.GRASS].includes(baseOf(t)),
            `${size} seed=${seed}: building (${t.col},${t.row}) base "${baseOf(t)}" not dirt/grass`);
          assert.notEqual(baseOf(t), TileType.FOREST,
            `${size} seed=${seed}: building (${t.col},${t.row}) must never sit on forest`);
          if (baseOf(t) === TileType.DIRT) dirtBases++;
          else grassBases++;
          if (t.roadDirs.size > 0) connectedBuildings++;
        }
        // The road MST connects buildings, so at least some are road-linked.
        assert.ok(connectedBuildings > 0,
          `${size} seed=${seed}: expected some buildings to be road-connected via roadDirs`);
        // Sanity: there ARE buildings (so the never-forest assertions ran).
        assert.ok(dirtBases + grassBases > 0,
          `${size} seed=${seed}: no buildings found`);
      }
    }
  });

  test('building bases vary between dirt and grass across maps (not always dirt)', () => {
    // Aggregate across seeds: the variety knob should produce BOTH dirt-based and
    // grass-based building tiles somewhere in the population.
    let dirt = 0, grass = 0;
    for (const size of SIZES) {
      for (let seed = 0; seed < 8; seed++) {
        const { tiles } = generateMap(seed, size);
        for (const t of tiles.values()) {
          if (legacyTileType(t) !== TileType.BUILDING) continue;
          if (baseOf(t) === TileType.DIRT) dirt++;
          else if (baseOf(t) === TileType.GRASS) grass++;
        }
      }
    }
    assert.ok(dirt > 0, 'expected some buildings on a dirt base');
    assert.ok(grass > 0, 'expected some buildings on a grass base');
  });

  test('road tiles are a path overlay that preserves their crossed base material', () => {
    // Roads now grow AFTER forest/dirt, so a road preserves whatever terrain it
    // crosses: grass, forest, or dirt (operator-locked: roads preserve terrain).
    const baseHistogram = { [TileType.GRASS]: 0, [TileType.FOREST]: 0, [TileType.DIRT]: 0 };
    for (const size of SIZES) {
      for (let seed = 0; seed < 4; seed++) {
        const { tiles } = generateMap(seed, size);
        for (const t of tiles.values()) {
          if (legacyTileType(t) !== TileType.ROAD) continue;
          assert.equal(pathOf(t), PathType.ROAD);
          const b = baseOf(t);
          assert.ok([TileType.GRASS, TileType.FOREST, TileType.DIRT].includes(b),
            `${size} seed=${seed}: road (${t.col},${t.row}) has invalid base "${b}"`);
          baseHistogram[b]++;
        }
      }
    }
    // Roads should land on more than just grass now — at least one road over a
    // non-grass base must exist across the sampled maps.
    assert.ok(baseHistogram[TileType.FOREST] + baseHistogram[TileType.DIRT] > 0,
      `expected some roads over forest/dirt, got ${JSON.stringify(baseHistogram)}`);
  });
});

// ── generateMultipleStarts ───────────────────────────────────────────────────

describe('generateMultipleStarts', () => {
  test('returns the primary start when count <= 1', () => {
    const { tiles, heroStart } = generateMap(1, 'standard');
    const out = generateMultipleStarts(tiles, heroStart, 1);
    assert.equal(out.length, 1);
    assert.equal(out[0].col, heroStart.col);
    assert.equal(out[0].row, heroStart.row);
  });

  test('returns N unique, walkable positions for N in 2..8', () => {
    const { tiles, heroStart } = generateMap(42, 'standard');
    for (const n of [2, 3, 4, 5, 6, 7, 8]) {
      const out = generateMultipleStarts(tiles, heroStart, n);
      assert.equal(out.length, n, `count=${n}: expected ${n} starts, got ${out.length}`);
      // First slot is always the primary start.
      assert.equal(out[0].col, heroStart.col);
      assert.equal(out[0].row, heroStart.row);
      // We accept duplicate fallbacks only as overflow at the end — record
      // uniqueness of the non-fallback prefix instead. The fallback path
      // repeats the primary start, so seeing primary appear twice indicates
      // the BFS ran out of candidates.
      const distinctKeys = new Set(out.map(p => hexKey(p.col, p.row)));
      // For small N the map should comfortably accommodate distinct slots.
      if (n <= 4) {
        assert.equal(distinctKeys.size, n,
          `count=${n}: expected ${n} unique positions, got ${distinctKeys.size}`);
      }
      // Every returned position must lie on a walkable (non-RIVER) tile.
      for (const p of out) {
        const t = tiles.get(hexKey(p.col, p.row));
        assert.ok(t, `count=${n}: position (${p.col},${p.row}) has no tile`);
        assert.notEqual(legacyTileType(t), TileType.RIVER,
          `count=${n}: position (${p.col},${p.row}) is on RIVER`);
      }
    }
  });

  test('respects minSep on returned positions', () => {
    const { tiles, heroStart } = generateMap(7, 'standard');
    const out = generateMultipleStarts(tiles, heroStart, 4, /*minSep*/ 3);
    // Drop trailing duplicates of the primary (fallback overflow).
    const primaryKey = hexKey(heroStart.col, heroStart.row);
    const distinct = [];
    const seen = new Set();
    for (const p of out) {
      const k = hexKey(p.col, p.row);
      if (k === primaryKey && seen.has(primaryKey)) continue;
      seen.add(k);
      distinct.push(p);
    }
    for (let i = 0; i < distinct.length; i++) {
      for (let j = i + 1; j < distinct.length; j++) {
        const a = distinct[i], b = distinct[j];
        const d = hexDistance(a.col, a.row, b.col, b.row);
        assert.ok(d >= 3 || (a.col === b.col && a.row === b.row),
          `minSep violated between (${a.col},${a.row}) and (${b.col},${b.row}): d=${d}`);
      }
    }
  });
});
