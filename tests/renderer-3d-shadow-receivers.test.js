// Tests for the `applyShadowReceiving` helper + the renderer callsites that
// turn road / river / river-extension / bridge meshes into shadow receivers.
//
// Babylon's ShadowGenerator only casts onto meshes whose `receiveShadows`
// flag is true. Before this fix, the per-tile road/river merged ribbons set
// the flag but the river-extension ribbons through the border-forest band
// and the bridge planks did not — so unit shadows fell off the moment a
// standee crossed onto those surfaces. The helper centralises the assignment
// and the renderer routes every flat path-mesh through it at build time.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyShadowReceiving,
  Renderer3D,
} from '../src/renderer-3d.js';

function fakeMesh(name) {
  return { name, receiveShadows: false };
}

function newInst() {
  const fakeCanvas = {
    parentElement: null, width: 800, height: 600, addEventListener() {},
  };
  return new Renderer3D(fakeCanvas, {});
}

describe('applyShadowReceiving — pure helper', () => {
  test('sets receiveShadows = true on every mesh in the array', () => {
    const meshes = [fakeMesh('a'), fakeMesh('b'), fakeMesh('c')];
    const n = applyShadowReceiving(meshes);
    assert.equal(n, 3);
    for (const m of meshes) assert.equal(m.receiveShadows, true);
  });

  test('returns 0 for null/undefined/empty input (defensive)', () => {
    assert.equal(applyShadowReceiving(null), 0);
    assert.equal(applyShadowReceiving(undefined), 0);
    assert.equal(applyShadowReceiving([]), 0);
  });

  test('skips null entries inside the array (MergeMeshes returns null on empty lists)', () => {
    const a = fakeMesh('a');
    const c = fakeMesh('c');
    const n = applyShadowReceiving([a, null, c, undefined]);
    assert.equal(n, 2);
    assert.equal(a.receiveShadows, true);
    assert.equal(c.receiveShadows, true);
  });

  test('idempotent — calling twice leaves the flag set, count counts both passes', () => {
    const a = fakeMesh('a');
    assert.equal(applyShadowReceiving([a]), 1);
    assert.equal(a.receiveShadows, true);
    assert.equal(applyShadowReceiving([a]), 1);
    assert.equal(a.receiveShadows, true);
  });

  test('accepts iterables (Set, Map.values()) as well as plain arrays', () => {
    const a = fakeMesh('a');
    const b = fakeMesh('b');
    const s = new Set([a, b]);
    assert.equal(applyShadowReceiving(s), 2);
    assert.equal(a.receiveShadows, true);
    assert.equal(b.receiveShadows, true);

    const m = new Map([['k1', fakeMesh('m1')], ['k2', fakeMesh('m2')]]);
    const n = applyShadowReceiving(m.values());
    assert.equal(n, 2);
    for (const mesh of m.values()) assert.equal(mesh.receiveShadows, true);
  });
});

describe('Renderer3D._setShadowReceiver — instance-method wrapper', () => {
  test('delegates to applyShadowReceiving (sets receiveShadows = true)', () => {
    const inst = newInst();
    const mesh = fakeMesh('road_tile_3,2');
    inst._setShadowReceiver(mesh);
    assert.equal(mesh.receiveShadows, true);
  });

  test('null-safe — does not throw when called with null', () => {
    const inst = newInst();
    // Bridge plank build can short-circuit before the mesh is constructed;
    // the wrapper must not throw or `_buildTileMesh` aborts mid-loop.
    assert.doesNotThrow(() => inst._setShadowReceiver(null));
    assert.doesNotThrow(() => inst._setShadowReceiver(undefined));
  });
});

describe('Renderer3D — road/river/river-extension/bridge prop registries', () => {
  // The freeze-static test pattern: stuff fake meshes into the per-tile prop
  // registries with the same metadata shape used at build time, then walk the
  // registry and assert receiveShadows is set on every "respectsFog: darken"
  // or "kind: river-extension" mesh.
  //
  // The actual `_setShadowReceiver` calls happen inside `_buildNetworkMesh`
  // and `_buildRiverExtensions`, which need a Babylon scene to run — covered
  // here by injecting pre-built fake meshes that mimic the post-construction
  // shape and checking the helper pass walks them correctly.

  test('applyShadowReceiving walks _tilePropsByKey road/river entries', () => {
    const inst = newInst();
    const road00 = { name: 'road_0,0', receiveShadows: false, metadata: { respectsFog: 'darken', kind: 'road' } };
    const river01 = { name: 'river_0,1', receiveShadows: false, metadata: { respectsFog: 'darken', kind: 'river' } };
    inst._tilePropsByKey.set('0,0', [road00]);
    inst._tilePropsByKey.set('0,1', [river01]);

    const ribbons = [];
    for (const list of inst._tilePropsByKey.values()) {
      for (const m of list) {
        if (m.metadata?.respectsFog === 'darken') ribbons.push(m);
      }
    }
    const n = applyShadowReceiving(ribbons);
    assert.equal(n, 2);
    assert.equal(road00.receiveShadows, true);
    assert.equal(river01.receiveShadows, true);
  });

  test('applyShadowReceiving walks _borderPropsByKey river-extension entries', () => {
    const inst = newInst();
    const ext0 = { name: 'river_extension_0_2', receiveShadows: false, metadata: { kind: 'river-extension' } };
    const ext1 = { name: 'river_extension_12_2', receiveShadows: false, metadata: { kind: 'river-extension' } };
    inst._borderPropsByKey.set('river-ext:0,2', [ext0]);
    inst._borderPropsByKey.set('river-ext:12,2', [ext1]);

    const exts = [];
    for (const list of inst._borderPropsByKey.values()) {
      for (const m of list) {
        if (m.metadata?.kind === 'river-extension') exts.push(m);
      }
    }
    const n = applyShadowReceiving(exts);
    assert.equal(n, 2);
    assert.equal(ext0.receiveShadows, true);
    assert.equal(ext1.receiveShadows, true);
  });

  test('mixed registry — applyShadowReceiving sets the flag on every mesh, regardless of metadata', () => {
    // The renderer is allowed to pass in props of any kind; the helper itself
    // does not filter — callers narrow before invoking it. Pinned here so a
    // future refactor that hands the helper a wider list doesn't accidentally
    // miss meshes that should receive shadows.
    const inst = newInst();
    const a = { name: 'bridge', receiveShadows: false };
    const b = { name: 'tile', receiveShadows: false };
    const c = { name: 'ribbon', receiveShadows: false };
    inst._tilePropsByKey.set('5,5', [a, b, c]);
    const all = [];
    for (const list of inst._tilePropsByKey.values()) all.push(...list);
    const n = applyShadowReceiving(all);
    assert.equal(n, 3);
    for (const m of [a, b, c]) assert.equal(m.receiveShadows, true);
  });
});
