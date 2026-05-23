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
import { Renderer3D } from '../src/renderer-3d.js';

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

  test('references the seed model files the brief calls out', () => {
    assert.match(html, /house\.glb/);
    assert.match(html, /paladin-idle\.glb/);
    assert.match(html, /walking\.glb/);
    assert.match(html, /running\.glb/);
  });

  test('uses ArcRotateCamera with attachControl (default Babylon orbit/zoom)', () => {
    assert.match(html, /ArcRotateCamera/);
    assert.match(html, /attachControl\(canvas/);
  });

  test('uses SceneLoader.ImportMeshAsync to load GLBs', () => {
    assert.match(html, /SceneLoader\.ImportMeshAsync/);
  });

  test('reuses Renderer3D for single-hex tile previews', () => {
    // The page now has two modes: a standalone GLB viewer (its own engine +
    // scene + ArcRotateCamera, kept isolated so asset-import bugs surface
    // without per-tile placement noise) AND a tile preview mode that
    // sandboxes the in-game Renderer3D against a stubbed one-tile state so
    // operators can inspect each TileType visually.
    assert.match(html, /from\s+['"][^'"]*renderer-3d\.js['"]/,
      'tile preview mode must import Renderer3D');
    assert.match(html, /new\s+Renderer3D\(/,
      'tile preview mode must instantiate Renderer3D');
    assert.match(html, /previewMode:\s*true/,
      'Renderer3D must be constructed with previewMode:true to disable border-forest / paladin loads');
  });

  test('renders a tile sidebar listing each TileType', () => {
    assert.match(html, /id="tile-list"/, 'sidebar must include a #tile-list container');
    // TileType + BuildingType imports are how we enumerate the entries.
    assert.match(html, /from\s+['"][^'"]*tiles\.js['"]/);
    assert.match(html, /\bTileType\b/);
    assert.match(html, /\bBuildingType\b/);
  });

  test('hosts the tile preview on a second canvas to avoid tearing down the GLB viewer', () => {
    assert.match(html, /id="tile-render-canvas"/,
      'a second canvas is needed so the GLB viewer state survives mode switches');
  });
});

describe('Renderer3D — previewMode option (consumed by admin-assets.html)', () => {
  const stubCanvas = () => ({
    parentElement: null, width: 800, height: 600, addEventListener() {},
  });

  test('defaults to false when no options are passed', () => {
    const r = new Renderer3D(stubCanvas(), { tiles: new Map(), entities: [] });
    assert.equal(r._previewMode, false);
  });

  test('flips to true when the constructor receives previewMode: true', () => {
    const r = new Renderer3D(stubCanvas(), { tiles: new Map(), entities: [] }, { previewMode: true });
    assert.equal(r._previewMode, true);
  });

  test('is exposed on the instance so test fixtures + assertions can inspect it', () => {
    // The flag is a private-by-convention `_previewMode` — read here just to
    // pin that future refactors don't rename it without updating call sites.
    const r = new Renderer3D(stubCanvas(), { tiles: new Map() }, { previewMode: true });
    assert.ok(Object.prototype.hasOwnProperty.call(r, '_previewMode'),
      'instances must carry _previewMode so the build-map gates can read it');
  });
});
