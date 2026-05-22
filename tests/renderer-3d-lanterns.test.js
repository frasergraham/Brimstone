// Phase 6 night-lantern subsystem (Piper) — pure-helper unit tests.
//
// What we lock down without a Babylon scene:
//   • lanternIntensityForPhase returns the documented peak per phase (and 0
//     for day / unknown).
//   • flickerScale stays inside the documented [0.7, 1.0] band for any t /
//     phaseOffset, and varies enough to actually read as flicker (i.e. it's
//     not stuck at a constant).
//   • diffLanternLifecycle adds new live entities, keeps already-lit ones,
//     and removes ids that disappeared (dead or missing from the live set).
//   • The numeric constants exported alongside have sensible bounds.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  LANTERN_INTENSITY_BY_PHASE,
  lanternIntensityForPhase,
  flickerScale,
  diffLanternLifecycle,
  LANTERN_COLOR_HEX,
  LANTERN_RANGE,
  LANTERN_HEIGHT_OFFSET,
  LANTERN_FADE_MS,
  LANTERN_FLICKER_FREQ_HZ,
  LANTERN_MATERIAL_LIGHT_CAP,
  PHASE_TRANSITION_MS,
} from '../src/renderer-3d.js';
import { Phase } from '../src/game.js';

// ── Per-phase peak intensity ────────────────────────────────────────────────

describe('Renderer3D — lanternIntensityForPhase', () => {
  test('night is the brightest peak (0.8)', () => {
    assert.equal(lanternIntensityForPhase(Phase.NIGHT), 0.8);
  });

  test('dusk is partial (0.4) — lanterns coming on', () => {
    assert.equal(lanternIntensityForPhase(Phase.DUSK), 0.4);
  });

  test('dawn is dim (0.3) — lanterns dying out', () => {
    assert.equal(lanternIntensityForPhase(Phase.DAWN), 0.3);
  });

  test('day is exactly zero — no lanterns lit during full daylight', () => {
    assert.equal(lanternIntensityForPhase(Phase.DAY), 0);
  });

  test('unknown / nullish phase falls back to 0 (defensive)', () => {
    assert.equal(lanternIntensityForPhase('aurora'),  0);
    assert.equal(lanternIntensityForPhase(undefined), 0);
    assert.equal(lanternIntensityForPhase(null),      0);
  });

  test('all four phase keys are present in LANTERN_INTENSITY_BY_PHASE', () => {
    for (const p of [Phase.DAWN, Phase.DAY, Phase.DUSK, Phase.NIGHT]) {
      assert.ok(p in LANTERN_INTENSITY_BY_PHASE, `missing peak for ${p}`);
    }
  });

  test('night > dusk > dawn > day (monotone across the dim half of the cycle)', () => {
    const night = lanternIntensityForPhase(Phase.NIGHT);
    const dusk  = lanternIntensityForPhase(Phase.DUSK);
    const dawn  = lanternIntensityForPhase(Phase.DAWN);
    const day   = lanternIntensityForPhase(Phase.DAY);
    assert.ok(night > dusk, 'night > dusk');
    assert.ok(dusk  > dawn, 'dusk > dawn');
    assert.ok(dawn  > day,  'dawn > day');
  });
});

// ── Flicker oscillator ──────────────────────────────────────────────────────

describe('Renderer3D — flickerScale', () => {
  test('stays inside the documented [0.7, 1.0] band for a dense sweep', () => {
    // Sweep across ~10 s at high resolution to cover several full cycles of
    // the slow band. With the fast/noise term removed, peak-to-peak swing is
    // tighter (0.3 vs the previous 0.4) so the light reads as calmer.
    let observedMax = -Infinity;
    let observedMin =  Infinity;
    for (let i = 0; i < 4000; i++) {
      const t = i * 2.5; // 0..10_000 ms
      const v = flickerScale(t, 0);
      assert.ok(v >= 0.7 - 1e-9 && v <= 1.0 + 1e-9,
        `flickerScale=${v} out of [0.7, 1.0] at t=${t}`);
      if (v > observedMax) observedMax = v;
      if (v < observedMin) observedMin = v;
    }
    // Peak-to-peak should sit inside the [0.3] envelope — confirms the fast
    // band was actually removed and not re-added with a different name.
    assert.ok(observedMax - observedMin <= 0.30 + 1e-9,
      `swing ${observedMax - observedMin} exceeds calm band of 0.30`);
  });

  test('respects a non-zero phaseOffset (decorrelates from another lantern)', () => {
    // Two lanterns with very different phase offsets should produce different
    // values at the same time, at least at most sample times.
    let differences = 0;
    for (let i = 0; i < 200; i++) {
      const t = i * 11; // pseudo-random sample times
      const a = flickerScale(t, 0);
      const b = flickerScale(t, Math.PI); // half-cycle offset on slow band
      if (Math.abs(a - b) > 1e-6) differences++;
    }
    assert.ok(differences > 150,
      `expected most samples to differ; only ${differences}/200 did`);
  });

  test('actually flickers (varies across t — not stuck at a single value)', () => {
    const samples = [];
    for (let i = 0; i < 100; i++) samples.push(flickerScale(i * 17, 0));
    const min = Math.min(...samples);
    const max = Math.max(...samples);
    assert.ok(max - min > 0.05, `flicker range ${max - min} too tight`);
  });

  test('respects custom frequency (different freq → different waveform)', () => {
    const slowSweep = [];
    const fastSweep = [];
    for (let i = 0; i < 100; i++) {
      const t = i * 13;
      slowSweep.push(flickerScale(t, 0, 0.5));
      fastSweep.push(flickerScale(t, 0, 10));
    }
    // Identical inputs would produce identical sequences; this confirms the
    // freq arg actually feeds into the oscillator.
    let differ = 0;
    for (let i = 0; i < slowSweep.length; i++) {
      if (Math.abs(slowSweep[i] - fastSweep[i]) > 1e-9) differ++;
    }
    assert.ok(differ > 80, `freq arg ignored? only ${differ}/100 samples differed`);
  });

  test('default args produce the same value as explicit args', () => {
    const t = 1234;
    const phaseOffset = 0.42;
    const explicit = flickerScale(t, phaseOffset, LANTERN_FLICKER_FREQ_HZ);
    const def      = flickerScale(t, phaseOffset);
    assert.ok(Math.abs(explicit - def) < 1e-12,
      `defaults drifted: ${explicit} vs ${def}`);
  });
});

// ── Lifecycle diff ──────────────────────────────────────────────────────────

const E = (id, alive = true, col = 0, row = 0) => ({ id, alive, col, row });

describe('Renderer3D — diffLanternLifecycle', () => {
  test('empty prior + empty current = no-op buckets', () => {
    const r = diffLanternLifecycle(new Set(), []);
    assert.deepEqual(r, { add: [], keep: [], remove: [] });
  });

  test('all-new entities land in `add`', () => {
    const r = diffLanternLifecycle(new Set(), [E(1), E(2), E(3)]);
    assert.deepEqual(r.add.sort(),    [1, 2, 3]);
    assert.deepEqual(r.keep,          []);
    assert.deepEqual(r.remove,        []);
  });

  test('all-known entities land in `keep`', () => {
    const prior = new Set([1, 2, 3]);
    const r = diffLanternLifecycle(prior, [E(1), E(2), E(3)]);
    assert.deepEqual(r.add,           []);
    assert.deepEqual(r.keep.sort(),   [1, 2, 3]);
    assert.deepEqual(r.remove,        []);
  });

  test('entities missing from the live set land in `remove`', () => {
    const prior = new Set([1, 2, 3]);
    const r = diffLanternLifecycle(prior, [E(1), E(3)]);
    assert.deepEqual(r.add,           []);
    assert.deepEqual(r.keep.sort(),   [1, 3]);
    assert.deepEqual(r.remove,        [2]);
  });

  test('dead entities are treated as not present (lantern removed)', () => {
    const prior = new Set([1, 2]);
    const r = diffLanternLifecycle(prior, [E(1, /*alive=*/false), E(2)]);
    assert.deepEqual(r.add,           []);
    assert.deepEqual(r.keep,          [2]);
    assert.deepEqual(r.remove,        [1]);
  });

  test('entities without col/row are filtered out (defensive)', () => {
    const prior = new Set();
    const r = diffLanternLifecycle(prior, [
      { id: 1, alive: true /* no col/row */ },
      E(2),
    ]);
    assert.deepEqual(r.add,    [2]);
    assert.deepEqual(r.keep,   []);
    assert.deepEqual(r.remove, []);
  });

  test('handles a churned set: some added, some kept, some removed', () => {
    const prior = new Set([1, 2, 3, 4]);
    const live  = [E(2), E(3), E(5), E(6)];
    const r = diffLanternLifecycle(prior, live);
    assert.deepEqual(r.add.sort(),    [5, 6]);
    assert.deepEqual(r.keep.sort(),   [2, 3]);
    assert.deepEqual(r.remove.sort(), [1, 4]);
  });

  test('null / undefined currentEntities is treated as empty', () => {
    const prior = new Set([1, 2]);
    assert.deepEqual(diffLanternLifecycle(prior, null),
                     { add: [], keep: [], remove: [1, 2] });
    assert.deepEqual(diffLanternLifecycle(prior, undefined),
                     { add: [], keep: [], remove: [1, 2] });
  });
});

// ── Constants sanity ────────────────────────────────────────────────────────

describe('Renderer3D — lantern constants', () => {
  test('LANTERN_COLOR_HEX is a warm amber tone (R > G > B)', () => {
    assert.match(LANTERN_COLOR_HEX, /^#[0-9a-f]{6}$/i);
    const r = parseInt(LANTERN_COLOR_HEX.slice(1, 3), 16);
    const g = parseInt(LANTERN_COLOR_HEX.slice(3, 5), 16);
    const b = parseInt(LANTERN_COLOR_HEX.slice(5, 7), 16);
    assert.ok(r > g, 'red dominates green for warmth');
    assert.ok(g > b, 'green dominates blue for warmth');
    assert.ok(r >= 200, 'red channel near full for a saturated warm tone');
  });

  test('LANTERN_RANGE covers a few hexes (not a single tile, not the whole map)', () => {
    assert.ok(LANTERN_RANGE > 1.5 && LANTERN_RANGE < 10);
  });

  test('LANTERN_RANGE is the calmer 5.0 (extended from the earlier 3.5)', () => {
    assert.equal(LANTERN_RANGE, 5.0);
  });

  test('LANTERN_HEIGHT_OFFSET sits above the standee base (positive)', () => {
    assert.ok(LANTERN_HEIGHT_OFFSET > 0);
  });

  test('LANTERN_FADE_MS matches the hemispheric phase transition (lockstep)', () => {
    assert.equal(LANTERN_FADE_MS, PHASE_TRANSITION_MS);
  });

  test('flicker freq is a sub-audible breathing rate (>0 and not buzzing)', () => {
    assert.ok(LANTERN_FLICKER_FREQ_HZ > 0);
    assert.ok(LANTERN_FLICKER_FREQ_HZ < 5,
      'slow band should stay below ~5Hz so it reads as candle wobble, not buzz');
  });

  test('material light cap is well above Babylon default of 4', () => {
    assert.ok(LANTERN_MATERIAL_LIGHT_CAP >= 8);
  });
});
