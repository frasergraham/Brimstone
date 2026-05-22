// Smoke test for the standalone 3D asset debug viewer at admin-assets.html.
// The page lets operators QA imported GLB models in isolation so we catch the
// "tiny helmet then giant head" / "model sinks into ground" classes of bugs
// without having to spin up the full game. This test just pins that the file
// exists at repo root and references the vendored Babylon UMD bundles — the
// actual rendering can't be exercised in Node.
//
// Task: t-e74357e8.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PAGE_PATH = resolve(__dirname, '..', 'admin-assets.html');

describe('admin-assets.html', () => {
  test('exists at repo root', () => {
    assert.ok(existsSync(PAGE_PATH), 'admin-assets.html should be at repo root next to admin.html');
  });

  const html = readFileSync(PAGE_PATH, 'utf8');

  test('loads Babylon core from local vendor path (not a CDN)', () => {
    assert.match(html, /\/assets\/vendor\/babylonjs\/babylon\.js/,
      'must reference the local Babylon core UMD bundle');
    assert.doesNotMatch(html, /cdn\.babylonjs\.com/, 'must not pull from cdn.babylonjs.com');
    assert.doesNotMatch(html, /cdn\.jsdelivr\.net/, 'must not pull from jsdelivr');
  });

  test('loads Babylon glTF loaders from local vendor path', () => {
    assert.match(html, /\/assets\/vendor\/babylonjs\/babylonjs\.loaders\.min\.js/,
      'must reference the local Babylon loaders UMD bundle so .glb is registered');
  });

  test('references the three seed model files the brief calls out', () => {
    assert.match(html, /house\.glb/);
    assert.match(html, /paladin\.glb/);
    assert.match(html, /idle\.glb/);
  });

  test('uses ArcRotateCamera with attachControl (default Babylon orbit/zoom)', () => {
    assert.match(html, /ArcRotateCamera/);
    assert.match(html, /attachControl\(canvas/);
  });

  test('uses SceneLoader.ImportMeshAsync to load GLBs', () => {
    assert.match(html, /SceneLoader\.ImportMeshAsync/);
  });

  test('does NOT reuse the in-game Renderer3D class', () => {
    // The viewer is intentionally standalone so it can isolate asset-import
    // bugs from the renderer's per-tile placement logic.
    assert.doesNotMatch(html, /from\s+['"][^'"]*renderer-3d\.js['"]/);
    assert.doesNotMatch(html, /\bnew\s+Renderer3D\b/);
  });
});
