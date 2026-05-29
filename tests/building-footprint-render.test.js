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
  BUILDING_ENTRANCE_NUDGE,
  TARGET_BUILDING_GROUND_SPAN,
} from '../src/building-render.js';

import {
  Renderer3D,
  hexToWorld,
  houseYawForHex,
  houseInstanceScalingForHex,
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
