// Pure-helper + batched-merge tests for the border-forest EDGE FADE.
//
// The decorative forest band that rings the playable map fades to transparency
// at its outer edge so the map dissolves into mist instead of ending at a hard
// wall (operator request). The fade is anchored to the OUTER edge of the band:
//   • outermost ring        → alpha 0.2
//   • 2nd-from-outermost     → alpha 0.5
//   • 3rd-from-outermost     → alpha 0.8
//   • any ring further IN    → alpha 1.0 (fully opaque)
// "Ring" = Chebyshev distance outward from the playable-map edge.
//
// The renderer itself can't run in node-test (Babylon + WebGL), so the
// ring→alpha bucketing is exercised as a pure function, and the merge-by-tier
// behaviour is exercised with a Babylon stub.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BORDER_FOREST_EDGE_ALPHAS,
  borderForestAlphaForOuterRing,
  borderForestAlphaForTile,
  borderTileDepthFromPlayable,
  borderTilePositions,
  forestTreesForHex,
  hexToWorld,
  Renderer3D,
  tilesExtent,
} from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';

function buildRectTiles(cols, rows) {
  const m = new Map();
  for (let c = 0; c < cols; c++) for (let r = 0; r < rows; r++) {
    m.set(hexKey(c, r), { col: c, row: r });
  }
  return m;
}

describe('Renderer3D — BORDER_FOREST_EDGE_ALPHAS', () => {
  test('three outer tiers: 0.2, 0.5, 0.8 (frozen)', () => {
    assert.deepEqual([...BORDER_FOREST_EDGE_ALPHAS], [0.2, 0.5, 0.8]);
    assert.ok(Object.isFrozen(BORDER_FOREST_EDGE_ALPHAS));
  });
});

describe('Renderer3D — borderForestAlphaForOuterRing', () => {
  test('outermost ring (0) → 0.2', () => {
    assert.equal(borderForestAlphaForOuterRing(0), 0.2);
  });

  test('2nd-from-outer (1) → 0.5, 3rd (2) → 0.8', () => {
    assert.equal(borderForestAlphaForOuterRing(1), 0.5);
    assert.equal(borderForestAlphaForOuterRing(2), 0.8);
  });

  test('any ring ≥3 from the outer edge → fully opaque (1.0)', () => {
    assert.equal(borderForestAlphaForOuterRing(3), 1.0);
    assert.equal(borderForestAlphaForOuterRing(4), 1.0);
    assert.equal(borderForestAlphaForOuterRing(99), 1.0);
  });

  test('negative / NaN treated as inner → opaque', () => {
    assert.equal(borderForestAlphaForOuterRing(-1), 1.0);
    assert.equal(borderForestAlphaForOuterRing(NaN), 1.0);
  });
});

describe('Renderer3D — borderTileDepthFromPlayable (Chebyshev rings out)', () => {
  const ext = { minCol: 0, maxCol: 12, minRow: 0, maxRow: 12 }; // 13×13

  test('tile inside the playable rectangle → 0', () => {
    assert.equal(borderTileDepthFromPlayable(6, 6, ext), 0);
    assert.equal(borderTileDepthFromPlayable(0, 0, ext), 0);
    assert.equal(borderTileDepthFromPlayable(12, 12, ext), 0);
  });

  test('one ring out in a single axis → 1', () => {
    assert.equal(borderTileDepthFromPlayable(-1, 6, ext), 1);  // left of map
    assert.equal(borderTileDepthFromPlayable(13, 6, ext), 1);  // right of map
    assert.equal(borderTileDepthFromPlayable(6, -1, ext), 1);  // above map
    assert.equal(borderTileDepthFromPlayable(6, 13, ext), 1);  // below map
  });

  test('diagonal corner uses the max of the two axis distances', () => {
    assert.equal(borderTileDepthFromPlayable(-2, -3, ext), 3);
    assert.equal(borderTileDepthFromPlayable(15, 14, ext), 3); // dCol=3, dRow=2 → 3
  });

  test('null extent → 0', () => {
    assert.equal(borderTileDepthFromPlayable(5, 5, null), 0);
  });
});

describe('Renderer3D — borderForestAlphaForTile (the 3-outer-rings fade)', () => {
  // 13×13 playable, band 6 deep: depths 1..6 outward.
  const ext = tilesExtent(buildRectTiles(13, 13));
  const bandDepth = 6;

  test('outermost ring (depth=bandDepth) → 0.2', () => {
    assert.equal(borderForestAlphaForTile(-6, 6, ext, bandDepth), 0.2);
    assert.equal(borderForestAlphaForTile(18, 6, ext, bandDepth), 0.2); // 12+6
    assert.equal(borderForestAlphaForTile(18, 18, ext, bandDepth), 0.2); // corner
  });

  test('2nd-from-outer (depth=bandDepth−1) → 0.5', () => {
    assert.equal(borderForestAlphaForTile(-5, 6, ext, bandDepth), 0.5);
    assert.equal(borderForestAlphaForTile(17, 6, ext, bandDepth), 0.5);
  });

  test('3rd-from-outer (depth=bandDepth−2) → 0.8', () => {
    assert.equal(borderForestAlphaForTile(-4, 6, ext, bandDepth), 0.8);
    assert.equal(borderForestAlphaForTile(16, 6, ext, bandDepth), 0.8);
  });

  test('all inner rings (depth 1..3 of a 6-deep band) stay opaque', () => {
    for (const depthIn of [1, 2, 3]) {
      const col = -depthIn; // ring `depthIn` out on the left edge
      assert.equal(
        borderForestAlphaForTile(col, 6, ext, bandDepth), 1.0,
        `ring at depth ${depthIn} (col ${col}) should be opaque`,
      );
    }
  });

  test('every border tile of a 6-deep band lands in {0.2,0.5,0.8,1.0}', () => {
    const allowed = new Set([0.2, 0.5, 0.8, 1.0]);
    for (const p of borderTilePositions(buildRectTiles(13, 13), bandDepth)) {
      const a = borderForestAlphaForTile(p.col, p.row, ext, bandDepth);
      assert.ok(allowed.has(a), `tile (${p.col},${p.row}) got disallowed alpha ${a}`);
    }
  });

  test('exactly the three outer rings of a 6-deep band are faded', () => {
    let faded = 0, opaque = 0;
    for (const p of borderTilePositions(buildRectTiles(13, 13), bandDepth)) {
      const a = borderForestAlphaForTile(p.col, p.row, ext, bandDepth);
      if (a < 1) faded++; else opaque++;
    }
    // Faded = rings at depth 4,5,6; opaque = rings at depth 1,2,3.
    // Both are non-empty for a 6-deep band, and the outer (bigger) rings carry
    // more tiles than the inner ones.
    assert.ok(faded > 0 && opaque > 0);
    assert.ok(faded > opaque, 'outer (faded) rings should out-count inner (opaque) rings');
  });

  test('shallow band (<3 deep) fades outer-first: depth=2 → outer 0.2, next 0.5', () => {
    const shallow = 2;
    // Outermost (depth 2) → ringsFromOuter 0 → 0.2
    assert.equal(borderForestAlphaForTile(-2, 6, ext, shallow), 0.2);
    // Innermost (depth 1) → ringsFromOuter 1 → 0.5
    assert.equal(borderForestAlphaForTile(-1, 6, ext, shallow), 0.5);
  });

  test('1-deep band: the single ring is the outermost → 0.2', () => {
    assert.equal(borderForestAlphaForTile(-1, 6, ext, 1), 0.2);
  });

  test('playable-interior tiles never fade (depth 0)', () => {
    assert.equal(borderForestAlphaForTile(6, 6, ext, bandDepth), 1.0);
  });
});

// ── Per-tier translucent merge ──────────────────────────────────────────────
//
// Babylon can't do per-instance alpha on a shared merged mesh, so faded border
// tiles are bucketed by alpha tier and merged once per tier with that tier's
// translucent material. This stub exercises `_buildBorderForestTreesBatched`
// with alpha < 1 and asserts the merged meshes carry the requested alpha.

function makeStubBabylon() {
  const makeMesh = (name) => ({
    name,
    position:   { set() {} },
    rotation:   { x: 0, y: 0, z: 0 },
    scaling:    { x: 1, y: 1, z: 1 },
    parent:     null,
    material:   null,
    metadata:   undefined,
    isPickable: true,
    setEnabled() {},
    dispose() {},
  });
  const StandardMaterial = function (name) {
    this.name = name;
    this.alpha = 1;
    this.transparencyMode = 0;
    this.needDepthPrePass = false;
    this.diffuseColor = null;
    this.specularColor = null;
    this.clone = (n) => {
      const c = new StandardMaterial(n);
      c.alpha = this.alpha;
      c.transparencyMode = this.transparencyMode;
      c.diffuseColor = this.diffuseColor;
      c.specularColor = this.specularColor;
      return c;
    };
  };
  return {
    MeshBuilder: {
      CreateCylinder: (name) => makeMesh(name),
      CreateSphere:   (name) => makeMesh(name),
    },
    Mesh: {
      MergeMeshes: (meshes) => {
        if (!meshes || meshes.length === 0) return null;
        return makeMesh('merged');
      },
    },
    StandardMaterial,
    Color3: function (r, g, b) { this.r = r; this.g = g; this.b = b; },
    Material: { MATERIAL_ALPHABLEND: 2 },
  };
}

function buildTreeJobsForBand(tiles, bandDepth, alpha) {
  const jobs = [];
  for (const pos of borderTilePositions(tiles, bandDepth)) {
    const { x, z } = hexToWorld(pos.col, pos.row);
    const trees = forestTreesForHex(pos.col, pos.row);
    if (trees.length > 0) {
      jobs.push({ namePrefix: `border_forest_${pos.col}_${pos.row}`, cx: x, cz: z, trees, alpha });
    }
  }
  return jobs;
}

describe('Renderer3D — _alphaMaterialFor', () => {
  test('alpha ≥ 1 returns the plain opaque shared material (no clone)', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    const opaque = r._materialFor('#234c1f');
    assert.equal(r._alphaMaterialFor('#234c1f', 1), opaque);
    assert.equal(r._alphaMaterialFor('#234c1f', 1.5), opaque);
    assert.equal(opaque.alpha, 1);
  });

  test('alpha < 1 returns a translucent clone with blending enabled', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    const opaque = r._materialFor('#234c1f');
    const faded  = r._alphaMaterialFor('#234c1f', 0.2);
    assert.notEqual(faded, opaque, 'must not mutate the shared opaque material');
    assert.equal(opaque.alpha, 1, 'shared opaque material left untouched');
    assert.equal(faded.alpha, 0.2);
    assert.equal(faded.transparencyMode, 2); // MATERIAL_ALPHABLEND
    assert.equal(faded.needDepthPrePass, true);
  });

  test('faded variants are cached per (color, alpha)', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    assert.equal(r._alphaMaterialFor('#234c1f', 0.5), r._alphaMaterialFor('#234c1f', 0.5));
    assert.notEqual(r._alphaMaterialFor('#234c1f', 0.5), r._alphaMaterialFor('#234c1f', 0.8));
  });
});

describe('Renderer3D — _buildBorderForestTreesBatched (per-tier alpha)', () => {
  test('alpha=1 (default) keeps merged meshes opaque', () => {
    const tiles = buildRectTiles(13, 13);
    const jobs = buildTreeJobsForBand(tiles, 2, 1);
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    const meshes = r._buildBorderForestTreesBatched({ name: 'root' }, jobs);
    assert.ok(meshes.length >= 1);
    for (const m of meshes) assert.equal(m.material.alpha, 1);
  });

  test('alpha=0.2 tags every merged mesh material translucent', () => {
    const tiles = buildRectTiles(13, 13);
    const jobs = buildTreeJobsForBand(tiles, 2, 0.2);
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    const meshes = r._buildBorderForestTreesBatched(
      { name: 'root' }, jobs, { alpha: 0.2, namePrefix: 'border_forest_a20' },
    );
    assert.ok(meshes.length >= 1);
    for (const m of meshes) {
      assert.equal(m.material.alpha, 0.2, `mesh ${m.name} should be faded`);
      assert.equal(m.material.transparencyMode, 2);
    }
    // namePrefix is honoured so tiers don't collide.
    assert.equal(meshes[0].name, 'border_forest_a20_trunks');
  });

  test('custom namePrefix flows into trunk + leaf mesh names', () => {
    const tiles = buildRectTiles(7, 7);
    const jobs = buildTreeJobsForBand(tiles, 1, 0.5);
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    const meshes = r._buildBorderForestTreesBatched(
      { name: 'root' }, jobs, { alpha: 0.5, namePrefix: 'border_forest_a50' },
    );
    assert.equal(meshes[0].name, 'border_forest_a50_trunks');
    for (let i = 1; i < meshes.length; i++) {
      assert.match(meshes[i].name, /^border_forest_a50_leaves_\d+$/);
    }
  });
});

// ── Border GROUND edge fade ──────────────────────────────────────────────
//
// The band's ground hexes fade with the SAME per-ring alpha as the trees, so
// the whole map edge (ground + foliage) dissolves as one layer. The fade
// clones the shared fogged terrain material per alpha tier — the playable
// map's ground material must NEVER be mutated. In node-test the atlas isn't
// loaded, so `_terrainMaterialFor` returns null and the fade falls back to a
// clone of the colour-fog material, which the Babylon stub supports.

describe('Renderer3D — _borderGroundMaterialFor (ground edge fade)', () => {
  function mkRenderer() {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    return r;
  }

  test('alpha ≥ 1 returns the shared opaque fog material (no clone)', () => {
    const r = mkRenderer();
    const shared = r._fogMaterialFor('#3a5f3a');
    assert.equal(r._borderGroundMaterialFor('forest_1', '#3a5f3a', 1), shared);
    assert.equal(r._borderGroundMaterialFor('forest_1', '#3a5f3a', 1.5), shared);
    assert.equal(shared.alpha, 1, 'shared material left opaque');
  });

  test('alpha < 1 returns a translucent clone; shared material untouched', () => {
    const r = mkRenderer();
    const shared = r._fogMaterialFor('#3a5f3a');
    const faded  = r._borderGroundMaterialFor('forest_1', '#3a5f3a', 0.2);
    assert.notEqual(faded, shared, 'must clone, not mutate the shared material');
    assert.equal(shared.alpha, 1, 'shared playable-tile material stays alpha 1');
    assert.equal(faded.alpha, 0.2);
    assert.equal(faded.transparencyMode, 2); // MATERIAL_ALPHABLEND
    assert.equal(faded.needDepthPrePass, true);
  });

  test('clones are cached per (base material, alpha) tier — bounded', () => {
    const r = mkRenderer();
    assert.equal(
      r._borderGroundMaterialFor('forest_1', '#3a5f3a', 0.5),
      r._borderGroundMaterialFor('forest_1', '#3a5f3a', 0.5),
      'same tier reuses one clone',
    );
    assert.notEqual(
      r._borderGroundMaterialFor('forest_1', '#3a5f3a', 0.5),
      r._borderGroundMaterialFor('forest_1', '#3a5f3a', 0.8),
      'distinct tiers get distinct clones',
    );
  });

  test('the three outer rings fade ground to 0.2/0.5/0.8; inner rings opaque', () => {
    const r = mkRenderer();
    const ext = tilesExtent(buildRectTiles(13, 13));
    const bandDepth = 6;
    // Walk a single edge ray outward (left of the map, fixed row 6) so each
    // step is one ring deeper, and confirm the ground material's alpha tracks
    // borderForestAlphaForTile exactly.
    const cases = [
      { col: -6, expect: 0.2 }, // outermost ring
      { col: -5, expect: 0.5 },
      { col: -4, expect: 0.8 },
      { col: -3, expect: 1.0 }, // inner rings opaque
      { col: -2, expect: 1.0 },
      { col: -1, expect: 1.0 },
    ];
    for (const { col, expect } of cases) {
      const alpha = borderForestAlphaForTile(col, 6, ext, bandDepth);
      assert.equal(alpha, expect, `ring at col ${col} expected alpha ${expect}`);
      const mat = r._borderGroundMaterialFor('forest_1', '#3a5f3a', alpha);
      assert.equal(mat.alpha, expect, `ground material at col ${col} should be alpha ${expect}`);
      if (expect < 1) assert.equal(mat.transparencyMode, 2, 'faded ground is alpha-blended');
    }
  });

  test('ground and trees on the same ring share one alpha (lockstep fade)', () => {
    const r = mkRenderer();
    const ext = tilesExtent(buildRectTiles(13, 13));
    const bandDepth = 6;
    const alpha = borderForestAlphaForTile(-6, 6, ext, bandDepth); // outermost
    const ground = r._borderGroundMaterialFor('forest_1', '#3a5f3a', alpha);
    const tree   = r._alphaMaterialFor('#234c1f', alpha);
    assert.equal(ground.alpha, tree.alpha, 'ground + tree fade in lockstep');
    assert.equal(ground.alpha, 0.2);
  });
});

describe('Renderer3D — _fadedTreeTemplateFor (real-tree path)', () => {
  function makeTemplateStub(name) {
    const mat = {
      name: `${name}_mat`,
      alpha: 1,
      transparencyMode: 0,
      needDepthPrePass: false,
      clone(n) { return { ...this, name: n, clone: this.clone, forceCompilation() {} }; },
      forceCompilation() {},
    };
    return {
      name,
      material: mat,
      metadata: { kind: 'tree-template', file: name },
      isPickable: false,
      getChildMeshes: () => [],
      setEnabled() {},
      clone(n) {
        return {
          name: n,
          material: this.material.clone(`${this.material.name}_clone`),
          metadata: undefined,
          isPickable: true,
          getChildMeshes: () => [],
          setEnabled() {},
        };
      },
    };
  }

  test('alpha ≥ 1 returns the shared opaque template untouched', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    const tmpl = makeTemplateStub('tree-a.glb');
    r._treeTemplates.set('tree-a.glb', tmpl);
    assert.equal(r._fadedTreeTemplateFor('tree-a.glb', 1), tmpl);
    assert.equal(tmpl.material.alpha, 1, 'opaque template material untouched');
  });

  test('alpha < 1 clones the template and fades its material', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    const tmpl = makeTemplateStub('tree-a.glb');
    r._treeTemplates.set('tree-a.glb', tmpl);
    const faded = r._fadedTreeTemplateFor('tree-a.glb', 0.2);
    assert.notEqual(faded, tmpl);
    assert.equal(tmpl.material.alpha, 1, 'shared opaque template not mutated');
    assert.equal(faded.material.alpha, 0.2);
    assert.equal(faded.material.transparencyMode, 2);
    assert.equal(faded.material.needDepthPrePass, true);
    assert.equal(faded.metadata.kind, 'tree-template-faded');
  });

  test('faded templates cached per (file, alpha)', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._treeTemplates.set('tree-a.glb', makeTemplateStub('tree-a.glb'));
    assert.equal(r._fadedTreeTemplateFor('tree-a.glb', 0.5), r._fadedTreeTemplateFor('tree-a.glb', 0.5));
    assert.notEqual(r._fadedTreeTemplateFor('tree-a.glb', 0.5), r._fadedTreeTemplateFor('tree-a.glb', 0.8));
  });

  test('missing file → null (cached)', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    assert.equal(r._fadedTreeTemplateFor('nope.glb', 0.2), null);
  });
});
