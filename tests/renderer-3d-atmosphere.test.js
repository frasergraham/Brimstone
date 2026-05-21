// Phase 6 of the 3D renderer — pure-helper unit tests for the atmosphere pass.
//
// What we can lock down without a Babylon scene:
//   • PHASE_LIGHT_CONFIG maps each phase to its expected intensity / colour /
//     clear-colour values (these define the visual identity of dawn vs dusk
//     vs night and should not drift without a designer push).
//   • Node glow colour is keyed correctly off the controller string.
//   • lerpLightConfig / easeInOutCubic interpolate as documented.
//   • pulseFactor stays inside the supplied [min, max] band over a period.
//   • buildFogVisibleSet visits the right hexes for single/multi observers,
//     respects sight range, and never includes hexes outside the owner's
//     reach (i.e. enemy units don't reveal anything for the observer).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PHASE_LIGHT_CONFIG,
  getPhaseLightConfig,
  NODE_GLOW_COLORS,
  getNodeGlowColor,
  PHASE_TRANSITION_MS,
  SELECTION_PULSE_PERIOD_MS,
  SELECTION_PULSE_MIN,
  SELECTION_PULSE_MAX,
  NODE_PULSE_PERIOD_MS,
  NODE_PULSE_MIN,
  NODE_PULSE_MAX,
  FOG_TILE_DARKEN,
  easeInOutCubic,
  lerpLightConfig,
  pulseFactor,
  buildFogVisibleSet,
} from '../src/renderer-3d.js';
import { Phase } from '../src/game.js';
import { hexKey } from '../src/hex.js';

// ── Phase → light config map ─────────────────────────────────────────────────

describe('Renderer3D — getPhaseLightConfig', () => {
  test('dawn = warm amber, mid intensity', () => {
    const c = getPhaseLightConfig(Phase.DAWN);
    assert.equal(c.intensity, 0.90);
    assert.equal(c.color.r, 1.00);
    assert.ok(c.color.g > 0.6 && c.color.g < 0.9, 'dawn green channel mid');
    assert.ok(c.color.b < c.color.g,             'dawn blue channel lowest');
  });

  test('day = white-ish, full intensity', () => {
    const c = getPhaseLightConfig(Phase.DAY);
    assert.ok(c.intensity > 1.0, 'day intensity > 1');
    assert.ok(c.color.r >= 0.95 && c.color.g >= 0.95 && c.color.b >= 0.9);
  });

  test('dusk = orange-red, mid intensity (similar to dawn)', () => {
    const c = getPhaseLightConfig(Phase.DUSK);
    assert.equal(c.intensity, 0.85);
    assert.equal(c.color.r, 1.00);
    assert.ok(c.color.g < 0.7, 'dusk green darker than dawn');
    assert.ok(c.color.b < c.color.g, 'dusk blue lowest');
  });

  test('night = cool blue, low intensity', () => {
    const c = getPhaseLightConfig(Phase.NIGHT);
    assert.ok(c.intensity < 0.7, 'night dimmer than mid phases');
    // Cool tone: blue channel dominates red, green sits between.
    assert.ok(c.color.b > c.color.r, 'night blue > red');
    assert.ok(c.color.r < 0.7,       'night red channel cool');
  });

  test('unknown phase falls back to day config (defensive)', () => {
    assert.deepEqual(getPhaseLightConfig('mysterious-aurora'), PHASE_LIGHT_CONFIG.day);
    assert.deepEqual(getPhaseLightConfig(undefined),           PHASE_LIGHT_CONFIG.day);
    assert.deepEqual(getPhaseLightConfig(null),                PHASE_LIGHT_CONFIG.day);
  });

  test('clear colour goes darker at night than during the day', () => {
    const day   = getPhaseLightConfig(Phase.DAY);
    const night = getPhaseLightConfig(Phase.NIGHT);
    const lum = c => c.clear.r + c.clear.g + c.clear.b;
    assert.ok(lum(day) > lum(night), 'day clear-colour brighter than night');
  });

  test('all four phases are present in PHASE_LIGHT_CONFIG', () => {
    for (const p of [Phase.DAWN, Phase.DAY, Phase.DUSK, Phase.NIGHT]) {
      assert.ok(PHASE_LIGHT_CONFIG[p], `missing config for ${p}`);
    }
  });
});

// ── Node glow colour by controller ──────────────────────────────────────────

describe('Renderer3D — getNodeGlowColor', () => {
  test('hero control = warm gold', () => {
    assert.equal(getNodeGlowColor('hero'),    '#ffc940');
  });

  test('witch control = sickly green', () => {
    assert.equal(getNodeGlowColor('witch'),   '#7fd14a');
  });

  test('neutral = pale white', () => {
    assert.equal(getNodeGlowColor('neutral'), '#f0f0f0');
  });

  test('contested = amber (matches 2D path contested overlay)', () => {
    assert.equal(getNodeGlowColor('contested'), '#ffaa00');
  });

  test('unknown controller falls back to neutral pale white', () => {
    assert.equal(getNodeGlowColor('martian'),  NODE_GLOW_COLORS.neutral);
    assert.equal(getNodeGlowColor(undefined),  NODE_GLOW_COLORS.neutral);
    assert.equal(getNodeGlowColor(null),       NODE_GLOW_COLORS.neutral);
  });
});

// ── Easing / interpolation ──────────────────────────────────────────────────

describe('Renderer3D — easeInOutCubic', () => {
  test('endpoints anchor at 0 and 1', () => {
    assert.equal(easeInOutCubic(0), 0);
    assert.equal(easeInOutCubic(1), 1);
  });

  test('midpoint is exactly 0.5 (symmetry of cubic ease)', () => {
    assert.ok(Math.abs(easeInOutCubic(0.5) - 0.5) < 1e-9);
  });

  test('clamps out-of-band inputs', () => {
    assert.equal(easeInOutCubic(-1), 0);
    assert.equal(easeInOutCubic( 5), 1);
  });

  test('monotonically non-decreasing across the unit interval', () => {
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const v = easeInOutCubic(i / 20);
      assert.ok(v >= prev - 1e-9, `non-monotone at t=${i / 20}`);
      prev = v;
    }
  });
});

describe('Renderer3D — lerpLightConfig', () => {
  const dawn = PHASE_LIGHT_CONFIG.dawn;
  const day  = PHASE_LIGHT_CONFIG.day;

  test('t=0 returns the from snapshot', () => {
    const r = lerpLightConfig(dawn, day, 0);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(r.intensity, dawn.intensity));
    assert.ok(near(r.color.r, dawn.color.r) && near(r.color.g, dawn.color.g) && near(r.color.b, dawn.color.b));
    assert.ok(near(r.clear.r, dawn.clear.r) && near(r.clear.g, dawn.clear.g) && near(r.clear.b, dawn.clear.b));
  });

  test('t=1 returns the to snapshot', () => {
    const r = lerpLightConfig(dawn, day, 1);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(r.intensity, day.intensity));
    assert.ok(near(r.color.r, day.color.r) && near(r.color.g, day.color.g) && near(r.color.b, day.color.b));
    assert.ok(near(r.clear.r, day.clear.r) && near(r.clear.g, day.clear.g) && near(r.clear.b, day.clear.b));
  });

  test('t=0.5 sits at the midpoint per channel', () => {
    const r = lerpLightConfig(dawn, day, 0.5);
    assert.ok(Math.abs(r.intensity - (dawn.intensity + day.intensity) / 2) < 1e-9);
    assert.ok(Math.abs(r.color.r - (dawn.color.r + day.color.r) / 2) < 1e-9);
    assert.ok(Math.abs(r.clear.b - (dawn.clear.b + day.clear.b) / 2) < 1e-9);
  });

  test('clamps t outside [0, 1]', () => {
    const below = lerpLightConfig(dawn, day, -2);
    const above = lerpLightConfig(dawn, day,  9);
    const near = (a, b) => Math.abs(a - b) < 1e-9;
    assert.ok(near(below.intensity, dawn.intensity));
    assert.ok(near(above.intensity, day.intensity));
  });
});

// ── Pulse oscillator ────────────────────────────────────────────────────────

describe('Renderer3D — pulseFactor', () => {
  test('values stay strictly inside [min, max] across a full period', () => {
    const period = SELECTION_PULSE_PERIOD_MS;
    const min    = SELECTION_PULSE_MIN;
    const max    = SELECTION_PULSE_MAX;
    for (let i = 0; i < 50; i++) {
      const t = (i / 50) * period;
      const v = pulseFactor(t, period, min, max);
      assert.ok(v >= min - 1e-9 && v <= max + 1e-9,
        `pulseFactor=${v} out of [${min}, ${max}] at t=${t}`);
    }
  });

  test('hits the documented extrema near period quarters', () => {
    const period = NODE_PULSE_PERIOD_MS, min = NODE_PULSE_MIN, max = NODE_PULSE_MAX;
    const peak   = pulseFactor(period * 0.25, period, min, max);
    const trough = pulseFactor(period * 0.75, period, min, max);
    assert.ok(Math.abs(peak   - max) < 1e-9, `expected peak=max, got ${peak}`);
    assert.ok(Math.abs(trough - min) < 1e-9, `expected trough=min, got ${trough}`);
  });

  test('period wraps cleanly (t and t+period give the same value)', () => {
    const a = pulseFactor(123, 1000, 0.2, 0.8);
    const b = pulseFactor(123 + 1000, 1000, 0.2, 0.8);
    assert.ok(Math.abs(a - b) < 1e-9);
  });
});

// ── Pulse + phase constants are exported with sensible bounds ───────────────

describe('Renderer3D — pulse constants', () => {
  test('selection pulse min < max', () => {
    assert.ok(SELECTION_PULSE_MIN < SELECTION_PULSE_MAX);
  });
  test('node pulse min < max', () => {
    assert.ok(NODE_PULSE_MIN < NODE_PULSE_MAX);
  });
  test('phase transition is a few seconds (not instant, not glacial)', () => {
    assert.ok(PHASE_TRANSITION_MS >= 1000 && PHASE_TRANSITION_MS <= 5000);
  });
  test('fog tile darken is between 0 (black) and 1 (no change)', () => {
    assert.ok(FOG_TILE_DARKEN > 0 && FOG_TILE_DARKEN < 1);
  });
});

// ── Fog of war visibility ───────────────────────────────────────────────────

/** Stub entity with a sight range — enough for sightRangeForEntity → 2 (hero). */
function heroAt(id, col, row, alive = true, owner = 'hero') {
  return {
    id, col, row, alive, owner,
    type: 'paladin', factionId: 'hero',
    hasAbility(_id) { return false; }, // disables scout bonus
  };
}
function witchAt(id, col, row, alive = true, owner = 'witch') {
  return {
    id, col, row, alive, owner,
    type: 'witch', factionId: 'witch',
    hasAbility(_id) { return false; },
  };
}

/** Build a small rectangular tile map (cols × rows) so visibility iteration
 *  has something to chew on. Keys mirror the production `hexKey(col,row)`. */
function rectTiles(cols, rows) {
  const tiles = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.set(hexKey(c, r), { col: c, row: r });
    }
  }
  return tiles;
}

describe('Renderer3D — buildFogVisibleSet', () => {
  test('empty / null inputs return an empty set (defensive)', () => {
    assert.equal(buildFogVisibleSet(null, 'hero').size, 0);
    assert.equal(buildFogVisibleSet({}, 'hero').size, 0);
    assert.equal(buildFogVisibleSet({ entities: [], tiles: new Map() }, 'hero').size, 0);
    assert.equal(buildFogVisibleSet({ entities: [heroAt(1, 0, 0)], tiles: rectTiles(3, 3) }, null).size, 0);
  });

  test('single hero observer at NIGHT (sight=1) covers exactly 7 hexes', () => {
    // HeroFaction.getSightRange returns 1 at NIGHT (sight disc = 1 + 6 = 7).
    const state = {
      entities: [heroAt(1, 5, 5)],
      tiles: rectTiles(11, 11),
      phase: Phase.NIGHT,
    };
    const v = buildFogVisibleSet(state, 'hero');
    assert.equal(v.size, 7);
    assert.ok(v.has(hexKey(5, 5)));
    assert.ok(!v.has(hexKey(7, 5)), '2 steps east is outside night sight');
  });

  test('single hero observer at DAY (sight=3) covers the 37-hex disc', () => {
    const state = {
      entities: [heroAt(1, 5, 5)],
      tiles: rectTiles(11, 11),
      phase: Phase.DAY,
    };
    const v = buildFogVisibleSet(state, 'hero');
    // Hex disc of radius 3 = 1 + 6 + 12 + 18 = 37 hexes; all land on the board.
    assert.equal(v.size, 37);
    assert.ok(v.has(hexKey(5, 5)));
    assert.ok(v.has(hexKey(8, 5)),  '3 steps east is within day sight');
    assert.ok(!v.has(hexKey(9, 5)), '4 steps east is out of sight');
  });

  test('observer near a map edge clips the disc correctly', () => {
    const state = {
      entities: [heroAt(1, 0, 0)],
      tiles: rectTiles(5, 5),
      phase: Phase.DAY,
    };
    const v = buildFogVisibleSet(state, 'hero');
    // From (0,0) only hexes with col >= 0 && row >= 0 can be visible.
    for (const k of v) {
      const [c, r] = k.split(',').map(Number);
      assert.ok(c >= 0 && r >= 0);
    }
    assert.ok(v.has(hexKey(0, 0)));
    assert.ok(!v.has(hexKey(4, 4)), 'far corner outside sight');
  });

  test('multi-observer: union of two heroes\' sight discs', () => {
    const state = {
      entities: [heroAt(1, 1, 1), heroAt(2, 8, 8)],
      tiles: rectTiles(10, 10),
      phase: Phase.DAY,
    };
    const v = buildFogVisibleSet(state, 'hero');
    assert.ok(v.has(hexKey(1, 1)));
    assert.ok(v.has(hexKey(8, 8)));
    // A hex equidistant from both is visible exactly once (set semantics).
    assert.ok(v.has(hexKey(2, 1)));
  });

  test('opposing-faction entities reveal nothing for the observer', () => {
    const state = {
      entities: [witchAt(1, 5, 5)],
      tiles: rectTiles(11, 11),
      phase: Phase.DAY,
    };
    assert.equal(buildFogVisibleSet(state, 'hero').size, 0);
  });

  test('dead entities do not contribute sight', () => {
    const state = {
      entities: [heroAt(1, 5, 5, /*alive=*/false)],
      tiles: rectTiles(11, 11),
      phase: Phase.DAY,
    };
    assert.equal(buildFogVisibleSet(state, 'hero').size, 0);
  });

  test('mixed roster: only entities owned by `observerOwner` matter', () => {
    const state = {
      entities: [heroAt(1, 2, 2), witchAt(2, 5, 5), heroAt(3, 4, 2, false)],
      tiles: rectTiles(10, 10),
      phase: Phase.DAY,
    };
    const v = buildFogVisibleSet(state, 'hero');
    assert.ok(v.has(hexKey(2, 2)));
    assert.ok(!v.has(hexKey(5, 5)), 'witch sight not folded in');
    // Dead third hero at (4,2) should not contribute either.
    assert.ok(!v.has(hexKey(6, 2)), 'dead hero sight not folded in');
  });
});
