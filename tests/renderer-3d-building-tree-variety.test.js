// Pure-helper tests for the 3D-renderer building dimension jitter and tree
// species/shade variety added alongside the polish bundle.
//
// The Babylon meshes themselves can't run in node-test (no WebGL), but the
// deterministic per-hex helpers feeding those meshes are pure functions and
// fully testable. Linked to tasks t-4d1ed6e9 (building variation) and
// t-d69a7590 (tree variety).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildingDimensionsForHex,
  BUILDING_BASE_DIM,
  BUILDING_ROOF_DIM,
  BUILDING_DIM_JITTER,
  forestTreesForHex,
  borderForestTreesForHex,
  treeSpeciesForHex,
  treeLeafShadeIndex,
  treeLeafColorFor,
  TREE_SPECIES,
  TREE_LEAF_PALETTE,
  TREE_LEAF_PALETTE_FOG,
  TREE_LEAF_SHADES_PER_SPECIES,
} from '../src/renderer-3d.js';

describe('Renderer3D — buildingDimensionsForHex', () => {
  test('is deterministic: same (col, row) returns equal dimensions', () => {
    const a = buildingDimensionsForHex(4, 9);
    const b = buildingDimensionsForHex(4, 9);
    assert.deepEqual(a, b);
  });

  test('different hexes produce different dimensions (sample of pairs)', () => {
    const a = buildingDimensionsForHex(0, 0);
    const b = buildingDimensionsForHex(1, 0);
    const c = buildingDimensionsForHex(0, 1);
    const sameBox = (x, y) =>
      x.box.width  === y.box.width &&
      x.box.height === y.box.height &&
      x.box.depth  === y.box.depth;
    assert.ok(!sameBox(a, b) || !sameBox(a, c), 'expected dimension variety across hexes');
  });

  test('each axis stays within ±BUILDING_DIM_JITTER of the base', () => {
    const tol = BUILDING_DIM_JITTER + 1e-9;
    for (let col = -8; col <= 8; col++) {
      for (let row = -8; row <= 8; row++) {
        const d = buildingDimensionsForHex(col, row);
        const ratioW = d.box.width  / BUILDING_BASE_DIM.width;
        const ratioH = d.box.height / BUILDING_BASE_DIM.height;
        const ratioD = d.box.depth  / BUILDING_BASE_DIM.depth;
        assert.ok(Math.abs(ratioW - 1) <= tol, `width ratio ${ratioW} out of band at (${col},${row})`);
        assert.ok(Math.abs(ratioH - 1) <= tol, `height ratio ${ratioH} out of band at (${col},${row})`);
        assert.ok(Math.abs(ratioD - 1) <= tol, `depth ratio ${ratioD} out of band at (${col},${row})`);
      }
    }
  });

  test('axes vary independently — width and height are not lockstep', () => {
    // If we used one shared hash for all axes the ratios would correlate
    // perfectly. Sample many hexes and verify width and height ratios show
    // independent variation.
    const ratios = [];
    for (let col = -10; col <= 10; col++) {
      for (let row = -10; row <= 10; row++) {
        const d = buildingDimensionsForHex(col, row);
        ratios.push([d.box.width / BUILDING_BASE_DIM.width, d.box.height / BUILDING_BASE_DIM.height]);
      }
    }
    // Pearson-ish: just count how often width-jitter sign matches height-jitter sign.
    // Independent jitter → ~50% same-sign. We allow some slack.
    let same = 0;
    for (const [w, h] of ratios) {
      if ((w - 1) * (h - 1) > 0) same++;
    }
    const frac = same / ratios.length;
    assert.ok(frac > 0.35 && frac < 0.65, `width/height jitter correlation looks lockstep: ${frac}`);
  });

  test('roof overhangs box by the historical ratio (0.62 / 0.55)', () => {
    const expectedRatio = BUILDING_ROOF_DIM.width / BUILDING_BASE_DIM.width;
    const d = buildingDimensionsForHex(3, 5);
    assert.ok(Math.abs(d.roof.width  / d.box.width  - expectedRatio) < 1e-9);
    assert.ok(Math.abs(d.roof.depth  / d.box.depth  - expectedRatio) < 1e-9);
    // Roof height is held constant — the lid should always read as a lid.
    assert.equal(d.roof.height, BUILDING_ROOF_DIM.height);
  });

  test('observed jitter spreads across the ±band, not collapsing to a single value', () => {
    const widths = [];
    for (let col = -8; col <= 8; col++) {
      for (let row = -8; row <= 8; row++) {
        widths.push(buildingDimensionsForHex(col, row).box.width);
      }
    }
    const min = Math.min(...widths);
    const max = Math.max(...widths);
    // Expect at least ~half the full jitter range covered across the sample.
    const fullRange = BUILDING_BASE_DIM.width * 2 * BUILDING_DIM_JITTER;
    assert.ok(max - min > fullRange * 0.5, `width spread too narrow: ${min}..${max}`);
  });
});

describe('Renderer3D — tree species', () => {
  test('three species are defined', () => {
    assert.equal(TREE_SPECIES.length, 3);
    assert.ok(TREE_SPECIES.includes('pine'));
    assert.ok(TREE_SPECIES.includes('oak'));
    assert.ok(TREE_SPECIES.includes('spruce'));
  });

  test('species pick is deterministic per (col, row, index)', () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(treeSpeciesForHex(3, 7, i), treeSpeciesForHex(3, 7, i));
    }
  });

  test('all three species appear across many hexes', () => {
    const counts = new Map(TREE_SPECIES.map((s) => [s, 0]));
    for (let col = -8; col <= 8; col++) {
      for (let row = -8; row <= 8; row++) {
        for (let i = 0; i < 5; i++) {
          counts.set(treeSpeciesForHex(col, row, i), counts.get(treeSpeciesForHex(col, row, i)) + 1);
        }
      }
    }
    for (const sp of TREE_SPECIES) {
      assert.ok(counts.get(sp) > 0, `species '${sp}' never appears in sample`);
    }
  });

  test('species returned is always one of TREE_SPECIES', () => {
    for (let col = -5; col <= 5; col++) {
      for (let row = -5; row <= 5; row++) {
        for (let i = 0; i < 5; i++) {
          const sp = treeSpeciesForHex(col, row, i);
          assert.ok(TREE_SPECIES.includes(sp), `unexpected species '${sp}'`);
        }
      }
    }
  });
});

describe('Renderer3D — tree leaf-shade index', () => {
  test('is deterministic per (col, row, index)', () => {
    for (let i = 0; i < 5; i++) {
      assert.equal(treeLeafShadeIndex(2, 4, i), treeLeafShadeIndex(2, 4, i));
    }
  });

  test('always in [0, TREE_LEAF_SHADES_PER_SPECIES)', () => {
    for (let col = -5; col <= 5; col++) {
      for (let row = -5; row <= 5; row++) {
        for (let i = 0; i < 5; i++) {
          const s = treeLeafShadeIndex(col, row, i);
          assert.ok(Number.isInteger(s) && s >= 0 && s < TREE_LEAF_SHADES_PER_SPECIES,
            `shade ${s} out of [0, ${TREE_LEAF_SHADES_PER_SPECIES}) at (${col},${row},${i})`);
        }
      }
    }
  });

  test('all shade buckets show up across many hexes', () => {
    const seen = new Set();
    for (let col = -8; col <= 8; col++) {
      for (let row = -8; row <= 8; row++) {
        for (let i = 0; i < 5; i++) seen.add(treeLeafShadeIndex(col, row, i));
      }
    }
    for (let s = 0; s < TREE_LEAF_SHADES_PER_SPECIES; s++) {
      assert.ok(seen.has(s), `shade ${s} never appeared`);
    }
  });
});

describe('Renderer3D — leaf colour palettes', () => {
  test('each species has exactly TREE_LEAF_SHADES_PER_SPECIES shades', () => {
    for (const sp of TREE_SPECIES) {
      assert.equal(TREE_LEAF_PALETTE[sp].length, TREE_LEAF_SHADES_PER_SPECIES);
      assert.equal(TREE_LEAF_PALETTE_FOG[sp].length, TREE_LEAF_SHADES_PER_SPECIES);
    }
  });

  test('all palette entries are #rrggbb', () => {
    for (const sp of TREE_SPECIES) {
      for (const c of TREE_LEAF_PALETTE[sp])     assert.match(c, /^#[0-9a-f]{6}$/i);
      for (const c of TREE_LEAF_PALETTE_FOG[sp]) assert.match(c, /^#[0-9a-f]{6}$/i);
    }
  });

  test('fogged variant of each shade is darker than the bright variant', () => {
    const lum = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      return ((n >> 16) & 0xff) + ((n >> 8) & 0xff) + (n & 0xff);
    };
    for (const sp of TREE_SPECIES) {
      for (let i = 0; i < TREE_LEAF_SHADES_PER_SPECIES; i++) {
        assert.ok(
          lum(TREE_LEAF_PALETTE_FOG[sp][i]) < lum(TREE_LEAF_PALETTE[sp][i]),
          `fog shade '${TREE_LEAF_PALETTE_FOG[sp][i]}' not darker than bright '${TREE_LEAF_PALETTE[sp][i]}' for ${sp}[${i}]`,
        );
      }
    }
  });

  test('treeLeafColorFor returns palette entry by (species, shade, fogged)', () => {
    for (const sp of TREE_SPECIES) {
      for (let i = 0; i < TREE_LEAF_SHADES_PER_SPECIES; i++) {
        assert.equal(treeLeafColorFor(sp, i),                TREE_LEAF_PALETTE[sp][i]);
        assert.equal(treeLeafColorFor(sp, i, { fogged: true }), TREE_LEAF_PALETTE_FOG[sp][i]);
      }
    }
  });
});

describe('Renderer3D — forestTreesForHex carries species + shadeIdx', () => {
  test('every tree has a valid species and shade index', () => {
    for (let col = -4; col <= 4; col++) {
      for (let row = -4; row <= 4; row++) {
        for (const t of forestTreesForHex(col, row)) {
          assert.ok(TREE_SPECIES.includes(t.species), `bad species '${t.species}'`);
          assert.ok(Number.isInteger(t.shadeIdx)
            && t.shadeIdx >= 0
            && t.shadeIdx < TREE_LEAF_SHADES_PER_SPECIES,
            `bad shadeIdx ${t.shadeIdx}`);
        }
      }
    }
  });

  test('species assignment matches treeSpeciesForHex per index', () => {
    const trees = forestTreesForHex(3, 7);
    for (let i = 0; i < trees.length; i++) {
      // trees[i].id encodes the original index — but since the helper attaches
      // species using occ._idx (= i in the build loop), the i-th tree's species
      // should equal treeSpeciesForHex(col, row, i).
      assert.equal(trees[i].species, treeSpeciesForHex(3, 7, i));
    }
  });

  test('borderForestTreesForHex also carries species + shadeIdx', () => {
    for (let col = -4; col <= 4; col++) {
      for (let row = -4; row <= 4; row++) {
        for (const t of borderForestTreesForHex(col, row)) {
          assert.ok(TREE_SPECIES.includes(t.species));
          assert.ok(Number.isInteger(t.shadeIdx)
            && t.shadeIdx >= 0
            && t.shadeIdx < TREE_LEAF_SHADES_PER_SPECIES);
        }
      }
    }
  });

  test('species variety appears across a single forest band sample', () => {
    const seen = new Set();
    for (let col = -6; col <= 6; col++) {
      for (let row = -6; row <= 6; row++) {
        for (const t of borderForestTreesForHex(col, row)) seen.add(t.species);
      }
    }
    assert.equal(seen.size, TREE_SPECIES.length,
      `expected all ${TREE_SPECIES.length} species in the band, saw ${[...seen].join(',')}`);
  });
});
