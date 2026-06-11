// Regression — forceCompilation argument shape.
//
// Babylon's `Material.forceCompilation(mesh, onCompiled?, options?, onError?)`
// expects a *function* as the 2nd argument. Passing the options object there
// (instead of in slot 3) silently broke material compilation: Babylon would
// finish compiling and call `onCompiled(material)`, but `onCompiled` was an
// object → `TypeError: t is not a function`. The error fires per PBR effect
// fallback, so a single misuse cascades into dozens of console errors AND a
// "BJS — Unable to compile effect" downstream symptom.
//
// The renderer now routes every pre-compile through the exported
// `forceCompileMaterial(material, mesh, options)` helper, which is tested
// behaviourally here against a spy material. A single trivial guard then
// pins that no call site bypasses the helper.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { forceCompileMaterial } from '../src/renderer-3d.js';

function makeSpyMaterial() {
  const calls = [];
  return {
    calls,
    forceCompilation(...args) { calls.push(args); },
  };
}

describe('forceCompileMaterial — Babylon argument shape', () => {
  test('passes the mesh 1st, the onCompiled slot 2nd (NOT the options object), options 3rd', () => {
    const mat = makeSpyMaterial();
    const mesh = { name: 'm' };
    const ok = forceCompileMaterial(mat, mesh);
    assert.equal(ok, true);
    assert.equal(mat.calls.length, 1, 'one compile requested');
    const [arg0, arg1, arg2] = mat.calls[0];
    assert.strictEqual(arg0, mesh, '1st arg is the mesh');
    assert.ok(arg1 === undefined || typeof arg1 === 'function',
      `2nd arg must be the onCompiled callback (or undefined) — Babylon calls it ` +
      `as a function when compile finishes. Got: ${typeof arg1}`);
    assert.equal(typeof arg2, 'object', '3rd arg carries the options object');
    assert.equal(arg2.useInstances, true,
      'default options pre-bake the INSTANCES define for hardware instances');
  });

  test('custom options pass through in slot 3', () => {
    const mat = makeSpyMaterial();
    const mesh = {};
    forceCompileMaterial(mat, mesh, { useInstances: false, clipPlane: true });
    const [, arg1, arg2] = mat.calls[0];
    assert.equal(arg1, undefined);
    assert.deepEqual(arg2, { useInstances: false, clipPlane: true });
  });

  test('swallows compile errors (headless / SwiftShader can throw)', () => {
    const mat = {
      forceCompilation() { throw new Error('no GL context'); },
    };
    assert.doesNotThrow(() => forceCompileMaterial(mat, {}));
    assert.equal(forceCompileMaterial(mat, {}), true,
      'a throwing compile still counts as requested');
  });

  test('no-ops safely when the material has no forceCompilation (or is null)', () => {
    assert.equal(forceCompileMaterial(null, {}), false);
    assert.equal(forceCompileMaterial(undefined, {}), false);
    assert.equal(forceCompileMaterial({}, {}), false);
    assert.equal(forceCompileMaterial({ forceCompilation: 'not-a-fn' }, {}), false);
  });
});

describe('renderer-3d call sites route through the helper', () => {
  // Trivial guard: the behavioural contract above only protects callers that
  // actually use forceCompileMaterial. The deep-scene call sites (tree-pack
  // template pre-compile, faded-template rebake) can't run under node:test,
  // so pin that raw `material.forceCompilation(...)` appears exactly once in
  // the source — inside the helper itself.
  test('raw .forceCompilation( is invoked only inside forceCompileMaterial', () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(resolve(here, '../src/renderer-3d.js'), 'utf8');
    const rawCalls = [...src.matchAll(/\.forceCompilation\s*\(/g)];
    assert.equal(rawCalls.length, 1,
      `expected exactly one raw forceCompilation call (the helper's); ` +
      `found ${rawCalls.length} — new call sites must use forceCompileMaterial()`);
  });
});
