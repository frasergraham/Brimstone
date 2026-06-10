// Map-gen populates authoritative sub-hex blocked slots on forest and bridge
// tiles: trees stay off the road faces, bridges block every non-road slot, and
// the result is deterministic for a given seed.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { generateMap } from '../src/map.js';
import {
  baseOf, isBridge, isBuildingFootprint, TileType, treeCountForTile,
} from '../src/tiles.js';
import { OUTER_SLOTS, roadFaceSlots } from '../src/hex-slots.js';

const SIZES = ['skirmish', 'standard'];

describe('generated maps — blocked slots', () => {
  test('every tile has a blockedSlots array', () => {
    for (const size of SIZES) {
      const { tiles } = generateMap(7, size);
      for (const t of tiles.values()) {
        assert.ok(Array.isArray(t.blockedSlots), `${t.col},${t.row} missing blockedSlots`);
        for (const s of t.blockedSlots) assert.ok(s >= 1 && s <= 6, 'slot is outer');
      }
    }
  });

  test('forest trees avoid road faces and the centre', () => {
    for (const size of SIZES) {
      const { tiles } = generateMap(11, size);
      let sawForest = false;
      for (const t of tiles.values()) {
        if (baseOf(t) !== TileType.FOREST || isBuildingFootprint(t)) continue;
        sawForest = true;
        const roadFaces = roadFaceSlots(t);
        for (const s of t.blockedSlots) {
          assert.notEqual(s, 0, 'no tree on the centre');
          assert.ok(!roadFaces.has(s), `forest ${t.col},${t.row} put a tree on road face ${s}`);
        }
        assert.ok(t.blockedSlots.length <= treeCountForTile(t));
      }
      assert.ok(sawForest, 'expected at least one forest tile');
    }
  });

  test('bridges block every non-road outer slot', () => {
    for (const size of SIZES) {
      const { tiles } = generateMap(11, size);
      let sawBridge = false;
      for (const t of tiles.values()) {
        if (!isBridge(t)) continue;
        sawBridge = true;
        const roadFaces = roadFaceSlots(t);
        const expected = OUTER_SLOTS.filter(s => !roadFaces.has(s));
        assert.deepEqual([...t.blockedSlots].sort((a, b) => a - b), expected);
      }
      assert.ok(sawBridge, 'expected at least one bridge tile');
    }
  });

  test('blocked slots are deterministic for a fixed seed', () => {
    const a = generateMap(42, 'standard').tiles;
    const b = generateMap(42, 'standard').tiles;
    for (const [k, ta] of a) {
      assert.deepEqual(ta.blockedSlots, b.get(k).blockedSlots, `mismatch at ${k}`);
    }
  });
});
