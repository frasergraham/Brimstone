// Fog-of-war tiles must render VISIBLY DARKER than lit ones.
//
// The bug this locks down: darkening only the fogged terrain material's
// `diffuseColor` is invisible at bright phases. StandardMaterial computes
//   finalDiffuse = clamp(lightAccum * diffuseColor + ambient, 0, 1) * texel
// At day the light accumulation (sun ≈ 2.0 + hemi) pushes `lightAccum` well
// past 1.0, so clamp(lightAccum * 0.55) still clamps to 1.0 — the ×0.55 is
// swallowed and the fogged hex reads exactly as bright as a lit one. The
// texture sample (`texel`) is applied OUTSIDE that clamp, so the fog tint must
// ALSO be carried at the texture `level` to survive saturation.
//
// These tests are DOM-free: they stub the Babylon material/texture/colour
// constructors and the atlas-texture lookup, then assert that the fogged
// material variant darkens BOTH the diffuse colour AND the texture level, and
// that it does so on a CLONE (the shared bright texture is never mutated).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D, FOG_TILE_DARKEN } from '../src/renderer-3d.js';

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  const r = new Renderer3D(fakeCanvas, {});
  // Minimal Babylon stub — just enough for _terrainMaterialFor to build a
  // StandardMaterial with Color3 fields. No GPU / WebGL needed.
  r._babylon = {
    Color3: class { constructor(x, y, z) { this.r = x; this.g = y; this.b = z; } },
    StandardMaterial: class {
      constructor(name) {
        this.name = name;
        this.diffuseTexture = null;
        this.diffuseColor = null;
        this.specularColor = null;
        this.emissiveColor = { r: 0, g: 0, b: 0 }; // StandardMaterial default
      }
    },
  };
  r._scene = {};
  return r;
}

// A fake atlas texture that records clone() calls and carries a `level`.
function makeFakeTexture(level = 1) {
  const tex = {
    level,
    cloneCount: 0,
    clone() {
      this.cloneCount++;
      return makeFakeTexture(this.level);
    },
  };
  return tex;
}

describe('Renderer3D fog — terrain tile renders darker (texture level, not just diffuse)', () => {
  test('_fogTerrainTextureFor darkens a CLONE; never mutates the bright source', () => {
    const r = makeRenderer();
    const bright = makeFakeTexture(1);

    const fog = r._fogTerrainTextureFor('grass_1', bright);

    assert.ok(fog, 'fog texture clone should be produced');
    assert.notEqual(fog, bright, 'must be a clone, not the shared bright texture');
    assert.equal(bright.cloneCount, 1, 'cloned exactly once');
    assert.equal(bright.level, 1, 'bright source texture level untouched');
    assert.ok(
      Math.abs(fog.level - FOG_TILE_DARKEN) < 1e-9,
      `fog clone level should be the darken factor (got ${fog.level})`,
    );
  });

  test('_fogTerrainTextureFor caches per sprite id (one clone reused)', () => {
    const r = makeRenderer();
    const bright = makeFakeTexture(1);
    const a = r._fogTerrainTextureFor('grass_1', bright);
    const b = r._fogTerrainTextureFor('grass_1', bright);
    assert.equal(a, b, 'same sprite id returns the same cached clone');
    assert.equal(bright.cloneCount, 1, 'only cloned once across repeat calls');
  });

  test('fogged terrain material darkens BOTH diffuseColor and texture level vs the bright variant', () => {
    const r = makeRenderer();
    // Stub the atlas lookup so the textured path runs without a real DOM/atlas.
    r._terrainTextureFor = () => makeFakeTexture(1);

    const bright = r._terrainMaterialFor('grass_1', { fogged: false });
    const fog    = r._terrainMaterialFor('grass_1', { fogged: true });

    // Bright variant: full-strength texture, default white diffuse.
    assert.equal(bright.diffuseTexture.level, 1, 'visible tile texture stays full brightness');

    // Fogged variant: darkened on BOTH axes.
    assert.ok(
      fog.diffuseTexture.level < bright.diffuseTexture.level,
      'fogged texture level must be lower than the visible tile',
    );
    assert.ok(
      Math.abs(fog.diffuseTexture.level - FOG_TILE_DARKEN) < 1e-9,
      'fogged texture level equals the fog darken factor',
    );
    assert.ok(
      fog.diffuseColor.r < 1 && fog.diffuseColor.g < 1 && fog.diffuseColor.b < 1,
      'fogged diffuseColor is also darkened (helps the unsaturated channels)',
    );
  });

  test('fogged terrain material emissive is NOT lifted above the bright variant', () => {
    // The earlier emissive hypothesis: terrain is not self-lit. Lock that the
    // fogged variant never introduces a brightening emissive that would undo
    // the darkening. Both variants keep emissive at the (0,0,0) default.
    const r = makeRenderer();
    r._terrainTextureFor = () => makeFakeTexture(1);

    const bright = r._terrainMaterialFor('grass_1', { fogged: false });
    const fog    = r._terrainMaterialFor('grass_1', { fogged: true });

    const sum = (c) => c.r + c.g + c.b;
    assert.ok(
      sum(fog.emissiveColor) <= sum(bright.emissiveColor) + 1e-9,
      'fogged emissive must not exceed the bright variant (no self-lit re-brightening)',
    );
  });

  test('setFogTint re-levels cached fog textures so already-fogged hexes re-dim live', () => {
    const r = makeRenderer();
    const bright = makeFakeTexture(1);
    const fog = r._fogTerrainTextureFor('grass_1', bright);
    assert.ok(Math.abs(fog.level - FOG_TILE_DARKEN) < 1e-9);

    r.setFogTint(0.3);
    assert.ok(Math.abs(fog.level - 0.3) < 1e-9, 'fog texture level follows the new tint');
  });

  test('setFogTint passes the raw value to the splat plugin (no in-renderer floor)', () => {
    // The admin lighting tuner needs the splat ground to track the full
    // 0..1 slider range — the FOG_HIDDEN_DARKEN floor for in-game readability
    // is applied by `_applyLightConfig`, not by setFogTint itself. Regression
    // for the operator's "Fog tint slider in lighting tool no longer affects
    // fog" report: previously this method clamped splatFog to ≤0.40, which
    // made every slider value from 0.4–1.0 produce the same splat darken.
    const r = makeRenderer();
    const splat = { uFogDarken: 1.0 };
    r._splatPlugin = splat;

    r.setFogTint(0.8);
    assert.equal(splat.uFogDarken, 0.8, 'splat plugin tracks 0.8 unmodified');

    r.setFogTint(0.5);
    assert.equal(splat.uFogDarken, 0.5, 'splat plugin tracks 0.5 unmodified');

    r.setFogTint(0.2);
    assert.equal(splat.uFogDarken, 0.2, 'splat plugin tracks 0.2 unmodified');

    r.setFogTint(1.0);
    assert.equal(splat.uFogDarken, 1.0, 'splat plugin tracks 1.0 (fully bright, no veil)');
  });
});
