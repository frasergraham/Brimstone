// Stage B — the merged splat ground mesh.
//
// With the flag ON, `_buildMap` builds exactly ONE ground mesh with 7 verts
// per tile, plus `aSplat` (3 floats/vert) and `aFog` (1 float/vert) custom
// attributes whose values match `terrain-splat.js`. The flag-OFF path (default)
// is exercised by every other renderer-3d test, which must stay green.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';
import { Tile, TileType } from '../src/tiles.js';
import { hexSplatWeights, splatChannelForTile } from '../src/terrain-splat.js';

// Minimal Babylon mock: records setVerticesData calls + captures geometry.
// Deliberately omits MaterialPluginBase so makeTerrainSplatPlugin → null and
// the material builds without a real shader (the plugin is browser-validated).
function makeFakeBabylon() {
  class Mesh {
    constructor(name) {
      this.name = name;
      this.metadata = null;
      this.material = null;
      this.parent = null;
      this.position = { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } };
      this.receiveShadows = false;
      this._vdata = {};
      this._custom = {};
    }
    setVerticesData(kind, data, updatable, stride) {
      this._custom[kind] = { data, updatable, stride };
    }
    freezeWorldMatrix() { this.isWorldMatrixFrozen = true; }
  }
  class VertexData {
    applyToMesh(mesh) {
      mesh._vdata.positions = this.positions;
      mesh._vdata.indices = this.indices;
      mesh._vdata.normals = this.normals;
    }
  }
  class Color3 { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } }
  class StandardMaterial { constructor(name) { this.name = name; this.specularColor = new Color3(0, 0, 0); } }
  class Texture {
    constructor(url) { this.url = url; this.wrapU = 0; this.wrapV = 0; }
  }
  Texture.WRAP_ADDRESSMODE = 1;
  class TransformNode { constructor(name) { this.name = name; } }
  return { Mesh, VertexData, Color3, StandardMaterial, Texture, TransformNode };
}

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  const r = new Renderer3D(fakeCanvas, {});
  r._babylon = makeFakeBabylon();
  r._scene = {};
  r._setShadowReceiver = () => {};
  // Most tests below assert PLAYABLE-only geometry — stub the border band to
  // zero hexes so the splat ground only contains state.tiles verts. The
  // border-forest extension is exercised by its own dedicated test.
  r._splatBorderBandDepth = () => 0;
  return r;
}

function rectState(cols, rows, typeFn) {
  const tiles = new Map();
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      tiles.set(hexKey(col, row), new Tile(col, row, typeFn ? typeFn(col, row) : TileType.GRASS));
    }
  }
  return { tiles };
}

describe('Renderer3D splat ground — geometry', () => {
  test('flag is ON by default (stage D); 1-line rollback flips it off', () => {
    const r = makeRenderer();
    assert.equal(r._useSplatTerrain, true, 'default flag on after stage D');
    assert.equal(r._splatGround, null, 'no ground until _buildSplatGround runs');
  });

  test('explicit flag OFF builds no splat ground (legacy per-hex path)', () => {
    const r = makeRenderer();
    r._useSplatTerrain = false;
    r._buildTileMesh = () => {};
    r._buildRoadRiverNetworks = () => {};
    r._buildMapBorderForest = () => {};
    r._syncBorderForestVisibility = () => {};
    r._freezeStaticMeshes = () => {};
    r.state = rectState(2, 2);
    r._buildMap();
    assert.equal(r._splatGround, null);
  });

  test('flag ON → one merged ground mesh, 7 verts per tile', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    const cols = 4, rows = 3;
    r.state = rectState(cols, rows);

    const mesh = r._buildSplatGround({ name: 'mapRoot' });
    assert.ok(mesh, 'ground mesh built');
    assert.equal(r._splatGround, mesh);
    assert.equal(mesh.metadata.kind, 'splatGround');

    const tileCount = cols * rows;
    assert.equal(mesh._vdata.positions.length, tileCount * 7 * 3, 'positions = 7 verts/tile × 3');
    assert.equal(mesh._vdata.indices.length, tileCount * 6 * 3, '6 fan triangles/tile × 3');
  });

  test('aSplat + aFog custom attributes present with correct strides', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r.state = rectState(3, 3);
    const mesh = r._buildSplatGround({ name: 'mapRoot' });

    const splat = mesh._custom.aSplat;
    const fog = mesh._custom.aFog;
    assert.ok(splat, 'aSplat attribute set');
    assert.ok(fog, 'aFog attribute set');
    assert.equal(splat.stride, 3);
    assert.equal(fog.stride, 1);
    assert.equal(splat.updatable, false, 'aSplat static');
    assert.equal(fog.updatable, true, 'aFog must be updatable for fog rewrites');

    const tiles = 9;
    assert.equal(splat.data.length, tiles * 7 * 3);
    assert.equal(fog.data.length, tiles * 7);
    // fog initialises to all-unfogged
    assert.ok([...fog.data].every((v) => v === 0));
  });

  test('aSplat values match terrain-splat.js for a mixed map', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    const typeFn = (c, rr) => {
      const t = [TileType.GRASS, TileType.DIRT, TileType.FOREST][(c + rr) % 3];
      return t;
    };
    r.state = rectState(4, 4, typeFn);
    const mesh = r._buildSplatGround({ name: 'mapRoot' });
    const splat = mesh._custom.aSplat.data;

    const channelAt = (col, row) => {
      const t = r.state.tiles.get(hexKey(col, row));
      return t ? splatChannelForTile(t) : null;
    };

    for (const [key, baseV] of r._hexVertexRange) {
      const tile = r.state.tiles.get(key);
      const expected = hexSplatWeights(tile, channelAt);
      for (let i = 0; i < 7 * 3; i++) {
        assert.ok(
          Math.abs(splat[baseV * 3 + i] - expected[i]) < 1e-6,
          `aSplat mismatch at ${key} idx ${i}: ${splat[baseV * 3 + i]} vs ${expected[i]}`,
        );
      }
    }
  });

  test('_hexVertexRange maps every tile to a distinct 7-vertex block', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r.state = rectState(5, 4);
    r._buildSplatGround({ name: 'mapRoot' });
    assert.equal(r._hexVertexRange.size, 20);
    const bases = [...r._hexVertexRange.values()].sort((a, b) => a - b);
    for (let i = 0; i < bases.length; i++) assert.equal(bases[i], i * 7);
  });

  test('_buildMap (flag on) builds the ground via the splat path', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r.state = rectState(3, 3);
    // Stub the heavy per-tile + network builders so we isolate the ground.
    r._buildTileMesh = () => {};
    r._buildRoadRiverNetworks = () => {};
    r._buildMapBorderForest = () => {};
    r._syncBorderForestVisibility = () => {};
    r._freezeStaticMeshes = () => {};
    r._buildMap();
    assert.ok(r._splatGround, 'splat ground built through _buildMap');
    assert.ok(r._mapBuilt);
  });

  test('freeze locks the ground world matrix (not its vertex buffers)', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    r.state = rectState(2, 2);
    r._buildSplatGround({ name: 'mapRoot' });
    const frozen = r._freezeStaticMeshes();
    assert.ok(r._splatGround.isWorldMatrixFrozen, 'world matrix frozen');
    assert.ok(frozen >= 1);
  });
});

describe('Renderer3D splat ground — border-forest extension', () => {
  test('extends the mesh with border-band verts, all forest-channel + edge alpha', () => {
    const r = makeRenderer();
    r._useSplatTerrain = true;
    // Override the stub to add one ring of border hexes around a 2×2 playable area.
    r._splatBorderBandDepth = () => 1;
    r.state = rectState(2, 2);

    const mesh = r._buildSplatGround({ name: 'mapRoot' });
    assert.ok(mesh, 'ground mesh built');

    const playableCount = 4; // 2×2
    const totalVerts = mesh._vdata.positions.length / 3;
    assert.ok(totalVerts > playableCount * 7,
      `border verts added: got ${totalVerts}, expected > ${playableCount * 7}`);
    assert.ok(totalVerts % 7 === 0, 'still 7 verts per hex');

    // aEdgeAlpha attribute is present and stride-1; playable verts = 1.0.
    const edge = mesh._custom.aEdgeAlpha;
    assert.ok(edge, 'aEdgeAlpha attribute set');
    assert.equal(edge.stride, 1);
    assert.equal(edge.updatable, false, 'aEdgeAlpha is static');
    assert.equal(edge.data.length, totalVerts);

    // Every playable vert (the first 4×7 = 28) carries alpha=1.
    for (let v = 0; v < playableCount * 7; v++) {
      assert.equal(edge.data[v], 1.0, `playable vert ${v} should be opaque`);
    }
    // At least one border vert has alpha < 1 (the dissolve).
    let foundFade = false;
    for (let v = playableCount * 7; v < totalVerts; v++) {
      if (edge.data[v] < 1) { foundFade = true; break; }
    }
    assert.ok(foundFade, 'at least one border vert has alpha < 1');

    // Border splat weights are uniformly forest channel (0, 0, 1).
    const splat = mesh._custom.aSplat.data;
    for (let v = playableCount * 7; v < totalVerts; v++) {
      assert.equal(splat[v * 3 + 0], 0, `border vert ${v} grass weight = 0`);
      assert.equal(splat[v * 3 + 1], 0, `border vert ${v} dirt  weight = 0`);
      assert.equal(splat[v * 3 + 2], 1, `border vert ${v} forest weight = 1`);
    }
  });
});
