// listModelFiles powers the admin asset viewer's live model list — it must
// surface EVERY .glb under assets/models/, not the old hardcoded handful that
// dropped all 13 buildings and several root rigs. Runs against the real repo
// assets so it also guards against the directory being moved/renamed.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listModelFiles } from '../server/admin.js';

const REPO_ROOT  = join(dirname(fileURLToPath(import.meta.url)), '..');
const MODELS_DIR = join(REPO_ROOT, 'assets', 'models');

describe('listModelFiles (real repo assets)', () => {
  const files = listModelFiles(MODELS_DIR);

  test('includes the root rigs that the old hardcoded list dropped', () => {
    for (const f of ['paladin-idle.glb', 'mannequin-idle.glb', 'zombie-idle.glb']) {
      assert.ok(files.includes(f), `missing root model: ${f}`);
    }
  });

  test('includes building models (previously absent from the viewer entirely)', () => {
    const buildings = files.filter(f => f.startsWith('buildings/'));
    assert.ok(buildings.length >= 10, `expected the buildings/, got ${buildings.length}`);
    assert.ok(files.includes('buildings/church.glb'), 'missing buildings/church.glb');
  });

  test('recurses into the trees subtree with POSIX-relative paths', () => {
    assert.ok(files.some(f => /^trees\/rock\/.+\.glb$/.test(f)), 'no trees/rock/*.glb found');
  });

  test('returns sorted, deduped, .glb-only paths (no dirs, no dotfiles)', () => {
    assert.deepEqual(files, [...files].sort(), 'output must be sorted');
    assert.ok(files.every(f => f.toLowerCase().endsWith('.glb')), 'non-.glb leaked in');
    assert.ok(!files.some(f => f.split('/').pop().startsWith('.')), 'dotfile leaked in');
  });
});

describe('listModelFiles (synthetic tree)', () => {
  test('walks nested dirs, skips dotfiles + non-glb, sorts', () => {
    const dir = mkdtempSync(join(tmpdir(), 'models-'));
    try {
      writeFileSync(join(dir, 'b.glb'), '');
      writeFileSync(join(dir, 'a.glb'), '');
      writeFileSync(join(dir, 'notes.txt'), '');        // wrong extension
      writeFileSync(join(dir, '.DS_Store'), '');         // dotfile
      mkdirSync(join(dir, 'sub'));
      writeFileSync(join(dir, 'sub', 'c.GLB'), '');       // case-insensitive ext
      assert.deepEqual(listModelFiles(dir), ['a.glb', 'b.glb', 'sub/c.GLB']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('missing directory yields an empty list (no throw)', () => {
    assert.deepEqual(listModelFiles(join(tmpdir(), 'definitely-not-here-xyz')), []);
  });
});
