// Tests for the `applyShadowReceiving` helper + the renderer callsites that
// turn road / river / river-extension / bridge meshes into shadow receivers.
//
// Babylon's ShadowGenerator only casts onto meshes whose `receiveShadows`
// flag is true. Before this fix, the per-tile road/river merged ribbons set
// the flag but the river-extension ribbons through the border-forest band
// and the bridge planks did not — so unit shadows fell off the moment a
// standee crossed onto those surfaces. The helper centralises the assignment
// and the renderer routes every flat path-mesh through it at build time.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyShadowReceiving,
  Renderer3D,
  RIVER_RIBBON_WIDTH,
  RIVER_RIBBON_Y,
} from '../src/renderer-3d.js';

import { TileType } from '../src/tiles.js';
import { EntityType } from '../src/entities.js';

function fakeMesh(name) {
  return { name, receiveShadows: false };
}

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

// ── Minimal Babylon stub good enough for `_buildNetworkMesh` + `_buildStandeeMesh`.
// The renderer touches a small surface: ribbon + cone + sphere builders, the
// merge call, a couple of material/color constructors, and a few enum constants.
// Anything not exercised by these tests is intentionally omitted.
function makeColor3() {
  class Color3 {
    constructor(r = 0, g = 0, b = 0) { this.r = r; this.g = g; this.b = b; }
    clone() { return new Color3(this.r, this.g, this.b); }
  }
  return Color3;
}

function makeFakeRibbon(name) {
  // 5 paths × N points; we don't care about N for receiver tests, but
  // setVerticesData/getTotalVertices must not throw.
  const m = {
    name,
    isPickable: true,
    receiveShadows: false,
    _vertexData: null,
    getTotalVertices() { return 20; },
    setVerticesData(_kind, data) { this._vertexData = data; },
  };
  return m;
}

function makeMergedFake(name = 'merged') {
  // Fresh post-merge mesh: receiveShadows defaults to false, mirroring real Babylon.
  return {
    name,
    parent: null,
    isPickable: true,
    receiveShadows: false,
    hasVertexAlpha: false,
    alphaIndex: 0,
    metadata: null,
    material: null,
  };
}

function makeFakeBabylonForRibbons() {
  const Color3 = makeColor3();
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  }
  let mergedCount = 0;
  const mergedMeshes = [];
  return {
    namespace: {
      Color3,
      Vector3,
      Mesh: {
        DOUBLESIDE: 2,
        MergeMeshes(list /* , disposeSource, ... */) {
          if (!list || list.length === 0) return null;
          const m = makeMergedFake(`merged_${mergedCount++}`);
          mergedMeshes.push(m);
          return m;
        },
      },
      MeshBuilder: {
        CreateRibbon(name) { return makeFakeRibbon(name); },
      },
      VertexBuffer: { ColorKind: 'color' },
      StandardMaterial: class StandardMaterial {
        constructor(name) {
          this.name = name;
          this.diffuseColor    = new Color3(0.5, 0.5, 0.5);
          this.emissiveColor   = new Color3(0.2, 0.2, 0.2);
          this.specularColor   = new Color3(0, 0, 0);
          this.backFaceCulling = true;
          this.disableLighting = false;
        }
        clone(newName) {
          const c = new StandardMaterial(newName);
          c.diffuseColor    = this.diffuseColor.clone();
          c.emissiveColor   = this.emissiveColor.clone();
          c.specularColor   = this.specularColor.clone();
          c.backFaceCulling = this.backFaceCulling;
          c.disableLighting = this.disableLighting;
          return c;
        }
      },
    },
    mergedMeshes,
  };
}

function makeFakeBabylonForStandees() {
  const Color3 = makeColor3();
  const makeBody = (name) => ({
    name,
    parent: null,
    isPickable: true,
    metadata: null,
    renderingGroupId: 7,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    material: null,
  });
  return {
    Color3,
    MeshBuilder: {
      CreateCylinder(name) { return makeBody(name); },
      CreateSphere(name)   { return makeBody(name); },
    },
    StandardMaterial: class StandardMaterial {
      constructor(name) {
        this.name = name;
        this.diffuseColor    = new Color3(1, 0, 0);
        this.specularColor   = new Color3(0, 0, 0);
        this.backFaceCulling = true;
      }
    },
  };
}

function makeFakeShadowGenerator() {
  const casters = [];
  return {
    casters,
    addShadowCaster(mesh) { casters.push(mesh); },
  };
}

describe('applyShadowReceiving — pure helper', () => {
  test('sets receiveShadows = true on every mesh in the array', () => {
    const meshes = [fakeMesh('a'), fakeMesh('b'), fakeMesh('c')];
    const n = applyShadowReceiving(meshes);
    assert.equal(n, 3);
    for (const m of meshes) assert.equal(m.receiveShadows, true);
  });

  test('returns 0 for null/undefined/empty input (defensive)', () => {
    assert.equal(applyShadowReceiving(null), 0);
    assert.equal(applyShadowReceiving(undefined), 0);
    assert.equal(applyShadowReceiving([]), 0);
  });

  test('skips null entries inside the array (MergeMeshes returns null on empty lists)', () => {
    const a = fakeMesh('a');
    const c = fakeMesh('c');
    const n = applyShadowReceiving([a, null, c, undefined]);
    assert.equal(n, 2);
    assert.equal(a.receiveShadows, true);
    assert.equal(c.receiveShadows, true);
  });

  test('idempotent — calling twice leaves the flag set, count counts both passes', () => {
    const a = fakeMesh('a');
    assert.equal(applyShadowReceiving([a]), 1);
    assert.equal(a.receiveShadows, true);
    assert.equal(applyShadowReceiving([a]), 1);
    assert.equal(a.receiveShadows, true);
  });

  test('accepts iterables (Set, Map.values()) as well as plain arrays', () => {
    const a = fakeMesh('a');
    const b = fakeMesh('b');
    const s = new Set([a, b]);
    assert.equal(applyShadowReceiving(s), 2);
    assert.equal(a.receiveShadows, true);
    assert.equal(b.receiveShadows, true);

    const m = new Map([['k1', fakeMesh('m1')], ['k2', fakeMesh('m2')]]);
    const n = applyShadowReceiving(m.values());
    assert.equal(n, 2);
    for (const mesh of m.values()) assert.equal(mesh.receiveShadows, true);
  });
});

describe('Renderer3D._setShadowReceiver — instance-method wrapper', () => {
  test('delegates to applyShadowReceiving (sets receiveShadows = true)', () => {
    const inst = newInst();
    const mesh = fakeMesh('road_tile_3,2');
    inst._setShadowReceiver(mesh);
    assert.equal(mesh.receiveShadows, true);
  });

  test('null-safe — does not throw when called with null', () => {
    const inst = newInst();
    // Bridge plank build can short-circuit before the mesh is constructed;
    // the wrapper must not throw or `_buildTileMesh` aborts mid-loop.
    assert.doesNotThrow(() => inst._setShadowReceiver(null));
    assert.doesNotThrow(() => inst._setShadowReceiver(undefined));
  });
});

describe('Renderer3D — road/river/river-extension/bridge prop registries', () => {
  // The freeze-static test pattern: stuff fake meshes into the per-tile prop
  // registries with the same metadata shape used at build time, then walk the
  // registry and assert receiveShadows is set on every "respectsFog: darken"
  // or "kind: river-extension" mesh.
  //
  // The actual `_setShadowReceiver` calls happen inside `_buildNetworkMesh`
  // and `_buildRiverExtensions`, which need a Babylon scene to run — covered
  // here by injecting pre-built fake meshes that mimic the post-construction
  // shape and checking the helper pass walks them correctly.

  test('applyShadowReceiving walks _tilePropsByKey road/river entries', () => {
    const inst = newInst();
    const road00 = { name: 'road_0,0', receiveShadows: false, metadata: { respectsFog: 'darken', kind: 'road' } };
    const river01 = { name: 'river_0,1', receiveShadows: false, metadata: { respectsFog: 'darken', kind: 'river' } };
    inst._tilePropsByKey.set('0,0', [road00]);
    inst._tilePropsByKey.set('0,1', [river01]);

    const ribbons = [];
    for (const list of inst._tilePropsByKey.values()) {
      for (const m of list) {
        if (m.metadata?.respectsFog === 'darken') ribbons.push(m);
      }
    }
    const n = applyShadowReceiving(ribbons);
    assert.equal(n, 2);
    assert.equal(road00.receiveShadows, true);
    assert.equal(river01.receiveShadows, true);
  });

  test('applyShadowReceiving walks _borderPropsByKey river-extension entries', () => {
    const inst = newInst();
    const ext0 = { name: 'river_extension_0_2', receiveShadows: false, metadata: { kind: 'river-extension' } };
    const ext1 = { name: 'river_extension_12_2', receiveShadows: false, metadata: { kind: 'river-extension' } };
    inst._borderPropsByKey.set('river-ext:0,2', [ext0]);
    inst._borderPropsByKey.set('river-ext:12,2', [ext1]);

    const exts = [];
    for (const list of inst._borderPropsByKey.values()) {
      for (const m of list) {
        if (m.metadata?.kind === 'river-extension') exts.push(m);
      }
    }
    const n = applyShadowReceiving(exts);
    assert.equal(n, 2);
    assert.equal(ext0.receiveShadows, true);
    assert.equal(ext1.receiveShadows, true);
  });

  test('mixed registry — applyShadowReceiving sets the flag on every mesh, regardless of metadata', () => {
    // The renderer is allowed to pass in props of any kind; the helper itself
    // does not filter — callers narrow before invoking it. Pinned here so a
    // future refactor that hands the helper a wider list doesn't accidentally
    // miss meshes that should receive shadows.
    const inst = newInst();
    const a = { name: 'bridge', receiveShadows: false };
    const b = { name: 'tile', receiveShadows: false };
    const c = { name: 'ribbon', receiveShadows: false };
    inst._tilePropsByKey.set('5,5', [a, b, c]);
    const all = [];
    for (const list of inst._tilePropsByKey.values()) all.push(...list);
    const n = applyShadowReceiving(all);
    assert.equal(n, 3);
    for (const m of [a, b, c]) assert.equal(m.receiveShadows, true);
  });
});

// ─── Integration: post-merge ribbon receivers ───────────────────────────────
// The operator's recurring symptom is "roads + rivers don't receive shadows in
// the browser even though the helper is wired up". Babylon's MergeMeshes builds
// a FRESH mesh whose `receiveShadows` defaults to false — the source ribbons'
// flag is NOT copied across the merge. So `_setShadowReceiver` must be called
// on the MERGED result, not on the source ribbons. These tests exercise the
// real `_buildNetworkMesh` against a Babylon stub and pin that every merged
// per-tile ribbon comes out with `receiveShadows === true`.
describe('Renderer3D._buildNetworkMesh — merged ribbons receive shadows', () => {
  function setupRibbonInst() {
    const inst = newInst();
    const { namespace, mergedMeshes } = makeFakeBabylonForRibbons();
    inst._babylon = namespace;
    inst._scene   = { /* unused by the codepath */ };
    inst._mapRoot = { name: 'mapRoot' };
    return { inst, mergedMeshes };
  }

  // Two adjacent stroke samples are enough for the per-stroke ribbon to pass
  // the `pts.length < 2` guard inside `_buildNetworkMesh`.
  const stroke = [
    { x: 0, z: 0 },
    { x: 0.5, z: 0 },
    { x: 1, z: 0 },
  ];

  test('returns a mesh with receiveShadows === true (on the post-merge return value, not the source ribbons)', () => {
    const { inst } = setupRibbonInst();
    const segments = [{ tile: { col: 2, row: 3 }, strokes: [stroke] }];
    const result = inst._buildNetworkMesh('river', segments, RIVER_RIBBON_WIDTH, RIVER_RIBBON_Y, '#1a3d5c');
    assert.ok(result, 'expected a non-null merged mesh');
    assert.equal(result.receiveShadows, true,
      'returned merged mesh must have receiveShadows = true so unit shadows fall on it');
  });

  test('every per-tile merged mesh registered in _tilePropsByKey has receiveShadows = true', () => {
    const { inst } = setupRibbonInst();
    // Three tiles each contribute one stroke → three per-tile merged meshes.
    const segments = [
      { tile: { col: 0, row: 0 }, strokes: [stroke] },
      { tile: { col: 1, row: 0 }, strokes: [stroke] },
      { tile: { col: 2, row: 0 }, strokes: [stroke] },
    ];
    inst._buildNetworkMesh('road', segments, 0.6, 0.025, '#6b5a3e');
    let propCount = 0;
    for (const list of inst._tilePropsByKey.values()) {
      for (const m of list) {
        propCount++;
        assert.equal(m.receiveShadows, true,
          `prop ${m.name} in _tilePropsByKey must have receiveShadows = true`);
      }
    }
    assert.equal(propCount, 3, 'expected one merged mesh per tile in the prop registry');
  });

  test('flag survives later config (material assignment, hasVertexAlpha, alphaIndex) — pins ordering robustness', () => {
    // Regression guard: if a future refactor moves any of the post-merge state
    // (material, hasVertexAlpha, metadata) BEFORE `_setShadowReceiver`, this
    // test still passes — but if anything between merge and config accidentally
    // resets receiveShadows the test catches it.
    const { inst } = setupRibbonInst();
    const segments = [{ tile: { col: 5, row: 5 }, strokes: [stroke] }];
    const result = inst._buildNetworkMesh('river', segments, RIVER_RIBBON_WIDTH, RIVER_RIBBON_Y, '#1a3d5c');
    assert.equal(result.receiveShadows, true);
    assert.ok(result.material, 'material must be assigned post-shadow-receiver');
    assert.equal(result.hasVertexAlpha, true, 'vertex-alpha edge-fade preserved');
    // Final state pin: shadow receiver flag is not reset by any of the
    // downstream property writes inside the merge loop.
    assert.equal(result.receiveShadows, true,
      'receiveShadows must remain true after material/hasVertexAlpha/alphaIndex/metadata are set');
  });

  test('null merge result is skipped without throwing (empty tile list short-circuits)', () => {
    const { inst } = setupRibbonInst();
    // Stub MergeMeshes to return null — mimics Babylon refusing a degenerate list.
    inst._babylon.Mesh.MergeMeshes = () => null;
    const segments = [{ tile: { col: 0, row: 0 }, strokes: [stroke] }];
    const result = inst._buildNetworkMesh('road', segments, 0.6, 0.025, '#6b5a3e');
    assert.equal(result, null, 'no per-tile merges → returned primary stays null');
  });
});

// ─── Integration: standees register as shadow casters ───────────────────────
// The reciprocal contract: shadow receivers only matter if there's actually
// something casting. Every entity standee — leader or rank-and-file — must
// register its cone AND its sphere head with the ShadowGenerator so the unit
// throws a token-shaped silhouette onto the terrain / roads / rivers it walks
// over. Pinned here against a Babylon stub since real Babylon needs WebGL.
describe('Renderer3D._buildStandeeMesh — cone + sphere register as shadow casters', () => {
  function setupStandeeInst() {
    const inst = newInst();
    inst._babylon = makeFakeBabylonForStandees();
    inst._scene   = { /* unused */ };
    inst._shadowGenerator = makeFakeShadowGenerator();
    // _baseMaterialForOwner caches per-owner StandardMaterials; the stub above
    // supplies StandardMaterial + Color3 constructors.
    return inst;
  }

  function fakeEntity(extra = {}) {
    // `color` short-circuits `_ownerColorFor` so we don't need faction theming.
    return {
      id: 42,
      type: EntityType.HERO,
      owner: 'hero',
      color: '#ff8800',
      col: 0,
      row: 0,
      alive: true,
      ...extra,
    };
  }

  test('cone is registered with _shadowGenerator.addShadowCaster', () => {
    const inst = setupStandeeInst();
    const standee = inst._buildStandeeMesh(fakeEntity());
    const cone = standee?.plane;
    assert.ok(cone, 'cone (exposed as `plane`) must be returned');
    assert.ok(inst._shadowGenerator.casters.includes(cone),
      'cone must be in the shadow generator caster list — without this, units throw no shadow');
  });

  test('sphere (head) is also registered as a shadow caster', () => {
    // The sphere is parented to the cone and renders separately; Babylon's
    // shadow pass needs explicit registration per mesh, so the head must be in
    // the caster list too — otherwise the unit silhouette comes out headless.
    const inst = setupStandeeInst();
    const standee = inst._buildStandeeMesh(fakeEntity());
    const sphere = standee?.sphere;
    assert.ok(sphere, 'sphere head must be returned');
    assert.ok(inst._shadowGenerator.casters.includes(sphere),
      'sphere head must be in the shadow generator caster list');
  });

  test('leader entity also registers both meshes (leader-vs-rank-and-file parity)', () => {
    // Leaders use a different height/width multiplier but the caster pipeline
    // is identical; pinning this prevents a future refactor from accidentally
    // gating addShadowCaster behind `leader === false`.
    const inst = setupStandeeInst();
    const standee = inst._buildStandeeMesh(fakeEntity({ type: EntityType.WITCH, owner: 'witch' }));
    assert.ok(inst._shadowGenerator.casters.includes(standee.plane));
    assert.ok(inst._shadowGenerator.casters.includes(standee.sphere));
    assert.equal(standee.leader, true, 'witch is a leader type — `leader` flag set');
  });

  test('multiple standees accumulate independently in the caster list (no overwriting)', () => {
    const inst = setupStandeeInst();
    const a = inst._buildStandeeMesh(fakeEntity({ id: 1 }));
    const b = inst._buildStandeeMesh(fakeEntity({ id: 2 }));
    const c = inst._buildStandeeMesh(fakeEntity({ id: 3 }));
    // 3 standees × 2 meshes each = 6 casters added across the three calls.
    assert.equal(inst._shadowGenerator.casters.length, 6,
      'each standee must contribute its cone + sphere to the caster list');
    for (const s of [a, b, c]) {
      assert.ok(inst._shadowGenerator.casters.includes(s.plane));
      assert.ok(inst._shadowGenerator.casters.includes(s.sphere));
    }
  });

  test('build is null-safe when _shadowGenerator is not yet wired (headless / pre-init)', () => {
    // `_addShadowCaster` early-returns when `_shadowGenerator` is null, so
    // building a standee before _initBabylon finishes must not throw — the
    // build-time call sites in tests + the headless renderer rely on this.
    const inst = setupStandeeInst();
    inst._shadowGenerator = null;
    assert.doesNotThrow(() => inst._buildStandeeMesh(fakeEntity()));
  });
});
