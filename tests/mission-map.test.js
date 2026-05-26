// Tests for the data-driven mission-map builder (src/campaign/mission-map.js).
// Covers handmade reconstruction and procedural-overlay layering (tile replace,
// road-node add/remove → road regen, symmetric roadDirs, bridges-only-over-river,
// implicit building/bridge nodes, and start/objective/hidden-survivor deltas).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMissionMap, rederiveRoads } from '../src/campaign/mission-map.js';
import { TileType, BuildingType, ResourceType, Tile, PathType, pathOf, legacyTileType, decomposeTileType } from '../src/tiles.js';
import { hexKey, setMapDimensions } from '../src/hex.js';

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
    assert.equal(legacyTileType(blank), TileType.GRASS);
  });

  test('reconstructs explicit tiles with mapped enums', () => {
    const m = buildMissionMap(mapDef);
    const inn = m.tiles.get(hexKey(2, 7));
    assert.equal(legacyTileType(inn), TileType.BUILDING);
    assert.equal(inn.building, BuildingType.INN);
    assert.equal(inn.fortifyLevel, 1);

    const forest = m.tiles.get(hexKey(4, 4));
    assert.equal(legacyTileType(forest), TileType.FOREST);
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
    assert.equal(legacyTileType(inn), TileType.BUILDING);
    assert.equal(inn.building, BuildingType.INN);
    assert.equal(inn.fortifyLevel, 2);
    assert.deepEqual([...inn.roadDirs], ['1,2']);

    const forest = m.tiles.get(hexKey(2, 2));
    assert.equal(forest.base, TileType.FOREST);
    assert.equal(legacyTileType(forest), TileType.FOREST);
    assert.equal(forest.resource, ResourceType.HERBS);
    assert.equal(forest.hiddenSurvivor, true);

    const road = m.tiles.get(hexKey(3, 3));
    assert.equal(road.base, TileType.GRASS);
    assert.equal(legacyTileType(road), TileType.ROAD);
    assert.deepEqual([...road.roadDirs].sort(), ['2,3', '4,3']);

    assert.equal(legacyTileType(m.tiles.get(hexKey(4, 4))), TileType.RIVER);
    assert.equal(legacyTileType(m.tiles.get(hexKey(5, 5))), TileType.BRIDGE);
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
      assert.equal(legacyTileType(ta), legacyTileType(tb), `${k} type`);
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
  for (const [k, t] of tiles) if (legacyTileType(t) === TileType.BRIDGE) out.add(k);
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
    assert.equal(legacyTileType(t), TileType.BUILDING);
    assert.equal(t.building, BuildingType.CHURCH);
    assert.equal(t.fortifyLevel, 2);
  });

  test('re-derived roads are symmetric and connect the node set', () => {
    const m = buildMissionMap(baseDef);
    assertSymmetricRoads(m.tiles);
    // At least some road tiles were laid between the buildings.
    let roadCount = 0;
    for (const t of m.tiles.values()) if (legacyTileType(t) === TileType.ROAD) roadCount++;
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
      if (legacyTileType(t) !== TileType.BUILDING) continue;
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
      .filter(([, t]) => legacyTileType(t) === TileType.ROAD)
      .map(([k]) => k).sort();
    assert.deepEqual(roadsOf(a), roadsOf(b));
  });
});

// ── rederiveRoads — river crossing (handmade vs procedural modes) ────────────
// Handmade/editor regen (bridgeRivers:true, the DEFAULT) must route ACROSS a
// river and create a BRIDGE at the crossing, since handmade maps have NO
// pre-placed bridges. Procedural-overlay regen (bridgeRivers:false) keeps the
// legacy generateMap behaviour: route around rivers, never invent a bridge.

describe('rederiveRoads — river crossing', () => {
  // A flat grass grid with a single vertical RIVER column splitting it in two.
  // Two road nodes sit on opposite banks, so the only MST edge MUST cross.
  function bankedGrid({ cols = 7, rows = 3, riverCol = 3 } = {}) {
    setMapDimensions(cols, rows);
    const tiles = new Map();
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const t = new Tile(col, row, TileType.GRASS);
        if (col === riverCol) decomposeTileType(t, TileType.RIVER);
        tiles.set(hexKey(col, row), t);
      }
    }
    return tiles;
  }

  const rand = () => 0.5; // deterministic neighbour ordering for BFS
  const leftNode = '1,1';
  const rightNode = '5,1';

  test('handmade (bridgeRivers:true, default) bridges across the river and connects both banks', () => {
    const tiles = bankedGrid();
    rederiveRoads(tiles, [leftNode, rightNode], rand); // default bridgeRivers:true

    // A BRIDGE was created, and it sits on the river column (col 3).
    const bridges = [...tiles.values()].filter(t => legacyTileType(t) === TileType.BRIDGE);
    assert.equal(bridges.length, 1, 'exactly one bridge over the single river column');
    assert.equal(bridges[0].col, 3, 'bridge sits on the river line');
    assert.equal(pathOf(bridges[0]), PathType.BRIDGE);

    // The bridge links across the river: roadDirs reach a tile on each bank.
    const bridge = bridges[0];
    const dirCols = [...bridge.roadDirs].map(k => tiles.get(k)).map(t => t.col);
    assert.ok(dirCols.some(c => c < 3), 'bridge connects to the left bank');
    assert.ok(dirCols.some(c => c > 3), 'bridge connects to the right bank');

    // Both authored nodes are road-connected (the path runs through them).
    assert.ok(tiles.get(leftNode).roadDirs.size > 0, 'left node connected');
    assert.ok(tiles.get(rightNode).roadDirs.size > 0, 'right node connected');

    // The two nodes are mutually reachable via the roadDirs graph (crosses river).
    assert.ok(roadConnected(tiles, leftNode, rightNode), 'nodes joined across the river');
  });

  test('procedural (bridgeRivers:false) does NOT cross the river — no new bridge created', () => {
    const tiles = bankedGrid();
    rederiveRoads(tiles, [leftNode, rightNode], rand, { bridgeRivers: false });

    // Legacy behaviour: rivers block BFS, no river→bridge conversion. With a
    // full-height river wall and no pre-placed bridge, no bridge can appear.
    const bridges = [...tiles.values()].filter(t => legacyTileType(t) === TileType.BRIDGE);
    assert.equal(bridges.length, 0, 'no bridge invented over the river');

    // No road tile sits on the river column either (it routes around / fails).
    const onRiver = [...tiles.values()].some(
      t => t.col === 3 && pathOf(t) === PathType.ROAD,
    );
    assert.equal(onRiver, false, 'no road paved onto the river column');
  });
});

// Flood the roadDirs graph from `start`; true if `goal` is reachable.
function roadConnected(tiles, start, goal) {
  const seen = new Set([start]);
  const stack = [start];
  while (stack.length) {
    const k = stack.pop();
    if (k === goal) return true;
    const t = tiles.get(k);
    if (!t) continue;
    for (const nk of t.roadDirs) {
      if (!seen.has(nk)) { seen.add(nk); stack.push(nk); }
    }
  }
  return false;
}

describe('buildMissionMap — errors', () => {
  test('rejects missing mapDef', () => {
    assert.throws(() => buildMissionMap(null), /mapDef is required/);
  });
  test('rejects unknown mode', () => {
    assert.throws(() => buildMissionMap({ mode: 'bogus' }), /unknown map mode/);
  });
});
