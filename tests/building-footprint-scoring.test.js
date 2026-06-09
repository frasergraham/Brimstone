// Quality scoring for building-footprint direction (src/building-footprint.js).
// A footprint hex is fully impassable, so the chosen direction matters: a random
// pick can wall a river bank (starving a future bridge) or pinch a corridor.
// pickFootprintNeighbor now scores eligible candidates and prefers the best,
// with a seeded tie-break. These tests pin the three penalty behaviours and the
// "all candidates bad" fallback directly on bare tile-map fixtures.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { pickFootprintNeighbor, _localCutPenalty } from '../src/building-footprint.js';
import { Tile, TileType, PathType, BuildingType, StructureType, isRiver } from '../src/tiles.js';
import { setMapDimensions, hexKey, getNeighbors, hexDistance, hexRange } from '../src/hex.js';
import { rng } from '../src/map.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

// Bare all-grass tile map; also sets map dimensions so hexRange clips correctly.
function gridTiles(cols, rows) {
  setMapDimensions(cols, rows);
  const tiles = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) tiles.set(hexKey(c, r), new Tile(c, r, TileType.GRASS));
  }
  return tiles;
}

function makeRiver(tiles, col, row) {
  tiles.get(hexKey(col, row)).path = PathType.RIVER;
}

// Mark (col,row) as an impassable footprint hex of some entrance.
function makeFootprint(tiles, col, row, entKey = '0,0') {
  tiles.get(hexKey(col, row)).buildingFootprintOf = entKey;
}

// Mark (col,row) as a building entrance.
function makeEntrance(tiles, col, row) {
  const t = tiles.get(hexKey(col, row));
  t.structure = StructureType.BUILDING;
  t.building = BuildingType.HOUSE;
}

// Is the chosen hex hex-adjacent to a river tile?
function riverAdjacent(tiles, hex) {
  return getNeighbors(hex.col, hex.row).some(n => {
    const t = tiles.get(hexKey(n.col, n.row));
    return t && isRiver(t);
  });
}

// ── River-bank avoidance (problem #1) ────────────────────────────────────────

describe('footprint scoring — river-bank avoidance', () => {
  test('never claims a river-bank hex when a non-bank neighbour is eligible', () => {
    // Entrance (7,7) interior. A north-south river two columns west (col 5) makes
    // only the west-side candidate(s) river-adjacent; east candidates stay clean.
    const build = () => {
      const tiles = gridTiles(15, 15);
      for (let r = 5; r <= 9; r++) makeRiver(tiles, 5, r);
      return tiles;
    };
    const tiles = build();

    // At least one candidate is a bank and at least one is not — otherwise the
    // test proves nothing.
    const cands = getNeighbors(7, 7);
    const banks = cands.filter(c => riverAdjacent(tiles, c));
    assert.ok(banks.length >= 1 && banks.length < cands.length,
      `setup invariant: expected some-but-not-all bank candidates, got ${banks.length}/${cands.length}`);

    // Deterministic pick avoids the bank.
    const det = pickFootprintNeighbor(tiles, 7, 7, null);
    assert.ok(det && !riverAdjacent(tiles, det),
      `deterministic pick (${det?.col},${det?.row}) is on a river bank`);

    // Seeded picks across many streams never land on a bank either.
    for (let seed = 0; seed < 40; seed++) {
      const fresh = build();
      const chosen = pickFootprintNeighbor(fresh, 7, 7, rng(seed));
      assert.ok(chosen && !riverAdjacent(fresh, chosen),
        `seed ${seed}: pick (${chosen?.col},${chosen?.row}) is on a river bank`);
    }
  });
});

// ── Local cut-vertex penalty (problem #2, corridors) ─────────────────────────

describe('footprint scoring — local connectivity', () => {
  test('_localCutPenalty is 0 for an open hex', () => {
    const tiles = gridTiles(11, 11);
    assert.equal(_localCutPenalty(tiles, { col: 5, row: 5 }, '5,5'), 0);
  });

  test('_localCutPenalty is >=1 when the hex pinches two passable neighbours', () => {
    const tiles = gridTiles(13, 13);
    const C = { col: 6, row: 6 };
    const cKey = hexKey(C.col, C.row);
    // Two of C's neighbours that are NOT adjacent to each other (so the only
    // local connection between them would run through C).
    const nbrs = getNeighbors(C.col, C.row);
    let A = null, B = null;
    outer: for (const a of nbrs) {
      for (const b of nbrs) {
        if (hexDistance(a.col, a.row, b.col, b.row) >= 2) { A = a; B = b; break outer; }
      }
    }
    assert.ok(A && B, 'setup: found two non-adjacent neighbours of C');
    const keep = new Set([cKey, hexKey(A.col, A.row), hexKey(B.col, B.row)]);
    // Wall off the entire radius-2 disc except C, A, B — A and B can now only be
    // joined by transiting C, so blocking C disconnects them.
    for (const h of hexRange(C.col, C.row, 2)) {
      const k = hexKey(h.col, h.row);
      if (!keep.has(k)) tiles.get(k).path = PathType.RIVER;
    }
    assert.ok(_localCutPenalty(tiles, C, cKey) >= 1,
      'walled pinch should register as a local cut');
  });

});

// ── Clustering preference (problem #2, walls) ────────────────────────────────

describe('footprint scoring — clustering', () => {
  test('prefers a candidate that does not hug another building/footprint', () => {
    const tiles = gridTiles(15, 15);
    makeEntrance(tiles, 7, 7);
    // Make the west candidate (6,7) clustered: give it an adjacent footprint that
    // is neither the entrance nor another of (7,7)'s candidates.
    const west = { col: 6, row: 7 };
    const westNbrs = getNeighbors(west.col, west.row);
    const entCands = new Set(getNeighbors(7, 7).map(c => hexKey(c.col, c.row)));
    const stamp = westNbrs.find(n =>
      !(n.col === 7 && n.row === 7) && !entCands.has(hexKey(n.col, n.row)));
    assert.ok(stamp, 'setup: found a footprint slot adjacent only to the west candidate');
    makeFootprint(tiles, stamp.col, stamp.row, '88,88');

    // Every candidate touches the entrance building (uniform +cluster), but only
    // the west candidate also touches the stamped footprint — so the picker must
    // not pick it, nor any other candidate adjacent to that footprint.
    const stampKey = hexKey(stamp.col, stamp.row);
    const det = pickFootprintNeighbor(tiles, 7, 7, null);
    const detTouchesStamp = getNeighbors(det.col, det.row).some(n => hexKey(n.col, n.row) === stampKey);
    assert.ok(det && !(det.col === west.col && det.row === west.row) && !detTouchesStamp,
      `picker chose a clustered candidate (${det?.col},${det?.row})`);
  });
});

// ── "All candidates bad" fallback ────────────────────────────────────────────

describe('footprint scoring — fallback when every candidate is poor', () => {
  test('still returns a hex and consumes exactly one rand() draw', () => {
    // Ring of river at distance 2 makes EVERY distance-1 candidate a river bank,
    // so all share the max penalty — the building must still get a footprint.
    const tiles = gridTiles(15, 15);
    const E = { col: 7, row: 7 };
    const ring1 = new Set(hexRange(E.col, E.row, 1).map(h => hexKey(h.col, h.row)));
    for (const h of hexRange(E.col, E.row, 2)) {
      const k = hexKey(h.col, h.row);
      if (!ring1.has(k)) tiles.get(k).path = PathType.RIVER;  // distance-2 ring only
    }
    // Sanity: every candidate is now a bank.
    const cands = getNeighbors(E.col, E.row);
    assert.ok(cands.every(c => riverAdjacent(tiles, c)), 'setup: all candidates are banks');

    let calls = 0;
    const countingRand = () => { calls++; return 0.3; };
    const chosen = pickFootprintNeighbor(tiles, E.col, E.row, countingRand);
    assert.ok(chosen, 'fallback must still place a footprint (never null when eligible)');
    assert.equal(calls, 1, 'exactly one rand() draw consumed, matching the old stream');
  });

  test('returns null only when there is no eligible neighbour at all', () => {
    // Surround the entrance entirely with river so nothing is eligible.
    const tiles = gridTiles(11, 11);
    const E = { col: 5, row: 5 };
    for (const n of getNeighbors(E.col, E.row)) makeRiver(tiles, n.col, n.row);
    assert.equal(pickFootprintNeighbor(tiles, E.col, E.row, null), null);
  });
});
