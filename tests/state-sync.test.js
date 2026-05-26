// Tests for server/state-sync.js — round-trip coverage for new entity fields.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { GameState } from '../src/game.js';
import { BASE_AGILITY, EntityType, createMinion, createSurvivor, SurvivorAbility } from '../src/entities.js';
import { SAVE_VERSION } from '../src/version.js';
import {
  Tile, TileType, PathType, StructureType, BuildingType,
  baseOf, pathOf, structureOf, isRiver, isBridge, hasBuilding,
  isPathRoadLike, isForestCover,
} from '../src/tiles.js';

function freshState() { return new GameState(true, true); }

describe('state-sync — Agility round-trip', () => {
  test('per-type defaults are present on every entity after construction', () => {
    const state = freshState();
    for (const e of state.entities) {
      assert.equal(e.agility, BASE_AGILITY[e.type] ?? 1,
        `Entity ${e.id} (${e.type}) should have default agility ${BASE_AGILITY[e.type]}`);
    }
  });

  test('custom agility survives serialize → deserialize', () => {
    const state = freshState();
    // Add a minion to exercise more than just hero/witch defaults.
    const minion = createMinion(5, 5);
    minion.owner = 'witch';
    state.entities.push(minion);

    // Override one entity to a non-default value.
    state.hero.agility = 9;

    const snap = serializeState(state);
    const restored = deserializeState(snap);

    for (const orig of state.entities) {
      const copy = restored.entities.find(e => e.id === orig.id);
      assert.ok(copy, `restored entity ${orig.id} missing`);
      assert.equal(copy.agility, orig.agility,
        `Agility for ${orig.id} (${orig.type}) must survive round-trip`);
    }
    const restoredHero = restored.entities.find(e => e.id === state.hero.id);
    assert.equal(restoredHero.agility, 9, 'Explicit override must persist');
  });

  test('pre-002 saves (missing agility) hydrate from BASE_AGILITY on restore', () => {
    const state = freshState();
    const snap = serializeState(state);
    // Simulate a legacy snapshot where agility is absent from entity blobs.
    for (const e of snap.entities) delete e.agility;

    const restored = deserializeState(snap);
    for (const e of restored.entities) {
      assert.notEqual(e.agility, undefined, `Entity ${e.id} should have a hydrated agility`);
      assert.equal(e.agility, BASE_AGILITY[e.type] ?? 1,
        `Missing agility should hydrate to BASE_AGILITY[${e.type}]`);
    }
  });
});

describe('state-sync — abilities array round-trip (Phase 4)', () => {
  test('survivor abilities[] survives serialize → deserialize', () => {
    const state = freshState();
    const survivor = createSurvivor(5, 5, 'hero-player-1', state);
    survivor.abilities = [SurvivorAbility.HEAL, SurvivorAbility.SCOUT];
    state.entities.push(survivor);

    const snap = serializeState(state);
    const restored = deserializeState(snap);

    const copy = restored.entities.find(e => e.id === survivor.id);
    assert.ok(copy, 'restored survivor present');
    assert.deepEqual(copy.abilities, [SurvivorAbility.HEAL, SurvivorAbility.SCOUT]);
    assert.equal(copy.hasAbility(SurvivorAbility.HEAL),  true);
    assert.equal(copy.hasAbility(SurvivorAbility.SCOUT), true);
  });

  test('entities without abilities serialize to empty array', () => {
    const state = freshState();
    const snap = serializeState(state);
    for (const e of snap.entities) {
      assert.ok(Array.isArray(e.abilities), `Entity ${e.id} abilities must be an array`);
    }
  });
});

describe('state-sync — factionId round-trip (rogue)', () => {
  test('rogue leader\'s factionId survives serialize → deserialize', async () => {
    const { concreteFactionOf } = await import('../src/factions.js');
    const state = freshState();
    state.swapLeaderToFaction('day', 'rogue');
    const heroId = state.hero.id;
    assert.equal(state.hero.factionId, 'rogue',
      'precondition: rogue leader should carry factionId');

    const snap = serializeState(state);
    const restored = deserializeState(snap);

    const restoredHero = restored.entities.find(e => e.id === heroId);
    assert.ok(restoredHero, 'restored leader present');
    assert.equal(restoredHero.factionId, 'rogue',
      'factionId must round-trip — without it the rogue silently reverts to paladin');
    // Concrete-faction lookup should resolve to RogueFaction post-restore.
    const fac = concreteFactionOf(restoredHero);
    assert.equal(fac.id, 'rogue');
    assert.equal(fac.canEquipWeaponItem('sword'), false,
      'restored rogue still refuses melee — proves the override is wired');
  });

  test('pre-PR saves (missing factionId) hydrate to null on restore', () => {
    const state = freshState();
    const snap = serializeState(state);
    // Simulate a legacy snapshot where factionId is absent from every blob.
    for (const e of snap.entities) delete e.factionId;
    const restored = deserializeState(snap);
    // Default leaders had no factionId before this PR; restore preserves
    // that — concrete lookup falls back to owner (side default).
    const hero = restored.entities.find(e => e.id === state.hero.id);
    assert.equal(hero.factionId, null);
  });
});

describe('state-sync — SAVE_VERSION', () => {
  test('SAVE_VERSION is 5 (layered tile model bump)', () => {
    assert.equal(SAVE_VERSION, 5);
  });
});

// Helper: overwrite a state's tiles with a hand-built set so we control the
// exact layer composition under test, then round-trip through state-sync.
function withTiles(state, tiles) {
  state.tiles = new Map();
  for (const t of tiles) state.tiles.set(`${t.col},${t.row}`, t);
  return state;
}

describe('state-sync — layered tile model round-trip (P1)', () => {
  test('serialize emits explicit base/structure/path layers', () => {
    const state = freshState();
    const snap = serializeState(state);
    for (const t of snap.tiles) {
      assert.ok('base' in t,      `tile ${t.key} snapshot must carry base`);
      assert.ok('structure' in t, `tile ${t.key} snapshot must carry structure`);
      assert.ok('path' in t,      `tile ${t.key} snapshot must carry path`);
      // `type` retained for back-compat, and must agree with the layers.
      assert.equal(typeof t.type, 'string');
    }
  });

  test('all base/path/structure combinations round-trip with correct accessors', () => {
    const state = freshState();

    // grass (plain), forest (cover), dirt
    const grass  = new Tile(0, 0, TileType.GRASS);
    const forest = new Tile(1, 0, TileType.FOREST);
    const dirt   = new Tile(2, 0, TileType.DIRT);
    // river / bridge / road
    const river  = new Tile(0, 1, TileType.RIVER);
    const bridge = new Tile(1, 1, TileType.BRIDGE);
    const road   = new Tile(2, 1, TileType.ROAD);
    // building tile
    const building = new Tile(0, 2, TileType.BUILDING);
    building.building = BuildingType.INN;
    // road OVER forest — the key layered case the derived `type` can't express.
    const roadForest = new Tile(1, 2, TileType.FOREST);
    roadForest.path = PathType.ROAD;
    roadForest.roadDirs = new Set(['1,1', '1,3']);

    withTiles(state, [grass, forest, dirt, river, bridge, road, building, roadForest]);

    const restored = deserializeState(serializeState(state));
    const get = (c, r) => restored.tiles.get(`${c},${r}`);

    // Every restored tile must be a real Tile instance (layered shim live).
    for (const t of restored.tiles.values()) {
      assert.ok(t instanceof Tile, 'restored tile must be a Tile instance');
    }

    // base material
    assert.equal(baseOf(get(0, 0)), TileType.GRASS);
    assert.equal(baseOf(get(1, 0)), TileType.FOREST);
    assert.equal(baseOf(get(2, 0)), TileType.DIRT);
    assert.equal(isForestCover(get(1, 0)), true);
    assert.equal(isForestCover(get(0, 0)), false);

    // path layer
    assert.equal(isRiver(get(0, 1)),  true);
    assert.equal(isBridge(get(1, 1)), true);
    assert.equal(pathOf(get(2, 1)),   PathType.ROAD);
    assert.equal(isPathRoadLike(get(2, 1)), true);
    assert.equal(isPathRoadLike(get(1, 1)), true); // bridge is road-like

    // building (structure + building field) → reports building type, road-like
    assert.equal(hasBuilding(get(0, 2)),   true);
    assert.equal(structureOf(get(0, 2)),   StructureType.BUILDING);
    assert.equal(get(0, 2).building,       BuildingType.INN);
    assert.equal(get(0, 2).type,           TileType.BUILDING);
    assert.equal(isPathRoadLike(get(0, 2)), true);

    // road-over-forest: BOTH the road path AND the forest base must survive.
    const rf = get(1, 2);
    assert.equal(baseOf(rf),       TileType.FOREST, 'forest base must survive under a road');
    assert.equal(pathOf(rf),       PathType.ROAD);
    assert.equal(isForestCover(rf), true, 'road over forest still grants cover (P0 semantics)');
    assert.equal(rf.type,          TileType.ROAD, 'derived type prefers path over base');
    assert.deepEqual([...rf.roadDirs].sort(), ['1,1', '1,3']);
  });

  test('roadDirs round-trips as a Set', () => {
    const state = freshState();
    const t = new Tile(3, 3, TileType.ROAD);
    t.roadDirs = new Set(['3,2', '4,3', '2,3']);
    withTiles(state, [t]);
    const restored = deserializeState(serializeState(state));
    const rt = restored.tiles.get('3,3');
    assert.ok(rt.roadDirs instanceof Set, 'roadDirs must restore as a Set');
    assert.deepEqual([...rt.roadDirs].sort(), ['2,3', '3,2', '4,3']);
  });

  test('LEGACY snapshot (only `type`, no layer fields) reconstructs layers correctly', () => {
    const state = freshState();
    withTiles(state, [
      new Tile(0, 0, TileType.FOREST),
      new Tile(1, 0, TileType.RIVER),
      Object.assign(new Tile(2, 0, TileType.BUILDING), { building: BuildingType.CHURCH }),
      new Tile(3, 0, TileType.BRIDGE),
      new Tile(4, 0, TileType.DIRT),
    ]);

    // Simulate a pre-P1 snapshot: strip the explicit layer fields so only the
    // derived `type` (and the other legacy fields) remain.
    const snap = serializeState(state);
    for (const t of snap.tiles) {
      delete t.base;
      delete t.structure;
      delete t.path;
    }

    const restored = deserializeState(snap);
    const get = (c, r) => restored.tiles.get(`${c},${r}`);

    // Forest tile → base forest, cover true.
    assert.equal(baseOf(get(0, 0)),      TileType.FOREST);
    assert.equal(isForestCover(get(0, 0)), true);
    // River → isRiver true, path river.
    assert.equal(isRiver(get(1, 0)),     true);
    assert.equal(pathOf(get(1, 0)),      PathType.RIVER);
    // Building tile → hasBuilding true.
    assert.equal(hasBuilding(get(2, 0)), true);
    assert.equal(structureOf(get(2, 0)), StructureType.BUILDING);
    assert.equal(get(2, 0).building,     BuildingType.CHURCH);
    // Bridge → isBridge true, road-like.
    assert.equal(isBridge(get(3, 0)),    true);
    assert.equal(isPathRoadLike(get(3, 0)), true);
    // Dirt → base dirt, no path, no cover.
    assert.equal(baseOf(get(4, 0)),      TileType.DIRT);
    assert.equal(pathOf(get(4, 0)),      null);
    assert.equal(isForestCover(get(4, 0)), false);
  });

  test('derived `type` matches the original after round-trip for every tile', () => {
    const state = freshState();
    const snap = serializeState(state);
    const restored = deserializeState(snap);
    for (const [key, orig] of state.tiles) {
      const rt = restored.tiles.get(key);
      assert.ok(rt, `tile ${key} restored`);
      assert.equal(rt.type, orig.type, `tile ${key} derived type must round-trip`);
    }
  });
});
