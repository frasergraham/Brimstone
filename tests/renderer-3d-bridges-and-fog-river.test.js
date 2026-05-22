// Tests for the bundled polish: bridge plank rendering disabled, and the
// river extension ribbons that thread through the border-forest band tinted
// dark to match the surrounding out-of-play forest.
//
// The renderer itself can't run in node-test (Babylon + WebGL), so we cover
// the change with two angles:
//   • A pure helper `fogRibbonMaterialColors` that derives the darkened
//     diffuse + emissive tuple from a CSS hex colour — exercised here.
//   • The bridge-plank gate inside `_buildTileMesh` is a `_renderBridges`
//     flag on the renderer instance; we exercise it by constructing a bare
//     instance and asserting the flag defaults to off (so the plank build
//     is dead code at runtime until a future caller flips it).
//
// Visual layering of the road tube across the river hex is unchanged — the
// road network builds itself from `roadDirs`, independent of whether the
// bridge plank is present. That's covered by the existing network tests
// (renderer-3d-networks.test.js).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  fogRibbonMaterialColors,
  ribbonMaterialColors,
  FOG_TILE_DARKEN,
  Renderer3D,
} from '../src/renderer-3d.js';
import { TileType, TILE_COLOR } from '../src/tiles.js';

// ── fogRibbonMaterialColors ──────────────────────────────────────────────────

describe('Renderer3D — fogRibbonMaterialColors', () => {
  test('returns the same shape as ribbonMaterialColors (diffuse + emissive triplets)', () => {
    const out = fogRibbonMaterialColors('#1a3d5c');
    assert.ok(Array.isArray(out.diffuse) && out.diffuse.length === 3);
    assert.ok(Array.isArray(out.emissive) && out.emissive.length === 3);
  });

  test('each channel is the unfogged ribbon colour × FOG_TILE_DARKEN by default', () => {
    const hex   = TILE_COLOR[TileType.RIVER];
    const lit   = ribbonMaterialColors(hex);
    const dark  = fogRibbonMaterialColors(hex);
    const k     = FOG_TILE_DARKEN;
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(dark.diffuse[i]  - lit.diffuse[i]  * k) < 1e-9,
        `diffuse[${i}] ${dark.diffuse[i]} should equal ${lit.diffuse[i] * k}`);
      assert.ok(Math.abs(dark.emissive[i] - lit.emissive[i] * k) < 1e-9,
        `emissive[${i}] ${dark.emissive[i]} should equal ${lit.emissive[i] * k}`);
    }
  });

  test('fog tint reduces brightness — every channel is dimmer than the lit ribbon', () => {
    const lit  = ribbonMaterialColors(TILE_COLOR[TileType.RIVER]);
    const dark = fogRibbonMaterialColors(TILE_COLOR[TileType.RIVER]);
    for (let i = 0; i < 3; i++) {
      assert.ok(dark.diffuse[i]  < lit.diffuse[i],
        `diffuse[${i}] should darken: ${dark.diffuse[i]} < ${lit.diffuse[i]}`);
      assert.ok(dark.emissive[i] < lit.emissive[i],
        `emissive[${i}] should darken: ${dark.emissive[i]} < ${lit.emissive[i]}`);
    }
  });

  test('explicit darken parameter is honoured (used by the renderer when fog tuner moves)', () => {
    const lit  = ribbonMaterialColors('#1a3d5c');
    const out  = fogRibbonMaterialColors('#1a3d5c', 0.5);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(out.diffuse[i]  - lit.diffuse[i]  * 0.5) < 1e-9);
      assert.ok(Math.abs(out.emissive[i] - lit.emissive[i] * 0.5) < 1e-9);
    }
  });

  test('darken=1 returns the unfogged colours unchanged', () => {
    const lit  = ribbonMaterialColors('#1a3d5c');
    const out  = fogRibbonMaterialColors('#1a3d5c', 1.0);
    for (let i = 0; i < 3; i++) {
      assert.ok(Math.abs(out.diffuse[i]  - lit.diffuse[i])  < 1e-9);
      assert.ok(Math.abs(out.emissive[i] - lit.emissive[i]) < 1e-9);
    }
  });

  test('darken=0 floors every channel to zero', () => {
    const out = fogRibbonMaterialColors('#1a3d5c', 0);
    for (let i = 0; i < 3; i++) {
      assert.equal(out.diffuse[i], 0);
      assert.equal(out.emissive[i], 0);
    }
  });
});

// ── Bridge plank gate ────────────────────────────────────────────────────────

describe('Renderer3D — _renderBridges flag', () => {
  test('defaults to false so the bridge plank build inside _buildTileMesh is short-circuited', () => {
    // Construct a bare renderer — passing no canvas/state means Babylon and
    // the scene stay null, which is exactly what we want for this assertion.
    const r = new Renderer3D(null, null);
    assert.equal(r._renderBridges, false,
      'bridge plank rendering must be off by default — road tube crosses the river on its own');
  });

  test('flag is a plain boolean that can be flipped on by callers', () => {
    const r = new Renderer3D(null, null);
    r._renderBridges = true;
    assert.equal(r._renderBridges, true);
    r._renderBridges = false;
    assert.equal(r._renderBridges, false);
  });
});
