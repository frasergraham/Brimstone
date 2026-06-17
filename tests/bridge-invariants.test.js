// Hard generator invariant: every BRIDGE tile must have EXACTLY two reciprocal
// road links, one entering and one exiting, with the two links on opposite
// river banks. The 3D bridge model (`bridgeRotationY` in renderer-3d.js)
// orients its plank from `roadDirs` — 1, 3 or 4 links render a broken /
// floating span.
//
// This file is the regression suite for that invariant: a broad seed sweep
// across every map preset confirms the procedural generator can never ship a
// bad bridge, and a pair of contrived-corruption tests proves the audit
// helpers (`findBridgeInvariantViolations` / `assertMapInvariants`) actually
// fire on bad input. We deliberately overlap with `tests/map-bridges.test.js`
// — that file locks down the same property at 100 seeds × 4 presets; this one
// pushes the scan wider (200 seeds × 4 presets + battle), guards the new
// throwing post-pass in `generateMap`, and exercises a few hand-broken
// topologies to keep the audit honest.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import {
  generateMap,
  findBridgeInvariantViolations,
  assertMapInvariants,
  MAP_SIZES,
} from '../src/map.js';
import { isBridge } from '../src/tiles.js';
import { hexKey, getNeighbors, setMapDimensions } from '../src/hex.js';

const SIZES = ['skirmish', 'standard', 'regional', 'campaign'];

describe('Bridge invariant — generator sweep', () => {
  // The four standard presets, 200 seeds each — well past the range the
  // operator-reported reproductions live in. If a future change reintroduces
  // an audit hole, this is where it will fall over first.
  for (const size of SIZES) {
    test(`${size}: 200-seed sweep, every bridge has 2 reciprocal opposite-bank links`, () => {
      let totalBridges = 0;
      for (let seed = 0; seed < 200; seed++) {
        const { tiles } = generateMap(seed, size);
        const violations = findBridgeInvariantViolations(tiles);
        assert.deepEqual(violations, [],
          `${size} seed=${seed}: ${violations.length} violation(s) — ` +
          violations.map(v => `(${v.col},${v.row}): ${v.reason}`).join('; '));
        for (const t of tiles.values()) if (isBridge(t)) totalBridges++;
      }
      // Sanity: the sweep actually exercised bridges (otherwise the invariant
      // check is vacuous).
      assert.ok(totalBridges > 0,
        `${size}: 200 seeds produced 0 bridges — sweep didn't exercise the invariant`);
    });
  }

  // Battle is the densest bridge preset (minBridges=5, bridgeMax=10) and 42×42
  // is slow to generate, so we run a smaller-but-still-meaningful sweep here.
  test('battle: 30-seed sweep, every bridge has 2 reciprocal opposite-bank links', () => {
    let totalBridges = 0;
    for (let seed = 0; seed < 30; seed++) {
      const { tiles } = generateMap(seed, 'battle');
      const violations = findBridgeInvariantViolations(tiles);
      assert.deepEqual(violations, [],
        `battle seed=${seed}: ${violations.length} violation(s) — ` +
        violations.map(v => `(${v.col},${v.row}): ${v.reason}`).join('; '));
      for (const t of tiles.values()) if (isBridge(t)) totalBridges++;
    }
    assert.ok(totalBridges > 0,
      `battle: 30 seeds produced 0 bridges — sweep didn't exercise the invariant`);
  });

  test('generateMap() now throws on any bridge invariant violation (post-pass)', () => {
    // The post-pass at the end of step 5 is `assertMapInvariants(tiles)` —
    // a regression that lets a bad bridge through would crash here, not be
    // silently logged. Run a small sweep that exercises that throw path
    // without relying on `findBridgeInvariantViolations` returning [].
    for (const size of SIZES) {
      for (let seed = 0; seed < 50; seed++) {
        assert.doesNotThrow(() => generateMap(seed, size),
          `${size} seed=${seed}: generateMap threw — bridge audit regression`);
      }
    }
  });

  test('every bridge also has minBridges-floor preserved (no over-pruning)', () => {
    // The audit reverts one-sided/unreached bridges to river. We need to make
    // sure the cleanup never strips the map below `minBridges`. (If it does,
    // playability breaks — both banks may end up disconnected.) This is the
    // companion to `tests/map-generation.test.js > bridge count is within
    // configured bounds` but specifically checks the post-audit invariant.
    for (const size of SIZES) {
      const cfg = MAP_SIZES[size];
      const min = cfg.minBridges ?? 1;
      for (let seed = 0; seed < 50; seed++) {
        const { tiles } = generateMap(seed, size);
        let bridges = 0;
        for (const t of tiles.values()) if (isBridge(t)) bridges++;
        assert.ok(bridges >= min,
          `${size} seed=${seed}: audit left ${bridges} bridges, expected ≥ ${min}`);
      }
    }
  });
});

describe('Bridge invariant — audit helpers catch contrived breakage', () => {
  // Find any real generated bridge, corrupt it in a particular way, then
  // assert the audit helpers actually fire. Without these, the sweep tests
  // above could pass for the wrong reason (e.g. helper silently returns []).
  function firstBridge() {
    for (let seed = 0; seed < 50; seed++) {
      const { tiles } = generateMap(seed, 'standard');
      for (const t of tiles.values()) if (isBridge(t)) return { tiles, bridge: t, seed };
    }
    return null;
  }

  test('a 3-link bridge (one extra neighbour) is reported as a violation', () => {
    const found = firstBridge();
    assert.ok(found, 'no bridge produced in 50 standard seeds — sweep is broken');
    const { tiles, bridge } = found;
    const extra = getNeighbors(bridge.col, bridge.row)
      .map(n => hexKey(n.col, n.row))
      .find(k => !bridge.roadDirs.has(k));
    assert.ok(extra, 'no spare neighbour to corrupt with');
    bridge.roadDirs.add(extra);
    const v = findBridgeInvariantViolations(tiles);
    assert.equal(v.length, 1,
      `expected 1 violation after corruption, got ${v.length}`);
    assert.match(v[0].reason, /3 road links/);
    assert.throws(() => assertMapInvariants(tiles), /Map invariant violation/);
  });

  test('a 1-link bridge (missing a side) is reported as a violation', () => {
    const found = firstBridge();
    assert.ok(found, 'no bridge produced in 50 standard seeds — sweep is broken');
    const { tiles, bridge } = found;
    // Drop one of the two reciprocal links so the bridge degenerates to a
    // single approach. We mutate BOTH sides so the helper's reciprocity check
    // doesn't fire first; we want the bare degree-1 violation.
    const dropKey = [...bridge.roadDirs][0];
    bridge.roadDirs.delete(dropKey);
    tiles.get(dropKey)?.roadDirs.delete(hexKey(bridge.col, bridge.row));
    const v = findBridgeInvariantViolations(tiles);
    assert.equal(v.length, 1,
      `expected 1 violation after corruption, got ${v.length}`);
    assert.match(v[0].reason, /1 road links/);
    assert.throws(() => assertMapInvariants(tiles), /Map invariant violation/);
  });

  test('a non-neighbour road link is reported as a violation', () => {
    const found = firstBridge();
    assert.ok(found, 'no bridge produced in 50 standard seeds — sweep is broken');
    const { tiles, bridge } = found;
    // Replace one real link with a non-neighbour key — the audit must catch
    // both the missing-neighbour case AND the missing-reciprocation case.
    const realLink = [...bridge.roadDirs][0];
    bridge.roadDirs.delete(realLink);
    tiles.get(realLink)?.roadDirs.delete(hexKey(bridge.col, bridge.row));
    // Pick a far-away tile that exists but is not adjacent to the bridge.
    const farKey = [...tiles.keys()].find(k => {
      const [c, r] = k.split(',').map(Number);
      if (c === bridge.col && r === bridge.row) return false;
      // not a hex-neighbour and not already linked
      const nbs = getNeighbors(bridge.col, bridge.row).map(n => hexKey(n.col, n.row));
      return !nbs.includes(k);
    });
    assert.ok(farKey, 'expected a non-neighbour tile to corrupt with');
    bridge.roadDirs.add(farKey);
    const v = findBridgeInvariantViolations(tiles);
    assert.ok(v.length >= 1, 'expected at least one violation after corruption');
    // The corruption is degree 2 + one non-neighbour — the helper should flag
    // the non-neighbour link explicitly.
    assert.ok(v.some(x => /not a neighbour/.test(x.reason)),
      `expected a 'not a neighbour' reason; got ${JSON.stringify(v)}`);
    assert.throws(() => assertMapInvariants(tiles), /Map invariant violation/);
  });
});
