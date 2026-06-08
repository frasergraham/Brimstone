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

