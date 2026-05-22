// Fog-of-war should hide tactical info on fogged hexes (standees, HP bars,
// node discs) while keeping terrain features (forest cones, building boxes,
// roofs) visible — they're permanent geometry, not intel about the opponent.
//
// Locked down here via a focused unit test on `_setTileFogged`: it must skip
// any prop whose `metadata.respectsFog === false`. Babylon mesh construction
// is exercised in-browser; this test injects plain prop objects so it stays
// fast and DOM-free.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer3D } from '../src/renderer-3d.js';

function makeRenderer() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  return new Renderer3D(fakeCanvas, {});
}

function makeProp(respectsFog) {
  const p = { isVisible: true };
  if (respectsFog === false) p.metadata = { respectsFog: false };
  return p;
}

describe('Renderer3D fog — terrain props stay visible', () => {
  test('_setTileFogged hides props without respectsFog flag, skips tagged terrain', () => {
    const r = makeRenderer();
    const hexK = '3,4';
    const tileMesh = { metadata: { baseColor: '#404040' }, material: null };
    // Stub material lookup so _setTileFogged doesn't reach into Babylon.
    r._fogMaterialFor = () => ({});
    r._materialFor    = () => ({});

    const treeCone = makeProp(false);   // forest cone — should stay visible
    const buildingBox = makeProp(false); // building box — should stay visible
    const nodeDisc = makeProp();         // tactical info — should fog out
    const standeeShadow = makeProp();    // tactical info — should fog out

    r._tilePropsByKey.set(hexK, [treeCone, buildingBox, nodeDisc, standeeShadow]);

    r._setTileFogged(hexK, tileMesh, true);

    assert.equal(treeCone.isVisible, true, 'forest cone must stay visible under fog');
    assert.equal(buildingBox.isVisible, true, 'building box must stay visible under fog');
    assert.equal(nodeDisc.isVisible, false, 'node disc must hide under fog');
    assert.equal(standeeShadow.isVisible, false, 'standee shadow must hide under fog');
    assert.ok(r._fogActiveSet.has(hexK), 'fog set should track the hex as fogged');
  });

  test('_setTileFogged un-fogging restores tactical props (terrain already visible)', () => {
    const r = makeRenderer();
    const hexK = '5,6';
    const tileMesh = { metadata: { baseColor: '#404040' }, material: null };
    r._fogMaterialFor = () => ({});
    r._materialFor    = () => ({});

    const treeCone = makeProp(false);
    const nodeDisc = makeProp();
    nodeDisc.isVisible = false; // previously fogged
    r._tilePropsByKey.set(hexK, [treeCone, nodeDisc]);
    r._fogActiveSet.add(hexK);

    r._setTileFogged(hexK, tileMesh, false);

    assert.equal(treeCone.isVisible, true, 'tree was never fogged; stays visible');
    assert.equal(nodeDisc.isVisible, true, 'node disc re-shown on un-fog');
    assert.ok(!r._fogActiveSet.has(hexK), 'fog set should no longer track the hex');
  });
});
