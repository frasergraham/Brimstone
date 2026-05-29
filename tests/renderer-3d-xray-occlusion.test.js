// X-ray occlusion outline — units hidden behind trees / buildings get a flat
// faction-colour OUTLINE (a hollow ring), NOT a fill, confined STRICTLY to the
// part of the unit hidden behind the occluder (zero pixels over the visible
// body). The render mechanism is two cloned, per-ghost layers in the WORLD
// rendering group (0), both routed to the transparent sub-pass (alpha < 1) so
// they draw AFTER all opaque world geometry (occluder depth present):
//
//   1. MASK layer (`disableColorWrite`, depthFunction ALWAYS) — stamps the
//      unit's full 2D footprint into the STENCIL buffer (bit XRAY_STENCIL_REF),
//      drawn first (lower alphaIndex). Marks the body interior.
//   2. RING layer — an expanded hull (scaled by XRAY_OUTLINE_SCALE) in flat
//      emissive faction colour, depthFunction GREATER (only where behind scene
//      geometry) AND stencil func NOTEQUAL ref (only outside the mask footprint)
//      → a hollow ring confined to the occluded region.
//
// No HighlightLayer. No renderOutline. No single GREATER-tested fill (a
// non-convex skinned mesh self-occludes → bleeds the ghost over the visible
// body — the artifact this rework eliminates).
//
// This pins:
//   • the pure helpers (occluder predicate, isOccluded, faction colour,
//     set-diff, sweep throttle), and
//   • the ghost pump + builder against a stubbed scene — occluded units get a
//     two-layer ghost built + enabled with the right faction colour, stencil
//     config, depth functions, draw order, and hull expansion; un-occluded /
//     fog-hidden units do not; dispose tears both layers + materials down.
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
  xrayFadeFactor,
  XRAY_SWEEP_EVERY_N,
  XRAY_GHOST_GROUP,
  XRAY_GHOST_DEPTH_FUNC,
  XRAY_MASK_DEPTH_FUNC,
  XRAY_GHOST_ALPHA,
  XRAY_OUTLINE_SCALE,
  XRAY_FADE_MS,
  XRAY_STENCIL_REF,
  XRAY_MASK_ALPHA_INDEX,
  XRAY_RING_ALPHA_INDEX,
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
// MaterialStencilState analogue — Babylon auto-creates `material.stencil`.
class StencilState {
  constructor() {
    this.enabled = false;
    this.func = 519; this.funcRef = 0xFF; this.funcMask = 0xFF; this.mask = 0xFF;
    this.opStencilFail = 7680; this.opDepthFail = 7680; this.opStencilDepthPass = 7680;
  }
}
class StandardMaterial {
  constructor(name) {
    this.name = name; this.disposed = false;
    this.backFaceCulling = false; this.disableColorWrite = false;
    this.stencil = new StencilState();
  }
  dispose() { this.disposed = true; }
}
// GL enum values shared by depth + stencil funcs / ops.
const Constants = { GREATER: 516, ALWAYS: 519, NOTEQUAL: 517, REPLACE: 7681, KEEP: 7680 };
const BABYLON = { Vector3: V3, Ray, Color3, StandardMaterial, Constants };

let _meshSeq = 0;
/** A minimal clonable mesh stub. `clone()` returns a tracked duplicate so the
 *  ghost build can be inspected (material, group, depth, enabled, skeleton,
 *  alphaIndex, scaling). */
function makeMesh(name, { renderingGroupId = 0 } = {}) {
  return {
    name,
    id: ++_meshSeq,
    renderingGroupId,
    alphaIndex: 0,
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
      c.scaling = new V3(this.scaling.x, this.scaling.y, this.scaling.z);
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

/** A ghost mesh is enabled, in the world group, not pickable, has a material. */
function assertGhostEnabled(ghostMesh) {
  assert.equal(ghostMesh._enabled, true, 'ghost mesh enabled');
  assert.equal(ghostMesh.renderingGroupId, XRAY_GHOST_GROUP, 'ghost in world group');
  assert.equal(ghostMesh.isPickable, false, 'ghost not pickable');
  assert.ok(ghostMesh.material, 'ghost has a material');
}

const maskMeshes = (g) => g.meshes.filter(m => m.material === g.maskMaterial);
const ringMeshes = (g) => g.meshes.filter(m => m.material === g.ringMaterial);

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

  test('xrayOccluderPredicate respects isEnabled / isVisible', () => {
    // A disabled occluder (e.g. border-forest hidden at certain zooms) must NOT
    // match — else a unit near the map edge gets a false ghost.
    assert.equal(
      xrayOccluderPredicate({ name: 'border_forest_a50_leaves_0', isEnabled: () => false }),
      false,
    );
    assert.equal(
      xrayOccluderPredicate({ metadata: { kind: 'tree-glb' }, isEnabled: () => false }),
      false,
    );
    // Explicitly invisible occluder also excluded.
    assert.equal(
      xrayOccluderPredicate({ metadata: { kind: 'building-glb' }, isVisible: false }),
      false,
    );
    // Enabled + visible occluder still matches.
    assert.equal(
      xrayOccluderPredicate({ name: 'border_forest_a50_leaves_0', isEnabled: () => true, isVisible: true }),
      true,
    );
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

// ── Ghost layer + material setup ─────────────────────────────────────────────
describe('Renderer3D — xray two-layer outline build', () => {
  test('builds a mask layer + a ring layer (cone + sphere each → 4 meshes)', () => {
    const r = makeRenderer();
    r._scene = {};
    const s = makeStandee(0);
    const ghost = r._buildXrayGhost(s, { id: 7, owner: 'hero' });
    assert.ok(ghost, 'ghost built');
    assert.equal(ghost.meshes.length, 4, 'cone+sphere cloned for BOTH the mask and ring layers');
    assert.equal(maskMeshes(ghost).length, 2, 'mask: cone + sphere');
    assert.equal(ringMeshes(ghost).length, 2, 'ring: cone + sphere');
    // Built ghosts start disabled (the pump enables on occlusion).
    for (const m of ghost.meshes) assert.equal(m._enabled, false, 'ghost starts disabled');
  });

  test('RING material — unlit faction emissive, depth GREATER, stencil NOTEQUAL (draw outside body)', () => {
    const r = makeRenderer();
    r._scene = {};
    const s = makeStandee(0);
    const ghost = r._buildXrayGhost(s, { id: 7, owner: 'hero' });
    const mat = ghost.ringMaterial;
    assert.ok(mat instanceof StandardMaterial, 'cloned StandardMaterial');
    assert.equal(mat.disableLighting, true, 'unlit');
    assert.ok(mat.emissiveColor instanceof Color3, 'faction emissive colour');
    assert.equal(mat.depthFunction, XRAY_GHOST_DEPTH_FUNC, 'depthFunction GREATER (516)');
    assert.equal(mat.depthFunction, Constants.GREATER, 'matches BABYLON.Constants.GREATER');
    assert.equal(mat.disableDepthWrite, true, 'no depth write');
    assert.equal(mat.backFaceCulling, true, 'culls back faces (front-faces-only)');
    // A freshly built ghost starts faded OUT (factor 0) — the pump fades the
    // ring in once the unit is actually occluded. XRAY_GHOST_ALPHA is the FULL
    // (fade target) alpha, held just under 1 so the layer routes to the
    // transparent sub-pass; at factor 0 the ring alpha is 0.
    assert.equal(ghost.fadeFactor, 0, 'ring starts faded out');
    assert.equal(mat.alpha, 0, 'faded-out ring has alpha 0');
    assert.ok(XRAY_GHOST_ALPHA > 0 && XRAY_GHOST_ALPHA < 1, 'full alpha in (0,1) → transparent pass');
    assert.equal(mat.disableColorWrite, false, 'ring DOES write colour');
    // Stencil: draw only where the body footprint bit is NOT set → hollow ring,
    // never a fill over the body (occluded or visible).
    assert.equal(mat.stencil.enabled, true, 'ring stencil enabled');
    assert.equal(mat.stencil.func, Constants.NOTEQUAL, 'stencil func NOTEQUAL');
    assert.equal(mat.stencil.funcRef, XRAY_STENCIL_REF, 'tests the mask bit');
    assert.equal(mat.stencil.funcMask, XRAY_STENCIL_REF, 'read mask = the mask bit');
    assert.equal(mat.stencil.opStencilDepthPass, Constants.KEEP, 'ring never writes the stencil');
  });

  test('MASK material — colour-disabled, depth ALWAYS, stamps the stencil bit', () => {
    const r = makeRenderer();
    r._scene = {};
    const s = makeStandee(0);
    const ghost = r._buildXrayGhost(s, { id: 7, owner: 'hero' });
    const mat = ghost.maskMaterial;
    assert.ok(mat instanceof StandardMaterial, 'cloned StandardMaterial');
    assert.equal(mat.disableColorWrite, true, 'mask writes NO colour (stencil only)');
    assert.equal(mat.depthFunction, XRAY_MASK_DEPTH_FUNC, 'depthFunction ALWAYS (519)');
    assert.equal(mat.depthFunction, Constants.ALWAYS, 'matches BABYLON.Constants.ALWAYS');
    assert.equal(mat.disableDepthWrite, true, 'no depth write');
    assert.equal(mat.alpha, XRAY_GHOST_ALPHA, 'alpha just under 1 → transparent pass (after opaque)');
    // Stencil: stamp the body-footprint bit everywhere the mask draws.
    assert.equal(mat.stencil.enabled, true, 'mask stencil enabled');
    assert.equal(mat.stencil.func, Constants.ALWAYS, 'stencil func ALWAYS (stamp everywhere covered)');
    assert.equal(mat.stencil.funcRef, XRAY_STENCIL_REF, 'writes the mask bit');
    assert.equal(mat.stencil.mask, XRAY_STENCIL_REF, 'write mask = the mask bit only');
    assert.equal(mat.stencil.opStencilDepthPass, Constants.REPLACE, 'sets the bit on draw');
  });

  test('draw order: mask layer alphaIndex < ring layer (transparent sub-pass ordering)', () => {
    const r = makeRenderer();
    r._scene = {};
    const s = makeStandee(0);
    const ghost = r._buildXrayGhost(s, { id: 7, owner: 'hero' });
    for (const m of maskMeshes(ghost)) assert.equal(m.alphaIndex, XRAY_MASK_ALPHA_INDEX, 'mask alphaIndex');
    for (const m of ringMeshes(ghost)) assert.equal(m.alphaIndex, XRAY_RING_ALPHA_INDEX, 'ring alphaIndex');
    assert.ok(XRAY_MASK_ALPHA_INDEX < XRAY_RING_ALPHA_INDEX, 'mask draws before ring → stencil ready');
  });

  test('ring hull is expanded by XRAY_OUTLINE_SCALE; mask stays at real size', () => {
    const r = makeRenderer();
    r._scene = {};
    const s = makeStandee(0);
    const ghost = r._buildXrayGhost(s, { id: 1, owner: 'witch' });
    for (const m of maskMeshes(ghost)) {
      assert.equal(m.scaling.x, 1, 'mask cone/sphere at real size');
    }
    for (const m of ringMeshes(ghost)) {
      assert.ok(Math.abs(m.scaling.x - XRAY_OUTLINE_SCALE) < 1e-9,
        `ring scaled to ${XRAY_OUTLINE_SCALE} (was ${m.scaling.x})`);
    }
    assert.ok(XRAY_OUTLINE_SCALE > 1, 'hull is expanded so the rim is the outline');
  });

  test('cone clone is re-parented under the live cone (tracks position); sphere keeps its parent', () => {
    const r = makeRenderer();
    r._scene = {};
    const s = makeStandee(3);
    const ghost = r._buildXrayGhost(s, { id: 1, owner: 'witch' });
    const maskCone = ghost.maskMeshes.find(m => m._clonedFrom === 'unit_cone');
    const maskSphere = ghost.maskMeshes.find(m => m._clonedFrom === 'unit_sphere');
    assert.equal(maskCone.parent, s.plane, 'cone ghost parented under live cone → tracks');
    assert.deepEqual(
      [maskCone.position.x, maskCone.position.y, maskCone.position.z], [0, 0, 0],
      'cone ghost at identity local position',
    );
    // sphere was a child of the cone; clone keeps that parent → tracks for free.
    assert.equal(maskSphere.parent, s.plane, 'sphere ghost keeps cone parent');
  });

  test('paladin ghost shares the source skeleton (never clones it) on both layers', () => {
    const r = makeRenderer();
    r._scene = {};
    const sharedSkeleton = { bones: [{ name: 'mixamorig:Hips' }] };
    r._paladinSource = { skeleton: sharedSkeleton };
    const s = makeStandee(0);
    const body = makeMesh('paladin_body');
    const sword = makeMesh('paladin_sword');
    s.paladinClone = { childMeshes: [body, sword], skinnedMesh: body };
    const ghost = r._buildXrayGhost(s, { id: 9, owner: 'hero' });
    assert.equal(ghost.meshes.length, 4, 'both paladin children cloned for BOTH layers');
    for (const m of ghost.meshes) {
      assert.equal(m.skeleton, sharedSkeleton, 'ghost shares the SOURCE skeleton (no clone)');
    }
    for (const m of maskMeshes(ghost)) assert.equal(m.material, ghost.maskMaterial);
    for (const m of ringMeshes(ghost)) assert.equal(m.material, ghost.ringMaterial);
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
    // Occluded unit's ghost is built + enabled (all 4 layer meshes); clear unit has none.
    assert.ok(occ.xrayGhost, 'occluded unit built a ghost');
    assert.equal(occ.xrayGhost.meshes.length, 4);
    for (const m of occ.xrayGhost.meshes) assertGhostEnabled(m);
    assert.ok(occ.xrayGhost.ringMaterial.emissiveColor instanceof Color3, 'faction-colour emissive ring');
    assert.equal(clear.xrayGhost, null, 'clear unit never built a ghost');
  });

  test('orbiting so the unit is no longer occluded fades the ghost out, then disables it', () => {
    const r = makeRenderer();
    let T = 1000;
    r._nowMs = () => T;
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
    // Drive the fade-in to completion so the ring is fully on before we orbit.
    r._pumpXrayFades(T + XRAY_FADE_MS);
    assert.equal(builtGhost.fadeFactor, 1, 'ring fully faded in');

    // "Orbit": the unit is no longer occluded, and bump the camera so the
    // throttle re-sweeps (camMoved) on the next aligned frame.
    occludedXs.clear();
    r._camera.alpha += 0.5;
    r._xrayFrame = XRAY_SWEEP_EVERY_N - 1;
    r._pumpXrayOcclusion();

    assert.equal(r._xrayOutlinedIds.has(1), false, 'no longer occluded → dropped from set');
    assert.equal(s.xrayGhost, builtGhost, 'ghost is cached, not disposed');
    // Fade-out has STARTED but not finished — meshes still enabled, ring ramping down.
    for (const m of s.xrayGhost.meshes) assert.equal(m._enabled, true, 'meshes stay enabled while fading out');
    r._pumpXrayFades(T + XRAY_FADE_MS / 2);
    assert.ok(builtGhost.fadeFactor > 0 && builtGhost.fadeFactor < 1, 'ring mid fade-out');

    // Complete the fade-out → meshes disabled.
    r._pumpXrayFades(T + XRAY_FADE_MS);
    assert.equal(builtGhost.fadeFactor, 0, 'ring fully faded out');
    for (const m of s.xrayGhost.meshes) assert.equal(m._enabled, false, 'whole ghost disabled once fade completes');
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
    assert.equal(s.xrayGhost.meshes.length, 4, 'both paladin children duplicated × 2 layers');
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
    // Both layers' materials from the old ghost are disposed.
    assert.equal(firstGhost.ringMaterial.disposed, true, 'old ring material disposed');
    assert.equal(firstGhost.maskMaterial.disposed, true, 'old mask material disposed');
  });

  test('_clearXrayGhostFor disposes meshes + both materials and drops tracking', () => {
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
    assert.equal(ghost.ringMaterial.disposed, true, 'ring material disposed');
    assert.equal(ghost.maskMaterial.disposed, true, 'mask material disposed');
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
    assert.equal(ghost.ringMaterial.disposed, true);
    assert.equal(ghost.maskMaterial.disposed, true);
    assert.equal(r._xrayOutlinedIds.size, 0);
  });
});

// ── Ring fade-in / fade-out ──────────────────────────────────────────────────
// Occlusion-state changes ramp the RING layer's emissive + alpha over
// XRAY_FADE_MS instead of flicking it on/off. The MASK layer is untouched so
// the hollow-ring stencil keeps working through the transition.
describe('xray ring fade', () => {
  test('XRAY_FADE_MS is a positive tunable, XRAY_OUTLINE_SCALE is the thicker 1.13', () => {
    assert.ok(XRAY_FADE_MS > 0, 'fade duration is positive');
    assert.ok(Math.abs(XRAY_OUTLINE_SCALE - 1.13) < 1e-9, 'outline scale bumped to 1.13');
    assert.ok(XRAY_OUTLINE_SCALE > 1, 'hull expanded → the rim is the outline');
  });

  test('xrayFadeFactor — linear ramp in/out, clamped, zero-duration snaps', () => {
    // Fade IN: 0 → 1 across the window.
    assert.equal(xrayFadeFactor({ from: 0, dir: 'in', startMs: 0, durMs: 200, now: 0 }), 0);
    assert.equal(xrayFadeFactor({ from: 0, dir: 'in', startMs: 0, durMs: 200, now: 100 }), 0.5);
    assert.equal(xrayFadeFactor({ from: 0, dir: 'in', startMs: 0, durMs: 200, now: 200 }), 1);
    // Fade OUT: 1 → 0 across the window.
    assert.equal(xrayFadeFactor({ from: 1, dir: 'out', startMs: 0, durMs: 200, now: 50 }), 0.75);
    assert.equal(xrayFadeFactor({ from: 1, dir: 'out', startMs: 0, durMs: 200, now: 200 }), 0);
    // Reversal mid-flight: fade in starting from a half-faded-out 0.4.
    assert.equal(xrayFadeFactor({ from: 0.4, dir: 'in', startMs: 0, durMs: 200, now: 100 }), 0.7);
    // Past the end clamps to the target; zero duration snaps to it.
    assert.equal(xrayFadeFactor({ from: 0, dir: 'in', startMs: 0, durMs: 200, now: 9999 }), 1);
    assert.equal(xrayFadeFactor({ from: 1, dir: 'in', startMs: 0, durMs: 0, now: 0 }), 1);
    assert.equal(xrayFadeFactor({ from: 1, dir: 'out', startMs: 0, durMs: 0, now: 0 }), 0);
  });

  test('occlusion fades the ring IN — alpha ramps over the window, not a snap', () => {
    const r = makeRenderer();
    let T = 5000;
    r._nowMs = () => T;
    r._scene = makeScene(new Set([0]));
    const s = makeStandee(0);
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };

    r._pumpXrayOcclusion(); // occluded → ghost built + enabled, fade-in started at T
    const g = s.xrayGhost;
    assert.ok(g, 'ghost built');
    // Right after the sweep the ring is still at the start of the fade (alpha 0).
    assert.equal(g.fadeFactor, 0, 'starts faded out');
    assert.equal(g.ringMaterial.alpha, 0, 'ring alpha 0 at fade start');
    // The MASK layer is NOT faded — held at full alpha so the stencil works.
    assert.equal(g.maskMaterial.alpha, XRAY_GHOST_ALPHA, 'mask alpha untouched during fade');

    // Tick to the midpoint — alpha is partway, proving it ramps rather than snaps.
    r._pumpXrayFades(T + XRAY_FADE_MS / 2);
    assert.ok(g.fadeFactor > 0 && g.fadeFactor < 1, 'mid fade-in factor in (0,1)');
    assert.ok(g.ringMaterial.alpha > 0 && g.ringMaterial.alpha < XRAY_GHOST_ALPHA,
      'ring alpha partway between 0 and full');
    assert.ok(g.ringMaterial.emissiveColor.r > 0, 'emissive also ramping up');

    // Tick to the end — full alpha + full emissive; the fade map drains.
    r._pumpXrayFades(T + XRAY_FADE_MS);
    assert.equal(g.fadeFactor, 1, 'fully faded in');
    assert.equal(g.ringMaterial.alpha, XRAY_GHOST_ALPHA, 'ring at full alpha');
    assert.equal(r._xrayFading.size, 0, 'settled fade removed from the per-frame map');
  });

  test('steady-state ghost is not in the fade map (no per-frame churn)', () => {
    const r = makeRenderer();
    let T = 0;
    r._nowMs = () => T;
    r._scene = makeScene(new Set([0]));
    const s = makeStandee(0);
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };
    r._pumpXrayOcclusion();
    r._pumpXrayFades(T + XRAY_FADE_MS); // settle the fade-in
    assert.equal(r._xrayFading.size, 0, 'no in-flight fades once settled');
    // A further idle tick is a no-op (map already empty).
    r._pumpXrayFades(T + 10 * XRAY_FADE_MS);
    assert.equal(r._xrayFading.size, 0);
  });
});
