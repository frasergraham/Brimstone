// Pure-helper tests for the river-flow texture scroll math. The renderer
// advances the river ribbon material's `uOffset` each frame to `riverFlowOffset`
// so the tiled water texture slides downstream along the U (flow) axis.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { riverFlowOffset, RIVER_FLOW_SPEED, Renderer3D } from '../src/renderer-3d.js';

function newInst() {
  const fakeCanvas = { parentElement: null, width: 800, height: 600, addEventListener() {} };
  return new Renderer3D(fakeCanvas, {});
}

describe('riverFlowOffset — texture scroll math', () => {
  test('zero elapsed time → zero offset', () => {
    assert.equal(riverFlowOffset(0), 0);
  });

  test('offset always wraps into [0, 1)', () => {
    for (const ms of [0, 250, 1000, 9999, 1e6, 3.6e6, 8.64e7]) {
      const o = riverFlowOffset(ms);
      assert.ok(o >= 0 && o < 1, `offset ${o} out of [0,1) for ms=${ms}`);
    }
  });

  test('advances monotonically within one tile period', () => {
    // One full period = 1 / RIVER_FLOW_SPEED seconds. Sample inside it.
    const periodMs = (1 / RIVER_FLOW_SPEED) * 1000;
    let prev = -1;
    for (let i = 0; i < 10; i++) {
      const o = riverFlowOffset((periodMs * i) / 10);
      assert.ok(o > prev, `expected increasing offset, got ${o} after ${prev}`);
      prev = o;
    }
  });

  test('wraps seamlessly at the period boundary (continuous flow)', () => {
    const periodMs = (1 / RIVER_FLOW_SPEED) * 1000;
    // Just before a full period the offset is near 1; just after it resets
    // near 0 — the WRAP address mode makes that visually seamless.
    assert.ok(riverFlowOffset(periodMs - 1) > 0.99);
    assert.ok(riverFlowOffset(periodMs + 1) < 0.01);
    // Exactly one period back to (near) zero.
    assert.ok(Math.abs(riverFlowOffset(periodMs)) < 1e-9);
  });

  test('frame-rate independent: offset depends only on absolute time', () => {
    // Same timestamp → same offset regardless of how we got there.
    const t = 1234.5;
    assert.equal(riverFlowOffset(t), riverFlowOffset(t));
  });

  test('speed override scales the scroll rate', () => {
    // Double speed reaches the same offset in half the time.
    const slow = riverFlowOffset(1000, 0.1);
    const fast = riverFlowOffset(500, 0.2);
    assert.ok(Math.abs(slow - fast) < 1e-9);
  });

  test('RIVER_FLOW_SPEED is a sane, subtle constant', () => {
    assert.ok(RIVER_FLOW_SPEED > 0 && RIVER_FLOW_SPEED < 1);
  });
});

describe('_pumpRiverFlow — wires the offset onto every river texture', () => {
  test('advances uOffset on all per-tile river textures AND the extension material', () => {
    const r = newInst();
    // Each per-tile river clone deep-clones its own diffuse texture; the pump
    // must scroll all of them, not just the primary mesh's.
    const t0 = { uOffset: 0 };
    const t1 = { uOffset: 0 };
    const t2 = { uOffset: 0 };
    r._riverFlowTextures = [t0, t1, t2];
    const extTex = { uOffset: 0 };
    r._riverExtensionMat = { diffuseTexture: extTex };

    const now = 5000;
    r._pumpRiverFlow(now);
    const expected = riverFlowOffset(now);
    for (const t of [t0, t1, t2, extTex]) {
      assert.equal(t.uOffset, expected, 'every river texture scrolls in lockstep');
    }
  });

  test('offset changes frame-to-frame (water keeps flowing)', () => {
    const r = newInst();
    const tex = { uOffset: 0 };
    r._riverFlowTextures = [tex];
    r._pumpRiverFlow(1000);
    const a = tex.uOffset;
    r._pumpRiverFlow(2000);
    const b = tex.uOffset;
    assert.notEqual(a, b, 'uOffset should advance between frames');
  });

  test('no-op when there is no river (no textures collected)', () => {
    const r = newInst();
    r._riverFlowTextures = [];
    r._riverExtensionMat = null;
    assert.doesNotThrow(() => r._pumpRiverFlow(1234));
  });

  test('tolerates an extension material with no loaded texture yet', () => {
    const r = newInst();
    r._riverFlowTextures = [];
    r._riverExtensionMat = {}; // async texture not resolved → no diffuseTexture
    assert.doesNotThrow(() => r._pumpRiverFlow(1234));
  });
});
