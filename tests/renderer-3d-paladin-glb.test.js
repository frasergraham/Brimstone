// Paladin GLB model tests — covers the hero-side standee swap that replaces
// the cone+sphere body with a clone of `assets/models/paladin.glb`, plus the
// pure faction predicate + load/retrofit/dispose machinery.
//
// Babylon can't run in node-test (no WebGL), so the load + clone paths are
// exercised against a stubbed `_babylon` namespace that records what the
// renderer asks for. The actual skinning / animation playback (which need a
// real WebGL scene) is out of scope here.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  isHeroFactionEntity,
  PALADIN_MODEL_DIR,
  PALADIN_MODEL_FILE,
  PALADIN_BASE_SCALE,
  PALADIN_YAW,
  TARGET_PALADIN_WORLD_HEIGHT,
  STANDEE_CONE_HEIGHT,
  STANDEE_LEADER_HEIGHT_MUL,
  STANDEE_BASE_Y_OFFSET,
  STANDEE_BASE_THICKNESS,
  TERRAIN_DISC_Y_OFFSET,
} from '../src/renderer-3d.js';

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

function fakeVector3Ctor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }

/** Build a minimal BABYLON stub exposing only what the paladin pipeline
 *  touches. `SceneLoader.ImportMeshAsync` is overridable per-case.
 *  `TransformNode` is provided so the clone path can build a per-standee
 *  root that parents the geometry submeshes — without it the renderer
 *  falls back to the legacy single-mesh path. Set `includeTransformNode`
 *  false to exercise that fallback. */
function makeFakeBabylon({ importImpl, includeTransformNode = true } = {}) {
  function FakeTransformNode(name, scene) {
    this.name = name;
    this.scene = scene;
    this.parent = null;
    this.position = { x: 0, y: 0, z: 0 };
    this.scaling  = null;
    this.rotation = null;
    this._isTransformNode = true;
    this._disposed = false;
  }
  FakeTransformNode.prototype.dispose = function dispose() { this._disposed = true; };

  const out = {
    Vector3: fakeVector3Ctor,
    Matrix: {
      Translation: (x, y, z) => ({ _kind: 'translation', x, y, z }),
    },
    SceneLoader: {
      ImportMeshAsync: importImpl || (async () => ({ meshes: [] })),
    },
  };
  if (includeTransformNode) out.TransformNode = FakeTransformNode;
  return out;
}

/** Source mesh stub — `clone()` returns a fresh stub that the renderer
 *  can position, scale, and parent. */
function makeFakeSourceMesh(name = 'paladin_src', {
  vertices = 200,
  // Default bbox roughly matches a Mixamo metres-units export (~1.8 m tall,
  // hip-pivot so feet are below origin). Tests that care about the
  // cm-export case override with min:{y:0}, max:{y:180}.
  bboxMin = { x: -0.4, y: -0.9, z: -0.2 },
  bboxMax = { x:  0.4, y:  0.9, z:  0.2 },
} = {}) {
  const cloneCalls = [];
  const bakeCalls = [];
  return {
    name,
    isPickable: true,
    isEnabled: true,
    skeleton: null,  // populated by tests that want a skeleton
    position: { x: 0, y: 0, z: 0 },
    scaling:  null,
    rotation: null,
    parent: null,
    renderingGroupId: 7,
    _bbox: {
      boundingBox: {
        minimum: { ...bboxMin },
        maximum: { ...bboxMax },
        minimumWorld: { ...bboxMin },
        maximumWorld: { ...bboxMax },
      },
    },
    getTotalVertices: () => vertices,
    setEnabled(b) { this.isEnabled = b; },
    getBoundingInfo() { return this._bbox; },
    bakeTransformIntoVertices(matrix) {
      bakeCalls.push(matrix);
      // Apply the translation to the bbox so a follow-up refreshBoundingInfo
      // reflects the baked-in offset.
      if (matrix && matrix._kind === 'translation') {
        this._bbox.boundingBox.minimum.y += matrix.y;
        this._bbox.boundingBox.maximum.y += matrix.y;
      }
    },
    refreshBoundingInfo() { this._refreshed = (this._refreshed ?? 0) + 1; },
    _bakeCalls: bakeCalls,
    clone(cloneName) {
      const inst = makeFakeClonedMesh(cloneName, this);
      cloneCalls.push(inst);
      return inst;
    },
    _cloneCalls: cloneCalls,
    dispose() { this._disposed = true; },
  };
}

function makeFakeClonedMesh(name, source) {
  return {
    name,
    source,
    isPickable: true,
    isEnabled: true,
    skeleton: null,
    position: { x: 0, y: 0, z: 0 },
    scaling: null,
    rotation: null,
    parent: null,
    renderingGroupId: 7,
    setEnabled(b) { this.isEnabled = b; },
    dispose() { this._disposed = true; },
  };
}

function makeFakeSkeleton(name = 'paladin_skel') {
  return {
    name,
    bones: [{ name: 'mixamorig:Hips' }, { name: 'mixamorig:Spine' }],
    clone(newName) {
      const c = makeFakeSkeleton(newName);
      c._clonedFrom = name;
      return c;
    },
    dispose() { this._disposed = true; },
  };
}

function makeFakeAnimGroup(name = 'mixamo.com') {
  return {
    name,
    _started: false,
    _stopped: false,
    start(loop, speed) { this._started = { loop, speed }; },
    stop()             { this._stopped = true; },
    clone(newName, converter) {
      const c = makeFakeAnimGroup(newName);
      c._converter = converter;
      c._clonedFrom = name;
      return c;
    },
    dispose() { this._disposed = true; },
  };
}

// ─── Pure predicate ─────────────────────────────────────────────────────────

describe('isHeroFactionEntity', () => {
  test('hero owner is a hero', () => {
    assert.equal(isHeroFactionEntity({ owner: 'hero' }), true);
  });
  test('witch owner is not a hero', () => {
    assert.equal(isHeroFactionEntity({ owner: 'witch' }), false);
  });
  test('neutral entity is not a hero', () => {
    assert.equal(isHeroFactionEntity({ owner: null }), false);
  });
  test('null entity returns false (no throw)', () => {
    assert.equal(isHeroFactionEntity(null), false);
    assert.equal(isHeroFactionEntity(undefined), false);
  });
});

// ─── Exported constants ─────────────────────────────────────────────────────

describe('paladin constants', () => {
  test('PALADIN_MODEL_DIR is the models subdirectory', () => {
    assert.equal(PALADIN_MODEL_DIR, 'models/');
  });
  test('PALADIN_MODEL_FILE is a .glb under assets/models/', () => {
    assert.match(PALADIN_MODEL_FILE, /\.glb$/,
      `expected a .glb filename, got ${PALADIN_MODEL_FILE}`);
  });
  test('PALADIN_BASE_SCALE is a positive sub-unit float', () => {
    assert.ok(PALADIN_BASE_SCALE > 0 && PALADIN_BASE_SCALE < 2);
  });
  test('PALADIN_YAW is in [0, 2π)', () => {
    assert.ok(PALADIN_YAW >= 0 && PALADIN_YAW < Math.PI * 2 + 1e-9);
  });
  test('TARGET_PALADIN_WORLD_HEIGHT fits within one hex (radius 1) and is taller than the cone+sphere it replaces', () => {
    assert.ok(TARGET_PALADIN_WORLD_HEIGHT > STANDEE_CONE_HEIGHT,
      'paladin should read bigger than the cone body');
    assert.ok(TARGET_PALADIN_WORLD_HEIGHT < 2,
      'paladin must not overflow the hex footprint by miles');
  });
});

// ─── Loader (`_loadPaladinModel`) ───────────────────────────────────────────

describe('_loadPaladinModel — async load + caching + fallback', () => {
  test('returns null when the scene is not ready yet', async () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._scene = null;
    assert.equal(await r._loadPaladinModel('assets'), null);
  });

  test('returns null when babylon is not loaded', async () => {
    const r = newInst();
    r._babylon = null;
    r._scene = {};
    assert.equal(await r._loadPaladinModel('assets'), null);
  });

  test('caches { mesh, skeleton, idleGroup } on _paladinSource', async () => {
    const r = newInst();
    r._scene = { _id: 'scene' };
    const mesh = makeFakeSourceMesh();
    const skel = makeFakeSkeleton();
    const grp  = makeFakeAnimGroup();
    mesh.skeleton = skel;
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({
        meshes: [mesh],
        skeletons: [skel],
        animationGroups: [grp],
      }),
    });
    const result = await r._loadPaladinModel('assets');
    assert.equal(result.mesh, mesh);
    assert.equal(result.skeleton, skel);
    assert.equal(result.idleGroup, grp);
    assert.equal(r._paladinSource, result);
  });

  test('source mesh is hidden (setEnabled(false)) so it never renders directly', async () => {
    const r = newInst();
    r._scene = {};
    const mesh = makeFakeSourceMesh();
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [mesh] }),
    });
    await r._loadPaladinModel('assets');
    assert.equal(mesh.isEnabled, false);
    assert.equal(mesh.isPickable, false);
  });

  test('idle animation group is started on the source skeleton', async () => {
    const r = newInst();
    r._scene = {};
    // Distinct group instances for paladin vs walking imports so the test
    // can pin the paladin/idle group's start state without the walking load
    // (which fires async from _loadPaladinModel) overwriting it.
    const idleGrp = makeFakeAnimGroup('Idle');
    const walkGrp = makeFakeAnimGroup('Walking');
    r._babylon = makeFakeBabylon({
      importImpl: async (_meshNames, _baseUrl, fileName) => {
        const grp = fileName && fileName.includes('walking') ? walkGrp : idleGrp;
        return { meshes: [makeFakeSourceMesh()], animationGroups: [grp] };
      },
    });
    await r._loadPaladinModel('assets');
    // Idle starts at speed 1.0 in _loadPaladinModel.
    assert.equal(idleGrp._started?.loop, true,
      'source idleGroup must be started looping (drives the rig)');
    assert.equal(idleGrp._stopped, false,
      'source idleGroup must NOT be stopped — clones share its bone matrices');
  });

  test('prefers the mesh with a skeleton over the first mesh', async () => {
    const r = newInst();
    r._scene = {};
    const bare    = makeFakeSourceMesh('bare');
    const skinned = makeFakeSourceMesh('skinned');
    const skel    = makeFakeSkeleton();
    skinned.skeleton = skel;
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [bare, skinned] }),
    });
    const result = await r._loadPaladinModel('assets');
    assert.equal(result.mesh, skinned);
    assert.equal(result.skeleton, skel);
  });

  test('filters out empty meshes (e.g. the glTF __root__ TransformNode)', async () => {
    const r = newInst();
    r._scene = {};
    const empty = makeFakeSourceMesh('__root__', { vertices: 0 });
    const real  = makeFakeSourceMesh('mesh',     { vertices: 100 });
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [empty, real] }),
    });
    const result = await r._loadPaladinModel('assets');
    assert.equal(result.mesh, real);
  });

  test('returns null when ImportMeshAsync rejects (404 / parse error)', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon({
      importImpl: async () => { throw new Error('404'); },
    });
    const original = console.warn;
    console.warn = () => {};
    try {
      const result = await r._loadPaladinModel('assets');
      assert.equal(result, null);
      assert.equal(r._paladinSource, null);
    } finally {
      console.warn = original;
    }
  });

  test('returns null when the GLB has no geometry', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [] }),
    });
    const original = console.warn;
    console.warn = () => {};
    try {
      const result = await r._loadPaladinModel('assets');
      assert.equal(result, null);
    } finally {
      console.warn = original;
    }
  });

  test('returns null when SceneLoader.ImportMeshAsync is unavailable', async () => {
    const r = newInst();
    r._scene = {};
    r._babylon = { Vector3: fakeVector3Ctor, SceneLoader: {} };
    const original = console.warn;
    console.warn = () => {};
    try {
      const result = await r._loadPaladinModel('assets');
      assert.equal(result, null);
    } finally {
      console.warn = original;
    }
  });

  test('de-dupes concurrent load attempts via _paladinLoadPromise', async () => {
    const r = newInst();
    r._scene = {};
    let paladinCalls = 0;
    r._babylon = makeFakeBabylon({
      importImpl: async (_meshNames, _baseUrl, fileName) => {
        if (fileName && fileName.includes('paladin')) paladinCalls++;
        return { meshes: [makeFakeSourceMesh()] };
      },
    });
    const [a, b] = await Promise.all([
      r._loadPaladinModel('assets'),
      r._loadPaladinModel('assets'),
    ]);
    assert.equal(paladinCalls, 1, 'second concurrent call must reuse the in-flight promise');
    assert.equal(a, b);
  });

  test('stores a bbox-derived _paladinScale + feet offset after load (replaces the fixed constant)', async () => {
    const r = newInst();
    r._scene = {};
    const mesh = makeFakeSourceMesh();  // default: 1.8 m tall, feet at y=-0.9
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [mesh] }),
    });
    await r._loadPaladinModel('assets');
    const expectedScale = TARGET_PALADIN_WORLD_HEIGHT / 1.8;
    assert.ok(Math.abs(r._paladinScale - expectedScale) < 1e-9,
      `expected scale ${expectedScale}, got ${r._paladinScale}`);
    // Feet offset = -minY, so the clone root can lift the model so feet
    // sit at the cone bottom rather than the Mixamo hip-pivot.
    assert.ok(Math.abs(r._paladinFeetOffset - 0.9) < 1e-9,
      `expected feet offset 0.9 (= -minY), got ${r._paladinFeetOffset}`);
  });

  // Bridge regression — the broken `await import(BABYLON_LOADERS_CDN)` pattern
  // from PR #369 was replaced with `_ensureBabylonLoaders` so the house and
  // paladin GLB consumers share one UMD-script-tag loader path. Pin the
  // ordering: helper resolves BEFORE ImportMeshAsync is called.
  test('awaits _ensureBabylonLoaders BEFORE calling ImportMeshAsync', async () => {
    const r = newInst();
    r._scene = {};
    const calls = [];
    let helperResolved = false;
    r._ensureBabylonLoaders = async () => {
      calls.push('ensure');
      await Promise.resolve();
      helperResolved = true;
      return true;
    };
    r._babylon = makeFakeBabylon({
      importImpl: async () => {
        calls.push('import');
        assert.equal(helperResolved, true, 'helper must resolve before import is called');
        return { meshes: [makeFakeSourceMesh()] };
      },
    });
    await r._loadPaladinModel('assets');
    // Walking companion load fires async too; collapse any post-paladin
    // 'ensure'/'import' calls — they're triggered by _loadWalkingAnimation.
    const paladinPhase = calls.slice(0, 2);
    assert.deepEqual(paladinPhase, ['ensure', 'import']);
  });
});

// ─── Bbox normalisation (`_normalisePaladinSource`) ─────────────────────────

describe('_normalisePaladinSource — aggregate-bbox scale + feet offset', () => {
  test('returns target/naturalHeight scale for an m-units source (~1.8 m tall)', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    // Default fake source: bbox.y ∈ [-0.9, 0.9] → naturalHeight = 1.8 m.
    const mesh = makeFakeSourceMesh();
    const { scale, feetOffset } = r._normalisePaladinSource(mesh);
    const expected = TARGET_PALADIN_WORLD_HEIGHT / 1.8;
    assert.ok(Math.abs(scale - expected) < 1e-9,
      `expected ${expected}, got ${scale}`);
    // Feet sit 0.9 below the mesh origin (Mixamo hip-pivot) — feetOffset
    // is the positive distance the clone root needs to lift to land feet
    // at root-local y=0.
    assert.ok(Math.abs(feetOffset - 0.9) < 1e-9);
  });

  test('returns target/naturalHeight scale for a cm-units source (~180 cm tall)', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    // Mixamo FBX with "Apply Unit Scale" disabled lands at ~180 cm tall —
    // this is the case that produced the "tiny helmet" symptom at the old
    // fixed PALADIN_BASE_SCALE=0.4.
    const mesh = makeFakeSourceMesh('cm_export', {
      bboxMin: { x: -45, y: 0,   z: -25 },
      bboxMax: { x:  45, y: 180, z:  25 },
    });
    const { scale } = r._normalisePaladinSource(mesh);
    const expected = TARGET_PALADIN_WORLD_HEIGHT / 180;
    assert.ok(Math.abs(scale - expected) < 1e-9,
      `cm-units export must scale tiny (${expected}), got ${scale}`);
    // The cm case is exactly why this fix exists — pin that the scale lands
    // well below the old fixed PALADIN_BASE_SCALE=0.4 so the body fits.
    assert.ok(scale < PALADIN_BASE_SCALE / 10,
      'cm-units scale must be far smaller than the old fixed scale');
  });

  test('aggregates min/max Y across a multi-submesh hierarchy (the giant-floating-head fix)', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    // Helmet alone is ~0.2 m tall sitting near the top. Body is 1.8 m
    // tall. PR #375 measured ONLY the helmet's bbox (scale = 0.8/0.2 = 4×)
    // — when applied to the helmet clone, the helmet filled the target
    // height; the body submesh was never cloned, so the visible model was
    // a giant floating head. The aggregated bbox here measures the WHOLE
    // hierarchy (-0.9 .. 0.9 = 1.8 m), giving the correct scale.
    const helmet = makeFakeSourceMesh('helmet', {
      bboxMin: { x: -0.2, y:  0.7, z: -0.2 },
      bboxMax: { x:  0.2, y:  0.9, z:  0.2 },
    });
    const body = makeFakeSourceMesh('body', {
      bboxMin: { x: -0.4, y: -0.9, z: -0.2 },
      bboxMax: { x:  0.4, y:  0.5, z:  0.2 },
    });
    const cape = makeFakeSourceMesh('cape', {
      bboxMin: { x: -0.3, y: -0.6, z: -0.1 },
      bboxMax: { x:  0.3, y:  0.4, z:  0.1 },
    });
    const { scale, feetOffset } = r._normalisePaladinSource([helmet, body, cape]);
    // Aggregate min.y = -0.9 (body), aggregate max.y = 0.9 (helmet)
    // → naturalHeight = 1.8 → scale = 0.8/1.8.
    const expectedScale = TARGET_PALADIN_WORLD_HEIGHT / 1.8;
    assert.ok(Math.abs(scale - expectedScale) < 1e-9,
      `expected aggregate scale ${expectedScale}, got ${scale}`);
    // Feet offset = -minY = 0.9 (taken from the body, not the helmet).
    // This is exactly the regression — measuring helmet alone gives
    // feet offset = -0.7 and a 4× scale that explodes the model.
    assert.ok(Math.abs(feetOffset - 0.9) < 1e-9,
      `feet offset must reflect the body's lowest point, got ${feetOffset}`);
  });

  test('falls back to PALADIN_BASE_SCALE when getBoundingInfo is unavailable', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    const mesh = { name: 'no_bbox', getTotalVertices: () => 100, setEnabled() {} };
    const { scale, feetOffset } = r._normalisePaladinSource(mesh);
    assert.equal(scale, PALADIN_BASE_SCALE);
    assert.equal(feetOffset, 0);
  });

  test('falls back when bbox is degenerate (zero height)', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    const mesh = makeFakeSourceMesh('flat', {
      bboxMin: { x: 0, y: 0, z: 0 },
      bboxMax: { x: 0, y: 0, z: 0 },
    });
    const { scale } = r._normalisePaladinSource(mesh);
    assert.equal(scale, PALADIN_BASE_SCALE);
  });

  test('skips meshes whose getBoundingInfo throws and aggregates the rest', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    const bad = makeFakeSourceMesh('bad');
    bad.getBoundingInfo = () => { throw new Error('bbox failed'); };
    const good = makeFakeSourceMesh('good');
    const { scale, feetOffset } = r._normalisePaladinSource([bad, good]);
    const expected = TARGET_PALADIN_WORLD_HEIGHT / 1.8;
    assert.ok(Math.abs(scale - expected) < 1e-9);
    assert.ok(Math.abs(feetOffset - 0.9) < 1e-9);
  });

  test('null source returns fallback scale + zero feet offset', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    const { scale, feetOffset } = r._normalisePaladinSource(null);
    assert.equal(scale, PALADIN_BASE_SCALE);
    assert.equal(feetOffset, 0);
  });

  test('empty meshes array returns fallback', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    const { scale, feetOffset } = r._normalisePaladinSource([]);
    assert.equal(scale, PALADIN_BASE_SCALE);
    assert.equal(feetOffset, 0);
  });
});

// ─── Clone helper (`_buildPaladinClone`) ────────────────────────────────────

describe('_buildPaladinClone — per-hero hierarchy clone + skeleton + animation', () => {
  function setupLoaded(r, { multi = false } = {}) {
    r._babylon = makeFakeBabylon();
    r._scene = {};
    const mesh = makeFakeSourceMesh('body');
    const skel = makeFakeSkeleton();
    const grp  = makeFakeAnimGroup();
    mesh.skeleton = skel;
    const meshes = multi
      ? [
          makeFakeSourceMesh('helmet', {
            bboxMin: { x: -0.2, y:  0.7, z: -0.2 },
            bboxMax: { x:  0.2, y:  0.9, z:  0.2 },
          }),
          mesh,
          makeFakeSourceMesh('cape', {
            bboxMin: { x: -0.3, y: -0.6, z: -0.1 },
            bboxMax: { x:  0.3, y:  0.4, z:  0.1 },
          }),
        ]
      : [mesh];
    r._paladinSource = { mesh, meshes, skeleton: skel, idleGroup: grp };
    return { mesh, meshes, skel, grp };
  }

  test('returns null when source isn\'t loaded yet', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._paladinSource = null;
    assert.equal(r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null), null);
  });

  test('clones the primary skinned mesh with a per-entity name', () => {
    const r = newInst();
    const { mesh } = setupLoaded(r);
    const out = r._buildPaladinClone({ id: 'e42', type: 'paladin' }, null);
    assert.ok(out && out.skinnedMesh);
    assert.equal(out.skinnedMesh.source, mesh);
    // Child mesh name embeds the entity id + the source mesh's name.
    assert.ok(out.skinnedMesh.name.startsWith('paladin_e42'),
      `expected skinned clone name to start with 'paladin_e42', got '${out.skinnedMesh.name}'`);
  });

  test('binds the source skeleton (shared) onto the skinned child', () => {
    // Per-clone skeleton cloning fails for glTF imports because the imported
    // AnimationGroup targets TransformNodes (via _linkedTransformNode), not
    // Bones — bone-name retargeting after Skeleton.clone leaves every clone
    // in T-pose. Sharing the source skeleton sidesteps the problem: the
    // source idleGroup animates the source skeleton, and every clone that
    // references that skeleton skins identically.
    const r = newInst();
    const { skel } = setupLoaded(r);
    const out = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null);
    assert.equal(out.skinnedMesh.skeleton, skel,
      'skinned child must reference the source skeleton (shared, not cloned)');
    // Per-clone fields are nulled out by design — the shared skeleton +
    // shared animation group are owned by _paladinSource and live for the
    // renderer's lifetime.
    assert.equal(out.skeleton, null);
    assert.equal(out.animationGroup, null);
  });

  test('all clones share the source skeleton (one playing idleGroup drives them all)', () => {
    const r = newInst();
    const { skel } = setupLoaded(r);
    const a = r._buildPaladinClone({ id: 'eA', type: 'paladin' }, null);
    const b = r._buildPaladinClone({ id: 'eB', type: 'paladin' }, null);
    assert.equal(a.skinnedMesh.skeleton, skel);
    assert.equal(b.skinnedMesh.skeleton, skel);
    assert.equal(a.skinnedMesh.skeleton, b.skinnedMesh.skeleton,
      'paladins must share the source skeleton — otherwise they all T-pose');
  });

  test('clone root is parented to the provided anchor (the cone)', () => {
    const r = newInst();
    setupLoaded(r);
    const cone = { name: 'cone' };
    const out  = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, cone);
    assert.equal(out.mesh.parent, cone);
  });

  test('clone root receives the bbox-derived scale + forward-facing yaw', () => {
    const r = newInst();
    setupLoaded(r);
    r._paladinScale = 0.5;
    r._paladinFeetOffset = 0;
    const out = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null);
    assert.equal(out.mesh.scaling.x, 0.5);
    assert.equal(out.mesh.scaling.y, 0.5);
    assert.equal(out.mesh.scaling.z, 0.5);
    assert.equal(out.mesh.rotation.y, PALADIN_YAW);
  });

  test('falls back to PALADIN_BASE_SCALE when _paladinScale is missing or non-positive', () => {
    for (const bad of [undefined, null, 0, -1, NaN]) {
      const r = newInst();
      setupLoaded(r);
      r._paladinScale = bad;
      const out = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null);
      assert.equal(out.mesh.scaling.x, PALADIN_BASE_SCALE,
        `bad scale ${bad} should fall back to PALADIN_BASE_SCALE`);
    }
  });

  test('every cloned CHILD mesh has alwaysSelectAsActiveMesh set (per-submesh culling fix)', () => {
    // The "giant floating head" regression came partly from per-submesh
    // bbox culling — even after fixing scale, Babylon culls each child by
    // its own bbox during skinning. Setting the flag on the root alone
    // doesn't propagate; every child needs it.
    const r = newInst();
    setupLoaded(r, { multi: true });
    const out = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null);
    assert.ok(out.childMeshes.length >= 2,
      `multi-mesh clone must have >1 child, got ${out.childMeshes.length}`);
    for (const child of out.childMeshes) {
      assert.equal(child.alwaysSelectAsActiveMesh, true,
        `child ${child.name} must have alwaysSelectAsActiveMesh set`);
    }
  });

  test('mesh root anchors feet at the cone bottom rim (lifts model by scale * feetOffset)', () => {
    const r = newInst();
    setupLoaded(r);
    r._paladinScale = 0.5;
    r._paladinFeetOffset = 0.9; // Mixamo hip-pivot → feet 0.9 below origin
    const out = r._buildPaladinClone({ id: 'e1', type: 'survivor' }, null);
    // Expected: coneFeetY + scale * feetOffset = -0.275 + 0.45 = 0.175
    // → the model's natural feet (at local y = -0.9, scaled to -0.45)
    // sit at root.position.y + (-0.45) = -0.275, exactly the cone bottom.
    const expectedRootY = -(STANDEE_CONE_HEIGHT) / 2 + 0.5 * 0.9;
    assert.ok(Math.abs(out.mesh.position.y - expectedRootY) < 1e-9,
      `expected root y ${expectedRootY}, got ${out.mesh.position.y}`);
    // Verify the derived feet position lands at the cone bottom rim.
    const feetWorldYInCone = out.mesh.position.y + 0.5 * (-0.9);
    const coneBottom = -(STANDEE_CONE_HEIGHT) / 2;
    assert.ok(Math.abs(feetWorldYInCone - coneBottom) < 1e-9,
      `feet should land at cone bottom ${coneBottom}, got ${feetWorldYInCone}`);
  });

  test('leader entities use the leader height multiplier for the feet offset', () => {
    const r = newInst();
    setupLoaded(r);
    r._paladinScale = 1;
    r._paladinFeetOffset = 0;
    const out = r._buildPaladinClone({ id: 'leader', type: 'paladin' }, null);
    const expected = -(STANDEE_CONE_HEIGHT * STANDEE_LEADER_HEIGHT_MUL) / 2;
    assert.ok(Math.abs(out.mesh.position.y - expected) < 1e-9,
      `leader root should sit at ${expected}, got ${out.mesh.position.y}`);
  });

  // ── Multi-mesh hierarchy ─────────────────────────────────────────────────
  test('multi-mesh hierarchy: each source submesh produces a cloned child parented to the root', () => {
    const r = newInst();
    setupLoaded(r, { multi: true });
    const out = r._buildPaladinClone({ id: 'multi', type: 'paladin' }, null);
    // 3 source meshes → 3 child clones.
    assert.equal(out.childMeshes.length, 3);
    // Every child has the cloned root as its parent.
    for (const c of out.childMeshes) {
      assert.equal(c.parent, out.mesh,
        `child ${c.name} must be parented to the cloned root`);
    }
    // Root is the new TransformNode, NOT one of the child meshes.
    assert.equal(out.mesh._isTransformNode, true);
    assert.equal(out.childMeshes.includes(out.mesh), false);
  });

  test('multi-mesh hierarchy: skinned child is identified and the source skeleton attaches only to it', () => {
    const r = newInst();
    const { mesh: srcSkinned, skel } = setupLoaded(r, { multi: true });
    const out = r._buildPaladinClone({ id: 'multi2', type: 'paladin' }, null);
    // The skinned child is the clone whose source mesh === src.mesh.
    assert.equal(out.skinnedMesh.source, srcSkinned);
    // It carries the SOURCE skeleton (shared), not a cloned one.
    assert.equal(out.skinnedMesh.skeleton, skel);
    // Non-skinned children must NOT carry the shared skeleton — otherwise
    // multiple meshes would each try to skin from the same bone matrices
    // with their own bind poses, producing visual chaos.
    for (const c of out.childMeshes) {
      if (c === out.skinnedMesh) continue;
      assert.notEqual(c.skeleton, skel,
        `non-skinned child ${c.name} must not share the source skeleton`);
    }
  });

  test('TransformNode fallback path: when BABYLON.TransformNode is unavailable, the primary skinned clone serves as the root', () => {
    const r = newInst();
    // Build a paladin source the same way setupLoaded does, but with a
    // BABYLON stub that lacks TransformNode — the implementation should
    // fall back to using the primary skinned clone as the root.
    r._babylon = makeFakeBabylon({ includeTransformNode: false });
    r._scene = {};
    const mesh = makeFakeSourceMesh('body');
    const skel = makeFakeSkeleton();
    mesh.skeleton = skel;
    r._paladinSource = { mesh, meshes: [mesh], skeleton: skel, idleGroup: null };
    const out = r._buildPaladinClone({ id: 'no_tn', type: 'paladin' }, null);
    assert.ok(out);
    // mesh === skinnedMesh in fallback path; scale/rotation applied to it.
    assert.equal(out.mesh, out.skinnedMesh);
    assert.equal(out.ownsRootNode, false);
  });
});

// ─── Dispose (`_disposePaladinClone`) ───────────────────────────────────────

describe('_disposePaladinClone — tears down mesh hierarchy (skeleton + anim are shared, not owned)', () => {
  test('no-ops cleanly when no clone is attached', () => {
    const r = newInst();
    assert.doesNotThrow(() => r._disposePaladinClone({ paladinClone: null }));
    assert.doesNotThrow(() => r._disposePaladinClone({}));
    assert.doesNotThrow(() => r._disposePaladinClone(null));
  });

  test('disposes every child mesh + the root, leaves the SHARED skeleton + anim group alive', () => {
    // Skeleton + animation group live on _paladinSource and are shared
    // across every clone. Disposing them per-clone would kill the idle
    // animation for the survivors. The standee teardown only owns the
    // mesh hierarchy (children + root).
    const r = newInst();
    const root = { name: 'root', _disposed: false, dispose() { this._disposed = true; } };
    const child1 = makeFakeClonedMesh('c1', null);
    const child2 = makeFakeClonedMesh('c2', null);
    const standee = {
      paladinClone: {
        mesh: root,
        skinnedMesh: child1,
        childMeshes: [child1, child2],
        ownsRootNode: true,
        skeleton: null,
        animationGroup: null,
      },
    };
    r._disposePaladinClone(standee);
    assert.equal(child1._disposed, true);
    assert.equal(child2._disposed, true);
    assert.equal(root._disposed, true);
    assert.equal(standee.paladinClone, null);
  });

  test('does NOT double-dispose the root when ownsRootNode is false (root is one of the children)', () => {
    const r = newInst();
    const child = makeFakeClonedMesh('c', null);
    // Legacy / fallback shape: mesh === skinnedMesh === single child.
    const standee = {
      paladinClone: {
        mesh: child,
        skinnedMesh: child,
        childMeshes: [child],
        ownsRootNode: false,
        skeleton: null,
        animationGroup: null,
      },
    };
    let disposeCalls = 0;
    const origDispose = child.dispose.bind(child);
    child.dispose = function() { disposeCalls++; origDispose(); };
    r._disposePaladinClone(standee);
    assert.equal(disposeCalls, 1, 'child should be disposed exactly once');
    assert.equal(standee.paladinClone, null);
  });

  test('survives partial clones (e.g. when skeleton.clone returned null)', () => {
    const r = newInst();
    const child = makeFakeClonedMesh('m', null);
    const standee = {
      paladinClone: {
        mesh: child, skinnedMesh: child, childMeshes: [child],
        ownsRootNode: false, skeleton: null, animationGroup: null,
      },
    };
    assert.doesNotThrow(() => r._disposePaladinClone(standee));
    assert.equal(child._disposed, true);
  });
});

