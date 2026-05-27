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
  BORDER_GROUND_ALPHA_INDEX,
  BORDER_TREE_ALPHA_INDEX,
  borderForestAlphaForOuterRing,
  borderForestAlphaForTile,
  borderTileDepthFromPlayable,
  borderTilePositions,
  forestTreesForHex,
  hexToWorld,
  Renderer3D,
  RIVER_ALPHA_INDEX,
  ROAD_ALPHA_INDEX,
  riverExtensionRingAlphas,
  tilesExtent,
} from '../src/renderer-3d.js';
import { hexKey, SQRT3 } from '../src/hex.js';

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

  // Rings BEYOND the outer edge (negative ringsFromOuter) sit PAST the band's
  // silhouette — river-extension samples poke one hex past the outermost band
  // tile. They must NOT snap back to opaque (the old behaviour, which left a
  // hard opaque river stub jutting into the faded map edge). Instead the fade
  // continues outward toward 0.
  test('beyond the outer edge (negative) keeps fading toward 0 — never opaque', () => {
    // Slope between the two outermost tiers is 0.2→0.5 ⇒ −0.3 per ring out, so
    // one ring past the edge already clamps to 0 (fully transparent).
    assert.equal(borderForestAlphaForOuterRing(-1), 0);
    assert.equal(borderForestAlphaForOuterRing(-2), 0);
    assert.equal(borderForestAlphaForOuterRing(-99), 0);
    // Crucially: NONE of these are the opaque 1.0 that caused the stub.
    for (const r of [-1, -2, -3, -10]) {
      assert.notEqual(borderForestAlphaForOuterRing(r), 1.0,
        `beyond-edge ring ${r} must not be opaque`);
    }
  });

  test('NaN still treated as opaque (defensive)', () => {
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

// ── MultiMaterial sub-material fade (the trees-stay-opaque ROOT CAUSE) ───────
//
// A merged GLB tree's material is a Babylon MultiMaterial. At draw time each
// sub-mesh renders with its corresponding SUBMATERIAL — the container's own
// `alpha` / `transparencyMode` are ignored. The original border-tree fade set
// alpha only on the container, so the actual trunk/leaf PBR submaterials stayed
// alpha=1 / OPAQUE and the trees rendered as a solid wall (verified in-browser
// via headless Chrome: subMaterials were alpha:1, transparencyMode:0). The fix
// clones + fades every submaterial (cloning so the shared opaque originals the
// in-map forest instances off are never mutated). This guards against silently
// regressing back to opaque.

describe('Renderer3D — _fadedTreeTemplateFor (MultiMaterial sub-materials)', () => {
  function makeSubMat(name) {
    return {
      name, alpha: 1, transparencyMode: 0, needDepthPrePass: false,
      clone(n) { return makeSubMat(n); },
      forceCompilation() {},
    };
  }
  // Template whose mesh material is a MultiMaterial (subMaterials array).
  // `MultiMaterial.clone()` shares the sub-materials by reference, mirroring
  // Babylon — so the renderer MUST clone each sub before fading it.
  function makeMultiTemplateStub(name) {
    const subs = [makeSubMat('trunk'), makeSubMat('leaf')];
    const multi = {
      name: `${name}_multi`, alpha: 1, transparencyMode: 0, needDepthPrePass: false,
      subMaterials: subs,
      clone(n) {
        // shallow: new container, SAME sub-material references (like Babylon)
        return { ...this, name: n, subMaterials: this.subMaterials, clone: this.clone };
      },
      // MultiMaterial has no forceCompilation — omitted on purpose.
    };
    return {
      name, material: multi, metadata: { kind: 'tree-template', file: name },
      isPickable: false, getChildMeshes: () => [], setEnabled() {},
      clone(n) {
        return {
          name: n, material: this.material.clone(`${this.material.name}_clone`),
          metadata: undefined, isPickable: true, getChildMeshes: () => [], setEnabled() {},
        };
      },
    };
  }

  test('fades every PBR sub-material — not just the container', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    const tmpl = makeMultiTemplateStub('tree-multi.glb');
    r._treeTemplates.set('tree-multi.glb', tmpl);
    const faded = r._fadedTreeTemplateFor('tree-multi.glb', 0.2);
    // Container reflects the requested alpha + alpha-blend mode…
    assert.equal(faded.material.alpha, 0.2);
    assert.equal(faded.material.transparencyMode, 2);
    // …AND every sub-material (what actually draws) is faded + alpha-blended.
    assert.equal(faded.material.subMaterials.length, 2);
    for (const sub of faded.material.subMaterials) {
      assert.equal(sub.alpha, 0.2, 'sub-material must carry the fade alpha');
      assert.equal(sub.transparencyMode, 2, 'sub-material must alpha-blend');
      assert.equal(sub.needDepthPrePass, true);
    }
  });

  test('clones sub-materials — the shared opaque originals stay untouched', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    const tmpl = makeMultiTemplateStub('tree-multi.glb');
    const originalSubs = tmpl.material.subMaterials;
    r._treeTemplates.set('tree-multi.glb', tmpl);
    const faded = r._fadedTreeTemplateFor('tree-multi.glb', 0.5);
    // Originals must NOT be mutated (the in-map forest instances off them).
    for (const sub of originalSubs) {
      assert.equal(sub.alpha, 1, 'shared sub-material left opaque');
      assert.equal(sub.transparencyMode, 0);
    }
    // And the faded clone holds DISTINCT sub-material objects.
    for (let i = 0; i < originalSubs.length; i++) {
      assert.notEqual(faded.material.subMaterials[i], originalSubs[i]);
    }
  });
});

// ── River-extension per-ring edge fade ──────────────────────────────────────
//
// The wilderness river extension is one ribbon spanning the whole band, so it
// can't bucket into a single per-tier material like the trees. Instead each
// centreline sample maps to its border ring and the per-ring alpha is folded
// into the ribbon's vertex colour. `riverExtensionRingAlphas` is that pure
// mapping; before the fix the river ran at full opacity to the band edge.

describe('Renderer3D — riverExtensionRingAlphas (river edge fade)', () => {
  const ext = tilesExtent(buildRectTiles(13, 13)); // cols/rows 0..12
  const bandDepth = 6;

  // World position of a hex centre (radius=1) — same layout the renderer uses.
  const at = (col, row) => ({ x: SQRT3 * (col + 0.5 * (row & 1)), z: 1.5 * row });

  test('samples over the outer rings get the same alpha as ground + trees', () => {
    // Walk outward along row 6, left of the playable map: depth 6→0.2, 5→0.5,
    // 4→0.8, ≤3→opaque — identical to borderForestAlphaForTile.
    const pts = [-6, -5, -4, -3].map(c => at(c, 6));
    const alphas = riverExtensionRingAlphas(pts, ext, bandDepth);
    assert.deepEqual(alphas, [0.2, 0.5, 0.8, 1.0]);
    // And it matches the ground/tree curve tile-for-tile.
    for (let i = 0; i < pts.length; i++) {
      const col = [-6, -5, -4, -3][i];
      assert.equal(alphas[i], borderForestAlphaForTile(col, 6, ext, bandDepth));
    }
  });

  test('samples inside the playable map stay fully opaque', () => {
    const alphas = riverExtensionRingAlphas([at(6, 6), at(0, 0)], ext, bandDepth);
    assert.deepEqual(alphas, [1.0, 1.0]);
  });

  // Regression (in-browser bug): the river extension runs one hex PAST the
  // outermost band tile. Those tail samples have depth > bandDepth, i.e.
  // negative ringsFromOuter, and used to map back to 1.0 → a solid opaque river
  // stub poking out beyond the faded map edge. They must now be ≤ the outer-ring
  // alpha and dissolve toward 0 — never opaque.
  test('samples BEYOND the outer ring dissolve toward 0 — not an opaque stub', () => {
    // Row 6, walking past the outermost band tile (col -6) to cols -7, -8.
    const tail = riverExtensionRingAlphas(
      [at(-6, 6), at(-7, 6), at(-8, 6)], ext, bandDepth,
    );
    assert.equal(tail[0], 0.2, 'outermost ring stays at the 0.2 tier');
    for (let i = 1; i < tail.length; i++) {
      assert.ok(tail[i] < 0.2, `beyond-edge sample ${i} should be more transparent than the outer ring`);
      assert.notEqual(tail[i], 1.0, `beyond-edge sample ${i} must NOT snap to opaque`);
      assert.ok(tail[i] >= 0, 'alpha stays non-negative');
    }
    // The far tail is fully transparent (dissolved off the edge).
    assert.equal(tail[tail.length - 1], 0);
  });

  test('non-array input → empty (defensive)', () => {
    assert.deepEqual(riverExtensionRingAlphas(null, ext, bandDepth), []);
  });
});

// ── Border-band transparent-sort stability (alphaIndex) ──────────────────────
//
// In-browser bug: the faded edge meshes (ground discs + foliage) flickered as
// the camera moved. Diagnosed via headless Chrome (CDP): every faded band mesh
// sat at Babylon's default alphaIndex (Number.MAX_VALUE), so the transparent
// pass tie-broke on distance-to-camera and the band's draw order reshuffled in
// 59 of 60 frames over a slow yaw sweep — popping the alpha blend (the same
// per-mesh-distance-sort flicker road/river ribbons already pin away). The fix
// pins a stable alphaIndex on the faded band meshes: ground < trees < river, so
// the back-to-front layering no longer depends on camera angle.

describe('Renderer3D — border-band alphaIndex (transparent-sort stability)', () => {
  test('ground < trees < river keeps the band layered front-to-back stably', () => {
    assert.ok(
      BORDER_GROUND_ALPHA_INDEX < BORDER_TREE_ALPHA_INDEX,
      'ground discs must draw behind the foliage standing on them',
    );
    assert.ok(
      BORDER_TREE_ALPHA_INDEX < RIVER_ALPHA_INDEX,
      'foliage must draw behind the river so water stays on top',
    );
    // All kept below the river/road indices so the existing ribbon ordering
    // (river < road) is undisturbed.
    assert.ok(BORDER_GROUND_ALPHA_INDEX < ROAD_ALPHA_INDEX);
    assert.ok(BORDER_TREE_ALPHA_INDEX < ROAD_ALPHA_INDEX);
  });

  test('_buildRealForestTreesForHex pins faded instances to BORDER_TREE_ALPHA_INDEX', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    r._scene   = {};
    // Stub the per-tree instance builder so we exercise just the alphaIndex
    // tagging branch without the full GLB instancing path.
    r._buildRealTreeInstance = (parent, col, row, t, i, prefix) => ({
      name: `${prefix}_inst${i}`, alphaIndex: Number.MAX_VALUE,
    });
    const trees = [{ x: 0, z: 0, scale: 1 }, { x: 0.2, z: 0.1, scale: 1 }];

    // Faded (alpha < 1) → every instance pinned to the stable band index.
    const faded = r._buildRealForestTreesForHex(
      { name: 'root' }, -6, 6, 0, 0, trees, 'border_forest', { alpha: 0.2 },
    );
    assert.equal(faded.length, 2);
    for (const m of faded) assert.equal(m.alphaIndex, BORDER_TREE_ALPHA_INDEX);

    // Opaque (alpha ≥ 1, e.g. in-map forest) → left untouched (opaque pass
    // ignores alphaIndex; tagging would be meaningless and risks reordering).
    const opaque = r._buildRealForestTreesForHex(
      { name: 'root' }, 3, 3, 0, 0, trees, 'forest', { alpha: 1 },
    );
    for (const m of opaque) assert.equal(m.alphaIndex, Number.MAX_VALUE);
  });
});

// ── _applyAlphaBlend (shared fade recipe) ───────────────────────────────────

describe('Renderer3D — _applyAlphaBlend', () => {
  test('flags a material alpha-blended at the requested alpha', () => {
    const r = new Renderer3D(null, null);
    r._babylon = makeStubBabylon();
    const mat = { alpha: 1, transparencyMode: 0, needDepthPrePass: false };
    const out = r._applyAlphaBlend(mat, 0.5);
    assert.equal(out, mat, 'mutates + returns the same material');
    assert.equal(mat.alpha, 0.5);
    assert.equal(mat.transparencyMode, 2); // MATERIAL_ALPHABLEND
    assert.equal(mat.needDepthPrePass, true);
  });
});
