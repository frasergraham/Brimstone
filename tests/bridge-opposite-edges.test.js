// Bridge opposite-edge invariant: a bridge crossing must ENTER and EXIT on
// OPPOSITE hex edges so it spans straight across the river, rather than bending
// between two adjacent edges. Pointy-top odd-r hex has 6 edge directions; the
// edge opposite direction `d` is `(d + 3) % 6`. The 3D bridge model
// (`bridgeRotationY` in renderer-3d.js) derives the plank's long axis from the
// difference of the two road-exit unit vectors — a non-opposite (adjacent-edge)
// pair yields a skewed/bent plank instead of a clean span.
//
// This is the regression suite for that fix: a broad seed sweep across every
// map preset confirms every generated bridge is a straight, opposite-edge span,
// and that the opposite-edge constraint never starves the map below
// `minBridges`. A contrived-corruption test proves the audit helper actually
// fires on a bent bridge (so the sweep can't pass for the wrong reason).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateMap,
  findBridgeInvariantViolations,
  assertMapInvariants,
  MAP_SIZES,
} from '../src/map.js';
import { isBridge } from '../src/tiles.js';
import { hexKey, getNeighbors, neighborDirIndex } from '../src/hex.js';

const SIZES = ['skirmish', 'standard', 'regional', 'campaign'];

// Direct opposite-edge check on a tile's two roadDirs links, independent of the
// generator's own helper — so the test can't pass merely because the helper is
// a no-op.
function bridgeIsStraight(tile) {
  const links = [...tile.roadDirs];
  if (links.length !== 2) return false;
  const [ac, ar] = links[0].split(',').map(Number);
  const [bc, br] = links[1].split(',').map(Number);
  const da = neighborDirIndex(tile.col, tile.row, ac, ar);
  const db = neighborDirIndex(tile.col, tile.row, bc, br);
  if (da < 0 || db < 0) return false;
  return (da + 3) % 6 === db;
}

describe('Bridge opposite-edge invariant — generator sweep', () => {
  for (const size of SIZES) {
    test(`${size}: 200-seed sweep, every bridge spans opposite (straight) edges`, () => {
      let totalBridges = 0;
      let bentBridges = 0;
      for (let seed = 0; seed < 200; seed++) {
        const { tiles } = generateMap(seed, size);
        // The hard invariant (now includes the opposite-edge check) must be
        // clean for every generated map.
        const violations = findBridgeInvariantViolations(tiles);
        assert.deepEqual(violations, [],
          `${size} seed=${seed}: ${violations.length} violation(s) — ` +
          violations.map(v => `(${v.col},${v.row}): ${v.reason}`).join('; '));
        for (const t of tiles.values()) {
          if (!isBridge(t)) continue;
          totalBridges++;
          if (!bridgeIsStraight(t)) {
            bentBridges++;
          }
        }
      }
      assert.equal(bentBridges, 0,
        `${size}: ${bentBridges}/${totalBridges} bridges are bent (non-opposite edges)`);
      // Sanity: the sweep actually exercised bridges.
      assert.ok(totalBridges > 0,
        `${size}: 200 seeds produced 0 bridges — sweep didn't exercise the invariant`);
    });
  }

  test('battle: 30-seed sweep, every bridge spans opposite (straight) edges', () => {
    let totalBridges = 0, bentBridges = 0;
    for (let seed = 0; seed < 30; seed++) {
      const { tiles } = generateMap(seed, 'battle');
      const violations = findBridgeInvariantViolations(tiles);
      assert.deepEqual(violations, [],
        `battle seed=${seed}: ${violations.length} violation(s) — ` +
        violations.map(v => `(${v.col},${v.row}): ${v.reason}`).join('; '));
      for (const t of tiles.values()) {
        if (!isBridge(t)) continue;
        totalBridges++;
        if (!bridgeIsStraight(t)) bentBridges++;
      }
    }
    assert.equal(bentBridges, 0,
      `battle: ${bentBridges}/${totalBridges} bridges are bent`);
    assert.ok(totalBridges > 0, 'battle: 30 seeds produced 0 bridges');
  });

  test('opposite-edge constraint never starves below minBridges', () => {
    // The straight-span constraint could in principle reject a crossing and
    // leave the map short of bridges. Confirm `minBridges` still holds across a
    // seed sweep for every preset.
    for (const size of SIZES) {
      const cfg = MAP_SIZES[size];
      const min = cfg.minBridges ?? 1;
      for (let seed = 0; seed < 60; seed++) {
        const { tiles } = generateMap(seed, size);
        let bridges = 0;
        for (const t of tiles.values()) if (isBridge(t)) bridges++;
        assert.ok(bridges >= min,
          `${size} seed=${seed}: opposite-edge constraint left ${bridges} bridges, expected ≥ ${min}`);
      }
    }
  });

  test('generateMap() throws on a bent bridge (post-pass)', () => {
    // The opposite-edge check is folded into assertMapInvariants(), called at
    // the end of generateMap. A regression that emits a bent bridge would crash
    // here rather than ship a skewed plank.
    for (const size of SIZES) {
      for (let seed = 0; seed < 50; seed++) {
        assert.doesNotThrow(() => generateMap(seed, size),
          `${size} seed=${seed}: generateMap threw — bridge audit regression`);
      }
    }
  });
});

describe('Bridge opposite-edge invariant — audit helper catches a bent bridge', () => {
  function firstBridge() {
    for (let seed = 0; seed < 50; seed++) {
      const { tiles } = generateMap(seed, 'standard');
      for (const t of tiles.values()) if (isBridge(t)) return { tiles, bridge: t, seed };
    }
    return null;
  }

  test('a bridge re-linked to two adjacent edges is reported as a bent span', () => {
    const found = firstBridge();
    assert.ok(found, 'no bridge produced in 50 standard seeds — sweep is broken');
    const { tiles, bridge } = found;

    // Find two adjacent-edge neighbours of the bridge that exist as tiles.
    // Adjacent edges differ by ±1 (mod 6) in direction index.
    const nbrs = getNeighbors(bridge.col, bridge.row)
      .map(n => ({ ...n, dir: neighborDirIndex(bridge.col, bridge.row, n.col, n.row), key: hexKey(n.col, n.row) }))
      .filter(n => tiles.has(n.key));
    let a = null, b = null;
    outer: for (const x of nbrs) {
      for (const y of nbrs) {
        if (x.key === y.key) continue;
        const diff = ((x.dir - y.dir) % 6 + 6) % 6;
        if (diff === 1 || diff === 5) { a = x; b = y; break outer; }
      }
    }
    assert.ok(a && b, 'expected two adjacent-edge neighbours to corrupt with');

    // Replace the bridge's links with the adjacent-edge pair (reciprocated, so
    // only the opposite-edge check fires — not the reciprocity/neighbour ones).
    const bridgeKey = hexKey(bridge.col, bridge.row);
    for (const k of [...bridge.roadDirs]) {
      bridge.roadDirs.delete(k);
      tiles.get(k)?.roadDirs.delete(bridgeKey);
    }
    for (const x of [a, b]) {
      bridge.roadDirs.add(x.key);
      tiles.get(x.key)?.roadDirs.add(bridgeKey);
    }

    const v = findBridgeInvariantViolations(tiles);
    assert.ok(v.some(x => /opposite edges/.test(x.reason)),
      `expected a bent-span violation; got ${JSON.stringify(v)}`);
    assert.throws(() => assertMapInvariants(tiles), /Map invariant violation/);
  });
});
