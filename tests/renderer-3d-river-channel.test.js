// R5 — River channel (variable width by curvature, sunken bed, dirt banks).
// These tests cover the pure helper + the integration contract between
// `_buildNetworkMesh('river',…)` and the sibling `_buildRiverBankMeshes` pass.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  riverHalfWidthsByCurvature,
  riverCornerY,
  RIVER_HALF_WIDTH_MIN,
  RIVER_HALF_WIDTH_MAX,
  RIVER_BED_Y,
  RIVER_BANK_TOP_Y,
  RIVER_BANK_WIDTH,
  RIVER_RIBBON_Y,
  RIVER_RIBBON_WIDTH,
  RIVER_RIBBON_U_SCALE,
  RIVER_ALPHA_INDEX,
  SPLAT_RIVER_CENTRE_EPS,
  Renderer3D,
} from '../src/renderer-3d.js';
import { hexKey } from '../src/hex.js';
import { Tile, TileType } from '../src/tiles.js';

describe('R5 — channel constants', () => {
  test('RIVER_BED_Y sits clearly below ground (negative Y)', () => {
    assert.ok(RIVER_BED_Y < 0, `RIVER_BED_Y ${RIVER_BED_Y} should be negative`);
    assert.ok(RIVER_BED_Y < -0.05,
      `RIVER_BED_Y ${RIVER_BED_Y} should be deep enough to read as a real depression`);
  });

  test('RIVER_BANK_TOP_Y sits above ground (positive depth-bias against terrain)', () => {
    assert.ok(RIVER_BANK_TOP_Y > 0,
      `RIVER_BANK_TOP_Y ${RIVER_BANK_TOP_Y} should be a small positive epsilon`);
    assert.ok(RIVER_BANK_TOP_Y < 0.05,
      `RIVER_BANK_TOP_Y ${RIVER_BANK_TOP_Y} should not visibly hover`);
  });

  test('legacy RIVER_RIBBON_Y stays a positive depth-bias (back-compat for road-style tests)', () => {
    assert.ok(RIVER_RIBBON_Y > 0 && RIVER_RIBBON_Y < 0.05,
      `RIVER_RIBBON_Y ${RIVER_RIBBON_Y} should remain a small positive epsilon`);
  });

  test('water MIN < water MAX half-widths so curvature can actually vary', () => {
    assert.ok(RIVER_HALF_WIDTH_MIN > 0);
    assert.ok(RIVER_HALF_WIDTH_MAX > RIVER_HALF_WIDTH_MIN,
      `MAX ${RIVER_HALF_WIDTH_MAX} should exceed MIN ${RIVER_HALF_WIDTH_MIN}`);
  });

  test('R5 polish 2 — water dominates the channel cross-section (water ≫ bank)', () => {
    // After widening the water and trimming the bank, water half-width on a
    // straight reach must be several times the per-side bank width — otherwise
    // we're back to "creek with arrow-shaped puddles in a brown channel".
    assert.ok(RIVER_HALF_WIDTH_MIN >= 4 * RIVER_BANK_WIDTH,
      `water MIN ${RIVER_HALF_WIDTH_MIN} should be ≥4× bank ${RIVER_BANK_WIDTH}`);
  });

  test('total channel outer half stays within a hex half-width and pan-clamp envelope', () => {
    // Pointy-top hex world half-width = HEX_RADIUS_WORLD × √3/2 ≈ 0.866 with
    // the renderer's HEX_RADIUS_WORLD = 1. The widened channel must still fit
    // inside the hex it threads through.
    const outerHalf = RIVER_HALF_WIDTH_MAX + RIVER_BANK_WIDTH;
    const hexHalfWidth = Math.sqrt(3) / 2;
    assert.ok(outerHalf < hexHalfWidth,
      `channel outer extent ${outerHalf} must fit inside a hex (${hexHalfWidth})`);
    // The pan-clamp uses RIVER_RIBBON_WIDTH/2 + 0.20 as the river half-width;
    // keep the channel inside that bound so the camera-clamp envelope stays
    // honest.
    const clampHalf = RIVER_RIBBON_WIDTH / 2 + 0.20;
    assert.ok(outerHalf <= clampHalf + 1e-9,
      `channel outer extent ${outerHalf} should sit inside pan-clamp envelope ${clampHalf}`);
  });
});

describe('R5 polish 2 — river ribbon U-axis tile rate', () => {
  test('RIVER_RIBBON_U_SCALE > 1 so the flow texture repeats inside each tile-segment', () => {
    // Without uScale>1 the river-ribbon.png maps exactly one arrow per
    // tile-segment and the current reads as floating arrows. The repeat is
    // what makes the flow look continuous.
    assert.ok(RIVER_RIBBON_U_SCALE > 1,
      `RIVER_RIBBON_U_SCALE ${RIVER_RIBBON_U_SCALE} should tile the flow texture`);
  });

  test('_buildRibbonMaterial("river", …) sets uScale on the diffuse texture; road does not', () => {
    function makeBabylonStub() {
      class Color3 {
        constructor(r = 0, g = 0, b = 0) { this.r = r; this.g = g; this.b = b; }
        clone() { return new Color3(this.r, this.g, this.b); }
      }
      const StandardMaterial = function (name) {
        this.name = name;
        this.diffuseColor  = new Color3(1, 1, 1);
        this.emissiveColor = new Color3(0, 0, 0);
        this.specularColor = new Color3(0, 0, 0);
        this.diffuseTexture = null;
        this.useAlphaFromDiffuseTexture = false;
        this.backFaceCulling = true;
        this.disableLighting = false;
      };
      const Texture = function (url) {
        this.url = url;
        this.wrapU = 0;
        this.wrapV = 0;
        this.hasAlpha = false;
        this.uScale = 1;
        this.uOffset = 0;
        this.level = 1;
      };
      return { Color3, StandardMaterial, Texture };
    }
    const inst = Object.create(Renderer3D.prototype);
    inst._babylon = makeBabylonStub();
    inst._scene = {};
    inst._assetsBasePath = 'assets';
    const riverMat = inst._buildRibbonMaterial('river', '#1a3d5c');
    assert.ok(riverMat.diffuseTexture, 'expected river material to carry a diffuse texture');
    assert.equal(riverMat.diffuseTexture.uScale, RIVER_RIBBON_U_SCALE,
      `river ribbon texture uScale should equal RIVER_RIBBON_U_SCALE (${RIVER_RIBBON_U_SCALE})`);
    assert.equal(riverMat.diffuseTexture.wrapU, 1,
      'river ribbon texture must wrap along U so uScale tiles cleanly');
    const roadMat = inst._buildRibbonMaterial('road', '#6b5a3e');
    assert.ok(roadMat.diffuseTexture, 'expected road material to carry a diffuse texture');
    assert.equal(roadMat.diffuseTexture.uScale, 1,
      'road texture should NOT pick up the river uScale tile rate');
  });
});

describe('riverHalfWidthsByCurvature', () => {
  test('empty / null / 1-point input returns []', () => {
    assert.deepEqual(riverHalfWidthsByCurvature(null), []);
    assert.deepEqual(riverHalfWidthsByCurvature([]), []);
    assert.deepEqual(riverHalfWidthsByCurvature([{ x: 0, z: 0 }]), []);
  });

  test('2-point stub returns MIN width (straight by definition)', () => {
    const w = riverHalfWidthsByCurvature([{ x: 0, z: 0 }, { x: 1, z: 0 }]);
    assert.equal(w.length, 2);
    assert.equal(w[0], RIVER_HALF_WIDTH_MIN);
    assert.equal(w[1], RIVER_HALF_WIDTH_MIN);
  });

  test('straight 3-point line yields MIN width everywhere', () => {
    const pts = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const w = riverHalfWidthsByCurvature(pts);
    for (const v of w) {
      assert.ok(Math.abs(v - RIVER_HALF_WIDTH_MIN) < 1e-9,
        `straight line should sit at MIN ${RIVER_HALF_WIDTH_MIN}, got ${v}`);
    }
  });

  test('sharp 90° corner at the midpoint widens past the straight line', () => {
    const pts = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 1, z: 1 }];
    const w = riverHalfWidthsByCurvature(pts);
    assert.ok(w[1] > RIVER_HALF_WIDTH_MIN + 1e-6,
      `corner apex width ${w[1]} should exceed MIN ${RIVER_HALF_WIDTH_MIN}`);
  });

  test('widths are clamped to [MIN, MAX] even for very sharp turns', () => {
    const pts = [{ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0, z: 0 }];
    const w = riverHalfWidthsByCurvature(pts);
    for (const v of w) {
      assert.ok(v >= RIVER_HALF_WIDTH_MIN - 1e-9 && v <= RIVER_HALF_WIDTH_MAX + 1e-9,
        `${v} should fall within [${RIVER_HALF_WIDTH_MIN}, ${RIVER_HALF_WIDTH_MAX}]`);
    }
  });
});

// ─── Integration: bank ribbons land in _tilePropsByKey ──────────────────────

function makeColor3() {
  class Color3 {
    constructor(r = 0, g = 0, b = 0) { this.r = r; this.g = g; this.b = b; }
    clone() { return new Color3(this.r, this.g, this.b); }
  }
  return Color3;
}

function makeFakeBabylon() {
  const Color3 = makeColor3();
  class Vector3 {
    constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
  }
  let mergedCount = 0;
  const StandardMaterial = class StandardMaterial {
    constructor(name) {
      this.name = name;
      this.diffuseColor  = new Color3(0.5, 0.5, 0.5);
      this.emissiveColor = new Color3(0, 0, 0);
      this.specularColor = new Color3(0, 0, 0);
      this.diffuseTexture = null;
      this.useAlphaFromDiffuseTexture = false;
      this.backFaceCulling = true;
      this.disableLighting = false;
      this.transparencyMode = 0;
    }
    clone(newName) {
      const c = new StandardMaterial(newName);
      c.diffuseColor = this.diffuseColor.clone();
      c.emissiveColor = this.emissiveColor.clone();
      c.specularColor = this.specularColor.clone();
      c.diffuseTexture = this.diffuseTexture;
      c.useAlphaFromDiffuseTexture = this.useAlphaFromDiffuseTexture;
      c.backFaceCulling = this.backFaceCulling;
      c.disableLighting = this.disableLighting;
      c.transparencyMode = this.transparencyMode;
      return c;
    }
  };
  const makeFakeRibbon = (name, opts) => {
    const N = opts.pathArray[0].length;
    const P = opts.pathArray.length;
    const verts = new Map();
    const colors = new Float32Array(P * N * 4);
    verts.set('color', colors);
    return {
      name,
      isPickable: true,
      receiveShadows: false,
      hasVertexAlpha: false,
      alphaIndex: undefined,
      _pathArray: opts.pathArray,
      getTotalVertices() { return P * N; },
      setVerticesData(kind, data) { verts.set(kind, data); },
      getVerticesData(kind) { return verts.get(kind) ?? null; },
      dispose() {},
    };
  };
  return {
    Color3,
    Vector3,
    StandardMaterial,
    Texture: function () { return { wrapU: 0, wrapV: 0, level: 1, url: null }; },
    Material: { MATERIAL_ALPHABLEND: 2 },
    Mesh: {
      DOUBLESIDE: 2,
      MergeMeshes(list) {
        if (!list || list.length === 0) return null;
        return {
          name: `merged_${mergedCount++}`,
          parent: null,
          isPickable: true,
          receiveShadows: false,
          hasVertexAlpha: false,
          alphaIndex: 0,
          metadata: null,
          material: null,
        };
      },
    },
    MeshBuilder: {
      CreateRibbon(name, opts) { return makeFakeRibbon(name, opts); },
    },
    VertexBuffer: { ColorKind: 'color', UVKind: 'uv', PositionKind: 'position', NormalKind: 'normal' },
  };
}

describe('R5 — _buildRiverBankMeshes integration', () => {
  function setupInst() {
    const inst = Object.create(Renderer3D.prototype);
    inst._babylon = makeFakeBabylon();
    inst._scene = {};
    inst._mapRoot = { name: 'mapRoot' };
    inst._tilePropsByKey = new Map();
    inst._setShadowReceiver = (m) => { m.receiveShadows = true; };
    inst._terrainDetailTexture = () => null;
    return inst;
  }

  test('river build emits BANK mesh in _tilePropsByKey alongside the water mesh', () => {
    const inst = setupInst();
    const stroke = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const segments = [{ tile: { col: 4, row: 2 }, strokes: [stroke] }];
    inst._buildNetworkMesh('river', segments, RIVER_RIBBON_WIDTH, RIVER_RIBBON_Y, '#1a3d5c');
    const tkey = '4,2';
    const props = inst._tilePropsByKey.get(tkey);
    assert.ok(props && props.length === 2,
      `expected 2 props (water + bank) at ${tkey}, got ${props && props.length}`);
    const kinds = props.map(p => p.metadata?.kind).sort();
    assert.deepEqual(kinds, ['river', 'river-bank'],
      `expected one 'river' + one 'river-bank', got ${JSON.stringify(kinds)}`);
  });

  test('bank ribbon alphaIndex sits BELOW the water (water draws on top of bed)', () => {
    const inst = setupInst();
    const stroke = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const segments = [{ tile: { col: 0, row: 0 }, strokes: [stroke] }];
    inst._buildNetworkMesh('river', segments, RIVER_RIBBON_WIDTH, RIVER_RIBBON_Y, '#1a3d5c');
    const props = inst._tilePropsByKey.get('0,0');
    const water = props.find(p => p.metadata?.kind === 'river');
    const bank  = props.find(p => p.metadata?.kind === 'river-bank');
    assert.ok(water && bank);
    assert.ok(bank.alphaIndex < water.alphaIndex,
      `bank alphaIndex ${bank.alphaIndex} should sit below water ${water.alphaIndex}`);
    assert.equal(water.alphaIndex, RIVER_ALPHA_INDEX);
  });

  test('bank mesh registers as a shadow receiver (so unit shadows fall on dirt banks too)', () => {
    const inst = setupInst();
    const stroke = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const segments = [{ tile: { col: 1, row: 1 }, strokes: [stroke] }];
    inst._buildNetworkMesh('river', segments, RIVER_RIBBON_WIDTH, RIVER_RIBBON_Y, '#1a3d5c');
    const props = inst._tilePropsByKey.get('1,1');
    const bank  = props.find(p => p.metadata?.kind === 'river-bank');
    assert.equal(bank.receiveShadows, true,
      'bank mesh must accept unit shadows like the water + ground around it');
  });

  test('bank material has a non-zero emissive so U-trench slope walls do not read black', () => {
    // The bank cross-section is a U-trench; the slope walls face mostly
    // sideways/downward and receive little diffuse contribution under the
    // directional sun. A baseline emissive lifts them into a readable warm
    // dirt tone regardless of lighting angle. Without it the playable river
    // banks rendered near-black under normal phase lighting.
    const inst = setupInst();
    const stroke = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const segments = [{ tile: { col: 2, row: 2 }, strokes: [stroke] }];
    inst._buildNetworkMesh('river', segments, RIVER_RIBBON_WIDTH, RIVER_RIBBON_Y, '#1a3d5c');
    const props = inst._tilePropsByKey.get('2,2');
    const bank  = props.find(p => p.metadata?.kind === 'river-bank');
    assert.ok(bank, 'expected a river-bank prop');
    assert.ok(bank.material, 'bank prop must carry its cloned material');
    const e = bank.material.emissiveColor;
    assert.ok(e, 'bank material must expose emissiveColor');
    assert.ok(e.r > 0 || e.g > 0 || e.b > 0,
      `bank emissive should be non-zero (got r=${e.r} g=${e.g} b=${e.b})`);
    // Fog parity: `baseEmissive` metadata must mirror the live material so
    // `_setTilePropsFogged` darkens the emissive alongside the diffuse when
    // the tile is fogged. Otherwise fogged banks would self-glow.
    const be = bank.metadata?.baseEmissive;
    assert.ok(be && (be.r > 0 || be.g > 0 || be.b > 0),
      `baseEmissive metadata must mirror the non-zero material emissive (got ${JSON.stringify(be)})`);
    assert.equal(be.r, e.r);
    assert.equal(be.g, e.g);
    assert.equal(be.b, e.b);
  });

  test('road build does NOT trigger the bank pass (no extra meshes)', () => {
    const inst = setupInst();
    const stroke = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const segments = [{ tile: { col: 7, row: 7 }, strokes: [stroke] }];
    inst._buildNetworkMesh('road', segments, 0.6, 0.025, '#6b5a3e');
    const props = inst._tilePropsByKey.get('7,7');
    assert.ok(props && props.length === 1, 'road tile should have exactly one prop (no bank)');
    assert.equal(props[0].metadata?.kind, 'road');
  });

  // R5 polish 3 — water material renders with the NORMAL depth test now.
  // The previous polish-2 workaround forced depthFunction=ALWAYS so the water
  // could draw through the displaced splat-ground cone (riverCornerY drops to
  // -0.18 on water hexes), but that also let the river paint OVER trees and
  // buildings sitting in front of it. The real fix is `disableDepthWrite` on
  // the splat material itself (see `_buildSplatMaterial`): the splat colours
  // still render correctly but the cone no longer pushes the depth buffer,
  // so the water at RIVER_BED_Y wins along the whole channel while trees +
  // buildings (which DO write depth) keep occluding it correctly. WebGL
  // ALWAYS = 519.
  test('water material does NOT force depthFunction=ALWAYS (splat handles it via disableDepthWrite)', () => {
    const inst = setupInst();
    const stroke = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const segments = [{ tile: { col: 5, row: 5 }, strokes: [stroke] }];
    inst._buildNetworkMesh('river', segments, RIVER_RIBBON_WIDTH, RIVER_RIBBON_Y, '#1a3d5c');
    const water = inst._tilePropsByKey.get('5,5')?.find(p => p.metadata?.kind === 'river');
    assert.ok(water, 'water mesh must exist');
    assert.notEqual(water.material.depthFunction, 519,
      `playable river water material must keep the normal depth test (not ALWAYS=519) so trees + buildings continue to occlude the river — got ${water.material.depthFunction}`);
  });

  test('road material does NOT touch depthFunction (road has no splat-cone occlusion)', () => {
    const inst = setupInst();
    const stroke = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const segments = [{ tile: { col: 8, row: 8 }, strokes: [stroke] }];
    inst._buildNetworkMesh('road', segments, 0.6, 0.025, '#6b5a3e');
    const road = inst._tilePropsByKey.get('8,8')?.find(p => p.metadata?.kind === 'road');
    assert.ok(road, 'road mesh must exist');
    // Either undefined (default LESS_EQUAL) or explicitly 0 — anything other
    // than ALWAYS (519) means we kept the normal depth test for roads.
    assert.notEqual(road.material.depthFunction, 519,
      'road material should not force depthFunction=ALWAYS — only the river ribbon needs the override');
  });

  // R5 polish 3 — `_riverFlowTextures` registry must be populated after each
  // river build so `_pumpRiverFlow` has a list of per-tile clone textures to
  // scroll. The polish-2 work moved code around in `_buildNetworkMesh`; this
  // is a regression guard so a later edit can't quietly de-list the textures
  // and silently break the river animation.
  test('_riverFlowTextures registry is populated after a river build', () => {
    const inst = setupInst();
    inst._assetsBasePath = 'assets';
    const stroke = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const segments = [
      { tile: { col: 2, row: 2 }, strokes: [stroke] },
      { tile: { col: 3, row: 2 }, strokes: [stroke] },
    ];
    inst._buildNetworkMesh('river', segments, RIVER_RIBBON_WIDTH, RIVER_RIBBON_Y, '#1a3d5c');
    assert.ok(Array.isArray(inst._riverFlowTextures),
      `_riverFlowTextures should be an array, got ${typeof inst._riverFlowTextures}`);
    assert.equal(inst._riverFlowTextures.length, segments.length,
      `_riverFlowTextures should hold one diffuse texture per per-tile river clone (expected ${segments.length}, got ${inst._riverFlowTextures.length})`);
  });

  // R5 polish 3 — the playable splat material must `disableDepthWrite` so the
  // displaced river-hex cone (centre/corners at riverCornerY) does not
  // depth-occlude the water ribbon at RIVER_BED_Y. Border splat already does
  // this via its alpha-blend pipeline; the opaque playable splat needs the
  // explicit flag.
  test('_buildSplatMaterial(opaque) sets disableDepthWrite so the river-hex cone does not occlude the water', () => {
    const inst = Object.create(Renderer3D.prototype);
    inst._babylon = {
      StandardMaterial: function (name) {
        this.name = name;
        this.disableDepthWrite = false;
        this.transparencyMode = 0;
        this.backFaceCulling = true;
        this.specularColor = null;
      },
      Color3: function (r, g, b) { this.r = r; this.g = g; this.b = b; },
      Material: { MATERIAL_ALPHABLEND: 2 },
    };
    inst._scene = {};
    inst._fogTileDarken = 1;
    inst._terrainDetailTexture = () => null;
    const mat = inst._buildSplatMaterial({ alphaBlend: false });
    assert.equal(mat.disableDepthWrite, true,
      'playable (opaque) splat material must disableDepthWrite so the river-hex cone does not depth-occlude the water ribbon');
  });
});

// ─── R5 follow-up: riverCornerY + symmetric splat-channel displacement ──────

describe('riverCornerY (pure helper)', () => {
  test('0 water neighbours → no drop', () => {
    assert.equal(riverCornerY(0), 0);
  });
  test('3 water neighbours → full bed depth', () => {
    assert.equal(riverCornerY(3), RIVER_BED_Y);
  });
  test('monotonic in waterCount (1 < 2 in magnitude)', () => {
    assert.ok(riverCornerY(1) < 0 && riverCornerY(1) > RIVER_BED_Y);
    assert.ok(riverCornerY(2) < riverCornerY(1)); // deeper
    assert.ok(riverCornerY(2) > RIVER_BED_Y);
  });
  test('clamps negative / out-of-range input', () => {
    assert.equal(riverCornerY(-2), 0);
    assert.equal(riverCornerY(99), RIVER_BED_Y);
  });
  test('non-integer input is coerced (floor via |0)', () => {
    assert.equal(riverCornerY(1.7), riverCornerY(1));
  });
});

describe('SPLAT_RIVER_CENTRE_EPS — channel constant', () => {
  test('strictly positive — splat centre must sit BELOW the water ribbon', () => {
    assert.ok(SPLAT_RIVER_CENTRE_EPS > 0,
      'centre epsilon must be > 0 so splat ground stays below the water ribbon and the river is visible');
  });
  test('small enough not to dominate the channel depth', () => {
    assert.ok(SPLAT_RIVER_CENTRE_EPS < Math.abs(RIVER_BED_Y),
      'centre epsilon should be much smaller than the bed depth itself');
  });
});

// Integration: build a real splat ground over a tiny river map and verify
// both (a) the centre/corner Y values match the spec and (b) every corner
// shared by multiple hexes lands at the SAME Y across all sharers.
describe('_buildSplatPlayableMesh — symmetric channel displacement', () => {
  function makeSplatBabylon() {
    const Color3 = makeColor3();
    class Vector3 {
      constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }
      set(x, y, z) { this.x = x; this.y = y; this.z = z; }
    }
    class Mesh {
      constructor(name) {
        this.name = name;
        this.position = new Vector3();
        this.metadata = null;
        this.material = null;
        this.parent = null;
        this._custom = new Map();
      }
      setVerticesData(kind, data) { this._custom.set(kind, data); }
    }
    class VertexData {
      applyToMesh(mesh) {
        mesh.positions = this.positions;
        mesh.indices   = this.indices;
        mesh.normals   = this.normals;
      }
    }
    return {
      Color3,
      Vector3,
      Mesh,
      VertexData,
      VertexBuffer: { ColorKind: 'color', UVKind: 'uv', PositionKind: 'position', NormalKind: 'normal' },
    };
  }

  function setupSplatInst(tiles) {
    const inst = Object.create(Renderer3D.prototype);
    inst._babylon = makeSplatBabylon();
    inst._scene = {};
    inst.state = { tiles };
    inst._buildSplatMaterial = () => ({ name: 'fakeSplatMat' });
    inst._setShadowReceiver = () => {};
    return inst;
  }

  function makeMap(riverKeys) {
    // 5×3 grid; cells in `riverKeys` get TileType.RIVER, everything else GRASS.
    const tiles = new Map();
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 5; col++) {
        const isRiverCell = riverKeys.has(`${col},${row}`);
        tiles.set(hexKey(col, row),
          new Tile(col, row, isRiverCell ? TileType.RIVER : TileType.GRASS));
      }
    }
    return tiles;
  }

  function cornerY(mesh, range, col, row, j) {
    const baseV = range.get(hexKey(col, row));
    return mesh.positions[(baseV + 1 + j) * 3 + 1];
  }
  function centreY(mesh, range, col, row) {
    const baseV = range.get(hexKey(col, row));
    return mesh.positions[baseV * 3 + 1];
  }
  function cornerXZ(mesh, range, col, row, j) {
    const baseV = range.get(hexKey(col, row));
    return {
      x: mesh.positions[(baseV + 1 + j) * 3 + 0],
      z: mesh.positions[(baseV + 1 + j) * 3 + 2],
    };
  }

  test('river hex centre sits BELOW the water ribbon (no z-fight)', () => {
    // Horizontal river across row=1: (1,1) (2,1) (3,1).
    const tiles = makeMap(new Set(['1,1', '2,1', '3,1']));
    const inst = setupSplatInst(tiles);
    inst._buildSplatPlayableMesh({ name: 'root' });
    const mesh  = inst._splatGround;
    const range = inst._hexVertexRange;
    for (const [c, r] of [[1, 1], [2, 1], [3, 1]]) {
      assert.ok(centreY(mesh, range, c, r) < RIVER_BED_Y,
        `river hex (${c},${r}) centre Y ${centreY(mesh, range, c, r)} should sit below RIVER_BED_Y ${RIVER_BED_Y}`);
    }
    // Grass hex centre stays at ground level.
    assert.equal(centreY(mesh, range, 0, 0), 0);
    assert.equal(centreY(mesh, range, 2, 0), 0);
  });

  test('corner shared by 3 grass hexes stays at Y=0', () => {
    const tiles = makeMap(new Set()); // pure grass
    const inst = setupSplatInst(tiles);
    inst._buildSplatPlayableMesh({ name: 'root' });
    const mesh  = inst._splatGround;
    const range = inst._hexVertexRange;
    for (let j = 0; j < 6; j++) {
      assert.equal(cornerY(mesh, range, 2, 1, j), 0,
        `grass-only corner j=${j} should remain at Y=0`);
    }
  });

  test('every shared corner agrees on Y across all hexes that touch it', () => {
    // Horizontal river through the middle row + one tributary going up from (2,1) to (2,0).
    const tiles = makeMap(new Set(['1,1', '2,1', '3,1', '2,0']));
    const inst = setupSplatInst(tiles);
    inst._buildSplatPlayableMesh({ name: 'root' });
    const mesh  = inst._splatGround;
    const range = inst._hexVertexRange;
    // Group every corner vertex by (rounded) XZ position; assert all Y values
    // in each group are identical. That's the symmetric-corner-drop invariant.
    const groups = new Map();
    for (const tile of tiles.values()) {
      for (let j = 0; j < 6; j++) {
        const { x, z } = cornerXZ(mesh, range, tile.col, tile.row, j);
        const y = cornerY(mesh, range, tile.col, tile.row, j);
        const k = `${x.toFixed(4)},${z.toFixed(4)}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push({ col: tile.col, row: tile.row, j, y });
      }
    }
    for (const [k, members] of groups) {
      if (members.length < 2) continue; // unshared border corner
      const y0 = members[0].y;
      for (const m of members) {
        // Float32 round-trip can lose a few ULPs; sub-1e-5 still nails the
        // "agree" invariant we care about (any real seam would be cm-scale).
        assert.ok(Math.abs(m.y - y0) < 1e-5,
          `corner ${k} sees Y=${y0} from ${members[0].col},${members[0].row}#${members[0].j} `
          + `but Y=${m.y} from ${m.col},${m.row}#${m.j} — seam gap!`);
      }
    }
  });

  test('corner interior to a 3-water junction lands at the full bed depth', () => {
    // Three river hexes meeting at a single corner: (1,1), (2,1), (2,0)
    // share corner — that corner should sit at riverCornerY(3) = RIVER_BED_Y.
    const tiles = makeMap(new Set(['1,1', '2,1', '2,0']));
    const inst = setupSplatInst(tiles);
    inst._buildSplatPlayableMesh({ name: 'root' });
    const mesh  = inst._splatGround;
    const range = inst._hexVertexRange;
    // Walk every shared corner and find the deepest Y; for this map the corner
    // shared by all 3 water tiles is the deepest, exactly RIVER_BED_Y.
    const groups = new Map();
    for (const tile of tiles.values()) {
      for (let j = 0; j < 6; j++) {
        const { x, z } = cornerXZ(mesh, range, tile.col, tile.row, j);
        const y = cornerY(mesh, range, tile.col, tile.row, j);
        const k = `${x.toFixed(4)},${z.toFixed(4)}`;
        if (!groups.has(k)) groups.set(k, { count: 0, y });
        groups.get(k).count++;
      }
    }
    let deepest = 0;
    for (const g of groups.values()) {
      if (g.count >= 3 && g.y < deepest) deepest = g.y;
    }
    // Float32 storage loses ~1e-7 of precision on RIVER_BED_Y; allow a tiny
    // tolerance and assert depth (not exact equality).
    assert.ok(Math.abs(deepest - RIVER_BED_Y) < 1e-5,
      `corner shared by 3 water hexes should sit at RIVER_BED_Y ${RIVER_BED_Y}, got ${deepest}`);
  });
});
