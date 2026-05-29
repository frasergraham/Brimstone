// P4 of the building-footprint rework — renderers draw the building on its
// FOOTPRINT hex (facing the entrance) instead of the entrance hex.
//
// Covers the pure render helpers (src/building-render.js) plus a stub-driven
// 3D smoke test asserting `_buildBuildingInstance` (what `_buildTileMesh` calls)
// lands the GLB instance at the footprint world position — not the entrance.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildingRenderHex,
  buildingFacingYaw,
  buildingFitScale,
  buildingNudgedPosition,
  doorStubDirection,
  compoundFortifyEdges,
  extendDoorStub,
  signpostWorldPos,
  BUILDING_ENTRANCE_NUDGE,
  TARGET_BUILDING_GROUND_SPAN,
  SIGNPOST_POST_HEIGHT,
  SIGNPOST_POST_DIAMETER,
  SIGNPOST_PLANK_WIDTH,
  SIGNPOST_PLANK_HEIGHT,
  SIGNPOST_ROAD_OFFSET,
} from '../src/building-render.js';

import {
  Renderer3D,
  hexToWorld,
  houseYawForHex,
  houseInstanceScalingForHex,
  buildRoadNetworkStrokes,
  _edgeTo,
  TILE_SLOTS,
  BUILDING_SLOT_INDEX,
  BUILDING_GLB_BY_TYPE,
  buildingGlbVariantForHex,
} from '../src/renderer-3d.js';

import { Tile, TileType, BuildingType, StructureType, hasBuilding } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';

// ── Test fixtures ────────────────────────────────────────────────────────────

/** A footprinted building entrance at (col,row) whose single footprint hex is
 *  (fcol,frow). Mirrors the P0/P1 data model: entrance carries `building` +
 *  `footprintHexes`; the footprint tile carries `buildingFootprintOf`. */
function makeEntrance(col, row, fcol, frow, building = BuildingType.INN) {
  const t = new Tile(col, row, TileType.DIRT);
  t.structure = StructureType.BUILDING;
  t.building  = building;
  t.footprintHexes = [hexKey(fcol, frow)];
  return t;
}

function newRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  return new Renderer3D(fakeCanvas, {});
}

function makeFakeBabylon() {
  const Vector3 = class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } };
  Vector3.Zero = () => new Vector3(0, 0, 0);
  return { Vector3, Mesh: { MergeMeshes: () => null }, SceneLoader: { ImportMeshAsync: async () => ({ meshes: [] }) } };
}

/** Minimal building template (mesh that records createInstance) so instance
 *  building can run synchronously without the async loader. */
function stubTemplate(r, relPath, { scale } = {}) {
  const mesh = {
    name: `tpl_${relPath}`,
    createInstance(n) {
      return {
        name: n, source: this, isPickable: true, metadata: null,
        position: { x: 0, y: 0, z: 0 }, scaling: null, rotation: null,
        parent: null, renderingGroupId: 7,
      };
    },
  };
  r._buildingTemplates.set(relPath, { mesh, scale });
  return mesh;
}

// ── buildingRenderHex ────────────────────────────────────────────────────────

describe('buildingRenderHex', () => {
  test('returns the footprint hex when the entrance has one', () => {
    const entrance = makeEntrance(5, 5, 6, 5);
    assert.equal(buildingRenderHex(entrance), hexKey(6, 5));
  });

  test('returns the entrance hex when footprintHexes is empty (legacy orphan)', () => {
    const orphan = new Tile(3, 4, TileType.DIRT);
    orphan.structure = StructureType.BUILDING;
    orphan.building  = BuildingType.CHURCH;
    // footprintHexes defaults to [] → orphan
    assert.equal(orphan.footprintHexes.length, 0);
    assert.ok(hasBuilding(orphan));
    assert.equal(buildingRenderHex(orphan), hexKey(3, 4));
  });

  test('picks the FIRST footprint hex when several are listed (N-hex schema)', () => {
    const entrance = makeEntrance(0, 0, 1, 0);
    entrance.footprintHexes = [hexKey(1, 0), hexKey(0, 1)];
    assert.equal(buildingRenderHex(entrance), hexKey(1, 0));
  });

  test('a plain (non-building) tile falls back to its own hex', () => {
    const grass = new Tile(2, 7, TileType.GRASS);
    assert.equal(buildingRenderHex(grass), hexKey(2, 7));
  });
});

// ── buildingFacingYaw ────────────────────────────────────────────────────────

describe('buildingFacingYaw', () => {
  test('local +Z points from the footprint toward the entrance, for 6 directions', () => {
    const footprint = { x: 3, z: -2 };
    // Six evenly-spaced "cardinal" hex directions around the footprint.
    for (let k = 0; k < 6; k++) {
      const a = (k * Math.PI * 2) / 6;          // target bearing
      const entrance = { x: footprint.x + Math.sin(a) * 1.3, z: footprint.z + Math.cos(a) * 1.3 };
      const yaw = buildingFacingYaw(entrance, footprint);
      // A mesh rotated yaw maps local +Z → world (sin yaw, cos yaw); that vector
      // must point toward the entrance.
      const fx = Math.sin(yaw), fz = Math.cos(yaw);
      const dx = entrance.x - footprint.x, dz = entrance.z - footprint.z;
      const len = Math.hypot(dx, dz);
      assert.ok(Math.abs(fx - dx / len) < 1e-9, `dir ${k}: +Z.x off`);
      assert.ok(Math.abs(fz - dz / len) < 1e-9, `dir ${k}: +Z.z off`);
    }
  });

  test('axis cases: +Z → 0, +X → π/2, −Z → π, −X → 3π/2', () => {
    const fp = { x: 0, z: 0 };
    assert.ok(Math.abs(buildingFacingYaw({ x: 0, z: 1 }, fp) - 0) < 1e-9);
    assert.ok(Math.abs(buildingFacingYaw({ x: 1, z: 0 }, fp) - Math.PI / 2) < 1e-9);
    assert.ok(Math.abs(buildingFacingYaw({ x: 0, z: -1 }, fp) - Math.PI) < 1e-9);
    assert.ok(Math.abs(buildingFacingYaw({ x: -1, z: 0 }, fp) - (3 * Math.PI) / 2) < 1e-9);
  });

  test('normalised into [0, 2π)', () => {
    const fp = { x: 0, z: 0 };
    for (let k = 0; k < 12; k++) {
      const a = (k * Math.PI) / 6;
      const yaw = buildingFacingYaw({ x: Math.sin(a), z: Math.cos(a) }, fp);
      assert.ok(yaw >= 0 && yaw < Math.PI * 2 + 1e-9, `yaw ${yaw} out of range`);
    }
  });

  test('coincident positions yield 0 (no NaN)', () => {
    assert.equal(buildingFacingYaw({ x: 4, z: 4 }, { x: 4, z: 4 }), 0);
  });
});

// ── buildingFitScale ─────────────────────────────────────────────────────────

describe('buildingFitScale', () => {
  test('scales the LARGER XZ axis to the target span', () => {
    // larger axis = 5 → scale = TARGET / 5
    assert.ok(Math.abs(buildingFitScale({ x: 2, z: 5 }) - TARGET_BUILDING_GROUND_SPAN / 5) < 1e-9);
    // larger axis = 4 (x) → scale = TARGET / 4
    assert.ok(Math.abs(buildingFitScale({ x: 4, z: 1 }) - TARGET_BUILDING_GROUND_SPAN / 4) < 1e-9);
  });

  test('upscales a model smaller than one hex', () => {
    const s = buildingFitScale({ x: 0.5, z: 0.5 });
    assert.ok(s > 1, `expected upscale, got ${s}`);
    assert.ok(Math.abs(s - TARGET_BUILDING_GROUND_SPAN / 0.5) < 1e-9);
  });

  test('honours a custom target span', () => {
    assert.ok(Math.abs(buildingFitScale({ x: 2, z: 2 }, 1.5) - 1.5 / 2) < 1e-9);
  });

  test('returns null for an unmeasurable (≈0) extent so the caller keeps its fallback', () => {
    assert.equal(buildingFitScale({ x: 0, z: 0 }), null);
    assert.equal(buildingFitScale({}), null);
    assert.equal(buildingFitScale(null), null);
  });

  test('ignores sign (extents are magnitudes)', () => {
    assert.equal(buildingFitScale({ x: -2, z: -5 }), buildingFitScale({ x: 2, z: 5 }));
  });
});

// ── buildingNudgedPosition (P4a) ─────────────────────────────────────────────

describe('buildingNudgedPosition', () => {
  test('lerps the default fraction from footprint toward entrance', () => {
    const fp = { x: 10, z: 4 };
    const en = { x: 20, z: 4 };
    const p = buildingNudgedPosition(fp, en);
    assert.ok(Math.abs(p.x - (10 + 10 * BUILDING_ENTRANCE_NUDGE)) < 1e-9);
    assert.ok(Math.abs(p.z - 4) < 1e-9);
  });

  test('lerps correctly for several entrance/footprint pairs and a custom nudge', () => {
    const cases = [
      { fp: { x: 0, z: 0 },  en: { x: 4, z: 8 },  n: 0.25 },
      { fp: { x: -3, z: 5 }, en: { x: 1, z: -1 }, n: 0.5 },
      { fp: { x: 7, z: 7 },  en: { x: 7, z: 7 },  n: 0.15 }, // coincident → identity
    ];
    for (const { fp, en, n } of cases) {
      const p = buildingNudgedPosition(fp, en, n);
      assert.ok(Math.abs(p.x - (fp.x + (en.x - fp.x) * n)) < 1e-9);
      assert.ok(Math.abs(p.z - (fp.z + (en.z - fp.z) * n)) < 1e-9);
    }
  });

  test('nudge=0 is identity; nudge=1 lands on the entrance', () => {
    const fp = { x: 2, z: 9 }, en = { x: 12, z: -3 };
    const at0 = buildingNudgedPosition(fp, en, 0);
    assert.ok(Math.abs(at0.x - fp.x) < 1e-9 && Math.abs(at0.z - fp.z) < 1e-9);
    const at1 = buildingNudgedPosition(fp, en, 1);
    assert.ok(Math.abs(at1.x - en.x) < 1e-9 && Math.abs(at1.z - en.z) < 1e-9);
  });

  test('identity (no shift) when there is no entrance world — orphan/no-footprint', () => {
    const fp = { x: 5, z: -2 };
    const p = buildingNudgedPosition(fp, null);
    assert.ok(Math.abs(p.x - fp.x) < 1e-9 && Math.abs(p.z - fp.z) < 1e-9);
  });
});

// ── doorStubDirection (P4a) ──────────────────────────────────────────────────

describe('doorStubDirection', () => {
  // odd-r deltas (mirror hex.js), indexed by dir 0..5.
  const DIRS_EVEN = [[-1, 0], [-1, -1], [0, -1], [1, 0], [0, 1], [-1, 1]];
  const DIRS_ODD  = [[-1, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1]];

  test('returns the correct dir for all 6 neighbours of an even-row entrance', () => {
    const col = 5, row = 4; // even row → DIRS_EVEN
    for (let d = 0; d < 6; d++) {
      const fp = hexKey(col + DIRS_EVEN[d][0], row + DIRS_EVEN[d][1]);
      const e = makeEntrance(col, row, col + DIRS_EVEN[d][0], row + DIRS_EVEN[d][1]);
      assert.equal(doorStubDirection(e, fp), d, `even-row dir ${d}`);
      assert.equal(doorStubDirection(e), d, `even-row dir ${d} (default footprint)`);
    }
  });

  test('returns the correct dir for all 6 neighbours of an odd-row entrance', () => {
    const col = 5, row = 5; // odd row → DIRS_ODD
    for (let d = 0; d < 6; d++) {
      const e = makeEntrance(col, row, col + DIRS_ODD[d][0], row + DIRS_ODD[d][1]);
      assert.equal(doorStubDirection(e), d, `odd-row dir ${d}`);
    }
  });

  test('returns -1 for a non-adjacent footprint (defensive)', () => {
    const e = makeEntrance(5, 5, 6, 5);
    assert.equal(doorStubDirection(e, hexKey(9, 9)), -1);
  });

  test('returns -1 for an orphan with empty footprintHexes (no door stub / no nudge)', () => {
    const orphan = new Tile(3, 4, TileType.DIRT);
    orphan.structure = StructureType.BUILDING;
    orphan.building  = BuildingType.CHURCH;
    assert.equal(orphan.footprintHexes.length, 0);
    assert.equal(doorStubDirection(orphan), -1);
  });
});

// ── _buildingPlacement — relocation + facing ─────────────────────────────────

describe('Renderer3D._buildingPlacement', () => {
  test('footprinted building → on the footprint hex nudged toward the entrance, facing it', () => {
    const r = newRenderer();
    const entrance = makeEntrance(5, 5, 6, 5);
    const ew = hexToWorld(5, 5);
    const fw = hexToWorld(6, 5);
    const p = r._buildingPlacement(entrance, ew.x, ew.z);
    assert.equal(p.isFootprint, true);
    // P4a: nudged BUILDING_ENTRANCE_NUDGE of the way from footprint toward entrance.
    const expect = buildingNudgedPosition(fw, ew, BUILDING_ENTRANCE_NUDGE);
    assert.ok(Math.abs(p.bx - expect.x) < 1e-9, 'nudged toward entrance X');
    assert.ok(Math.abs(p.bz - expect.z) < 1e-9, 'nudged toward entrance Z');
    // Still off the footprint centre and not all the way to the entrance.
    assert.ok(Math.abs(p.bx - fw.x) > 1e-9, 'shifted off footprint centre');
    assert.ok(Math.abs(p.bx - ew.x) > 1e-9, 'not sitting on the entrance');
    assert.ok(Math.abs(p.yaw - buildingFacingYaw(ew, fw)) < 1e-9, 'yaw faces entrance');
  });

  test('orphan building → legacy NE slot offset + centre-facing yaw (unchanged)', () => {
    const r = newRenderer();
    const orphan = new Tile(3, 4, TileType.DIRT);
    orphan.structure = StructureType.BUILDING;
    orphan.building  = BuildingType.CHURCH; // footprintHexes empty
    const ew = hexToWorld(3, 4);
    const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
    const p = r._buildingPlacement(orphan, ew.x, ew.z);
    assert.equal(p.isFootprint, false);
    assert.ok(Math.abs(p.bx - (ew.x + slot.x)) < 1e-9);
    assert.ok(Math.abs(p.bz - (ew.z + slot.z)) < 1e-9);
    assert.ok(Math.abs(p.yaw - houseYawForHex(3, 4)) < 1e-9);
  });
});

// ── _buildBuildingInstance — 3D smoke: GLB lands on the footprint hex ─────────

describe('Renderer3D._buildBuildingInstance — footprint relocation', () => {
  test('places the GLB instance at the footprint worldPos, not the entrance', () => {
    const r = newRenderer();
    r._babylon = makeFakeBabylon();
    const entrance = makeEntrance(5, 5, 6, 5, BuildingType.INN);
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.INN][0], { scale: 0.3 });

    const ew = hexToWorld(entrance.col, entrance.row);
    const fw = hexToWorld(6, 5);
    const inst = r._buildBuildingInstance(entrance, ew.x, ew.z, null);
    assert.ok(inst, 'instance built');

    // On the footprint hex, nudged toward the entrance (P4a) — no NE slot offset.
    const expect = buildingNudgedPosition(fw, ew, BUILDING_ENTRANCE_NUDGE);
    assert.ok(Math.abs(inst.position.x - expect.x) < 1e-9, `x ${inst.position.x} != nudged ${expect.x}`);
    assert.ok(Math.abs(inst.position.z - expect.z) < 1e-9, `z ${inst.position.z} != nudged ${expect.z}`);
    // And NOT at the entrance hex centre.
    assert.ok(Math.abs(inst.position.x - ew.x) > 1e-6 || Math.abs(inst.position.z - ew.z) > 1e-6,
      'instance must not sit on the entrance hex');

    // Yaw faces the entrance.
    assert.ok(Math.abs(inst.rotation.y - buildingFacingYaw(ew, fw)) < 1e-9, 'yaw faces entrance');

    // Scale is template-base × per-hex jitter (unchanged compositing).
    const sc = houseInstanceScalingForHex(entrance.col, entrance.row);
    assert.ok(Math.abs(inst.scaling.x - 0.3 * sc.x) < 1e-9);
  });

  test('orphan building (no footprint) still lands on the NE slot, facing centre', () => {
    const r = newRenderer();
    r._babylon = makeFakeBabylon();
    const orphan = new Tile(2, 3, TileType.DIRT);
    orphan.structure = StructureType.BUILDING;
    orphan.building  = BuildingType.MILL;
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.MILL][0]);

    const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
    const inst = r._buildBuildingInstance(orphan, 10, 20, null);
    assert.ok(Math.abs(inst.position.x - (10 + slot.x)) < 1e-9);
    assert.ok(Math.abs(inst.position.z - (20 + slot.z)) < 1e-9);
    assert.ok(Math.abs(inst.rotation.y - houseYawForHex(2, 3)) < 1e-9);
    assert.equal(buildingGlbVariantForHex(orphan), BUILDING_GLB_BY_TYPE[BuildingType.MILL][0]);
  });
});

// ── P4b: compoundFortifyEdges — entrance + footprint walled as one enclosure ──

describe('compoundFortifyEdges', () => {
  // odd-r deltas (mirror building-render.js / fortNeighborOffset), indexed 0..5.
  const DIRS_ODD = [[-1, 0], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1]];
  const dirToward = (col, row, tcol, trow) => {
    for (let d = 0; d < 6; d++) {
      if (col + DIRS_ODD[d][0] === tcol && row + DIRS_ODD[d][1] === trow) return d;
    }
    return -1;
  };

  test('shared edge is bare on BOTH hexes; every OTHER edge gets a wall', () => {
    // Entrance (5,5) + footprint (6,5) — the only fortified compound on the map.
    const E = { col: 5, row: 5 };
    const F = { col: 6, row: 5 };
    const inCompound = (c, r) => (c === 5 && r === 5) || (c === 6 && r === 5);
    const { entrance, footprint } = compoundFortifyEdges(E, F, inCompound);

    const eShared = dirToward(5, 5, 6, 5); // entrance edge facing the footprint
    const fShared = dirToward(6, 5, 5, 5); // footprint edge facing the entrance
    assert.ok(eShared >= 0 && fShared >= 0);

    // Shared (interior) edges are bare.
    assert.ok(!entrance.includes(eShared), 'entrance shared edge bare');
    assert.ok(!footprint.includes(fShared), 'footprint shared edge bare');

    // All five OTHER edges of each hex carry a wall.
    for (let d = 0; d < 6; d++) {
      if (d !== eShared) assert.ok(entrance.includes(d), `entrance edge ${d} walled`);
      if (d !== fShared) assert.ok(footprint.includes(d), `footprint edge ${d} walled`);
    }
    assert.equal(entrance.length, 5);
    assert.equal(footprint.length, 5);
  });

  test('an edge touching ANOTHER fortified compound merges to bare', () => {
    const E = { col: 5, row: 5 };
    const F = { col: 6, row: 5 };
    // A second fortified building sits to the west of the entrance (4,5).
    const inCompound = (c, r) =>
      (c === 5 && r === 5) || (c === 6 && r === 5) || (c === 4 && r === 5);
    const { entrance } = compoundFortifyEdges(E, F, inCompound);

    const eShared = dirToward(5, 5, 6, 5); // toward own footprint → bare
    const eMerge  = dirToward(5, 5, 4, 5); // toward neighbour compound → bare
    assert.ok(!entrance.includes(eShared), 'own shared edge bare');
    assert.ok(!entrance.includes(eMerge), 'edge touching neighbour compound merges to bare');
    assert.equal(entrance.length, 4, 'two interior edges, four walls');
  });

  test('no footprint → footprint mask empty, entrance is the plain perimeter rule', () => {
    const E = { col: 5, row: 5 };
    const inCompound = (c, r) => c === 5 && r === 5; // isolated fortified hex
    const { entrance, footprint } = compoundFortifyEdges(E, null, inCompound);
    assert.deepEqual(footprint, []);
    assert.deepEqual(entrance, [0, 1, 2, 3, 4, 5], 'all six edges walled when isolated');
  });
});

// ── P4b: extendDoorStub — door road continues into the footprint hex ──────────

describe('extendDoorStub', () => {
  test('appends the building point to the stroke ending at the edge midpoint', () => {
    const edgeMid = { x: 1, z: 0 };
    const bldg    = { x: 1.5, z: 0 };
    const strokes = [[{ x: 0, z: 0 }, { x: 1, z: 0 }]]; // centre → edge mid
    extendDoorStub(strokes, edgeMid, bldg);
    assert.equal(strokes[0].length, 3, 'stroke gained the building terminus');
    assert.deepEqual(strokes[0][2], { x: 1.5, z: 0 }, 'far end is the building point');
  });

  test('prepends when the stroke STARTS at the edge midpoint (bezier orientation)', () => {
    const edgeMid = { x: 1, z: 0 };
    const bldg    = { x: 1.5, z: 0 };
    const strokes = [[{ x: 1, z: 0 }, { x: 0, z: 0 }, { x: -1, z: 0 }]]; // edge → through
    extendDoorStub(strokes, edgeMid, bldg);
    assert.equal(strokes[0].length, 4);
    assert.deepEqual(strokes[0][0], { x: 1.5, z: 0 }, 'building point is the new start');
  });

  test('no-op when no endpoint matches the edge midpoint', () => {
    const strokes = [[{ x: 0, z: 0 }, { x: 9, z: 9 }]];
    extendDoorStub(strokes, { x: 1, z: 0 }, { x: 1.5, z: 0 });
    assert.equal(strokes[0].length, 2, 'unchanged');
  });
});

// ── P4b: buildRoadNetworkStrokes — door ribbon ends at the building, not edge ──

describe('buildRoadNetworkStrokes — door stub reaches into the footprint', () => {
  test('an isolated fortified-less entrance road stub terminates at the nudged building position', () => {
    const tiles = new Map();
    const entrance = makeEntrance(5, 5, 6, 5, BuildingType.INN); // footprint (6,5)
    tiles.set(hexKey(5, 5), entrance);

    const segs = buildRoadNetworkStrokes(tiles);
    const seg  = segs.find(s => s.tile.col === 5 && s.tile.row === 5);
    assert.ok(seg, 'entrance emits a road segment (the door stub)');
    assert.equal(seg.strokes.length, 1, 'one door stub');

    const stub = seg.strokes[0];
    const here = hexToWorld(5, 5);
    const fw   = hexToWorld(6, 5);
    const edge = _edgeTo(here, fw);
    const nudged = buildingNudgedPosition(
      { x: fw.x, z: fw.z }, { x: here.x, z: here.z }, BUILDING_ENTRANCE_NUDGE,
    );

    // The stub starts at the entrance centre, passes the shared edge midpoint,
    // and CONTINUES to the building's nudged draw position inside the footprint.
    const tip = stub[stub.length - 1];
    assert.ok(Math.abs(tip.x - nudged.x) < 1e-9 && Math.abs(tip.z - nudged.z) < 1e-9,
      'stub tip is the nudged building position');
    // It must NOT stop at the shared edge midpoint any more.
    assert.ok(Math.abs(tip.x - edge.mx) > 1e-9 || Math.abs(tip.z - edge.mz) > 1e-9,
      'stub no longer terminates at the A–B edge');
    // The edge midpoint is still on the path (the road crosses the edge).
    assert.ok(stub.some(p => Math.abs(p.x - edge.mx) < 1e-9 && Math.abs(p.z - edge.mz) < 1e-9),
      'path still crosses the shared edge midpoint');
  });
});

// ── signpostWorldPos (P4c) ───────────────────────────────────────────────────

describe('signpostWorldPos', () => {
  test('returns the midpoint of several entrance/footprint world pairs', () => {
    const cases = [
      { e: { x: 0,  z: 0 },  f: { x: 4,  z: 0 },  m: { x: 2,    z: 0 } },
      { e: { x: 2,  z: 6 },  f: { x: -2, z: 2 },  m: { x: 0,    z: 4 } },
      { e: { x: -5, z: -1 }, f: { x: 3,  z: 7 },  m: { x: -1,   z: 3 } },
      { e: { x: 1.5, z: 2.5 }, f: { x: 0.5, z: -1.5 }, m: { x: 1, z: 0.5 } },
    ];
    for (const { e, f, m } of cases) {
      const p = signpostWorldPos(e, f);
      assert.ok(p, 'midpoint computed');
      assert.ok(Math.abs(p.x - m.x) < 1e-9, `x ${p.x} != ${m.x}`);
      assert.ok(Math.abs(p.z - m.z) < 1e-9, `z ${p.z} != ${m.z}`);
    }
  });

  test('midpoint of two real adjacent hex centres lies on their shared edge', () => {
    const ew = hexToWorld(5, 5);
    const fw = hexToWorld(6, 5);
    const p  = signpostWorldPos(ew, fw);
    assert.ok(Math.abs(p.x - (ew.x + fw.x) / 2) < 1e-9);
    assert.ok(Math.abs(p.z - (ew.z + fw.z) / 2) < 1e-9);
    // The shared-edge midpoint sits strictly between the two centres.
    assert.ok(p.x > Math.min(ew.x, fw.x) && p.x < Math.max(ew.x, fw.x));
  });

  test('orphan with no footprint world → null (signals the floating-label fallback)', () => {
    const ew = hexToWorld(3, 4);
    assert.equal(signpostWorldPos(ew, null), null);
    assert.equal(signpostWorldPos(ew, undefined), null);
    assert.equal(signpostWorldPos(null, ew), null);
  });

  test('missing x/z components → null (defensive)', () => {
    assert.equal(signpostWorldPos({ x: 1 }, { x: 2, z: 3 }), null);
    assert.equal(signpostWorldPos({ x: 1, z: 2 }, { z: 3 }), null);
  });
});

describe('Signpost dimension constants — operator-dialable knobs', () => {
  test('post is short and thin; plank is wider than it is tall', () => {
    assert.ok(SIGNPOST_POST_HEIGHT > 0 && SIGNPOST_POST_HEIGHT < 1,
      `POST_HEIGHT ${SIGNPOST_POST_HEIGHT} should be a fraction of a hex`);
    assert.ok(SIGNPOST_POST_DIAMETER > 0 && SIGNPOST_POST_DIAMETER < SIGNPOST_PLANK_WIDTH,
      'post diameter should be thinner than the plank is wide');
    assert.ok(SIGNPOST_PLANK_WIDTH > SIGNPOST_PLANK_HEIGHT,
      'plank should read as a landscape board (wider than tall)');
  });

  test('plank sits at the top of the post (plank fits within post height)', () => {
    assert.ok(SIGNPOST_PLANK_HEIGHT < SIGNPOST_POST_HEIGHT,
      'plank height should be less than the post height so it perches on top');
  });
});

// ── Signpost / label / node-label sync — stub-driven Babylon ─────────────────

/** A fake 2D canvas context: every painting call is a no-op, every style is a
 *  plain settable property. Enough for `_paintSignpostPlank` / label painting. */
function fakeCtx() {
  return {
    fillStyle: '', strokeStyle: '', lineWidth: 0,
    font: '', textAlign: '', textBaseline: '',
    clearRect() {}, fillRect() {}, strokeRect() {}, fillText() {},
  };
}

function fakeSignMesh(name) {
  return {
    name, parent: null, isPickable: true, material: null,
    billboardMode: null, isVisible: true, renderingGroupId: 0,
    receiveShadows: false, metadata: null, alphaIndex: 0,
    rotation: { x: 0, y: 0, z: 0 },
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
  };
}

/** A Babylon stub broad enough to drive `_buildBuildingSignpost` and
 *  `_buildNodeGlowMeshes`. Every created mesh is pushed to `created`. */
function makeSignBabylon(created) {
  const Color3 = class { constructor(r = 0, g = 0, b = 0) { this.r = r; this.g = g; this.b = b; } };
  const Vector3 = class { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } };
  const make = (name) => { const m = fakeSignMesh(name); created.push(m); return m; };
  return {
    Color3,
    Vector3,
    Texture: { TRILINEAR_SAMPLINGMODE: 3 },
    Mesh: { BILLBOARDMODE_Y: 2, BILLBOARDMODE_ALL: 7, DOUBLESIDE: 2 },
    DynamicTexture: class {
      constructor(name) { this.name = name; this.hasAlpha = false; }
      getContext() { return fakeCtx(); }
      update() {}
      updateSamplingMode() {}
    },
    StandardMaterial: class { constructor(name) { this.name = name; this.alpha = 1; } },
    MeshBuilder: {
      CreatePlane(name) { return make(name); },
      CreateCylinder(name) { return make(name); },
      CreateTube(name) { return make(name); },
    },
  };
}

describe('Renderer3D._buildBuildingSignpost — footprinted building', () => {
  test('builds a post + billboarded plank at the door-side edge, both tracked', () => {
    globalThis.document = globalThis.document || {};
    const r = newRenderer();
    const created = [];
    r._babylon = makeSignBabylon(created);
    r._scene = {};

    const entrance = makeEntrance(5, 5, 6, 5, BuildingType.INN);
    const ew = hexToWorld(5, 5);
    r._buildBuildingSignpost(entrance, ew.x, ew.z, { name: 'mapRoot' });

    const post  = created.find(m => m.name === 'bldgSignPost_5,5');
    const plank = created.find(m => m.name === 'bldgSignPlank_5,5');
    assert.ok(post,  'post cylinder built');
    assert.ok(plank, 'name plank built');

    // Plank billboards on the vertical axis only; the post does not billboard.
    assert.equal(plank.billboardMode, r._babylon.Mesh.BILLBOARDMODE_Y);
    assert.equal(post.billboardMode, null, 'post stays vertical (no billboard)');

    // Both stand at the entrance↔footprint shared-edge midpoint pushed off
    // the road by SIGNPOST_ROAD_OFFSET (perpendicular to the entrance→
    // footprint axis), with a deterministic per-hex side bias so adjacent
    // buildings don't alternate-zigzag.
    // Mirror the renderer's sideBias picker exactly.
    const sideBias = (((entrance.col * 73856093) ^ (entrance.row * 19349663)) & 1) ? 1 : -1;
    const off = signpostWorldPos(ew, hexToWorld(6, 5), SIGNPOST_ROAD_OFFSET, sideBias);
    assert.ok(Math.abs(post.position.x - off.x) < 1e-9, 'post x at offset edge');
    assert.ok(Math.abs(post.position.z - off.z) < 1e-9, 'post z at offset edge');
    assert.ok(Math.abs(plank.position.x - off.x) < 1e-9, 'plank x at offset edge');
    assert.ok(Math.abs(plank.position.z - off.z) < 1e-9, 'plank z at offset edge');
    // Plank rests on top of the post — its bottom edge meets the post tip,
    // so the post never pierces the text.
    assert.ok(plank.position.y > post.position.y, 'plank sits above the post centre');
    // Off the road centreline (the shared-edge midpoint is at sideBias=0).
    const onRoad = signpostWorldPos(ew, hexToWorld(6, 5));
    const dist = Math.hypot(post.position.x - onRoad.x, post.position.z - onRoad.z);
    assert.ok(Math.abs(dist - SIGNPOST_ROAD_OFFSET) < 1e-9, 'pushed off the road by the offset');

    // Tracked as one unit so the fade pump + fog veil treat them together.
    const entry = r._buildingLabelsByKey.get('5,5');
    assert.ok(entry, 'entry registered under the entrance hex key');
    assert.equal(entry.meshes.length, 2, 'post + plank tracked');
    assert.equal(entry.mats.length, 2, 'post + plank materials tracked');
    assert.ok(entry.tex, 'plank texture tracked');
    assert.equal(entry.fogged, false);
  });

  test('orphan building (no footprint) falls back to the floating label (single plane)', () => {
    globalThis.document = globalThis.document || {};
    const r = newRenderer();
    const created = [];
    r._babylon = makeSignBabylon(created);
    r._scene = {};

    const orphan = new Tile(3, 4, TileType.DIRT);
    orphan.structure = StructureType.BUILDING;
    orphan.building  = BuildingType.CHURCH; // footprintHexes empty → orphan
    const ow = hexToWorld(3, 4);
    r._buildBuildingSignpost(orphan, ow.x, ow.z, { name: 'mapRoot' });

    // No signpost meshes; one floating label plane, billboarded on all axes.
    assert.ok(!created.some(m => m.name?.startsWith('bldgSignPost')), 'no post for orphan');
    const plane = created.find(m => m.name === 'bldgLabel_3,4');
    assert.ok(plane, 'orphan gets the old floating label plane');
    assert.equal(plane.billboardMode, r._babylon.Mesh.BILLBOARDMODE_ALL);

    const entry = r._buildingLabelsByKey.get('3,4');
    assert.ok(entry, 'orphan label tracked');
    assert.equal(entry.meshes.length, 1, 'just the floating plane');
  });

  test('no DOM (headless) → no-op (matches the document guard)', () => {
    const saved = globalThis.document;
    delete globalThis.document;
    try {
      const r = newRenderer();
      const created = [];
      r._babylon = makeSignBabylon(created);
      r._scene = {};
      r._buildBuildingSignpost(makeEntrance(5, 5, 6, 5), 0, 0, null);
      assert.equal(created.length, 0, 'nothing built without a DOM');
      assert.equal(r._buildingLabelsByKey.size, 0);
    } finally {
      if (saved !== undefined) globalThis.document = saved;
    }
  });
});

describe('Renderer3D — power-node labels removed (P4c)', () => {
  test('the floating-name-label builders + pump are gone from the prototype', () => {
    assert.equal(typeof Renderer3D.prototype._buildNodeNameLabel, 'undefined');
    assert.equal(typeof Renderer3D.prototype._paintNodeLabel, 'undefined');
    assert.equal(typeof Renderer3D.prototype._pumpNodeLabelFade, 'undefined');
  });

  test('_buildNodeGlowMeshes builds rings + tint discs but NO label meshes', () => {
    globalThis.document = globalThis.document || {};
    const r = newRenderer();
    const created = [];
    r._babylon = makeSignBabylon(created);
    r._scene = {};
    r._mapRoot = { name: 'mapRoot' };
    r._freezeStaticMeshes = () => {}; // isolate from the freeze machinery
    r.state = {
      entities: [],
      witchObjectives: [
        { label: 'Power Node 1', hexes: [{ col: 5, row: 5 }, { col: 6, row: 5 }] },
      ],
    };

    r._buildNodeGlowMeshes();

    // Identifier outline tubes + tint discs were built…
    assert.ok(created.some(m => m.name?.startsWith('node_edge_')), 'identifier ring tubes built');
    assert.ok(created.some(m => m.name?.startsWith('node_tint_')), 'tint discs built');
    assert.equal(r._nodeTintMeshes.length, 2, 'one tint disc per node hex');
    // …but NO node name-label plane, and the old label registries are gone.
    assert.ok(!created.some(m => m.name?.startsWith('nodeLabel')), 'no node name-label mesh');
    assert.equal(r._nodeNameLabels, undefined, 'node-label registry removed');
    assert.equal(r._nodeLabelsByCenterHex, undefined, 'node-label-by-hex map removed');
  });
});
