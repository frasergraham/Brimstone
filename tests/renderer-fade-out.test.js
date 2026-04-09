// Tests for fade-out animation methods on the Renderer.
// Uses a minimal stub that replicates just the data structures — the Renderer
// class itself requires a real canvas (DOM) and cannot be instantiated here.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

// ── Minimal renderer stub ──────────────────────────────────────────────────────
// Replicates only the fields and methods under test.

function makeRendererStub() {
  return {
    _fadeOutAnims:        new Map(),
    _startAnimLoopCalled: false,

    addFadeOutAnim(entityId, duration = 600) {
      this._fadeOutAnims.set(entityId, { startTime: Date.now(), duration });
      this._startAnimLoopCalled = true;
    },

    getFadeOutOpacity(entityId) {
      const anim = this._fadeOutAnims.get(entityId);
      if (!anim) return 1;
      const t = (Date.now() - anim.startTime) / anim.duration;
      return Math.max(0, 1 - t);
    },

    clearAnimations() {
      this._fadeOutAnims = new Map();
    },
  };
}

// ── addFadeOutAnim ──────────────────────────────────────────────────────────────

describe('addFadeOutAnim', () => {
  test('stores an entry in the fade-out map', () => {
    const r = makeRendererStub();
    r.addFadeOutAnim('e1', 600);
    assert.equal(r._fadeOutAnims.size, 1);
    assert.ok(r._fadeOutAnims.has('e1'));
  });

  test('entry has startTime and duration', () => {
    const r = makeRendererStub();
    const before = Date.now();
    r.addFadeOutAnim('e1', 500);
    const entry = r._fadeOutAnims.get('e1');
    assert.ok(entry.startTime >= before);
    assert.equal(entry.duration, 500);
  });

  test('replaces an existing fade for the same entity', () => {
    const r = makeRendererStub();
    r.addFadeOutAnim('e1', 600);
    const first = r._fadeOutAnims.get('e1').startTime;
    r.addFadeOutAnim('e1', 800);
    assert.equal(r._fadeOutAnims.size, 1);
    assert.equal(r._fadeOutAnims.get('e1').duration, 800);
  });

  test('multiple entities can fade independently', () => {
    const r = makeRendererStub();
    r.addFadeOutAnim('e1', 600);
    r.addFadeOutAnim('e2', 400);
    assert.equal(r._fadeOutAnims.size, 2);
  });

  test('starts the animation loop', () => {
    const r = makeRendererStub();
    r.addFadeOutAnim('e1');
    assert.equal(r._startAnimLoopCalled, true);
  });
});

// ── getFadeOutOpacity ───────────────────────────────────────────────────────────

describe('getFadeOutOpacity', () => {
  test('returns 1 for unknown entity (no fade)', () => {
    const r = makeRendererStub();
    assert.equal(r.getFadeOutOpacity('unknown'), 1);
  });

  test('returns ~1 immediately after adding fade', () => {
    const r = makeRendererStub();
    r.addFadeOutAnim('e1', 1000);
    const opacity = r.getFadeOutOpacity('e1');
    // Should be very close to 1 (just created)
    assert.ok(opacity > 0.95, `Expected >0.95, got ${opacity}`);
  });

  test('returns 0 after duration has elapsed', () => {
    const r = makeRendererStub();
    // Backdate the start time to simulate elapsed duration
    r._fadeOutAnims.set('e1', { startTime: Date.now() - 1000, duration: 600 });
    assert.equal(r.getFadeOutOpacity('e1'), 0);
  });

  test('returns value between 0 and 1 mid-fade', () => {
    const r = makeRendererStub();
    // Backdate to halfway through the fade
    r._fadeOutAnims.set('e1', { startTime: Date.now() - 300, duration: 600 });
    const opacity = r.getFadeOutOpacity('e1');
    assert.ok(opacity > 0.3 && opacity < 0.7, `Expected ~0.5, got ${opacity}`);
  });

  test('never returns negative values', () => {
    const r = makeRendererStub();
    r._fadeOutAnims.set('e1', { startTime: Date.now() - 10000, duration: 600 });
    assert.equal(r.getFadeOutOpacity('e1'), 0);
  });
});

// ── clearAnimations ─────────────────────────────────────────────────────────────

describe('clearAnimations clears fade-out anims', () => {
  test('clears all fade-out entries', () => {
    const r = makeRendererStub();
    r.addFadeOutAnim('e1', 600);
    r.addFadeOutAnim('e2', 600);
    r.clearAnimations();
    assert.equal(r._fadeOutAnims.size, 0);
  });

  test('is safe to call when empty', () => {
    const r = makeRendererStub();
    r.clearAnimations();
    assert.equal(r._fadeOutAnims.size, 0);
  });
});
