// Per-vertex terrain tint — subtle multiplicative RGB jitter applied AFTER
// the splat blend so a hex doesn't read as one flat colour. Tests the pure
// helpers in src/terrain-splat.js: determinism, range, the per-vertex
// distribution, and the load-bearing EDGE-SYMMETRY contract (coincident
// corners on adjacent hexes must hash to identical tints, otherwise the
// boundary visibly seams).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  vertexTintAt,
  hexTintWeights,
  DEFAULT_TINT_AMP,
} from '../src/terrain-splat.js';
import { hexToWorld } from '../src/renderer-3d.js';

const R = 1;

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

describe('vertexTintAt — determinism and range', () => {
  test('deterministic for the same world position', () => {
    const a = vertexTintAt(2.5, -1.3);
    const b = vertexTintAt(2.5, -1.3);
    assert.deepEqual(a, b);
  });

  test('stays within ±DEFAULT_TINT_AMP of 1.0 on a sweep', () => {
    for (let x = -10; x <= 10; x += 0.7) {
      for (let z = -10; z <= 10; z += 0.7) {
        const t = vertexTintAt(x, z);
        for (const v of t) {
          assert.ok(
            v >= 1 - DEFAULT_TINT_AMP - 1e-9 && v <= 1 + DEFAULT_TINT_AMP + 1e-9,
            `tint ${v} out of range at (${x},${z})`,
          );
        }
      }
    }
  });

  test('mean across many points is ~1.0', () => {
    let sumR = 0, sumG = 0, sumB = 0, n = 0;
    for (let x = -8; x < 8; x += 0.3) {
      for (let z = -8; z < 8; z += 0.3) {
        const t = vertexTintAt(x, z);
        sumR += t[0]; sumG += t[1]; sumB += t[2]; n++;
      }
    }
    // Within ±0.01 of 1.0 across a few thousand samples is comfortable for
    // a fract(sin) hash — well-distributed enough not to drift the look.
    assert.ok(Math.abs(sumR / n - 1) < 0.01, `meanR ${sumR / n}`);
    assert.ok(Math.abs(sumG / n - 1) < 0.01, `meanG ${sumG / n}`);
    assert.ok(Math.abs(sumB / n - 1) < 0.01, `meanB ${sumB / n}`);
  });

  test('R/G/B vary independently (not the same hash on all channels)', () => {
    // Pick a sample where r, g, b should differ — fewer than 1 in 10 random
    // hashes collide perfectly, so among 50 points at least some should split.
    let split = 0;
    for (let i = 0; i < 50; i++) {
      const t = vertexTintAt(i * 1.7, i * -0.9);
      if (t[0] !== t[1] || t[1] !== t[2]) split++;
    }
    assert.ok(split > 40, `expected most samples to have unequal channels, got ${split}/50`);
  });

  test('amp option scales the range', () => {
    const wide = vertexTintAt(1.5, 2.5, { amp: 0.2 });
    const tight = vertexTintAt(1.5, 2.5, { amp: 0.02 });
    // The hash is the same — only the multiplier differs. So the deviations
    // from 1.0 should be in a 0.2 : 0.02 = 10 : 1 ratio.
    for (let i = 0; i < 3; i++) {
      const dWide = wide[i] - 1;
      const dTight = tight[i] - 1;
      // Skip the (vanishingly rare) case where the hash sits exactly on 0.5
      // and both deltas are zero — guard the divisor.
      if (Math.abs(dTight) < 1e-12) continue;
      assert.ok(Math.abs(dWide / dTight - 10) < 1e-6,
        `amp ratio not 10:1 at channel ${i} (${dWide} vs ${dTight})`);
    }
  });
});

describe('hexTintWeights — shape and per-vertex variation', () => {
  test('returns Float32Array(7*3)', () => {
    const w = hexTintWeights(3, 4);
    assert.ok(w instanceof Float32Array);
    assert.equal(w.length, 21);
  });

  test('within a hex, the 7 vertex tints are not all identical', () => {
    const w = hexTintWeights(2, 3);
    const sigs = new Set();
    for (let v = 0; v < 7; v++) {
      sigs.add(`${w[v * 3].toFixed(6)},${w[v * 3 + 1].toFixed(6)},${w[v * 3 + 2].toFixed(6)}`);
    }
    assert.ok(sigs.size >= 5, `expected ≥5 distinct vertex tints, got ${sigs.size}`);
  });

  test('all 21 values lie in [1-amp, 1+amp]', () => {
    const w = hexTintWeights(5, 6, { amp: 0.08 });
    for (const v of w) {
      assert.ok(v >= 0.92 - 1e-9 && v <= 1.08 + 1e-9, `out of range: ${v}`);
    }
  });
});

describe('terrain tint — coincident-vertex edge symmetry', () => {
  // The contract: at every world position shared by ≥2 hexes (a corner), each
  // owning hex must emit the same tint, otherwise interpolation across the
  // shared edge breaks and a colour seam appears. Same test pattern as the
  // splat-weights edge-symmetry test.
  test('coincident corners across a 4×4 patch have identical tints', () => {
    const seen = new Map();
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        const w = hexTintWeights(col, row, { radius: R });
        const verts = fanWorldVerts(col, row);
        for (let v = 0; v < 7; v++) {
          const k = posKey(verts[v]);
          const t = [w[v * 3], w[v * 3 + 1], w[v * 3 + 2]];
          if (seen.has(k)) {
            const prev = seen.get(k);
            for (let ch = 0; ch < 3; ch++) {
              assert.ok(
                Math.abs(prev[ch] - t[ch]) < 1e-6,
                `tint mismatch at coincident vertex ${k} ch${ch}: ` +
                `${prev[ch]} vs ${t[ch]} (hex ${col},${row})`,
              );
            }
          } else {
            seen.set(k, t);
          }
        }
      }
    }
    assert.ok(seen.size > 0);
  });

  test('odd & negative rows preserve the same edge-symmetry contract', () => {
    const seen = new Map();
    for (let row = -2; row <= 2; row++) {
      for (let col = -2; col <= 2; col++) {
        const w = hexTintWeights(col, row, { radius: R });
        const verts = fanWorldVerts(col, row);
        for (let v = 0; v < 7; v++) {
          const k = posKey(verts[v]);
          const t = [w[v * 3], w[v * 3 + 1], w[v * 3 + 2]];
          if (seen.has(k)) {
            const prev = seen.get(k);
            for (let ch = 0; ch < 3; ch++) {
              assert.ok(Math.abs(prev[ch] - t[ch]) < 1e-6,
                `tint mismatch at ${k} ch${ch} (hex ${col},${row})`);
            }
          } else {
            seen.set(k, t);
          }
        }
      }
    }
  });
});
