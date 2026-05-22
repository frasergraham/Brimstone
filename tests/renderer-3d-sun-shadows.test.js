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
    assert.ok(d.x < 0, 'dawn x negative (sun east of map)');
    assert.ok(d.y < 0, 'dawn y < 0 (light travels downward)');
    // Low sun: the horizontal component must dominate the vertical so we get
    // long, raked shadows rather than near-overhead noon shadows.
    assert.ok(Math.abs(d.x) > Math.abs(d.y),
      `dawn |x|=${Math.abs(d.x)} should exceed |y|=${Math.abs(d.y)} (low sun, near horizon)`);
  });

  test('day sun is dominantly downward but tilted enough to cast visible shadows', () => {
    const d = sunDirectionForPhase(Phase.DAY);
    // -Y must dominate so noon reads as "from above"...
    assert.ok(d.y < -0.7, `day y=${d.y} must be predominantly downward (< -0.7)`);
    // ...but not be a perfect (0,-1,0) vector — a perfectly vertical sun
    // projects a near-zero shadow offset and shadows disappear into the
    // caster itself. Require a meaningful lateral component on at least one
    // horizontal axis so the operator sees a visible shadow footprint.
    const lateral = Math.hypot(d.x, d.z);
    assert.ok(lateral > 0.2, `day sun lateral ${lateral.toFixed(2)} must be > 0.2 so shadows actually project`);
  });

  test('dusk mirrors dawn — shines from the west', () => {
    const dawn = sunDirectionForPhase(Phase.DAWN);
    const dusk = sunDirectionForPhase(Phase.DUSK);
    assert.ok(dusk.x > 0, 'dusk x positive (sun west of map)');
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
    // Boosted above 1 so the directional sun dominates the (low) hemi fill
    // and cast shadows read as real dark patches instead of pale tints.
    assert.ok(day >= 1.5, `day intensity ${day} should be ≥ 1.5`);
  });

  test('dawn and dusk are mid-intensity (matching golden-hour feel)', () => {
    const dawn = sunIntensityForPhase(Phase.DAWN);
    const dusk = sunIntensityForPhase(Phase.DUSK);
    assert.equal(dawn, dusk);
    assert.ok(dawn > 0.5 && dawn < sunIntensityForPhase(Phase.DAY),
      `dawn/dusk intensity ${dawn} should sit between night and day`);
  });

  test('night is effectively off — close to zero so shadows fade out', () => {
    const night = sunIntensityForPhase(Phase.NIGHT);
    assert.ok(night >= 0, 'night intensity non-negative');
    assert.ok(night < 0.2, `night intensity should fade to near-zero, got ${night}`);
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

  test('darkness sits in [0, 0.5] — strong cast shadows', () => {
    assert.ok(SUN_SHADOW_DARKNESS >= 0 && SUN_SHADOW_DARKNESS <= 0.5,
      `darkness ${SUN_SHADOW_DARKNESS} out of [0, 0.5]`);
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
