// Pure-helper tests for the ribbon face-normal contract used by the 3D
// renderer's river/road networks.
//
// The renderer builds each ribbon stroke by passing two parallel offset paths
// to `MeshBuilder.CreateRibbon`. The order of those two paths determines the
// winding of the emitted triangles, and therefore the direction of the face
// normal. The only HemisphericLight in the scene points +Y; if the normal
// ends up pointing −Y, the visible top face is the back face and reads as
// near-black (only the underside is lit).
//
// PR #322 (flatten tube → ribbon) used `pathArray = [leftV3, rightV3]`, which
// for our perpendicular-offset convention (left = +Z side, right = −Z side
// when travelling +X) yields normals pointing −Y. PR #323 papered over the
// symptom by adding `emissiveColor = 0.15 × diffuse`, but for the genuinely-
// dark TILE_COLORs of road (`#6b5a3e`) and river (`#1a3d5c`) that scaled-down
// emissive was still essentially black, leaving the ribbons reading as black
// strips on top of the brighter terrain — exactly the operator's complaint.
//
// This PR's fix flips the path order to `[rightV3, leftV3]` so the natural
// face normal points +Y. These tests pin that contract.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ribbonOffsetPaths,
  ribbonFaceNormal,
  sampleQuadBezier,
  HEMI_GROUND_SCALE,
  PHASE_LIGHT_CONFIG,
} from '../src/renderer-3d.js';

const at = (xs, i, y) => ({ x: xs[i].x, y, z: xs[i].z });

describe('ribbonFaceNormal — geometry sanity', () => {
  test('returns a unit vector', () => {
    const n = ribbonFaceNormal(
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: -1 },
      { x: 1, y: 0, z: 0 },
    );
    const len = Math.hypot(n.x, n.y, n.z);
    assert.ok(Math.abs(len - 1) < 1e-9, `expected unit length, got ${len}`);
  });

  test('flat-XZ triangle with right→left winding faces +Y', () => {
    // right = (0,0,-1), left = (0,0,+1); next-right = (1,0,-1).
    // CreateRibbon's first triangle = (path0[0], path1[0], path0[1])
    //                              = (right[0], left[0], right[1]).
    const n = ribbonFaceNormal(
      { x: 0, y: 0, z: -1 }, // path0[0] = right[0]
      { x: 0, y: 0, z: +1 }, // path1[0] = left[0]
      { x: 1, y: 0, z: -1 }, // path0[1] = right[1]
    );
    assert.ok(n.y > 0.999, `normal Y should be +1, got ${n.y}`);
  });

  test('flat-XZ triangle with left→right winding faces −Y (regression of PR #322)', () => {
    const n = ribbonFaceNormal(
      { x: 0, y: 0, z: +1 }, // path0[0] = left[0]
      { x: 0, y: 0, z: -1 }, // path1[0] = right[0]
      { x: 1, y: 0, z: +1 }, // path0[1] = left[1]
    );
    assert.ok(n.y < -0.999, `normal Y should be −1, got ${n.y}`);
  });
});

describe('ribbon path order — integration with offset paths', () => {
  // What we actually feed into CreateRibbon is `[right, left]` (NOT
  // `[left, right]`), so the resulting normal points +Y for any forward-going
  // stroke. We sample a curved bezier and verify the normal at multiple
  // segments along the path.
  test('[right, left] ordering yields +Y normals along a curved stroke', () => {
    const pts = sampleQuadBezier({ x: 0, z: 0 }, { x: 2, z: 1 }, { x: 4, z: -1 }, 8);
    const { left, right } = ribbonOffsetPaths(pts, 0.6);

    for (let i = 0; i < pts.length - 1; i++) {
      const n = ribbonFaceNormal(
        at(right, i,     0.085),
        at(left,  i,     0.085),
        at(right, i + 1, 0.085),
      );
      assert.ok(n.y > 0.9,
        `[right,left] segment ${i}: normal Y = ${n.y}, expected ≈ +1`);
    }
  });

  test('[left, right] ordering would yield −Y normals (this is what we are avoiding)', () => {
    const pts = sampleQuadBezier({ x: 0, z: 0 }, { x: 2, z: 1 }, { x: 4, z: -1 }, 8);
    const { left, right } = ribbonOffsetPaths(pts, 0.6);

    for (let i = 0; i < pts.length - 1; i++) {
      const n = ribbonFaceNormal(
        at(left,  i,     0.085),
        at(right, i,     0.085),
        at(left,  i + 1, 0.085),
      );
      assert.ok(n.y < -0.9,
        `[left,right] segment ${i}: normal Y = ${n.y}, expected ≈ −1`);
    }
  });
});

describe('HEMI_GROUND_SCALE — under-side ambient floor', () => {
  // The hemispheric light's groundColor was defaulting to (0,0,0), which
  // turned any face pointing away from the +Y light into a pure-black
  // silhouette — load-bearing for the ribbon's underside when the camera is
  // tilted. _applyLightConfig now sets groundColor = HEMI_GROUND_SCALE ×
  // diffuse, so this constant guards both "not zero" (the bug it fixes) and
  // "not 1.0" (which would erase the lit/unlit contrast on the terrain).
  test('non-zero — defends against pure-black underside (current bug)', () => {
    assert.ok(HEMI_GROUND_SCALE > 0,
      `HEMI_GROUND_SCALE must be positive — was ${HEMI_GROUND_SCALE}`);
  });

  test('comfortably below the diffuse so hemi contrast is preserved', () => {
    assert.ok(HEMI_GROUND_SCALE < 0.6,
      `HEMI_GROUND_SCALE must stay well under 1.0 to keep terrain hemi contrast — was ${HEMI_GROUND_SCALE}`);
  });

  test('keeps every phase\'s ground tint non-zero across all channels', () => {
    // groundColor = HEMI_GROUND_SCALE × cfg.color. Phase configs should never
    // hit pure zero on any channel, otherwise the underside still goes black
    // on that channel even with groundColor enabled.
    for (const [phase, cfg] of Object.entries(PHASE_LIGHT_CONFIG)) {
      const r = cfg.color.r * HEMI_GROUND_SCALE;
      const g = cfg.color.g * HEMI_GROUND_SCALE;
      const b = cfg.color.b * HEMI_GROUND_SCALE;
      assert.ok(r > 0 && g > 0 && b > 0,
        `phase ${phase}: ground tint has zero channel (r=${r}, g=${g}, b=${b})`);
    }
  });
});
