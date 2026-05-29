// P3a: line of sight follows the same entrance/footprint asymmetry as movement.
//   • ENTRANCE hex (isBuildingEntrance) → TRANSPARENT. A unit on it, or behind
//     it relative to a viewer, is visible. It is just the threshold/front door.
//   • FOOTPRINT hex (isBuildingFootprint) → BLOCKS LOS. It is the building wall.
//   • Forest cover still blocks (unchanged regression guard).
// The blocker predicate lives in src/tiles.js (`blocksLineOfSight`) and is
// shared by hasLineOfSight / computeLineOfSight / getVisiblePositions, so the
// 2D & 3D renderers, fog, and both AIs all observe the same rule.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Phase } from '../src/game.js';
import {
  hasLineOfSight, computeLineOfSight, getVisiblePositions,
} from '../src/actions.js';
import { hexKey, hexLine, setMapDimensions } from '../src/hex.js';
import { TileType, BuildingType, StructureType, blocksLineOfSight } from '../src/tiles.js';

setMapDimensions(40, 22);

// ── tile fixtures (minimal duck-typed tiles, matching los-fog.test.js) ──────

function grassTile(col, row) {
  return { col, row, base: TileType.GRASS, structure: null, path: null };
}
function forestTile(col, row) {
  return { col, row, base: TileType.FOREST, structure: null, path: null };
}
function entranceTile(col, row, fpKey, b = BuildingType.INN) {
  return {
    col, row,
    base: TileType.DIRT,
    structure: StructureType.BUILDING,
    building: b,
    path: null,
    footprintHexes: [fpKey],
    buildingFootprintOf: null,
  };
}
function footprintTile(col, row, entKey) {
  return {
    col, row,
    base: TileType.GRASS,
    structure: null,
    path: null,
    building: null,
    footprintHexes: [],
    buildingFootprintOf: entKey,
  };
}

function rectGrass(cols, rows) {
  const tiles = new Map();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      tiles.set(hexKey(c, r), grassTile(c, r));
    }
  }
  return tiles;
}

function entity(id, owner, col, row, opts = {}) {
  const abilities = new Set(opts.abilities ?? []);
  return {
    id, owner, col, row,
    alive: opts.alive ?? true,
    hasAbility(name) { return abilities.has(name); },
  };
}

// Place `make(col,row)` on the first intermediate hex of the A→B line and
// return that line. A and B are 3 apart so exactly one intermediate matters.
function placeOnMiddle(tiles, ax, ay, bx, by, make) {
  const line = hexLine(ax, ay, bx, by);
  const mid = line[1];
  tiles.set(hexKey(mid.col, mid.row), make(mid.col, mid.row));
  return { line, mid };
}

// ── 1. predicate unit ───────────────────────────────────────────────────────

describe('blocksLineOfSight predicate', () => {
  test('footprint and forest block; entrance, grass, null do not', () => {
    assert.equal(blocksLineOfSight(footprintTile(1, 1, '0,0')), true);
    assert.equal(blocksLineOfSight(forestTile(1, 1)), true);
    assert.equal(blocksLineOfSight(entranceTile(1, 1, '2,2')), false);
    assert.equal(blocksLineOfSight(grassTile(1, 1)), false);
    assert.equal(blocksLineOfSight(null), false);
    assert.equal(blocksLineOfSight(undefined), false);
  });
});

// ── 2. hasLineOfSight through each terrain ──────────────────────────────────

describe('LOS through entrance vs footprint vs forest', () => {
  test('through an ENTRANCE: A can see B (entrance transparent)', () => {
    const tiles = rectGrass(13, 13);
    placeOnMiddle(tiles, 5, 5, 5, 2, (c, r) => entranceTile(c, r, hexKey(0, 0)));
    assert.equal(hasLineOfSight({ tiles }, 5, 5, 5, 2), true);
  });

  test('through a FOOTPRINT: A cannot see B (wall blocks)', () => {
    const tiles = rectGrass(13, 13);
    placeOnMiddle(tiles, 5, 5, 5, 2, (c, r) => footprintTile(c, r, hexKey(0, 0)));
    assert.equal(hasLineOfSight({ tiles }, 5, 5, 5, 2), false);
  });

  test('through a FOREST: A cannot see B (regression — forest still blocks)', () => {
    const tiles = rectGrass(13, 13);
    placeOnMiddle(tiles, 5, 5, 5, 2, (c, r) => forestTile(c, r));
    assert.equal(hasLineOfSight({ tiles }, 5, 5, 5, 2), false);
  });
});

// ── 3. a unit ON an entrance hex sees out ───────────────────────────────────

describe('a unit standing on an entrance hex can see out', () => {
  test('entrance is the origin (transparent) — distant clear tile is visible', () => {
    const tiles = rectGrass(13, 13);
    // The viewer's own hex is a building entrance; the rest of the line is open.
    tiles.set(hexKey(5, 5), entranceTile(5, 5, hexKey(0, 0)));
    const state = {
      phase: Phase.DAY,
      tiles,
      entities: [entity(1, 'hero', 5, 5)],
    };
    const set = computeLineOfSight(state, 'hero');
    assert.ok(set.has(hexKey(5, 5)), 'own entrance hex is visible');
    assert.ok(set.has(hexKey(5, 1)), '4 hexes out on a clear line IS visible');
  });
});

// ── 4. endpoint exemption (clear line) ──────────────────────────────────────

describe('endpoint exemption still holds', () => {
  test('viewer to a distant tile on a fully clear line is visible', () => {
    const tiles = rectGrass(13, 13);
    assert.equal(hasLineOfSight({ tiles }, 2, 6, 6, 6), true);
  });

  test('a footprint sitting ON an endpoint does not block (endpoints exempt)', () => {
    const tiles = rectGrass(13, 13);
    // Target endpoint itself is a footprint; the line between is clear.
    tiles.set(hexKey(5, 2), footprintTile(5, 2, hexKey(0, 0)));
    assert.equal(hasLineOfSight({ tiles }, 5, 5, 5, 2), true,
      'a blocker on the endpoint is exempt — only intermediates block');
  });
});

// ── 5. AI consumption via getVisiblePositions ───────────────────────────────

describe('AI sight respects the entrance/footprint asymmetry', () => {
  // getVisiblePositions(state, viewer) is what hero-ai-engine and the witch AI
  // consume (through computeLineOfSight). A hidden enemy behind a wall must not
  // surface; one behind a mere threshold must.
  function aiState(viewer, target, midMake) {
    const tiles = rectGrass(13, 13);
    // viewer at (5,5), target at (5,2); intermediate (5,4) gets midMake.
    placeOnMiddle(tiles, 5, 5, 5, 2, midMake);
    return {
      phase: Phase.DAY, // hero range 6, witch fixed 5 — both reach distance 3
      tiles,
      entities: [
        entity(1, viewer, 5, 5),
        entity(2, target, 5, 2),
      ],
    };
  }

  test('witch AI: hero behind a FOOTPRINT is NOT visible', () => {
    const st = aiState('witch', 'hero', (c, r) => footprintTile(c, r, hexKey(0, 0)));
    const vis = getVisiblePositions(st, 'witch');
    assert.ok(!vis.has(hexKey(5, 2)), 'hero hidden behind the wall');
  });

  test('witch AI: hero behind an ENTRANCE (only) IS visible', () => {
    const st = aiState('witch', 'hero', (c, r) => entranceTile(c, r, hexKey(0, 0)));
    const vis = getVisiblePositions(st, 'witch');
    assert.ok(vis.has(hexKey(5, 2)), 'hero visible through the threshold');
  });

  test('hero AI: witch behind a FOOTPRINT is NOT visible', () => {
    const st = aiState('hero', 'witch', (c, r) => footprintTile(c, r, hexKey(0, 0)));
    const vis = getVisiblePositions(st, 'hero');
    assert.ok(!vis.has(hexKey(5, 2)), 'witch hidden behind the wall');
  });

  test('hero AI: witch behind an ENTRANCE (only) IS visible', () => {
    const st = aiState('hero', 'witch', (c, r) => entranceTile(c, r, hexKey(0, 0)));
    const vis = getVisiblePositions(st, 'hero');
    assert.ok(vis.has(hexKey(5, 2)), 'witch visible through the threshold');
  });
});
