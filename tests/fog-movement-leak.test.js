// Tests that movement highlights don't leak hidden enemy positions through fog.
// When fog is active and an enemy is not visible, their tile should still
// appear as a valid move destination (green highlight). The move may fail at
// resolution if the enemy is still there, but the planning UI must not reveal
// hidden positions by omitting tiles from the highlight set.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { hexKey } from '../src/hex.js';
import {
  getReachableHexes, getValidActions, getVisiblePositions,
} from '../src/actions.js';
import { validatePlanAction, PlanActionType } from '../src/planner.js';
import { Phase } from '../src/game.js';
import { createHero, createWitch, createMinion } from '../src/entities.js';
import { TileType } from '../src/tiles.js';

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeTinyState(fogOfWar = 'partial') {
  const state = {
    phase: Phase.DAY,
    entities: [],
    tiles: new Map(),
    exploredHexes: { hero: new Set(), witch: new Set() },
    fogOfWar,
    heroRevealedByHorn: false,
    inventory: { shared: {}, witch: {} },
    actionBudget: { hero: 3, witch: 3 },
  };
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 7; col++) {
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

// ── getReachableHexes with visibleEnemyHexes ────────────────────────────────

describe('getReachableHexes fog-aware enemy blocking', () => {
  test('blocks visible enemies (visibleEnemyHexes includes their hex)', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'hero');
    placeEntity(state, hero);
    const minion = createMinion(3, 2, 'witch');
    placeEntity(state, minion);

    // Enemy is visible — should be blocked
    const visible = new Set([hexKey(3, 2)]);
    const reachable = getReachableHexes(state, hero, 1, null, visible);
    assert.ok(
      !reachable.some(h => h.col === 3 && h.row === 2),
      'visible enemy hex should NOT be reachable'
    );
  });

  test('does NOT block hidden enemies (visibleEnemyHexes omits their hex)', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'hero');
    placeEntity(state, hero);
    const minion = createMinion(3, 2, 'witch');
    placeEntity(state, minion);

    // Enemy is NOT visible — should be reachable
    const visible = new Set(); // empty = nothing visible
    const reachable = getReachableHexes(state, hero, 1, null, visible);
    assert.ok(
      reachable.some(h => h.col === 3 && h.row === 2),
      'hidden enemy hex SHOULD be reachable when not visible'
    );
  });

  test('blocks all enemies when visibleEnemyHexes is null (resolution mode)', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'hero');
    placeEntity(state, hero);
    const minion = createMinion(3, 2, 'witch');
    placeEntity(state, minion);

    // null = resolution mode, all enemies blocked
    const reachable = getReachableHexes(state, hero, 1, null, null);
    assert.ok(
      !reachable.some(h => h.col === 3 && h.row === 2),
      'enemy hex should be blocked in resolution mode (null visibility)'
    );
  });

  test('allows pathing through hidden enemy tiles to reach tiles beyond', () => {
    const state = makeTinyState();
    const hero = createHero(3, 3, 'hero');
    placeEntity(state, hero);
    // Place enemy on an adjacent tile that is on the path to a tile 2 steps away
    const minion = createMinion(3, 2, 'witch');
    placeEntity(state, minion);

    // With horse (range 2), a road through the enemy tile, and enemy hidden,
    // should be able to reach tiles beyond
    state.tiles.set(hexKey(3, 2), {
      type: TileType.ROAD, building: null, fortifyLevel: 0, explored: false,
    });
    state.tiles.set(hexKey(3, 1), {
      type: TileType.ROAD, building: null, fortifyLevel: 0, explored: false,
    });

    const visible = new Set(); // enemy hidden
    const reachable = getReachableHexes(state, hero, 2, null, visible);
    assert.ok(
      reachable.some(h => h.col === 3 && h.row === 1),
      'should reach tile beyond hidden enemy via road'
    );
  });
});

// ── getValidActions respects fog ────────────────────────────────────────────

describe('getValidActions does not leak enemy positions in fog', () => {
  test('move targets include hidden enemy hex when fog is active', () => {
    const state = makeTinyState('partial');
    const hero = createHero(3, 3, 'hero');
    placeEntity(state, hero);
    // Place enemy far enough away to be outside sight range
    // DAY sight = 3, so place enemy at distance 1 but make sight range 0
    // Actually, just place adjacent and use NIGHT phase (sight=1) at distance > 1
    // Simpler: place enemy adjacent but use a state where sight is too short
    // Sight range in DAY=3, so adjacent (dist=1) IS visible. Use NIGHT (sight=1).
    // At distance 1, NIGHT sight=1 still sees them. Let's place further away.
    // Actually at dist=1, sight=1 means visible. We need dist > sight.
    // Place hero at (3,3), enemy at (3,2) — distance 1. NIGHT sight=1 → visible.
    // Place hero at (0,0), enemy at (0,2) — distance 2. NIGHT sight=1 → NOT visible.
    // But then they're not adjacent so movement range 1 won't reach.
    // Best approach: test getValidActions with a manually placed far enemy blocking
    // a near tile. Actually let's just verify the mechanism works for adjacent.

    // In NIGHT phase, sight = 1, so adjacent IS visible. Use a setup where
    // the enemy is visible to confirm blocking, then one where they aren't.
    // The simplest way: use fog='partial' with no friendly units near the enemy.
    // getVisiblePositions checks sight range from all friendly entities.
    // Hero at (0,0) in NIGHT phase has sight=1, enemy at (1,0) is distance=1 → visible.
    // Hero at (0,0) in NIGHT phase has sight=1, enemy at (0,2) is distance=2 → NOT visible.
    // But (0,2) is not adjacent, so can't test movement to it with range 1.
    // Solution: use range 2 (horse).

    // Fresh setup: hero with horse at (0,0), enemy at (0,2), NIGHT phase
    const s = makeTinyState('partial');
    s.phase = Phase.NIGHT; // sight=1
    const h = createHero(0, 0, 'hero');
    h.items = { horse: 1 };
    placeEntity(s, h);
    const m = createMinion(0, 2, 'witch');
    placeEntity(s, m);

    // Make road path to extend range: (0,0)->(0,1)->(0,2) all roads
    s.tiles.set(hexKey(0, 1), {
      type: TileType.ROAD, building: null, fortifyLevel: 0, explored: false,
    });
    s.tiles.set(hexKey(0, 2), {
      type: TileType.ROAD, building: null, fortifyLevel: 0, explored: false,
    });

    const actions = getValidActions(s, h);
    const moveAction = actions.find(a => a.type === 'move');
    assert.ok(moveAction, 'should have a move action');

    // Enemy at (0,2) is distance 2 from hero at (0,0), NIGHT sight=1 → NOT visible
    // So the tile should still appear in move targets
    const hasFoggedEnemyTile = moveAction.targets.some(t => t.col === 0 && t.row === 2);
    assert.ok(
      hasFoggedEnemyTile,
      'move targets should include hex with hidden enemy (fog should not leak)'
    );
  });

  test('move targets exclude visible enemy hex', () => {
    const s = makeTinyState('partial');
    s.phase = Phase.DAY; // sight=3
    const h = createHero(3, 3, 'hero');
    placeEntity(s, h);
    const m = createMinion(3, 2, 'witch');
    placeEntity(s, m);

    // DAY sight=3, distance=1 → enemy is VISIBLE
    const actions = getValidActions(s, h);
    const moveAction = actions.find(a => a.type === 'move');
    assert.ok(moveAction, 'should have a move action');

    const hasVisibleEnemyTile = moveAction.targets.some(t => t.col === 3 && t.row === 2);
    assert.ok(
      !hasVisibleEnemyTile,
      'move targets should exclude hex with visible enemy'
    );
  });

  test('no fog (fogOfWar=none) still blocks enemy hexes', () => {
    const s = makeTinyState('none');
    const h = createHero(3, 3, 'hero');
    placeEntity(s, h);
    const m = createMinion(3, 2, 'witch');
    placeEntity(s, m);

    const actions = getValidActions(s, h);
    const moveAction = actions.find(a => a.type === 'move');
    assert.ok(moveAction, 'should have a move action');

    const hasEnemyTile = moveAction.targets.some(t => t.col === 3 && t.row === 2);
    assert.ok(!hasEnemyTile, 'without fog, enemy hex should be blocked as before');
  });
});

// ── validatePlanAction respects fog ─────────────────────────────────────────

describe('validatePlanAction MOVE respects fog', () => {
  test('allows planning a move to a hidden enemy hex', () => {
    const s = makeTinyState('partial');
    s.phase = Phase.NIGHT;
    const h = createHero(0, 0, 'hero');
    h.items = { horse: 1 };
    placeEntity(s, h);
    const m = createMinion(0, 2, 'witch');
    placeEntity(s, m);

    s.tiles.set(hexKey(0, 1), {
      type: TileType.ROAD, building: null, fortifyLevel: 0, explored: false,
    });
    s.tiles.set(hexKey(0, 2), {
      type: TileType.ROAD, building: null, fortifyLevel: 0, explored: false,
    });

    const result = validatePlanAction(s, {
      type: PlanActionType.MOVE,
      entityId: h.id,
      toCol: 0,
      toRow: 2,
    });
    assert.ok(result.valid, 'should allow move to hidden enemy hex during planning');
  });

  test('rejects move to a visible enemy hex', () => {
    const s = makeTinyState('partial');
    s.phase = Phase.DAY;
    const h = createHero(3, 3, 'hero');
    placeEntity(s, h);
    const m = createMinion(3, 2, 'witch');
    placeEntity(s, m);

    const result = validatePlanAction(s, {
      type: PlanActionType.MOVE,
      entityId: h.id,
      toCol: 3,
      toRow: 2,
    });
    assert.ok(!result.valid, 'should reject move to visible enemy hex');
  });
});
