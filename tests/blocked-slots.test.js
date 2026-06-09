// deriveBlockedSlots + capacity + authoritative entity slot assignment, and
// their round-trip / migration through state-sync.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import {
  Tile, TileType, PathType, BuildingType,
  TILE_CAPACITY, treeCountForTile, tileOccupancyCount, tileCapacityRemaining,
  deriveBlockedSlots, decomposeTileType,
} from '../src/tiles.js';
import { OUTER_SLOTS, roadFaceSlots } from '../src/hex-slots.js';
import { assignSlotOnTile } from '../src/actions.js';
import { createMinion } from '../src/entities.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { hexKey } from '../src/hex.js';

describe('deriveBlockedSlots — forests', () => {
  test('forest places treeCountForTile slots, none on a road face nor centre', () => {
    const t = new Tile(3, 4, TileType.FOREST);
    t.roadDirs = new Set(['4,4']); // some adjacent road face
    const blocked = deriveBlockedSlots(t);
    const roadFaces = roadFaceSlots(t);
    const n = treeCountForTile(t);
    assert.equal(blocked.length, Math.min(n, OUTER_SLOTS.length - roadFaces.size));
    for (const s of blocked) {
      assert.ok(s >= 1 && s <= 6, 'tree slot is an outer slot');
      assert.ok(!roadFaces.has(s), `tree slot ${s} sits on a road face`);
    }
  });

  test('forest capacity is unchanged by the blocked-slot system', () => {
    // Occupancy still comes from treeCountForTile, so forest capacity matches
    // the pre-feature behaviour even after blockedSlots is populated.
    const t = new Tile(3, 4, TileType.FOREST);
    t.blockedSlots = deriveBlockedSlots(t);
    assert.equal(tileOccupancyCount(t), treeCountForTile(t));
    assert.equal(tileCapacityRemaining(t, 0), TILE_CAPACITY - treeCountForTile(t));
  });

  test('building-on-forest excludes the building slot from tree candidates', () => {
    const t = new Tile(2, 2, TileType.FOREST);
    t.structure = 'building';
    t.building = BuildingType.HOUSE;
    const blocked = deriveBlockedSlots(t);
    assert.ok(!blocked.includes(1), 'tree must not take the building slot (1)');
  });
});

describe('deriveBlockedSlots — bridges', () => {
  function bridge(col, row, roadDirs) {
    const t = new Tile(col, row);
    decomposeTileType(t, TileType.RIVER);
    t.path = PathType.BRIDGE;
    t.roadDirs = new Set(roadDirs);
    return t;
  }

  test('a 2-road bridge blocks all 4 non-road slots → capacity 3', () => {
    // (5,4): W (4,4)→slot3, E (6,4)→slot6 stay usable; the other 4 block.
    const t = bridge(5, 4, ['4,4', '6,4']);
    t.blockedSlots = deriveBlockedSlots(t);
    assert.equal(t.blockedSlots.length, 4);
    const roadFaces = roadFaceSlots(t);
    for (const s of t.blockedSlots) assert.ok(!roadFaces.has(s));
    assert.equal(tileOccupancyCount(t), 4);
    assert.equal(tileCapacityRemaining(t, 0), 3); // 7 - 4
  });

  test('bridge with no derived slots costs nothing until derived', () => {
    const t = bridge(5, 4, ['4,4', '6,4']);
    // blockedSlots default [] → bridge term 0 (legacy/pre-derive behaviour)
    assert.equal(tileOccupancyCount(t), 0);
  });
});

describe('assignSlotOnTile — authoritative entity slots', () => {
  // A tile with no starting entity, no blocked slots, and not a building
  // footprint — a clean place to test slot picking.
  function emptyTile(state) {
    const occupied = new Set(state.entities.map(e => hexKey(e.col, e.row)));
    return [...state.tiles.values()].find(x =>
      (x.blockedSlots?.length ?? 0) === 0 &&
      !x.buildingFootprintOf &&
      !occupied.has(hexKey(x.col, x.row)));
  }

  test('a lone unit lands on the centre slot', () => {
    const state = new GameState(true, true);
    const t = emptyTile(state);
    const u = createMinion(t.col, t.row, null, state);
    state.entities.push(u);
    assignSlotOnTile(state, u);
    assert.equal(u.slot, 0);
  });

  test('a second unit on the same tile gets a distinct slot', () => {
    const state = new GameState(true, true);
    const t = emptyTile(state);
    const a = createMinion(t.col, t.row, null, state);
    const b = createMinion(t.col, t.row, null, state);
    state.entities.push(a); assignSlotOnTile(state, a);
    state.entities.push(b); assignSlotOnTile(state, b);
    assert.equal(a.slot, 0);
    assert.notEqual(b.slot, a.slot);
  });

  test('units avoid the tile’s blocked slots', () => {
    const state = new GameState(true, true);
    const t = emptyTile(state);
    t.blockedSlots = [1, 2, 3];
    const u = createMinion(t.col, t.row, null, state);
    state.entities.push(u);
    assignSlotOnTile(state, u);
    assert.ok(!t.blockedSlots.includes(u.slot));
  });
});

describe('state-sync round-trip & migration', () => {
  test('entity slot and tile blockedSlots survive serialize → deserialize', () => {
    const state = new GameState(true, true);
    state.hero.slot = 4;
    const t = [...state.tiles.values()][0];
    t.blockedSlots = [2, 5];
    const restored = deserializeState(serializeState(state));
    const h = restored.entities.find(e => e.id === state.hero.id);
    assert.equal(h.slot, 4);
    assert.deepEqual(restored.tiles.get(hexKey(t.col, t.row)).blockedSlots, [2, 5]);
  });

  test('legacy snapshot (no slot / blockedSlots) hydrates: slot→0, bridge cap derived', () => {
    const state = new GameState(true, true);
    // Make a known bridge tile so the migration has something to derive.
    const t = [...state.tiles.values()].find(x => !x.buildingFootprintOf);
    decomposeTileType(t, TileType.RIVER);
    t.path = PathType.BRIDGE;
    t.roadDirs = new Set([hexKey(t.col - 1, t.row), hexKey(t.col + 1, t.row)]);
    t.blockedSlots = deriveBlockedSlots(t);
    const expectedCap = tileCapacityRemaining(t, 0);

    const snap = serializeState(state);
    for (const e of snap.entities) delete e.slot;
    for (const ts of snap.tiles) delete ts.blockedSlots;

    const restored = deserializeState(snap);
    for (const e of restored.entities) assert.equal(e.slot, 0);
    const rt = restored.tiles.get(hexKey(t.col, t.row));
    assert.equal(tileCapacityRemaining(rt, 0), expectedCap,
      'migrated bridge regains its reduced capacity');
  });
});
