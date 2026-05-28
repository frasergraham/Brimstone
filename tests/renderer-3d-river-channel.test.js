// R5 — River channel (variable width by curvature, sunken bed, dirt banks).
// These tests cover the pure helper + the integration contract between
// `_buildNetworkMesh('river',…)` and the sibling `_buildRiverBankMeshes` pass.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  riverHalfWidthsByCurvature,
  RIVER_HALF_WIDTH_MIN,
  RIVER_HALF_WIDTH_MAX,
  RIVER_BED_Y,
  RIVER_BANK_TOP_Y,
  RIVER_BANK_WIDTH,
  RIVER_RIBBON_Y,
  RIVER_RIBBON_WIDTH,
  RIVER_ALPHA_INDEX,
  Renderer3D,
} from '../src/renderer-3d.js';

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

  test('total channel outer half (water MAX + bank) stays within a sane envelope', () => {
    const outerHalf = RIVER_HALF_WIDTH_MAX + RIVER_BANK_WIDTH;
    assert.ok(outerHalf <= RIVER_RIBBON_WIDTH / 2 + RIVER_BANK_WIDTH + 1e-9,
      `channel outer extent ${outerHalf} should fit inside the legacy footprint+bank`);
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

  test('road build does NOT trigger the bank pass (no extra meshes)', () => {
    const inst = setupInst();
    const stroke = [{ x: 0, z: 0 }, { x: 0.5, z: 0 }, { x: 1, z: 0 }];
    const segments = [{ tile: { col: 7, row: 7 }, strokes: [stroke] }];
    inst._buildNetworkMesh('road', segments, 0.6, 0.025, '#6b5a3e');
    const props = inst._tilePropsByKey.get('7,7');
    assert.ok(props && props.length === 1, 'road tile should have exactly one prop (no bank)');
    assert.equal(props[0].metadata?.kind, 'road');
  });
});
