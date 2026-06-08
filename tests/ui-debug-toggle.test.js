// Tests for the hidden triple-click-on-"Actions" gesture that toggles the
// on-canvas debug counters. Only the pure predicate has logic worth testing;
// the body-class toggle and CSS gating are visual.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { isDebugToggleClick } from '../src/ui.js';

// Minimal fake target: `closest` returns a truthy match only when the selector
// is the actions-label and this element claims to be (or descend from) one.
function fakeTarget({ isLabel = false } = {}) {
  return {
    closest(sel) { return isLabel && sel === '.actions-label' ? {} : null; },
  };
}

describe('isDebugToggleClick', () => {
  test('triple-click on the actions label toggles', () => {
    assert.equal(isDebugToggleClick({ detail: 3, target: fakeTarget({ isLabel: true }) }), true);
  });

  test('triple-click elsewhere does not toggle', () => {
    assert.equal(isDebugToggleClick({ detail: 3, target: fakeTarget({ isLabel: false }) }), false);
  });

  test('single and double clicks on the label do not toggle', () => {
    assert.equal(isDebugToggleClick({ detail: 1, target: fakeTarget({ isLabel: true }) }), false);
    assert.equal(isDebugToggleClick({ detail: 2, target: fakeTarget({ isLabel: true }) }), false);
  });

  test('handles missing event or target gracefully', () => {
    assert.equal(isDebugToggleClick(null), false);
    assert.equal(isDebugToggleClick({ detail: 3, target: null }), false);
  });

  test('falls back to classList when closest is unavailable', () => {
    const target = { classList: { contains: (c) => c === 'actions-label' } };
    assert.equal(isDebugToggleClick({ detail: 3, target }), true);
  });
});
