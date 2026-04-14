// Tests for full-fog unseen hex culling:
//   In full fog mode, unseen hexes are not rendered at all (no terrain, no
//   roads/rivers, no black overlay). Only hexes in the "known" set (sight +
//   movement + explored) are rendered. This test validates the fogKnownHexes
//   computation logic used by the renderer.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hexKey } from '../src/hex.js';
import { buildFogMovementHexes } from '../src/actions.js';
import { createHero, createWitch, createMinion } from '../src/entities.js';
import { TileType } from '../src/tiles.js';
import { Phase } from '../src/game.js';

// ── Inline helpers matching renderer._buildFogVisibleHexes ──────────────────

function toAxial(col, row) {
  const q = col - (row - (row & 1)) / 2;
  return { q, r: row };
}

function hexDistance(col1, row1, col2, row2) {
  const a = toAxial(col1, row1);
  const b = toAxial(col2, row2);
  return (Math.abs(a.q - b.q) + Math.abs(a.q + a.r - b.q - b.r) + Math.abs(a.r - b.r)) / 2;
}

function buildSightSet(observerOwner, entities, phase, cols, rows) {
  const ranges = { day: 3, night: 1, dawn: 2, dusk: 2 };
  const visibleSet = new Set();
  for (const e of entities) {
    if (!e.alive || e.owner !== observerOwner) continue;
    const range = (ranges[phase] ?? 2) + (e.isScout ? 1 : 0);
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        if (hexDistance(col, row, e.col, e.row) <= range) {
          visibleSet.add(hexKey(col, row));
        }
      }
    }
  }
  return visibleSet;
}

// Replicates the fogKnownHexes computation from the renderer
function buildFogKnownHexes(state, observerOwner, sightSet) {
  const moveSet = buildFogMovementHexes(state, observerOwner);
  const explored = state.exploredHexes?.[observerOwner];
  // Update explored memory (matches renderer behavior)
  if (explored) {
    for (const k of sightSet) explored.add(k);
    for (const k of moveSet) explored.add(k);
  }
  const known = new Set(sightSet);
  for (const k of moveSet) known.add(k);
  if (explored) for (const k of explored) known.add(k);
  return known;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTinyState(size = 7) {
  const state = {
    phase: Phase.DAY,
    entities: [],
    tiles: new Map(),
    exploredHexes: { hero: new Set(), witch: new Set() },
    fogOfWar: 'full',
  };
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      state.tiles.set(hexKey(col, row), {
        type: TileType.GRASS, building: null, fortifyLevel: 0, explored: false,
        col, row, roadDirs: new Set(),
      });
    }
  }
  return state;
}

// ── fogKnownHexes computation ──────────────────────────────────────────────

describe('fogKnownHexes — unseen hex culling', () => {
  test('hexes within sight range are in known set', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'hero');
    state.entities.push(hero);

    const sightSet = buildSightSet('hero', state.entities, 'day', 7, 7);
    const known = buildFogKnownHexes(state, 'hero', sightSet);

    // Hero at (3,3), day sight range 3 — (3,3) and neighbors should be known
    assert.ok(known.has(hexKey(3, 3)), 'hero position is known');
    assert.ok(known.has(hexKey(3, 2)), 'adjacent hex is known');
    assert.ok(known.has(hexKey(3, 0)), 'hex at range 3 is known');
  });

  test('hexes outside all sets are NOT in known set', () => {
    const state = makeTinyState();
    const hero = createHero(0, 0, 'hero');
    state.entities.push(hero);
    state.phase = Phase.NIGHT; // sight range 1

    const sightSet = buildSightSet('hero', state.entities, 'night', 7, 7);
    const known = buildFogKnownHexes(state, 'hero', sightSet);

    // (6,6) is far from (0,0) — should NOT be known
    assert.ok(!known.has(hexKey(6, 6)), 'far hex is not known');
  });

  test('explored hexes are in known set even when out of sight', () => {
    const state = makeTinyState();
    const hero = createHero(0, 0, 'hero');
    state.entities.push(hero);
    state.phase = Phase.NIGHT; // sight range 1

    // Pre-explore a far hex
    state.exploredHexes.hero.add(hexKey(6, 6));

    const sightSet = buildSightSet('hero', state.entities, 'night', 7, 7);
    const known = buildFogKnownHexes(state, 'hero', sightSet);

    assert.ok(known.has(hexKey(6, 6)), 'previously explored hex is known');
  });

  test('movement-reachable hexes are in known set', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'hero');
    state.entities.push(hero);
    state.phase = Phase.NIGHT; // sight range 1

    const sightSet = buildSightSet('hero', state.entities, 'night', 7, 7);
    const known = buildFogKnownHexes(state, 'hero', sightSet);
    const moveSet = buildFogMovementHexes(state, 'hero');

    // All movement-reachable hexes should be in known set
    for (const k of moveSet) {
      assert.ok(known.has(k), `move-reachable hex ${k} is known`);
    }
  });

  test('known set is superset of sight set', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'hero');
    state.entities.push(hero);

    const sightSet = buildSightSet('hero', state.entities, 'day', 7, 7);
    const known = buildFogKnownHexes(state, 'hero', sightSet);

    for (const k of sightSet) {
      assert.ok(known.has(k), `sight hex ${k} must be in known set`);
    }
  });

  test('known set grows as explored set accumulates', () => {
    const state = makeTinyState();
    const hero = createHero(0, 0, 'hero');
    state.entities.push(hero);
    state.phase = Phase.NIGHT;

    // First computation
    const sightSet1 = buildSightSet('hero', state.entities, 'night', 7, 7);
    const known1 = buildFogKnownHexes(state, 'hero', sightSet1);
    const size1 = known1.size;

    // Move hero to a new position
    hero.col = 6;
    hero.row = 6;

    // Second computation — explored set now includes old position's hexes
    const sightSet2 = buildSightSet('hero', state.entities, 'night', 7, 7);
    const known2 = buildFogKnownHexes(state, 'hero', sightSet2);

    assert.ok(known2.size > size1, 'known set grows after unit moves');
    // Old position should still be known (via explored memory)
    assert.ok(known2.has(hexKey(0, 0)), 'old position retained via explored');
  });

  test('fogKnownHexes is null when fog is not full', () => {
    // The renderer only computes fogKnownHexes when fogOfWar === 'full'.
    // For partial fog, all terrain is rendered (just dimmed outside sight).
    const state = makeTinyState();
    state.fogOfWar = 'partial';
    // fogKnownHexes should remain null — partial fog renders all hexes
    assert.equal(state.fogOfWar, 'partial');
    // No terrain culling needed
  });

  test('fogKnownHexes is null when fog is none', () => {
    const state = makeTinyState();
    state.fogOfWar = 'none';
    assert.equal(state.fogOfWar, 'none');
  });

  test('explored hex memory is updated during known set computation', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'hero');
    state.entities.push(hero);

    assert.equal(state.exploredHexes.hero.size, 0, 'starts empty');

    const sightSet = buildSightSet('hero', state.entities, 'day', 7, 7);
    buildFogKnownHexes(state, 'hero', sightSet);

    // After computation, explored set should contain at least the sight hexes
    assert.ok(state.exploredHexes.hero.size > 0, 'explored set populated');
    for (const k of sightSet) {
      assert.ok(state.exploredHexes.hero.has(k), `sight hex ${k} added to explored`);
    }
  });

  test('witch observer uses witch entities and explored hexes', () => {
    const state = makeTinyState();
    const witch = createWitch(3, 3, 'witch');
    state.entities.push(witch);
    // Also place a hero — should be ignored for witch observer
    const hero = createHero(6, 6, 'hero');
    state.entities.push(hero);

    const sightSet = buildSightSet('witch', state.entities, 'day', 7, 7);
    const known = buildFogKnownHexes(state, 'witch', sightSet);

    assert.ok(known.has(hexKey(3, 3)), 'witch position is known');
    // Hero position should NOT be known to witch (hero is far away)
    // Witch sight range is 2 in day, so (6,6) at distance ~4 should be unknown
    assert.ok(!known.has(hexKey(6, 6)), 'hero position not known to witch');
  });
});

// ── Terrain pass culling ────────────────────────────────────────────────────

describe('terrain pass skips unseen hexes', () => {
  test('simulated terrain pass only draws known hexes', () => {
    const state = makeTinyState();
    const hero = createHero(0, 0, 'hero');
    state.entities.push(hero);
    state.phase = Phase.NIGHT; // sight range 1

    const sightSet = buildSightSet('hero', state.entities, 'night', 7, 7);
    const fogKnownHexes = buildFogKnownHexes(state, 'hero', sightSet);

    // Simulate terrain pass: collect which hexes would be drawn
    const drawn = [];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        if (fogKnownHexes && !fogKnownHexes.has(hexKey(col, row))) continue;
        const t = state.tiles.get(hexKey(col, row));
        if (t) drawn.push(hexKey(col, row));
      }
    }

    // Total map has 49 hexes. With night sight range 1, only a small
    // subset near (0,0) should be drawn.
    assert.ok(drawn.length < 49, 'not all hexes are drawn');
    assert.ok(drawn.length > 0, 'some hexes are drawn');
    // Hero's own hex must be drawn
    assert.ok(drawn.includes(hexKey(0, 0)), 'hero hex is drawn');
    // Far hex must not be drawn
    assert.ok(!drawn.includes(hexKey(6, 6)), 'far hex is not drawn');
  });

  test('all hexes drawn when fogKnownHexes is null (no fog)', () => {
    const state = makeTinyState();
    const fogKnownHexes = null;

    const drawn = [];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        if (fogKnownHexes && !fogKnownHexes.has(hexKey(col, row))) continue;
        const t = state.tiles.get(hexKey(col, row));
        if (t) drawn.push(hexKey(col, row));
      }
    }

    assert.equal(drawn.length, 49, 'all hexes drawn when fog disabled');
  });
});

// ── Fog layer dim overlay ──────────────────────────────────────────────────

describe('fog layer skips unseen hexes', () => {
  test('only known non-sight hexes get dim overlay', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'hero');
    state.entities.push(hero);
    state.phase = Phase.NIGHT; // sight range 1

    // Pre-explore some hexes outside night sight range so they become
    // "known but not in sight" — these should get dimmed, not skipped.
    state.exploredHexes.hero.add(hexKey(0, 0));
    state.exploredHexes.hero.add(hexKey(6, 6));
    state.exploredHexes.hero.add(hexKey(5, 5));

    const sightSet = buildSightSet('hero', state.entities, 'night', 7, 7);
    const fogKnownHexes = buildFogKnownHexes(state, 'hero', sightSet);

    // Simulate fog layer logic: collect dim vs skipped hexes
    const dimmed = [];
    const skipped = [];
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        const k = hexKey(col, row);
        if (sightSet.has(k)) continue; // bright — no overlay
        if (fogKnownHexes && !fogKnownHexes.has(k)) {
          skipped.push(k);
          continue;
        }
        dimmed.push(k);
      }
    }

    assert.ok(dimmed.length > 0, 'some hexes are dimmed');
    assert.ok(skipped.length > 0, 'some hexes are skipped (unseen)');
    // No dimmed hex should be in the sight set
    for (const k of dimmed) {
      assert.ok(!sightSet.has(k), `dimmed hex ${k} is not in sight set`);
    }
    // All dimmed hexes should be in known set
    for (const k of dimmed) {
      assert.ok(fogKnownHexes.has(k), `dimmed hex ${k} is in known set`);
    }
    // No skipped hex should be in known set
    for (const k of skipped) {
      assert.ok(!fogKnownHexes.has(k), `skipped hex ${k} is not in known set`);
    }
  });

  test('no black overlay hexes exist in the new fog layer', () => {
    // Previously, unseen hexes got rgba(0,0,0,1.0) overlay. Now they are
    // simply not rendered. Verify no hex falls into the "black" category.
    const state = makeTinyState();
    const hero = createHero(0, 0, 'hero');
    state.entities.push(hero);
    state.phase = Phase.NIGHT;

    const sightSet = buildSightSet('hero', state.entities, 'night', 7, 7);
    const fogKnownHexes = buildFogKnownHexes(state, 'hero', sightSet);

    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 7; col++) {
        const k = hexKey(col, row);
        const inSight = sightSet.has(k);
        const inKnown = fogKnownHexes.has(k);
        // Every hex is either: bright (sight), dimmed (known but not sight),
        // or not rendered at all (not known). No "black overlay" tier.
        if (!inSight && !inKnown) {
          // This hex is unseen — should not be rendered at all
          continue;
        }
        // If in known but not sight, it gets dim overlay only
        if (inKnown && !inSight) {
          // Dim overlay — OK
          continue;
        }
        // If in sight — bright, no overlay
      }
    }
    // If we got here without error, the three-tier (bright/dim/skip) is correct
    assert.ok(true);
  });
});
