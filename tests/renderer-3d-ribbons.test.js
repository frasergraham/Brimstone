// Pure-helper tests for the flat-ribbon offset math used by the 3D renderer's
// river/road networks. The renderer feeds the two returned `{x, z}` arrays
// into MeshBuilder.CreateRibbon at a constant Y; the strip lies flat on the
// terrain and retains the bezier curve shape in the XZ plane.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ribbonOffsetPaths,
  sampleQuadBezier,
  ribbonMaterialColors,
  RIVER_RIBBON_WIDTH,
  ROAD_RIBBON_WIDTH,
  RIBBON_EMISSIVE_SCALE,
} from '../src/renderer-3d.js';
import { TileType, TILE_COLOR } from '../src/tiles.js';

const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const APPROX = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

describe('ribbonOffsetPaths — degenerate inputs', () => {
  test('non-array input returns empty paths', () => {
    assert.deepEqual(ribbonOffsetPaths(null, 1), { left: [], right: [] });
    assert.deepEqual(ribbonOffsetPaths(undefined, 1), { left: [], right: [] });
  });

  test('fewer than 2 points returns empty paths (no tangent available)', () => {
    assert.deepEqual(ribbonOffsetPaths([], 1), { left: [], right: [] });
    assert.deepEqual(ribbonOffsetPaths([{ x: 0, z: 0 }], 1), { left: [], right: [] });
  });
});

describe('ribbonOffsetPaths — same length as input', () => {
  test('output left/right arrays have one entry per input point', () => {
    const pts = sampleQuadBezier({ x: 0, z: 0 }, { x: 1, z: 1 }, { x: 2, z: 0 }, 10);
    const { left, right } = ribbonOffsetPaths(pts, 0.5);
    assert.equal(left.length, pts.length);
    assert.equal(right.length, pts.length);
  });

  test('straight 2-point stub produces 2 entries on each side', () => {
    const { left, right } = ribbonOffsetPaths(
      [{ x: 0, z: 0 }, { x: 1, z: 0 }],
      0.3,
    );
    assert.equal(left.length, 2);
    assert.equal(right.length, 2);
  });
});

describe('ribbonOffsetPaths — equidistant from the source points', () => {
  test('each left/right pair is exactly width/2 from its source point', () => {
    const pts = sampleQuadBezier({ x: 0, z: 0 }, { x: 1, z: 2 }, { x: 4, z: 0 }, 12);
    const width = 0.7;
    const half = width / 2;
    const { left, right } = ribbonOffsetPaths(pts, width);
    for (let i = 0; i < pts.length; i++) {
      assert.ok(APPROX(dist(pts[i], left[i]),  half, 1e-9),
        `left[${i}] distance ${dist(pts[i], left[i])} != ${half}`);
      assert.ok(APPROX(dist(pts[i], right[i]), half, 1e-9),
        `right[${i}] distance ${dist(pts[i], right[i])} != ${half}`);
    }
  });

  test('left and right are on opposite sides — distance between them = width', () => {
    const pts = sampleQuadBezier({ x: 0, z: 0 }, { x: 2, z: 3 }, { x: 5, z: 1 }, 10);
    const width = 1.0;
    const { left, right } = ribbonOffsetPaths(pts, width);
    for (let i = 0; i < pts.length; i++) {
      assert.ok(APPROX(dist(left[i], right[i]), width, 1e-9),
        `gap ${dist(left[i], right[i])} != ${width} at i=${i}`);
    }
  });
});

describe('ribbonOffsetPaths — perpendicular to the local tangent', () => {
  // For each interior point i, the offset vector (left[i] − points[i]) must be
  // perpendicular to the central-difference tangent (points[i+1] − points[i−1]).
  // Dot product → 0.
  test('interior offset vectors are perpendicular to central-difference tangent', () => {
    const pts = sampleQuadBezier({ x: 0, z: 0 }, { x: 1, z: 4 }, { x: 6, z: 1 }, 16);
    const { left } = ribbonOffsetPaths(pts, 0.4);
    for (let i = 1; i < pts.length - 1; i++) {
      const tx = pts[i + 1].x - pts[i - 1].x;
      const tz = pts[i + 1].z - pts[i - 1].z;
      const ox = left[i].x - pts[i].x;
      const oz = left[i].z - pts[i].z;
      const dot = tx * ox + tz * oz;
      assert.ok(APPROX(dot, 0, 1e-9),
        `interior point ${i}: offset·tangent = ${dot}, expected 0`);
    }
  });

  test('endpoint offsets are perpendicular to forward/backward difference tangent', () => {
    const pts = sampleQuadBezier({ x: 0, z: 0 }, { x: 1, z: 4 }, { x: 6, z: 1 }, 8);
    const { left } = ribbonOffsetPaths(pts, 0.4);
    const n = pts.length;

    // First point: forward difference.
    {
      const tx = pts[1].x - pts[0].x;
      const tz = pts[1].z - pts[0].z;
      const ox = left[0].x - pts[0].x;
      const oz = left[0].z - pts[0].z;
      assert.ok(APPROX(tx * ox + tz * oz, 0, 1e-9));
    }
    // Last point: backward difference.
    {
      const tx = pts[n - 1].x - pts[n - 2].x;
      const tz = pts[n - 1].z - pts[n - 2].z;
      const ox = left[n - 1].x - pts[n - 1].x;
      const oz = left[n - 1].z - pts[n - 1].z;
      assert.ok(APPROX(tx * ox + tz * oz, 0, 1e-9));
    }
  });
});

describe('ribbonOffsetPaths — orientation', () => {
  test('for a straight east-going path, left = +Z side, right = −Z side', () => {
    // perp((1,0)) = (-0, 1) = (0, 1) → +Z, so left gets +z offset.
    const pts = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 2, z: 0 }];
    const { left, right } = ribbonOffsetPaths(pts, 0.5);
    for (let i = 0; i < 3; i++) {
      assert.ok(APPROX(left[i].x, pts[i].x), `left[${i}].x stays on axis`);
      assert.ok(APPROX(left[i].z, +0.25), `left[${i}].z = +0.25`);
      assert.ok(APPROX(right[i].z, -0.25), `right[${i}].z = -0.25`);
    }
  });
});

describe('ribbonMaterialColors — diffuse + emissive split', () => {
  // The 3D scene is lit by a single +Y hemispheric light, and CreateRibbon's
  // path-pair winding produces face normals pointing −Y for the road/river
  // ribbons (the underside catches the light). A small emissive keeps the
  // top face readable without making the network glow — without it the
  // ribbons read as solid black against the lit terrain.
  test('emissive is RIBBON_EMISSIVE_SCALE × diffuse component-wise', () => {
    const { diffuse, emissive } = ribbonMaterialColors('#8a5a2b');
    assert.equal(emissive.length, 3);
    for (let i = 0; i < 3; i++) {
      assert.ok(APPROX(emissive[i], diffuse[i] * RIBBON_EMISSIVE_SCALE, 1e-9),
        `channel ${i}: ${emissive[i]} != ${diffuse[i]} × ${RIBBON_EMISSIVE_SCALE}`);
    }
  });

  test('emissive scale is small but non-zero (modest lift, not full glow)', () => {
    assert.ok(RIBBON_EMISSIVE_SCALE > 0,
      `emissive scale must be positive — was ${RIBBON_EMISSIVE_SCALE}`);
    assert.ok(RIBBON_EMISSIVE_SCALE < 0.5,
      `emissive scale must stay subtle — was ${RIBBON_EMISSIVE_SCALE}`);
  });

  test('all diffuse channels are non-zero for road and river tile colours', () => {
    // Guards against TILE_COLOR slots accidentally becoming black/transparent
    // and dragging the ribbon down with them.
    for (const tt of [TileType.ROAD, TileType.RIVER]) {
      const { diffuse } = ribbonMaterialColors(TILE_COLOR[tt]);
      const sum = diffuse[0] + diffuse[1] + diffuse[2];
      assert.ok(sum > 0,
        `TILE_COLOR[${tt}] ribbon diffuse should not be all-black (sum=${sum})`);
    }
  });
});

describe('ribbon widths — river vs road sanity', () => {
  test('river ribbon is roughly half the hex-width (√3 ≈ 1.732)', () => {
    const hexW = Math.sqrt(3);
    assert.ok(RIVER_RIBBON_WIDTH > hexW * 0.35 && RIVER_RIBBON_WIDTH < hexW * 0.6,
      `river width ${RIVER_RIBBON_WIDTH} should be ~0.5 × hex-width ${hexW}`);
  });

  test('road ribbon is narrower than river but still readable (~0.35 × hex)', () => {
    const hexW = Math.sqrt(3);
    assert.ok(ROAD_RIBBON_WIDTH > hexW * 0.25 && ROAD_RIBBON_WIDTH < hexW * 0.45,
      `road width ${ROAD_RIBBON_WIDTH} should be ~0.35 × hex-width ${hexW}`);
  });
});
