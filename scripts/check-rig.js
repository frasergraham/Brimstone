#!/usr/bin/env node
/*
 * check-rig.js — validate character rig .glb files against the "Mixamo
 * standard" convention the renderer's rig cascade expects, so a generated or
 * hand-exported model can be checked BEFORE it's dropped into assets/models/.
 *
 * The renderer normalises every rig to standee height at clone time, so a model
 * that breaks convention still *renders* — but an off-convention export (wrong
 * scale node, hip-centred origin, OBJ round-trip) forces per-rig fudging and
 * tends to pop/float/sink as animations play (see the paladin saga). This
 * reports the metrics that matter so you can tune the export until it's clean.
 *
 * USAGE
 *   node scripts/check-rig.js                     # every character rig in assets/models/
 *   node scripts/check-rig.js paladin-idle.glb    # one file (name or path)
 *   npm run validate:rigs
 *
 * Exit code is non-zero if any rig FAILs a hard check — usable as a gate.
 *
 * "Character rig" = a .glb that contains a skinned mesh (a skin + skeleton);
 * animation-only clips (walking.glb …) and props (house.glb, trees) are skipped.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeIO } from '@gltf-transform/core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = path.join(ROOT, 'assets', 'models');

// ── tiny mat4 (column-major) so world-space measurement handles any
//    rotation/scale hierarchy without a dependency ───────────────────────────
const mat = {
  identity: () => [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1],
  mul(a, b) { // a*b
    const o = new Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      o[c*4+r] = a[0*4+r]*b[c*4+0] + a[1*4+r]*b[c*4+1] + a[2*4+r]*b[c*4+2] + a[3*4+r]*b[c*4+3];
    }
    return o;
  },
  fromTRS(t, q, s) {
    const [x,y,z,w] = q;
    const x2=x+x, y2=y+y, z2=z+z;
    const xx=x*x2, xy=x*y2, xz=x*z2, yy=y*y2, yz=y*z2, zz=z*z2, wx=w*x2, wy=w*y2, wz=w*z2;
    const [sx,sy,sz] = s;
    return [
      (1-(yy+zz))*sx, (xy+wz)*sx, (xz-wy)*sx, 0,
      (xy-wz)*sy, (1-(xx+zz))*sy, (yz+wx)*sy, 0,
      (xz+wy)*sz, (yz-wx)*sz, (1-(xx+yy))*sz, 0,
      t[0], t[1], t[2], 1,
    ];
  },
  point(m, p) {
    const [x,y,z] = p;
    return [
      m[0]*x + m[4]*y + m[8]*z + m[12],
      m[1]*x + m[5]*y + m[9]*z + m[13],
      m[2]*x + m[6]*y + m[10]*z + m[14],
    ];
  },
  // Uniform-ish scale = length of the X basis vector.
  scaleOf(m) { return Math.hypot(m[0], m[1], m[2]); },
};

function worldMatrixOf(node) {
  let m = mat.fromTRS(node.getTranslation(), node.getRotation(), node.getScale());
  let parent = node.getParentNode?.() ?? null;
  while (parent) {
    m = mat.mul(mat.fromTRS(parent.getTranslation(), parent.getRotation(), parent.getScale()), m);
    parent = parent.getParentNode?.() ?? null;
  }
  return m;
}

/** Find the node hosting a skinned mesh, or null if the glb isn't a character. */
function findSkinnedNode(root) {
  for (const node of root.listNodes()) {
    if (node.getMesh() && node.getSkin()) return node;
  }
  // Fallback: a mesh node + a skin anywhere (some exporters split them).
  if (root.listSkins().length) {
    for (const node of root.listNodes()) if (node.getMesh()) return node;
  }
  return null;
}

async function measure(glbPath) {
  const doc = await new NodeIO().read(glbPath);
  const root = doc.getRoot();
  const meshNode = findSkinnedNode(root);
  if (!meshNode) return { skip: true };

  const mesh = meshNode.getMesh();
  const wm = worldMatrixOf(meshNode);
  const worldScale = mat.scaleOf(wm);

  // World bbox from the POSITION accessor corners.
  let minY = Infinity, maxY = -Infinity, verts = 0;
  for (const prim of mesh.listPrimitives()) {
    const pos = prim.getAttribute('POSITION');
    if (!pos) continue;
    verts += pos.getCount();
    const lo = pos.getMin([]), hi = pos.getMax([]);
    // transform all 8 corners (rotation can swap which extreme is min/max).
    for (const cx of [lo[0], hi[0]]) for (const cy of [lo[1], hi[1]]) for (const cz of [lo[2], hi[2]]) {
      const wy = mat.point(wm, [cx, cy, cz])[1];
      if (wy < minY) minY = wy;
      if (wy > maxY) maxY = wy;
    }
  }
  const height = maxY - minY;

  // Hips world Y.
  const skin = meshNode.getSkin() || root.listSkins()[0];
  const joints = skin ? skin.listJoints() : [];
  const hips = joints.find(j => /(^|:)Hips$/.test(j.getName() || ''))
    || root.listNodes().find(n => /(^|:)Hips$/.test(n.getName() || ''));
  const hipsY = hips ? mat.point(worldMatrixOf(hips), [0,0,0])[1] : null;

  const mixamoNamed = joints.length
    ? joints.filter(j => /^mixamorig:/.test(j.getName() || '')).length / joints.length
    : 0;

  return {
    meshNodeName: meshNode.getName() || '(unnamed)',
    worldScale, minY, maxY, height, hipsY,
    joints: joints.length,
    mixamoNamed,
    verts,
    textures: root.listTextures().length,
    sizeMB: fs.statSync(glbPath).size / 1e6,
    anims: root.listAnimations().map(a => a.getName() || 'clip'),
  };
}

// ── checks ───────────────────────────────────────────────────────────────────
const C = { ok: '\x1b[32m✓\x1b[0m', warn: '\x1b[33m⚠\x1b[0m', fail: '\x1b[31m✗\x1b[0m' };

function evaluate(m) {
  const checks = [];
  const add = (level, label, detail) => checks.push({ level, label, detail });

  // Scale ≈ 1 (no ×100 compensation node).
  if (m.worldScale >= 0.5 && m.worldScale <= 2)        add('ok',   'scale ≈ 1', m.worldScale.toFixed(3));
  else add('fail', 'scale off convention', `${m.worldScale.toFixed(3)}× (want ~1; a value like 100 means a compensation node — bake transforms before export)`);

  // Height — informational, warn outside a loose human range.
  if (m.height >= 1.2 && m.height <= 2.2)              add('ok',   'height', `${m.height.toFixed(2)} m`);
  else add('warn', 'height unusual', `${m.height.toFixed(2)} m (human ~1.5–2.0; fine for a short/hunched character)`);

  // Feet at origin (world minY ≈ 0).
  const feetTol = Math.max(0.05, m.height * 0.06);
  if (Math.abs(m.minY) <= feetTol)                     add('ok',   'feet at origin', `minY ${m.minY.toFixed(3)}`);
  else add('fail', 'origin not at feet', `minY ${m.minY.toFixed(3)} (want ≈0; re-origin so the feet sit on Y=0)`);

  // Hips at standing height (positive, ~mid-height).
  if (m.hipsY == null)                                 add('warn', 'no Hips bone found', 'expected a mixamorig:Hips joint');
  else if (m.hipsY > m.height * 0.30 && m.hipsY < m.height * 0.65) add('ok', 'Hips at standing height', `${m.hipsY.toFixed(3)} (${(m.hipsY/m.height*100).toFixed(0)}% up)`);
  else add('fail', 'Hips not at standing height', `${m.hipsY.toFixed(3)} (want ~0.4–0.6× height & positive; a value ≈0 means the skeleton is rooted at the hip, not the feet)`);

  // Bone naming.
  if (m.joints === 0)                                  add('fail', 'no skeleton joints', 'not a rigged character');
  else if (m.mixamoNamed >= 0.9)                       add('ok',   'mixamorig bone names', `${m.joints} joints`);
  else add('warn', 'non-mixamo bone names', `${(m.mixamoNamed*100).toFixed(0)}% mixamorig: (convert-character-fbx.js normalises mixamorigN: → mixamorig:)`);

  // OBJ round-trip artifact.
  if (/\.obj/i.test(m.meshNodeName))                   add('warn', 'OBJ round-trip', `mesh node "${m.meshNodeName}" — export a rigged glTF/FBX, not via OBJ`);

  return checks;
}

// ── run ──────────────────────────────────────────────────────────────────────
function resolveTargets(argv) {
  if (argv.length) {
    return argv.map(a => path.isAbsolute(a) ? a
      : fs.existsSync(a) ? a : path.join(MODELS_DIR, a));
  }
  return fs.readdirSync(MODELS_DIR)
    .filter(f => f.endsWith('.glb'))
    .map(f => path.join(MODELS_DIR, f));
}

async function main() {
  const targets = resolveTargets(process.argv.slice(2));
  let anyFail = false, rigCount = 0;

  for (const file of targets) {
    let m;
    try { m = await measure(file); }
    catch (err) { console.log(`\n${path.basename(file)}\n  ${C.fail} could not read: ${err.message}`); anyFail = true; continue; }
    if (m.skip) continue; // not a character rig
    rigCount++;

    const checks = evaluate(m);
    const failed = checks.some(c => c.level === 'fail');
    const warned = checks.some(c => c.level === 'warn');
    if (failed) anyFail = true;
    const verdict = failed ? `${C.fail} FAIL` : warned ? `${C.warn} WARN` : `${C.ok} PASS`;

    console.log(`\n\x1b[1m${path.basename(file)}\x1b[0m  ${verdict}`);
    console.log(`  ${m.verts} verts · ${m.joints} joints · ${m.textures} tex · ${m.sizeMB.toFixed(1)}MB · clips: ${m.anims.join(', ') || 'none'}`);
    for (const c of checks) console.log(`  ${C[c.level]} ${c.label}: ${c.detail}`);
  }

  if (rigCount === 0) console.log('No character rigs found (a rig is a .glb with a skinned mesh).');
  else console.log(`\n${rigCount} rig(s) checked.${anyFail ? '  Some FAILED.' : '  All clear.'}`);
  process.exit(anyFail ? 1 : 0);
}

export { measure, evaluate };

// Only run when invoked directly (not when imported for reuse).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
