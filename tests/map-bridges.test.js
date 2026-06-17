// Bridge connectivity invariant for src/map.js outputs.
//
// A BRIDGE tile MUST connect EXACTLY two road entry/exit faces. The 3D bridge
// model (`bridgeRotationY` in renderer-3d.js) orients its plank from the
// tile's `roadDirs`, so a bridge with 1, 3 or 4 road links renders a broken /
// floating span. The procedural generator used to produce such bridges when
// several MST road edges routed through the same single river crossing; the
// road/bridge audit in map.js now normalises every crossing to a clean
// two-link opposite-bank span.
//
// We sweep 100 seeds for each of the four standard presets (plus a smaller
// battle sweep — the densest bridge case at min 5 crossings) and assert the
// invariant on every bridge tile, both directly (count road-linked neighbours)
// and via the shared `assertMapInvariants` helper that map.js itself calls.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { generateMap, assertMapInvariants, findBridgeInvariantViolations } from '../src/map.js';
import { isBridge } from '../src/tiles.js';
import { hexKey, hexDistance, getNeighbors } from '../src/hex.js';

// Count a bridge's road entry/exit neighbours independently of map.js's own
// helper: a neighbour hex that is reciprocally linked via roadDirs.
function roadNeighbourCount(tile, tiles) {
  const bridgeKey = hexKey(tile.col, tile.row);
  let n = 0;
  for (const nb of getNeighbors(tile.col, tile.row)) {
    const nk = hexKey(nb.col, nb.row);
    if (!tile.roadDirs.has(nk)) continue;
    const nt = tiles.get(nk);
    assert.ok(nt, `bridge (${tile.col},${tile.row}) links to missing tile ${nk}`);
    assert.ok(nt.roadDirs.has(bridgeKey),
      `bridge (${tile.col},${tile.row}) link to ${nk} is not reciprocated`);
    n++;
  }
  // roadDirs should only ever contain neighbour keys — assert no stray links.
  assert.equal(n, tile.roadDirs.size,
    `bridge (${tile.col},${tile.row}) has roadDirs entries that are not neighbours`);
  return n;
}

describe('Bridge road-connection invariant', () => {
  const SWEEPS = [
    ['skirmish', 100],
    ['standard', 100],
    ['regional', 100],
    ['campaign', 100],
    ['battle',    30], // densest bridge preset (min 5 crossings); fewer seeds — 42×42 is slow
  ];

  for (const [size, seeds] of SWEEPS) {
    test(`${size}: every bridge connects exactly 2 road neighbours (${seeds} seeds)`, () => {
      let totalBridges = 0;
      for (let seed = 0; seed < seeds; seed++) {
        const { tiles } = generateMap(seed, size);
        for (const t of tiles.values()) {
          if (!isBridge(t)) continue;
          totalBridges++;
          const n = roadNeighbourCount(t, tiles);
          assert.equal(n, 2,
            `${size} seed=${seed}: bridge (${t.col},${t.row}) has ${n} road neighbours, must be 2`);
          // Each link must be an actual hex neighbour (distance 1).
          for (const nk of t.roadDirs) {
            const [nc, nr] = nk.split(',').map(Number);
            assert.equal(hexDistance(t.col, t.row, nc, nr), 1,
              `${size} seed=${seed}: bridge (${t.col},${t.row}) link ${nk} is not adjacent`);
          }
        }
      }
      // Sanity: the sweep actually exercised some bridges.
      assert.ok(totalBridges > 0, `${size}: expected at least one bridge across ${seeds} seeds`);
    });
  }

  test('assertMapInvariants passes for every preset / seed in the sweep', () => {
    for (const [size, seeds] of SWEEPS) {
      for (let seed = 0; seed < seeds; seed++) {
        const { tiles } = generateMap(seed, size);
        // Throws (with the offending tiles) on any violation.
        assert.doesNotThrow(() => assertMapInvariants(tiles),
          `${size} seed=${seed}: assertMapInvariants threw`);
        assert.deepEqual(findBridgeInvariantViolations(tiles), [],
          `${size} seed=${seed}: unexpected bridge invariant violations`);
      }
    }
  });

  test('assertMapInvariants throws loudly on a hand-broken bridge', () => {
    // Take a real generated bridge and corrupt it to a 3-link state, then
    // confirm the assertion fires — guards against the helper silently passing.
    let broken = null;
    for (let seed = 0; seed < 50 && !broken; seed++) {
      const { tiles } = generateMap(seed, 'standard');
      for (const t of tiles.values()) {
        if (!isBridge(t)) continue;
        // Inject a third (neighbour) link to force a violation.
        const nb = getNeighbors(t.col, t.row)
          .map(n => hexKey(n.col, n.row))
          .find(k => !t.roadDirs.has(k));
        t.roadDirs.add(nb);
        broken = tiles;
        break;
      }
    }
    assert.ok(broken, 'expected to find a bridge to corrupt');
    assert.throws(() => assertMapInvariants(broken), /Map invariant violation/);
  });
});
