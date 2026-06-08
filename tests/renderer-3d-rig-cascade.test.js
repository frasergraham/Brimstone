// Rig-cascade tests — the convention by which every non-paladin unit resolves
// a 3D rig: first `<type>-idle.glb`, else the shared mannequin, else the
// cone+sphere pawn. Covers the pure resolver helpers and the per-owner tint
// applied to the blank mannequin by _buildRigClone.
//
// Babylon can't run under node-test (no WebGL), so the clone path is exercised
// against a minimal stub namespace — same approach as renderer-3d-paladin-glb.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  Renderer3D,
  entityTypeRigFile,
  fallbackRigCandidates,
  MANNEQUIN_RIG_FILE,
} from '../src/renderer-3d.js';

describe('entityTypeRigFile', () => {
  test('derives <type>-idle.glb from the entity type', () => {
    assert.equal(entityTypeRigFile({ type: 'zombie' }), 'zombie-idle.glb');
    assert.equal(entityTypeRigFile({ type: 'witch' }), 'witch-idle.glb');
    // Underscored multi-word types pass through verbatim (already slug-safe).
    assert.equal(entityTypeRigFile({ type: 'wood_golem' }), 'wood_golem-idle.glb');
  });

  test('returns null for a missing / non-string type', () => {
    assert.equal(entityTypeRigFile(null), null);
    assert.equal(entityTypeRigFile({}), null);
    assert.equal(entityTypeRigFile({ type: 42 }), null);
  });
});

describe('fallbackRigCandidates', () => {
  test('orders the type-specific rig before the shared mannequin', () => {
    assert.deepEqual(fallbackRigCandidates({ type: 'zombie' }),
      ['zombie-idle.glb', MANNEQUIN_RIG_FILE]);
    assert.deepEqual(fallbackRigCandidates({ type: 'survivor' }),
      ['survivor-idle.glb', MANNEQUIN_RIG_FILE]);
  });

  test('falls back to mannequin-only when there is no usable type', () => {
    assert.deepEqual(fallbackRigCandidates(null), [MANNEQUIN_RIG_FILE]);
    assert.deepEqual(fallbackRigCandidates({}), [MANNEQUIN_RIG_FILE]);
  });

  test('does not list the mannequin twice if the type IS the mannequin', () => {
    assert.deepEqual(fallbackRigCandidates({ type: 'mannequin' }), [MANNEQUIN_RIG_FILE]);
  });
});

// ── _buildRigClone per-owner tint ───────────────────────────────────────────

function fakeColor3(r, g, b) { this.r = r; this.g = g; this.b = b; }
function fakeVector3(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; }

function makeFakeMaterial(name = 'mat') {
  return {
    name,
    albedoColor: null,
    diffuseColor: null,
    clone(n) { return makeFakeMaterial(n); },
  };
}

function makeClonedMesh(name) {
  return {
    name, isPickable: true, isEnabled: true, parent: null,
    material: makeFakeMaterial(`${name}_srcmat`),
    setEnabled(b) { this.isEnabled = b; },
    dispose() { this._disposed = true; },
  };
}

function makeRigSource(cloneTag, { tintable }) {
  const mesh = {
    name: `${cloneTag}_src`,
    clone(n) { return makeClonedMesh(n); },
    setEnabled() {},
  };
  return {
    mesh, meshes: [mesh], skeleton: null, idleGroup: null, transformNodes: [],
    scale: 1, feetOffset: 0, cloneTag, tintable,
  };
}

function newRenderer() {
  const r = new Renderer3D({ parentElement: null, width: 800, height: 600, addEventListener() {} }, {});
  r._babylon = {
    Vector3: fakeVector3,
    Color3: fakeColor3,
    TransformNode: function (name) { this.name = name; this.parent = null; this.dispose = () => {}; },
  };
  r._scene = {};
  return r;
}

describe('_ensureFallbackRig cascade', () => {
  test('advances to the mannequin after the type-specific rig 404s', () => {
    const r = newRenderer();
    const calls = [];
    r._loadFallbackRig = (file) => { calls.push(file); return Promise.resolve(null); };
    // Reproduce the stuck state: witch-idle.glb was attempted and 404'd, so it
    // sits in BOTH _rigFileMissing and (staler) _rigLoadPromises.
    r._rigFileMissing.add('witch-idle.glb');
    r._rigLoadPromises.set('witch-idle.glb', Promise.resolve(null));
    r._ensureFallbackRig({ type: 'witch' });
    // Must skip the dead type rig and kick the mannequin — not get blocked on
    // the stale in-flight promise.
    assert.deepEqual(calls, [MANNEQUIN_RIG_FILE]);
  });

  test('kicks the type-specific rig first when nothing is loaded yet', () => {
    const r = newRenderer();
    const calls = [];
    r._loadFallbackRig = (file) => { calls.push(file); return Promise.resolve(null); };
    r._ensureFallbackRig({ type: 'zombie' });
    assert.deepEqual(calls, ['zombie-idle.glb']);
  });
});

describe('_buildRigClone tint', () => {
  test('tints each clone to the owner colour when tintColor is given', () => {
    const r = newRenderer();
    const src = makeRigSource('mannequin', { tintable: true });
    const clone = r._buildRigClone({ id: 'u1', type: 'survivor' }, null, src,
      { tintColor: '#ff0000' });
    assert.ok(clone, 'clone built');
    const child = clone.childMeshes[0];
    // Material was cloned (per-standee instance) and set to red.
    assert.notEqual(child.material.name, 'mannequin_u1_src_srcmat',
      'a fresh per-standee material instance was assigned');
    assert.equal(child.material.albedoColor.r, 1);
    assert.equal(child.material.albedoColor.g, 0);
    assert.equal(child.material.albedoColor.b, 0);
  });

  test('leaves the shared material untouched when no tint is given', () => {
    const r = newRenderer();
    const src = makeRigSource('zombie', { tintable: false });
    const clone = r._buildRigClone({ id: 'z1', type: 'zombie' }, null, src, {});
    assert.ok(clone, 'clone built');
    const child = clone.childMeshes[0];
    assert.equal(child.material.albedoColor, null, 'no tint applied');
  });
});
