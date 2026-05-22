// Unit + smoke tests for scripts/extract-tree-pack.js — the one-time GLB splitter
// that turns assets/models/tree_pack.glb into per-model GLBs + manifest.json.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { groupModelName, buildGroupKey } from '../scripts/extract-tree-pack.js';

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
