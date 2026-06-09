#!/usr/bin/env node
/*
 * convert-character-fbx.js — convert a Mixamo character FBX (mesh + skeleton +
 * embedded idle) into a runtime-ready, retargetable .glb under assets/models/.
 *
 * This is the mesh-bearing companion to convert-mixamo-anim.js (which handles
 * animation-only "without skin" clips). Use it for the unit RIGS — the blank
 * mannequin that every unit falls back to, the zombie, and any future
 * <type>-idle.glb the renderer's rig cascade looks up by entity type.
 *
 * WHAT THE POST-PROCESS DOES (and why)
 * ------------------------------------
 * 1. NORMALISE BONE NAMES. Mixamo sometimes exports joints as `mixamorig1:Hips`
 *    instead of the canonical `mixamorig:Hips` (it appends a digit when the
 *    upload already carried a skeleton). The renderer retargets the shared
 *    walk/run/punch/hit/block clips onto a rig BY BONE NAME, and those clips
 *    target `mixamorig:` — so a `mixamorig1:` rig would T-pose the moment it
 *    moves. We rewrite `mixamorig<digits>:` → `mixamorig:` so every rig speaks
 *    the same skeleton dialect as the clip bank. (Channels/skins reference node
 *    OBJECTS, not names, so renaming is safe for the embedded idle.)
 * 2. STRIP or SHRINK textures. Mixamo ships 4K diffuse/normal/AO maps — ~28MB
 *    for the mannequin alone, pointless at board-token scale. `strip: true`
 *    drops every texture and leaves a single neutral material the renderer
 *    tints per owner (the "blank mannequin we colorize"). `maxTexture` instead
 *    resizes maps (for rigs whose skin we want to keep, e.g. the zombie).
 * 3. prune + dedup to drop the nodes/accessors the above orphan.
 *
 * REQUIREMENTS
 * ------------
 *   npm install --no-save fbx2gltf      # prebuilt FBX2glTF binary, dev-only
 *   (sharp is already a devDependency — used for texture resize)
 *
 * RUN
 * ---
 *   node scripts/convert-character-fbx.js            # all JOBS below
 *   node scripts/convert-character-fbx.js mannequin  # one job by glb basename
 *
 * Reads source FBX from assets/source/characters/, writes .glb to assets/models/.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { NodeIO } from '@gltf-transform/core';
import { prune, dedup, textureCompress } from '@gltf-transform/functions';
import sharp from 'sharp';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'assets', 'source', 'characters');
const OUT_DIR = path.join(ROOT, 'assets', 'models');

// source FBX → output .glb. `strip` makes a blank, tintable rig (mannequin);
// `maxTexture` keeps the skin but caps map resolution (zombie + future rigs).
const JOBS = [
  { fbx: 'Mannequin-Idle.fbx', glb: 'mannequin-idle.glb', strip: true },
  { fbx: 'Zombie-Idle.fbx',    glb: 'zombie-idle.glb',    maxTexture: 1024 },
];

function resolveBinary() {
  let pkgDir;
  try {
    pkgDir = path.dirname(require.resolve('fbx2gltf/package.json'));
  } catch (_) {
    throw new Error('fbx2gltf not installed. Run:  npm install --no-save fbx2gltf');
  }
  const platform = process.platform === 'darwin' ? 'Darwin'
    : process.platform === 'win32' ? 'Windows_NT' : 'Linux';
  const exe = platform === 'Windows_NT' ? 'FBX2glTF.exe' : 'FBX2glTF';
  const bin = path.join(pkgDir, 'bin', platform, exe);
  if (!fs.existsSync(bin)) throw new Error(`FBX2glTF binary not found at ${bin}`);
  return bin;
}

/** Rewrite `mixamorig<digits>:` → `mixamorig:` on every node so the rig matches
 *  the shared clip bank's bone names. Exported for tests. */
export function canonicaliseMixamoName(name) {
  if (typeof name !== 'string') return name;
  return name.replace(/^mixamorig\d+:/, 'mixamorig:');
}

async function postProcess(glbPath, job) {
  const io = new NodeIO();
  const doc = await io.read(glbPath);
  const root = doc.getRoot();

  // 1. Normalise bone names.
  let renamed = 0;
  for (const node of root.listNodes()) {
    const next = canonicaliseMixamoName(node.getName());
    if (next !== node.getName()) { node.setName(next); renamed++; }
  }

  // 2. Textures: strip to a tintable material, or cap resolution.
  if (job.strip) {
    for (const m of root.listMaterials()) {
      m.setBaseColorTexture(null);
      m.setNormalTexture(null);
      m.setMetallicRoughnessTexture(null);
      m.setOcclusionTexture(null);
      m.setEmissiveTexture(null);
      m.setBaseColorFactor([0.8, 0.8, 0.8, 1]); // neutral; runtime tints per owner
      m.setMetallicFactor(0.0);
      m.setRoughnessFactor(0.7);
    }
  } else if (job.maxTexture) {
    await doc.transform(textureCompress({
      encoder: sharp,
      resize: [job.maxTexture, job.maxTexture],
    }));
  }

  // 3. Drop orphans.
  await doc.transform(prune(), dedup());
  await io.write(glbPath, doc);

  const mb = (fs.statSync(glbPath).size / 1e6).toFixed(2);
  console.log(`[character]   post-processed (${renamed} bones renamed, ${root.listTextures().length} textures, ${mb}MB)`);
}

async function main() {
  const only = process.argv[2]; // optional glb basename filter, e.g. "mannequin"
  const bin = resolveBinary();
  console.log(`[character] using ${bin}`);
  for (const job of JOBS) {
    if (only && !job.glb.includes(only)) continue;
    const src = path.join(SRC_DIR, job.fbx);
    const out = path.join(OUT_DIR, job.glb);
    if (!fs.existsSync(src)) {
      console.warn(`[character] SKIP ${job.fbx} (not found in ${SRC_DIR})`);
      continue;
    }
    console.log(`[character] ${job.fbx} → ${job.glb}`);
    execFileSync(bin, ['-i', src, '-o', out, '--binary'], { stdio: 'inherit' });
    await postProcess(out, job);
    // Validate the result against the Mixamo-standard targets (scale, feet
    // origin, Hips height, …). Non-zero exit = a check failed; it's already
    // printed, and we don't abort the batch on it.
    try {
      execFileSync('node', [path.join(__dirname, 'check-rig.js'), out], { stdio: 'inherit' });
    } catch { /* a check FAILed — reported above, keep going */ }
  }
  console.log('[character] done.');
}

// Only run when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
