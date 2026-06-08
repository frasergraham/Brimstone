// Asset-base resolution for the /admin/tools 3D surfaces (Assets/Lighting tabs
// + the Mission Editor "Preview in 3D" overlay).
//
// Regression for the "preview/lighting render but show no textures or GLB
// models" bug. admin-tools.html is served at the SUB-PATH url `/admin/tools`,
// so a *relative* asset base ('assets') resolves against `/admin/` →
// `/admin/assets/...` → 404 for the tilemap atlas and every GLB. The live game
// dodges this only because it is served from the root url. The fix:
//   1. mission-editor-ui exports an absolute ASSET_BASE + resolveAssetBase()
//      guard, used by both the 2D editor renderer and the 3D preview.
//   2. Renderer3D.beginLoad(basePath) accepts the base SYNCHRONOUSLY (loadImages
//      only pins it after its async image load — too late for beginLoad to read).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { ASSET_BASE, resolveAssetBase } from '../src/tools/mission-editor-ui.js';
import { Renderer3D } from '../src/renderer-3d.js';

const FAKE_CANVAS = { parentElement: null, width: 800, height: 600 };

describe('resolveAssetBase', () => {
  test('ASSET_BASE is absolute (must not resolve against /admin/)', () => {
    assert.equal(ASSET_BASE, '/assets');
    assert.ok(ASSET_BASE.startsWith('/'), 'asset base must be absolute');
  });

  test('passes absolute bases through unchanged', () => {
    assert.equal(resolveAssetBase('/assets'), '/assets');
    assert.equal(resolveAssetBase('/custom/assets'), '/custom/assets');
  });

  test('rejects relative / empty / non-string bases → ASSET_BASE fallback', () => {
    // A relative base is the exact failure mode under /admin/tools.
    assert.equal(resolveAssetBase('assets'), '/assets');
    assert.equal(resolveAssetBase(''), '/assets');
    assert.equal(resolveAssetBase(undefined), '/assets');
    assert.equal(resolveAssetBase(null), '/assets');
    assert.equal(resolveAssetBase(42), '/assets');
  });
});

describe('Renderer3D.beginLoad(basePath)', () => {
  /** Stub the renderer so beginLoad() runs without a real Babylon engine and we
   *  can observe which base every loader received. */
  function makeRenderer() {
    const r = new Renderer3D(FAKE_CANVAS, {});
    r._scene = {}; // truthy → scene-dependent GLB loaders actually fire
    const bases = {};
    r._initBabylon          = async () => {};
    r.loadImages            = async (b) => { bases.sprites = b; };
    r._loadBuildingModels   = async (b) => { bases.buildings = b; };
    // Hero rig now pre-warms through the cascade: _loadFallbackRig(file, base).
    r._loadFallbackRig      = async (_file, b) => { bases.paladin = b; };
    r._loadTreePackManifest = async (b) => { bases.forest = b; };
    return { r, bases };
  }

  test('pins an explicit absolute base synchronously (before any await)', () => {
    const { r } = makeRenderer();
    r.beginLoad('/assets');
    // Set synchronously inside beginLoad — not deferred to loadImages' async tail.
    assert.equal(r._assetsBasePath, '/assets');
  });

  test('threads the explicit base into every asset loader', async () => {
    const { r, bases } = makeRenderer();
    r.beginLoad('/assets');
    await new Promise(res => setTimeout(res, 0)); // let chained loaders run
    assert.equal(bases.sprites, '/assets');
    assert.equal(bases.buildings, '/assets');
    assert.equal(bases.paladin, '/assets');
    assert.equal(bases.forest, '/assets');
  });

  test('no-arg call keeps the relative default (unchanged for the root-served live game)', () => {
    const { r } = makeRenderer();
    r.beginLoad();
    // _assetsBasePath stays null → loaders get the relative 'assets' fallback,
    // which is correct when the host page is served from the site root.
    assert.equal(r._assetsBasePath, null);
  });

  test('a previously-set base (via loadImages) is preserved when beginLoad gets no arg', () => {
    const { r, bases } = makeRenderer();
    r._assetsBasePath = '/assets'; // as if loadImages('/assets') already resolved
    r.beginLoad();
    assert.equal(r._assetsBasePath, '/assets');
    return new Promise(res => setTimeout(res, 0)).then(() => {
      assert.equal(bases.buildings, '/assets');
    });
  });
});
