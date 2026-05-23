// Pure-helper tests for the on-canvas FPS / ms-per-frame chip.
// Babylon wiring (observer registration, DOM element update) is exercised by
// hand in-browser — these tests just lock the formatter and the throttle
// interval constant.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { formatFpsLabel, FPS_COUNTER_UPDATE_MS } from '../src/renderer-3d.js';

describe('formatFpsLabel', () => {
  test('typical 60 fps reading', () => {
    assert.equal(formatFpsLabel(60, 16.667), '60.0 fps · 16.7 ms');
  });

  test('high refresh rate (120 fps)', () => {
    assert.equal(formatFpsLabel(120, 8.333), '120.0 fps · 8.3 ms');
  });

  test('first-frame zeros are rendered as 0.0 (not NaN)', () => {
    assert.equal(formatFpsLabel(0, 0), '0.0 fps · 0.0 ms');
  });

  test('non-finite values fall back to 0.0', () => {
    assert.equal(formatFpsLabel(NaN, NaN), '0.0 fps · 0.0 ms');
    assert.equal(formatFpsLabel(Infinity, Infinity), '0.0 fps · 0.0 ms');
  });

  test('negative values fall back to 0.0', () => {
    assert.equal(formatFpsLabel(-1, -5), '0.0 fps · 0.0 ms');
  });

  test('rounds to one decimal (not truncates)', () => {
    assert.equal(formatFpsLabel(59.96, 16.74), '60.0 fps · 16.7 ms');
    assert.equal(formatFpsLabel(29.44, 33.99), '29.4 fps · 34.0 ms');
  });
});

describe('FPS_COUNTER_UPDATE_MS', () => {
  test('throttle interval is ~100ms — fast enough to feel live, slow enough to skip per-frame DOM writes', () => {
    assert.equal(FPS_COUNTER_UPDATE_MS, 100);
  });
});
