// Unit + smoke tests for scripts/extract-tree-pack.js — the one-time GLB splitter
// that turns assets/models/tree_pack.glb into per-model GLBs + manifest.json.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  groupModelName,
  buildGroupKey,
  buildTreeRecords,
  classifyTree,
} from '../scripts/extract-tree-pack.js';

const _here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(_here, '..');

describe('groupModelName — classification by name + materials', () => {
  test('rocks — by name prefix, no season required', () => {
    assert.deepEqual(groupModelName('Rock 5_540', ['gray']), {
      category: 'rock', season: null, species: null, part: null,
    });
    assert.deepEqual(groupModelName('stone 11_1', ['Material.037']), {
      category: 'rock', season: null, species: null, part: null,
    });
    assert.deepEqual(groupModelName('Stone 2_543', ['Material.022']), {
      category: 'rock', season: null, species: null, part: null,
    });
  });

  test('clouds + grass — by name prefix, no materials needed', () => {
    assert.equal(groupModelName('cloud 1_26', ['cloud']).category, 'cloud');
    assert.equal(groupModelName('grass 3_57', ['Material.107']).category, 'grass');
  });

  test('complete summer tree — leaf + trunk materials both present', () => {
    // The "Tree N" capitalised series has both leaves and trunk on one node.
    const r = groupModelName('Tree 11_60', ['brown.004', 'green.001']);
    assert.equal(r.category, 'tree');
    assert.equal(r.season, 'summer');
    assert.equal(r.species, '11');
    assert.equal(r.part, 'complete');
  });

  test('split leaves — autumn (orange material)', () => {
    const r = groupModelName('TREE 1.003_381', ['orange']);
    assert.equal(r.category, 'tree-leaves');
    assert.equal(r.season, 'autumn');
    assert.equal(r.species, '1');
    assert.equal(r.part, 'leaves');
  });

  test('split leaves — winter (light_blue)', () => {
    const r = groupModelName('TREE 12.005_189', ['light_blue']);
    assert.equal(r.category, 'tree-leaves');
    assert.equal(r.season, 'winter');
    assert.equal(r.species, '12');
  });

  test('split leaves — dead (material = deep-red)', () => {
    const r = groupModelName('TREE 9.007_520', ['material']);
    assert.equal(r.category, 'tree-leaves');
    assert.equal(r.season, 'dead');
    assert.equal(r.species, '9');
  });

  test('split leaves — summer (light_green)', () => {
    const r = groupModelName('TREE 1_279', ['light_green']);
    assert.equal(r.category, 'tree-leaves');
    assert.equal(r.season, 'summer');
    assert.equal(r.species, '1');
  });

  test('split trunks — season derived from brown variant', () => {
    // brown = summer, brown.001 = autumn, brown.002 = winter, brown.003 = dead
    assert.equal(groupModelName('TREE 1.001_280', ['brown']).season, 'summer');
    assert.equal(groupModelName('TREE 5.002_400', ['brown.001']).season, 'autumn');
    assert.equal(groupModelName('TREE 7.004_207', ['brown.002']).season, 'winter');
    assert.equal(groupModelName('TREE 10.006_498', ['brown.003']).season, 'dead');
  });

  test('standalone Trunk — falls into a tree-trunk group', () => {
    const r = groupModelName('Trunk 5_112', ['brown.004']);
    assert.equal(r.category, 'tree-trunk');
    assert.equal(r.season, 'summer'); // brown.004 in source = summer trunk
    assert.equal(r.part, 'trunk');
  });

  test('unknown primitive name with no leaf/trunk material → skipped', () => {
    assert.equal(groupModelName('Plane.002_49', ['Material.108']), null);
    assert.equal(groupModelName('foo_bar', []), null);
  });

  test('handles bad inputs gracefully', () => {
    assert.equal(groupModelName(null), null);
    assert.equal(groupModelName(undefined, undefined), null);
    assert.equal(groupModelName(123), null);
  });

  test('buildGroupKey produces predictable, filesystem-safe keys', () => {
    assert.equal(buildGroupKey({ category: 'tree', season: 'summer' }), 'tree-summer-complete');
    assert.equal(buildGroupKey({ category: 'tree-leaves', season: 'winter' }), 'tree-winter-leaves');
    assert.equal(buildGroupKey({ category: 'tree-trunk', season: 'dead' }), 'tree-dead-trunk');
    assert.equal(buildGroupKey({ category: 'rock', season: null }), 'rock');
    assert.equal(buildGroupKey({ category: 'cloud', season: null }), 'cloud');
  });
});

describe('buildTreeRecords — assembles complete-tree records', () => {
  // The extractor emits ONE record per FULL tree. Split source nodes (one
  // material each) get paired into multi-index records; pre-merged nodes
  // produce single-index records.

  test('pre-merged "Tree N" → single-index summer-complete record', () => {
    const recs = buildTreeRecords([
      { name: 'Tree 11_60', materials: ['green.001', 'brown.004'] },
    ]);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].groupKey, 'tree-summer-complete');
    assert.equal(recs[0].species, '11');
    assert.deepEqual(recs[0].indices, [0]);
  });

  test('split TREE N + TREE N.001 → single summer record with paired indices', () => {
    const recs = buildTreeRecords([
      { name: 'TREE 1_279', materials: ['light_green'] },        // 0 = leaves
      { name: 'TREE 1.001_280', materials: ['brown'] },          // 1 = trunk
    ]);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].groupKey, 'tree-summer-complete');
    assert.equal(recs[0].species, '1');
    assert.deepEqual(recs[0].indices.sort(), [0, 1]);
  });

  test('all four seasons emit when species has all 8 variants', () => {
    // Source-GLB node names always end in `_NNN` (exporter index suffix);
    // the species/variant regex requires that to match.
    const nodes = [
      { name: 'TREE 5_100',     materials: ['light_green'] }, // summer leaves
      { name: 'TREE 5.001_101', materials: ['brown'] },       // summer trunk
      { name: 'TREE 5.002_102', materials: ['brown.001'] },   // autumn trunk
      { name: 'TREE 5.003_103', materials: ['orange'] },      // autumn leaves
      { name: 'TREE 5.004_104', materials: ['brown.002'] },   // winter trunk
      { name: 'TREE 5.005_105', materials: ['light_blue'] },  // winter leaves
      { name: 'TREE 5.006_106', materials: ['brown.003'] },   // dead trunk
      { name: 'TREE 5.007_107', materials: ['material'] },    // dead leaves
    ];
    const recs = buildTreeRecords(nodes);
    const seasons = recs.map(r => r.groupKey).sort();
    assert.deepEqual(seasons, [
      'tree-autumn-complete',
      'tree-dead-complete',
      'tree-summer-complete',
      'tree-winter-complete',
    ]);
    for (const rec of recs) {
      assert.equal(rec.indices.length, 2, `${rec.groupKey} should pair leaves+trunk`);
      assert.equal(rec.species, '5');
    }
  });

  test('incomplete species (leaves only) emits nothing for that season', () => {
    const recs = buildTreeRecords([
      { name: 'TREE 50_999', materials: ['light_green'] }, // summer leaves, no trunk
    ]);
    assert.equal(recs.length, 0);
  });

  test('lowercase "tree.NNN" big oak: pairs by variant table', () => {
    const recs = buildTreeRecords([
      { name: 'tree_278',     materials: ['light_green'] },   // summer leaves
      { name: 'tree.004_320', materials: ['brown'] },         // summer trunk
      { name: 'tree.001_380', materials: ['orange'] },        // autumn leaves
      { name: 'tree.005_422', materials: ['brown.001'] },     // autumn trunk
    ]);
    const seasons = recs.map(r => r.groupKey).sort();
    assert.deepEqual(seasons, ['tree-autumn-complete', 'tree-summer-complete']);
    for (const rec of recs) {
      assert.equal(rec.species, 'misc-0');
      assert.equal(rec.indices.length, 2);
    }
  });

  test('non-tree nodes are ignored', () => {
    const recs = buildTreeRecords([
      { name: 'Rock 5_540',  materials: ['gray'] },
      { name: 'cloud 1_26',  materials: ['cloud'] },
      { name: 'Plane.002_49', materials: ['Material.108'] },
      { name: 'Trunk 5_112', materials: ['brown.004'] },
    ]);
    assert.deepEqual(recs, []);
  });
});

describe('classifyTree — species + region from bbox shape', () => {
  test('round small canopy → birch (NE)', () => {
    const c = classifyTree({ w: 3, h: 4, d: 3 });
    assert.equal(c.region, 'new-england');
    assert.equal(c.species, 'birch');
  });

  test('tall narrow conifer (h >> w) → pine / hemlock / spruce by height', () => {
    assert.equal(classifyTree({ w: 4, h: 14, d: 4 }).species, 'white-pine');
    assert.equal(classifyTree({ w: 4, h: 11, d: 4 }).species, 'hemlock');
    assert.equal(classifyTree({ w: 4, h: 8,  d: 4 }).species, 'spruce');
  });

  test('large round deciduous → oak (NE)', () => {
    const c = classifyTree({ w: 8, h: 13, d: 8 });
    assert.equal(c.region, 'new-england');
    assert.equal(c.species, 'oak');
  });

  test('very wide low canopy → elm / willow', () => {
    assert.equal(classifyTree({ w: 12, h: 10, d: 12 }).species, 'elm');
    assert.equal(classifyTree({ w: 12, h: 8,  d: 12 }).species, 'willow');
  });

  test('extreme tall-thin asymmetric silhouette → palm (tropical, EXCLUDED)', () => {
    const c = classifyTree({ w: 2, h: 12, d: 0.5 });
    assert.equal(c.region, 'tropical');
    assert.equal(c.species, 'palm');
  });

  test('bad / missing bbox falls back to mixed/new-england', () => {
    assert.deepEqual(classifyTree(null), { species: 'mixed', region: 'new-england' });
    assert.deepEqual(classifyTree({}), { species: 'mixed', region: 'new-england' });
  });

  test('every classification has a region', () => {
    for (const bbox of [{w:1,h:1,d:1}, {w:5,h:20,d:5}, {w:10,h:5,d:10}, {w:0.5,h:15,d:0.5}]) {
      const c = classifyTree(bbox);
      assert.ok(['new-england', 'tropical', 'other'].includes(c.region));
      assert.ok(typeof c.species === 'string' && c.species.length > 0);
    }
  });
});

describe('extract-tree-pack — smoke test', () => {
  test('script runs end-to-end (skips if @gltf-transform/core not installed)', () => {
    let canImport = false;
    try {
      // Probe for the dep — if not present we want a clean skip rather than a fail.
      // We can't await inside the t.test callback in this style, so resolve sync via require-style probe.
      const pkgPath = path.join(REPO_ROOT, 'node_modules', '@gltf-transform', 'core', 'package.json');
      canImport = existsSync(pkgPath);
    } catch {
      canImport = false;
    }
    if (!canImport) {
      console.log('[skip] @gltf-transform/core not installed — extract-tree-pack smoke test skipped');
      return;
    }

    const srcGlb = path.join(REPO_ROOT, 'assets', 'models', 'tree_pack.glb');
    if (!existsSync(srcGlb)) {
      console.log('[skip] tree_pack.glb not present — extract-tree-pack smoke test skipped');
      return;
    }

    // Heavy: only run when explicitly opted in. The full extraction takes ~10s and
    // mutates assets/models/trees/, which we don't want every npm-test run to do.
    if (!process.env.RUN_EXTRACT_SMOKE) {
      console.log('[skip] RUN_EXTRACT_SMOKE not set — extract-tree-pack heavy smoke test skipped');
      return;
    }

    const res = spawnSync(process.execPath, ['scripts/extract-tree-pack.js'], {
      cwd: REPO_ROOT, encoding: 'utf8',
    });
    assert.equal(res.status, 0, `script exited non-zero: ${res.stderr}`);

    const manifestPath = path.join(REPO_ROOT, 'assets', 'models', 'trees', 'manifest.json');
    assert.ok(existsSync(manifestPath), 'manifest.json was not written');
  });
});
