// Pure-helper tests for the directional sun light + dynamic shadow system.
// Locks down:
//   • sunDirectionForPhase / sunIntensityForPhase return the expected per-phase
//     vector / scalar values (these are the visual identity of dawn/day/dusk
//     and should not drift without a designer push).
//   • Shadow-generator constants (mapSize, bias, darkness, filteringQuality)
//     are exported with sane values.
//   • lerpLightConfig now interpolates the sun.dir / sun.intensity fields
//     when both endpoints carry a `sun` sub-config.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE_LIGHT_CONFIG,
  sunDirectionForPhase,
  sunIntensityForPhase,
  SUN_SHADOW_MAP_SIZE,
  SUN_SHADOW_USE_PCF,
  SUN_SHADOW_FILTERING_QUALITY,
  SUN_SHADOW_BIAS,
  SUN_SHADOW_DARKNESS,
  lerpLightConfig,
} from '../src/renderer-3d.js';
import { Phase } from '../src/game.js';

describe('Renderer3D — sunDirectionForPhase', () => {
  test('dawn shines from the east at a low angle', () => {
    const d = sunDirectionForPhase(Phase.DAWN);
    assert.equal(d.x, -0.6, 'dawn x = -0.6 (sun east of map)');
    assert.equal(d.y, -0.7, 'dawn y < 0 (light travels downward)');
    assert.ok(Math.abs(d.x) > Math.abs(d.y * 0.5),
      'dawn has a meaningful horizontal component (low sun)');
  });

  test('day sun is near-overhead — dominant -Y', () => {
    const d = sunDirectionForPhase(Phase.DAY);
    assert.equal(d.x, 0, 'day x = 0 (sun directly overhead in X)');
    assert.equal(d.y, -1, 'day y = -1 (straight down)');
  });

  test('dusk mirrors dawn — shines from the west', () => {
    const dawn = sunDirectionForPhase(Phase.DAWN);
    const dusk = sunDirectionForPhase(Phase.DUSK);
    assert.equal(dusk.x, 0.6, 'dusk x = 0.6 (sun west of map)');
    assert.equal(dusk.x, -dawn.x, 'dusk x is the mirror of dawn x');
    assert.equal(dusk.y, dawn.y, 'dusk and dawn share the same low pitch');
  });

  test('night direction is defined (intensity 0 makes it irrelevant)', () => {
    const d = sunDirectionForPhase(Phase.NIGHT);
    assert.ok(typeof d.x === 'number' && Number.isFinite(d.x));
    assert.ok(typeof d.y === 'number' && Number.isFinite(d.y));
    assert.ok(typeof d.z === 'number' && Number.isFinite(d.z));
  });

  test('unknown phase falls back to day direction (defensive)', () => {
    assert.deepEqual(sunDirectionForPhase('starlight-aurora'),
      PHASE_LIGHT_CONFIG.day.sun.dir);
    assert.deepEqual(sunDirectionForPhase(undefined), PHASE_LIGHT_CONFIG.day.sun.dir);
    assert.deepEqual(sunDirectionForPhase(null),      PHASE_LIGHT_CONFIG.day.sun.dir);
  });
});

describe('Renderer3D — sunIntensityForPhase', () => {
  test('day sun is brightest', () => {
    const day = sunIntensityForPhase(Phase.DAY);
    assert.equal(day, 1.0);
  });

  test('dawn and dusk are mid-intensity (matching golden-hour feel)', () => {
    assert.equal(sunIntensityForPhase(Phase.DAWN), 0.6);
    assert.equal(sunIntensityForPhase(Phase.DUSK), 0.6);
  });

  test('night is effectively off — close to zero so shadows fade out', () => {
    const night = sunIntensityForPhase(Phase.NIGHT);
    assert.ok(night >= 0, 'night intensity non-negative');
    assert.ok(night < 0.1, `night intensity should fade to near-zero, got ${night}`);
  });

  test('day > dawn = dusk > night ordering', () => {
    const day   = sunIntensityForPhase(Phase.DAY);
    const dawn  = sunIntensityForPhase(Phase.DAWN);
    const dusk  = sunIntensityForPhase(Phase.DUSK);
    const night = sunIntensityForPhase(Phase.NIGHT);
    assert.ok(day > dawn, 'day brighter than dawn');
    assert.equal(dawn, dusk, 'dawn matches dusk');
    assert.ok(dusk > night, 'dusk brighter than night');
  });

  test('unknown phase falls back to day intensity (defensive)', () => {
    assert.equal(sunIntensityForPhase('starlight-aurora'),
      PHASE_LIGHT_CONFIG.day.sun.intensity);
    assert.equal(sunIntensityForPhase(undefined), PHASE_LIGHT_CONFIG.day.sun.intensity);
    assert.equal(sunIntensityForPhase(null),      PHASE_LIGHT_CONFIG.day.sun.intensity);
  });
});

describe('Renderer3D — shadow generator constants', () => {
  test('mapSize is a power of two between 512 and 4096', () => {
    assert.ok(SUN_SHADOW_MAP_SIZE >= 512 && SUN_SHADOW_MAP_SIZE <= 4096,
      `mapSize ${SUN_SHADOW_MAP_SIZE} should sit in the playable range`);
    // power of two check: only one bit set
    assert.equal(SUN_SHADOW_MAP_SIZE & (SUN_SHADOW_MAP_SIZE - 1), 0,
      'mapSize must be a power of two for texture sampling efficiency');
  });

  test('PCF filtering is enabled (softens silhouette edges)', () => {
    assert.equal(SUN_SHADOW_USE_PCF, true);
  });

  test('filtering quality matches Babylon QUALITY_MEDIUM (1)', () => {
    // BABYLON.ShadowGenerator.QUALITY_MEDIUM === 1 in @babylonjs/core 7.x.
    // Pinned here so a future Babylon upgrade that renumbers these is caught.
    assert.equal(SUN_SHADOW_FILTERING_QUALITY, 1);
  });

  test('bias is small but non-zero (acne suppression without peter-panning)', () => {
    assert.ok(SUN_SHADOW_BIAS > 0 && SUN_SHADOW_BIAS < 0.05,
      `bias ${SUN_SHADOW_BIAS} should be in (0, 0.05)`);
  });

  test('darkness sits in (0, 1) — visible but not pitch black', () => {
    assert.ok(SUN_SHADOW_DARKNESS > 0 && SUN_SHADOW_DARKNESS < 1,
      `darkness ${SUN_SHADOW_DARKNESS} out of (0, 1)`);
    assert.ok(SUN_SHADOW_DARKNESS <= 0.5,
      'darkness ≤ 0.5 so shadows read strongly');
  });
});

describe('Renderer3D — lerpLightConfig with sun', () => {
  const dawn = PHASE_LIGHT_CONFIG.dawn;
  const day  = PHASE_LIGHT_CONFIG.day;

  test('t=0 returns the from snapshot, including sun', () => {
    const r = lerpLightConfig(dawn, day, 0);
    assert.ok(r.sun, 'lerp should include sun when both endpoints carry one');
    assert.equal(r.sun.dir.x, dawn.sun.dir.x);
    assert.equal(r.sun.dir.y, dawn.sun.dir.y);
    assert.equal(r.sun.dir.z, dawn.sun.dir.z);
    assert.equal(r.sun.intensity, dawn.sun.intensity);
  });

  test('t=1 returns the to snapshot, including sun', () => {
    const r = lerpLightConfig(dawn, day, 1);
    assert.equal(r.sun.dir.x, day.sun.dir.x);
    assert.equal(r.sun.dir.y, day.sun.dir.y);
    assert.equal(r.sun.intensity, day.sun.intensity);
  });

  test('t=0.5 sits at the midpoint of sun fields', () => {
    const r = lerpLightConfig(dawn, day, 0.5);
    const mid = (a, b) => (a + b) / 2;
    assert.ok(Math.abs(r.sun.dir.x - mid(dawn.sun.dir.x, day.sun.dir.x)) < 1e-9);
    assert.ok(Math.abs(r.sun.dir.y - mid(dawn.sun.dir.y, day.sun.dir.y)) < 1e-9);
    assert.ok(Math.abs(r.sun.intensity - mid(dawn.sun.intensity, day.sun.intensity)) < 1e-9);
  });

  test('omits sun when either side lacks one (defensive)', () => {
    const stripped = {
      intensity: dawn.intensity,
      color: dawn.color,
      clear: dawn.clear,
    }; // no sun
    const r = lerpLightConfig(stripped, day, 0.5);
    assert.equal(r.sun, undefined, 'no sun on output when input missing');
  });

  test('every phase config carries a sun sub-config', () => {
    for (const p of ['dawn', 'day', 'dusk', 'night']) {
      const cfg = PHASE_LIGHT_CONFIG[p];
      assert.ok(cfg.sun, `${p} should have a sun sub-config`);
      assert.equal(typeof cfg.sun.intensity, 'number', `${p} sun.intensity is numeric`);
      assert.equal(typeof cfg.sun.dir.x, 'number');
      assert.equal(typeof cfg.sun.dir.y, 'number');
      assert.equal(typeof cfg.sun.dir.z, 'number');
    }
  });
});
