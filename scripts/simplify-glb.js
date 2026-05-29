/**
 * scripts/simplify-glb.js
 *
 * Look-preserving GLB mesh simplification for the offline asset pipeline.
 *
 * Decimates a GLB to ~`targetTris` triangles using meshoptimizer's error-bounded
 * simplifier (via gltf-transform). Error bounding is what preserves the look:
 * vertices only collapse while the geometric error stays under `error`, so
 * silhouettes survive. Welding first merges coincident vertices so the simplifier
 * can collapse edges across the seams the generator leaves behind. Materials,
 * textures and UV sets are untouched (we never strip them).
 *
 * These are devDependencies (offline tooling) — keep this module out of the
 * runtime/test import path of the game itself.
 */

import { NodeIO } from '@gltf-transform/core';
import { simplify, weld, getGLPrimitiveCount } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';

/** Total GL triangle count across all meshes/primitives in a Document. */
export function countTris(doc) {
  let t = 0;
  for (const mesh of doc.getRoot().listMeshes())
    for (const prim of mesh.listPrimitives()) t += getGLPrimitiveCount(prim);
  return t;
}

/**
 * Simplify the GLB at `srcPath` down toward `targetTris` and write to `destPath`.
 *
 * @param {string} srcPath     input GLB path
 * @param {string} destPath    output GLB path (may equal srcPath)
 * @param {number} targetTris  target triangle count
 * @param {number} [error]     meshopt error bound (default 0.01; higher = more aggressive)
 * @returns {Promise<{before:number, after:number, hitTarget:boolean,
 *                     materials:number, textures:number}>}
 */
export async function simplifyGlb(srcPath, destPath, targetTris, error = 0.01) {
  const io  = new NodeIO();
  const doc = await io.read(srcPath);
  const before = countTris(doc);

  if (before <= targetTris) {
    // Already at/under target — copy through unchanged.
    await io.write(destPath, doc);
    return {
      before,
      after: before,
      hitTarget: true,
      materials: doc.getRoot().listMaterials().length,
      textures:  doc.getRoot().listTextures().length,
    };
  }

  const ratio = targetTris / before;
  await MeshoptSimplifier.ready;
  await doc.transform(
    weld(),
    simplify({ simplifier: MeshoptSimplifier, ratio, error }),
  );

  const after = countTris(doc);
  await io.write(destPath, doc);
  // The error bound can stop decimation short of the ratio; that's intended
  // (look preservation wins). Treat "within 10% of target" as on-target.
  return {
    before,
    after,
    hitTarget: after <= targetTris * 1.1,
    materials: doc.getRoot().listMaterials().length,
    textures:  doc.getRoot().listTextures().length,
  };
}
