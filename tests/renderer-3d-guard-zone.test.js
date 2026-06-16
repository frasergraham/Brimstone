// Guard-zone outline (3D) — verifies _syncGuardZone builds the orange exterior
// perimeter tubes for guarding units. The Babylon mesh wiring is stubbed (real
// CreateTube runs in-browser); this locks the build LOGIC: when meshes appear,
// where the reach comes from (playback stance vs queued plan), the sight cap,
// and fog suppression. Regression guard for "the zone renders at all" — it was
// silently absent when the feature lived only in the unused 2D renderer.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';
import { GameState, Phase } from '../src/game.js';
import { computeGhostState, PlanActionType } from '../src/planner.js';
import { hexKey } from '../src/hex.js';

// Minimal Babylon stub: just enough for _syncGuardZone's CreateTube / Vector3 /
// StandardMaterial / Color3 calls. Every tube is a disposable spy.
function stubBabylon() {
  return {
    Vector3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    Color3:  class { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } },
    StandardMaterial: class { constructor() { this.backFaceCulling = true; } },
    Mesh: { DOUBLESIDE: 2 },
    MeshBuilder: {
      CreateTube(name) {
        return { name, parent: null, isPickable: true, material: null, metadata: null, disposed: 0, dispose() { this.disposed++; } };
      },
    },
  };
}

// Range is weapon-derived (Entity.getRange()): reach comes from the equipped
// weapon plus ability range mods, not a writable `.range` field. makeRanged
// equips a bow (reach 3) and stacks eagle_eye (+1 range each) to hit a target
// attack range, so the guard zone renders as ranged.
function makeRanged(entity, range) {
  entity.equipWeapon('bow');
  for (let i = 3; i < range; i++) entity.abilities.push('eagle_eye');
}

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  const r = new Renderer3D(fakeCanvas, {});
  r._babylon = stubBabylon();
  r._scene = {};
  r._mapRoot = {};
  r._fogActiveSet = new Set();
  return r;
}

// Carve an open grass band so movement/LOS is deterministic regardless of the
// generated map (mirrors the helper in guard.test.js).
function clearBand(state) {
  for (let c = 3; c <= 11; c++) {
    for (let row = 3; row <= 7; row++) {
      const t = state.tiles.get(hexKey(c, row));
      if (!t) continue;
      t.base = 'grass'; t.path = null; t.structure = null;
      t.buildingFootprintOf = null; t.footprintHexes = []; t.fortifyLevel = 0;
    }
  }
}

describe('Renderer3D._syncGuardZone — perimeter outline build', () => {
  test('no guarding unit → no meshes', () => {
    const r = makeRenderer();
    const state = new GameState(true, true);
    state.planningPhase = false;
    r.state = state;
    r._syncGuardZone();
    assert.equal((r._guardZoneMeshes ?? []).length, 0);
  });

  test('playback: a guarding ranged unit produces perimeter tubes', () => {
    const r = makeRenderer();
    const state = new GameState(true, true);
    const guard = state.hero;
    makeRanged(guard, 3); guard.guarding = 1; guard.col = 5; guard.row = 5;
    clearBand(state);
    state.planningPhase = false;
    r.state = state;
    r._syncGuardZone();
    assert.ok((r._guardZoneMeshes ?? []).length > 0,
      'a guarding unit should produce an outline');
  });

  test('planning: a queued GUARD action previews the zone (no live stance yet)', () => {
    const r = makeRenderer();
    const state = new GameState(true, true);
    const guard = state.hero;
    makeRanged(guard, 3); guard.guarding = 0; guard.col = 5; guard.row = 5;
    clearBand(state);
    state.planningPhase = true;
    r.state = state;
    r.planGhostSteps = computeGhostState(state,
      [{ type: PlanActionType.GUARD, entityId: guard.id }]);
    r._syncGuardZone();
    assert.ok((r._guardZoneMeshes ?? []).length > 0,
      'a queued GUARD should preview the outline during planning');
  });

  test('melee guard outlines its six-neighbour ring', () => {
    const r = makeRenderer();
    const state = new GameState(true, true);
    const guard = state.hero;
    guard.range = 1; guard.guarding = 1; guard.col = 5; guard.row = 5;
    clearBand(state);
    state.planningPhase = false;
    r.state = state;
    r._syncGuardZone();
    // The melee zone is the 6 neighbours with the guard's own (excluded) hex as
    // a hole — an annulus. Each ring hex draws 4 perimeter edges (1 toward the
    // central hole + 3 outward; the 2 shared with adjacent ring hexes are
    // skipped) → 6 × 4 = 24 exterior-perimeter tubes.
    assert.equal((r._guardZoneMeshes ?? []).length, 24);
  });

  test('fogged guarding unit is suppressed (no zone revealed) during playback', () => {
    const r = makeRenderer();
    const state = new GameState(true, true);
    const guard = state.hero;
    makeRanged(guard, 3); guard.guarding = 1; guard.col = 5; guard.row = 5;
    clearBand(state);
    state.planningPhase = false;
    r.state = state;
    r._fogActiveSet = new Set([hexKey(guard.col, guard.row)]);
    r._syncGuardZone();
    assert.equal((r._guardZoneMeshes ?? []).length, 0,
      'a unit hidden by fog must not reveal its guard coverage');
  });

  test('sight cap shrinks the zone vs raw attack range at night', () => {
    // range 5 but night hero sight 3 → the covered set (and thus the perimeter)
    // is strictly smaller than an uncapped range-5 disc would be.
    const big = makeRenderer();
    const sNight = new GameState(true, true);
    sNight.phase = Phase.NIGHT;
    const g1 = sNight.hero; makeRanged(g1, 5); g1.guarding = 1; g1.col = 7; g1.row = 7;
    sNight.planningPhase = false;
    big.state = sNight;
    big._syncGuardZone();
    const nightCount = (big._guardZoneMeshes ?? []).length;

    const day = makeRenderer();
    const sDay = new GameState(true, true);
    sDay.phase = Phase.DAY;            // hero sight 6 ≥ range 5 → uncapped
    const g2 = sDay.hero; makeRanged(g2, 5); g2.guarding = 1; g2.col = 7; g2.row = 7;
    sDay.planningPhase = false;
    day.state = sDay;
    day._syncGuardZone();
    const dayCount = (day._guardZoneMeshes ?? []).length;

    assert.ok(nightCount > 0 && dayCount > 0, 'both phases draw something');
    assert.ok(nightCount < dayCount,
      `night sight cap (3) should yield a smaller perimeter than day (6): night ${nightCount} vs day ${dayCount}`);
  });
});
