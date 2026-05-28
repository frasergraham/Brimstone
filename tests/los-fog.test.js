// Line-of-sight fog of war — verifies the centralised LOS computation in
// src/actions.js (`computeLineOfSight`, `hasLineOfSight`).
//
// Spec:
//   • Hero LOS distance: DAY=6, DAWN/DUSK=4, NIGHT=3
//   • Witch LOS distance: 5 at all phases
//   • Buildings and forest tiles BLOCK line of sight beyond them; the
//     blocking tile itself IS visible.
//   • Multiple units' LOS unions correctly.
//   • Ability sight bonuses (SCOUT) stack additively per unit.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Phase } from '../src/game.js';
import { computeLineOfSight, hasLineOfSight } from '../src/actions.js';
import { hexKey, hexLine, setMapDimensions } from '../src/hex.js';
import { TileType, BuildingType, StructureType, PathType } from '../src/tiles.js';
import { getFaction } from '../src/factions.js';

// LOS tests use up to 40×17 grids; expand MAP_COLS/ROWS so `hexRange`
// (which filters candidates by global map bounds) doesn't silently clip
// our fixture maps. The globals are shared module state — that's how the
// renderer-3d-atmosphere tests also use larger grids.
setMapDimensions(40, 22);

// ── tile / state fixtures ───────────────────────────────────────────────────

function grassTile(col, row) {
  return { col, row, base: TileType.GRASS, structure: null, path: null };
}
function forestTile(col, row) {
  return { col, row, base: TileType.FOREST, structure: null, path: null };
}
function buildingTile(col, row, b = BuildingType.INN) {
  return {
    col, row,
    base: TileType.DIRT,
    structure: StructureType.BUILDING,
    building: b,
    path: null,
  };
}
// Forest base under a road path — still blocks LOS per the operator-locked
// `isForestCover` rule (base material wins regardless of overlay).
function roadOnForestTile(col, row) {
  return {
    col, row,
    base: TileType.FOREST,
    structure: null,
    path: PathType.ROAD,
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
  // Minimal duck-typed entity. We only need .alive, .owner, .col, .row,
  // and (optionally) a hasAbility() hook so sightRangeForEntity can read
  // scout. Faction-side bonuses come from `owner` via `concreteFactionOf`.
  const abilities = new Set(opts.abilities ?? []);
  return {
    id, owner, col, row,
    alive: opts.alive ?? true,
    hasAbility(name) { return abilities.has(name); },
  };
}

// ── 1. Phase distances produce correct base ranges per faction ──────────────

describe('LOS fog — base phase ranges', () => {
  test('hero sees the full 6-hex disc on open ground at DAY', () => {
    const state = {
      phase: Phase.DAY,
      tiles: rectGrass(17, 17),
      entities: [entity(1, 'hero', 8, 8)],
    };
    const set = computeLineOfSight(state, 'hero');
    // radius 6 disc = 1+6+12+18+24+30+36 = 127
    assert.equal(set.size, 127);
    assert.ok(set.has(hexKey(14, 8)), 'hex 6 away east IS visible');
    assert.ok(!set.has(hexKey(15, 8)), 'hex 7 away east is NOT visible');
  });

  test('hero NIGHT range is 3 (disc = 37)', () => {
    const state = {
      phase: Phase.NIGHT,
      tiles: rectGrass(15, 15),
      entities: [entity(1, 'hero', 7, 7)],
    };
    const set = computeLineOfSight(state, 'hero');
    assert.equal(set.size, 37);
    assert.ok(set.has(hexKey(10, 7)), '3 east IS visible at NIGHT');
    assert.ok(!set.has(hexKey(11, 7)), '4 east NOT visible at NIGHT');
  });

  test('hero DAWN range is 4 (disc = 61)', () => {
    const state = {
      phase: Phase.DAWN,
      tiles: rectGrass(15, 15),
      entities: [entity(1, 'hero', 7, 7)],
    };
    const set = computeLineOfSight(state, 'hero');
    // radius 4 disc = 1+6+12+18+24 = 61
    assert.equal(set.size, 61);
  });

  test('hero DUSK range is 4 (same as DAWN)', () => {
    const state = {
      phase: Phase.DUSK,
      tiles: rectGrass(15, 15),
      entities: [entity(1, 'hero', 7, 7)],
    };
    assert.equal(computeLineOfSight(state, 'hero').size, 61);
  });

  test('witch sees fixed 5-hex disc regardless of phase', () => {
    for (const phase of [Phase.DAY, Phase.DAWN, Phase.DUSK, Phase.NIGHT]) {
      const state = {
        phase,
        tiles: rectGrass(15, 15),
        entities: [entity(1, 'witch', 7, 7)],
      };
      // radius 5 disc = 1+6+12+18+24+30 = 91
      assert.equal(
        computeLineOfSight(state, 'witch').size, 91,
        `witch range at ${phase}`,
      );
    }
  });

  test('faction defaults match the spec table', () => {
    const hero = getFaction('hero');
    const witch = getFaction('witch');
    assert.equal(hero.getSightRange(Phase.DAY), 6);
    assert.equal(hero.getSightRange(Phase.DAWN), 4);
    assert.equal(hero.getSightRange(Phase.DUSK), 4);
    assert.equal(hero.getSightRange(Phase.NIGHT), 3);
    assert.equal(witch.getSightRange(Phase.DAY), 5);
    assert.equal(witch.getSightRange(Phase.NIGHT), 5);
  });
});

// ── 2. Buildings and forests block LOS past themselves ──────────────────────

describe('LOS fog — terrain blockers', () => {
  test('a building between unit and target blocks vision past it', () => {
    // Hero at (5,5), target at (5,2), distance 3. Place a building on the
    // intermediate hex (along the column).
    const tiles = rectGrass(13, 13);
    // Find the intermediate hex on the line so we don't guess.
    const line = hexLine(5, 5, 5, 2);
    assert.equal(line.length, 4, 'line should be 4 hexes inclusive');
    const blocker = line[1]; // first intermediate
    tiles.set(hexKey(blocker.col, blocker.row), buildingTile(blocker.col, blocker.row));

    const state = {
      phase: Phase.DAY,
      tiles,
      entities: [entity(1, 'hero', 5, 5)],
    };
    const set = computeLineOfSight(state, 'hero');
    assert.ok(set.has(hexKey(blocker.col, blocker.row)),
      'blocking building IS visible');
    assert.ok(!set.has(hexKey(5, 2)),
      'hex past the blocker is NOT visible');
  });

  test('a forest tile between unit and target blocks vision past it', () => {
    const tiles = rectGrass(13, 13);
    const line = hexLine(5, 5, 5, 2);
    const blocker = line[1];
    tiles.set(hexKey(blocker.col, blocker.row), forestTile(blocker.col, blocker.row));

    const state = {
      phase: Phase.DAY,
      tiles,
      entities: [entity(1, 'hero', 5, 5)],
    };
    const set = computeLineOfSight(state, 'hero');
    assert.ok(set.has(hexKey(blocker.col, blocker.row)), 'forest IS visible');
    assert.ok(!set.has(hexKey(5, 2)), 'hex past forest NOT visible');
  });

  test('forest base under a road still blocks LOS (operator-locked behaviour)', () => {
    const tiles = rectGrass(13, 13);
    const line = hexLine(5, 5, 5, 2);
    const blocker = line[1];
    tiles.set(hexKey(blocker.col, blocker.row),
      roadOnForestTile(blocker.col, blocker.row));

    const state = {
      phase: Phase.DAY,
      tiles,
      entities: [entity(1, 'hero', 5, 5)],
    };
    const set = computeLineOfSight(state, 'hero');
    assert.ok(!set.has(hexKey(5, 2)), 'forest base blocks LOS even with road overlay');
  });

  test('open grass between unit and target preserves vision', () => {
    const state = {
      phase: Phase.DAY,
      tiles: rectGrass(13, 13),
      entities: [entity(1, 'hero', 5, 5)],
    };
    const set = computeLineOfSight(state, 'hero');
    assert.ok(set.has(hexKey(5, 2)), 'target with open path IS visible');
  });

  test('hasLineOfSight: clear line returns true, blocked line returns false', () => {
    const tiles = rectGrass(13, 13);
    const line = hexLine(2, 2, 6, 2);
    // Block the middle hex
    const mid = line[Math.floor(line.length / 2)];
    tiles.set(hexKey(mid.col, mid.row), forestTile(mid.col, mid.row));

    const state = { tiles };
    assert.equal(hasLineOfSight(state, 2, 2, 4, 2), true,
      'short line (no blocker between) is clear');
    assert.equal(hasLineOfSight(state, 2, 2, 6, 2), false,
      'long line crossing a forest is blocked');
  });

  test('hasLineOfSight: endpoints are never themselves blockers', () => {
    const tiles = rectGrass(7, 7);
    // Source tile is a building — still reports visible to itself.
    tiles.set(hexKey(3, 3), buildingTile(3, 3));
    tiles.set(hexKey(3, 5), buildingTile(3, 5));
    const state = { tiles };
    // Same hex
    assert.equal(hasLineOfSight(state, 3, 3, 3, 3), true);
    // Adjacent — no intermediate hex possible
    assert.equal(hasLineOfSight(state, 3, 3, 3, 4), true);
    // Distance 2 line, endpoint is a building but no intermediate blocker
    assert.equal(hasLineOfSight(state, 3, 3, 3, 5), true);
  });
});

// ── 3. Multiple units' LOS unions correctly ─────────────────────────────────

describe('LOS fog — multi-unit union', () => {
  test('two heroes far apart cover disjoint regions; their union is added', () => {
    // Place both heroes inset from edges so each disc lands fully on-map.
    const state = {
      phase: Phase.NIGHT, // small disc per unit (range 3)
      tiles: rectGrass(25, 12),
      entities: [
        entity(1, 'hero', 5, 5),
        entity(2, 'hero', 19, 5),
      ],
    };
    const set = computeLineOfSight(state, 'hero');
    assert.ok(set.has(hexKey(5, 5)), 'first hero own hex');
    assert.ok(set.has(hexKey(19, 5)), 'second hero own hex');
    assert.ok(!set.has(hexKey(12, 5)), 'neither hero can see midpoint');
    // No double-count: 2× 37-disc = 74 if disjoint.
    assert.equal(set.size, 74);
  });

  test('opposing-faction units do not contribute to the observer set', () => {
    const state = {
      phase: Phase.DAY,
      tiles: rectGrass(15, 15),
      entities: [
        entity(1, 'hero', 2, 2),
        entity(2, 'witch', 12, 12),
      ],
    };
    const set = computeLineOfSight(state, 'hero');
    assert.ok(set.has(hexKey(2, 2)));
    assert.ok(!set.has(hexKey(12, 12)), 'witch own hex NOT folded into hero set');
  });

  test('dead units do not contribute', () => {
    const state = {
      phase: Phase.DAY,
      tiles: rectGrass(15, 15),
      entities: [entity(1, 'hero', 7, 7, { alive: false })],
    };
    assert.equal(computeLineOfSight(state, 'hero').size, 0);
  });
});

// ── 4. Ability sight bonus stacks additively ────────────────────────────────

describe('LOS fog — ability sight bonus', () => {
  test('a SCOUT survivor sees one hex further than a non-scout', () => {
    const state = {
      phase: Phase.DAY,
      tiles: rectGrass(17, 17),
      entities: [entity(1, 'hero', 8, 8, { abilities: ['scout'] })],
    };
    const set = computeLineOfSight(state, 'hero');
    // Range 6 + 1 = 7 → disc = 1+6+12+18+24+30+36+42 = 169
    assert.equal(set.size, 169);
    assert.ok(set.has(hexKey(15, 8)), '7 east IS visible with scout');
  });

  test('ability bonus is per-unit (only the scout, not its allies, gets +1)', () => {
    // Two heroes placed so their range-6 discs don't overlap. Scout adds 1
    // tile to ONE disc only — so the total = 127 + (127 + 19) = 273.
    // (Hex disc radius 7 minus disc radius 6 = 42 new perimeter hexes;
    //  here we just verify the scout's perimeter grew, not the partner's.)
    const state = {
      phase: Phase.DAY,
      tiles: rectGrass(40, 14),
      entities: [
        entity(1, 'hero', 7, 7),
        entity(2, 'hero', 32, 7, { abilities: ['scout'] }),
      ],
    };
    const set = computeLineOfSight(state, 'hero');
    assert.ok(set.has(hexKey(13, 7)), 'non-scout sees 6 east of self');
    assert.ok(!set.has(hexKey(14, 7)), 'non-scout does NOT see 7 east of self');
    assert.ok(set.has(hexKey(39, 7)), 'scout sees 7 east of self');
  });
});

// ── 5. Defensive / edge cases ───────────────────────────────────────────────

describe('LOS fog — defensive paths', () => {
  test('null state / missing observer returns empty set', () => {
    assert.equal(computeLineOfSight(null, 'hero').size, 0);
    assert.equal(computeLineOfSight({}, 'hero').size, 0);
    assert.equal(computeLineOfSight({ tiles: new Map(), entities: [] }, null).size, 0);
  });

  test('the observer\'s own hex is always visible (even if standing on a building)', () => {
    const tiles = rectGrass(5, 5);
    tiles.set(hexKey(2, 2), buildingTile(2, 2));
    const state = {
      phase: Phase.DAY,
      tiles,
      entities: [entity(1, 'hero', 2, 2)],
    };
    assert.ok(computeLineOfSight(state, 'hero').has(hexKey(2, 2)));
  });
});
