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
  resolveSunDirPair,
  sunDirectionForRound,
  phaseProgressForRound,
} from '../src/renderer-3d.js';
import { Phase } from '../src/game.js';

describe('Renderer3D — sunDirectionForPhase', () => {
  test('dawn dir reads as the dawn-side rising-sun fallback (low east sun)', () => {
    // sunDirectionForPhase returns the phase's dirStart in isolation; for
    // dawn that's the legacy `sun.dir` fallback used on custom cycle configs.
    const d = sunDirectionForPhase(Phase.DAWN);
    assert.ok(d.x < 0, 'dawn fallback x negative (sun east of map)');
    assert.ok(d.y < 0, 'dawn y < 0 (light travels downward)');
    assert.ok(Math.abs(d.x) > Math.abs(d.y),
      `dawn |x|=${Math.abs(d.x)} should exceed |y|=${Math.abs(d.y)} (low sun, near horizon)`);
  });

  test('day dirStart is a tilted-from-vertical rising-side sun', () => {
    const d = sunDirectionForPhase(Phase.DAY);
    // -Y must dominate so noon reads as "from above"…
    assert.ok(d.y < -0.5, `day dirStart y=${d.y} must be predominantly downward (< -0.5)`);
    // …but with a meaningful lateral component on at least one axis so
    // cast shadows actually project.
    const lateral = Math.hypot(d.x, d.z);
    assert.ok(lateral > 0.2, `day dirStart lateral ${lateral.toFixed(2)} must be > 0.2 so shadows actually project`);
  });

  test('dusk dir reads as the dusk-side setting-sun fallback (low west sun)', () => {
    const dawn = sunDirectionForPhase(Phase.DAWN);
    const dusk = sunDirectionForPhase(Phase.DUSK);
    assert.ok(dusk.x > 0, 'dusk fallback x positive (sun west of map)');
    assert.equal(dusk.x, -dawn.x, 'dusk fallback x is the mirror of dawn');
    assert.equal(dusk.y, dawn.y, 'dusk and dawn share the same low pitch');
  });

  test('night direction is defined (intensity low makes it moonlight)', () => {
    const d = sunDirectionForPhase(Phase.NIGHT);
    assert.ok(typeof d.x === 'number' && Number.isFinite(d.x));
    assert.ok(typeof d.y === 'number' && Number.isFinite(d.y));
    assert.ok(typeof d.z === 'number' && Number.isFinite(d.z));
  });

  test('unknown phase falls back to day direction (defensive)', () => {
    const day = sunDirectionForPhase(Phase.DAY);
    assert.deepEqual(sunDirectionForPhase('starlight-aurora'), day);
    assert.deepEqual(sunDirectionForPhase(undefined), day);
    assert.deepEqual(sunDirectionForPhase(null),      day);
  });
});

describe('Renderer3D — resolveSunDirPair (schema migration)', () => {
  test('day / night carry explicit dirStart + dirEnd', () => {
    const day = resolveSunDirPair('day');
    const night = resolveSunDirPair('night');
    // Day sweeps east → west: dirStart.x < dirEnd.x.
    assert.ok(day.dirStart.x < day.dirEnd.x,
      `day dirStart.x=${day.dirStart.x} should be < dirEnd.x=${day.dirEnd.x} (sun rises east, sets west)`);
    assert.ok(night.dirStart.x < night.dirEnd.x,
      `night dirStart.x=${night.dirStart.x} should be < dirEnd.x=${night.dirEnd.x}`);
  });

  test('legacy single-`dir` phase resolves to both start and end', () => {
    // Dawn / dusk carry only `sun.dir` (transitional fallback). The pair
    // must collapse to that single direction for callers that don't apply
    // neighbour-bridging.
    for (const phase of ['dawn', 'dusk']) {
      const pair = resolveSunDirPair(phase);
      const dir = PHASE_LIGHT_CONFIG[phase].sun.dir;
      assert.deepEqual(pair.dirStart, dir);
      assert.deepEqual(pair.dirEnd, dir);
    }
  });
});

describe('Renderer3D — phaseProgressForRound', () => {
  test('default cycle: dawn(1) → t=0.5, day(2,3,4) → 0/0.5/1, dusk(5) → 0.5, night(6,7,8) → 0/0.5/1', () => {
    assert.deepEqual(phaseProgressForRound(1), { phase: 'dawn',  t: 0.5 });
    assert.deepEqual(phaseProgressForRound(2), { phase: 'day',   t: 0 });
    assert.deepEqual(phaseProgressForRound(3), { phase: 'day',   t: 0.5 });
    assert.deepEqual(phaseProgressForRound(4), { phase: 'day',   t: 1 });
    assert.deepEqual(phaseProgressForRound(5), { phase: 'dusk',  t: 0.5 });
    assert.deepEqual(phaseProgressForRound(6), { phase: 'night', t: 0 });
    assert.deepEqual(phaseProgressForRound(7), { phase: 'night', t: 0.5 });
    assert.deepEqual(phaseProgressForRound(8), { phase: 'night', t: 1 });
  });

  test('cycle wraps at round 9 → dawn again', () => {
    assert.deepEqual(phaseProgressForRound(9), { phase: 'dawn', t: 0.5 });
    assert.deepEqual(phaseProgressForRound(10), { phase: 'day', t: 0 });
  });

  test('custom cycleConfig with single-element phase run', () => {
    const cc = { phases: ['day', 'night'], loop: true };
    assert.deepEqual(phaseProgressForRound(1, cc), { phase: 'day',   t: 0.5 });
    assert.deepEqual(phaseProgressForRound(2, cc), { phase: 'night', t: 0.5 });
  });
});

describe('Renderer3D — sunDirectionForRound (start→end sweep)', () => {
  test('default cycle DAY rounds sweep from dirStart to dirEnd', () => {
    const day = resolveSunDirPair('day');
    const r2 = sunDirectionForRound(2); // t=0
    const r3 = sunDirectionForRound(3); // t=0.5
    const r4 = sunDirectionForRound(4); // t=1
    assert.deepEqual(r2, day.dirStart);
    assert.deepEqual(r4, day.dirEnd);
    assert.ok(Math.abs(r3.x - (day.dirStart.x + day.dirEnd.x) / 2) < 1e-9);
  });

  test('default cycle NIGHT rounds sweep from dirStart to dirEnd', () => {
    const night = resolveSunDirPair('night');
    assert.deepEqual(sunDirectionForRound(6), night.dirStart);
    assert.deepEqual(sunDirectionForRound(8), night.dirEnd);
  });

  test('default cycle dawn bridges NIGHT.dirEnd → DAY.dirStart at midpoint', () => {
    const night = resolveSunDirPair('night');
    const day   = resolveSunDirPair('day');
    const r1 = sunDirectionForRound(1); // dawn, t=0.5
    assert.ok(Math.abs(r1.x - (night.dirEnd.x + day.dirStart.x) / 2) < 1e-9);
    assert.ok(Math.abs(r1.y - (night.dirEnd.y + day.dirStart.y) / 2) < 1e-9);
    assert.ok(Math.abs(r1.z - (night.dirEnd.z + day.dirStart.z) / 2) < 1e-9);
  });

  test('default cycle dusk bridges DAY.dirEnd → NIGHT.dirStart at midpoint', () => {
    const day   = resolveSunDirPair('day');
    const night = resolveSunDirPair('night');
    const r5 = sunDirectionForRound(5); // dusk, t=0.5
    assert.ok(Math.abs(r5.x - (day.dirEnd.x + night.dirStart.x) / 2) < 1e-9);
  });

  test('custom cycleConfig disables neighbour-bridging — dawn uses its own pair', () => {
    const cc = { phases: ['dawn', 'day'], loop: true };
    const dawnPair = resolveSunDirPair('dawn');
    // Round 1 = dawn, single-element phase run → t=0.5 → midpoint of own pair
    // (which is dir-as-both for dawn, so x equals dir.x exactly).
    assert.equal(sunDirectionForRound(1, cc).x, dawnPair.dirStart.x);
  });
});

describe('Renderer3D — sunIntensityForPhase', () => {
  test('day sun is brightest', () => {
    const day = sunIntensityForPhase(Phase.DAY);
    // Boosted above 1 so the directional sun dominates the (low) hemi fill
    // and cast shadows read as real dark patches instead of pale tints.
    assert.ok(day >= 1.5, `day intensity ${day} should be ≥ 1.5`);
  });

  test('dawn and dusk are golden-hour low raking sun (≥ midday, long shadows)', () => {
    const dawn = sunIntensityForPhase(Phase.DAWN);
    const dusk = sunIntensityForPhase(Phase.DUSK);
    // Operator-tuned (PHASE_LIGHT_CONFIG): dawn/dusk run a touch hotter than
    // midday so the low-angle raking sun throws long, strong shadows. They
    // sit close to each other but are no longer pinned exactly equal.
    assert.ok(Math.abs(dawn - dusk) < 0.2, `dawn ${dawn} ≈ dusk ${dusk}`);
    assert.ok(dawn >= sunIntensityForPhase(Phase.DAY),
      `dawn/dusk intensity ${dawn} should be at least as strong as midday`);
  });

  test('night sun acts as moonlight — dimmer than day but bright enough to cast shadows', () => {
    const night = sunIntensityForPhase(Phase.NIGHT);
    const day   = sunIntensityForPhase(Phase.DAY);
    assert.ok(night > 0, 'night intensity > 0 so cast shadows still project');
    assert.ok(night < day, `night ${night} should be dimmer than day ${day}`);
  });

  test('dawn ≈ dusk ≥ day > night ordering (golden-hour raking sun, moonlit night)', () => {
    const day   = sunIntensityForPhase(Phase.DAY);
    const dawn  = sunIntensityForPhase(Phase.DAWN);
    const dusk  = sunIntensityForPhase(Phase.DUSK);
    const night = sunIntensityForPhase(Phase.NIGHT);
    assert.ok(dawn >= day, 'dawn at least as strong as day (low raking sun)');
    assert.ok(Math.abs(dawn - dusk) < 0.2, 'dawn ≈ dusk');
    assert.ok(day > night, 'day brighter than moonlit night');
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
  // `dawn` carries a legacy `sun.dir`; `day` carries a `sun.dirStart` pair.
  // The lerp picks a representative `dir` (legacy if present, else
  // dirStart/dirEnd midpoint) so transitions degrade gracefully across both
  // schemas — the renderer overrides sun.dir per-frame from
  // sunDirectionForRound anyway, so this is only consumed by snapshot callers.
  const dayDirRep = {
    x: (day.sun.dirStart.x + day.sun.dirEnd.x) / 2,
    y: (day.sun.dirStart.y + day.sun.dirEnd.y) / 2,
    z: (day.sun.dirStart.z + day.sun.dirEnd.z) / 2,
  };

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
    assert.ok(Math.abs(r.sun.dir.x - dayDirRep.x) < 1e-9);
    assert.ok(Math.abs(r.sun.dir.y - dayDirRep.y) < 1e-9);
    assert.equal(r.sun.intensity, day.sun.intensity);
  });

  test('t=0.5 sits at the midpoint of sun fields', () => {
    const r = lerpLightConfig(dawn, day, 0.5);
    const mid = (a, b) => (a + b) / 2;
    assert.ok(Math.abs(r.sun.dir.x - mid(dawn.sun.dir.x, dayDirRep.x)) < 1e-9);
    assert.ok(Math.abs(r.sun.dir.y - mid(dawn.sun.dir.y, dayDirRep.y)) < 1e-9);
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

  test('every phase config carries a sun sub-config with intensity + a direction', () => {
    for (const p of ['dawn', 'day', 'dusk', 'night']) {
      const cfg = PHASE_LIGHT_CONFIG[p];
      assert.ok(cfg.sun, `${p} should have a sun sub-config`);
      assert.equal(typeof cfg.sun.intensity, 'number', `${p} sun.intensity is numeric`);
      // Either schema is valid: legacy `dir` (dawn/dusk) or new `dirStart/dirEnd` (day/night).
      const hasLegacy = cfg.sun.dir
        && typeof cfg.sun.dir.x === 'number'
        && typeof cfg.sun.dir.y === 'number'
        && typeof cfg.sun.dir.z === 'number';
      const hasPair = cfg.sun.dirStart && cfg.sun.dirEnd
        && typeof cfg.sun.dirStart.x === 'number' && typeof cfg.sun.dirEnd.x === 'number';
      assert.ok(hasLegacy || hasPair, `${p}: sun must carry either dir or {dirStart,dirEnd}`);
    }
  });
});
