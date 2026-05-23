// Per-unit thin hex outline visibility — pins the rule that the always-on
// thin ring only renders for units owned by the local-side player. Enemy
// units carry no thin outline; the thick selection ring still applies to
// any unit that is selected, regardless of side.
//
// Tests drive `_syncEntityHexOutlines` against a stubbed `_buildEntityHexOutline`
// (the real builder needs a Babylon scene); the predicate that decides the
// `isLocal` flag is what we lock down here.
//
// Tasks: t-1b787e9d (own-only thin hex outline).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  return new Renderer3D(fakeCanvas, {});
}

/** Stand in for the real builder — captures the `isLocal` arg passed in by
 *  `_syncEntityHexOutlines` so we can assert against it without needing a
 *  Babylon scene. */
function stubBuilder(r) {
  const built = []; // {id, isLocal}
  r._buildEntityHexOutline = (entity, isLocal) => {
    built.push({ id: entity.id, isLocal: !!isLocal });
    // The real builder returns thin/thick mesh objects; tests only read the
    // `isLocal` flag + the visibility tracker, so a minimal stub suffices.
    const thin  = { isVisible: !!isLocal, position: { x: 0, z: 0 }, material: null };
    const thick = { isVisible: false,    position: { x: 0, z: 0 }, material: null };
    return { thin, thick, ownerKey: entity.color || '#fff', isLocal: !!isLocal };
  };
  return built;
}

// Minimal scene/babylon stubs so `_syncEntityHexOutlines` doesn't early-out.
function withSceneStubs(r) {
  r._scene = {};
  r._babylon = {};
  r._entityHexOutlines = new Map();
  // Material lookups go through Babylon's StandardMaterial in the real code;
  // stub them so the recolour path (owner flip) doesn't try to build a real
  // material against the empty fake babylon namespace.
  r._thinOutlineMaterialFor  = () => ({ stub: 'thin'  });
  r._thickOutlineMaterialFor = () => ({ stub: 'thick' });
}

describe('Renderer3D — own-only thin hex outline', () => {
  test('thin ring is built visible only for entities matching observerOwner', () => {
    const r = makeRenderer();
    withSceneStubs(r);
    const built = stubBuilder(r);

    r.state = {
      myFaction: 'hero',
      entities: [
        { id: 1, alive: true, col: 0, row: 0, owner: 'hero' },
        { id: 2, alive: true, col: 1, row: 0, owner: 'witch' },
        { id: 3, alive: true, col: 2, row: 0, owner: 'hero' },
      ],
    };

    r._syncEntityHexOutlines();

    const byId = Object.fromEntries(built.map(b => [b.id, b.isLocal]));
    assert.equal(byId[1], true,  'hero unit gets the always-on thin outline');
    assert.equal(byId[2], false, 'enemy witch unit gets no thin outline');
    assert.equal(byId[3], true,  'another hero unit gets the always-on thin outline');

    // The outline map's stored thin.isVisible mirrors the predicate.
    assert.equal(r._entityHexOutlines.get(1).thin.isVisible, true);
    assert.equal(r._entityHexOutlines.get(2).thin.isVisible, false);
    assert.equal(r._entityHexOutlines.get(3).thin.isVisible, true);
  });

  test('observerOwner inferred from witchIsAI/heroIsAI when myFaction is unset', () => {
    const r = makeRenderer();
    withSceneStubs(r);
    const built = stubBuilder(r);

    // witchIsAI=true, heroIsAI=false → human is hero
    r.state = {
      witchIsAI: true, heroIsAI: false,
      entities: [
        { id: 1, alive: true, col: 0, row: 0, owner: 'hero'  },
        { id: 2, alive: true, col: 1, row: 0, owner: 'witch' },
      ],
    };

    r._syncEntityHexOutlines();
    const byId = Object.fromEntries(built.map(b => [b.id, b.isLocal]));
    assert.equal(byId[1], true);
    assert.equal(byId[2], false);
  });

  test('AI-vs-AI (no observer) → no thin outline for any unit', () => {
    const r = makeRenderer();
    withSceneStubs(r);
    const built = stubBuilder(r);

    r.state = {
      witchIsAI: true, heroIsAI: true,
      entities: [
        { id: 1, alive: true, col: 0, row: 0, owner: 'hero'  },
        { id: 2, alive: true, col: 1, row: 0, owner: 'witch' },
      ],
    };

    r._syncEntityHexOutlines();
    for (const b of built) {
      assert.equal(b.isLocal, false,
        `entity ${b.id} should have no thin outline when there is no local observer`);
    }
  });

  test('side flip updates an existing outline\'s isLocal + thin visibility', () => {
    const r = makeRenderer();
    withSceneStubs(r);
    stubBuilder(r);

    // First pass — hero is local, hero unit gets a thin outline.
    r.state = {
      myFaction: 'hero',
      entities: [{ id: 1, alive: true, col: 0, row: 0, owner: 'hero' }],
    };
    r._syncEntityHexOutlines();
    assert.equal(r._entityHexOutlines.get(1).isLocal, true);
    assert.equal(r._entityHexOutlines.get(1).thin.isVisible, true);

    // Second pass — entity's ownership flips to witch (e.g. recruited survivor
    // captured). The same outline mesh is kept; its thin ring goes invisible.
    r.state.entities[0].owner = 'witch';
    r._syncEntityHexOutlines();
    assert.equal(r._entityHexOutlines.get(1).isLocal, false);
    assert.equal(r._entityHexOutlines.get(1).thin.isVisible, false);
  });
});
