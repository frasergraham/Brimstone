// House GLB model tests — covers the pure transform helpers + the stub-driven
// load / instance / retrofit machinery that lets `_buildTileMesh` swap the
// procedural box+roof for an instance of `assets/models/house.glb`.
//
// Babylon can't run in node-test (no WebGL), so the load + instance paths are
// exercised against a stubbed `_babylon` namespace. Pure transform math is
// tested directly. Task: t-cfee95e5.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  houseYawForHex,
  houseInstanceScalingForHex,
  buildingDimensionsForHex,
  BUILDING_BASE_DIM,
  HOUSE_MODEL_DIR,
  HOUSE_MODEL_FILE,
  HOUSE_INSTANCE_BASE_SCALE,
  TILE_SLOTS,
  BUILDING_SLOT_INDEX,
  BUILDING_GLB_BY_TYPE,
  buildingUsesHouseModel,
  _bakeOriginToBottom,
} from '../src/renderer-3d.js';

import { TileType, BuildingType, StructureType, Tile } from '../src/tiles.js';

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

/** Minimal BABYLON stub exposing only what the renderer's house pipeline
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

  test('different hexes generally produce different yaws', () => {
    const sample = new Set();
    for (let c = -5; c <= 5; c++) {
      for (let r = -5; r <= 5; r++) sample.add(houseYawForHex(c, r));
    }
    // 121 samples should fill the [0, 2π) range densely. The bar is well
    // below the sample count — collapsed-to-one would mean the hash seed
    // is wrong, but we don't expect zero hash collisions.
    assert.ok(sample.size > 60, `expected wide spread, only ${sample.size} unique yaws`);
  });
});

describe('houseInstanceScalingForHex', () => {
  test('deterministic', () => {
    assert.deepEqual(houseInstanceScalingForHex(2, 3), houseInstanceScalingForHex(2, 3));
  });

  test('matches the buildingDimensionsForHex jitter ratios on each axis', () => {
    for (let c = -4; c <= 4; c++) {
      for (let r = -4; r <= 4; r++) {
        const s    = houseInstanceScalingForHex(c, r);
        const dims = buildingDimensionsForHex(c, r);
        assert.ok(Math.abs(s.x - dims.box.width  / BUILDING_BASE_DIM.width)  < 1e-9);
        assert.ok(Math.abs(s.y - dims.box.height / BUILDING_BASE_DIM.height) < 1e-9);
        assert.ok(Math.abs(s.z - dims.box.depth  / BUILDING_BASE_DIM.depth)  < 1e-9);
      }
    }
  });

  test('per-axis ratios stay within ±15% of unity (matches BUILDING_DIM_JITTER)', () => {
    for (let c = -6; c <= 6; c++) {
      for (let r = -6; r <= 6; r++) {
        const s = houseInstanceScalingForHex(c, r);
        for (const v of [s.x, s.y, s.z]) {
          assert.ok(Math.abs(v - 1) <= 0.15 + 1e-9, `axis ${v} out of ±15% band`);
        }
      }
    }
  });
});

describe('exported constants', () => {
  test('HOUSE_MODEL_DIR points at the models subdirectory', () => {
    assert.equal(HOUSE_MODEL_DIR, 'models/');
  });
  test('HOUSE_MODEL_FILE is house.glb', () => {
    assert.equal(HOUSE_MODEL_FILE, 'house.glb');
  });
  test('HOUSE_INSTANCE_BASE_SCALE is a positive number near the procedural box width', () => {
    assert.ok(HOUSE_INSTANCE_BASE_SCALE > 0);
    assert.ok(Math.abs(HOUSE_INSTANCE_BASE_SCALE - BUILDING_BASE_DIM.width) < 0.5,
      `scale ${HOUSE_INSTANCE_BASE_SCALE} drifted far from box width ${BUILDING_BASE_DIM.width}`);
  });
});

describe('_buildHouseInstance — positioning + jitter + metadata', () => {
  test('returns null when _houseSourceMesh is not loaded yet', () => {
    const inst = newInst();
    inst._babylon = makeFakeBabylon();
    inst._houseSourceMesh = null;
    const result = inst._buildHouseInstance({ col: 0, row: 0 }, 0, 0, null);
    assert.equal(result, null);
  });

  test('createInstance is called with a per-hex unique name', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._houseSourceMesh = makeFakeMesh('house_source');
    const a = r._buildHouseInstance({ col: 3, row: 5 }, 0, 0, null);
    const b = r._buildHouseInstance({ col: 4, row: 5 }, 0, 0, null);
    assert.equal(a.name, 'bldgInst_3_5');
    assert.equal(b.name, 'bldgInst_4_5');
  });

  test('positions the instance at the NE building slot, anchored at tile-top', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._houseSourceMesh = makeFakeMesh('house_source');
    const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
    const inst = r._buildHouseInstance({ col: 2, row: 3 }, 10, 20, null);
    assert.ok(Math.abs(inst.position.x - (10 + slot.x)) < 1e-9, 'x slot offset');
    assert.ok(Math.abs(inst.position.z - (20 + slot.z)) < 1e-9, 'z slot offset');
    // Tile-top Y matches the procedural building's base (0.43 - 0.7/2 = 0.08).
    assert.ok(Math.abs(inst.position.y - 0.08) < 1e-9, `tile-top Y ${inst.position.y}`);
  });

  test('scaling combines HOUSE_INSTANCE_BASE_SCALE with the per-hex axis ratios', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._houseSourceMesh = makeFakeMesh('house_source');
    const inst = r._buildHouseInstance({ col: 1, row: 1 }, 0, 0, null);
    const sc = houseInstanceScalingForHex(1, 1);
    assert.ok(Math.abs(inst.scaling.x - HOUSE_INSTANCE_BASE_SCALE * sc.x) < 1e-9);
    assert.ok(Math.abs(inst.scaling.y - HOUSE_INSTANCE_BASE_SCALE * sc.y) < 1e-9);
    assert.ok(Math.abs(inst.scaling.z - HOUSE_INSTANCE_BASE_SCALE * sc.z) < 1e-9);
  });

  test('rotation yaw is hash-seeded per (col, row)', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._houseSourceMesh = makeFakeMesh('house_source');
    const inst = r._buildHouseInstance({ col: 4, row: 9 }, 0, 0, null);
    assert.ok(Math.abs(inst.rotation.y - houseYawForHex(4, 9)) < 1e-9);
  });

  test('instance is unpickable, fog-immune, and on world-geometry render group', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._houseSourceMesh = makeFakeMesh('house_source');
    const inst = r._buildHouseInstance({ col: 0, row: 0 }, 0, 0, null);
    assert.equal(inst.isPickable, false);
    assert.equal(inst.metadata.respectsFog, false);
    assert.equal(inst.metadata.kind, 'building-house');
    assert.equal(inst.renderingGroupId, 0);
  });

  test('shadow caster registration happens via _addShadowCaster', () => {
    const r = newInst();
    const casters = [];
    r._babylon = makeFakeBabylon();
    r._shadowGenerator = { addShadowCaster: (m) => casters.push(m) };
    r._houseSourceMesh = makeFakeMesh('house_source');
    const inst = r._buildHouseInstance({ col: 0, row: 0 }, 0, 0, null);
    assert.deepEqual(casters, [inst]);
  });
});

describe('_loadHouseModel — async load + retrofit + fallback', () => {
  test('returns null when scene is not yet ready', async () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._scene   = null;
    assert.equal(await r._loadHouseModel('assets'), null);
  });

  test('caches the loaded source mesh on _houseSourceMesh', async () => {
    const r = newInst();
    r._scene = { _id: 'scene' };
    const fakeMesh = makeFakeMesh('imported_house', { vertices: 100, indices: 90 });
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [fakeMesh] }),
    });
    const loaded = await r._loadHouseModel('assets');
    assert.equal(loaded, fakeMesh);
    assert.equal(r._houseSourceMesh, fakeMesh);
  });

  test('hides the source mesh and lands it on rendering group 0', async () => {
    const r = newInst();
    r._scene = {};
    const fakeMesh = makeFakeMesh('imported_house');
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [fakeMesh] }),
    });
    await r._loadHouseModel('assets');
    assert.equal(fakeMesh.isEnabled, false, 'source must be hidden');
    assert.equal(fakeMesh.isPickable, false);
    assert.equal(fakeMesh.renderingGroupId, 0);
  });

  test('filters out empty meshes (e.g. the glTF __root__ TransformNode)', async () => {
    const r = newInst();
    r._scene = {};
    const empty = makeFakeMesh('__root__', { vertices: 0, indices: 0 });
    const real  = makeFakeMesh('walls', { vertices: 100 });
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [empty, real] }),
    });
    const loaded = await r._loadHouseModel('assets');
    assert.equal(loaded, real);
  });

  test('merges multiple sub-meshes via Mesh.MergeMeshes', async () => {
    const r = newInst();
    r._scene = {};
    const walls = makeFakeMesh('walls', { vertices: 50 });
    const roof  = makeFakeMesh('roof',  { vertices: 30 });
    const merged = makeFakeMesh('merged_house', { vertices: 80 });
    let mergeArgs = null;
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [walls, roof] }),
      mergeImpl: (meshes, _dispose, _32, _subclass, _subdivide, multiMulti) => {
        mergeArgs = { meshes, multiMulti };
        return merged;
      },
    });
    const loaded = await r._loadHouseModel('assets');
    assert.equal(loaded, merged);
    assert.deepEqual(mergeArgs.meshes, [walls, roof]);
    assert.equal(mergeArgs.multiMulti, true,
      'multiMultiMaterials must be true so glTF per-submesh textures survive the merge');
  });

  test('returns null when ImportMeshAsync rejects (file missing / parse error)', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon({
      importImpl: async () => { throw new Error('404: assets/models/house.glb'); },
    });
    const original = console.warn;
    console.warn = () => {};
    try {
      const loaded = await r._loadHouseModel('assets');
      assert.equal(loaded, null);
      assert.equal(r._houseSourceMesh, null);
    } finally {
      console.warn = original;
    }
  });

  test('returns null when import succeeds but the GLB has no geometry', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [] }),
    });
    const original = console.warn;
    console.warn = () => {};
    try {
      const loaded = await r._loadHouseModel('assets');
      assert.equal(loaded, null);
    } finally {
      console.warn = original;
    }
  });

  test('de-dupes concurrent load attempts via _houseLoadPromise', async () => {
    const r = newInst();
    r._scene = {};
    let importCalls = 0;
    r._babylon = makeFakeBabylon({
      importImpl: async () => {
        importCalls++;
        return { meshes: [makeFakeMesh('mesh')] };
      },
    });
    const a = r._loadHouseModel('assets');
    const b = r._loadHouseModel('assets');
    const [ra, rb] = await Promise.all([a, b]);
    // The async function wraps the inner promise in a fresh outer Promise
    // each call, so `a !== b`. The de-dupe guarantee is that ImportMeshAsync
    // is invoked at most once — the second call falls into the
    // `_houseLoadPromise` shortcut and resolves to the same source mesh.
    assert.equal(importCalls, 1, 'concurrent loads must share one ImportMeshAsync invocation');
    assert.equal(ra, rb, 'both calls resolve to the same source mesh');
  });
});

describe('_upgradeBuildingsToHouseModel — retrofit after async load', () => {
  function makeState(buildingHexes) {
    const tiles = new Map();
    for (const { col, row } of buildingHexes) {
      tiles.set(`${col},${row}`, {
        col, row, type: TileType.BUILDING, building: BuildingType.HOUSE,
      });
    }
    return { tiles };
  }

  test('replaces procedural box+roof meshes with a house instance', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    r.state     = makeState([{ col: 2, row: 3 }]);
    r._houseSourceMesh = makeFakeMesh('house_source');

    // Pre-existing procedural building props for tile (2,3).
    const box  = { name: 'bldg_2_3', dispose() { this._disposed = true; } };
    const roof = { name: 'roof_2_3', dispose() { this._disposed = true; } };
    const labelPlane = { name: 'bldgLabel_2_3', dispose() { this._disposed = true; } };
    r._tilePropsByKey.set('2,3', [box, roof, labelPlane]);

    const upgraded = r._upgradeBuildingsToHouseModel();
    assert.equal(upgraded, 1);
    assert.equal(box._disposed, true);
    assert.equal(roof._disposed, true);
    // Non-bldg / non-roof props (e.g. hover labels) are left alone.
    assert.notEqual(labelPlane._disposed, true);

    const props = r._tilePropsByKey.get('2,3');
    const inst  = props.find(p => p?.metadata?.kind === 'building-house');
    assert.ok(inst, 'house instance must be present after retrofit');
    assert.ok(props.includes(labelPlane), 'hover label must survive');
  });

  test('idempotent — skips tiles already carrying an instance', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    r.state     = makeState([{ col: 0, row: 0 }]);
    r._houseSourceMesh = makeFakeMesh('house_source');

    const first  = r._upgradeBuildingsToHouseModel();
    const second = r._upgradeBuildingsToHouseModel();
    assert.equal(first, 1);
    assert.equal(second, 0, 'second pass must find no work to do');
  });

  test('no-ops when the map is not yet built', () => {
    const r = newInst();
    r._mapBuilt = false;
    r._houseSourceMesh = makeFakeMesh('house_source');
    assert.equal(r._upgradeBuildingsToHouseModel(), 0);
  });

  test('no-ops when the source mesh is missing', () => {
    const r = newInst();
    r._mapBuilt = true;
    r.state = makeState([{ col: 0, row: 0 }]);
    r._houseSourceMesh = null;
    assert.equal(r._upgradeBuildingsToHouseModel(), 0);
  });

  test('only touches BUILDING tiles — other tiles in _tilePropsByKey are untouched', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    // State has only one BUILDING tile + one bystander tree tile in props.
    const tiles = new Map();
    tiles.set('1,1', { col: 1, row: 1, type: TileType.BUILDING, building: BuildingType.HOUSE });
    tiles.set('5,5', { col: 5, row: 5, type: TileType.FOREST });
    r.state = { tiles };
    r._houseSourceMesh = makeFakeMesh('house_source');

    const tree = { name: 'tree_5_5', dispose() { this._disposed = true; } };
    r._tilePropsByKey.set('5,5', [tree]);
    r._tilePropsByKey.set('1,1', [
      { name: 'bldg_1_1', dispose() { this._disposed = true; } },
      { name: 'roof_1_1', dispose() { this._disposed = true; } },
    ]);

    r._upgradeBuildingsToHouseModel();
    assert.notEqual(tree._disposed, true, 'tree on a non-building tile must be preserved');
    assert.deepEqual(r._tilePropsByKey.get('5,5'), [tree]);
  });

  test('triggers a freeze pass so the new instance gets its world matrix locked', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    r.state     = makeState([{ col: 7, row: 7 }]);
    r._houseSourceMesh = makeFakeMesh('house_source');
    r._tilePropsByKey.set('7,7', [
      { name: 'bldg_7_7', dispose() {} },
      { name: 'roof_7_7', dispose() {} },
    ]);

    r._upgradeBuildingsToHouseModel();
    const inst = r._tilePropsByKey.get('7,7').find(p => p?.metadata?.kind === 'building-house');
    assert.ok(inst);
    assert.equal(inst._frozen, true,
      'freeze pass must walk _tilePropsByKey and lock the new instance');
  });
});

describe('integration: house source available during _buildTileMesh', () => {
  // We can't call the real `_buildTileMesh` (it pokes too many Babylon APIs),
  // but we can confirm the branch logic by inspecting what
  // `_upgradeBuildingsToHouseModel` does end-to-end: with a source loaded
  // post-build, every building tile ends up with exactly one instance.
  test('every building tile gets exactly one house instance after retrofit', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    const tiles = new Map();
    const buildings = [
      { col: 0, row: 0 }, { col: 1, row: 0 }, { col: 0, row: 1 }, { col: 3, row: 5 },
    ];
    for (const { col, row } of buildings) {
      tiles.set(`${col},${row}`, { col, row, type: TileType.BUILDING, building: BuildingType.HOUSE });
      r._tilePropsByKey.set(`${col},${row}`, [
        { name: `bldg_${col}_${row}`, dispose() {} },
        { name: `roof_${col}_${row}`, dispose() {} },
      ]);
    }
    r.state = { tiles };
    r._houseSourceMesh = makeFakeMesh('house_source');

    const upgraded = r._upgradeBuildingsToHouseModel();
    assert.equal(upgraded, buildings.length);
    for (const { col, row } of buildings) {
      const props = r._tilePropsByKey.get(`${col},${row}`);
      const insts = props.filter(p => p?.metadata?.kind === 'building-house');
      assert.equal(insts.length, 1, `tile (${col},${row}) should have 1 house instance`);
    }
  });
});

describe('BUILDING_GLB_BY_TYPE — only HOUSE has an asset entry', () => {
  test('contains a HOUSE → assets/models/house.glb mapping', () => {
    assert.equal(BUILDING_GLB_BY_TYPE[BuildingType.HOUSE], `${HOUSE_MODEL_DIR}${HOUSE_MODEL_FILE}`);
  });

  test('does NOT list INN / GRAVEYARD / CHURCH / other building types', () => {
    const nonHouseTypes = Object.values(BuildingType).filter(t => t !== BuildingType.HOUSE);
    for (const t of nonHouseTypes) {
      assert.equal(BUILDING_GLB_BY_TYPE[t], undefined,
        `building type "${t}" must not yet map to a GLB`);
    }
  });

  test('is frozen so accidental writes during render don\'t mutate the table', () => {
    assert.ok(Object.isFrozen(BUILDING_GLB_BY_TYPE));
  });
});

describe('buildingUsesHouseModel — gating predicate', () => {
  test('true only for BUILDING tiles whose building === HOUSE', () => {
    assert.equal(
      buildingUsesHouseModel({ type: TileType.BUILDING, building: BuildingType.HOUSE }),
      true,
    );
  });

  test('false for every non-HOUSE building type', () => {
    for (const t of Object.values(BuildingType)) {
      if (t === BuildingType.HOUSE) continue;
      assert.equal(
        buildingUsesHouseModel({ type: TileType.BUILDING, building: t }),
        false,
        `building "${t}" must NOT use the house GLB`,
      );
    }
  });

  test('false for tiles with no building (layered model: base material only)', () => {
    // In the layered model a tile is a building when it has a structure /
    // building — NOT by tile.type. A forest or grass tile with no building
    // field is not a building.
    const forest = new Tile(0, 0, TileType.FOREST);
    const grass  = new Tile(0, 0, TileType.GRASS);
    assert.equal(buildingUsesHouseModel(forest), false);
    assert.equal(buildingUsesHouseModel(grass), false);
  });

  test('P3 payoff: a HOUSE building on a forest base still uses the house GLB', () => {
    // A building can now sit on any base material (e.g. a house on a forest
    // tile, with trees rendered alongside). It's still a building, so the
    // house-GLB gate is keyed on the structure/building, not the base.
    const houseOnForest = new Tile(2, 3, TileType.FOREST);
    houseOnForest.structure = StructureType.BUILDING;
    houseOnForest.building  = BuildingType.HOUSE;
    assert.equal(buildingUsesHouseModel(houseOnForest), true);
  });

  test('false for null / undefined input', () => {
    assert.equal(buildingUsesHouseModel(null), false);
    assert.equal(buildingUsesHouseModel(undefined), false);
  });
});

describe('_upgradeBuildingsToHouseModel — HOUSE-only scope', () => {
  test('non-HOUSE building tiles keep their procedural box+roof', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    const tiles = new Map();
    // Cover every non-HOUSE building type to guard against future regressions.
    const nonHouseTypes = Object.values(BuildingType).filter(t => t !== BuildingType.HOUSE);
    let col = 0;
    for (const t of nonHouseTypes) {
      tiles.set(`${col},0`, { col, row: 0, type: TileType.BUILDING, building: t });
      r._tilePropsByKey.set(`${col},0`, [
        { name: `bldg_${col}_0`, dispose() { this._disposed = true; } },
        { name: `roof_${col}_0`, dispose() { this._disposed = true; } },
      ]);
      col++;
    }
    r.state = { tiles };
    r._houseSourceMesh = makeFakeMesh('house_source');

    const upgraded = r._upgradeBuildingsToHouseModel();
    assert.equal(upgraded, 0, 'no non-HOUSE building should upgrade');
    // Procedural meshes must still be present (not disposed).
    for (let c = 0; c < nonHouseTypes.length; c++) {
      const props = r._tilePropsByKey.get(`${c},0`);
      assert.equal(props.length, 2, `tile (${c},0) keeps both procedural meshes`);
      assert.notEqual(props[0]._disposed, true);
      assert.notEqual(props[1]._disposed, true);
      assert.equal(props.some(p => p?.metadata?.kind === 'building-house'), false);
    }
  });

  test('mixed map: HOUSE tiles upgrade, non-HOUSE tiles untouched', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    const tiles = new Map();
    tiles.set('0,0', { col: 0, row: 0, type: TileType.BUILDING, building: BuildingType.HOUSE });
    tiles.set('1,0', { col: 1, row: 0, type: TileType.BUILDING, building: BuildingType.INN });
    tiles.set('2,0', { col: 2, row: 0, type: TileType.BUILDING, building: BuildingType.GRAVEYARD });
    for (const k of ['0,0', '1,0', '2,0']) {
      const [c, rr] = k.split(',').map(Number);
      r._tilePropsByKey.set(k, [
        { name: `bldg_${c}_${rr}`, dispose() { this._disposed = true; } },
        { name: `roof_${c}_${rr}`, dispose() { this._disposed = true; } },
      ]);
    }
    r.state = { tiles };
    r._houseSourceMesh = makeFakeMesh('house_source');

    const upgraded = r._upgradeBuildingsToHouseModel();
    assert.equal(upgraded, 1, 'exactly the HOUSE tile upgrades');
    // HOUSE tile: procedural meshes disposed, instance added.
    const houseProps = r._tilePropsByKey.get('0,0');
    assert.ok(houseProps.some(p => p?.metadata?.kind === 'building-house'));
    // INN / GRAVEYARD tiles: still hold their procedural meshes, no instance.
    for (const k of ['1,0', '2,0']) {
      const props = r._tilePropsByKey.get(k);
      assert.equal(props.length, 2, `tile ${k} keeps procedural meshes`);
      assert.equal(props.some(p => p?.metadata?.kind === 'building-house'), false);
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
    // minY was -0.8 → yOffset = +0.8 (lifts the mesh so its floor lands at 0).
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

  test('runs as part of _loadHouseModel so instances inherit the corrected origin', async () => {
    const r = newInst();
    r._scene = {};
    const baked = [];
    const imported = {
      name: 'imported_house',
      isPickable: true,
      isEnabled: true,
      renderingGroupId: 7,
      getTotalVertices: () => 100,
      getTotalIndices:  () => 60,
      setEnabled(b) { this.isEnabled = b; },
      getBoundingInfo() { return { boundingBox: { minimumWorld: { y: -0.5 } } }; },
      bakeTransformIntoVertices(m) { baked.push(m); },
      refreshBoundingInfo() {},
    };
    r._babylon = {
      ...makeFakeBabylon({ importImpl: async () => ({ meshes: [imported] }) }),
      Matrix: { Translation: (x, y, z) => ({ kind: 'translation', x, y, z }) },
    };
    await r._loadHouseModel('assets');
    assert.equal(baked.length, 1, 'pivot bake must run inside _loadHouseModel');
    assert.ok(Math.abs(baked[0].y - 0.5) < 1e-9);
  });
});
