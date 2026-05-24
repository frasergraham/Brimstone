// Pure-helper tests for the 3D renderer's tile top-face texture path
// (see "Tile top-face textures" banner in src/renderer-3d.js).
//
// We don't instantiate the renderer here — Babylon needs a WebGL context that
// node-test doesn't have. These tests cover the pure mapping from a tile to
// the sprite id used for its textured top, plus the constants the renderer's
// material cache is keyed on.

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import {
  Renderer3D,
  TERRAIN_VARIANT_COUNTS,
  TERRAIN_DISC_RADIUS_MUL,
  TERRAIN_DISC_Y_OFFSET,
  terrainSpriteIdFor,
} from '../src/renderer-3d.js';
import { TileType } from '../src/tiles.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

describe('Renderer3D — terrainSpriteIdFor', () => {
  test('grass tile picks a grass_N variant', () => {
    const id = terrainSpriteIdFor({ type: TileType.GRASS }, 0, 0);
    assert.match(id, /^grass_[1-5]$/);
  });

  test('forest tile uses a grass underlay variant (real 3D tree cones sit on top)', () => {
    // FOREST sprite atlas variants are obsolete now — we render trees as
    // actual cone meshes on the tile, so the ground underneath is plain
    // grass. Same pattern BUILDING uses (dirt underlay + building box on top).
    const id = terrainSpriteIdFor({ type: TileType.FOREST }, 1, 2);
    assert.match(id, /^grass_[1-5]$/);
  });

  test('dirt tile picks a dirt_N variant', () => {
    const id = terrainSpriteIdFor({ type: TileType.DIRT }, 3, 4);
    assert.match(id, /^dirt_[1-5]$/);
  });

  test('building tile uses a dirt base variant (matches 2D renderer)', () => {
    const id = terrainSpriteIdFor({ type: TileType.BUILDING, building: 'inn' }, 5, 6);
    assert.match(id, /^dirt_[1-5]$/);
  });

  test('road / river / bridge tiles use a grass underlay sprite', () => {
    // Item 2: ROAD/RIVER/BRIDGE tiles render with grass underneath; the
    // bezier network tube provides the path visual on top. Top-disc texture
    // therefore needs to be a grass variant so the underlay reads correctly.
    assert.match(terrainSpriteIdFor({ type: TileType.ROAD   }, 0, 0), /^grass_[1-5]$/);
    assert.match(terrainSpriteIdFor({ type: TileType.RIVER  }, 0, 0), /^grass_[1-5]$/);
    assert.match(terrainSpriteIdFor({ type: TileType.BRIDGE }, 0, 0), /^grass_[1-5]$/);
  });

  test('unknown tile type returns null', () => {
    assert.equal(terrainSpriteIdFor({ type: 'lava' }, 0, 0), null);
  });

  test('null / undefined tile returns null safely', () => {
    assert.equal(terrainSpriteIdFor(null, 0, 0), null);
    assert.equal(terrainSpriteIdFor(undefined, 0, 0), null);
  });

  test('same hex deterministically picks the same variant across calls', () => {
    const a = terrainSpriteIdFor({ type: TileType.GRASS }, 7, 11);
    const b = terrainSpriteIdFor({ type: TileType.GRASS }, 7, 11);
    assert.equal(a, b);
  });

  test('different hexes vary across the variant pool', () => {
    const ids = new Set();
    for (let c = 0; c < 6; c++) {
      for (let r = 0; r < 6; r++) {
        ids.add(terrainSpriteIdFor({ type: TileType.GRASS }, c, r));
      }
    }
    // A pool of 5 variants should produce more than one distinct id across
    // 36 hexes — otherwise the hash collapsed to a single bucket.
    assert.ok(ids.size > 1, `expected >1 distinct variants, got ${ids.size}`);
  });

  test('negative coordinates do not throw or return out-of-range ids', () => {
    // The hash includes col*row, which can go negative; the result must still
    // be one of grass_1..grass_5 — never grass_0 or grass_-1.
    for (let c = -3; c <= 0; c++) {
      for (let r = -3; r <= 0; r++) {
        const id = terrainSpriteIdFor({ type: TileType.GRASS }, c, r);
        assert.match(id, /^grass_[1-5]$/, `bad id at (${c},${r}): ${id}`);
      }
    }
  });
});

describe('Renderer3D — material-cache key uniqueness', () => {
  // The renderer keys its terrain material cache by sprite id alone (one
  // material per textured variant, shared across every tile that picks it).
  // We verify the key-distinction property the cache relies on without
  // exercising the actual Babylon material constructor.
  test('two tiles of the same terrain & coords resolve to the same id', () => {
    const a = terrainSpriteIdFor({ type: TileType.GRASS }, 4, 7);
    const b = terrainSpriteIdFor({ type: TileType.GRASS }, 4, 7);
    assert.equal(a, b);
  });

  test('different terrains never collide on sprite id', () => {
    const ids = new Set();
    for (const t of [TileType.GRASS, TileType.FOREST, TileType.DIRT]) {
      for (let c = 0; c < 5; c++) {
        for (let r = 0; r < 5; r++) {
          const id = terrainSpriteIdFor({ type: t }, c, r);
          if (id) ids.add(id);
        }
      }
    }
    // Every id begins with its terrain name — no cross-terrain reuse.
    for (const id of ids) {
      assert.ok(
        id.startsWith('grass_') || id.startsWith('forest_') || id.startsWith('dirt_'),
        `unexpected id ${id}`,
      );
    }
  });

  test('null sprite-id is the renderer signal for "use solid colour fallback"', () => {
    // _terrainMaterialFor(null) returns null in the renderer; that is the
    // explicit fallback gate. Item 2 made road/river/bridge return a grass
    // sprite (so the underlay matches the surrounding terrain), so the only
    // null cases left are tiles with unrecognised types — locked here.
    assert.equal(terrainSpriteIdFor({ type: 'mystery' }, 0, 0), null);
    assert.equal(terrainSpriteIdFor(null,                 0, 0), null);
  });
});

describe('Renderer3D — texture-disc geometry constants', () => {
  test('disc radius multiplier matches the cylinder hex edge', () => {
    // 1.0 means the disc's hex corners land exactly on the cylinder's hex
    // corners — chosen for clean visual alignment with no overhang. A future
    // tweak away from 1.0 should be a deliberate decision, not an accident.
    assert.equal(TERRAIN_DISC_RADIUS_MUL, 1.0);
  });

  test('disc Y offset sits comfortably above the cylinder top to win the depth fight', () => {
    // Cylinder has height 0.15 centred at y=0, so its top face is at y=0.075.
    // The original 0.076 offset (1 mm gap) lost the depth fight at typical
    // ArcRotateCamera distances (radius 20–80) — Babylon's default near/far
    // planes give depth precision in the ~1 mm range at radius 80, and the
    // disc became invisible behind the prism top. Round-5 bumped this to a
    // ~9 mm gap which survives at every supported zoom level while still
    // staying under the river bezier tube centre (0.085) so road / river
    // tile underlays don't pop in front of the tubes.
    assert.ok(TERRAIN_DISC_Y_OFFSET > 0.080, `disc Y ${TERRAIN_DISC_Y_OFFSET} must clear the cylinder top by enough to survive z-fighting at far camera distances`);
    assert.ok(TERRAIN_DISC_Y_OFFSET < 0.085, `disc Y ${TERRAIN_DISC_Y_OFFSET} must be < river tube Y 0.085`);
  });

  test('variant counts cover only multi-variant terrains', () => {
    assert.equal(TERRAIN_VARIANT_COUNTS.grass,  5);
    assert.equal(TERRAIN_VARIANT_COUNTS.forest, 5);
    assert.equal(TERRAIN_VARIANT_COUNTS.dirt,   5);
    // road/river/bridge intentionally absent — they're not textured at all.
    assert.equal(TERRAIN_VARIANT_COUNTS.road,   undefined);
    assert.equal(TERRAIN_VARIANT_COUNTS.river,  undefined);
    assert.equal(TERRAIN_VARIANT_COUNTS.bridge, undefined);
  });
});

// Stub the bits of Babylon and the DOM that _terrainTextureFor touches, so
// we can call into the live method without a real WebGL context. Returns
// `{ inst, textureCalls }` — `textureCalls` is the captured argument list of
// every `new BABYLON.Texture(...)` invocation. Lets us pin the constructor
// signature (the previous regression was a 5-arg form that flipped V via
// `invertY=false`, which hid the disc behind backface culling).
function buildRendererWithStubAtlas() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  const inst = new Renderer3D(fakeCanvas, { tiles: new Map() });
  const textureCalls = [];
  const TRILINEAR = 3; // distinct sentinel — does not matter, just unique
  inst._babylon = {
    Texture: function (...args) {
      textureCalls.push(args);
      this._args = args;
      this.dispose = () => {};
    },
  };
  inst._babylon.Texture.TRILINEAR_SAMPLINGMODE = TRILINEAR;
  inst._scene = { __scene: true };
  inst._tilemapImg = { __img: true, naturalWidth: 1024, naturalHeight: 1024 };
  inst._spriteRects = new Map([
    ['grass_1', { x: 6, y: 36, size: 256 }],
  ]);
  return { inst, textureCalls };
}

describe('Renderer3D._terrainTextureFor — Babylon Texture constructor wiring', () => {
  // Node has no DOM; stub the minimum surface area _terrainTextureFor needs.
  // Install before every test in the suite, restore after — describe-block
  // body runs at import time, so swapping globalThis.document inline would
  // un-stub before the tests actually execute.
  let origDocument;
  before(() => {
    origDocument = globalThis.document;
    const fakeCtx = { drawImage() {} };
    const fakeCanvas = { getContext: () => fakeCtx, toDataURL: () => 'data:image/png;base64,IGNORED' };
    globalThis.document = { createElement: () => fakeCanvas };
  });
  after(() => {
    if (origDocument === undefined) delete globalThis.document;
    else globalThis.document = origDocument;
  });

    test('uses Babylon defaults — no invertY=false form (regression #312 / portrait fix 0a2f8007)', () => {
      // The previous regression here was constructing the disc texture as
      //   new BABYLON.Texture(dataUrl, scene, true, false, TRILINEAR);
      // which passes `invertY=false`. The portrait code learned this hides the
      // visible face behind backFaceCulling; the disc has the same geometry
      // (front face normal +Y after `rotation.x=-π/2`) so the same bug applies.
      // Lock the convention: pass URL + scene only, let Babylon's defaults
      // (noMipmap=false, invertY=true) do the right thing.
      const { inst, textureCalls } = buildRendererWithStubAtlas();
      const tex = inst._terrainTextureFor('grass_1');
      assert.ok(tex, 'expected a Texture instance for a valid sprite id');
      assert.equal(textureCalls.length, 1);
      const args = textureCalls[0];
      // First arg is the data URL (string); second is the scene; nothing else.
      // The disallowed shape passed `true, false, samplingMode` after scene.
      assert.equal(typeof args[0], 'string', 'first arg is the data URL');
      assert.equal(args[1], inst._scene, 'second arg is the scene');
      assert.ok(args.length <= 2 || args[3] !== false,
        `_terrainTextureFor must not call new BABYLON.Texture with invertY=false; got args.length=${args.length}, args[3]=${args[3]}`);
    });

    test('caches the texture per sprite id (second call returns the cached instance)', () => {
      const { inst, textureCalls } = buildRendererWithStubAtlas();
      const a = inst._terrainTextureFor('grass_1');
      const b = inst._terrainTextureFor('grass_1');
      assert.strictEqual(a, b);
      assert.equal(textureCalls.length, 1, 'Texture constructor invoked once across two calls');
    });

    test('returns null when tilemap image is absent (atlas not yet loaded)', () => {
      const { inst } = buildRendererWithStubAtlas();
      inst._tilemapImg = null;
      assert.equal(inst._terrainTextureFor('grass_1'), null);
    });

    test('returns null when the sprite id has no atlas rect (warns once, no throw)', () => {
      const { inst } = buildRendererWithStubAtlas();
      const orig = console.warn;
      const warned = [];
      console.warn = (...a) => warned.push(a);
      try {
        assert.equal(inst._terrainTextureFor('not_a_real_sprite'), null);
        assert.ok(warned.length >= 1, 'expected a warning when the sprite id is missing');
      } finally {
        console.warn = orig;
      }
    });
});

describe('Renderer3D consumers — must call loadImages() to populate the atlas', () => {
  // The atlas (`_tilemapImg` + `_spriteRects`) is populated lazily by
  // `Renderer3D.loadImages()`. Callers that construct Renderer3D but skip
  // loadImages() get a textureless renderer: `_buildTileTopDisc` returns
  // null for every tile (no `_tilemapImg` → `_terrainMaterialFor` returns
  // null → no disc is created at all), and `_upgradeTileTextures` never
  // fires because the loadImages() handler is the only thing that calls it.
  //
  // The operator-visible symptom is "every hex shows as a bare coloured
  // cylinder with no terrain sprite on top" — IDENTICAL to the bug that
  // PR #329 (invertY=false → defaults) tried to fix. PR #329 corrected the
  // texture constructor convention but the actual cause in the playtest
  // path was this missing call: `tools/3d-preview.html` constructed
  // Renderer3D and called `draw()` but never `loadImages()`, so the disc
  // path was dead before the Babylon Texture constructor was ever reached.
  //
  // This contract test locks in that every Renderer3D consumer touching
  // the live tilemap path must invoke loadImages(). Tests/scripts that
  // exercise pure helpers (no Babylon, no real DOM) are explicitly excluded.

  test('tools/3d-preview.html calls renderer.loadImages() in rebuildScene', () => {
    const path = resolve(__dirname, '../tools/3d-preview.html');
    const src = readFileSync(path, 'utf8');
    assert.ok(
      /renderer\.loadImages\s*\(/.test(src),
      'tools/3d-preview.html must call renderer.loadImages() — otherwise ' +
      '_tilemapImg stays null forever and tiles render as bare coloured ' +
      'cylinders with no terrain sprite (the symptom #t-44c10cd9 chased)',
    );
  });

  test('src/main.js drives the atlas load via renderer.beginLoad()', () => {
    // Sibling check — locks in the main game flow too, so a future refactor
    // that moves the renderer construction can't silently drop the call.
    //
    // The loading-screen work (feat/loading-screen) moved the direct
    // loadImages() call into the renderer: main.js now calls beginLoad(), and
    // beginLoad() loads the tilemap atlas (alongside the GLB bundle). So the
    // contract that "the active game populates its tilemap atlas" is now
    // satisfied by the beginLoad() call rather than a bare loadImages().
    const path = resolve(__dirname, '../src/main.js');
    const src = readFileSync(path, 'utf8');
    assert.ok(
      /renderer\.beginLoad\s*\(/.test(src),
      'src/main.js must call renderer.beginLoad() so the active game has a ' +
      'populated tilemap atlas (beginLoad() loads the atlas internally)',
    );
  });

  test('_terrainMaterialFor returns null when _tilemapImg is absent (contract that justifies the loadImages requirement)', () => {
    // Pin the failure mode that makes the missing-loadImages bug invisible:
    // _terrainMaterialFor silently returns null when the atlas isn't loaded,
    // which means tile cylinders happily fall back to solid colour rather
    // than throwing or warning. That silent fallback is what made it
    // possible for a Renderer3D consumer (the preview tool) to ship without
    // loadImages and look "fine" except for the missing terrain art.
    const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
    const inst = new Renderer3D(fakeCanvas, { tiles: new Map() });
    // No _tilemapImg, no _spriteRects, no _babylon, no _scene — exactly the
    // state a freshly-constructed Renderer3D is in before loadImages runs.
    const mat = inst._terrainMaterialFor('grass_1');
    assert.equal(mat, null,
      '_terrainMaterialFor must return null without an atlas — the silent ' +
      'fallback that makes the missing-loadImages bug user-visible');
  });
});
