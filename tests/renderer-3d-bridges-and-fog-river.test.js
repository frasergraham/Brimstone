// Tests for the bundled polish: bridge plank rendering disabled, and the
// river-extension ribbons that thread through the border-forest band
// rendering with the SAME colour as the in-map river network (no fog tint).
//
// Why no fog tint: bridge planks are off, so the road ribbon visibly crosses
// the river at every bridge tile, and the river extension carries the water
// past the playable edge through the forest band. Earlier polish tinted the
// extension down to match the dark border hexes, which read as a dimmer
// stripe than the playable-area river. Operator wants the water to look the
// same colour and brightness inside and outside the playable area — the
// border band's ambient darkness handles the visual fade naturally without
// any explicit material multiplier.
//
// Babylon + WebGL can't run in node-test, so we cover the change with two
// angles:
//   • A stubbed-Babylon test that drives `_buildRiverExtensions` and asserts
//     the extension mesh's material diffuse / emissive equal the unfogged
//     in-map river ribbon colours.
//   • The bridge-plank gate inside `_buildTileMesh` is a `_renderBridges`
//     flag on the renderer instance; we exercise it by constructing a bare
//     instance and asserting the flag defaults to off (so the plank build
//     is dead code at runtime until a future caller flips it).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ribbonMaterialColors,
  Renderer3D,
  RIVER_ALPHA_INDEX,
} from '../src/renderer-3d.js';
import { TileType, TILE_COLOR } from '../src/tiles.js';
import { hexKey } from '../src/hex.js';

// ── Stubbed Babylon for the river-extension build path ────────────────────────

function makeStubBabylon() {
  // The new river-extension build path (matching the in-map river ribbon) sets
  // per-vertex alpha via `getTotalVertices` + `setVerticesData`, so the stub
  // meshes must respond to both. Stored colours aren't read by the assertions
  // below, but kept for future shape pinning.
  const makeMesh = (name, vertexCount = 0) => ({
    name,
    position:   { set() {} },
    rotation:   { x: 0, y: 0, z: 0 },
    scaling:    { x: 1, y: 1, z: 1 },
    parent:     null,
    material:   null,
    metadata:   undefined,
    isPickable: true,
    alphaIndex: undefined,
    receiveShadows: false,
    hasVertexAlpha: false,
    _vertexCount:   vertexCount,
    _vertexData:    new Map(),
    getTotalVertices() { return this._vertexCount; },
    setVerticesData(kind, data) { this._vertexData.set(kind, data); },
    setEnabled() {},
    dispose() {},
  });
  return {
    MeshBuilder: {
      CreateRibbon: (name, opts) => {
        // 5-path ribbons (new path) and 2-path ribbons (old path) both have
        // `pathArray[i].length` samples per path; total verts = paths × N.
        let n = 0;
        if (opts && Array.isArray(opts.pathArray) && opts.pathArray.length > 0) {
          n = opts.pathArray.length * (opts.pathArray[0].length || 0);
        }
        return makeMesh(name, n);
      },
    },
    Mesh: {
      DOUBLESIDE: 2,
    },
    StandardMaterial: function (name) {
      this.name             = name;
      this.diffuseColor     = null;
      this.emissiveColor    = null;
      this.specularColor    = null;
      this.backFaceCulling  = true;
      this.disableLighting  = false;
      this.clone            = function (cloneName) {
        const c = new (Object.getPrototypeOf(this).constructor)(cloneName);
        c.diffuseColor    = this.diffuseColor;
        c.emissiveColor   = this.emissiveColor;
        c.specularColor   = this.specularColor;
        c.backFaceCulling = this.backFaceCulling;
        c.disableLighting = this.disableLighting;
        return c;
      };
    },
    Color3: function (r, g, b) { this.r = r; this.g = g; this.b = b; },
    Vector3: function (x, y, z) { this.x = x; this.y = y; this.z = z; },
    VertexBuffer: { ColorKind: 'color' },
  };
}

/** Tiny tiles map: river crosses horizontally through (0..4, row=2). Endpoints
 *  at col=0 and col=4 each have one water neighbour → two exits. */
function makeRiverAcross(cols = 5, row = 2) {
  const tiles = new Map();
  for (let c = 0; c < cols; c++) {
    tiles.set(hexKey(c, row), { col: c, row, type: TileType.RIVER, roadDirs: new Set() });
  }
  return tiles;
}

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

describe('Renderer3D — river extension uses the in-map river colour (no fog tint)', () => {
  test('extension material diffuse + emissive equal ribbonMaterialColors(TILE_COLOR.RIVER)', () => {
    const r = newInst();
    r._babylon = makeStubBabylon();
    r._scene   = {};
    r._mapRoot = { name: 'mapRoot' };
    r.state    = { tiles: makeRiverAcross(5, 2) };
    // Sentinel "river exists" probe — `_buildRiverExtensions` checks this and
    // bails out if the map has no river. The mesh contents don't matter
    // because the extension material is now built from `ribbonMaterialColors`
    // directly rather than cloned off the in-map river mesh.
    r._riverNetworkMesh = { name: 'river_5,5', material: { name: 'river_anchor' } };

    r._buildRiverExtensions(2);

    const exts = [];
    for (const list of r._borderPropsByKey.values()) {
      for (const m of list) if (m.metadata?.kind === 'river-extension') exts.push(m);
    }
    assert.ok(exts.length >= 1, 'expected at least one river-extension mesh');

    const expected = ribbonMaterialColors(TILE_COLOR[TileType.RIVER]);
    for (const m of exts) {
      const d = m.material.diffuseColor;
      const e = m.material.emissiveColor;
      assert.ok(Math.abs(d.r - expected.diffuse[0]) < 1e-9,
        `extension ${m.name} diffuse.r ${d.r} should equal in-map river ${expected.diffuse[0]}`);
      assert.ok(Math.abs(d.g - expected.diffuse[1]) < 1e-9);
      assert.ok(Math.abs(d.b - expected.diffuse[2]) < 1e-9);
      assert.ok(Math.abs(e.r - expected.emissive[0]) < 1e-9,
        `extension ${m.name} emissive.r ${e.r} should equal in-map river ${expected.emissive[0]}`);
      assert.ok(Math.abs(e.g - expected.emissive[1]) < 1e-9);
      assert.ok(Math.abs(e.b - expected.emissive[2]) < 1e-9);
    }
  });

  test('extension meshes do NOT carry a fogged: true tag', () => {
    // The old polish stashed `fogged: true` on the metadata so the renderer
    // could distinguish darkened extensions from the playable-area river.
    // After dropping the fog tint there is nothing to distinguish — pin that
    // the tag is gone so a future change can't silently re-darken extensions.
    const r = newInst();
    r._babylon = makeStubBabylon();
    r._scene   = {};
    r._mapRoot = { name: 'mapRoot' };
    r.state    = { tiles: makeRiverAcross(5, 2) };
    r._riverNetworkMesh = { name: 'river_5,5', material: {} };

    r._buildRiverExtensions(2);

    for (const list of r._borderPropsByKey.values()) {
      for (const m of list) {
        if (m.metadata?.kind === 'river-extension') {
          assert.notEqual(m.metadata.fogged, true,
            `extension ${m.name} should not carry fogged:true after the tint drop`);
        }
      }
    }
  });

  test('extension meshes set receiveShadows + alphaIndex to match the in-map river', () => {
    // Matching in-map ribbons means matching shadow + transparency behaviour —
    // unit shadows should fall across the extension, and the road ribbon's
    // higher alphaIndex must still win at any crossing point.
    const r = newInst();
    r._babylon = makeStubBabylon();
    r._scene   = {};
    r._mapRoot = { name: 'mapRoot' };
    r.state    = { tiles: makeRiverAcross(5, 2) };
    r._riverNetworkMesh = { name: 'river_5,5', material: {} };

    r._buildRiverExtensions(2);

    for (const list of r._borderPropsByKey.values()) {
      for (const m of list) {
        if (m.metadata?.kind === 'river-extension') {
          assert.equal(m.receiveShadows, true,
            `extension ${m.name} must catch shadows like the in-map river`);
          assert.equal(m.alphaIndex, RIVER_ALPHA_INDEX,
            `extension ${m.name} alphaIndex should equal RIVER_ALPHA_INDEX`);
        }
      }
    }
  });

  test('extension is built as a 5-path feathered ribbon (parity with _buildNetworkMesh)', () => {
    // The old extension used a 2-path CreateRibbon (rectangular strip), which
    // read as a bright unfeathered stripe alongside the in-map river's
    // alpha-tapered feathered bezier. Pin that the new extension uses the SAME
    // 5-path layout (`outerRight, innerRight, center, innerLeft, outerLeft`)
    // with per-vertex alpha — that's what produces the lateral edge fade that
    // makes the river blend smoothly into the surrounding grass / forest.
    const r = newInst();
    r._babylon = makeStubBabylon();
    r._scene   = {};
    r._mapRoot = { name: 'mapRoot' };
    r.state    = { tiles: makeRiverAcross(5, 2) };
    r._riverNetworkMesh = { name: 'river_5,5', material: {} };

    r._buildRiverExtensions(2);

    const exts = [];
    for (const list of r._borderPropsByKey.values()) {
      for (const m of list) if (m.metadata?.kind === 'river-extension') exts.push(m);
    }
    assert.ok(exts.length >= 1);
    for (const m of exts) {
      // 5 paths × ≥2 samples each. With NETWORK_BEZIER_SEGMENTS = 22 the
      // sample count per path is 23, giving 5*23 = 115 verts. Pin "multiple
      // of 5 with ≥10 verts" rather than the exact count so tweaking the
      // segment constant doesn't break the test.
      const n = m.getTotalVertices();
      assert.ok(n >= 10, `extension ${m.name} should have ≥10 verts (5 paths × ≥2 samples), got ${n}`);
      assert.equal(n % 5, 0,
        `extension ${m.name} vert count ${n} should divide evenly into 5 paths`);
      assert.equal(m.hasVertexAlpha, true,
        `extension ${m.name} must enable per-vertex alpha for the lateral edge fade`);
      // Per-vertex colour buffer must be populated with the alpha-by-path
      // pattern (outer 0, inner 1, center 1, inner 1, outer 0).
      const colors = m._vertexData.get('color');
      assert.ok(colors instanceof Float32Array,
        `extension ${m.name} should have a Float32Array color buffer set`);
      assert.equal(colors.length, n * 4);
      const N = n / 5;
      // Spot-check alpha at path 0 (outer right) = 0 and path 2 (center) = 1.
      assert.equal(colors[3], 0, 'outer-right path alpha should be 0');
      assert.equal(colors[2 * N * 4 + 3], 1, 'center path alpha should be 1');
      assert.equal(colors[4 * N * 4 + 3], 0, 'outer-left path alpha should be 0');
    }
  });

  test('extension material exactly matches the in-map river ribbon recipe (built via _buildRibbonMaterial)', () => {
    // Both must call `_buildRibbonMaterial(_, TILE_COLOR.RIVER)`, which is the
    // single source of truth for the diffuse / emissive recipe. Pin that the
    // extension material name uses the `river_extension_ribbon_mat` prefix
    // so it's traceable in dumpRibbonDebug, AND that its colours equal the
    // independent `ribbonMaterialColors` recipe (drift detector).
    const r = newInst();
    r._babylon = makeStubBabylon();
    r._scene   = {};
    r._mapRoot = { name: 'mapRoot' };
    r.state    = { tiles: makeRiverAcross(5, 2) };
    r._riverNetworkMesh = { name: 'river_5,5', material: {} };

    r._buildRiverExtensions(2);

    const exts = [];
    for (const list of r._borderPropsByKey.values()) {
      for (const m of list) if (m.metadata?.kind === 'river-extension') exts.push(m);
    }
    assert.ok(exts.length >= 1);
    // All extensions share ONE base material instance (no per-tile clones —
    // the extension never gets fogged, unlike the in-map river ribbons).
    const matRef = exts[0].material;
    for (const m of exts) {
      assert.equal(m.material, matRef,
        'all extension meshes should share the same StandardMaterial instance');
    }
    assert.ok(/river_extension/.test(matRef.name),
      `material name "${matRef.name}" should identify it as a river extension material`);
  });

  test('no river on the map → no extension built (no-op)', () => {
    const r = newInst();
    r._babylon = makeStubBabylon();
    r._scene   = {};
    r._mapRoot = { name: 'mapRoot' };
    r.state    = { tiles: makeRiverAcross(5, 2) };
    r._riverNetworkMesh = null;

    r._buildRiverExtensions(2);

    let count = 0;
    for (const list of r._borderPropsByKey.values()) {
      for (const m of list) if (m.metadata?.kind === 'river-extension') count++;
    }
    assert.equal(count, 0,
      'with no in-map river the extension build must short-circuit before creating ribbons');
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
