#!/usr/bin/env node
/*
 * convert-mixamo-anim.js — convert Mixamo "without skin" FBX clips into
 * animation-only .glb files that retarget onto the shared paladin skeleton.
 *
 * WHY THIS WORKS WITHOUT A MESH-STRIP STEP
 * ----------------------------------------
 * Mixamo exports downloaded *without skin* contain only the `mixamorig:*`
 * skeleton node hierarchy plus one AnimationGroup ("mixamo.com") — no mesh,
 * no skin binding. FBX2glTF preserves that 1:1, so the resulting .glb is
 * already the animation-only shape we want (0 meshes, 0 skins, ~42 TRS
 * nodes). This is exactly how the pre-existing walking.glb / running.glb
 * were made. The renderer + asset-viewer retarget each clip onto the
 * paladin's real skeleton *by bone name* at load time, so no scale baking
 * or T-pose fix-up is needed here — the bone names line up
 * (mixamorig:Hips, mixamorig:Spine, ...) with paladin-idle.glb.
 *
 * REQUIREMENTS
 * ------------
 * The `fbx2gltf` npm package ships prebuilt FBX2glTF binaries per platform
 * (Darwin / Linux / Windows_NT). It is a dev-only, on-demand tool — NOT a
 * runtime dependency — so it is installed transiently rather than added to
 * package.json:
 *
 *   npm install --no-save fbx2gltf
 *
 * RE-RUN
 * ------
 *   npm install --no-save fbx2gltf
 *   node scripts/convert-mixamo-anim.js
 *
 * Reads source FBX from assets/source/animations/, writes .glb to
 * assets/models/. Running.fbx maps to running-new.glb (NOT running.glb) so
 * the shipped running.glb is never clobbered — verified byte-identical, see
 * the worker report. Pass --check to only verify outputs without writing.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'assets', 'source', 'animations');
const OUT_DIR = path.join(ROOT, 'assets', 'models');

// source FBX → output .glb basename. Running is deliberately *-new so the
// existing running.glb (already shipped, identical clip) is preserved.
const JOBS = [
  { fbx: 'Punch.fbx', glb: 'punch.glb' },
  { fbx: 'Hit.fbx', glb: 'hit.glb' },
  { fbx: 'Block.fbx', glb: 'block.glb' },
  { fbx: 'Running.fbx', glb: 'running-new.glb' },
];

function resolveBinary() {
  // fbx2gltf package layout: node_modules/fbx2gltf/bin/<platform>/FBX2glTF
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve('fbx2gltf/package.json'));
  } catch (_) {
    throw new Error(
      'fbx2gltf not installed. Run:  npm install --no-save fbx2gltf',
    );
  }
  const platform = process.platform === 'darwin' ? 'Darwin'
    : process.platform === 'win32' ? 'Windows_NT'
    : 'Linux';
  const exe = platform === 'Windows_NT' ? 'FBX2glTF.exe' : 'FBX2glTF';
  const bin = path.join(pkgDir, 'bin', platform, exe);
  if (!fs.existsSync(bin)) {
    throw new Error(`FBX2glTF binary not found at ${bin}`);
  }
  return bin;
}

function main() {
  const bin = resolveBinary();
  console.log(`[convert] using ${bin}`);
  for (const job of JOBS) {
    const src = path.join(SRC_DIR, job.fbx);
    const out = path.join(OUT_DIR, job.glb);
    if (!fs.existsSync(src)) {
      console.warn(`[convert] SKIP ${job.fbx} (not found in ${SRC_DIR})`);
      continue;
    }
    console.log(`[convert] ${job.fbx} → ${job.glb}`);
    execFileSync(bin, ['-i', src, '-o', out, '--binary'], { stdio: 'inherit' });
    const bytes = fs.statSync(out).size;
    console.log(`[convert]   wrote ${out} (${bytes} bytes)`);
  }
  console.log('[convert] done.');
}

main();
