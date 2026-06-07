// Tests for the 2D renderer's line-of-sight memoization (B2).
//
// _buildFogVisibleHexes / _cachedVisiblePositions recompute the (pure)
// computeLineOfSight / getVisiblePositions BFS only when _fogVersion() changes
// — sight only moves when an entity moves/dies, the round advances, or the fog
// mode changes. draw() fires on every hover during planning, so this avoids
// re-running the BFS on every pointer move. We verify:
//   • _fogVersion is stable when nothing relevant changed, and sensitive to
//     entity moves / round / fog mode.
//   • _buildFogVisibleHexes returns the SAME Set instance on a cache hit, and a
//     fresh one after an entity moves (correctness of invalidation).
//   • transient attacker reveals are folded in WITHOUT polluting the cache.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Renderer } from '../src/renderer.js';
import { Phase } from '../src/game.js';
import { hexKey, setMapDimensions } from '../src/hex.js';
import { TileType } from '../src/tiles.js';

setMapDimensions(20, 20);

// Minimal duck-typed entity — computeLineOfSight only needs alive/owner/col/row
// and an optional hasAbility() hook (mirrors tests/los-fog.test.js).
function entity(owner, col, row) {
  return { owner, col, row, alive: true, hasAbility() { return false; } };
}

function rectGrass(cols, rows) {
  const tiles = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.set(hexKey(c, r), { col: c, row: r, base: TileType.GRASS, structure: null, path: null });
    }
  }
  return tiles;
}

// A fresh fake-renderer `this` carrying just the fields the memoized helpers use.
function fakeRenderer(state) {
  return {
    state,
    _fogBaseCache:  { key: null, set: null },
    _revealedCache: { key: null, set: null },
    _attackerReveals: [],
    _fogVersion:            Renderer.prototype._fogVersion,
    _cachedLineOfSight:     Renderer.prototype._cachedLineOfSight,
    _cachedVisiblePositions: Renderer.prototype._cachedVisiblePositions,
    _buildFogVisibleHexes:  Renderer.prototype._buildFogVisibleHexes,
  };
}

function baseState() {
  return {
    phase: Phase.DAY,
    round: 1,
    fogOfWar: 'partial',
    tiles: rectGrass(15, 15),
    entities: [entity('hero', 7, 7)],
  };
}

describe('_fogVersion', () => {
  test('stable when nothing relevant changed', () => {
    const r = fakeRenderer(baseState());
    assert.equal(r._fogVersion('hero'), r._fogVersion('hero'));
  });

  test('changes when an entity moves', () => {
    const r = fakeRenderer(baseState());
    const before = r._fogVersion('hero');
    r.state.entities[0].col += 1;
    assert.notEqual(before, r._fogVersion('hero'));
  });

  test('changes when the round advances', () => {
    const r = fakeRenderer(baseState());
    const before = r._fogVersion('hero');
    r.state.round = 2;
    assert.notEqual(before, r._fogVersion('hero'));
  });

  test('changes when the fog mode changes', () => {
    const r = fakeRenderer(baseState());
    const before = r._fogVersion('hero');
    r.state.fogOfWar = 'none';
    assert.notEqual(before, r._fogVersion('hero'));
  });

  test('distinct per observer', () => {
    const r = fakeRenderer(baseState());
    assert.notEqual(r._fogVersion('hero'), r._fogVersion('witch'));
  });
});

describe('_buildFogVisibleHexes memoization', () => {
  test('returns the same Set instance on a cache hit', () => {
    const r = fakeRenderer(baseState());
    const first  = r._buildFogVisibleHexes('hero');
    const second = r._buildFogVisibleHexes('hero');
    assert.strictEqual(first, second, 'unchanged state should reuse the cached set');
    assert.ok(first.has(hexKey(7, 7)), 'observer hex is visible');
  });

  test('recomputes (new instance) after an entity moves', () => {
    const r = fakeRenderer(baseState());
    const first = r._buildFogVisibleHexes('hero');
    assert.ok(first.has(hexKey(7, 7)), 'precondition: original centre visible');
    r.state.entities[0].col = 1;
    r.state.entities[0].row = 1;
    const second = r._buildFogVisibleHexes('hero');
    assert.notStrictEqual(first, second, 'a move must invalidate the cache');
    assert.ok(second.has(hexKey(1, 1)), 'new observer hex is visible');
    // (7,7) is now 12 hexes away — well beyond the 6-hex day disc.
    assert.ok(!second.has(hexKey(7, 7)), 'distant old centre no longer in sight');
  });

  test('attacker reveals fold in without polluting the cached base', () => {
    const r = fakeRenderer(baseState());
    const base = r._cachedLineOfSight('hero');
    const revealKey = hexKey(0, 0); // far outside the day disc
    assert.ok(!base.has(revealKey), 'precondition: reveal hex not normally visible');

    r._attackerReveals = [{ key: revealKey, expiresAt: Date.now() + 10_000 }];
    const withReveal = r._buildFogVisibleHexes('hero');
    assert.ok(withReveal.has(revealKey), 'transient reveal is included');
    assert.notStrictEqual(withReveal, base, 'reveal path returns a clone, not the cached base');
    assert.ok(!base.has(revealKey), 'cached base set was not mutated');
  });

  test('expired attacker reveals are pruned and ignored', () => {
    const r = fakeRenderer(baseState());
    const revealKey = hexKey(0, 0);
    r._attackerReveals = [{ key: revealKey, expiresAt: Date.now() - 1 }];
    const set = r._buildFogVisibleHexes('hero');
    assert.ok(!set.has(revealKey), 'expired reveal must not appear');
    assert.equal(r._attackerReveals.length, 0, 'expired reveal pruned from the list');
  });
});

describe('_cachedVisiblePositions memoization', () => {
  test('same instance on a hit, fresh after a move', () => {
    const state = baseState();
    state.entities.push(entity('witch', 8, 7)); // an enemy near the hero
    const r = fakeRenderer(state);
    const first = r._cachedVisiblePositions('hero');
    assert.strictEqual(first, r._cachedVisiblePositions('hero'));
    r.state.entities[0].col = 1;
    r.state.entities[0].row = 1;
    assert.notStrictEqual(first, r._cachedVisiblePositions('hero'));
  });
});
