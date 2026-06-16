// Regression tests for the "buildings don't RECEIVE shadows" bug.
//
// Buildings registered as shadow CASTERS via `_addShadowCaster` but never set
// `receiveShadows`, so other objects' shadows (a unit cone, a neighbouring
// tree, the roof onto the wall) never landed on a building surface. Babylon's
// InstancedMesh inherits `receiveShadows` from its source template, and the
// template defaulted to false — so every building instance was a non-receiver.
//
// The fix sets `receiveShadows = true` on:
//   1. the building GLB *template* in `_loadBuildingModel` (durable — instances inherit)
//   2. the building GLB *instance* in `_buildBuildingInstance` (belt-and-suspenders)
//   3. the procedural box + roof fallback in `_buildTileMesh`
//
// Babylon can't run under node-test (no WebGL), so the paths are exercised
// against stubbed `_babylon` namespaces — same approach as the house-glb +
// shadow-receiver suites.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  BUILDING_GLB_BY_TYPE,
  buildingDimensionsForHex,
} from '../src/renderer-3d.js';

import { TileType, BuildingType, StructureType, Tile } from '../src/tiles.js';

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

function makeFakeBabylon({ importImpl } = {}) {
  const Vector3 = class {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  };
  Vector3.Zero = () => new Vector3(0, 0, 0);
  return {
    Vector3,
    Mesh: { MergeMeshes: () => null },
    SceneLoader: { ImportMeshAsync: importImpl || (async () => ({ meshes: [] })) },
    Matrix: { Translation: (x, y, z) => ({ kind: 'translation', x, y, z }) },
  };
}

// ── 1. Template (durable fix) ───────────────────────────────────────────────
describe('_loadBuildingModel — template becomes a shadow receiver', () => {
  function makeImportedMesh(name, { children = [] } = {}) {
    return {
      name,
      isPickable: true,
      isEnabled: true,
      renderingGroupId: 7,
      receiveShadows: false, // mirrors real Babylon default
      getTotalVertices: () => 100,
      getTotalIndices: () => 60,
      setEnabled(b) { this.isEnabled = b; },
      getChildMeshes: () => children,
    };
  }

  test('sets receiveShadows = true on the loaded template source mesh', async () => {
    const r = newInst();
    r._scene = {};
    const imported = makeImportedMesh('inn');
    r._babylon = makeFakeBabylon({ importImpl: async () => ({ meshes: [imported] }) });

    assert.equal(imported.receiveShadows, false, 'precondition: defaults to false');
    await r._loadBuildingModel('models/buildings/inn.glb', 'assets');
    assert.equal(imported.receiveShadows, true,
      'building template must receive shadows so every instance inherits it');
    // And it is the cached template.
    assert.equal(r._buildingTemplates.get('models/buildings/inn.glb').mesh, imported);
  });

  test('also covers retained sub-meshes in the un-merged single-mesh case', async () => {
    const r = newInst();
    r._scene = {};
    const childA = { name: 'walls', receiveShadows: false };
    const childB = { name: 'roof', receiveShadows: false };
    const imported = makeImportedMesh('church', { children: [childA, childB] });
    r._babylon = makeFakeBabylon({ importImpl: async () => ({ meshes: [imported] }) });

    await r._loadBuildingModel('models/buildings/church.glb', 'assets');
    assert.equal(imported.receiveShadows, true);
    assert.equal(childA.receiveShadows, true, 'sub-mesh must also receive shadows');
    assert.equal(childB.receiveShadows, true);
  });
});

// ── 2. Instance (belt-and-suspenders) ───────────────────────────────────────
describe('_buildBuildingInstance — instance is a shadow receiver', () => {
  function stubTemplate(r, relPath) {
    const mesh = {
      name: `tpl_${relPath}`,
      createInstance(n) {
        return {
          name: n,
          isPickable: true,
          metadata: null,
          // Real InstancedMesh inherits this from the source; the stub starts
          // at the unhelpful default so the explicit instance write is observable.
          receiveShadows: false,
          position: { x: 0, y: 0, z: 0 },
          scaling: null,
          rotation: null,
          parent: null,
          renderingGroupId: 7,
        };
      },
    };
    r._buildingTemplates.set(relPath, { mesh });
    return mesh;
  }

  test('sets receiveShadows = true on the built instance', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.INN][0]);
    const inst = r._buildBuildingInstance(
      { building: BuildingType.INN, col: 2, row: 3 }, 0, 0, null,
    );
    assert.ok(inst, 'instance must be built');
    assert.equal(inst.receiveShadows, true,
      'building GLB instance must receive shadows (was false before the fix)');
  });

  test('still registers the instance as a shadow CASTER (regression guard)', () => {
    const r = newInst();
    const casters = [];
    r._babylon = makeFakeBabylon();
    r._shadowGenerator = { addShadowCaster: (m) => casters.push(m) };
    stubTemplate(r, BUILDING_GLB_BY_TYPE[BuildingType.GRAVEYARD][0]);
    const inst = r._buildBuildingInstance(
      { building: BuildingType.GRAVEYARD, col: 0, row: 0 }, 0, 0, null,
    );
    assert.deepEqual(casters, [inst], 'buildings must still CAST as well as receive');
    assert.equal(inst.receiveShadows, true);
  });
});

// ── 3. Procedural box + roof fallback ───────────────────────────────────────
describe('_buildTileMesh — procedural box + roof receive shadows', () => {
  function makeBoxBabylon() {
    const Vector3 = class {
      constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
    };
    return {
      Vector3,
      MeshBuilder: {
        CreateBox(name) {
          return {
            name,
            isPickable: true,
            receiveShadows: false, // Babylon default
            metadata: null,
            parent: null,
            material: null,
            position: { x: 0, y: 0, z: 0 },
          };
        },
      },
    };
  }

  function buildingTile() {
    const t = new Tile(2, 3, TileType.GRASS);
    t.structure = StructureType.BUILDING;
    t.building  = BuildingType.INN;
    return t;
  }

  test('box (bldg_…) and roof (roof_…) both have receiveShadows = true', () => {
    const r = newInst();
    r._babylon = makeBoxBabylon();
    r._scene   = {};
    // No GLB template loaded → `_buildBuildingInstance` returns null → the
    // procedural box+roof path runs.
    // Isolate the box/roof code by stubbing the heavy scene-touching helpers.
    r._buildFlatHexMesh   = (name) => ({ name, material: null, metadata: null });
    r._tileMaterialFor    = () => null;
    r._materialFor        = () => null;
    r._buildBuildingGroundLabel = () => {};
    // _shadowGenerator stays null → `_addShadowCaster` is a safe no-op.

    const tile = buildingTile();
    r._buildTileMesh(tile, { name: 'mapRoot' });

    const props = r._tilePropsByKey.get('2,3') || [];
    const box  = props.find(m => m.name === 'bldg_2_3');
    const roof = props.find(m => m.name === 'roof_2_3');
    assert.ok(box,  'procedural box must be built when no GLB template is loaded');
    assert.ok(roof, 'procedural roof must be built');
    assert.equal(box.receiveShadows, true,
      'procedural building box must receive shadows');
    assert.equal(roof.receiveShadows, true,
      'procedural building roof must receive shadows');
  });

  test('procedural box dimensions still come from buildingDimensionsForHex (no regression)', () => {
    const r = newInst();
    r._babylon = makeBoxBabylon();
    r._scene   = {};
    r._buildFlatHexMesh   = (name) => ({ name, material: null, metadata: null });
    r._tileMaterialFor    = () => null;
    r._materialFor        = () => null;
    r._buildBuildingGroundLabel = () => {};

    // Spy on the box builder to capture the options passed.
    const created = [];
    const realCreate = r._babylon.MeshBuilder.CreateBox;
    r._babylon.MeshBuilder.CreateBox = (name, opts, scene) => {
      created.push({ name, opts });
      return realCreate(name, opts, scene);
    };

    r._buildTileMesh(buildingTile(), { name: 'mapRoot' });
    const dims = buildingDimensionsForHex(2, 3);
    const box  = created.find(c => c.name === 'bldg_2_3');
    assert.ok(box);
    assert.ok(Math.abs(box.opts.width - dims.box.width) < 1e-9, 'box width unchanged');
    assert.ok(Math.abs(box.opts.height - dims.box.height) < 1e-9, 'box height unchanged');
  });
});
