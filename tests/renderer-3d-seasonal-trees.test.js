// Pure-helper tests for the seasonal tree palette + reduced-oak-ratio
// changes. Linked to task t-632e1310.
//
// The 3D renderer can't run in node-test (Babylon + WebGL), but the
// per-map season selection, the species probability table, and the
// seasonal leaf palettes are all pure functions and fully testable.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_SPECIES_PROBABILITIES,
  forestTreesForHex,
  borderForestTreesForHex,
  hashTileLayout,
  pickSeason,
  SEASONS,
  SEASONAL_LEAF_PALETTES,
  SEASONAL_LEAF_PALETTES_FOG,
  seasonalLeafPalette,
  SEASON_SPECIES_PROBABILITIES,
  seasonalSpeciesProbabilities,
  treeLeafColorFor,
  treeSpeciesForHex,
  TREE_LEAF_PALETTE,
  TREE_LEAF_SHADES_PER_SPECIES,
  TREE_SPECIES,
} from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';

describe('Renderer3D — species probabilities (rebalance)', () => {
  test('default species probabilities sum to 1', () => {
    const p = DEFAULT_SPECIES_PROBABILITIES;
    assert.ok(Math.abs((p.pine + p.spruce + p.oak) - 1) < 1e-9);
  });

  test('oak is the rare species in every season (≤10%)', () => {
    for (const s of SEASONS) {
      const p = SEASON_SPECIES_PROBABILITIES[s];
      assert.ok(p.oak <= 0.10, `${s}: oak prob ${p.oak} > 10%`);
    }
  });

  test('pine + spruce dominate in every season (≥85%)', () => {
    for (const s of SEASONS) {
      const p = SEASON_SPECIES_PROBABILITIES[s];
      assert.ok((p.pine + p.spruce) >= 0.85,
        `${s}: pine+spruce ${(p.pine + p.spruce).toFixed(2)} < 85%`);
    }
  });

  test('winter has the lowest oak probability', () => {
    const winterOak = SEASON_SPECIES_PROBABILITIES.winter.oak;
    for (const s of SEASONS) {
      if (s === 'winter') continue;
      assert.ok(winterOak <= SEASON_SPECIES_PROBABILITIES[s].oak,
        `winter oak ${winterOak} should be ≤ ${s} oak ${SEASON_SPECIES_PROBABILITIES[s].oak}`);
    }
  });

  test('seasonalSpeciesProbabilities falls back to summer for unknown', () => {
    assert.deepEqual(seasonalSpeciesProbabilities('nonsense'),
                     SEASON_SPECIES_PROBABILITIES.summer);
  });
});

describe('Renderer3D — treeSpeciesForHex (rebalanced distribution)', () => {
  test('observed oak ratio across a 13×13 sample is ≤10%', () => {
    let total = 0;
    let oak = 0;
    for (let col = 0; col < 13; col++) {
      for (let row = 0; row < 13; row++) {
        for (let i = 0; i < 5; i++) {
          total++;
          if (treeSpeciesForHex(col, row, i) === 'oak') oak++;
        }
      }
    }
    const ratio = oak / total;
    assert.ok(ratio <= 0.10,
      `oak ratio ${ratio.toFixed(3)} exceeds 10% (${oak}/${total})`);
  });

  test('observed oak ratio is at least 3% — oak still appears', () => {
    let total = 0;
    let oak = 0;
    for (let col = -10; col <= 10; col++) {
      for (let row = -10; row <= 10; row++) {
        for (let i = 0; i < 5; i++) {
          total++;
          if (treeSpeciesForHex(col, row, i) === 'oak') oak++;
        }
      }
    }
    assert.ok(oak / total >= 0.03,
      `oak ratio ${(oak / total).toFixed(3)} too low — oaks have effectively vanished`);
  });

  test('pine + spruce together dominate (≥85% of sample)', () => {
    let total = 0;
    let dominant = 0;
    for (let col = -10; col <= 10; col++) {
      for (let row = -10; row <= 10; row++) {
        for (let i = 0; i < 5; i++) {
          total++;
          const s = treeSpeciesForHex(col, row, i);
          if (s === 'pine' || s === 'spruce') dominant++;
        }
      }
    }
    assert.ok(dominant / total >= 0.85,
      `pine+spruce ratio ${(dominant/total).toFixed(3)} below 85%`);
  });

  test('winter sample has fewer oaks than summer sample', () => {
    let summerOak = 0;
    let winterOak = 0;
    for (let col = -10; col <= 10; col++) {
      for (let row = -10; row <= 10; row++) {
        for (let i = 0; i < 5; i++) {
          if (treeSpeciesForHex(col, row, i, 'summer') === 'oak') summerOak++;
          if (treeSpeciesForHex(col, row, i, 'winter') === 'oak') winterOak++;
        }
      }
    }
    assert.ok(winterOak < summerOak,
      `winter oak count ${winterOak} should be < summer ${summerOak}`);
  });

  test('species pick is deterministic per (col, row, idx, season)', () => {
    for (const s of SEASONS) {
      for (let i = 0; i < 5; i++) {
        assert.equal(treeSpeciesForHex(3, 7, i, s), treeSpeciesForHex(3, 7, i, s));
      }
    }
  });

  test('result is always one of TREE_SPECIES for every season', () => {
    for (const s of SEASONS) {
      for (let col = -5; col <= 5; col++) {
        for (let row = -5; row <= 5; row++) {
          for (let i = 0; i < 5; i++) {
            const sp = treeSpeciesForHex(col, row, i, s);
            assert.ok(TREE_SPECIES.includes(sp), `bad species '${sp}'`);
          }
        }
      }
    }
  });
});

describe('Renderer3D — pickSeason / hashTileLayout', () => {
  test('SEASONS has the expected four entries', () => {
    assert.deepEqual([...SEASONS].sort(), ['fall', 'spring', 'summer', 'winter']);
  });

  test('pickSeason is deterministic for the same seed', () => {
    assert.equal(pickSeason(42), pickSeason(42));
    assert.equal(pickSeason(0xdeadbeef), pickSeason(0xdeadbeef));
  });

  test('pickSeason always returns a SEASONS member (including negative seeds)', () => {
    for (let i = -50; i <= 50; i++) {
      assert.ok(SEASONS.includes(pickSeason(i)), `bad season for seed ${i}`);
    }
  });

  test('pickSeason covers all four seasons over a sweep of seeds', () => {
    const seen = new Set();
    for (let i = 0; i < 100; i++) seen.add(pickSeason(i));
    assert.equal(seen.size, SEASONS.length);
  });

  test('hashTileLayout is deterministic for the same map', () => {
    const m1 = new Map();
    const m2 = new Map();
    for (let c = 0; c < 5; c++) for (let r = 0; r < 5; r++) {
      m1.set(hexKey(c, r), { col: c, row: r });
      m2.set(hexKey(c, r), { col: c, row: r });
    }
    assert.equal(hashTileLayout(m1), hashTileLayout(m2));
  });

  test('hashTileLayout differs for different maps', () => {
    const m1 = new Map();
    const m2 = new Map();
    for (let c = 0; c < 5; c++) for (let r = 0; r < 5; r++) {
      m1.set(hexKey(c, r), { col: c, row: r });
    }
    for (let c = 0; c < 7; c++) for (let r = 0; r < 7; r++) {
      m2.set(hexKey(c, r), { col: c, row: r });
    }
    assert.notEqual(hashTileLayout(m1), hashTileLayout(m2));
  });

  test('hashTileLayout(null) and (empty) return 0', () => {
    assert.equal(hashTileLayout(null), 0);
    assert.equal(hashTileLayout(new Map()), 0);
  });

  test('hashTileLayout result is an unsigned 32-bit integer', () => {
    const m = new Map();
    for (let c = 0; c < 13; c++) for (let r = 0; r < 13; r++) {
      m.set(hexKey(c, r), { col: c, row: r });
    }
    const h = hashTileLayout(m);
    assert.ok(Number.isInteger(h));
    assert.ok(h >= 0 && h <= 0xffffffff);
  });
});

describe('Renderer3D — seasonal leaf palettes', () => {
  test('every season has palettes for every species, shape-matched', () => {
    for (const s of SEASONS) {
      const bright = SEASONAL_LEAF_PALETTES[s];
      const fog    = SEASONAL_LEAF_PALETTES_FOG[s];
      for (const sp of TREE_SPECIES) {
        assert.equal(bright[sp].length, TREE_LEAF_SHADES_PER_SPECIES);
        assert.equal(fog[sp].length, TREE_LEAF_SHADES_PER_SPECIES);
      }
    }
  });

  test('every palette entry is a #rrggbb hex string', () => {
    for (const s of SEASONS) {
      for (const sp of TREE_SPECIES) {
        for (const c of SEASONAL_LEAF_PALETTES[s][sp])     assert.match(c, /^#[0-9a-f]{6}$/i);
        for (const c of SEASONAL_LEAF_PALETTES_FOG[s][sp]) assert.match(c, /^#[0-9a-f]{6}$/i);
      }
    }
  });

  test('summer palette equals the default TREE_LEAF_PALETTE', () => {
    assert.deepEqual(SEASONAL_LEAF_PALETTES.summer, TREE_LEAF_PALETTE);
  });

  test('seasonal palettes are visually distinct from summer', () => {
    // Each non-summer season should change at least one colour vs summer
    // (otherwise the season has no visual effect).
    for (const s of SEASONS) {
      if (s === 'summer') continue;
      let differs = false;
      for (const sp of TREE_SPECIES) {
        for (let i = 0; i < TREE_LEAF_SHADES_PER_SPECIES; i++) {
          if (SEASONAL_LEAF_PALETTES[s][sp][i] !== SEASONAL_LEAF_PALETTES.summer[sp][i]) {
            differs = true; break;
          }
        }
        if (differs) break;
      }
      assert.ok(differs, `season '${s}' has identical palette to summer`);
    }
  });

  test('seasonalLeafPalette falls back to summer for unknown season', () => {
    assert.deepEqual(seasonalLeafPalette('nonsense'), SEASONAL_LEAF_PALETTES.summer);
    assert.deepEqual(seasonalLeafPalette('nonsense', { fogged: true }),
                     SEASONAL_LEAF_PALETTES_FOG.summer);
  });

  test('treeLeafColorFor honours the seasonal palette', () => {
    for (const s of SEASONS) {
      for (const sp of TREE_SPECIES) {
        for (let i = 0; i < TREE_LEAF_SHADES_PER_SPECIES; i++) {
          assert.equal(
            treeLeafColorFor(sp, i, { season: s }),
            SEASONAL_LEAF_PALETTES[s][sp][i],
          );
          assert.equal(
            treeLeafColorFor(sp, i, { season: s, fogged: true }),
            SEASONAL_LEAF_PALETTES_FOG[s][sp][i],
          );
        }
      }
    }
  });

  test('treeLeafColorFor without season uses the historical summer-default', () => {
    for (const sp of TREE_SPECIES) {
      for (let i = 0; i < TREE_LEAF_SHADES_PER_SPECIES; i++) {
        assert.equal(treeLeafColorFor(sp, i), TREE_LEAF_PALETTE[sp][i]);
      }
    }
  });
});

describe('Renderer3D — bucket-count invariant under seasonal palettes', () => {
  test('each season produces ≤ 9 distinct leaf colours total', () => {
    // The cross-tile merge cap is 9 leaf colour buckets + 1 trunk = 10
    // meshes. Each season must keep its palette inside the 9-colour budget
    // (3 species × 3 shades) so the merge invariant in
    // tests/renderer-3d-forest-border.test.js still holds.
    for (const s of SEASONS) {
      const colors = new Set();
      for (const sp of TREE_SPECIES) {
        for (const c of SEASONAL_LEAF_PALETTES[s][sp]) colors.add(c);
      }
      assert.ok(colors.size <= 9,
        `season ${s} uses ${colors.size} distinct leaf colours (>9)`);
    }
  });
});

describe('Renderer3D — forestTreesForHex / borderForestTreesForHex carry season-dependent species', () => {
  test('forestTreesForHex(col, row, season) honours the season probability table', () => {
    // Spot-check: count oaks in 13×13 with winter vs summer — winter should
    // have fewer.
    let summerOaks = 0;
    let winterOaks = 0;
    for (let c = 0; c < 13; c++) {
      for (let r = 0; r < 13; r++) {
        for (const t of forestTreesForHex(c, r, 'summer')) {
          if (t.species === 'oak') summerOaks++;
        }
        for (const t of forestTreesForHex(c, r, 'winter')) {
          if (t.species === 'oak') winterOaks++;
        }
      }
    }
    assert.ok(winterOaks < summerOaks,
      `winter oaks ${winterOaks} should be < summer oaks ${summerOaks}`);
  });

  test('borderForestTreesForHex(col, row, season) honours the season probability table', () => {
    let summerOaks = 0;
    let winterOaks = 0;
    for (let c = 0; c < 13; c++) {
      for (let r = 0; r < 13; r++) {
        for (const t of borderForestTreesForHex(c, r, 'summer')) {
          if (t.species === 'oak') summerOaks++;
        }
        for (const t of borderForestTreesForHex(c, r, 'winter')) {
          if (t.species === 'oak') winterOaks++;
        }
      }
    }
    assert.ok(winterOaks < summerOaks,
      `winter border oaks ${winterOaks} should be < summer ${summerOaks}`);
  });

  test('species is deterministic across calls for a given season', () => {
    const a = forestTreesForHex(3, 7, 'fall').map((t) => t.species);
    const b = forestTreesForHex(3, 7, 'fall').map((t) => t.species);
    assert.deepEqual(a, b);
  });

  test('omitting season uses the default probabilities (back-compat)', () => {
    const trees = forestTreesForHex(3, 7);
    for (let i = 0; i < trees.length; i++) {
      assert.equal(trees[i].species, treeSpeciesForHex(3, 7, i));
    }
  });
});
