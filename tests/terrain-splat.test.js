// Pure-helper tests for per-vertex terrain texture-splatting (src/terrain-splat.js).
//
// Covers: channel classification, weight normalization, EDGE SYMMETRY (the
// load-bearing contract — coincident rim verts on adjacent hexes must carry
// identical weights so the GPU interpolation matches across shared edges),
// the world↔hex round-trip (incl. odd/even/negative rows), procedural-colour
// determinism + range, and fog weights.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SPLAT_GRASS, SPLAT_DIRT, SPLAT_FOREST, SPLAT_CHANNELS,
  splatChannelForTile,
  vertexSplatWeights,
  hexSplatWeights,
  worldToHex,
  proceduralTerrainColor,
  valueNoise2D,
  hexFogWeights,
  neighborDeltas,
  DEFAULT_TERRAIN_TINTS,
  hexGridAlphaForZoom,
} from '../src/terrain-splat.js';
import { hexToWorld } from '../src/renderer-3d.js';
import { Tile, TileType, PathType, StructureType } from '../src/tiles.js';

const R = 1;
const SQRT3 = Math.sqrt(3);

// World position of a hex's 7 fan vertices (centre + 6 corners), matching
// `_buildFlatHexMesh`: corner i at angle (π/6 + i·π/3), radius R, on XZ.
function fanWorldVerts(col, row) {
  const { x, z } = hexToWorld(col, row, R);
  const verts = [{ x, z }];
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + i * Math.PI / 3;
    verts.push({ x: x + R * Math.cos(a), z: z + R * Math.sin(a) });
  }
  return verts;
}

const posKey = (p) => `${p.x.toFixed(4)},${p.z.toFixed(4)}`;

describe('terrain-splat — channel classification', () => {
  test('grass/dirt/forest base map to their channels', () => {
    assert.equal(splatChannelForTile(new Tile(0, 0, TileType.GRASS)), SPLAT_GRASS);
    assert.equal(splatChannelForTile(new Tile(0, 0, TileType.DIRT)), SPLAT_DIRT);
    assert.equal(splatChannelForTile(new Tile(0, 0, TileType.FOREST)), SPLAT_FOREST);
  });

  test('road/river inherit the underlying base channel', () => {
    const road = new Tile(0, 0, TileType.GRASS);
    road.path = PathType.ROAD;
    assert.equal(splatChannelForTile(road), SPLAT_GRASS);

    const river = new Tile(0, 0, TileType.DIRT);
    river.path = PathType.RIVER;
    assert.equal(splatChannelForTile(river), SPLAT_DIRT);
  });

  test('building base (dirt) maps to dirt channel', () => {
    const b = new Tile(0, 0, TileType.BUILDING);
    assert.equal(splatChannelForTile(b), SPLAT_DIRT);
    assert.equal(StructureType.BUILDING, b.structure);
  });
});

describe('terrain-splat — vertexSplatWeights', () => {
  test('centre vertex is 100% own', () => {
    const w = vertexSplatWeights(SPLAT_DIRT, [SPLAT_GRASS, SPLAT_GRASS], true);
    assert.deepEqual(w, [0, 1, 0]);
  });

  test('weights always normalize to 1', () => {
    for (const own of [0, 1, 2]) {
      for (const nbrs of [[0, 1], [2, null], [null, null], [1, 2]]) {
        const w = vertexSplatWeights(own, nbrs, false);
        const s = w[0] + w[1] + w[2];
        assert.ok(Math.abs(s - 1) < 1e-9, `sum ${s} for own=${own} nbrs=${nbrs}`);
        for (const c of w) assert.ok(c >= 0, 'no negative weight');
      }
    }
  });

  test('default blendShare gives symmetric incident average', () => {
    // grass own, one dirt + one grass neighbour → incident {grass,grass,dirt}
    const w = vertexSplatWeights(SPLAT_GRASS, [SPLAT_DIRT, SPLAT_GRASS], false);
    assert.ok(Math.abs(w[SPLAT_GRASS] - 2 / 3) < 1e-9);
    assert.ok(Math.abs(w[SPLAT_DIRT] - 1 / 3) < 1e-9);
  });

  test('lower blendShare sharpens toward own', () => {
    const avg = vertexSplatWeights(SPLAT_GRASS, [SPLAT_DIRT, SPLAT_DIRT], false, { blendShare: 0.5 });
    const sharp = vertexSplatWeights(SPLAT_GRASS, [SPLAT_DIRT, SPLAT_DIRT], false, { blendShare: 0.25 });
    assert.ok(sharp[SPLAT_GRASS] > avg[SPLAT_GRASS], 'lower blendShare → more own');
  });

  test('off-map neighbours (null) are excluded from the average', () => {
    const w = vertexSplatWeights(SPLAT_GRASS, [SPLAT_DIRT, null], false);
    // incident {grass, dirt} → 50/50
    assert.ok(Math.abs(w[SPLAT_GRASS] - 0.5) < 1e-9);
    assert.ok(Math.abs(w[SPLAT_DIRT] - 0.5) < 1e-9);
  });
});

describe('terrain-splat — hexSplatWeights edge symmetry', () => {
  // Build a mixed patch and verify that every vertex shared by multiple hexes
  // (by exact world position) carries identical splat weights from each hex's
  // perspective. This is the GPU-interpolation continuity contract.
  test('coincident vertices have identical weights across a mixed grid', () => {
    const tiles = new Map();
    const set = (c, r, type) => tiles.set(`${c},${r}`, new Tile(c, r, type));
    // 4×4 patch with grass/dirt/forest mixed, incl. odd & even rows.
    const types = [
      [TileType.GRASS, TileType.DIRT, TileType.GRASS, TileType.FOREST],
      [TileType.DIRT, TileType.FOREST, TileType.DIRT, TileType.GRASS],
      [TileType.GRASS, TileType.GRASS, TileType.FOREST, TileType.DIRT],
      [TileType.FOREST, TileType.DIRT, TileType.GRASS, TileType.GRASS],
    ];
    for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) set(c, r, types[r][c]);

    const channelAt = (c, r) => {
      const t = tiles.get(`${c},${r}`);
      return t ? splatChannelForTile(t) : null;
    };

    // worldPosKey → first-seen weight vector
    const seen = new Map();
    for (const tile of tiles.values()) {
      const weights = hexSplatWeights(tile, channelAt);
      const verts = fanWorldVerts(tile.col, tile.row);
      for (let v = 0; v < 7; v++) {
        const k = posKey(verts[v]);
        const w = [weights[v * 3], weights[v * 3 + 1], weights[v * 3 + 2]];
        if (seen.has(k)) {
          const prev = seen.get(k);
          for (let ch = 0; ch < 3; ch++) {
            assert.ok(
              Math.abs(prev[ch] - w[ch]) < 1e-6,
              `coincident vertex ${k} weight mismatch ch${ch}: ${prev[ch]} vs ${w[ch]} ` +
              `(tile ${tile.col},${tile.row})`,
            );
          }
        } else {
          seen.set(k, w);
        }
      }
    }
    assert.ok(seen.size > 0);
  });

  test('returns Float32Array of 7*3 with normalized rows', () => {
    const tile = new Tile(1, 1, TileType.GRASS);
    const w = hexSplatWeights(tile, () => null);
    assert.ok(w instanceof Float32Array);
    assert.equal(w.length, 7 * SPLAT_CHANNELS);
    for (let v = 0; v < 7; v++) {
      const s = w[v * 3] + w[v * 3 + 1] + w[v * 3 + 2];
      assert.ok(Math.abs(s - 1) < 1e-6, `vertex ${v} sum ${s}`);
    }
  });

  test('isolated hex (all neighbours off-map) is 100% own everywhere', () => {
    const tile = new Tile(0, 0, TileType.DIRT);
    const w = hexSplatWeights(tile, () => null);
    for (let v = 0; v < 7; v++) {
      assert.ok(Math.abs(w[v * 3 + SPLAT_DIRT] - 1) < 1e-9, `vertex ${v} not all dirt`);
    }
  });
});

describe('terrain-splat — worldToHex round-trips hexToWorld', () => {
  test('exact round-trip for odd/even/negative rows', () => {
    for (let row = -4; row <= 8; row++) {
      for (let col = -4; col <= 8; col++) {
        const { x, z } = hexToWorld(col, row, R);
        const back = worldToHex(x, z, R);
        assert.deepEqual(
          back, { col, row },
          `round-trip failed at (${col},${row}) → world(${x},${z}) → (${back.col},${back.row})`,
        );
      }
    }
  });

  test('points jittered toward a hex centre still resolve to that hex', () => {
    for (const [col, row] of [[3, 2], [4, 5], [0, 0], [6, 7]]) {
      const { x, z } = hexToWorld(col, row, R);
      for (const [dx, dz] of [[0.2, 0.1], [-0.15, 0.2], [0.1, -0.25]]) {
        const back = worldToHex(x + dx, z + dz, R);
        assert.deepEqual(back, { col, row }, `jitter at (${col},${row}) d(${dx},${dz})`);
      }
    }
  });
});

describe('terrain-splat — proceduralTerrainColor', () => {
  test('deterministic for the same inputs', () => {
    const a = proceduralTerrainColor(SPLAT_GRASS, 3.2, 5.7);
    const b = proceduralTerrainColor(SPLAT_GRASS, 3.2, 5.7);
    assert.deepEqual(a, b);
  });

  test('output stays in [0,1] across a sweep', () => {
    for (const ch of [0, 1, 2]) {
      for (let x = -10; x <= 10; x += 1.3) {
        for (let z = -10; z <= 10; z += 1.7) {
          const c = proceduralTerrainColor(ch, x, z);
          for (const v of c) assert.ok(v >= 0 && v <= 1, `channel ${ch} (${x},${z}) → ${v}`);
        }
      }
    }
  });

  test('different channels produce different base hues', () => {
    const g = proceduralTerrainColor(SPLAT_GRASS, 0, 0);
    const d = proceduralTerrainColor(SPLAT_DIRT, 0, 0);
    assert.notDeepEqual(g, d);
  });

  test('variation actually moves the colour around', () => {
    const samples = new Set();
    for (let x = 0; x < 30; x += 2.5) {
      samples.add(proceduralTerrainColor(SPLAT_FOREST, x, x * 0.5)[1].toFixed(4));
    }
    assert.ok(samples.size > 3, 'forest green should vary across space');
  });

  test('valueNoise2D stays in [0,1]', () => {
    for (let i = 0; i < 50; i++) {
      const n = valueNoise2D(i * 0.37, i * -0.21);
      assert.ok(n >= 0 && n <= 1, `noise ${n}`);
    }
  });

  test('three default tints are defined', () => {
    assert.equal(DEFAULT_TERRAIN_TINTS.length, 3);
  });
});

describe('terrain-splat — hexFogWeights', () => {
  function neighborKeys(col, row) {
    return neighborDeltas(row).map(([dc, dr]) => `${col + dc},${row + dr}`);
  }

  test('fully fogged hex → all-1, fully clear → all-0', () => {
    const fogged = new Set(['5,5']);
    // surround 5,5 with fog too for the all-1 case
    for (const k of neighborKeys(5, 5)) fogged.add(k);
    const w = hexFogWeights('5,5', neighborKeys(5, 5), fogged);
    for (let i = 0; i < 7; i++) assert.equal(w[i], 1, `vertex ${i}`);

    const clear = hexFogWeights('5,5', neighborKeys(5, 5), new Set());
    for (let i = 0; i < 7; i++) assert.equal(clear[i], 0, `vertex ${i}`);
  });

  test('crisp default (softness=0): rim equals own → uniform fog per hex', () => {
    // 3,3 fogged; nothing else. Crisp default sets all 7 verts to own — the
    // GPU then has no in-hex gradient and the boundary jumps sharply to the
    // neighbour's value, producing a clear "you cannot see this hex" signal.
    const fogged = new Set(['3,3']);
    const w = hexFogWeights('3,3', neighborKeys(3, 3), fogged);
    for (let i = 0; i < 7; i++) assert.equal(w[i], 1, `vertex ${i} = own`);
    const clear = hexFogWeights('4,3', neighborKeys(4, 3), fogged);
    for (let i = 0; i < 7; i++) assert.equal(clear[i], 0, `vertex ${i} = own`);
  });

  test('soft veil edge (softness=1, opt-in): rim toward a clear neighbour is partial', () => {
    const fogged = new Set(['3,3']);
    const w = hexFogWeights('3,3', neighborKeys(3, 3), fogged, { softness: 1 });
    assert.equal(w[0], 1, 'centre fully fogged');
    let hasPartial = false;
    for (let i = 1; i < 7; i++) {
      assert.ok(w[i] > 0 && w[i] < 1, `rim ${i} should be partial, got ${w[i]}`);
      hasPartial = true;
    }
    assert.ok(hasPartial);
  });

  test('softness=1 preserves coincident-vertex symmetry across adjacent hexes', () => {
    // The old soft-edge contract: coincident rim verts on adjacent hexes carry
    // the same averaged value so the GPU interpolation matches across the
    // shared edge. Crisp default deliberately breaks this at the fog boundary
    // (that IS the visible jump); softness=1 still preserves it.
    const fogged = new Set(['2,2']);
    const cells = [];
    for (let r = 1; r <= 3; r++) for (let c = 1; c <= 3; c++) cells.push([c, r]);
    const seen = new Map();
    for (const [c, r] of cells) {
      const w = hexFogWeights(`${c},${r}`, neighborKeys(c, r), fogged, { softness: 1 });
      const verts = fanWorldVerts(c, r);
      for (let v = 0; v < 7; v++) {
        const k = posKey(verts[v]);
        if (seen.has(k)) {
          assert.ok(Math.abs(seen.get(k) - w[v]) < 1e-6,
            `fog mismatch at ${k}: ${seen.get(k)} vs ${w[v]} (hex ${c},${r})`);
        } else {
          seen.set(k, w[v]);
        }
      }
    }
  });
});

describe('hexGridAlphaForZoom (hex wireframe distance fade)', () => {
  test('peaks at the close-in zoom (radius = minR)', () => {
    assert.equal(hexGridAlphaForZoom(4, 4, 30, { peak: 0.5 }), 0.5);
  });
  test('drops to minVisible at the far zoom (radius = maxR)', () => {
    assert.equal(hexGridAlphaForZoom(30, 4, 30, { peak: 0.5, minVisible: 0 }), 0);
  });
  test('mid-range is between the two extremes (smoothstep, monotonic)', () => {
    const a = hexGridAlphaForZoom(10, 4, 30, { peak: 0.5 });
    const b = hexGridAlphaForZoom(20, 4, 30, { peak: 0.5 });
    assert.ok(a > b && a < 0.5 && b > 0, `expected close > far > 0, got ${a} > ${b}`);
  });
  test('clamps outside [minR, maxR]', () => {
    assert.equal(hexGridAlphaForZoom(1,  4, 30, { peak: 0.5 }), 0.5);
    assert.equal(hexGridAlphaForZoom(99, 4, 30, { peak: 0.5 }), 0);
  });
  test('degenerate range returns peak', () => {
    assert.equal(hexGridAlphaForZoom(5, 10, 10, { peak: 0.3 }), 0.3);
  });
});
