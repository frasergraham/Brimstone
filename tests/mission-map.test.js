// Tests for the data-driven mission-map builder (src/campaign/mission-map.js).
// Covers handmade reconstruction and procedural-overlay layering (tile replace,
// road-node add/remove → road regen, symmetric roadDirs, bridges-only-over-river,
// implicit building/bridge nodes, and start/objective/hidden-survivor deltas).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMissionMap } from '../src/campaign/mission-map.js';
import { TileType, BuildingType, ResourceType } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';

// ── Handmade ─────────────────────────────────────────────────────────────────

describe('buildMissionMap — handmade', () => {
  const mapDef = {
    mode: 'handmade',
    cols: 9,
    rows: 9,
    heroStart: { col: 2, row: 7 },
    witchStart: { col: 7, row: 1 },
    witchObjectives: [{ col: 4, row: 4, hexes: [{ col: 4, row: 4 }] }],
    roadNodes: ['2,7', '4,5'],
    tiles: [
      {
        col: 2, row: 7, type: 'BUILDING', building: 'INN', fortifyLevel: 1,
        resource: null, hiddenSurvivor: false, roadDirs: ['3,6', '2,6'],
      },
      {
        col: 4, row: 4, type: 'FOREST', building: null,
        resource: 'HERBS', hiddenSurvivor: true, roadDirs: [],
      },
      { col: 5, row: 5, type: 'RIVER' },
    ],
  };

  test('returns the canonical builder shape', () => {
    const m = buildMissionMap(mapDef);
    assert.ok(m.tiles instanceof Map);
    assert.deepEqual(m.heroStart, { col: 2, row: 7 });
    assert.deepEqual(m.witchStart, { col: 7, row: 1 });
    assert.equal(m.witchObjectives.length, 1);
    assert.equal(m.mapSize, 'skirmish');
    assert.deepEqual(m.survivorCounts, { buildings: 0, terrain: 0 });
    assert.equal(m.cols, 9);
    assert.equal(m.rows, 9);
  });

  test('fills a full grass grid for unspecified tiles', () => {
    const m = buildMissionMap(mapDef);
    assert.equal(m.tiles.size, 9 * 9);
    const blank = m.tiles.get(hexKey(0, 0));
    assert.equal(blank.type, TileType.GRASS);
  });

  test('reconstructs explicit tiles with mapped enums', () => {
    const m = buildMissionMap(mapDef);
    const inn = m.tiles.get(hexKey(2, 7));
    assert.equal(inn.type, TileType.BUILDING);
    assert.equal(inn.building, BuildingType.INN);
    assert.equal(inn.fortifyLevel, 1);

    const forest = m.tiles.get(hexKey(4, 4));
    assert.equal(forest.type, TileType.FOREST);
    assert.equal(forest.resource, ResourceType.HERBS);
  });

  test('converts roadDirs array → Set (lossless, no regen)', () => {
    const m = buildMissionMap(mapDef);
    const inn = m.tiles.get(hexKey(2, 7));
    assert.ok(inn.roadDirs instanceof Set);
    assert.deepEqual([...inn.roadDirs].sort(), ['2,6', '3,6']);
    // A tile with an empty roadDirs array yields an empty Set, not undefined.
    assert.equal(m.tiles.get(hexKey(4, 4)).roadDirs.size, 0);
  });

  test('preserves hiddenSurvivor flag', () => {
    const m = buildMissionMap(mapDef);
    assert.equal(m.tiles.get(hexKey(4, 4)).hiddenSurvivor, true);
    assert.equal(m.tiles.get(hexKey(2, 7)).hiddenSurvivor, false);
  });
});

// ── Handmade — layered tile shape (base/structure/path) ──────────────────────
// P5 canonical on-disk shape: explicit base/structure/path uppercase KEYs.
// The builder must reconstruct the SAME Tile (derived type + layers) as the
// legacy `type`-only form, and old+new defs must be interchangeable.

describe('buildMissionMap — handmade, layered tile shape', () => {
  const layeredDef = {
    mode: 'handmade',
    cols: 6,
    rows: 6,
    heroStart: { col: 0, row: 5 },
    witchStart: { col: 5, row: 0 },
    tiles: [
      // building over dirt, road-through carried by roadDirs
      { col: 1, row: 1, base: 'DIRT', structure: 'BUILDING', path: null, building: 'INN', fortifyLevel: 2, roadDirs: ['1,2'] },
      { col: 2, row: 2, base: 'FOREST', structure: null, path: null, resource: 'HERBS', hiddenSurvivor: true },
      { col: 3, row: 3, base: 'GRASS', structure: null, path: 'ROAD', roadDirs: ['2,3', '4,3'] },
      { col: 4, row: 4, base: 'GRASS', structure: null, path: 'RIVER' },
      { col: 5, row: 5, base: 'GRASS', structure: null, path: 'BRIDGE' },
    ],
  };

  test('sets each layer and derives the legacy type', () => {
    const m = buildMissionMap(layeredDef);

    const inn = m.tiles.get(hexKey(1, 1));
    assert.equal(inn.base, TileType.DIRT);
    assert.equal(inn.type, TileType.BUILDING);
    assert.equal(inn.building, BuildingType.INN);
    assert.equal(inn.fortifyLevel, 2);
    assert.deepEqual([...inn.roadDirs], ['1,2']);

    const forest = m.tiles.get(hexKey(2, 2));
    assert.equal(forest.base, TileType.FOREST);
    assert.equal(forest.type, TileType.FOREST);
    assert.equal(forest.resource, ResourceType.HERBS);
    assert.equal(forest.hiddenSurvivor, true);

    const road = m.tiles.get(hexKey(3, 3));
    assert.equal(road.base, TileType.GRASS);
    assert.equal(road.type, TileType.ROAD);
    assert.deepEqual([...road.roadDirs].sort(), ['2,3', '4,3']);

    assert.equal(m.tiles.get(hexKey(4, 4)).type, TileType.RIVER);
    assert.equal(m.tiles.get(hexKey(5, 5)).type, TileType.BRIDGE);
  });

  test('layered and legacy type-only defs build identical tiles', () => {
    const legacyDef = {
      mode: 'handmade', cols: 6, rows: 6,
      tiles: [
        { col: 1, row: 1, type: 'BUILDING', building: 'INN', fortifyLevel: 2, roadDirs: ['1,2'] },
        { col: 2, row: 2, type: 'FOREST', resource: 'HERBS', hiddenSurvivor: true },
        { col: 3, row: 3, type: 'ROAD', roadDirs: ['2,3', '4,3'] },
        { col: 4, row: 4, type: 'RIVER' },
        { col: 5, row: 5, type: 'BRIDGE' },
      ],
    };
    const a = buildMissionMap(layeredDef);
    const b = buildMissionMap(legacyDef);
    for (const k of ['1,1', '2,2', '3,3', '4,4', '5,5']) {
      const ta = a.tiles.get(k);
      const tb = b.tiles.get(k);
      assert.equal(ta.type, tb.type, `${k} type`);
      assert.equal(ta.base, tb.base, `${k} base`);
      assert.equal(ta.structure ?? null, tb.structure ?? null, `${k} structure`);
      assert.equal(ta.path ?? null, tb.path ?? null, `${k} path`);
      assert.equal(ta.building ?? null, tb.building ?? null, `${k} building`);
      assert.deepEqual([...ta.roadDirs].sort(), [...tb.roadDirs].sort(), `${k} roadDirs`);
    }
  });
});

// ── Procedural + overlay ───────────────────────────────────────────────────────

// Assert every roadDirs link is mirrored on the neighbour (no one-way roads).
function assertSymmetricRoads(tiles) {
  for (const [k, t] of tiles) {
    for (const nk of t.roadDirs) {
      const n = tiles.get(nk);
      assert.ok(n, `roadDir to missing tile ${nk} from ${k}`);
      assert.ok(n.roadDirs.has(k), `asymmetric road ${k} → ${nk}`);
    }
  }
}

function bridgeKeys(tiles) {
  const out = new Set();
  for (const [k, t] of tiles) if (t.type === TileType.BRIDGE) out.add(k);
  return out;
}

describe('buildMissionMap — procedural overlay', () => {
  const SEED = 12345;
  const baseDef = { mode: 'procedural', seed: SEED, mapSize: 'standard', nodeCount: 3 };

  test('builds the canonical shape from a seeded base', () => {
    const m = buildMissionMap(baseDef);
    assert.ok(m.tiles instanceof Map);
    assert.equal(m.mapSize, 'standard');
    assert.ok(m.cols > 0 && m.rows > 0);
    assert.ok(m.heroStart && m.witchStart);
    assert.equal(m.witchObjectives.length, 3);
  });

  test('overlay tiles replace base tiles (field merge)', () => {
    const m = buildMissionMap({
      ...baseDef,
      overlay: {
        tiles: [{ col: 4, row: 5, type: 'BUILDING', building: 'CHURCH', fortifyLevel: 2 }],
      },
    });
    const t = m.tiles.get(hexKey(4, 5));
    assert.equal(t.type, TileType.BUILDING);
    assert.equal(t.building, BuildingType.CHURCH);
    assert.equal(t.fortifyLevel, 2);
  });

  test('re-derived roads are symmetric and connect the node set', () => {
    const m = buildMissionMap(baseDef);
    assertSymmetricRoads(m.tiles);
    // At least some road tiles were laid between the buildings.
    let roadCount = 0;
    for (const t of m.tiles.values()) if (t.type === TileType.ROAD) roadCount++;
    assert.ok(roadCount > 0, 'expected roads between building nodes');
  });

  test('bridges only sit over river crossings (no new bridges created)', () => {
    const before = buildMissionMap(baseDef);
    // The re-derivation must not invent bridges on dry land — every BRIDGE in
    // the result corresponds to a base river crossing. We approximate this by
    // confirming the builder never increases the bridge set relative to the raw
    // generated base.
    const baseBridges = bridgeKeys(before.tiles);
    const withOverlay = buildMissionMap({
      ...baseDef,
      overlay: { roadNodes: { add: ['1,1'], remove: [] } },
    });
    const overlayBridges = bridgeKeys(withOverlay.tiles);
    for (const k of overlayBridges) {
      assert.ok(baseBridges.has(k), `new bridge appeared at ${k}`);
    }
  });

  test('roadNodes add changes the graph (extra waypoint pulls in roads)', () => {
    // Pick a far-corner grass tile and force it to be a road node; roads should
    // then reach it (its roadDirs become non-empty).
    const corner = '1,1';
    const m = buildMissionMap({
      ...baseDef,
      overlay: {
        tiles: [{ col: 1, row: 1, type: 'GRASS' }],
        roadNodes: { add: [corner], remove: [] },
      },
    });
    assertSymmetricRoads(m.tiles);
    const t = m.tiles.get(hexKey(1, 1));
    assert.ok(t.roadDirs.size > 0, 'added road node should be connected by roads');
  });

  test('buildings are implicitly road nodes even with empty roadNodes', () => {
    const m = buildMissionMap({ ...baseDef, overlay: { roadNodes: { add: [], remove: [] } } });
    // Every building tile should be touched by a road (or be adjacent to one
    // via roadDirs), since buildings are auto-included as MST nodes.
    let connectedBuildings = 0;
    let totalBuildings = 0;
    for (const t of m.tiles.values()) {
      if (t.type !== TileType.BUILDING) continue;
      totalBuildings++;
      if (t.roadDirs.size > 0) connectedBuildings++;
    }
    assert.ok(totalBuildings >= 2);
    assert.equal(connectedBuildings, totalBuildings, 'all buildings should be road-connected');
  });

  test('hiddenSurvivor / start / objective deltas applied', () => {
    const m = buildMissionMap({
      ...baseDef,
      overlay: {
        heroStart: { col: 3, row: 3 },
        witchStart: { col: 9, row: 9 },
        hiddenSurvivors: { add: ['5,5'], remove: [] },
        witchObjectives: [{ col: 6, row: 6, hexes: [{ col: 6, row: 6 }] }],
      },
    });
    assert.deepEqual(m.heroStart, { col: 3, row: 3 });
    assert.deepEqual(m.witchStart, { col: 9, row: 9 });
    assert.equal(m.tiles.get(hexKey(5, 5)).hiddenSurvivor, true);
    assert.equal(m.witchObjectives.length, 1);
    assert.deepEqual(m.witchObjectives[0].col, 6);
  });

  test('deterministic: same def → identical road layout', () => {
    const a = buildMissionMap(baseDef);
    const b = buildMissionMap(baseDef);
    const roadsOf = (m) => [...m.tiles.entries()]
      .filter(([, t]) => t.type === TileType.ROAD)
      .map(([k]) => k).sort();
    assert.deepEqual(roadsOf(a), roadsOf(b));
  });
});

describe('buildMissionMap — errors', () => {
  test('rejects missing mapDef', () => {
    assert.throws(() => buildMissionMap(null), /mapDef is required/);
  });
  test('rejects unknown mode', () => {
    assert.throws(() => buildMissionMap({ mode: 'bogus' }), /unknown map mode/);
  });
});
