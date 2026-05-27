// X-ray occlusion outline (v1) — units hidden behind trees / buildings get a
// faction-coloured, depth-ignoring HighlightLayer silhouette so they read
// through the occluder. This pins:
//   • the pure helpers (occluder predicate, isOccluded, faction colour,
//     set-diff, sweep throttle), and
//   • the membership pump against a stubbed HighlightLayer + scene — occluded
//     units are added with their faction colour, un-occluded / fog-hidden
//     units are never outlined, and dispose tears the layer down.
//
// The pump (`_pumpXrayOcclusion`) needs no real Babylon — minimal Vector3 /
// Ray / Color3 / HighlightLayer / scene stubs drive the real math.

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
const BABYLON = { Vector3: V3, Ray, Color3, HighlightLayer: function () {} };

function fakeHL() {
  const added = new Map(); // mesh → color
  const calls = { add: [], remove: [], disposed: false };
  return {
    _added: added,
    calls,
    innerGlow: true,
    outerGlow: true,
    addMesh(m, c) { added.set(m, c); calls.add.push({ mesh: m, color: c }); },
    removeMesh(m) { added.delete(m); calls.remove.push(m); },
    dispose() { calls.disposed = true; },
  };
}

/** A cone+sphere standee at world-x `x`. The fake scene decides occlusion from
 *  the reconstructed anchor x (see `makeScene`). */
function makeStandee(x, { enabled = true } = {}) {
  const plane = {
    name: 'unit_cone',
    position: new V3(x, 0.3, 0),
    metadata: { kind: 'entity' },
    _enabled: enabled,
    isEnabled() { return this._enabled; },
  };
  const sphere = { name: 'unit_sphere', position: new V3(x, 0.6, 0) };
  return { plane, sphere, leader: false, paladinClone: null };
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

// ── Pump membership / fog / dispose ─────────────────────────────────────────
describe('Renderer3D — xray occlusion pump', () => {
  test('occluded unit is added to the layer with its faction colour; clear one is not', () => {
    const r = makeRenderer();
    const hl = r._xrayHL = fakeHL();
    r._scene = makeScene(new Set([0])); // unit at x=0 is occluded, x=5 is clear
    const occ = makeStandee(0);
    const clear = makeStandee(5);
    r._entityStandees = new Map([[1, occ], [2, clear]]);
    r.state = { entities: [
      { id: 1, alive: true, owner: 'hero', col: 0, row: 0 },
      { id: 2, alive: true, owner: 'hero', col: 5, row: 0 },
    ] };

    r._pumpXrayOcclusion();

    assert.equal(r._xrayOutlinedIds.has(1), true,  'occluded unit outlined');
    assert.equal(r._xrayOutlinedIds.has(2), false, 'clear unit not outlined');
    // cone + sphere of the occluded unit are in the layer; clear unit's are not.
    assert.equal(hl._added.has(occ.plane), true);
    assert.equal(hl._added.has(occ.sphere), true);
    assert.equal(hl._added.has(clear.plane), false);
    // Added with a Color3 (faction colour), not undefined.
    assert.ok(hl._added.get(occ.plane) instanceof Color3);
  });

  test('orbiting so the unit is no longer occluded removes it from the layer', () => {
    const r = makeRenderer();
    const hl = r._xrayHL = fakeHL();
    const occludedXs = new Set([0]);
    r._scene = makeScene(occludedXs);
    const s = makeStandee(0);
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'witch', col: 0, row: 0 }] };

    r._pumpXrayOcclusion();
    assert.equal(r._xrayOutlinedIds.has(1), true);
    assert.equal(hl._added.has(s.plane), true);

    // "Orbit": the unit is no longer occluded, and bump the camera so the
    // throttle re-sweeps (camMoved) on the next aligned frame.
    occludedXs.clear();
    r._camera.alpha += 0.5;
    r._xrayFrame = XRAY_SWEEP_EVERY_N - 1;
    r._pumpXrayOcclusion();

    assert.equal(r._xrayOutlinedIds.has(1), false, 'no longer occluded → dropped');
    assert.equal(hl._added.has(s.plane), false, 'meshes removed from layer');
    assert.ok(hl.calls.remove.length >= 1);
  });

  test('fog-hidden unit is never outlined', () => {
    const r = makeRenderer();
    const hl = r._xrayHL = fakeHL();
    r._scene = makeScene(new Set([0])); // would be occluded if visible
    const hidden = makeStandee(0, { enabled: false }); // setEnabled(false) via fog
    r._entityStandees = new Map([[1, hidden]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };

    r._pumpXrayOcclusion();

    assert.equal(r._xrayOutlinedIds.has(1), false);
    assert.equal(hl._added.size, 0, 'fog-hidden unit contributes no outline meshes');
  });

  test('paladin clone child meshes are outlined instead of the hidden cone', () => {
    const r = makeRenderer();
    const hl = r._xrayHL = fakeHL();
    r._scene = makeScene(new Set([0]));
    const s = makeStandee(0);
    const body = { name: 'paladin_body' };
    const sword = { name: 'paladin_sword' };
    s.paladinClone = { childMeshes: [body, sword] };
    r._entityStandees = new Map([[1, s]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };

    r._pumpXrayOcclusion();

    assert.equal(hl._added.has(body), true);
    assert.equal(hl._added.has(sword), true);
    assert.equal(hl._added.has(s.plane), false, 'hidden cone is not outlined when paladin loaded');
  });

  test('throttle: off-cadence frame with no movement does not sweep', () => {
    const r = makeRenderer();
    r._xrayHL = fakeHL();
    r._scene = makeScene(new Set([0]));
    r._entityStandees = new Map([[1, makeStandee(0)]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };

    // First pump establishes membership (camMoved true on first sweep).
    r._pumpXrayOcclusion();
    assert.equal(r._xrayOutlinedIds.has(1), true);

    // Now nothing moves and the frame is off-cadence → no churn, set unchanged.
    r._xrayFrame = XRAY_SWEEP_EVERY_N; // → frame+1 not a multiple of N
    const before = r._xrayHL.calls.add.length;
    r._pumpXrayOcclusion();
    assert.equal(r._xrayHL.calls.add.length, before, 'no extra addMesh on skipped sweep');
  });

  test('_disposeXray tears down the layer and clears tracking', () => {
    const r = makeRenderer();
    const hl = r._xrayHL = fakeHL();
    r._scene = makeScene(new Set([0]));
    r._entityStandees = new Map([[1, makeStandee(0)]]);
    r.state = { entities: [{ id: 1, alive: true, owner: 'hero', col: 0, row: 0 }] };
    r._pumpXrayOcclusion();
    assert.equal(r._xrayOutlinedIds.size, 1);

    r._disposeXray();
    assert.equal(hl.calls.disposed, true);
    assert.equal(r._xrayHL, null);
    assert.equal(r._xrayOutlinedIds.size, 0);
  });
});
