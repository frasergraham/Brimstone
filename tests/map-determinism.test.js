// Seeded-determinism tests for src/map.js.
//
// The screenshot/preview tooling, the network save/resume flow, and the 3D
// renderer scene-build path all assume that the same seed + map size produces
// the same map every time. If that invariant ever drifts (e.g. a generator step
// starts pulling from a different RNG, or Set/Map iteration order leaks into
// tile order), saves silently desync from preview thumbnails and AI training
// runs become unreproducible.
//
// These tests pin determinism end-to-end: tiles, witchObjectives, heroStart,
// and witchStart must match byte-for-byte across two independent generations
// with the same seed, across every preset size.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap, MAP_SIZES } from '../src/map.js';
import { hexKey } from '../src/hex.js';

// Canonicalise a generated map into a plain JSON-stable shape so deep-equal
// comparisons aren't tripped up by Set iteration order on `roadDirs`.
function _snapshot(result) {
  const tiles = [];
  for (const [k, t] of result.tiles) {
    tiles.push({
      k,
      col: t.col,
      row: t.row,
      type: t.type,
      building: t.building,
      explored: t.explored,
      resource: t.resource,
      fortifyLevel: t.fortifyLevel,
      roadDirs: [...t.roadDirs].sort(),
    });
  }
  tiles.sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  const objectives = result.witchObjectives.map(o => ({
    col: o.col, row: o.row, label: o.label,
    hexes: [...(o.hexes || [])]
      .map(h => `${h.col},${h.row}`)
      .sort(),
    color: o.color,
  }));
  return {
    tiles,
    witchObjectives: objectives,
    heroStart:  { col: result.heroStart.col,  row: result.heroStart.row },
    witchStart: { col: result.witchStart.col, row: result.witchStart.row },
    mapSize: result.mapSize,
  };
}

describe('generateMap — seeded determinism', () => {
  for (const size of ['skirmish', 'standard', 'regional', 'campaign']) {
    test(`${size}: same seed → identical map across runs`, () => {
      for (const seed of [1, 17, 9999, 1234567]) {
        const a = _snapshot(generateMap(seed, size));
        const b = _snapshot(generateMap(seed, size));
        assert.deepEqual(a, b,
          `seed=${seed}, size=${size}: maps differ between runs`);
      }
    });
  }

  test('different seeds produce different maps (sanity check)', () => {
    // If two seeds collided to the same map for every size, the determinism
    // assertion above would be vacuously true. Verify the generator actually
    // varies across seeds on the standard preset.
    const a = _snapshot(generateMap(1, 'standard'));
    const b = _snapshot(generateMap(2, 'standard'));
    assert.notDeepEqual(a, b, 'distinct seeds produced identical maps');
  });

  test('nodeCountOverride is deterministic', () => {
    for (const seed of [3, 42, 1000]) {
      for (const n of [1, 2, 3]) {
        const a = generateMap(seed, 'standard', n);
        const b = generateMap(seed, 'standard', n);
        assert.equal(a.witchObjectives.length, b.witchObjectives.length);
        for (let i = 0; i < a.witchObjectives.length; i++) {
          assert.equal(a.witchObjectives[i].col, b.witchObjectives[i].col);
          assert.equal(a.witchObjectives[i].row, b.witchObjectives[i].row);
        }
      }
    }
  });

  test('heroStart and witchStart are stable for the same seed', () => {
    for (const size of Object.keys(MAP_SIZES)) {
      for (const seed of [5, 50, 500]) {
        const a = generateMap(seed, size);
        const b = generateMap(seed, size);
        assert.equal(hexKey(a.heroStart.col, a.heroStart.row),
                     hexKey(b.heroStart.col, b.heroStart.row),
                     `heroStart drift on seed=${seed}, size=${size}`);
        assert.equal(hexKey(a.witchStart.col, a.witchStart.row),
                     hexKey(b.witchStart.col, b.witchStart.row),
                     `witchStart drift on seed=${seed}, size=${size}`);
      }
    }
  });
});
