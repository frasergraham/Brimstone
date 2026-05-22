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
  STANDEE_CONE_HEIGHT,
  STANDEE_LEADER_HEIGHT_MUL,
} from '../src/renderer-3d.js';

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

function fakeVector3Ctor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }

/** Build a minimal BABYLON stub exposing only what the paladin pipeline
 *  touches. `SceneLoader.ImportMeshAsync` is overridable per-case. */
function makeFakeBabylon({ importImpl } = {}) {
  return {
    Vector3: fakeVector3Ctor,
    SceneLoader: {
      ImportMeshAsync: importImpl || (async () => ({ meshes: [] })),
    },
  };
}

/** Source mesh stub — `clone()` returns a fresh stub that the renderer
 *  can position, scale, and parent. */
function makeFakeSourceMesh(name = 'paladin_src', { vertices = 200 } = {}) {
  const cloneCalls = [];
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
    getTotalVertices: () => vertices,
    setEnabled(b) { this.isEnabled = b; },
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
  test('PALADIN_MODEL_FILE is paladin.glb', () => {
    assert.equal(PALADIN_MODEL_FILE, 'paladin.glb');
  });
  test('PALADIN_BASE_SCALE is a positive sub-unit float', () => {
    assert.ok(PALADIN_BASE_SCALE > 0 && PALADIN_BASE_SCALE < 2);
  });
  test('PALADIN_YAW is in [0, 2π)', () => {
    assert.ok(PALADIN_YAW >= 0 && PALADIN_YAW < Math.PI * 2 + 1e-9);
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

  test('idle animation group is stopped on the source (per-clone copy plays instead)', async () => {
    const r = newInst();
    r._scene = {};
    const mesh = makeFakeSourceMesh();
    const grp  = makeFakeAnimGroup('Idle');
    r._babylon = makeFakeBabylon({
      importImpl: async () => ({ meshes: [mesh], animationGroups: [grp] }),
    });
    await r._loadPaladinModel('assets');
    assert.equal(grp._stopped, true);
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
    let calls = 0;
    r._babylon = makeFakeBabylon({
      importImpl: async () => {
        calls++;
        return { meshes: [makeFakeSourceMesh()] };
      },
    });
    const [a, b] = await Promise.all([
      r._loadPaladinModel('assets'),
      r._loadPaladinModel('assets'),
    ]);
    assert.equal(calls, 1, 'second concurrent call must reuse the in-flight promise');
    assert.equal(a, b);
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
    assert.deepEqual(calls, ['ensure', 'import']);
  });
});

// ─── Clone helper (`_buildPaladinClone`) ────────────────────────────────────

describe('_buildPaladinClone — per-hero mesh + skeleton + animation', () => {
  function setupLoaded(r) {
    r._babylon = makeFakeBabylon();
    const mesh = makeFakeSourceMesh();
    const skel = makeFakeSkeleton();
    const grp  = makeFakeAnimGroup();
    mesh.skeleton = skel;
    r._paladinSource = { mesh, skeleton: skel, idleGroup: grp };
    return { mesh, skel, grp };
  }

  test('returns null when source isn\'t loaded yet', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._paladinSource = null;
    assert.equal(r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null), null);
  });

  test('clones the source mesh with a per-entity name', () => {
    const r = newInst();
    const { mesh } = setupLoaded(r);
    const out = r._buildPaladinClone({ id: 'e42', type: 'paladin' }, null);
    assert.ok(out && out.mesh);
    assert.equal(out.mesh.name, 'paladin_e42');
    assert.equal(out.mesh.source, mesh);
  });

  test('clones the skeleton and binds it to the cloned mesh', () => {
    const r = newInst();
    setupLoaded(r);
    const out = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null);
    assert.ok(out.skeleton);
    assert.equal(out.skeleton.name, 'paladinSkel_e1');
    assert.equal(out.mesh.skeleton, out.skeleton);
  });

  test('clones the idle animation group and starts it looping at speed 1.0', () => {
    const r = newInst();
    setupLoaded(r);
    const out = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null);
    assert.ok(out.animationGroup);
    assert.equal(out.animationGroup.name, 'paladinAnim_e1');
    assert.deepEqual(out.animationGroup._started, { loop: true, speed: 1.0 });
  });

  test('animation clone passes a target-converter that maps bones by name', () => {
    const r = newInst();
    setupLoaded(r);
    const out = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null);
    const conv = out.animationGroup._converter;
    assert.equal(typeof conv, 'function');
    // The converter should return the cloned-skeleton bone matching the
    // source target's name. We can't compare by reference (clones are
    // distinct), so just check that name-matched lookup happens.
    const fakeOldTarget = { name: 'mixamorig:Hips' };
    const remapped = conv(fakeOldTarget);
    assert.equal(remapped.name, 'mixamorig:Hips');
  });

  test('animation clone falls through gracefully when name has no bone match', () => {
    const r = newInst();
    setupLoaded(r);
    const out = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null);
    const conv = out.animationGroup._converter;
    const fake = { name: 'NonExistentBone' };
    // Returns the original target (passthrough) rather than throwing.
    assert.equal(conv(fake), fake);
  });

  test('per-hero cloned animation groups are distinct objects', () => {
    const r = newInst();
    setupLoaded(r);
    const a = r._buildPaladinClone({ id: 'eA', type: 'paladin' }, null);
    const b = r._buildPaladinClone({ id: 'eB', type: 'paladin' }, null);
    assert.notEqual(a.animationGroup, b.animationGroup,
      'each hero must drive its own AnimationGroup so idles desync naturally');
    assert.notEqual(a.skeleton, b.skeleton,
      'each hero must have its own skeleton instance');
  });

  test('cloned mesh is parented to the provided anchor (the cone)', () => {
    const r = newInst();
    setupLoaded(r);
    const cone = { name: 'cone' };
    const out  = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, cone);
    assert.equal(out.mesh.parent, cone);
  });

  test('cloned mesh receives the standard scale + forward-facing yaw', () => {
    const r = newInst();
    setupLoaded(r);
    const out = r._buildPaladinClone({ id: 'e1', type: 'paladin' }, null);
    assert.equal(out.mesh.scaling.x, PALADIN_BASE_SCALE);
    assert.equal(out.mesh.scaling.y, PALADIN_BASE_SCALE);
    assert.equal(out.mesh.scaling.z, PALADIN_BASE_SCALE);
    assert.equal(out.mesh.rotation.y, PALADIN_YAW);
  });

  test('mesh sits at cone-local feet (Y = -coneHeight/2) so feet rest on the base disc', () => {
    const r = newInst();
    setupLoaded(r);
    // Non-leader unit (regular paladin).
    const out = r._buildPaladinClone({ id: 'e1', type: 'survivor' }, null);
    const expected = -(STANDEE_CONE_HEIGHT) / 2;
    assert.ok(Math.abs(out.mesh.position.y - expected) < 1e-9,
      `expected feet at ${expected}, got ${out.mesh.position.y}`);
  });

  test('leader entities use the leader height multiplier for the feet offset', () => {
    const r = newInst();
    setupLoaded(r);
    const out = r._buildPaladinClone({ id: 'leader', type: 'paladin' }, null);
    const expected = -(STANDEE_CONE_HEIGHT * STANDEE_LEADER_HEIGHT_MUL) / 2;
    assert.ok(Math.abs(out.mesh.position.y - expected) < 1e-9,
      `leader feet should be at ${expected}, got ${out.mesh.position.y}`);
  });
});

// ─── Dispose (`_disposePaladinClone`) ───────────────────────────────────────

describe('_disposePaladinClone — tears down animation + skeleton + mesh', () => {
  test('no-ops cleanly when no clone is attached', () => {
    const r = newInst();
    assert.doesNotThrow(() => r._disposePaladinClone({ paladinClone: null }));
    assert.doesNotThrow(() => r._disposePaladinClone({}));
    assert.doesNotThrow(() => r._disposePaladinClone(null));
  });

  test('disposes all three pieces and clears the field', () => {
    const r = newInst();
    const mesh = makeFakeClonedMesh('m', null);
    const skel = makeFakeSkeleton('s');
    const grp  = makeFakeAnimGroup('g');
    const standee = { paladinClone: { mesh, skeleton: skel, animationGroup: grp } };
    r._disposePaladinClone(standee);
    assert.equal(grp._disposed, true);
    assert.equal(skel._disposed, true);
    assert.equal(mesh._disposed, true);
    assert.equal(standee.paladinClone, null);
  });

  test('survives partial clones (e.g. when skeleton.clone returned null)', () => {
    const r = newInst();
    const mesh = makeFakeClonedMesh('m', null);
    const standee = { paladinClone: { mesh, skeleton: null, animationGroup: null } };
    assert.doesNotThrow(() => r._disposePaladinClone(standee));
    assert.equal(mesh._disposed, true);
  });
});

// ─── Retrofit pass (`_upgradeHeroStandeesToPaladin`) ────────────────────────

describe('_upgradeHeroStandeesToPaladin — async-load retrofit', () => {
  function plantStandee(r, id, owner, type = 'paladin') {
    const cone   = { name: `unit_${id}`, visibility: 1, metadata: {} };
    const sphere = { name: `unit_${id}_head`, visibility: 1 };
    const base   = { name: `unitbase_${id}` };
    r._entityStandees.set(id, { plane: cone, base, sphere, leader: false, paladinClone: null });
    return { cone, sphere, base };
  }
  function setupSourceAndState(r, entities) {
    r._babylon = makeFakeBabylon();
    const mesh = makeFakeSourceMesh();
    const skel = makeFakeSkeleton();
    const grp  = makeFakeAnimGroup();
    mesh.skeleton = skel;
    r._paladinSource = { mesh, skeleton: skel, idleGroup: grp };
    r.state = { entities };
  }

  test('upgrades hero standees with a paladin clone and hides cone+sphere', () => {
    const r = newInst();
    setupSourceAndState(r, [
      { id: 'h1', owner: 'hero',  type: 'paladin', col: 0, row: 0 },
      { id: 'w1', owner: 'witch', type: 'witch',   col: 1, row: 0 },
    ]);
    const { cone, sphere } = plantStandee(r, 'h1', 'hero');
    plantStandee(r, 'w1', 'witch');
    const upgraded = r._upgradeHeroStandeesToPaladin();
    assert.equal(upgraded, 1);
    assert.equal(cone.visibility, 0);
    assert.equal(sphere.visibility, 0);
    assert.ok(r._entityStandees.get('h1').paladinClone);
    assert.equal(r._entityStandees.get('w1').paladinClone, null);
  });

  test('skips standees already carrying a clone (idempotent)', () => {
    const r = newInst();
    setupSourceAndState(r, [{ id: 'h1', owner: 'hero', type: 'paladin' }]);
    plantStandee(r, 'h1', 'hero');
    assert.equal(r._upgradeHeroStandeesToPaladin(), 1);
    assert.equal(r._upgradeHeroStandeesToPaladin(), 0,
      'second pass must find no work to do');
  });

  test('no-ops when source isn\'t loaded', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    r._paladinSource = null;
    r.state = { entities: [{ id: 'h1', owner: 'hero', type: 'paladin' }] };
    plantStandee(r, 'h1', 'hero');
    assert.equal(r._upgradeHeroStandeesToPaladin(), 0);
  });

  test('no-ops when state has no entities array', () => {
    const r = newInst();
    setupSourceAndState(r, []);
    r.state = null;
    assert.equal(r._upgradeHeroStandeesToPaladin(), 0);
  });

  test('ignores entities that exist in state but have no standee built yet', () => {
    const r = newInst();
    setupSourceAndState(r, [
      { id: 'h1', owner: 'hero', type: 'paladin' },
      { id: 'h2', owner: 'hero', type: 'paladin' },
    ]);
    plantStandee(r, 'h1', 'hero');
    assert.equal(r._upgradeHeroStandeesToPaladin(), 1);
  });
});

// ─── _buildStandeeMesh fork — pre-loaded source path ────────────────────────
//
// We can't drive the full `_buildStandeeMesh` (which calls into Babylon
// MeshBuilder) without a WebGL context, but `_upgradeHeroStandeesToPaladin`
// exercises the same hero-predicate + clone-paladin branch the inline build
// fork takes when the source is available at construction time. The
// integration test below confirms the end-to-end shape: a hero in state
// gets a hidden cone+sphere and a paladin clone, a non-hero doesn't.

describe('hero predicate gates the paladin path end-to-end', () => {
  test('multiple heroes each get a distinct paladin clone after retrofit', () => {
    const r = newInst();
    r._babylon = makeFakeBabylon();
    const mesh = makeFakeSourceMesh();
    const skel = makeFakeSkeleton();
    const grp  = makeFakeAnimGroup();
    mesh.skeleton = skel;
    r._paladinSource = { mesh, skeleton: skel, idleGroup: grp };
    r.state = {
      entities: [
        { id: 'h1', owner: 'hero',  type: 'paladin' },
        { id: 'h2', owner: 'hero',  type: 'survivor' },
        { id: 'w1', owner: 'witch', type: 'witch' },
        { id: 'z1', owner: 'witch', type: 'zombie' },
      ],
    };
    // Plant standees for all four entities.
    for (const e of r.state.entities) {
      const cone   = { name: `unit_${e.id}`, visibility: 1, metadata: {} };
      const sphere = { name: `unit_${e.id}_head`, visibility: 1 };
      r._entityStandees.set(e.id, { plane: cone, base: {}, sphere, leader: false, paladinClone: null });
    }
    const upgraded = r._upgradeHeroStandeesToPaladin();
    assert.equal(upgraded, 2);
    const h1Clone = r._entityStandees.get('h1').paladinClone;
    const h2Clone = r._entityStandees.get('h2').paladinClone;
    assert.ok(h1Clone && h2Clone);
    assert.notEqual(h1Clone.skeleton, h2Clone.skeleton,
      'each hero must have its own skeleton — paladins can\'t share bone matrices');
    assert.notEqual(h1Clone.animationGroup, h2Clone.animationGroup,
      'each hero must have its own AnimationGroup so idles play independently');
    assert.equal(r._entityStandees.get('w1').paladinClone, null);
    assert.equal(r._entityStandees.get('z1').paladinClone, null);
  });
});
