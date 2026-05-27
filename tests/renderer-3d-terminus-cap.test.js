// Integration test for the rounded, fading ROAD terminus cap.
//
// A 1-neighbour road stub dead-ends at its tile centre. `_buildNetworkMesh`
// rounds that end into a semicircle (the ribbon half-width tapers to 0) and
// fades its alpha to 0 at the tip so the road dissolves into the ground
// instead of stopping in a hard rectangle. River termini flow off-map (border
// extension) and keep their square end — verified here too.
//
// Babylon + WebGL can't run in node-test, so we drive `_buildNetworkMesh`
// through a stubbed Babylon that records each CreateRibbon's `pathArray` and
// the per-vertex colour buffer the builder writes. The cap's signature:
//   • the CENTRE path (always opaque on a normal ribbon) carries an alpha-0
//     vertex at the cap tip and an alpha-1 vertex in the road body;
//   • the inner offset paths collapse onto the centreline at the tip
//     (half-width → 0), tracing the semicircle.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D, TERMINUS_CAP_SEGMENTS } from '../src/renderer-3d.js';
import { TileType, Tile } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';

// Stubbed Babylon that records every ribbon's pathArray + colour buffer.
function makeStubBabylon(created) {
  const makeMesh = (name, vertexCount = 0, pathArray = null) => ({
    name, pathArray,
    position: { set() {} }, rotation: {}, scaling: {},
    parent: null, material: null, metadata: undefined,
    isPickable: true, alphaIndex: undefined,
    receiveShadows: false, hasVertexAlpha: false,
    _vertexCount: vertexCount, _vertexData: new Map(),
    getTotalVertices() { return this._vertexCount; },
    setVerticesData(kind, data) { this._vertexData.set(kind, data); },
    setEnabled() {}, dispose() {},
  });
  return {
    MeshBuilder: {
      CreateRibbon: (name, opts) => {
        let n = 0;
        if (opts && Array.isArray(opts.pathArray) && opts.pathArray.length > 0) {
          n = opts.pathArray.length * (opts.pathArray[0].length || 0);
        }
        const m = makeMesh(name, n, opts.pathArray);
        created.push(m);
        return m;
      },
    },
    Mesh: {
      DOUBLESIDE: 2,
      // Merge just returns a fresh mesh; the per-ribbon colour buffers we
      // assert on are written BEFORE the merge, so we don't need the merge to
      // preserve them.
      MergeMeshes: () => makeMesh('merged', 0, null),
    },
    StandardMaterial: function (name) {
      this.name = name;
      this.diffuseColor = { clone: () => ({}) };
      this.emissiveColor = { clone: () => ({}) };
      this.specularColor = null;
      this.backFaceCulling = true;
      this.disableLighting = false;
      this.clone = (n) => {
        const c = { name: n, diffuseColor: null, emissiveColor: null };
        return c;
      };
    },
    Color3: function (r, g, b) {
      this.r = r; this.g = g; this.b = b;
      this.clone = () => ({ r: this.r, g: this.g, b: this.b, clone() { return { ...this }; } });
    },
    Vector3: function (x, y, z) { this.x = x; this.y = y; this.z = z; },
    VertexBuffer: { ColorKind: 'color', UVKind: 'uv' },
  };
}

// Straight 3-tile road A–B–C along a row. A and C have ONE road neighbour each
// (termini); B has two (a through-tile, no terminus).
function makeRoadLine() {
  const tiles = new Map();
  const mk = (col, dirs) => {
    const t = new Tile(col, 0, TileType.ROAD);
    t.roadDirs = new Set(dirs);
    tiles.set(hexKey(col, 0), t);
  };
  mk(0, [hexKey(1, 0)]);                 // A: terminus
  mk(1, [hexKey(0, 0), hexKey(2, 0)]);   // B: through
  mk(2, [hexKey(1, 0)]);                 // C: terminus
  return tiles;
}

function newInst() {
  const r = new Renderer3D({ parentElement: null, width: 800, height: 600, addEventListener() {} }, {});
  r._scene = {};
  r._mapRoot = { name: 'mapRoot' };
  r._tilePropsByKey = new Map();
  return r;
}

// Pull the per-vertex alpha of the CENTRE path (path index 2 of 5) for a ribbon.
function centrePathAlphas(mesh) {
  const colors = mesh._vertexData.get('color');
  const total = mesh._vertexCount;
  const N = total / 5;            // 5 paths
  const out = [];
  for (let k = 0; k < N; k++) {
    const v = 2 * N + k;          // centre path vertices
    out.push(colors[v * 4 + 3]);
  }
  return out;
}

describe('road terminus cap — _buildNetworkMesh integration', () => {
  test('terminus ribbon fades its centre path to alpha 0 at the tip', () => {
    const created = [];
    const r = newInst();
    r._babylon = makeStubBabylon(created);
    r.state = { tiles: makeRoadLine() };

    r._buildRoadRiverNetworks();

    // Terminus tile A = stroke "road_0_0_0"; through tile B = "road_1_0_0".
    const termA = created.find(m => m.name === 'road_0_0_0');
    const through = created.find(m => m.name === 'road_1_0_0');
    assert.ok(termA, 'expected a ribbon for terminus tile A');
    assert.ok(through, 'expected a ribbon for through tile B');

    const aAlphas = centrePathAlphas(termA);
    const bAlphas = centrePathAlphas(through);

    // Cap tip is the FIRST centre-path vertex (cap samples prepended): alpha 0.
    assert.ok(Math.abs(aAlphas[0]) < 1e-9,
      `terminus centre path should start transparent, got ${aAlphas[0]}`);
    // Road body end stays fully opaque on the centre path.
    assert.ok(Math.abs(aAlphas[aAlphas.length - 1] - 1) < 1e-9,
      `terminus centre path should end opaque, got ${aAlphas[aAlphas.length - 1]}`);
    // The through-tile centre path is opaque at EVERY vertex (no cap fade).
    for (const a of bAlphas) {
      assert.ok(Math.abs(a - 1) < 1e-9, `through-tile centre path should be opaque, got ${a}`);
    }
  });

  test('terminus ribbon adds TERMINUS_CAP_SEGMENTS extra samples (semicircle)', () => {
    const created = [];
    const r = newInst();
    r._babylon = makeStubBabylon(created);
    r.state = { tiles: makeRoadLine() };
    r._buildRoadRiverNetworks();

    const termA = created.find(m => m.name === 'road_0_0_0');
    const through = created.find(m => m.name === 'road_1_0_0');
    // Raw road stub is 2 points; cap prepends TERMINUS_CAP_SEGMENTS more.
    const nA = termA.pathArray[0].length;
    assert.equal(nA, 2 + TERMINUS_CAP_SEGMENTS,
      `terminus stroke should have ${2 + TERMINUS_CAP_SEGMENTS} samples`);

    // At the cap tip (first sample), the two inner offset paths collapse onto
    // the centreline — half-width tapered to 0 → semicircle point.
    const [rightOuter, rightInner, centre, leftInner] = termA.pathArray;
    const dInnerTip = Math.hypot(rightInner[0].x - leftInner[0].x, rightInner[0].z - leftInner[0].z);
    const dInnerBody = Math.hypot(
      rightInner[nA - 1].x - leftInner[nA - 1].x,
      rightInner[nA - 1].z - leftInner[nA - 1].z);
    assert.ok(dInnerTip < 1e-9, `inner paths should meet at the cap tip, gap ${dInnerTip}`);
    assert.ok(dInnerBody > 0.1, `inner paths should be full width in the body, gap ${dInnerBody}`);

    // Through-tile keeps the raw bezier sample count (no cap prepended).
    assert.ok(through.pathArray[0].length > 2);
  });

  test('river termini are NOT capped (no extra samples on a 1-neighbour river)', () => {
    const created = [];
    const r = newInst();
    // River line A–B–C: endpoints have one water neighbour.
    const tiles = new Map();
    for (let c = 0; c < 3; c++) {
      const t = new Tile(c, 0, TileType.RIVER);
      t.roadDirs = new Set();
      tiles.set(hexKey(c, 0), t);
    }
    r._babylon = makeStubBabylon(created);
    r.state = { tiles };
    r._buildRoadRiverNetworks();

    const riverEnd = created.find(m => m.name === 'river_0_0_0');
    assert.ok(riverEnd, 'expected a river ribbon for the endpoint tile');
    // River 1-neighbour stroke is the off-tile through-bezier — its centre path
    // is opaque at every vertex (no terminus fade).
    for (const a of centrePathAlphas(riverEnd)) {
      assert.ok(Math.abs(a - 1) < 1e-9, `river terminus centre path should be opaque, got ${a}`);
    }
  });
});
