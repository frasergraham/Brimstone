#!/usr/bin/env node
// One-time extractor: splits assets/models/tree_pack.glb into per-model GLBs
// grouped by category (tree/rock/cloud/grass) and (for trees) season.
//
// Trees are emitted as ONE GLB per FULL tree (leaves + trunk together — no
// trunk/leaves split files). Each tree entry is classified with a species
// (oak, maple, pine, …) and a region (new-england or other), so the runtime
// can filter to colonial New England species.
//
// Writes:
//   assets/models/trees/<group>/<name>.glb
//   assets/models/trees/manifest.json   { version: 2, groups: { "<group>": [{file,species,region}] } }
//
// The source GLB encodes trees in two forms:
//   1) "Tree N" (capital, single node, both green.001 + brown.004 materials)
//      → pre-merged complete summer trees.
//   2) "TREE N" / "TREE N.001-N.007" (uppercase, one material each) → paired
//      leaf + trunk nodes, one pair per season. Variants:
//        .000 = light_green leaves   (summer leaves)
//        .001 = brown trunk           (summer trunk)
//        .002 = brown.001 trunk       (autumn trunk)
//        .003 = orange leaves         (autumn leaves)
//        .004 = brown.002 trunk       (winter trunk)
//        .005 = light_blue leaves     (winter leaves)
//        .006 = brown.003 trunk       (dead trunk)
//        .007 = material (red) leaves (dead leaves)
//   3) "tree.NNN" (lowercase, big oak) — same per-season split pattern but
//      with different variant→material mapping (see TREE_DOT_VARIANTS).
//
// The complete summer trees (form #1) are extracted as-is. For autumn /
// winter / dead, we MERGE the corresponding leaves + trunk source nodes
// into one GLB per tree, preserving their relative position and re-centering
// the result so the tree's horizontal centroid sits at the origin with its
// bottom on Y=0.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeIO, Logger } from '@gltf-transform/core';
import { prune, dedup, cloneDocument } from '@gltf-transform/functions';

// Material → (season, part) for TREE NN.XXX series (uppercase, split nodes).
const LEAF_MATERIAL_TO_SEASON = Object.freeze({
  light_green: 'summer',
  'green.001': 'summer',
  orange: 'autumn',
  light_blue: 'winter',
  material: 'dead',
});

const TRUNK_MATERIAL_TO_SEASON = Object.freeze({
  brown: 'summer',
  'brown.001': 'autumn',
  'brown.002': 'winter',
  'brown.003': 'dead',
  'brown.004': 'summer',
  'brown.005': 'summer',
});

const TRUNK_MATERIALS = new Set(Object.keys(TRUNK_MATERIAL_TO_SEASON));
const LEAF_MATERIALS = new Set(Object.keys(LEAF_MATERIAL_TO_SEASON));

/**
 * Classify a top-level source node by name + the materials used by its meshes.
 * Pure helper — exported for unit tests.
 *
 * @param {string} name - the node's name in the source GLB
 * @param {string[]} materialNames - names of materials referenced by the node's mesh primitives
 * @returns {{category: string, season: string|null, species: string|null, part: string|null} | null}
 *          null = skip (unrecognised primitive geometry)
 */
export function groupModelName(name, materialNames = []) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();

  if (/^rock\b/i.test(trimmed) || /^stone\b/i.test(trimmed)) {
    return { category: 'rock', season: null, species: null, part: null };
  }
  if (/^cloud\b/i.test(trimmed)) {
    return { category: 'cloud', season: null, species: null, part: null };
  }
  if (/^grass\b/i.test(trimmed)) {
    return { category: 'grass', season: null, species: null, part: null };
  }

  const mats = Array.isArray(materialNames) ? materialNames : [];
  const hasLeaf = mats.some((m) => LEAF_MATERIALS.has(m));
  const hasTrunk = mats.some((m) => TRUNK_MATERIALS.has(m));

  // Case 1: pre-merged complete tree — both leaf + trunk materials present.
  // Source names: "Tree N" (capital with space).
  if (hasLeaf && hasTrunk) {
    const leafMat = mats.find((m) => LEAF_MATERIALS.has(m));
    return {
      category: 'tree',
      season: LEAF_MATERIAL_TO_SEASON[leafMat] || 'summer',
      species: parseSpecies(trimmed),
      part: 'complete',
    };
  }
  if (hasLeaf) {
    const leafMat = mats.find((m) => LEAF_MATERIALS.has(m));
    return {
      category: 'tree-leaves',
      season: LEAF_MATERIAL_TO_SEASON[leafMat],
      species: parseSpecies(trimmed),
      part: 'leaves',
    };
  }
  if (hasTrunk) {
    const trunkMat = mats.find((m) => TRUNK_MATERIALS.has(m));
    // Standalone trunks (e.g. "Trunk N") — treat as trunk parts.
    return {
      category: 'tree-trunk',
      season: TRUNK_MATERIAL_TO_SEASON[trunkMat],
      species: parseSpecies(trimmed),
      part: 'trunk',
    };
  }
  return null;
}

function parseSpecies(name) {
  // Source-GLB node names have a trailing _<index> suffix appended by the exporter
  // (e.g. "TREE 1.003_381", "Tree 11_60"). Strip it before parsing the semantic name.
  const trimmed = name.replace(/_\d+$/, '');
  let m;
  if ((m = trimmed.match(/^TREE\s+(\d+)(?:\.\d+)?$/i))) return m[1];
  if ((m = trimmed.match(/^Tree\s+(\d+)/))) return m[1];
  if ((m = trimmed.match(/^tree\.(\d+)/))) return `misc-${m[1]}`;
  if ((m = trimmed.match(/^tree$/))) return 'misc-0';
  if ((m = trimmed.match(/^Trunk\s*(\d+)?/))) return m[1] || '0';
  return null;
}

export function buildGroupKey({ category, season }) {
  if (category === 'tree') return `tree-${season}-complete`;
  if (category === 'tree-leaves') return `tree-${season}-leaves`;
  if (category === 'tree-trunk') return `tree-${season}-trunk`;
  return category;
}

// ─── Species + region classifier ──────────────────────────────────────────
// Pure helper — exported for tests. Given a tree's combined bbox dimensions
// (W = max x-extent, H = max y-extent, D = max z-extent), assign a plausible
// New England species. The shape-to-species mapping is heuristic — without
// per-tree semantic metadata in the source pack we use canopy aspect ratio
// + height as a stand-in for silhouette. The classifier explicitly rejects
// known tropical silhouettes (very tall + very thin trunk with a small
// canopy → palm) so they can be filtered out of New England forests.
//
// @param {{w:number,h:number,d:number}} bbox combined tree bbox
// @returns {{species: string, region: 'new-england' | 'tropical' | 'other'}}
export function classifyTree(bbox) {
  if (!bbox || !Number.isFinite(bbox.w) || !Number.isFinite(bbox.h) || !Number.isFinite(bbox.d)) {
    return { species: 'mixed', region: 'new-england' };
  }
  const w = Math.max(bbox.w, 1e-3);
  const d = Math.max(bbox.d, 1e-3);
  const h = Math.max(bbox.h, 1e-3);
  const maxWidth = Math.max(w, d);
  const minWidth = Math.min(w, d);
  const aspect = h / maxWidth;           // taller = bigger
  const symmetry = minWidth / maxWidth;  // round canopies → ~1

  // Tropical exclusion — very tall narrow silhouette with a sparse canopy.
  // This catches palm-like / cypress-spike shapes (h/w > 3.0 + asymmetric).
  if (aspect > 3.0 && symmetry < 0.6) {
    return { species: 'palm', region: 'tropical' };
  }
  // Conifer: tall + narrow round canopy. Threshold 1.8 keeps oaks (typical
  // aspect ~1.0–1.6) in the deciduous bucket while still catching pines /
  // hemlocks / spruces (aspect typically >= 2).
  if (aspect > 1.8) {
    // Discriminate among NE conifers by absolute height.
    if (h > 13) return { species: 'white-pine', region: 'new-england' };
    if (h > 10) return { species: 'hemlock', region: 'new-england' };
    return { species: 'spruce', region: 'new-england' };
  }
  // Tall-ish + roundish canopy: classic NE deciduous.
  if (aspect > 1.0) {
    if (h > 12) return { species: 'oak', region: 'new-england' };
    if (h > 10) return { species: 'maple', region: 'new-england' };
    if (h > 8)  return { species: 'beech', region: 'new-england' };
    return { species: 'birch', region: 'new-england' };
  }
  // Shorter than wide: spreading canopy (mature oak / elm / willow).
  if (aspect > 0.6) {
    if (h > 9) return { species: 'elm', region: 'new-england' };
    return { species: 'willow', region: 'new-england' };
  }
  // Very wide, low canopy — shrubby. Still NE (sumac, dogwood, alder).
  return { species: 'alder', region: 'new-england' };
}

// Walk past the Sketchfab_Scene → Sketchfab_model → root → GLTF_SceneRootNode
// wrappers and return the actual list of model nodes.
function getTopModelNodes(rootRef) {
  const scenes = rootRef.listScenes();
  if (!scenes.length) return [];
  let cursor = scenes[0].listChildren();
  // Drill through single-child wrapper nodes (Sketchfab_model → root → GLTF_SceneRootNode)
  // until we hit a layer with multiple siblings — those are the model nodes.
  // Heuristic specific to this asset pack's Sketchfab wrapper structure.
  while (cursor.length === 1 && cursor[0].getMesh() == null && cursor[0].listChildren().length > 0) {
    cursor = cursor[0].listChildren();
  }
  return cursor;
}

function collectMaterials(node) {
  const set = new Set();
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    const mesh = n.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const mat = prim.getMaterial();
        if (mat) set.add(mat.getName());
      }
    }
    for (const c of n.listChildren()) stack.push(c);
  }
  return [...set];
}

// Compute the local-space bbox of a node's geometry (raw POSITION attribute
// values, before applying the node's own translation). Used to convert into
// world-space bboxes for re-centering when extracting multi-node trees.
function localBBox(node) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  const stack = [node];
  while (stack.length) {
    const n = stack.pop();
    const mesh = n.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const pos = prim.getAttribute('POSITION');
        if (!pos) continue;
        const arr = pos.getArray();
        const count = pos.getCount();
        for (let i = 0; i < count; i++) {
          const x = arr[i * 3], y = arr[i * 3 + 1], z = arr[i * 3 + 2];
          if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
          if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
        }
      }
    }
    for (const c of n.listChildren()) stack.push(c);
  }
  if (!isFinite(minX)) return null;
  return { minX, minY, minZ, maxX, maxY, maxZ };
}

// Compute the union of `indices` nodes' world-space bboxes. World-space here
// means each node's local bbox shifted by its translation — we don't traverse
// nested parent transforms because the source pack's tree nodes are flat at
// the top level.
function unionWorldBBox(topNodes, indices) {
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (const i of indices) {
    const node = topNodes[i];
    const t = node.getTranslation();
    const lb = localBBox(node);
    if (!lb) continue;
    if (t[0] + lb.minX < minX) minX = t[0] + lb.minX;
    if (t[1] + lb.minY < minY) minY = t[1] + lb.minY;
    if (t[2] + lb.minZ < minZ) minZ = t[2] + lb.minZ;
    if (t[0] + lb.maxX > maxX) maxX = t[0] + lb.maxX;
    if (t[1] + lb.maxY > maxY) maxY = t[1] + lb.maxY;
    if (t[2] + lb.maxZ > maxZ) maxZ = t[2] + lb.maxZ;
  }
  if (!isFinite(minX)) return null;
  return {
    minX, minY, minZ, maxX, maxY, maxZ,
    w: maxX - minX, h: maxY - minY, d: maxZ - minZ,
    cx: (minX + maxX) / 2, cz: (minZ + maxZ) / 2,
  };
}

// Extract a subset of top-level nodes into a fresh GLB. When `indices` has
// more than one element (e.g. paired leaves + trunk), the combined world
// bbox is used to re-center the tree at origin with its bottom on Y=0;
// individual translations are preserved relative to each other so the trunk
// stays under the canopy.
async function extractNodes(srcDoc, indices, outPath, io) {
  const cloneDoc = cloneDocument(srcDoc);
  cloneDoc.setLogger(new Logger(Logger.Verbosity.WARN));
  const cloneTopNodes = getTopModelNodes(cloneDoc.getRoot());
  const keep = new Set(indices);
  const bb = unionWorldBBox(cloneTopNodes, indices);
  const cx = bb?.cx ?? 0;
  const cz = bb?.cz ?? 0;
  const minY = bb?.minY ?? 0;

  for (let i = 0; i < cloneTopNodes.length; i++) {
    if (!keep.has(i)) {
      cloneTopNodes[i].dispose();
    } else {
      const t = cloneTopNodes[i].getTranslation();
      cloneTopNodes[i].setTranslation([t[0] - cx, t[1] - minY, t[2] - cz]);
    }
  }
  await cloneDoc.transform(prune(), dedup());
  await io.write(outPath, cloneDoc);
  return bb;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// For the TREE NN.XXX series, variants .000–.007 map to (season, part) pairs.
// Index = variant suffix as integer (0 = no suffix).
const TREE_UPPER_VARIANTS = [
  { season: 'summer', part: 'leaves' },  // .000 = light_green
  { season: 'summer', part: 'trunk' },   // .001 = brown
  { season: 'autumn', part: 'trunk' },   // .002 = brown.001
  { season: 'autumn', part: 'leaves' },  // .003 = orange
  { season: 'winter', part: 'trunk' },   // .004 = brown.002
  { season: 'winter', part: 'leaves' },  // .005 = light_blue
  { season: 'dead',   part: 'trunk' },   // .006 = brown.003
  { season: 'dead',   part: 'leaves' },  // .007 = material
];

// The lowercase "tree.NNN" series uses a different variant→(season, part) mapping
// (different exporter ordering — see source-pack inspection).
const TREE_DOT_VARIANTS = {
  0:    { season: 'summer', part: 'leaves' },  // "tree"
  '001': { season: 'autumn', part: 'leaves' }, // orange
  '002': { season: 'winter', part: 'leaves' }, // light_blue
  '003': { season: 'dead',   part: 'leaves' }, // material
  '004': { season: 'summer', part: 'trunk' },  // brown
  '005': { season: 'autumn', part: 'trunk' },  // brown.001
  '006': { season: 'dead',   part: 'trunk' },  // brown.003
  '007': { season: 'winter', part: 'trunk' },  // brown.002
};

/**
 * Group the top-level source nodes into emit-ready tree records.
 *
 * Each record is one COMPLETE tree (one GLB output). Returns:
 *   [
 *     { groupKey: 'tree-summer-complete', species, indices: [i,j], sourceName },
 *     ...
 *   ]
 *
 * Pure helper — exported for unit tests.
 *
 * @param {Array<{name: string, materials: string[]}>} nodeInfos
 *        per-top-node {name, materials} pairs in source order
 * @returns {Array<{groupKey: string, species: string|null, indices: number[], sourceName: string}>}
 */
export function buildTreeRecords(nodeInfos) {
  const out = [];
  // Buckets for TREE NN.XXX pairs to merge: speciesId → { season → { leaves, trunk } }
  const upperBuckets = new Map();
  // Buckets for tree.NNN pairs (one species, "big oak"): "misc-0" → { season → { leaves, trunk } }
  const dotBuckets = new Map();

  for (let i = 0; i < nodeInfos.length; i++) {
    const { name, materials } = nodeInfos[i];
    if (typeof name !== 'string') continue;
    const trimmed = name.trim();

    // Pre-merged complete trees: "Tree N" (capital with space) — single-node extract.
    let m = trimmed.match(/^Tree\s+(\d+)(?:\.\d+)?_\d+$/);
    if (m) {
      const speciesNum = m[1];
      out.push({
        groupKey: 'tree-summer-complete',
        species: speciesNum,
        indices: [i],
        sourceName: name,
      });
      continue;
    }

    // Split trees: "TREE N" or "TREE N.NNN" (uppercase) — bucket into species + variant.
    m = trimmed.match(/^TREE\s+(\d+)(?:\.(\d+))?_\d+$/);
    if (m) {
      const speciesNum = m[1];
      const variantIdx = m[2] ? parseInt(m[2], 10) : 0;
      const variant = TREE_UPPER_VARIANTS[variantIdx];
      if (!variant) continue;
      if (!upperBuckets.has(speciesNum)) upperBuckets.set(speciesNum, {});
      const speciesBucket = upperBuckets.get(speciesNum);
      if (!speciesBucket[variant.season]) speciesBucket[variant.season] = {};
      speciesBucket[variant.season][variant.part] = { index: i, name };
      continue;
    }

    // Lowercase "tree.NNN" (or bare "tree") — single big-oak species, split per season.
    m = trimmed.match(/^tree(?:\.(\d{3}))?_\d+$/);
    if (m) {
      const variantKey = m[1] || 0;
      const variant = TREE_DOT_VARIANTS[variantKey];
      if (!variant) continue;
      if (!dotBuckets.has('misc-0')) dotBuckets.set('misc-0', {});
      const sb = dotBuckets.get('misc-0');
      if (!sb[variant.season]) sb[variant.season] = {};
      sb[variant.season][variant.part] = { index: i, name };
      continue;
    }
    // Standalone Trunk / unknown — skipped (not a complete tree).
  }

  // Drain the upper-case buckets: pair leaves + trunk per (species, season).
  for (const [speciesNum, seasons] of upperBuckets) {
    for (const season of ['summer', 'autumn', 'winter', 'dead']) {
      const pair = seasons[season];
      if (!pair || !pair.leaves || !pair.trunk) continue;
      out.push({
        groupKey: `tree-${season}-complete`,
        species: speciesNum,
        indices: [pair.leaves.index, pair.trunk.index],
        sourceName: `${pair.leaves.name}+${pair.trunk.name}`,
      });
    }
  }
  // Drain the lowercase big-oak buckets.
  for (const [speciesNum, seasons] of dotBuckets) {
    for (const season of ['summer', 'autumn', 'winter', 'dead']) {
      const pair = seasons[season];
      if (!pair || !pair.leaves || !pair.trunk) continue;
      out.push({
        groupKey: `tree-${season}-complete`,
        species: speciesNum,
        indices: [pair.leaves.index, pair.trunk.index],
        sourceName: `${pair.leaves.name}+${pair.trunk.name}`,
      });
    }
  }
  return out;
}

async function main() {
  const SRC = path.join('assets', 'models', 'tree_pack.glb');
  const OUT_DIR = path.join('assets', 'models', 'trees');

  if (!fs.existsSync(SRC)) {
    console.error(`Source GLB not found: ${SRC}`);
    process.exit(1);
  }

  console.log(`Reading ${SRC}...`);
  const io = new NodeIO();
  const srcDoc = await io.read(SRC);
  const topNodes = getTopModelNodes(srcDoc.getRoot());
  console.log(`Source: ${topNodes.length} top-level nodes`);

  const nodeInfos = topNodes.map((n) => ({
    name: n.getName(),
    materials: collectMaterials(n),
  }));

  // Tree records (complete trees, possibly multi-node).
  const treeRecords = buildTreeRecords(nodeInfos);
  console.log(`Tree records: ${treeRecords.length}`);

  // Non-tree records (rocks, clouds, grass) — single-node, classified by name.
  const nonTreeRecords = [];
  for (let i = 0; i < nodeInfos.length; i++) {
    const g = groupModelName(nodeInfos[i].name, nodeInfos[i].materials);
    if (!g) continue;
    if (g.category === 'rock' || g.category === 'cloud' || g.category === 'grass') {
      nonTreeRecords.push({
        groupKey: g.category,
        species: null,
        indices: [i],
        sourceName: nodeInfos[i].name,
      });
    }
  }
  console.log(`Non-tree records: ${nonTreeRecords.length}`);

  // Reset output directory.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Assign per-group slot numbers, write GLBs, build manifest.
  const groupCounters = Object.create(null);
  const manifestGroups = Object.create(null);
  const groupCounts = Object.create(null);
  const regionCounts = { 'new-england': 0, tropical: 0, other: 0 };

  const allRecords = [...treeRecords, ...nonTreeRecords];
  console.log(`Extracting ${allRecords.length} models...`);

  let written = 0;
  for (const rec of allRecords) {
    const isTree = rec.groupKey.startsWith('tree-');
    const speciesPart = rec.species ? `${slug(rec.species)}-` : '';
    groupCounters[rec.groupKey] = (groupCounters[rec.groupKey] || 0) + 1;
    const slot = String(groupCounters[rec.groupKey]).padStart(3, '0');
    const outName = `${rec.groupKey}-${speciesPart}${slot}.glb`;
    const outPath = path.join(OUT_DIR, rec.groupKey, outName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    const bb = await extractNodes(srcDoc, rec.indices, outPath, io);

    const entry = {
      file: path.relative(OUT_DIR, outPath).split(path.sep).join('/'),
    };
    if (isTree) {
      const { species, region } = classifyTree(bb);
      entry.species = species;
      entry.region = region;
      regionCounts[region] = (regionCounts[region] || 0) + 1;
    }

    (manifestGroups[rec.groupKey] = manifestGroups[rec.groupKey] || []).push(entry);
    groupCounts[rec.groupKey] = (groupCounts[rec.groupKey] || 0) + 1;

    written++;
    if (written % 50 === 0) console.log(`  ${written} / ${allRecords.length}`);
  }

  const manifest = {
    version: 2,
    generatedAt: new Date().toISOString(),
    source: 'tree_pack.glb',
    generated_by: 'scripts/extract-tree-pack.js',
    groups: manifestGroups,
  };
  fs.writeFileSync(
    path.join(OUT_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2) + '\n',
  );

  console.log('\nDone.');
  console.log(`Wrote ${written} GLBs to ${OUT_DIR}`);
  console.log('\nGroup counts:');
  const sortedGroups = Object.keys(groupCounts).sort();
  for (const g of sortedGroups) {
    console.log(`  ${g.padEnd(28)} ${groupCounts[g]}`);
  }
  console.log('\nRegion counts (trees only):');
  for (const r of Object.keys(regionCounts)) {
    console.log(`  ${r.padEnd(14)} ${regionCounts[r]}`);
  }
}

// Run when invoked directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
