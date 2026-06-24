// Stage C — splat-terrain fog migration.
//
// With the flag ON, `_applyFogVeil` rewrites the merged ground's `aFog` vertex
// attribute once (via `_writeFogWeights`) instead of swapping per-tile
// materials, and hides/darkens props via `_setTilePropsFogged`. Existing
// (flag-off) fog behaviour is unchanged.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';
import { hexFogWeights, neighborDeltas } from '../src/terrain-splat.js';

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  return new Renderer3D(fakeCanvas, {});
}

// Stand up the minimum splat-ground state `_writeFogWeights` needs: a fog
// buffer, a vertex-range map, a stub ground mesh that records updateVerticesData.
function withSplatGround(r, tileKeys) {
  const buf = new Float32Array(tileKeys.length * 13);
  const range = new Map();
  tileKeys.forEach((k, i) => range.set(k, i * 13));
  const updates = [];
  r._splatFogBuf = buf;
  r._hexVertexRange = range;
  r._splatGround = {
    updateVerticesData(kind, data) { updates.push({ kind, data: data.slice() }); },
  };
  return { buf, range, updates };
}

function tilesFrom(keys) {
  const tiles = new Map();
  for (const k of keys) {
    const [c, rr] = k.split(',').map(Number);
    tiles.set(k, { col: c, row: rr });
  }
  return tiles;
}

describe('Renderer3D splat fog — _writeFogWeights', () => {
  test('rewrites aFog per hex from hexFogWeights and pushes one update', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    const keys = [];
    for (let row = 1; row <= 3; row++) for (let col = 1; col <= 3; col++) keys.push(hexKey(col, row));
    r.state = { tiles: tilesFrom(keys) };
    const { buf, range, updates } = withSplatGround(r, keys);

    const fogged = new Set(['2,2']);
    r._writeFogWeights(fogged);

    assert.equal(updates.length, 1, 'one updateVerticesData call');
    assert.equal(updates[0].kind, 'aFog');

    // Spot-check: the slice for 2,2 matches hexFogWeights with present-neighbour keys.
    const baseV = range.get('2,2');
    const nKeys = neighborDeltas(2).map(([dc, dr]) => {
      const nk = hexKey(2 + dc, 2 + dr);
      return r.state.tiles.has(nk) ? nk : null;
    });
    const expected = hexFogWeights('2,2', nKeys, fogged);
    for (let v = 0; v < 7; v++) {
      assert.ok(Math.abs(buf[baseV + v] - expected[v]) < 1e-6, `vertex ${v}`);
    }
    // centre of 2,2 fully fogged
    assert.equal(buf[baseV], 1);
  });

  test('no-op without a ground / buffer (node-test, flag off)', () => {
    const r = makeRenderer();
    // nothing set up — must not throw
    assert.doesNotThrow(() => r._writeFogWeights(new Set(['0,0'])));
  });
});

describe('Renderer3D splat fog — _setTilePropsFogged', () => {
  test('hides tactical props, skips permanent geometry, tracks _fogActiveSet', () => {
    const r = makeRenderer();
    const hexK = '4,4';
    const tree = { isVisible: true, metadata: { respectsFog: false } };
    const disc = { isVisible: true };
    r._tilePropsByKey.set(hexK, [tree, disc]);

    r._setTilePropsFogged(hexK, true);
    assert.equal(tree.isVisible, true, 'permanent geometry stays visible');
    assert.equal(disc.isVisible, false, 'tactical prop hidden');
    assert.ok(r._fogActiveSet.has(hexK));

    r._setTilePropsFogged(hexK, false);
    assert.equal(disc.isVisible, true, 'tactical prop revealed');
    assert.ok(!r._fogActiveSet.has(hexK));
  });

  test('GLB buildings (respectsFog:false) are left untouched by the prop loop', () => {
    // GLB buildings darken via their own per-building material tint
    // (`_applyBuildingFogDarken`), NOT the per-prop veil loop. So building meshes
    // carry `respectsFog: false`, and `_setTilePropsFogged` must neither hide nor
    // mutate them. (The darkening itself is covered below.)
    const r = makeRenderer();
    const hexK = '6,2';
    const bldg = {
      isVisible: true,
      material: { diffuseColor: { r: 1, g: 1, b: 1 } },
      metadata: { respectsFog: false, kind: 'building-glb' },
    };
    r._tilePropsByKey.set(hexK, [bldg]);
    r._setTilePropsFogged(hexK, true);
    assert.equal(bldg.isVisible, true, 'building stays visible under fog');
    assert.equal(bldg.material.diffuseColor.r, 1, 'prop loop does not mutate it');
    assert.ok(r._fogActiveSet.has(hexK), 'tile still tracked as fogged');
  });

  test("'darken' props tint to FOG_HIDDEN_DARKEN cap on both texture level + colour", async () => {
    // Fog darken on roads/rivers must hit the TEXTURE level (outside the
    // lighting clamp) so it survives bright phases — same fix the terrain
    // fog veil relies on. And it clamps to FOG_HIDDEN_DARKEN so the ribbon
    // reads as "occluded" not "lightly tinted".
    const { FOG_HIDDEN_DARKEN } = await import('../src/renderer-3d.js');
    const r = makeRenderer();
    r._fogTileDarken = 0.7; // mild phase value — should clamp down to the cap
    const hexK = '5,5';
    const road = {
      isVisible: true,
      material: {
        diffuseColor: { r: 1, g: 1, b: 1 },
        diffuseTexture: { level: 1 },
      },
      metadata: { respectsFog: 'darken', baseDiffuse: { r: 1, g: 1, b: 1 } },
    };
    r._tilePropsByKey.set(hexK, [road]);
    r._setTilePropsFogged(hexK, true);
    assert.equal(road.isVisible, true, 'road stays visible under fog');
    assert.equal(road.material.diffuseTexture.level, FOG_HIDDEN_DARKEN,
      'texture level darkened past the lighting clamp');
    assert.equal(road.material.diffuseColor.r, FOG_HIDDEN_DARKEN,
      'diffuse colour darkened too (belt-and-braces for texture-less mats)');
    r._setTilePropsFogged(hexK, false);
    assert.equal(road.material.diffuseTexture.level, 1, 'level restored on un-fog');
    assert.equal(road.material.diffuseColor.r, 1.0, 'colour restored on un-fog');
  });
});

describe('Renderer3D building fog — _applyBuildingFogDarken', () => {
  function bldg(fogHexKey, mat) {
    return { metadata: { kind: 'building-glb', respectsFog: false, fogHexKey }, material: mat,
      isDisposed: () => false };
  }

  test('PBR building on a fogged hex darkens albedo+emissive to FOG_HIDDEN_DARKEN; visible one untouched', async () => {
    const { FOG_HIDDEN_DARKEN } = await import('../src/renderer-3d.js');
    const r = makeRenderer();
    const fogged  = bldg('3,3', { albedoColor: { r: 1, g: 0.8, b: 0.6 }, emissiveColor: { r: 0.2, g: 0.2, b: 0.2 } });
    const visible = bldg('9,9', { albedoColor: { r: 1, g: 0.8, b: 0.6 } });
    r._buildingMeshes.add(fogged);
    r._buildingMeshes.add(visible);
    r._fogActiveSet = new Set(['3,3']);

    r._applyBuildingFogDarken();

    assert.ok(Math.abs(fogged.material.albedoColor.r - 1 * FOG_HIDDEN_DARKEN) < 1e-9, 'albedo r darkened');
    assert.ok(Math.abs(fogged.material.albedoColor.g - 0.8 * FOG_HIDDEN_DARKEN) < 1e-9, 'albedo g darkened');
    assert.ok(Math.abs(fogged.material.emissiveColor.r - 0.2 * FOG_HIDDEN_DARKEN) < 1e-9, 'emissive darkened');
    assert.equal(visible.material.albedoColor.r, 1, 'visible building unchanged');
  });

  test('Standard building darkens diffuseColor and restores exactly on un-fog (idempotent)', () => {
    const r = makeRenderer();
    const b = bldg('2,2', { diffuseColor: { r: 0.9, g: 0.7, b: 0.5 } });
    r._buildingMeshes.add(b);

    r._fogActiveSet = new Set(['2,2']);
    r._applyBuildingFogDarken();
    r._applyBuildingFogDarken(); // re-apply must not compound
    const k = 0.40;
    assert.ok(Math.abs(b.material.diffuseColor.r - 0.9 * k) < 1e-9, 'no compounding on re-apply');

    r._fogActiveSet = new Set(); // un-fog
    r._applyBuildingFogDarken();
    assert.ok(Math.abs(b.material.diffuseColor.r - 0.9) < 1e-9, 'restored to base');
    assert.ok(Math.abs(b.material.diffuseColor.g - 0.7) < 1e-9, 'restored to base g');
  });

  test('MultiMaterial building tints every sub-material', () => {
    const r = makeRenderer();
    const sub0 = { albedoColor: { r: 1, g: 1, b: 1 } };
    const sub1 = { diffuseColor: { r: 0.6, g: 0.6, b: 0.6 } };
    const b = bldg('4,4', { subMaterials: [sub0, sub1] });
    r._buildingMeshes.add(b);
    r._fogActiveSet = new Set(['4,4']);

    r._applyBuildingFogDarken();
    assert.ok(Math.abs(sub0.albedoColor.r - 0.40) < 1e-9, 'sub0 darkened');
    assert.ok(Math.abs(sub1.diffuseColor.r - 0.6 * 0.40) < 1e-9, 'sub1 darkened');
  });

  test('disposed building is dropped from the tracking set', () => {
    const r = makeRenderer();
    const b = bldg('1,1', { diffuseColor: { r: 1, g: 1, b: 1 } });
    b.isDisposed = () => true;
    r._buildingMeshes.add(b);
    r._applyBuildingFogDarken();
    assert.equal(r._buildingMeshes.size, 0, 'disposed mesh pruned');
  });
});

describe('Renderer3D splat fog — _applyFogVeil integration', () => {
  test('flag on routes through _writeFogWeights + _setTilePropsFogged', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r._scene = {};
    const keys = ['1,1', '2,1', '1,2', '2,2'];
    r.state = { tiles: tilesFrom(keys), fogOfWar: 'standard' };
    withSplatGround(r, keys);

    // Force a known fogged set by stubbing the observer-derived computation.
    r._observerOwner = () => 'hero';
    r._buildFogVisibleHexes = () => new Set(['1,1', '2,1']); // 1,2 & 2,2 fogged

    let wrote = false;
    const realWrite = r._writeFogWeights.bind(r);
    r._writeFogWeights = (fogged) => { wrote = true; realWrite(fogged); };

    r._applyFogVeil();
    assert.ok(wrote, '_writeFogWeights invoked');
    assert.ok(r._fogActiveSet.has('1,2') && r._fogActiveSet.has('2,2'));
    assert.ok(!r._fogActiveSet.has('1,1'));
  });

  test('_applyLightConfig floors fogTint to FOG_HIDDEN_DARKEN before handing it to setFogTint', async () => {
    // In-game readability rule: even when a phase config carries a mild
    // fogTint like dawn's 0.70, the splat ground must read as a clear
    // "occluded vision" patch — never a thin atmospheric haze. The floor at
    // FOG_HIDDEN_DARKEN lives in `_applyLightConfig` so that the admin
    // lighting tuner (which calls `setFogTint` directly) keeps full
    // slider range, while the live game's phase apply still floors.
    const { FOG_HIDDEN_DARKEN } = await import('../src/renderer-3d.js');
    const r = makeRenderer();
    r._babylon = {
      Color3: class { constructor(x, y, z) { this.r = x; this.g = y; this.b = z; } },
      Color4: class { constructor(x, y, z, w) { this.r = x; this.g = y; this.b = z; this.a = w; } },
      Vector3: class { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    };
    r._light = { intensity: 0, diffuse: null, specular: null, groundColor: null };
    r._scene = { clearColor: null, fogColor: null, ambientColor: null };
    r._sunLight = { direction: null, intensity: 0 };
    r._lightState = { sun: { dir: {} } };
    r._splatPlugin = { uFogDarken: 1.0 };
    r.state = { round: 1, phase: 'dawn' };

    // A mild phase value (>0.40) must be floored to FOG_HIDDEN_DARKEN.
    r._applyLightConfig({
      intensity: 1.0,
      color: { r: 1, g: 1, b: 1 },
      clear: { r: 0, g: 0, b: 0 },
      ambient: { r: 0, g: 0, b: 0 },
      fogTint: 0.70,
      sun: { dir: { x: 0, y: -1, z: 0 }, intensity: 1.0 },
    });
    assert.equal(r._splatPlugin.uFogDarken, FOG_HIDDEN_DARKEN,
      'phase fogTint 0.70 floors to FOG_HIDDEN_DARKEN for in-game readability');

    // A value below the floor passes through unchanged.
    r._applyLightConfig({
      intensity: 1.0,
      color: { r: 1, g: 1, b: 1 },
      clear: { r: 0, g: 0, b: 0 },
      ambient: { r: 0, g: 0, b: 0 },
      fogTint: 0.20,
      sun: { dir: { x: 0, y: -1, z: 0 }, intensity: 1.0 },
    });
    assert.equal(r._splatPlugin.uFogDarken, 0.20,
      'phase fogTint 0.20 is below the floor — pass through unchanged');
  });

  test('setFogTint drives the plugin uFogDarken with the raw value (in-game floor lives in _applyLightConfig)', () => {
    // The splat plugin tracks the raw fog tint through `setFogTint` — full
    // 0..1 range — so the admin lighting tuner sees the slider take effect
    // across its whole travel. The in-game readability floor at
    // FOG_HIDDEN_DARKEN is applied by `_applyLightConfig` (the caller that
    // hands phase-config values to setFogTint), not inside setFogTint itself.
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r._splatPlugin = { uFogDarken: 1.0 };
    r._scene = null; // setFogTint guards _applyFogVeil on _scene
    // A mild golden-hour fog value passes through unmodified.
    r.setFogTint(0.7);
    assert.equal(r._splatPlugin.uFogDarken, 0.7);
    assert.equal(r._fogTileDarken, 0.7, 'raw phase value preserved');
    // Lower values also pass through.
    r.setFogTint(0.1);
    assert.equal(r._splatPlugin.uFogDarken, 0.1);
  });
});
