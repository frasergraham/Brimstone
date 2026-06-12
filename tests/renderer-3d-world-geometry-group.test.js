// Unit-vs-building occlusion (task t-4d82b52e).
//
// Babylon's `renderingGroupId` groups bypass the depth buffer — a mesh in
// group 1 ALWAYS draws above a mesh in group 0 regardless of world-space
// depth. Previously the renderer used group 1 for unit standees and per-unit
// hex outlines, which made them draw on top of buildings even when the
// camera angle placed a building between the camera and the unit. The fix
// is to keep ALL world geometry in WORLD_GROUP (0) so the depth buffer
// handles z-order, and reserve higher groups strictly for UI elements that
// must override depth-test (icon billboards / floaters → UNIT_ICON_GROUP,
// planning attack overlays → ATTACK_OVERLAY_GROUP).
//
// The policy now lives in named, exported constants which every assignment
// in src/renderer-3d.js uses — so we test (a) the constant relationships and
// (b) behaviourally, by running real builders over stubbed Babylon objects
// and reading the group each created mesh was assigned.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import {
  Renderer3D,
  WORLD_GROUP,
  UNIT_ICON_GROUP,
  ATTACK_OVERLAY_GROUP,
  XRAY_GHOST_GROUP,
} from '../src/renderer-3d.js';

// ─── The group constants encode the occlusion policy ────────────────────────

describe('Renderer3D — rendering group policy constants', () => {
  test('WORLD_GROUP is 0 — the depth buffer owns world z-order', () => {
    assert.equal(WORLD_GROUP, 0,
      'world geometry must live in Babylon\'s default group 0 so a building ' +
      'between the camera and a unit correctly hides the unit');
  });

  test('x-ray ghosts share the world group (they depth-test against occluders)', () => {
    assert.equal(XRAY_GHOST_GROUP, WORLD_GROUP);
  });

  test('UI groups stack strictly above world geometry: world < icon < attack overlay', () => {
    assert.ok(UNIT_ICON_GROUP > WORLD_GROUP,
      'icon billboards / floaters must beat world geometry');
    assert.ok(ATTACK_OVERLAY_GROUP > UNIT_ICON_GROUP,
      'attack overlays must beat icon billboards');
    assert.ok(ATTACK_OVERLAY_GROUP <= 3,
      'Babylon supports groups 0..3 by default');
  });
});

// ─── Stubbed-Babylon harness ────────────────────────────────────────────────

function makeMesh(name) {
  return {
    name,
    isPickable: true,
    isVisible: true,
    visibility: 1,
    renderingGroupId: -1, // sentinel — builders must overwrite it
    billboardMode: 0,
    parent: null,
    material: null,
    uniqueId: 1,
    disposed: 0,
    position: { x: 0, y: 0, z: 0, set(x, y, z) { this.x = x; this.y = y; this.z = z; } },
    dispose() { this.disposed += 1; },
  };
}

function makeFakeBabylon() {
  class Vector3 { constructor(x, y, z) { this.x = x; this.y = y; this.z = z; } }
  class Color3  { constructor(r, g, b) { this.r = r; this.g = g; this.b = b; } }
  class StandardMaterial {
    constructor(name) { this.name = name; }
    dispose() {}
  }
  class DynamicTexture {
    constructor(name) {
      this.name = name;
      this.hasAlpha = false;
      this._ctx = {
        clearRect() {}, beginPath() {}, closePath() {}, moveTo() {}, lineTo() {},
        arc() {}, arcTo() {}, fill() {}, stroke() {}, clip() {},
        save() {}, restore() {}, fillRect() {}, drawImage() {},
        strokeText() {}, fillText() {},
        measureText: (s) => ({ width: String(s).length * 10 }),
        set font(_v) {}, set textAlign(_v) {}, set textBaseline(_v) {},
        set fillStyle(_v) {}, set strokeStyle(_v) {}, set lineWidth(_v) {},
        set lineCap(_v) {}, set lineJoin(_v) {}, set miterLimit(_v) {},
      };
    }
    getContext() { return this._ctx; }
    update() {}
    dispose() {}
  }
  function Animation(name, targetProperty) {
    this.name = name; this.targetProperty = targetProperty;
  }
  Animation.ANIMATIONTYPE_FLOAT = 0;
  Animation.ANIMATIONLOOPMODE_CONSTANT = 0;
  Animation.prototype.setKeys = function (k) { this.keys = k; };
  Animation.prototype.setEasingFunction = function () {};
  const Mesh = { BILLBOARDMODE_ALL: 7, DOUBLESIDE: 2, CAP_ALL: 3 };
  const MeshBuilder = {
    CreateTube:  (name) => makeMesh(name),
    CreatePlane: (name) => makeMesh(name),
  };
  return {
    Vector3, Color3, StandardMaterial, DynamicTexture, Animation,
    Mesh, MeshBuilder,
  };
}

// ─── World geometry: per-unit hex outline rings live in WORLD_GROUP ─────────

describe('Renderer3D — _buildEntityHexOutline assigns WORLD_GROUP', () => {
  test('thin + thick outline tubes both land in the world group', () => {
    const inst = Object.create(Renderer3D.prototype);
    inst._babylon = makeFakeBabylon();
    inst._scene = {};
    inst._thinOutlineMatCache  = new Map();
    inst._thickOutlineMatCache = new Map();

    const outline = inst._buildEntityHexOutline(
      { id: 'e1', owner: 'hero', col: 2, row: 3 }, true,
    );

    assert.equal(outline.thin.renderingGroupId, WORLD_GROUP,
      'thin ring must depth-test against buildings — no group bump');
    assert.equal(outline.thick.renderingGroupId, WORLD_GROUP,
      'thick (selection) ring must depth-test against buildings too');
  });
});

// ─── UI sticker: floating combat text rides in UNIT_ICON_GROUP ──────────────

describe('Renderer3D — _spawnFloatingText assigns UNIT_ICON_GROUP', () => {
  test('the floater plane renders above all world geometry', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = Object.create(Renderer3D.prototype);
    const planes = [];
    const B = makeFakeBabylon();
    const origCreatePlane = B.MeshBuilder.CreatePlane;
    B.MeshBuilder.CreatePlane = (name) => {
      const p = origCreatePlane(name);
      planes.push(p);
      return p;
    };
    inst._babylon = B;
    inst._scene = {
      stopAnimation() {},
      beginDirectAnimation() {},
    };
    inst._trackAnim = (p) => p;
    inst._entityStandees = new Map();
    inst.state = { entities: [] };

    inst._spawnFloatingText(1, 1, 'HIT 2');

    assert.equal(planes.length, 1, 'one floater plane created');
    assert.equal(planes[0].renderingGroupId, UNIT_ICON_GROUP,
      'floaters must never hide behind terrain or standees');
  });
});

// ─── UI overlay: planning attack arrows ride in ATTACK_OVERLAY_GROUP ────────

describe('Renderer3D — _buildPlanBattleArrows assigns ATTACK_OVERLAY_GROUP', () => {
  test('shaft, both head wedges, and the ×N badge all use the overlay group', () => {
    if (!('document' in globalThis)) globalThis.document = {};
    const inst = Object.create(Renderer3D.prototype);
    inst._babylon = makeFakeBabylon();
    inst._scene = {};
    inst._mapRoot = null;
    inst._planBattleMeshes = [];
    inst._planBattleSig = 'force-rebuild';      // differs from any real signature
    inst.planGhostSteps = null;
    inst.unitInfoCards = null;
    inst.state = null;
    inst._overlays = new Map([
      ['plan-battle-0', {
        kind: 'plan-arrow', layer: 'plan-arrow',
        meta: { variant: 'battle', fromHex: '0,0', toHex: '1,0', count: 2 },
      }],
    ]);

    inst._buildPlanBattleArrows();

    assert.equal(inst._planBattleMeshes.length, 2,
      'one arrow entry (shaft+heads) plus one badge entry');
    const [arrow, badgeEntry] = inst._planBattleMeshes;
    for (const part of ['shaft', 'head1', 'head2']) {
      assert.equal(arrow[part].renderingGroupId, ATTACK_OVERLAY_GROUP,
        `${part} must render above world geometry AND icon billboards`);
    }
    assert.equal(badgeEntry.badge.renderingGroupId, ATTACK_OVERLAY_GROUP,
      'the ×N badge shares the overlay group');
  });
});

// ─── Trivial source guard — no literal group ids bypass the named policy ────
//
// All behaviourally testable builders are covered above, but the renderer has
// many more `renderingGroupId = …` sites (tile prisms, tree/house instances,
// ghost standees, speech bubbles…) that only run inside the full Babylon
// scene build. This single check keeps every assignment routed through the
// named constants so a new call site must consciously pick a group from the
// policy table — it cannot silently bump a mesh with a magic number.

describe('Renderer3D — all renderingGroupId assignments use the named constants', () => {
  const __dirname = path.dirname(fileURLToPath(import.meta.url));
  const SRC = readFileSync(path.join(__dirname, '..', 'src', 'renderer-3d.js'), 'utf8');

  test('no literal numeric renderingGroupId assignment exists in the source', () => {
    const offenders = [];
    SRC.split('\n').forEach((line, i) => {
      if (/\.renderingGroupId\s*=\s*\d/.test(line)) offenders.push(`line ${i + 1}: ${line.trim()}`);
    });
    assert.equal(offenders.length, 0,
      'renderingGroupId must be assigned from WORLD_GROUP / UNIT_ICON_GROUP / ' +
      'ATTACK_OVERLAY_GROUP / XRAY_GHOST_GROUP, not magic numbers:\n' +
      offenders.join('\n'));
  });
});
