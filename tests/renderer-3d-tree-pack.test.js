// Tree-pack runtime forest generator tests — covers the pure helpers
// (treeGroupsForSeason, pickTreeFileForSlot), the stub-driven manifest
// load, and the retrofit + procedural-fallback paths used by FOREST tiles
// and the map-border forest band.
//
// Babylon can't run in node-test (no WebGL), so the load + instance paths
// are exercised against a stubbed `_babylon` namespace and a stubbed
// `globalThis.fetch`. Task: tree-pack Phase 2.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  treeGroupsForSeason,
  pickTreeFileForSlot,
  TREE_PACK_DIR,
  TREE_PACK_MANIFEST_FILE,
  TARGET_TREE_WORLD_HEIGHT,
  forestTreesForHex,
} from '../src/renderer-3d.js';

import { TileType } from '../src/tiles.js';

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

function makeFakeBabylon({ importImpl, mergeImpl } = {}) {
  const Vector3 = class {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  };
  Vector3.Zero = () => new Vector3(0, 0, 0);
  return {
    Vector3,
    Matrix: { Translation: (x, y, z) => ({ x, y, z }) },
    Mesh: { MergeMeshes: mergeImpl || (() => null) },
    SceneLoader: {
      ImportMeshAsync: importImpl || (async () => ({ meshes: [] })),
    },
  };
}

let _instanceCounter = 0;
function makeFakeTemplate(name, opts = {}) {
  const minY = opts.minY ?? 0;
  const maxY = opts.maxY ?? 1.6; // bbox height 1.6 → templateScale = 1/1.6 ≈ 0.625
  return {
    name,
    isPickable: true,
    metadata: null,
    isEnabled: true,
    renderingGroupId: 7,
    setEnabled(b) { this.isEnabled = b; },
    getTotalVertices: () => opts.vertices ?? 100,
    getTotalIndices: () => opts.indices ?? 90,
    getBoundingInfo() {
      return {
        boundingBox: {
          minimumWorld: { x: -0.5, y: minY, z: -0.5 },
          maximumWorld: { x: 0.5,  y: maxY, z: 0.5 },
        },
      };
    },
    bakeTransformIntoVertices() {},
    refreshBoundingInfo() {},
    createInstance(n) {
      _instanceCounter++;
      return {
        name: n,
        source: this,
        isPickable: true,
        metadata: null,
        parent: null,
        position: { x: 0, y: 0, z: 0 },
        scaling: null,
        rotation: null,
        renderingGroupId: 7,
        dispose() { this._disposed = true; },
        freezeWorldMatrix() { this._frozen = true; },
        isWorldMatrixFrozen: false,
      };
    },
  };
}

/** Wrap globalThis.fetch with a per-call stub returning a JSON manifest
 *  for the manifest URL. Returns a restore handle. */
function stubFetch(responses) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const r = responses[url] ?? responses.__default__;
    if (!r) return { ok: false, status: 404, async json() { return {}; } };
    return r;
  };
  return () => { globalThis.fetch = original; };
}

// ─── Pure helper: treeGroupsForSeason ───────────────────────────────────

describe('treeGroupsForSeason', () => {
  test('summer → tree-summer-complete', () => {
    assert.equal(treeGroupsForSeason('summer'), 'tree-summer-complete');
  });

  test('spring leans on summer (green canopy)', () => {
    assert.equal(treeGroupsForSeason('spring'), 'tree-summer-complete');
  });

  test('fall and autumn both → tree-autumn-complete', () => {
    assert.equal(treeGroupsForSeason('fall'), 'tree-autumn-complete');
    assert.equal(treeGroupsForSeason('autumn'), 'tree-autumn-complete');
  });

  test('winter → tree-winter-complete', () => {
    assert.equal(treeGroupsForSeason('winter'), 'tree-winter-complete');
  });

  test('dead → tree-dead-complete', () => {
    assert.equal(treeGroupsForSeason('dead'), 'tree-dead-complete');
  });

  test('unknown / null season falls back to summer', () => {
    assert.equal(treeGroupsForSeason(null), 'tree-summer-complete');
    assert.equal(treeGroupsForSeason('made-up'), 'tree-summer-complete');
  });
});

// ─── Pure helper: pickTreeFileForSlot ───────────────────────────────────

describe('pickTreeFileForSlot', () => {
  const files = ['a.glb', 'b.glb', 'c.glb', 'd.glb'];

  test('returns null on empty / missing list', () => {
    assert.equal(pickTreeFileForSlot(null, 0, 0, 0), null);
    assert.equal(pickTreeFileForSlot([], 0, 0, 0), null);
  });

  test('deterministic per (col, row, treeIdx)', () => {
    for (const [c, r, i] of [[0, 0, 0], [3, 5, 2], [-4, 7, 4]]) {
      assert.equal(
        pickTreeFileForSlot(files, c, r, i),
        pickTreeFileForSlot(files, c, r, i),
      );
    }
  });

  test('different slots on the same hex generally pick different files', () => {
    const picks = new Set();
    for (let i = 0; i < 5; i++) picks.add(pickTreeFileForSlot(files, 0, 0, i));
    // With 4 files and 5 slots, we expect >=2 distinct picks; this guards
    // against a degenerate hash that always returns files[0].
    assert.ok(picks.size >= 2, `expected ≥2 distinct picks, got ${picks.size}`);
  });

  test('every pick is a member of the input list', () => {
    for (let c = -3; c <= 3; c++) {
      for (let r = -3; r <= 3; r++) {
        for (let i = 0; i < 5; i++) {
          const pick = pickTreeFileForSlot(files, c, r, i);
          assert.ok(files.includes(pick), `pick ${pick} not in input list`);
        }
      }
    }
  });
});

// ─── Constants ──────────────────────────────────────────────────────────

describe('exported constants', () => {
  test('TREE_PACK_DIR points at the trees subdirectory', () => {
    assert.equal(TREE_PACK_DIR, 'models/trees/');
  });
  test('TREE_PACK_MANIFEST_FILE is manifest.json', () => {
    assert.equal(TREE_PACK_MANIFEST_FILE, 'manifest.json');
  });
  test('TARGET_TREE_WORLD_HEIGHT is a positive number near the procedural tree height', () => {
    assert.ok(TARGET_TREE_WORLD_HEIGHT > 0 && TARGET_TREE_WORLD_HEIGHT < 3);
  });
});

// ─── _loadTreePackManifest — fetch + import + fallback ──────────────────

describe('_loadTreePackManifest', () => {
  test('returns null when scene is not ready', async () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._scene   = null;
    assert.equal(await r._loadTreePackManifest('assets'), null);
  });

  test('returns null when global fetch is unavailable', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon();
    const originalFetch = globalThis.fetch;
    const originalWarn  = console.warn;
    globalThis.fetch = undefined;
    console.warn = () => {};
    try {
      assert.equal(await r._loadTreePackManifest('assets'), null);
      assert.equal(r._useRealTrees, false);
    } finally {
      globalThis.fetch = originalFetch;
      console.warn = originalWarn;
    }
  });

  test('returns null when the manifest fetch responds with 404', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon();
    const originalWarn = console.warn;
    console.warn = () => {};
    const restore = stubFetch({ __default__: { ok: false, status: 404 } });
    try {
      assert.equal(await r._loadTreePackManifest('assets'), null);
      assert.equal(r._useRealTrees, false);
    } finally {
      restore();
      console.warn = originalWarn;
    }
  });

  test('returns null when the manifest has no `groups` field', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon();
    const originalWarn = console.warn;
    console.warn = () => {};
    const restore = stubFetch({
      __default__: { ok: true, async json() { return { version: 1 }; } },
    });
    try {
      assert.equal(await r._loadTreePackManifest('assets'), null);
    } finally {
      restore();
      console.warn = originalWarn;
    }
  });

  test('loads templates and flips _useRealTrees true on a valid manifest', async () => {
    const r = newInst();
    r._scene = {};
    const imported = makeFakeTemplate('tree_a');
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [imported] }),
    });
    const restore = stubFetch({
      __default__: {
        ok: true,
        async json() {
          return {
            version: 1,
            groups: {
              'tree-summer-complete': [{ file: 'tree-summer-complete/a.glb' }],
              'tree-summer-trunk':    [{ file: 'tree-summer-trunk/x.glb' }],
            },
          };
        },
      },
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await r._loadTreePackManifest('assets');
      assert.equal(r._useRealTrees, true);
      assert.equal(r._treeTemplates.size, 1, 'one unique complete-tree file loads');
      assert.ok(r._treeGroupsByName.has('tree-summer-complete'));
      // Trunk-only groups are intentionally skipped — only *-complete groups
      // are loaded in this PR.
      assert.equal(r._treeGroupsByName.has('tree-summer-trunk'), false);
      assert.equal(imported.isEnabled, false, 'template must be hidden');
      assert.equal(imported.isPickable, false);
      assert.equal(imported.renderingGroupId, 0);
    } finally {
      restore();
      console.log = originalLog;
    }
  });

  test('computes per-template scale so the bbox-height matches TARGET_TREE_WORLD_HEIGHT', async () => {
    const r = newInst();
    r._scene = {};
    // bbox 0..2 → height 2 → templateScale = TARGET/2.
    const imported = makeFakeTemplate('tall_tree', { minY: 0, maxY: 2 });
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [imported] }),
    });
    const restore = stubFetch({
      __default__: {
        ok: true,
        async json() {
          return {
            version: 1,
            groups: {
              'tree-summer-complete': [{ file: 'tree-summer-complete/a.glb' }],
            },
          };
        },
      },
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await r._loadTreePackManifest('assets');
      const tmpl = r._treeTemplates.get('tree-summer-complete/a.glb');
      assert.ok(tmpl, 'template registered under its manifest filename');
      assert.ok(Math.abs(tmpl.metadata.templateScale - TARGET_TREE_WORLD_HEIGHT / 2) < 1e-9);
    } finally {
      restore();
      console.log = originalLog;
    }
  });

  test('de-dupes concurrent load attempts via _treePackLoadPromise', async () => {
    const r = newInst();
    r._scene = {};
    let importCalls = 0;
    r._babylon = makeFakeBabylon({
      importImpl: async () => {
        importCalls++;
        return { meshes: [makeFakeTemplate(`t${importCalls}`)] };
      },
    });
    const restore = stubFetch({
      __default__: {
        ok: true,
        async json() {
          return {
            version: 1,
            groups: {
              'tree-summer-complete': [{ file: 'tree-summer-complete/a.glb' }],
            },
          };
        },
      },
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      const a = r._loadTreePackManifest('assets');
      const b = r._loadTreePackManifest('assets');
      const [ra, rb] = await Promise.all([a, b]);
      assert.equal(importCalls, 1, 'concurrent loads share one import pass');
      assert.equal(ra, rb);
    } finally {
      restore();
      console.log = originalLog;
    }
  });

  test('manifest v2: filters out non-new-england tree entries', async () => {
    const r = newInst();
    r._scene = {};
    const loaded = [];
    r._babylon = makeFakeBabylon({
      importImpl: async (_n, _base, file) => {
        loaded.push(file);
        return { meshes: [makeFakeTemplate(file)] };
      },
    });
    const restore = stubFetch({
      __default__: {
        ok: true,
        async json() {
          return {
            version: 2,
            groups: {
              'tree-summer-complete': [
                { file: 'ne.glb',     species: 'oak',  region: 'new-england' },
                { file: 'palm.glb',   species: 'palm', region: 'tropical' },
                { file: 'spruce.glb', species: 'spruce', region: 'new-england' },
              ],
            },
          };
        },
      },
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await r._loadTreePackManifest('assets');
      // palm.glb should never have been imported — region filter drops it
      // before the parallel-import step.
      assert.ok(!loaded.includes('palm.glb'), 'tropical entry must be skipped');
      assert.equal(r._treeTemplates.size, 2);
      assert.ok(r._treeTemplates.has('ne.glb'));
      assert.ok(r._treeTemplates.has('spruce.glb'));
      assert.equal(r._treeTemplates.has('palm.glb'), false);
      assert.deepEqual(
        r._treeGroupsByName.get('tree-summer-complete').sort(),
        ['ne.glb', 'spruce.glb'],
      );
    } finally {
      restore();
      console.log = originalLog;
    }
  });

  test('manifest v1 back-compat: entries with no region field are kept', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon({
      importImpl: async (_n, _base, file) => ({ meshes: [makeFakeTemplate(file)] }),
    });
    const restore = stubFetch({
      __default__: {
        ok: true,
        async json() {
          return {
            version: 1,
            groups: {
              'tree-summer-complete': [{ file: 'legacy.glb' }],
            },
          };
        },
      },
    });
    const originalLog = console.log;
    console.log = () => {};
    try {
      await r._loadTreePackManifest('assets');
      assert.equal(r._treeTemplates.size, 1);
      assert.ok(r._treeTemplates.has('legacy.glb'));
    } finally {
      restore();
      console.log = originalLog;
    }
  });

  test('isolates per-file import failures — surviving files still register', async () => {
    const r = newInst();
    r._scene = {};
    let calls = 0;
    r._babylon = makeFakeBabylon({
      importImpl: async (_n, _base, file) => {
        calls++;
        if (file === 'broken.glb') throw new Error('parse error');
        return { meshes: [makeFakeTemplate(file)] };
      },
    });
    const restore = stubFetch({
      __default__: {
        ok: true,
        async json() {
          return {
            version: 1,
            groups: {
              'tree-summer-complete': [
                { file: 'broken.glb' },
                { file: 'good.glb' },
              ],
            },
          };
        },
      },
    });
    const originalLog = console.log;
    const originalWarn = console.warn;
    console.log = () => {};
    console.warn = () => {};
    try {
      await r._loadTreePackManifest('assets');
      assert.equal(calls, 2);
      assert.equal(r._treeTemplates.size, 1);
      assert.ok(r._treeTemplates.has('good.glb'));
      const list = r._treeGroupsByName.get('tree-summer-complete');
      assert.deepEqual(list, ['good.glb']);
    } finally {
      restore();
      console.log = originalLog;
      console.warn = originalWarn;
    }
  });
});

// ─── _buildRealTreeInstance / _buildRealForestTreesForHex ───────────────

describe('_buildRealTreeInstance — positioning + scaling + metadata', () => {
  function readyInstanceRenderer() {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._useRealTrees = true;
    r._season = 'summer';
    const tmpl = makeFakeTemplate('tmpl');
    tmpl.metadata = { templateScale: 0.5 };
    r._treeTemplates.set('tree-summer-complete/a.glb', tmpl);
    r._treeGroupsByName.set('tree-summer-complete', ['tree-summer-complete/a.glb']);
    return { r, tmpl };
  }

  test('returns null when _useRealTrees is false', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._useRealTrees = false;
    const inst = r._buildRealTreeInstance(
      null, 0, 0, { x: 0, z: 0, scale: 1 }, 0, 'forest_0_0',
    );
    assert.equal(inst, null);
  });

  test('returns null when no templates exist for the season group', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._useRealTrees = true;
    r._season = 'winter'; // no winter templates registered
    const inst = r._buildRealTreeInstance(
      null, 0, 0, { x: 0, z: 0, scale: 1 }, 0, 'forest_0_0',
    );
    assert.equal(inst, null);
  });

  test('createInstance is called with a per-slot unique name', () => {
    const { r } = readyInstanceRenderer();
    const a = r._buildRealTreeInstance(
      null, 1, 2, { x: 0.1, z: -0.2, scale: 1 }, 0, 'forest_1_2',
      { cx: 0, cz: 0 },
    );
    const b = r._buildRealTreeInstance(
      null, 1, 2, { x: 0.3, z: 0.1, scale: 1 }, 1, 'forest_1_2',
      { cx: 0, cz: 0 },
    );
    assert.equal(a.name, 'forest_1_2_t0_real');
    assert.equal(b.name, 'forest_1_2_t1_real');
  });

  test('positions at (cx + tree.x, 0, cz + tree.z)', () => {
    const { r } = readyInstanceRenderer();
    const inst = r._buildRealTreeInstance(
      null, 0, 0, { x: 0.4, z: -0.3, scale: 1 }, 0, 'pfx',
      { cx: 10, cz: 20 },
    );
    assert.ok(Math.abs(inst.position.x - 10.4) < 1e-9);
    assert.ok(Math.abs(inst.position.z - 19.7) < 1e-9);
    // Y is 0 — the source's bbox bottom was baked to local Y=0 at load.
    assert.equal(inst.position.y, 0);
  });

  test('scale is templateScale × tree.scale on every axis', () => {
    const { r } = readyInstanceRenderer();
    const inst = r._buildRealTreeInstance(
      null, 0, 0, { x: 0, z: 0, scale: 0.8 }, 0, 'pfx', { cx: 0, cz: 0 },
    );
    // templateScale = 0.5, tree.scale = 0.8 → 0.4 on every axis.
    assert.ok(Math.abs(inst.scaling.x - 0.4) < 1e-9);
    assert.ok(Math.abs(inst.scaling.y - 0.4) < 1e-9);
    assert.ok(Math.abs(inst.scaling.z - 0.4) < 1e-9);
  });

  test('rotation Y is hash-seeded — deterministic per (col, row, treeIdx)', () => {
    const { r } = readyInstanceRenderer();
    const a = r._buildRealTreeInstance(
      null, 4, 9, { x: 0, z: 0, scale: 1 }, 2, 'pfx', { cx: 0, cz: 0 },
    );
    const b = r._buildRealTreeInstance(
      null, 4, 9, { x: 0, z: 0, scale: 1 }, 2, 'pfx', { cx: 0, cz: 0 },
    );
    assert.equal(a.rotation.y, b.rotation.y);
    assert.ok(a.rotation.y >= 0 && a.rotation.y < Math.PI * 2 + 1e-9);
  });

  test('instance is unpickable, fog-immune, world-geometry group', () => {
    const { r } = readyInstanceRenderer();
    const inst = r._buildRealTreeInstance(
      null, 0, 0, { x: 0, z: 0, scale: 1 }, 0, 'pfx', { cx: 0, cz: 0 },
    );
    assert.equal(inst.isPickable, false);
    assert.equal(inst.metadata.respectsFog, false);
    assert.equal(inst.metadata.kind, 'tree-glb');
    assert.equal(inst.renderingGroupId, 0);
  });

  test('shadow caster registration goes through _addShadowCaster', () => {
    const { r } = readyInstanceRenderer();
    const casters = [];
    r._shadowGenerator = { addShadowCaster: (m) => casters.push(m) };
    const inst = r._buildRealTreeInstance(
      null, 0, 0, { x: 0, z: 0, scale: 1 }, 0, 'pfx', { cx: 0, cz: 0 },
    );
    assert.deepEqual(casters, [inst]);
  });
});

describe('_buildRealForestTreesForHex — multi-tree assembly', () => {
  test('builds one instance per tree slot and returns them all', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._useRealTrees = true;
    r._season = 'summer';
    const tmpl = makeFakeTemplate('tmpl');
    tmpl.metadata = { templateScale: 1 };
    r._treeTemplates.set('a.glb', tmpl);
    r._treeGroupsByName.set('tree-summer-complete', ['a.glb']);
    const trees = forestTreesForHex(2, 3, 'summer');
    const insts = r._buildRealForestTreesForHex(
      null, 2, 3, 1, 2, trees, 'forest_2_3', { season: 'summer' },
    );
    assert.equal(insts.length, trees.length, 'one instance per tree slot');
  });

  test('returns empty array when no template is available', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._useRealTrees = false;
    const trees = forestTreesForHex(0, 0, 'summer');
    const insts = r._buildRealForestTreesForHex(
      null, 0, 0, 0, 0, trees, 'pfx',
    );
    assert.deepEqual(insts, []);
  });

  test('safe with empty trees array', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._useRealTrees = true;
    assert.deepEqual(
      r._buildRealForestTreesForHex(null, 0, 0, 0, 0, [], 'pfx'),
      [],
    );
  });
});

// ─── _upgradeForestToRealTrees — retrofit pass ──────────────────────────

describe('_upgradeForestToRealTrees — retrofit after async load', () => {
  function setupForRetrofit() {
    const r = newInst();
    r._babylon  = makeFakeBabylon();
    r._mapBuilt = true;
    r._mapRoot  = { name: 'mapRoot' };
    r._season   = 'summer';
    r._useRealTrees = true;
    const tmpl = makeFakeTemplate('tmpl');
    tmpl.metadata = { templateScale: 1 };
    r._treeTemplates.set('a.glb', tmpl);
    r._treeGroupsByName.set('tree-summer-complete', ['a.glb']);
    return r;
  }

  test('no-op when the map is not yet built', () => {
    const r = setupForRetrofit();
    r._mapBuilt = false;
    assert.equal(r._upgradeForestToRealTrees(), 0);
  });

  test('no-op when _useRealTrees is false', () => {
    const r = setupForRetrofit();
    r._useRealTrees = false;
    r.state = { tiles: new Map() };
    assert.equal(r._upgradeForestToRealTrees(), 0);
  });

  test('replaces procedural FOREST cluster meshes with real-tree instances', () => {
    const r = setupForRetrofit();
    const tiles = new Map();
    tiles.set('2,3', { col: 2, row: 3, type: TileType.FOREST });
    r.state = { tiles };
    // Pre-existing procedural meshes named with the forest cluster prefix.
    const trunks = {
      name: 'forest_2_3_trunks', dispose() { this._disposed = true; },
    };
    const leaves = {
      name: 'forest_2_3_leaves_0', dispose() { this._disposed = true; },
    };
    r._tilePropsByKey.set('2,3', [trunks, leaves]);

    const upgraded = r._upgradeForestToRealTrees();
    assert.ok(upgraded >= 1);
    assert.equal(trunks._disposed, true);
    assert.equal(leaves._disposed, true);
    const props = r._tilePropsByKey.get('2,3');
    assert.ok(props.some(m => m?.metadata?.kind === 'tree-glb'),
      'at least one real-tree instance present after retrofit');
  });

  test('idempotent — second pass finds no work', () => {
    const r = setupForRetrofit();
    const tiles = new Map();
    tiles.set('0,0', { col: 0, row: 0, type: TileType.FOREST });
    r.state = { tiles };
    r._tilePropsByKey.set('0,0', [{
      name: 'forest_0_0_trunks', dispose() {},
    }]);
    const first = r._upgradeForestToRealTrees();
    const second = r._upgradeForestToRealTrees();
    assert.ok(first >= 1);
    assert.equal(second, 0);
  });

  test('does not touch non-FOREST tile props', () => {
    const r = setupForRetrofit();
    const tiles = new Map();
    tiles.set('1,1', { col: 1, row: 1, type: TileType.BUILDING });
    r.state = { tiles };
    const bldg = { name: 'bldg_1_1', dispose() { this._disposed = true; } };
    r._tilePropsByKey.set('1,1', [bldg]);
    r._upgradeForestToRealTrees();
    assert.notEqual(bldg._disposed, true);
  });

  test('preserves batched border-forest meshes when no real trees are available', () => {
    // Defensive two-phase swap: only dispose the procedural batch when at
    // least one real instance was produced. Without this guard a season
    // with no template bucket would wipe the cones and leave the border
    // empty.
    const r = setupForRetrofit();
    r.state = { tiles: new Map() };
    const oldMesh = { name: 'border_forest_trunks', dispose() { this._disposed = true; } };
    r._borderForestBatchMeshes = [oldMesh];
    r._upgradeForestToRealTrees();
    // No border tiles registered → no real instances built → old batch stays.
    assert.notEqual(oldMesh._disposed, true);
    assert.deepEqual(r._borderForestBatchMeshes, [oldMesh]);
  });
});
