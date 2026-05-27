// X-ray occlusion ghost — units hidden behind trees / buildings get a flat
// faction-colour "ghost" duplicate of their meshes that shows ONLY over the
// occluder. The render mechanism: when occluded, a cloned, unlit, emissive
// faction-colour duplicate of the unit's meshes is enabled in the WORLD
// rendering group (0) with `depthFunction = GREATER` + `disableDepthWrite`, so
// it depth-tests against the already-drawn scene and rasterizes only where it's
// FARTHER than what's in the depth buffer (= the part hidden behind the
// occluder). Where the unit is clear the ghost fails the depth test and the
// normal unit shows. No HighlightLayer. No renderOutline. No group promotion.
//
// This pins:
//   • the pure helpers (occluder predicate, isOccluded, faction colour,
//     set-diff, sweep throttle), and
//   • the ghost pump against a stubbed scene — occluded units get a ghost
//     built + enabled with the right faction colour, depthFunction GREATER and
//     world rendering group; un-occluded / fog-hidden units do not; dispose
//     tears the ghost down.
//
// The pump (`_pumpXrayOcclusion`) needs no real Babylon — minimal Vector3 / Ray
// / Color3 / StandardMaterial / mesh-clone stubs drive the real math.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  factionOutlineColor,
  xrayOccluderPredicate,
  isOccluded,
  diffOccludedSets,
  shouldSweepXray,
  XRAY_SWEEP_EVERY_N,
  XRAY_GHOST_GROUP,
  XRAY_GHOST_DEPTH_FUNC,
  XRAY_GHOST_ALPHA,
} from '../src/renderer-3d.js';

// ── Babylon stubs ──────────────────────────────────────────────────────────
class V3 {
  constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  static Zero() { return new V3(0, 0, 0); }
  subtract(o) { return new V3(this.x - o.x, this.y - o.y, this.z - o.z); }
  length() { return Math.hypot(this.x, this.y, this.z); }
  normalize() { const l = this.length() || 1; this.x /= l; this.y /= l; this.z /= l; return this; }
  copyFrom(o) { this.x = o.x; this.y = o.y; this.z = o.z; return this; }
}
class Ray { constructor(origin, direction, length) { this.origin = origin; this.direction = direction; this.length = length; } }
class Color3 { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } }
class StandardMaterial {
  constructor(name) { this.name = name; this.disposed = false; this.backFaceCulling = false; }
  dispose() { this.disposed = true; }
}
const Constants = { GREATER: 516 };
const BABYLON = { Vector3: V3, Ray, Color3, StandardMaterial, Constants };

let _meshSeq = 0;
/** A minimal clonable mesh stub. `clone()` returns a tracked duplicate so the
 *  ghost build can be inspected (material, group, depth, enabled, skeleton). */
function makeMesh(name, { renderingGroupId = 0 } = {}) {
  return {
    name,
    id: ++_meshSeq,
    renderingGroupId,
    isPickable: true,
    skeleton: null,
    position: new V3(),
    rotation: new V3(),
    scaling: new V3(1, 1, 1),
    parent: null,
    _enabled: true,
    material: null,
    disposed: false,
    isEnabled() { return this._enabled; },
    setEnabled(v) { this._enabled = !!v; },
    dispose() { this.disposed = true; },
    clone(cloneName, _parent, _dncc) {
      const c = makeMesh(cloneName, { renderingGroupId: this.renderingGroupId });
      c.skeleton = this.skeleton;       // shallow skeleton share (Babylon does too)
      c.parent = this.parent;           // clone keeps source's parent by default
      c._clonedFrom = this.name;
      return c;
    },
  };
}

/** A cone+sphere standee at world-x `x`. Meshes start in rendering group 0 (the
 *  world group). The fake scene decides occlusion from the reconstructed anchor
 *  x (see `makeScene`). */
function makeStandee(x, { enabled = true } = {}) {
  const plane = makeMesh('unit_cone');
  plane.position = new V3(x, 0.3, 0);
  plane.metadata = { kind: 'entity' };
  plane._enabled = enabled;
  const sphere = makeMesh('unit_sphere');
  sphere.position = new V3(x, 0.6, 0);
  sphere.parent = plane;              // sphere is a child of the cone
  return { plane, sphere, leader: false, paladinClone: null, xrayGhost: null };
}

/** Scene whose `pickWithRay` reports a hit (occluded) when the ray's anchor x
 *  rounds to a value in `occludedXs`. Hit distance is half the ray length so
 *  the occluder sits clearly in front of the unit. */
function makeScene(occludedXs) {
  return {
    pickWithRay(ray /*, predicate */) {
      const ax = ray.origin.x + ray.direction.x * ray.length;
      if (occludedXs.has(Math.round(ax))) {
        return { hit: true, distance: ray.length * 0.5 };
      }
      return { hit: false, distance: Infinity };
    },
  };
}

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  const r = new Renderer3D(fakeCanvas, {});
  r._babylon = BABYLON;
  r._camera = {
    position: new V3(0, 10, -10),
    target: new V3(0, 0, 0),
    alpha: 1, beta: 1, radius: 20,
  };
  // Force the throttle to fire on the next single pump call.
  r._xrayFrame = XRAY_SWEEP_EVERY_N - 1;
  return r;
}

/** A ghost mesh is enabled, in the world group, faction-coloured, depth-GREATER. */
function assertGhostEnabled(ghostMesh) {
  assert.equal(ghostMesh._enabled, true, 'ghost mesh enabled');
  assert.equal(ghostMesh.renderingGroupId, XRAY_GHOST_GROUP, 'ghost in world group');
  assert.equal(ghostMesh.isPickable, false, 'ghost not pickable');
  assert.ok(ghostMesh.material, 'ghost has a material');
}

// ── Pure helpers ────────────────────────────────────────────────────────────
describe('xray pure helpers', () => {
  test('factionOutlineColor — explicit colour wins, then theme, then grey', () => {
    assert.equal(factionOutlineColor({ color: '#abcdef', owner: 'hero' }), '#abcdef');
    const heroHex = factionOutlineColor({ owner: 'hero' });
    assert.match(heroHex, /^#[0-9a-f]{6}$/i, 'hero owner resolves to a theme hex');
    assert.equal(factionOutlineColor({}), '#888888');
    assert.equal(factionOutlineColor(null), '#888888');
  });

  test('xrayOccluderPredicate matches trees/buildings/border, not units', () => {
    assert.equal(xrayOccluderPredicate({ metadata: { kind: 'tree-glb' } }), true);
    assert.equal(xrayOccluderPredicate({ metadata: { kind: 'building-glb' } }), true);
    assert.equal(xrayOccluderPredicate({ metadata: { kind: 'map-border-forest' } }), true);
    assert.equal(xrayOccluderPredicate({ name: 'bldg_3_4' }), true);
    assert.equal(xrayOccluderPredicate({ name: 'roof_3_4' }), true);
    assert.equal(xrayOccluderPredicate({ name: 'border_forest_a50_leaves_0' }), true);
    // Units + ground + null are NOT occluders.
    assert.equal(xrayOccluderPredicate({ metadata: { kind: 'entity' }, name: 'unit_7' }), false);
    assert.equal(xrayOccluderPredicate({ metadata: { kind: 'tile' }, name: 'tile_1_1' }), false);
    assert.equal(xrayOccluderPredicate(null), false);
  });

  test('isOccluded — nearer hit blocks, farther/no hit does not', () => {
    assert.equal(isOccluded(10, 5, true), true);
    assert.equal(isOccluded(10, 9.9, true), true);
    assert.equal(isOccluded(10, 10, true), false, 'co-planar hit is not a block');
    assert.equal(isOccluded(10, 12, true), false);
    assert.equal(isOccluded(10, Infinity, false), false, 'no hit → not occluded');
  });

  test('diffOccludedSets reports only changed ids', () => {
    const { added, removed } = diffOccludedSets(new Set([1, 2, 3]), new Set([2, 3, 4]));
    assert.deepEqual(added.sort(), [4]);
    assert.deepEqual(removed.sort(), [1]);
    const none = diffOccludedSets(new Set([1, 2]), new Set([1, 2]));
    assert.deepEqual(none.added, []);
    assert.deepEqual(none.removed, []);
  });

  test('shouldSweepXray — Nth frame AND something moved', () => {
    const N = 4;
    assert.equal(shouldSweepXray({ frame: 4, N, camMoved: true,  unitsMoved: false }), true);
    assert.equal(shouldSweepXray({ frame: 8, N, camMoved: false, unitsMoved: true }), true);
    // Right frame, but nothing changed → skip.
    assert.equal(shouldSweepXray({ frame: 4, N, camMoved: false, unitsMoved: false }), false);
    // Something changed, but off-cadence frame → skip.
    assert.equal(shouldSweepXray({ frame: 5, N, camMoved: true,  unitsMoved: true }), false);
  });
});

// ── Ghost material setup ─────────────────────────────────────────────────────
describe('Renderer3D — xray ghost material', () => {
  test('ghost material is unlit faction emissive, depth-GREATER, no depth-write, transparent', () => {
    const r = makeRenderer();
    r._scene = {};
    const s = makeStandee(0);
    const ghost = r._buildXrayGhost(s, { id: 7, owner: 'hero' });
    assert.ok(ghost, 'ghost built');
    const mat = ghost.material;
    assert.ok(mat instanceof StandardMaterial, 'cloned StandardMaterial');
    assert.equal(mat.disableLighting, true, 'unlit');
    assert.ok(mat.emissiveColor instanceof Color3, 'faction emissive colour');
    assert.equal(mat.depthFunction, XRAY_GHOST_DEPTH_FUNC, 'depthFunction GREATER (516)');
    assert.equal(mat.depthFunction, Constants.GREATER, 'matches BABYLON.Constants.GREATER');
    assert.equal(mat.disableDepthWrite, true, 'no depth write');
    // Load-bearing for the GREATER test: ghost back faces sit farther than the
    // unit body and would bleed the ghost over the visible unit if drawn.
    assert.equal(mat.backFaceCulling, true, 'culls back faces (front-faces-only)');
    assert.equal(mat.alpha, XRAY_GHOST_ALPHA, 'alpha just under 1 → transparent pass');
    assert.ok(mat.alpha > 0 && mat.alpha < 1, 'alpha in (0,1)');
    // Cone + sphere both cloned, both share this one per-ghost material.
    assert.equal(ghost.meshes.length, 2, 'cone + sphere cloned');
    for (const m of ghost.meshes) assert.equal(m.material, mat, 'meshes share the ghost material');
    // Built ghosts start disabled (the pump enables on occlusion).
    for (const m of ghost.meshes) assert.equal(m._enabled, false, 'ghost starts disabled');
  });

  test('cone clone is re-parented under the live cone (tracks position); sphere keeps its parent', () => {
    const r = makeRenderer();
    r._scene = {};
    const s = makeStandee(3);
    const ghost = r._buildXrayGhost(s, { id: 1, owner: 'witch' });
    const coneGhost = ghost.meshes.find(m => m._clonedFrom === 'unit_cone');
    const sphereGhost = ghost.meshes.find(m => m._clonedFrom === 'unit_sphere');
    assert.equal(coneGhost.parent, s.plane, 'cone ghost parented under live cone → tracks');
    assert.deepEqual(
      [coneGhost.position.x, coneGhost.position.y, coneGhost.position.z], [0, 0, 0],
      'cone ghost at identity local position',
    );
    // sphere was a child of the cone; clone keeps that parent → tracks for free.
    assert.equal(sphereGhost.parent, s.plane, 'sphere ghost keeps cone parent');
  });

  test('paladin ghost shares the source skeleton (never clones it)', () => {
    const r = makeRenderer();
    r._scene = {};
    const sharedSkeleton = { bones: [{ name: 'mixamorig:Hips' }] };
    r._paladinSource = { skeleton: sharedSkeleton };
    const s = makeStandee(0);
    const body = makeMesh('paladin_body');
    const sword = makeMesh('paladin_sword');
    s.paladinClone = { childMeshes: [body, sword], skinnedMesh: body };
    const ghost = r._buildXrayGhost(s, { id: 9, owner: 'hero' });
    assert.equal(ghost.meshes.length, 2, 'both paladin children cloned');
    for (const m of ghost.meshes) {
      assert.equal(m.skeleton, sharedSkeleton, 'ghost shares the SOURCE skeleton (no clone)');
      assert.equal(m.material, ghost.material, 'flat ghost material applied over the texture');
    }
  });
});

// ── Pump membership / fog / dispose ─────────────────────────────────────────
describe('Renderer3D — xray occlusion pump', () => {
  test('occluded unit gets an enabled faction-colour ghost; clear unit does not', () => {
    const r = makeRenderer();
    r._scene = makeScene(new Set([0])); // unit at x=0 is occluded, x=5 is clear
    const occ = makeStandee(0);
    const clear = makeStandee(5);
    r._entityStandees = new Map([[1, occ], [2, clear]]);
    r.state = { entities: [
      { id: 1, alive: true, owner: 'hero', col: 0, row: 0 },
      { id: 2, alive: true, owner: 'hero', col: 5, row: 0 },
    ] };

    r._pumpXrayOcclusion();

    assert.equal(r._xrayOutlinedIds.has(1), true,  'occluded unit ghosted');
    assert.equal(r._xrayOutlinedIds.has(2), false, 'clear unit not ghosted');
    // Occluded unit's ghost is built + enabled; clear unit has no ghost.
    assert.ok(occ.xrayGhost, 'occluded unit built a ghost');
    for (const m of occ.xrayGhost.meshes) assertGhostEnabled(m);
    assert.ok(occ.xrayGhost.material.emissiveColor instanceof Color3, 'faction-colour emissive');
    assert.equal(clear.xrayGhost, null, 'clear unit never built a ghost');
  });

  test('orbiting so the unit is no longer occluded disables (but keeps) the ghost', () => {
    const r = makeRenderer();
    const occludedXs = new Set([0]);
    r._scene = makeScene(occludedXs);
    const s = makeStandee(0);
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'witch', col: 0, row: 0 }] };

    r._pumpXrayOcclusion();
    assert.equal(r._xrayOutlinedIds.has(1), true);
    const builtGhost = s.xrayGhost;
    assert.ok(builtGhost);
    for (const m of builtGhost.meshes) assert.equal(m._enabled, true);

    // "Orbit": the unit is no longer occluded, and bump the camera so the
    // throttle re-sweeps (camMoved) on the next aligned frame.
    occludedXs.clear();
    r._camera.alpha += 0.5;
    r._xrayFrame = XRAY_SWEEP_EVERY_N - 1;
    r._pumpXrayOcclusion();

    assert.equal(r._xrayOutlinedIds.has(1), false, 'no longer occluded → dropped from set');
    assert.equal(s.xrayGhost, builtGhost, 'ghost is cached, not disposed');
    for (const m of s.xrayGhost.meshes) assert.equal(m._enabled, false, 'ghost disabled when clear');
  });

  test('fog-hidden unit is never ghosted', () => {
    const r = makeRenderer();
    r._scene = makeScene(new Set([0])); // would be occluded if visible
    const hidden = makeStandee(0, { enabled: false }); // setEnabled(false) via fog
    r._entityStandees = new Map([[1, hidden]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };

    r._pumpXrayOcclusion();

    assert.equal(r._xrayOutlinedIds.has(1), false);
    assert.equal(hidden.xrayGhost, null, 'fog-hidden unit builds no ghost');
  });

  test('paladin clone child meshes are ghosted instead of the hidden cone', () => {
    const r = makeRenderer();
    r._scene = makeScene(new Set([0]));
    r._paladinSource = { skeleton: { bones: [] } };
    const s = makeStandee(0);
    const body = makeMesh('paladin_body');
    const sword = makeMesh('paladin_sword');
    s.paladinClone = { childMeshes: [body, sword], skinnedMesh: body };
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };

    r._pumpXrayOcclusion();

    assert.ok(s.xrayGhost, 'paladin unit ghosted');
    assert.equal(s.xrayGhost.meshes.length, 2, 'both paladin children duplicated');
    for (const m of s.xrayGhost.meshes) assertGhostEnabled(m);
    // The cone itself was NOT cloned (paladin path uses the clone children).
    assert.ok(s.xrayGhost.meshes.every(m => m._clonedFrom.startsWith('paladin_')),
      'ghost duplicates the paladin meshes, not the hidden cone');
  });

  test('throttle: off-cadence frame with no movement does not sweep', () => {
    const r = makeRenderer();
    r._scene = makeScene(new Set([0]));
    const s = makeStandee(0);
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };

    // First pump establishes membership (camMoved true on first sweep).
    r._pumpXrayOcclusion();
    assert.equal(r._xrayOutlinedIds.has(1), true);
    const ghostAfterFirst = s.xrayGhost;

    // Now nothing moves and the frame is off-cadence → no churn, set unchanged.
    r._xrayFrame = XRAY_SWEEP_EVERY_N; // → frame+1 not a multiple of N
    r._pumpXrayOcclusion();
    assert.equal(s.xrayGhost, ghostAfterFirst, 'no rebuild on skipped sweep');
    assert.equal(r._xrayOutlinedIds.has(1), true, 'membership unchanged');
  });

  test('owner change rebuilds the ghost with the new faction colour', () => {
    const r = makeRenderer();
    r._scene = makeScene(new Set([0]));
    const s = makeStandee(0);
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, color: '#ff0000', col: 0, row: 0 }] };
    r._pumpXrayOcclusion();
    const firstGhost = s.xrayGhost;
    assert.equal(firstGhost.colorKey, '#ff0000');

    // Same unit, new owner colour, re-occluded after an orbit.
    r.state.entities[0].color = '#00ff00';
    r._camera.alpha += 0.5;
    r._xrayFrame = XRAY_SWEEP_EVERY_N - 1;
    // Force a fresh sweep that re-adds id 1: drop it from the set first.
    r._setXrayGhostEnabled(s, false);
    r._xrayOutlinedIds.delete(1);
    r._pumpXrayOcclusion();
    assert.notEqual(s.xrayGhost, firstGhost, 'ghost rebuilt on colour change');
    assert.equal(s.xrayGhost.colorKey, '#00ff00');
    assert.equal(firstGhost.material.disposed, true, 'old ghost material disposed');
  });

  test('_clearXrayGhostFor disposes meshes + material and drops tracking', () => {
    const r = makeRenderer();
    r._scene = makeScene(new Set([0]));
    const s = makeStandee(0);
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };
    r._pumpXrayOcclusion();
    const ghost = s.xrayGhost;
    assert.ok(ghost);

    r._clearXrayGhostFor(1, s);
    assert.equal(s.xrayGhost, null, 'ghost cleared off the standee');
    for (const m of ghost.meshes) assert.equal(m.disposed, true, 'ghost meshes disposed');
    assert.equal(ghost.material.disposed, true, 'ghost material disposed');
    assert.equal(r._xrayOutlinedIds.has(1), false, 'dropped from tracking');
  });

  test('_disposeXray tears down every ghost and clears tracking', () => {
    const r = makeRenderer();
    r._scene = makeScene(new Set([0]));
    const s = makeStandee(0);
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };
    r._pumpXrayOcclusion();
    const ghost = s.xrayGhost;
    assert.equal(r._xrayOutlinedIds.size, 1);

    r._disposeXray();
    assert.equal(s.xrayGhost, null, 'ghost disposed off the standee');
    for (const m of ghost.meshes) assert.equal(m.disposed, true);
    assert.equal(ghost.material.disposed, true);
    assert.equal(r._xrayOutlinedIds.size, 0);
  });
});
