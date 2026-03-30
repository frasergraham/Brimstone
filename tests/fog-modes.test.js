// Tests for three-mode fog of war: none / partial / full
//   - fogOfWar string enum in GameState
//   - getFogReachableHexes ignores enemies
//   - buildFogMovementHexes unions all friendly entities
//   - exploredHexes memory persists
//   - state-sync backward compatibility for boolean fogOfWar

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hexKey } from '../src/hex.js';
import {
  getFogReachableHexes, buildFogMovementHexes, sightRange,
} from '../src/actions.js';
import { GameState, Phase } from '../src/game.js';
import { createHero, createWitch, createMinion } from '../src/entities.js';
import { TileType } from '../src/tiles.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTinyState() {
  // 5x5 map, all grass, no rivers
  const state = {
    phase: Phase.DAY,
    entities: [],
    tiles: new Map(),
    exploredHexes: { hero: new Set(), witch: new Set() },
    fogOfWar: 'full',
  };
  for (let row = 0; row < 5; row++) {
    for (let col = 0; col < 5; col++) {
      state.tiles.set(hexKey(col, row), {
        type: TileType.GRASS, building: null, fortifyLevel: 0, explored: false,
      });
    }
  }
  return state;
}

function placeEntity(state, entity) {
  state.entities.push(entity);
  return entity;
}

// ── GameState fogOfWar enum ─────────────────────────────────────────────────

describe('fogOfWar string enum', () => {
  test('defaults to partial when AI is present', () => {
    const state = new GameState(true, false);
    assert.equal(state.fogOfWar, 'partial');
  });

  test('defaults to none when both players are human', () => {
    const state = new GameState(false, false);
    assert.equal(state.fogOfWar, 'none');
  });

  test('exploredHexes initialized as empty Sets', () => {
    const state = new GameState(true, false);
    assert.ok(state.exploredHexes.hero instanceof Set);
    assert.ok(state.exploredHexes.witch instanceof Set);
    assert.equal(state.exploredHexes.hero.size, 0);
  });
});

// ── getFogReachableHexes ────────────────────────────────────────────────────

describe('getFogReachableHexes', () => {
  test('returns reachable hexes including start position', () => {
    const state = makeTinyState();
    const hero = createHero(2, 2, 'hero');
    placeEntity(state, hero);
    const reachable = getFogReachableHexes(state, hero);
    assert.ok(reachable.has(hexKey(2, 2)), 'should include start hex');
    assert.ok(reachable.size > 1, 'should include at least one neighbor');
  });

  test('ignores enemy units (unlike getReachableHexes)', () => {
    const state = makeTinyState();
    const hero = createHero(2, 2, 'hero');
    placeEntity(state, hero);
    // Place enemy on adjacent hex
    const minion = createMinion(2, 1, 'witch');
    placeEntity(state, minion);
    const reachable = getFogReachableHexes(state, hero);
    // Should still include the hex with the enemy (fog visibility ignores blocking)
    assert.ok(reachable.has(hexKey(2, 1)), 'enemy hex should be reachable for fog');
  });

  test('river tiles are impassable', () => {
    const state = makeTinyState();
    state.tiles.set(hexKey(2, 1), {
      type: TileType.RIVER, building: null, fortifyLevel: 0, explored: false,
    });
    const hero = createHero(2, 2, 'hero');
    placeEntity(state, hero);
    const reachable = getFogReachableHexes(state, hero);
    assert.ok(!reachable.has(hexKey(2, 1)), 'river hex should not be reachable');
  });

  test('road tiles extend range (cost 1 instead of 2)', () => {
    const state = makeTinyState();
    // Make a road path: (2,2) -> (2,1) -> (2,0)
    state.tiles.set(hexKey(2, 1), {
      type: TileType.ROAD, building: null, fortifyLevel: 0, explored: false,
    });
    state.tiles.set(hexKey(2, 0), {
      type: TileType.ROAD, building: null, fortifyLevel: 0, explored: false,
    });
    const hero = createHero(2, 2, 'hero');
    placeEntity(state, hero);
    const reachable = getFogReachableHexes(state, hero);
    // With budget 2, road tiles cost 1 each, so should reach 2 road hops
    assert.ok(reachable.has(hexKey(2, 1)), 'first road hop');
    assert.ok(reachable.has(hexKey(2, 0)), 'second road hop');
  });
});

// ── buildFogMovementHexes ───────────────────────────────────────────────────

describe('buildFogMovementHexes', () => {
  test('unions reachable hexes for all friendly entities', () => {
    const state = makeTinyState();
    const hero = createHero(0, 0, 'hero');
    placeEntity(state, hero);
    const survivor = createHero(4, 4, 'hero'); // far corner
    survivor.owner = 'hero';
    placeEntity(state, survivor);

    const union = buildFogMovementHexes(state, 'hero');
    assert.ok(union.has(hexKey(0, 0)), 'hero start hex');
    assert.ok(union.has(hexKey(4, 4)), 'survivor start hex');
    assert.ok(union.size > 2, 'should include neighbors of both entities');
  });

  test('uses projected positions when provided', () => {
    const state = makeTinyState();
    const hero = createHero(0, 0, 'hero');
    placeEntity(state, hero);

    // Project hero to center
    const projected = new Map([[hero.id, { col: 2, row: 2 }]]);
    const union = buildFogMovementHexes(state, 'hero', projected);
    assert.ok(union.has(hexKey(2, 2)), 'projected position included');
    // Original position should NOT be in the reachable set (unit moved)
    // Actually it might still be reachable from projected pos depending on distance
    // The key point is that projected position IS reachable
  });

  test('ignores dead entities', () => {
    const state = makeTinyState();
    const hero = createHero(2, 2, 'hero');
    hero.hp = 0; // alive is a getter based on hp > 0
    placeEntity(state, hero);

    const union = buildFogMovementHexes(state, 'hero');
    assert.equal(union.size, 0, 'dead entity contributes nothing');
  });

  test('ignores enemy entities', () => {
    const state = makeTinyState();
    const minion = createMinion(2, 2, 'witch');
    placeEntity(state, minion);

    const union = buildFogMovementHexes(state, 'hero');
    assert.equal(union.size, 0, 'enemy entity not included');
  });
});

// ── exploredHexes memory ────────────────────────────────────────────────────

describe('exploredHexes memory', () => {
  test('markExplored adds hexes to faction set', () => {
    const state = new GameState(true, false);
    const hexes = new Set([hexKey(1, 1), hexKey(2, 2)]);
    state.markExplored('hero', hexes);
    assert.ok(state.exploredHexes.hero.has(hexKey(1, 1)));
    assert.ok(state.exploredHexes.hero.has(hexKey(2, 2)));
  });

  test('markExplored accumulates across calls', () => {
    const state = new GameState(true, false);
    state.markExplored('hero', new Set([hexKey(1, 1)]));
    state.markExplored('hero', new Set([hexKey(2, 2)]));
    assert.equal(state.exploredHexes.hero.size, 2);
  });

  test('markExplored does not affect other faction', () => {
    const state = new GameState(true, false);
    state.markExplored('hero', new Set([hexKey(1, 1)]));
    assert.equal(state.exploredHexes.witch.size, 0);
  });
});

// ── State serialization backward compat ─────────────────────────────────────

describe('fogOfWar state-sync backward compatibility', () => {
  test('boolean true deserializes to partial', async () => {
    // Import dynamically to avoid server-side module issues
    const { serializeState, deserializeState } = await import('../server/state-sync.js');
    const state = new GameState(true, false);
    state.fogOfWar = 'partial';
    const snap = serializeState(state);
    // Simulate old boolean format
    snap.fogOfWar = true;
    delete snap.exploredHexes;
    const restored = deserializeState(snap);
    assert.equal(restored.fogOfWar, 'partial');
    assert.ok(restored.exploredHexes.hero instanceof Set);
  });

  test('boolean false deserializes to none', async () => {
    const { serializeState, deserializeState } = await import('../server/state-sync.js');
    const state = new GameState(false, false);
    const snap = serializeState(state);
    snap.fogOfWar = false;
    delete snap.exploredHexes;
    const restored = deserializeState(snap);
    assert.equal(restored.fogOfWar, 'none');
  });

  test('string values preserved through round-trip', async () => {
    const { serializeState, deserializeState } = await import('../server/state-sync.js');
    for (const mode of ['none', 'partial', 'full']) {
      const state = new GameState(true, false);
      state.fogOfWar = mode;
      state.markExplored('hero', new Set([hexKey(3, 3)]));
      const snap = serializeState(state);
      const restored = deserializeState(snap);
      assert.equal(restored.fogOfWar, mode, `mode ${mode} preserved`);
      assert.ok(restored.exploredHexes.hero.has(hexKey(3, 3)), 'explored hex preserved');
    }
  });
});
