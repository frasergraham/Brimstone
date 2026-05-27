// Building GLB model tests — covers the pure helpers + the stub-driven
// load / instance / retrofit machinery that lets `_buildTileMesh` swap the
// procedural box+roof for an instance of a Scenario-generated GLB
// (`assets/models/buildings/<type>.glb`), with HOUSE keeping the legacy
// hand-made `assets/models/house.glb` as a second hash-picked variant.
//
// Babylon can't run in node-test (no WebGL), so the load + instance paths are
// exercised against a stubbed `_babylon` namespace. Pure helpers are tested
// directly. (Generalized from the original HOUSE-only pipeline.)

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  houseYawForHex,
  houseInstanceScalingForHex,
  BUILDING_BASE_DIM,
  HOUSE_MODEL_DIR,
  HOUSE_MODEL_FILE,
  HOUSE_INSTANCE_BASE_SCALE,
  HOUSE_INSTANCE_JITTER,
  TARGET_BUILDING_WORLD_HEIGHT,
  LEGACY_HOUSE_PATH,
  BUILDINGS_MODEL_DIR,
  TILE_SLOTS,
  BUILDING_SLOT_INDEX,
  BUILDING_GLB_BY_TYPE,
  buildingUsesGlbModel,
  buildingUsesHouseModel,
  buildingGlbVariantForHex,
  _bakeOriginToBottom,
} from '../src/renderer-3d.js';

import { TileType, BuildingType, StructureType, Tile } from '../src/tiles.js';

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

/** Minimal BABYLON stub exposing only what the renderer's building pipeline
 *  touches. `SceneLoader.ImportMeshAsync` returns a fake mesh that supports
 *  `createInstance`; tests can swap the implementation per-case. */
function makeFakeBabylon({ importImpl, mergeImpl } = {}) {
  const Vector3 = class {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  };
  Vector3.Zero = () => new Vector3(0, 0, 0);
  return {
    Vector3,
    Mesh: { MergeMeshes: mergeImpl || (() => null) },
    SceneLoader: {
      ImportMeshAsync: importImpl || (async () => ({ meshes: [] })),
    },
  };
}

/** Make a fake mesh that records createInstance calls + dispose state. */
function makeFakeMesh(name, opts = {}) {
  return {
    name,
    isPickable: true,
    metadata: null,
    isEnabled: true,
    renderingGroupId: 7, // start non-zero so the world-group write is observable
    position: { x: 0, y: 0, z: 0 },
    scaling: null,
    rotation: null,
    _disposed: false,
    parent: null,
    getTotalVertices: () => opts.vertices ?? 36,
    getTotalIndices:  () => opts.indices ?? 36,
    setEnabled(b) { this.isEnabled = b; },
    dispose() { this._disposed = true; },
    createInstance(n) {
      const inst = makeFakeInstance(n, this);
      this._instances = this._instances || [];
      this._instances.push(inst);
      return inst;
    },
  };
}

function makeFakeInstance(name, source) {
  return {
    name,
    source,
    isPickable: true,
    metadata: null,
    position: { x: 0, y: 0, z: 0 },
    scaling: null,
    rotation: null,
    parent: null,
    renderingGroupId: 7,
    _frozen: false,
    isWorldMatrixFrozen: false,
    doNotSyncBoundingInfo: false,
    freezeWorldMatrix() { this._frozen = true; this.isWorldMatrixFrozen = true; },
    dispose() { this._disposed = true; },
  };
}

/** Pre-load a building template for `relPath` directly into the renderer's
 *  template map (bypassing the async loader) so instance/retrofit tests can
 *  run synchronously. */
function stubTemplate(r, relPath, { scale } = {}) {
  const mesh = makeFakeMesh(`tpl_${relPath}`);
  r._buildingTemplates.set(relPath, { mesh, scale });
  return mesh;
}

describe('houseYawForHex', () => {
  test('deterministic per (col, row)', () => {
    for (const [c, r] of [[0, 0], [3, 7], [-4, 2]]) {
      assert.equal(houseYawForHex(c, r), houseYawForHex(c, r));
    }
  });

  test('returned yaw is in [0, 2π)', () => {
    for (let c = -8; c <= 8; c++) {
      for (let r = -8; r <= 8; r++) {
        const y = houseYawForHex(c, r);
        assert.ok(y >= 0 && y < Math.PI * 2 + 1e-9, `yaw ${y} out of range at (${c},${r})`);
      }
    }
  });

  test('is consistent across all hexes (faces the hex centre, not random)', () => {
    const sample = new Set();
    for (let c = -5; c <= 5; c++) {
      for (let r = -5; r <= 5; r++) sample.add(houseYawForHex(c, r));
    }
    assert.equal(sample.size, 1, `expected one consistent yaw, got ${sample.size}`);
  });

  test('points from the NE building slot back toward the hex centre', () => {
    const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
    // Vector from the building slot to the tile centre, in world XZ.
    const expected = Math.atan2(-slot.x, -slot.z);
    const norm = expected < 0 ? expected + Math.PI * 2 : expected;
    assert.ok(Math.abs(houseYawForHex(0, 0) - norm) < 1e-9,
      `yaw ${houseYawForHex(0, 0)} does not face centre (${norm})`);
  });
});

describe('houseInstanceScalingForHex', () => {
  test('deterministic', () => {
    assert.deepEqual(houseInstanceScalingForHex(2, 3), houseInstanceScalingForHex(2, 3));
  });

  test('is uniform (isotropic) — same factor on every axis, never distorts', () => {
    for (let c = -4; c <= 4; c++) {
      for (let r = -4; r <= 4; r++) {
        const s = houseInstanceScalingForHex(c, r);
        assert.equal(s.x, s.y, `x/y differ at (${c},${r})`);
        assert.equal(s.y, s.z, `y/z differ at (${c},${r})`);
      }
    }
  });

  test('stays within ±HOUSE_INSTANCE_JITTER of unity (small uniform variety)', () => {
    let sawBelow = false, sawAbove = false;
    for (let c = -6; c <= 6; c++) {
      for (let r = -6; r <= 6; r++) {
        const s = houseInstanceScalingForHex(c, r);
        for (const v of [s.x, s.y, s.z]) {
          assert.ok(Math.abs(v - 1) <= HOUSE_INSTANCE_JITTER + 1e-9,
            `axis ${v} out of ±${HOUSE_INSTANCE_JITTER} band`);
        }
        if (s.x < 1 - 1e-6) sawBelow = true;
        if (s.x > 1 + 1e-6) sawAbove = true;
      }
    }
    // Confirms there *is* some jitter (not pinned to exactly 1.0 everywhere).
    assert.ok(sawBelow && sawAbove, 'expected jitter both below and above unity');
  });
});

describe('exported constants', () => {
  test('HOUSE_MODEL_DIR points at the models subdirectory', () => {
    assert.equal(HOUSE_MODEL_DIR, 'models/');
  });
  test('HOUSE_MODEL_FILE is house.glb', () => {
    assert.equal(HOUSE_MODEL_FILE, 'house.glb');
  });
  test('LEGACY_HOUSE_PATH is the original hand-made house model', () => {
    assert.equal(LEGACY_HOUSE_PATH, 'models/house.glb');
  });
  test('BUILDINGS_MODEL_DIR points at the scenario buildings subdirectory', () => {
    assert.equal(BUILDINGS_MODEL_DIR, 'models/buildings/');
  });
  test('HOUSE_INSTANCE_BASE_SCALE is a positive number near the procedural box width', () => {
    assert.ok(HOUSE_INSTANCE_BASE_SCALE > 0);
    assert.ok(Math.abs(HOUSE_INSTANCE_BASE_SCALE - BUILDING_BASE_DIM.width) < 0.5,
      `scale ${HOUSE_INSTANCE_BASE_SCALE} drifted far from box width ${BUILDING_BASE_DIM.width}`);
  });
  test('TARGET_BUILDING_WORLD_HEIGHT is a sane positive height', () => {
    assert.ok(TARGET_BUILDING_WORLD_HEIGHT > 0 && TARGET_BUILDING_WORLD_HEIGHT < 3,
      `target height ${TARGET_BUILDING_WORLD_HEIGHT} out of sane range`);
  });
});

describe('BUILDING_GLB_BY_TYPE — covers all 13 building types', () => {
  test('has an entry for every BuildingType value', () => {
    const types = Object.values(BuildingType);
    assert.equal(types.length, 13, 'expected 13 building types');
    for (const t of types) {
      assert.ok(Array.isArray(BUILDING_GLB_BY_TYPE[t]),
        `building type "${t}" must map to a variant array`);
      assert.ok(BUILDING_GLB_BY_TYPE[t].length >= 1,
        `building type "${t}" must list at least one GLB path`);
    }
  });

  test('non-HOUSE types map to a single assets/models/buildings/<key>.glb path', () => {
    for (const t of Object.values(BuildingType)) {
      if (t === BuildingType.HOUSE) continue;
      const variants = BUILDING_GLB_BY_TYPE[t];
      assert.equal(variants.length, 1, `"${t}" should have exactly one variant`);
      assert.equal(variants[0], `${BUILDINGS_MODEL_DIR}${t}.glb`,
        `"${t}" should point at models/buildings/${t}.glb`);
    }
  });

  test('paths use the lowercase generator keys (church, town_hall, …)', () => {
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.CHURCH][0],     'models/buildings/church.glb');
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.TOWN_HALL][0],  'models/buildings/town_hall.glb');
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.INN][0],        'models/buildings/inn.glb');
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.BLACKSMITH][0], 'models/buildings/blacksmith.glb');
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.GRAVEYARD][0],  'models/buildings/graveyard.glb');
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.WATCHTOWER][0], 'models/buildings/watchtower.glb');
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.APOTHECARY][0], 'models/buildings/apothecary.glb');
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.STOREHOUSE][0], 'models/buildings/storehouse.glb');
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.STABLE][0],     'models/buildings/stable.glb');
  });

  test('HOUSE lists BOTH the legacy and scenario models as two variants', () => {
    const variants = BUILDING_GLB_BY_TYPE[BuildingType.HOUSE];
    assert.equal(variants.length, 2, 'HOUSE must have exactly two variants');
    assert.ok(variants.includes(LEGACY_HOUSE_PATH), 'legacy models/house.glb must be a HOUSE variant');
    assert.ok(variants.includes(`${BUILDINGS_MODEL_DIR}house.glb`),
      'scenario models/buildings/house.glb must be a HOUSE variant');
  });

  test('legacy house.glb is NOT overwritten — both house paths are distinct', () => {
    assert.notEqual(LEGACY_HOUSE_PATH, `${BUILDINGS_MODEL_DIR}house.glb`);
  });

  test('is frozen so accidental writes during render do not mutate the table', () => {
    assert.ok(Object.isFrozen(BUILDING_GLB_BY_TYPE));
    assert.ok(Object.isFrozen(BUILDING_GLB_BY_TYPE[BuildingType.HOUSE]),
      'variant arrays must also be frozen');
  });
});

describe('buildingUsesGlbModel — gating predicate', () => {
  test('true for every building type (all 13 render a GLB)', () => {
    for (const t of Object.values(BuildingType)) {
      assert.equal(
        buildingUsesGlbModel({ type: TileType.BUILDING, building: t }),
        true,
        `building "${t}" should use a GLB`,
      );
    }
  });

  test('false for tiles with no building (layered model: base material only)', () => {
    const forest = new Tile(0, 0, TileType.FOREST);
    const grass  = new Tile(0, 0, TileType.GRASS);
    assert.equal(buildingUsesGlbModel(forest), false);
    assert.equal(buildingUsesGlbModel(grass), false);
  });

  test('a HOUSE building on a forest base still uses a GLB', () => {
    const houseOnForest = new Tile(2, 3, TileType.FOREST);
    houseOnForest.structure = StructureType.BUILDING;
    houseOnForest.building  = BuildingType.HOUSE;
    assert.equal(buildingUsesGlbModel(houseOnForest), true);
  });

  test('false for null / undefined input', () => {
    assert.equal(buildingUsesGlbModel(null), false);
    assert.equal(buildingUsesGlbModel(undefined), false);
  });

  test('buildingUsesHouseModel is a back-compat alias of buildingUsesGlbModel', () => {
    assert.equal(buildingUsesHouseModel, buildingUsesGlbModel);
  });
});

describe('buildingGlbVariantForHex — per-tile variant pick', () => {
  test('single-variant types always return that one path', () => {
    for (const t of Object.values(BuildingType)) {
      if (t === BuildingType.HOUSE) continue;
      const path = BUILDING_GLB_BY_TYPE[t][0];
      for (const [c, r] of [[0, 0], [3, 7], [-4, 2]]) {
        assert.equal(buildingGlbVariantForHex({ building: t, col: c, row: r }), path);
      }
    }
  });

  test('HOUSE pick is deterministic per (col, row)', () => {
    for (let c = -4; c <= 4; c++) {
      for (let r = -4; r <= 4; r++) {
        const tile = { building: BuildingType.HOUSE, col: c, row: r };
        assert.equal(buildingGlbVariantForHex(tile), buildingGlbVariantForHex(tile));
      }
    }
  });

  test('HOUSE pick chooses between exactly the two house variants — and nothing else', () => {
    const allowed = new Set(BUILDING_GLB_BY_TYPE[BuildingType.HOUSE]);
    assert.equal(allowed.size, 2);
    for (let c = -8; c <= 8; c++) {
      for (let r = -8; r <= 8; r++) {
        const v = buildingGlbVariantForHex({ building: BuildingType.HOUSE, col: c, row: r });
        assert.ok(allowed.has(v), `picked ${v} which is not a house variant`);
      }
    }
  });

  test('HOUSE pick actually mixes both variants across a village (neither dominates)', () => {
    const counts = new Map();
    for (let c = 0; c < 16; c++) {
      for (let r = 0; r < 16; r++) {
        const v = buildingGlbVariantForHex({ building: BuildingType.HOUSE, col: c, row: r });
        counts.set(v, (counts.get(v) || 0) + 1);
      }
    }
    // Both variants should appear; neither collapses to zero.
    assert.equal(counts.size, 2, 'both house variants should be picked across a grid');
    for (const [variant, n] of counts) {
      assert.ok(n > 0, `${variant} never picked`);
    }
  });

  test('returns null for a tile with no building', () => {
    assert.equal(buildingGlbVariantForHex({ col: 0, row: 0 }), null);
    assert.equal(buildingGlbVariantForHex(null), null);
  });
});

describe('_buildBuildingInstance — positioning + jitter + metadata', () => {
  test('returns null when no template for the tile variant is loaded yet', () => {
    const inst = newInst();
    inst._babylon = makeFakeBabylon();
    // No templates loaded.
    const result = inst._buildBuildingInstance({ building: BuildingType.CHURCH, col: 0, row: 0 }, 0, 0, null);
    assert.equal(result, null);
  });

  test('createInstance is called with a per-hex unique name', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.INN][0]);
    const a = r._buildBuildingInstance({ building: BuildingType.INN, col: 3, row: 5 }, 0, 0, null);
    const b = r._buildBuildingInstance({ building: BuildingType.INN, col: 4, row: 5 }, 0, 0, null);
    assert.equal(a.name, 'bldgInst_3_5');
    assert.equal(b.name, 'bldgInst_4_5');
  });

  test('positions the instance at the NE building slot, anchored at tile-top', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.MILL][0]);
    const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
    const inst = r._buildBuildingInstance({ building: BuildingType.MILL, col: 2, row: 3 }, 10, 20, null);
    assert.ok(Math.abs(inst.position.x - (10 + slot.x)) < 1e-9, 'x slot offset');
    assert.ok(Math.abs(inst.position.z - (20 + slot.z)) < 1e-9, 'z slot offset');
    assert.ok(Math.abs(inst.position.y - 0.08) < 1e-9, `tile-top Y ${inst.position.y}`);
  });

  test('scaling combines the template scale with the uniform per-hex jitter', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    // Explicit template scale so we can assert the product exactly.
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.BARN][0], { scale: 0.4 });
    const inst = r._buildBuildingInstance({ building: BuildingType.BARN, col: 1, row: 1 }, 0, 0, null);
    const sc = houseInstanceScalingForHex(1, 1);
    assert.ok(Math.abs(inst.scaling.x - 0.4 * sc.x) < 1e-9);
    assert.ok(Math.abs(inst.scaling.y - 0.4 * sc.y) < 1e-9);
    assert.ok(Math.abs(inst.scaling.z - 0.4 * sc.z) < 1e-9);
  });

  test('falls back to HOUSE_INSTANCE_BASE_SCALE when the template has no measured scale', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.DOCK][0]); // no scale
    const inst = r._buildBuildingInstance({ building: BuildingType.DOCK, col: 2, row: 2 }, 0, 0, null);
    const sc = houseInstanceScalingForHex(2, 2);
    assert.ok(Math.abs(inst.scaling.x - HOUSE_INSTANCE_BASE_SCALE * sc.x) < 1e-9);
  });

  test('rotation yaw faces the hex centre (houseYawForHex)', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.STABLE][0]);
    const inst = r._buildBuildingInstance({ building: BuildingType.STABLE, col: 4, row: 9 }, 0, 0, null);
    assert.ok(Math.abs(inst.rotation.y - houseYawForHex(4, 9)) < 1e-9);
  });

  test('instance is unpickable, fog-immune, and on world-geometry render group', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.CHURCH][0]);
    const inst = r._buildBuildingInstance({ building: BuildingType.CHURCH, col: 0, row: 0 }, 0, 0, null);
    assert.equal(inst.isPickable, false);
    assert.equal(inst.metadata.respectsFog, false);
    assert.equal(inst.metadata.kind, 'building-glb');
    assert.equal(inst.renderingGroupId, 0);
  });

  test('HOUSE picks the right template for its hashed variant', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    // Load BOTH house variant templates so whichever the hash picks resolves.
    for (const v of BUILDING_GLB_BY_TYPE[BuildingType.HOUSE]) stubTemplate(r, v);
    for (const [c, rr] of [[0, 0], [1, 0], [2, 2], [5, 7]]) {
      const tile = { building: BuildingType.HOUSE, col: c, row: rr };
      const inst = r._buildBuildingInstance(tile, 0, 0, null);
      const expected = buildingGlbVariantForHex(tile);
      assert.equal(inst.source.name, `tpl_${expected}`,
        `(${c},${rr}) should instance the hashed variant ${expected}`);
    }
  });

  test('shadow caster registration happens via _addShadowCaster', () => {
    const r = newInst();
    const casters = [];
    r._babylon = makeFakeBabylon();
    r._shadowGenerator = { addShadowCaster: (m) => casters.push(m) };
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.GRAVEYARD][0]);
    const inst = r._buildBuildingInstance({ building: BuildingType.GRAVEYARD, col: 0, row: 0 }, 0, 0, null);
    assert.deepEqual(casters, [inst]);
  });
});

describe('_loadBuildingModel — async load + retrofit + fallback', () => {
  test('returns null when scene is not yet ready', async () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._scene   = null;
    assert.equal(await r._loadBuildingModel('models/buildings/inn.glb', 'assets'), null);
  });

  test('splits the relative path into rootUrl + fileName for ImportMeshAsync', async () => {
    const r = newInst();
    r._scene = {};
    let importArgs = null;
    r._babylon = makeFakeBabylon({
      importImpl: async (names, rootUrl, fileName) => {
        importArgs = { rootUrl, fileName };
        return { meshes: [makeFakeMesh('m', { vertices: 10 })] };
      },
    });
    await r._loadBuildingModel('models/buildings/church.glb', 'assets');
    assert.equal(importArgs.rootUrl, 'assets/models/buildings/');
    assert.equal(importArgs.fileName, 'church.glb');
  });

  test('caches the loaded source mesh + scale in _buildingTemplates', async () => {
    const r = newInst();
    r._scene = {};
    const fakeMesh = makeFakeMesh('imported', { vertices: 100, indices: 90 });
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [fakeMesh] }),
    });
    const loaded = await r._loadBuildingModel('models/buildings/mill.glb', 'assets');
    assert.equal(loaded, fakeMesh);
    const tpl = r._buildingTemplates.get('models/buildings/mill.glb');
    assert.equal(tpl.mesh, fakeMesh);
    // No measurable bbox on the fake mesh → fallback scale.
    assert.equal(tpl.scale, HOUSE_INSTANCE_BASE_SCALE);
  });

  test('computes a bbox-derived scale so the template lands at the target height', async () => {
    const r = newInst();
    r._scene = {};
    const imported = {
      name: 'tall_church', isPickable: true, isEnabled: true, renderingGroupId: 7,
      getTotalVertices: () => 100, getTotalIndices: () => 60,
      setEnabled(b) { this.isEnabled = b; },
      getBoundingInfo() { return { boundingBox: { minimumWorld: { y: 0 }, maximumWorld: { y: 4 } } }; },
    };
    r._babylon = makeFakeBabylon({ importImpl: async () => ({ meshes: [imported] }) });
    await r._loadBuildingModel('models/buildings/church.glb', 'assets');
    const tpl = r._buildingTemplates.get('models/buildings/church.glb');
    // height 4 → scale = TARGET / 4
    assert.ok(Math.abs(tpl.scale - TARGET_BUILDING_WORLD_HEIGHT / 4) < 1e-9,
      `bbox-derived scale ${tpl.scale} != ${TARGET_BUILDING_WORLD_HEIGHT / 4}`);
  });

  test('hides the source mesh and lands it on rendering group 0', async () => {
    const r = newInst();
    r._scene = {};
    const fakeMesh = makeFakeMesh('imported');
    r._babylon = makeFakeBabylon({ importImpl: async () => ({ meshes: [fakeMesh] }) });
    await r._loadBuildingModel('models/buildings/barn.glb', 'assets');
    assert.equal(fakeMesh.isEnabled, false, 'source must be hidden');
    assert.equal(fakeMesh.isPickable, false);
    assert.equal(fakeMesh.renderingGroupId, 0);
  });

  test('filters out empty meshes (e.g. the glTF __root__ TransformNode)', async () => {
    const r = newInst();
    r._scene = {};
    const empty = makeFakeMesh('__root__', { vertices: 0, indices: 0 });
    const real  = makeFakeMesh('walls', { vertices: 100 });
    r._babylon = makeFakeBabylon({ importImpl: async () => ({ meshes: [empty, real] }) });
    const loaded = await r._loadBuildingModel('models/buildings/inn.glb', 'assets');
    assert.equal(loaded, real);
  });

  test('merges multiple sub-meshes via Mesh.MergeMeshes', async () => {
    const r = newInst();
    r._scene = {};
    const walls = makeFakeMesh('walls', { vertices: 50 });
    const roof  = makeFakeMesh('roof',  { vertices: 30 });
    const merged = makeFakeMesh('merged', { vertices: 80 });
    let mergeArgs = null;
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [walls, roof] }),
      mergeImpl: (meshes, _dispose, _32, _subclass, _subdivide, multiMulti) => {
        mergeArgs = { meshes, multiMulti };
        return merged;
      },
    });
    const loaded = await r._loadBuildingModel('models/buildings/blacksmith.glb', 'assets');
    assert.equal(loaded, merged);
    assert.deepEqual(mergeArgs.meshes, [walls, roof]);
    assert.equal(mergeArgs.multiMulti, true,
      'multiMultiMaterials must be true so glTF per-submesh textures survive the merge');
  });

  test('returns null when ImportMeshAsync rejects (file missing / parse error)', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon({
      importImpl: async () => { throw new Error('404: assets/models/buildings/dock.glb'); },
    });
    const original = console.warn;
    console.warn = () => {};
    try {
      const loaded = await r._loadBuildingModel('models/buildings/dock.glb', 'assets');
      assert.equal(loaded, null);
      assert.equal(r._buildingTemplates.has('models/buildings/dock.glb'), false,
        'a failed load must not register a template (tile keeps procedural box)');
    } finally {
      console.warn = original;
    }
  });

  test('returns null when import succeeds but the GLB has no geometry', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon({ importImpl: async () => ({ meshes: [] }) });
    const original = console.warn;
    console.warn = () => {};
    try {
      const loaded = await r._loadBuildingModel('models/buildings/stable.glb', 'assets');
      assert.equal(loaded, null);
    } finally {
      console.warn = original;
    }
  });

  test('de-dupes concurrent load attempts per path via _buildingLoadPromises', async () => {
    const r = newInst();
    r._scene = {};
    let importCalls = 0;
    r._babylon = makeFakeBabylon({
      importImpl: async () => {
        importCalls++;
        return { meshes: [makeFakeMesh('mesh')] };
      },
    });
    const a = r._loadBuildingModel('models/buildings/apothecary.glb', 'assets');
    const b = r._loadBuildingModel('models/buildings/apothecary.glb', 'assets');
    const [ra, rb] = await Promise.all([a, b]);
    assert.equal(importCalls, 1, 'concurrent loads must share one ImportMeshAsync invocation');
    assert.equal(ra, rb, 'both calls resolve to the same source mesh');
  });
});

describe('_loadBuildingModels — loads every variant path', () => {
  test('loads each unique path across BUILDING_GLB_BY_TYPE exactly once', async () => {
    const r = newInst();
    r._scene = {};
    const requested = [];
    r._babylon = makeFakeBabylon({
      importImpl: async (names, rootUrl, fileName) => {
        requested.push(rootUrl + fileName);
        return { meshes: [makeFakeMesh(fileName, { vertices: 10 })] };
      },
    });
    await r._loadBuildingModels('assets');

    // Expected unique paths = 12 single-variant types + 2 HOUSE variants = 14.
    const uniquePaths = new Set();
    for (const variants of Object.values(BUILDING_GLB_BY_TYPE)) {
      for (const p of variants) uniquePaths.add(p);
    }
    assert.equal(uniquePaths.size, 14, '13 types, HOUSE has 2 → 14 unique paths');
    assert.equal(requested.length, uniquePaths.size, 'every unique path loaded once');
    for (const p of uniquePaths) {
      assert.ok(requested.includes(`assets/${p}`), `path ${p} should have been requested`);
      assert.ok(r._buildingTemplates.has(p), `template for ${p} should be cached`);
    }
  });

  test('a single failing path does not block the others', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon({
      importImpl: async (names, rootUrl, fileName) => {
        if (fileName === 'church.glb') throw new Error('boom');
        return { meshes: [makeFakeMesh(fileName, { vertices: 10 })] };
      },
    });
    const original = console.warn;
    console.warn = () => {};
    try {
      await r._loadBuildingModels('assets');
    } finally {
      console.warn = original;
    }
    assert.equal(r._buildingTemplates.has('models/buildings/church.glb'), false,
      'failed church load is absent');
    assert.ok(r._buildingTemplates.has('models/buildings/inn.glb'),
      'other types still loaded despite the church failure');
  });
});

describe('_upgradeBuildingsToGlbModel — retrofit after async load', () => {
  function makeState(buildings) {
    const tiles = new Map();
    for (const { col, row, building } of buildings) {
      tiles.set(`${col},${row}`, {
        col, row, type: TileType.BUILDING, building,
      });
    }
    return { tiles };
  }

  test('replaces procedural box+roof meshes with a GLB instance', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    r.state     = makeState([{ col: 2, row: 3, building: BuildingType.INN }]);
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.INN][0]);

    const box  = { name: 'bldg_2_3', dispose() { this._disposed = true; } };
    const roof = { name: 'roof_2_3', dispose() { this._disposed = true; } };
    const labelPlane = { name: 'bldgLabel_2_3', dispose() { this._disposed = true; } };
    r._tilePropsByKey.set('2,3', [box, roof, labelPlane]);

    const upgraded = r._upgradeBuildingsToGlbModel();
    assert.equal(upgraded, 1);
    assert.equal(box._disposed, true);
    assert.equal(roof._disposed, true);
    assert.notEqual(labelPlane._disposed, true);

    const props = r._tilePropsByKey.get('2,3');
    const inst  = props.find(p => p?.metadata?.kind === 'building-glb');
    assert.ok(inst, 'GLB instance must be present after retrofit');
    assert.ok(props.includes(labelPlane), 'hover label must survive');
  });

  test('leaves procedural box+roof in place when the tile variant template is not loaded', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    r.state     = makeState([{ col: 1, row: 1, building: BuildingType.CHURCH }]);
    // Load a DIFFERENT type's template — the church template is missing.
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.INN][0]);
    const box  = { name: 'bldg_1_1', dispose() { this._disposed = true; } };
    const roof = { name: 'roof_1_1', dispose() { this._disposed = true; } };
    r._tilePropsByKey.set('1,1', [box, roof]);

    const upgraded = r._upgradeBuildingsToGlbModel();
    assert.equal(upgraded, 0, 'church tile must not upgrade without its template');
    assert.notEqual(box._disposed, true, 'procedural box must survive');
    assert.notEqual(roof._disposed, true, 'procedural roof must survive');
    assert.equal(r._tilePropsByKey.get('1,1').some(p => p?.metadata?.kind === 'building-glb'), false);
  });

  test('idempotent — skips tiles already carrying an instance', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    r.state     = makeState([{ col: 0, row: 0, building: BuildingType.MILL }]);
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.MILL][0]);

    const first  = r._upgradeBuildingsToGlbModel();
    const second = r._upgradeBuildingsToGlbModel();
    assert.equal(first, 1);
    assert.equal(second, 0, 'second pass must find no work to do');
  });

  test('no-ops when the map is not yet built', () => {
    const r = newInst();
    r._mapBuilt = false;
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.INN][0]);
    assert.equal(r._upgradeBuildingsToGlbModel(), 0);
  });

  test('no-ops when no templates are loaded', () => {
    const r = newInst();
    r._mapBuilt = true;
    r.state = makeState([{ col: 0, row: 0, building: BuildingType.INN }]);
    assert.equal(r._upgradeBuildingsToGlbModel(), 0);
  });

  test('only touches building tiles — other tiles in _tilePropsByKey are untouched', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    const tiles = new Map();
    tiles.set('1,1', { col: 1, row: 1, type: TileType.BUILDING, building: BuildingType.INN });
    tiles.set('5,5', { col: 5, row: 5, type: TileType.FOREST });
    r.state = { tiles };
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.INN][0]);

    const tree = { name: 'tree_5_5', dispose() { this._disposed = true; } };
    r._tilePropsByKey.set('5,5', [tree]);
    r._tilePropsByKey.set('1,1', [
      { name: 'bldg_1_1', dispose() { this._disposed = true; } },
      { name: 'roof_1_1', dispose() { this._disposed = true; } },
    ]);

    r._upgradeBuildingsToGlbModel();
    assert.notEqual(tree._disposed, true, 'tree on a non-building tile must be preserved');
    assert.deepEqual(r._tilePropsByKey.get('5,5'), [tree]);
  });

  test('triggers a freeze pass so the new instance gets its world matrix locked', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    r.state     = makeState([{ col: 7, row: 7, building: BuildingType.STABLE }]);
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.STABLE][0]);
    r._tilePropsByKey.set('7,7', [
      { name: 'bldg_7_7', dispose() {} },
      { name: 'roof_7_7', dispose() {} },
    ]);

    r._upgradeBuildingsToGlbModel();
    const inst = r._tilePropsByKey.get('7,7').find(p => p?.metadata?.kind === 'building-glb');
    assert.ok(inst);
    assert.equal(inst._frozen, true,
      'freeze pass must walk _tilePropsByKey and lock the new instance');
  });

  test('mixed map: every type with a loaded template upgrades to its own model', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    const types = [BuildingType.CHURCH, BuildingType.INN, BuildingType.GRAVEYARD, BuildingType.HOUSE];
    const tiles = new Map();
    let col = 0;
    for (const t of types) {
      tiles.set(`${col},0`, { col, row: 0, type: TileType.BUILDING, building: t });
      r._tilePropsByKey.set(`${col},0`, [
        { name: `bldg_${col}_0`, dispose() {} },
        { name: `roof_${col}_0`, dispose() {} },
      ]);
      col++;
    }
    r.state = { tiles };
    // Load every variant template so all four tiles can upgrade.
    for (const t of types) {
      for (const v of BUILDING_GLB_BY_TYPE[t]) stubTemplate(r, v);
    }

    const upgraded = r._upgradeBuildingsToGlbModel();
    assert.equal(upgraded, types.length, 'all four building tiles upgrade');
    let c = 0;
    for (const t of types) {
      const tile  = { building: t, col: c, row: 0 };
      const props = r._tilePropsByKey.get(`${c},0`);
      const inst  = props.find(p => p?.metadata?.kind === 'building-glb');
      assert.ok(inst, `tile (${c},0) [${t}] should have a GLB instance`);
      const expected = buildingGlbVariantForHex(tile);
      assert.equal(inst.source.name, `tpl_${expected}`,
        `tile (${c},0) [${t}] should instance its own model (${expected})`);
      c++;
    }
  });
});

describe('_bakeOriginToBottom — pivot fix', () => {
  function makeFakeBabylonWithMatrix() {
    const b = makeFakeBabylon();
    b.Matrix = {
      Translation: (x, y, z) => ({ kind: 'translation', x, y, z }),
    };
    return b;
  }

  function makeMeshWithBoundingBox(minY) {
    const calls = [];
    return {
      _baked: null,
      _refreshed: false,
      getBoundingInfo() {
        return { boundingBox: { minimumWorld: { x: -1, y: minY, z: -1 } } };
      },
      bakeTransformIntoVertices(m) { calls.push(m); this._baked = m; },
      refreshBoundingInfo() { this._refreshed = true; },
      _bakeCalls: calls,
    };
  }

  test('shifts the mesh up so its bottom sits at local Y ≈ 0', () => {
    const BABYLON = makeFakeBabylonWithMatrix();
    const mesh = makeMeshWithBoundingBox(-0.8);
    _bakeOriginToBottom(mesh, BABYLON);
    assert.equal(mesh._bakeCalls.length, 1, 'bakeTransformIntoVertices called once');
    const m = mesh._bakeCalls[0];
    assert.equal(m.kind, 'translation');
    assert.equal(m.x, 0);
    assert.equal(m.z, 0);
    assert.ok(Math.abs(m.y - 0.8) < 1e-9, `y offset was ${m.y}, expected 0.8`);
    assert.equal(mesh._refreshed, true, 'bounding info must be refreshed post-bake');
  });

  test('no-op when bounding-box bottom is already at zero (within epsilon)', () => {
    const BABYLON = makeFakeBabylonWithMatrix();
    const mesh = makeMeshWithBoundingBox(0);
    _bakeOriginToBottom(mesh, BABYLON);
    assert.equal(mesh._bakeCalls.length, 0, 'no bake when minY ≈ 0');
  });

  test('safe on stubbed meshes lacking getBoundingInfo', () => {
    const BABYLON = makeFakeBabylonWithMatrix();
    const mesh = { bakeTransformIntoVertices() { throw new Error('should not be called'); } };
    assert.doesNotThrow(() => _bakeOriginToBottom(mesh, BABYLON));
  });

  test('safe on stubbed meshes lacking bakeTransformIntoVertices', () => {
    const BABYLON = makeFakeBabylonWithMatrix();
    const mesh = { getBoundingInfo: () => ({ boundingBox: { minimumWorld: { y: -1 } } }) };
    assert.doesNotThrow(() => _bakeOriginToBottom(mesh, BABYLON));
  });

  test('runs as part of _loadBuildingModel so instances inherit the corrected origin', async () => {
    const r = newInst();
    r._scene = {};
    const baked = [];
    const imported = {
      name: 'imported',
      isPickable: true,
      isEnabled: true,
      renderingGroupId: 7,
      getTotalVertices: () => 100,
      getTotalIndices:  () => 60,
      setEnabled(b) { this.isEnabled = b; },
      getBoundingInfo() { return { boundingBox: { minimumWorld: { y: -0.5 }, maximumWorld: { y: 0.5 } } }; },
      bakeTransformIntoVertices(m) { baked.push(m); },
      refreshBoundingInfo() {},
    };
    r._babylon = {
      ...makeFakeBabylon({ importImpl: async () => ({ meshes: [imported] }) }),
      Matrix: { Translation: (x, y, z) => ({ kind: 'translation', x, y, z }) },
    };
    await r._loadBuildingModel('models/buildings/inn.glb', 'assets');
    assert.equal(baked.length, 1, 'pivot bake must run inside _loadBuildingModel');
    assert.ok(Math.abs(baked[0].y - 0.5) < 1e-9);
  });
});
