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
  isPathRoadLike, isForestCover, legacyTileType } from '../src/tiles.js';

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
  test('SAVE_VERSION is 8 (shared-inventory dict-of-objects bump)', () => {
    assert.equal(SAVE_VERSION, 8);
  });
});

// Phase 2 migration: shared faction inventories flatten from `{ id: N }` to the
// dict-of-objects shape `{ id: { count: N } }` on deserialize. The shim chains
// after the legacy `shared`→`hero` rename and is idempotent.
describe('state-sync — inventory dict-of-objects migration (v7 → v8)', () => {
  test('flat numeric resources migrate to { count } on deserialize', () => {
    const snap = serializeState(freshState());
    snap.inventory = { hero: { food: 5, silver: 3 }, witch: { wood: 4, metal: 2 } };
    const restored = deserializeState(snap);
    assert.deepEqual(restored.inventory.hero, { food: { count: 5 }, silver: { count: 3 } });
    assert.deepEqual(restored.inventory.witch, { wood: { count: 4 }, metal: { count: 2 } });
  });

  test('idempotent — already-migrated (v8) data round-trips unchanged', () => {
    const snap = serializeState(freshState());
    snap.inventory = { hero: { food: { count: 5 } }, witch: { wood: { count: 2 } } };
    const restored = deserializeState(snap);
    assert.deepEqual(restored.inventory.hero, { food: { count: 5 } });
    assert.deepEqual(restored.inventory.witch, { wood: { count: 2 } });
  });

  test('cascades v6 → v8: legacy `shared` pool is renamed to hero AND flattened', () => {
    const snap = serializeState(freshState());
    // A v6 snapshot predates BOTH the `shared`→`hero` rename and the numeric→
    // object change; a single load must walk both shims in order.
    snap.inventory = { shared: { food: 2, metal: 1 }, witch: { wood: 3 } };
    const restored = deserializeState(snap);
    assert.equal(restored.inventory.shared, undefined, 'shared pool renamed away');
    assert.deepEqual(restored.inventory.hero, { food: { count: 2 }, metal: { count: 1 } });
    assert.deepEqual(restored.inventory.witch, { wood: { count: 3 } });
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
    assert.equal(legacyTileType(get(0, 2)),           TileType.BUILDING);
    assert.equal(isPathRoadLike(get(0, 2)), true);

    // road-over-forest: BOTH the road path AND the forest base must survive.
    const rf = get(1, 2);
    assert.equal(baseOf(rf),       TileType.FOREST, 'forest base must survive under a road');
    assert.equal(pathOf(rf),       PathType.ROAD);
    assert.equal(isForestCover(rf), true, 'road over forest still grants cover (P0 semantics)');
    assert.equal(legacyTileType(rf),          TileType.ROAD, 'derived type prefers path over base');
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
      assert.equal(legacyTileType(rt), legacyTileType(orig), `tile ${key} derived type must round-trip`);
    }
  });
});

describe('state-sync — undiscovered-tile authored hidden-encounter fields round-trip', () => {
  // An UNDISCOVERED tile carries the authored hidden-encounter payload directly
  // (hiddenSurvivorId / hiddenSurvivorLevel / exploreOverride). Until the tile is
  // explored, that data lives ONLY on the tile — so it MUST survive a mid-mission
  // save/resume. Once discovered, triggerSurvivorEncounter clears the tile and the
  // spawned entity carries the data instead (entity.ref/level already round-trip).
  test('all three fields survive on an undiscovered tile; control tile stays clean', () => {
    const state = freshState();

    // Undiscovered hidden-survivor tile with every authored field set.
    const hidden = new Tile(0, 0, TileType.GRASS);
    hidden.hiddenSurvivor = true;
    hidden.hiddenSurvivorId = 'martha';
    hidden.hiddenSurvivorLevel = 3;
    hidden.exploreOverride = { kind: 'resource', id: 'wood', amount: 2 };

    // Control tile: a plain grass tile with none of the hidden-encounter fields.
    const control = new Tile(1, 0, TileType.GRASS);

    withTiles(state, [hidden, control]);

    const restored = deserializeState(serializeState(state));
    const rt = restored.tiles.get('0,0');
    const ctl = restored.tiles.get('1,0');

    // Undiscovered tile: every authored field survives identically.
    assert.equal(rt.hiddenSurvivor,      true,     'hiddenSurvivor flag must survive');
    assert.equal(rt.hiddenSurvivorId,    'martha', 'hiddenSurvivorId must round-trip');
    assert.equal(rt.hiddenSurvivorLevel, 3,        'hiddenSurvivorLevel must round-trip');
    assert.deepEqual(rt.exploreOverride, { kind: 'resource', id: 'wood', amount: 2 },
      'exploreOverride must round-trip');

    // Control tile: no spurious hidden-encounter data after round-trip.
    assert.ok(!ctl.hiddenSurvivor,      'control tile must not gain hiddenSurvivor');
    assert.ok(!ctl.hiddenSurvivorId,    'control tile must not gain hiddenSurvivorId');
    assert.ok(!ctl.hiddenSurvivorLevel, 'control tile must not gain hiddenSurvivorLevel');
    assert.ok(!ctl.exploreOverride,     'control tile must not gain exploreOverride');
  });

  test('discovered path unchanged — the spawned entity still carries ref + level', () => {
    // After discovery the data has moved off the tile onto the entity. Confirm
    // that entity-carried path (the part that already worked) does not regress.
    const state = freshState();
    const surv = createSurvivor(2, 2);
    surv.owner = 'hero';
    surv.ref = 'survivor_2_2';
    surv.level = 4;
    state.entities.push(surv);

    const restored = deserializeState(serializeState(state));
    const rt = restored.entities.find(e => e.id === surv.id);
    assert.ok(rt, 'discovered survivor entity must survive round-trip');
    assert.equal(rt.ref,   'survivor_2_2', 'entity ref must round-trip (discovered path)');
    assert.equal(rt.level, 4,             'entity level must round-trip (discovered path)');
  });
});
