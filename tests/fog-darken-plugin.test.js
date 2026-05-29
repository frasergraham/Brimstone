// FogDarkenPlugin — the third (uniform-array) attempt at darkening GLB
// buildings on fogged hexes. The prior two attempts (per-instance attribute /
// GLB→box swap) were reverted; this one carries the fogged-tile XZ centres in a
// GLOBAL uniform array so Babylon's instancing pipeline can't drop the data.
//
// Shader correctness can't be proven by node tests (no GPU) — that lives in the
// browser pixel-sampling check. These tests pin the JS contract: the pure
// fogged-building list helper, the plugin's uniform/GLSL shape, the attach
// helper's recursion + idempotency, and the renderer's uniform fan-out.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeFogDarkenPlugin,
  attachFogDarkenToMaterial,
  MAX_FOG_TILES,
  FOG_BUILDING_DARKEN_DEFAULT,
  FOG_BUILDING_RADIUS_DEFAULT,
} from '../src/fog-darken-plugin.js';
import {
  Renderer3D,
  buildFoggedBuildingTileList,
  hexToWorld,
  TILE_SLOTS,
  BUILDING_SLOT_INDEX,
  FOG_HIDDEN_DARKEN,
} from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';

// ── Minimal fake Babylon exposing just enough of MaterialPluginBase ──────────
class FakeMaterialPluginBase {
  constructor(material, name, priority, defines) {
    this._material = material;
    this.name = name;
    this.priority = priority;
    this._defines = defines;
  }
  _enable() { /* registration is a no-op in the stub */ }
}
const FakeBABYLON = {
  MaterialPluginBase: FakeMaterialPluginBase,
  Material: { AllDirtyFlag: 0x7fffffff },
};

function buildingTile(col, row, footprintHexes = []) {
  return { col, row, building: 'inn', structure: 'building', footprintHexes };
}
function footprintTile(col, row, entranceKey) {
  return { col, row, building: null, buildingFootprintOf: entranceKey };
}
function orphanBuildingTile(col, row) {
  return { col, row, building: 'inn', structure: 'building', footprintHexes: [] };
}
function plainTile(col, row) {
  return { col, row, building: null };
}

describe('buildFoggedBuildingTileList', () => {
  test('modern compound: emits the nudged footprint→entrance midpoint when the FOOTPRINT hex is fogged', async () => {
    const { buildingNudgedPosition, BUILDING_ENTRANCE_NUDGE } =
      await import('../src/building-render.js');
    const tiles = new Map();
    // Entrance at (2,2), footprint at (3,2). Footprint is fogged; the building
    // should appear at the nudged position lerped 15% toward (2,2).
    const fpKey = hexKey(3, 2);
    tiles.set(hexKey(2, 2), buildingTile(2, 2, [fpKey]));
    tiles.set(fpKey, footprintTile(3, 2, hexKey(2, 2)));
    const state = { tiles };
    const fogged = new Set([fpKey]);

    const list = buildFoggedBuildingTileList(state, fogged);
    assert.equal(list.length, 1, 'one fogged building');

    const eW = hexToWorld(2, 2);
    const fW = hexToWorld(3, 2);
    const expected = buildingNudgedPosition(fW, eW, BUILDING_ENTRANCE_NUDGE);
    assert.ok(Math.abs(list[0].x - expected.x) < 1e-9, `x ${list[0].x} != ${expected.x}`);
    assert.ok(Math.abs(list[0].z - expected.z) < 1e-9, `z ${list[0].z} != ${expected.z}`);
  });

  test('modern compound: entrance-fogged but FOOTPRINT not fogged → excluded (the building is visibly on the unfogged hex)', () => {
    const tiles = new Map();
    const fpKey = hexKey(3, 2);
    tiles.set(hexKey(2, 2), buildingTile(2, 2, [fpKey]));
    tiles.set(fpKey, footprintTile(3, 2, hexKey(2, 2)));
    // Only the entrance is fogged. The building visual sits on (3,2) which is
    // not fogged, so it shouldn't darken.
    const fogged = new Set([hexKey(2, 2)]);
    assert.deepEqual(buildFoggedBuildingTileList({ tiles }, fogged), []);
  });

  test('legacy orphan: still uses entrance + NE-slot position (prod-compatible)', () => {
    const tiles = new Map();
    tiles.set(hexKey(2, 2), orphanBuildingTile(2, 2));
    tiles.set(hexKey(2, 4), plainTile(2, 4));
    const fogged = new Set([hexKey(2, 2), hexKey(2, 4)]);

    const list = buildFoggedBuildingTileList({ tiles }, fogged);
    assert.equal(list.length, 1);

    const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
    const { x, z } = hexToWorld(2, 2);
    assert.ok(Math.abs(list[0].x - (x + slot.x)) < 1e-9);
    assert.ok(Math.abs(list[0].z - (z + slot.z)) < 1e-9);
  });

  test('empty when nothing fogged or no state', () => {
    const tiles = new Map([[hexKey(1, 1), orphanBuildingTile(1, 1)]]);
    assert.deepEqual(buildFoggedBuildingTileList({ tiles }, new Set()), []);
    assert.deepEqual(buildFoggedBuildingTileList(null, new Set([hexKey(1, 1)])), []);
    assert.deepEqual(buildFoggedBuildingTileList({ tiles }, null), []);
  });
});

describe('makeFogDarkenPlugin', () => {
  test('null without a usable MaterialPluginBase', () => {
    assert.equal(makeFogDarkenPlugin(null), null);
    assert.equal(makeFogDarkenPlugin({}), null);
  });

  test('constructs with sentinel-filled uniform defaults', () => {
    const Plugin = makeFogDarkenPlugin(FakeBABYLON);
    const p = new Plugin({});
    assert.equal(p.getClassName(), 'FogDarkenPlugin');
    assert.equal(p.fogTiles.length, MAX_FOG_TILES * 2);
    assert.ok([...p.fogTiles].every((v) => v === 1e8), 'all slots park at far sentinel');
    assert.equal(p.fogCount, 0);
    assert.equal(p.fogDarkenAmount, FOG_BUILDING_DARKEN_DEFAULT);
    assert.equal(p.fogTileRadius, FOG_BUILDING_RADIUS_DEFAULT);
  });

  test('prepareDefines gates FOG_DARKEN on enable state', () => {
    const Plugin = makeFogDarkenPlugin(FakeBABYLON);
    const p = new Plugin({});
    const defines = {};
    p.prepareDefines(defines);
    assert.equal(defines.FOG_DARKEN, false);
    p.isEnabled = true;
    p.prepareDefines(defines);
    assert.equal(defines.FOG_DARKEN, true);
  });

  test('getUniforms declares the vec2 array + scalars (ubo + fragment GLSL)', () => {
    const Plugin = makeFogDarkenPlugin(FakeBABYLON);
    const u = new Plugin({}).getUniforms();
    const arr = u.ubo.find((e) => e.name === 'fogTiles');
    assert.equal(arr.size, 2);
    assert.equal(arr.arraySize, MAX_FOG_TILES);
    assert.ok(u.ubo.some((e) => e.name === 'fogCount'));
    assert.ok(u.ubo.some((e) => e.name === 'fogDarkenAmount'));
    assert.ok(u.ubo.some((e) => e.name === 'fogTileRadius'));
    assert.match(u.fragment, /uniform vec2 fogTiles\[MAX_FOG_TILES\]/);
    assert.match(u.fragment, new RegExp(`#define MAX_FOG_TILES ${MAX_FOG_TILES}`));
  });

  test('getCustomCode injects worldXZ varying (vertex) + final-color multiply (fragment)', () => {
    const Plugin = makeFogDarkenPlugin(FakeBABYLON);
    const p = new Plugin({});
    const v = p.getCustomCode('vertex');
    assert.match(v.CUSTOM_VERTEX_MAIN_END, /vFogWorldXZ\s*=\s*worldPos\.xz/);
    const f = p.getCustomCode('fragment');
    // Final post-lighting hook — outside the lighting clamp, universal to
    // Standard + PBR (the reason the dim survives bright phases).
    assert.match(f.CUSTOM_FRAGMENT_MAIN_END, /gl_FragColor\.rgb\s*\*=\s*mix\(1\.0,\s*fogDarkenAmount/);
    assert.match(f.CUSTOM_FRAGMENT_MAIN_END, /for \(int i = 0; i < MAX_FOG_TILES/);
  });

  test('bindForSubMesh writes all uniforms when enabled, nothing when disabled', () => {
    const Plugin = makeFogDarkenPlugin(FakeBABYLON);
    const p = new Plugin({});
    const calls = { arrays: [], floats: {} };
    const ubo = {
      updateArray(name, data) { calls.arrays.push([name, data]); },
      updateFloat(name, v) { calls.floats[name] = v; },
    };
    p.bindForSubMesh(ubo);
    assert.deepEqual(calls.arrays, [], 'disabled → no writes');

    p.isEnabled = true;
    p.fogCount = 3;
    p.bindForSubMesh(ubo);
    assert.equal(calls.arrays[0][0], 'fogTiles');
    assert.equal(calls.arrays[0][1].length, MAX_FOG_TILES * 2);
    assert.equal(calls.floats.fogCount, 3);
    assert.equal(calls.floats.fogDarkenAmount, FOG_BUILDING_DARKEN_DEFAULT);
    assert.equal(calls.floats.fogTileRadius, FOG_BUILDING_RADIUS_DEFAULT);
  });
});

describe('attachFogDarkenToMaterial', () => {
  test('attaches an enabled plugin to a plain material', () => {
    const mat = {};
    const plugins = attachFogDarkenToMaterial(FakeBABYLON, mat);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].isEnabled, true);
  });

  test('recurses into MultiMaterial.subMaterials', () => {
    const multi = { subMaterials: [{}, {}, {}] };
    const plugins = attachFogDarkenToMaterial(FakeBABYLON, multi);
    assert.equal(plugins.length, 3);
  });

  test('idempotent — returns the existing plugin instead of double-attaching', () => {
    const existing = { name: 'FogDarken' };
    const mat = { pluginManager: { _plugins: [existing] } };
    const plugins = attachFogDarkenToMaterial(FakeBABYLON, mat);
    assert.deepEqual(plugins, [existing]);
  });

  test('empty array without MaterialPluginBase', () => {
    assert.deepEqual(attachFogDarkenToMaterial({}, {}), []);
    assert.deepEqual(attachFogDarkenToMaterial(FakeBABYLON, null), []);
  });
});

describe('Renderer3D._updateBuildingFogUniform', () => {
  function makeRenderer() {
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    return new Renderer3D(fakeCanvas, {});
  }
  function fakePlugin() {
    return { fogTiles: new Float32Array(MAX_FOG_TILES * 2).fill(1e8), fogCount: 0 };
  }

  test('fans the fogged-building centres into every attached plugin', () => {
    const r = makeRenderer();
    const tiles = new Map([
      [hexKey(2, 2), buildingTile(2, 2)],
      [hexKey(4, 4), buildingTile(4, 4)],
    ]);
    r.state = { tiles };
    r._fogActiveSet = new Set([hexKey(2, 2)]);
    const p = fakePlugin();
    r._buildingFogPlugins.add(p);

    r._updateBuildingFogUniform();

    assert.equal(p.fogCount, 1);
    const slot = TILE_SLOTS[BUILDING_SLOT_INDEX];
    const { x, z } = hexToWorld(2, 2);
    // Float32Array storage → compare at float32 precision.
    assert.ok(Math.abs(p.fogTiles[0] - (x + slot.x)) < 1e-4);
    assert.ok(Math.abs(p.fogTiles[1] - (z + slot.z)) < 1e-4);
    // Slot 1 onward stays at the sentinel.
    assert.equal(p.fogTiles[2], 1e8);
  });

  test('unfogging clears the count and re-parks the slot at the sentinel', () => {
    const r = makeRenderer();
    r.state = { tiles: new Map([[hexKey(2, 2), buildingTile(2, 2)]]) };
    const p = fakePlugin();
    r._buildingFogPlugins.add(p);

    r._fogActiveSet = new Set([hexKey(2, 2)]);
    r._updateBuildingFogUniform();
    assert.equal(p.fogCount, 1);

    r._fogActiveSet = new Set();
    r._updateBuildingFogUniform();
    assert.equal(p.fogCount, 0);
    assert.equal(p.fogTiles[0], 1e8);
    assert.equal(p.fogTiles[1], 1e8);
  });

  test('caps at MAX_FOG_TILES without overflowing the buffer', () => {
    const r = makeRenderer();
    const tiles = new Map();
    const fogged = new Set();
    for (let i = 0; i < MAX_FOG_TILES + 5; i++) {
      const k = hexKey(i, 1);
      tiles.set(k, buildingTile(i, 1));
      fogged.add(k);
    }
    r.state = { tiles };
    r._fogActiveSet = fogged;
    const p = fakePlugin();
    r._buildingFogPlugins.add(p);

    r._updateBuildingFogUniform();
    assert.equal(p.fogCount, MAX_FOG_TILES);
    assert.equal(p.fogTiles.length, MAX_FOG_TILES * 2);
  });

  test('FOG_HIDDEN_DARKEN is the attached-plugin darken floor', () => {
    // Documents the intended coupling: the renderer seeds plugin.fogDarkenAmount
    // from FOG_HIDDEN_DARKEN so a fogged building matches the ground veil floor.
    assert.equal(FOG_BUILDING_DARKEN_DEFAULT, FOG_HIDDEN_DARKEN);
  });
});
