#!/usr/bin/env node
// One-time extractor: splits assets/models/tree_pack.glb into per-model GLBs
// grouped by category (tree/rock/cloud/grass) and (for trees) season.
//
// Writes:
//   assets/models/trees/<group>/<name>.glb
//   assets/models/trees/manifest.json   { version, groups: { "<group>": [...] } }
//
// Grouping is derived from each top-level node's name + the materials its
// descendants reference (the source GLB names materials by colour, e.g.
// "light_green", "orange", "light_blue", "material" — those map cleanly to
// summer/autumn/winter/dead). See `groupModelName()` for the full table.

import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import { NodeIO, Logger } from '@gltf-transform/core';
import { prune, dedup, cloneDocument } from '@gltf-transform/functions';

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
  const leafMat = mats.find((m) => LEAF_MATERIALS.has(m));
  const trunkMat = mats.find((m) => TRUNK_MATERIALS.has(m));

  if (leafMat && trunkMat) {
    return {
      category: 'tree',
      season: LEAF_MATERIAL_TO_SEASON[leafMat],
      species: parseSpecies(trimmed),
      part: 'complete',
    };
  }
  if (leafMat) {
    return {
      category: 'tree-leaves',
      season: LEAF_MATERIAL_TO_SEASON[leafMat],
      species: parseSpecies(trimmed),
      part: 'leaves',
    };
  }
  if (trunkMat) {
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
  if ((m = trimmed.match(/^Trunk\s*(\d+)?/))) return m[1] || '0';
  return null;
}

export function buildGroupKey({ category, season }) {
  if (category === 'tree') return `tree-${season}-complete`;
  if (category === 'tree-leaves') return `tree-${season}-leaves`;
  if (category === 'tree-trunk') return `tree-${season}-trunk`;
  return category;
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

async function extractNodes(srcDoc, indices, outPath, io) {
  const cloneDoc = cloneDocument(srcDoc);
  cloneDoc.setLogger(new Logger(Logger.Verbosity.WARN));
  const cloneTopNodes = getTopModelNodes(cloneDoc.getRoot());
  const keep = new Set(indices);
  for (let i = 0; i < cloneTopNodes.length; i++) {
    if (!keep.has(i)) {
      cloneTopNodes[i].dispose();
    } else {
      // Reset translation so the model loads centred at origin.
      cloneTopNodes[i].setTranslation([0, 0, 0]);
    }
  }
  await cloneDoc.transform(prune(), dedup());
  await io.write(outPath, cloneDoc);
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
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

  const items = [];
  for (let i = 0; i < topNodes.length; i++) {
    const node = topNodes[i];
    const name = node.getName();
    const mats = collectMaterials(node);
    const g = groupModelName(name, mats);
    if (!g) continue;
    items.push({ index: i, name, ...g });
  }

  // Reset output directory.
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // Group items, assign stable per-group slot numbers, write GLBs.
  const groupCounters = Object.create(null);
  const manifestGroups = Object.create(null);
  const groupCounts = Object.create(null);
  console.log(`Extracting ${items.length} models...`);

  let written = 0;
  for (const item of items) {
    const groupKey = buildGroupKey(item);
    groupCounters[groupKey] = (groupCounters[groupKey] || 0) + 1;
    const slot = String(groupCounters[groupKey]).padStart(3, '0');
    const speciesPart = item.species ? `${slug(item.species)}-` : '';
    const outName = `${groupKey}-${speciesPart}${slot}.glb`;
    const outPath = path.join(OUT_DIR, groupKey, outName);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    await extractNodes(srcDoc, [item.index], outPath, io);

    const entry = {
      file: path.relative(OUT_DIR, outPath).split(path.sep).join('/'),
      source_name: item.name,
    };
    if (item.species != null) entry.species = item.species;
    if (item.season != null) entry.season = item.season;
    if (item.part != null) entry.part = item.part;

    (manifestGroups[groupKey] = manifestGroups[groupKey] || []).push(entry);
    groupCounts[groupKey] = (groupCounts[groupKey] || 0) + 1;

    written++;
    if (written % 50 === 0) console.log(`  ${written} / ${items.length}`);
  }

  const manifest = {
    version: 1,
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
}

// Run when invoked directly (not when imported by tests).
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
