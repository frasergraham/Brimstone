// Brute faction — tests for the distinct mechanics implemented in
// BruteFaction (no road movement bonus, minions-only summons, building
// survivor auto-zombify, crushing-blow blast splash on adjacent hexes).

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import {
  ActionType, getValidActions, executeMove, executeBattle, executeSummon,
} from '../src/actions.js';
import {
  EntityType, createMinion, createZombie, createCatapult,
} from '../src/entities.js';
import { TileType, ResourceType, BuildingType, legacyTileType, decomposeTileType, isBuildingFootprint } from '../src/tiles.js';
import { hexKey, getNeighbors, hexDistance } from '../src/hex.js';
import { getFaction, BruteFaction, WitchFaction } from '../src/factions.js';

function freshState() {
  return new GameState(true, true);
}

// Procedural maps can drop an impassable building footprint (cap-0) on any hex.
// Fixtures that move onto / knock back into / build on a fixed coordinate must
// neutralize any footprint markers a random map happened to place there.
function clearFootprint(tile) {
  if (!tile) return tile;
  tile.buildingFootprintOf = null;
  tile.footprintHexes = [];
  return tile;
}


// Isolate a single melee duel so the combat margin is a pure function of the
// forced dice: remove every entity except `leader` (no stray-ally gang-up) and
// scrub the surrounding tiles to plain grass (no terrain defence bonus on the
// target, open knockback destinations). Procedural maps otherwise occasionally
// shift the margin — flipping a forced non-crush into a crush, or a survivable
// blow into a kill — which makes margin/crush/kill assertions flaky.
// Remove every entity except `leader` so the procedural map's stray units
// (which can occupy a fixture's target/destination hex and fail a move, or add
// gang-up advantage) can't interfere.
function soloLeader(state, leader) {
  state.entities = state.entities.filter(e => e === leader);
}

function isolateArena(state, leader, radius = 3) {
  soloLeader(state, leader);
  for (const [, t] of state.tiles) {
    if (hexDistance(t.col, t.row, leader.col, leader.row) <= radius) {
      decomposeTileType(t, TileType.GRASS);
      t.building = null; t.structure = null; t.fortifyLevel = 0;
      clearFootprint(t);
    }
  }
}

// Spawn a brute leader at (col, row) by swapping the night-side default.
function bruteState(col = 5, row = 5) {
  const state = freshState();
  state.swapLeaderToFaction('night', 'brute');
  state.witch.col = col;
  state.witch.row = row;
  return { state, brute: state.witch };
}

// ── Faction class & registry ────────────────────────────────────────────────

describe('BruteFaction — class & registry', () => {
  test('getFaction("brute") returns a BruteFaction extending WitchFaction', () => {
    const f = getFaction('brute');
    assert.ok(f instanceof BruteFaction);
    assert.ok(f instanceof WitchFaction);
    assert.equal(f.id, 'brute');
    assert.equal(f.name, 'Brute');
    assert.equal(f.leaderType, EntityType.BRUTE);
  });

  test('brute is no longer a stub — it has its own behaviour', () => {
    assert.equal(getFaction('brute').isStub(), false);
  });
});

// ── Stats — heavy tank ──────────────────────────────────────────────────────

describe('BruteFaction — leader stats', () => {
  test('brute is a heavy tank: high HP, ATK, DEF; low agility', () => {
    const b = getFaction('brute').createLeader(0, 0, 'p1');
    assert.equal(b.maxHp,   100);
    assert.equal(b.attack,   4);
    assert.equal(b.defense,  3);
    assert.equal(b.agility,  3);
    assert.equal(b.getRange(), 1);
  });

  test('brute leader keeps the witch summon ability (innate)', () => {
    const b = getFaction('brute').createLeader(0, 0, 'p1');
    assert.equal(b.hasAbility('summon'), true);
    assert.equal(b.hasAbility('sound_horn'), false);
  });
});

// ── Summons — minions only ──────────────────────────────────────────────────

describe('BruteFaction — minions-only summons', () => {
  test('getSummonOptions returns only MINION when affordable', () => {
    const f = getFaction('brute');
    const inv = { wood: { count: 2 }, metal: { count: 2 } };
    const opts = f.getSummonOptions(inv);
    assert.equal(opts.length, 1);
    assert.equal(opts[0].summonType, EntityType.MINION);
    assert.equal(opts[0].affordable, true);
  });

  test('getSummonOptions returns empty when total resources < minion cost (1)', () => {
    const f = getFaction('brute');
    assert.deepEqual(f.getSummonOptions({}), []);
    // Brute minion costs 1, so wood:1 IS enough — should return the option.
    const opts = f.getSummonOptions({ wood: { count: 1 } });
    assert.equal(opts.length, 1);
    assert.equal(opts[0].summonType, EntityType.MINION);
  });

  test('brute minion costs 1 resource (vs the witch\'s 2)', () => {
    assert.equal(getFaction('brute').getMinionCost(), 1);
    assert.equal(getFaction('witch').getMinionCost(), 2);
  });

  test('executeSummon spends only 1 resource on a brute minion', () => {
    const { state, brute } = bruteState();
    state.inventory.witch[ResourceType.METAL] = { count: 1 };
    state.inventory.witch[ResourceType.WOOD] = { count: 0 };
    const r = executeSummon(state, brute, EntityType.MINION);
    assert.equal(r.success, true);
    assert.equal((state.inventory.witch[ResourceType.METAL]?.count ?? 0), 0,
      'brute should pay only 1 metal for a minion');
    assert.deepEqual(r.spent, [{ type: ResourceType.METAL, amount: 1 }]);
  });

  test('SUMMON action surfaces only the minion option for the brute', () => {
    const { state, brute } = bruteState();
    state.inventory.witch[ResourceType.METAL] = { count: 4 };
    state.inventory.witch[ResourceType.WOOD] = { count: 4 };
    const summons = getValidActions(state, brute).filter(a => a.type === ActionType.SUMMON);
    assert.equal(summons.length, 1);
    assert.equal(summons[0].summonType, EntityType.MINION);
  });

  test('with a rich inventory, getSummonOptions still returns ONLY minion for the brute', () => {
    // The UI uses a probe inventory to discover the full allowed-summon set
    // for greyed-out display. The brute must never expose IRON_GOLEM or
    // WOOD_GOLEM at this stage, even when the probe is flooded with
    // resources.
    const opts = getFaction('brute').getSummonOptions({
      [ResourceType.METAL]: { count: 99 },
      [ResourceType.WOOD]: { count: 99 },
    });
    const types = opts.map(o => o.summonType);
    assert.deepEqual(types, [EntityType.MINION]);
  });

  test('executeSummon with no requested type spawns a minion (not a golem)', () => {
    const { state, brute } = bruteState();
    state.inventory.witch[ResourceType.METAL] = { count: 4 };
    state.inventory.witch[ResourceType.WOOD] = { count: 4 };
    const before = state.entities.length;
    const r = executeSummon(state, brute, null);
    assert.equal(r.success, true);
    const summoned = state.entities[state.entities.length - 1];
    assert.equal(state.entities.length, before + 1);
    assert.equal(summoned.type, EntityType.MINION);
  });

  test('executeSummon ignores a request for IRON_GOLEM and falls back to MINION', () => {
    const { state, brute } = bruteState();
    state.inventory.witch[ResourceType.METAL] = { count: 4 };
    const r = executeSummon(state, brute, EntityType.IRON_GOLEM);
    assert.equal(r.success, true);
    const summoned = state.entities[state.entities.length - 1];
    assert.equal(summoned.type, EntityType.MINION,
      'brute golem request should fall through to minion');
  });
});

// ── Building auto-zombify ───────────────────────────────────────────────────

describe('BruteFaction — onAfterMoveStep auto-zombifies survivors in buildings', () => {
  test('moving onto a building tile with a hidden survivor auto-raises a zombie', () => {
    const { state, brute } = bruteState(3, 3);
    soloLeader(state, brute); // keep the move's destination/path clear of stray units
    const t = state.tiles.get(hexKey(4, 3));
    decomposeTileType(t, TileType.BUILDING);
    t.building = BuildingType.INN;
    t.hiddenSurvivor = true;
    t.explored = false;
    clearFootprint(t);
    // Clear stray hidden survivors the random map placed elsewhere, so the
    // move's phase-random reveal can only fire on the building under test.
    for (const tile of state.tiles.values()) {
      if (tile.col === 4 && tile.row === 3) continue;
      tile.hiddenSurvivor = false;
    }

    const result = executeMove(state, brute, 4, 3);
    assert.equal(result.success, true);
    assert.ok(result.encounterSurvivor, 'a survivor should be discovered');
    assert.equal(result.encounterSurvivor.type, 'zombie',
      'discovered entity should be raised as a zombie, not recruited as a survivor');
    assert.equal(t.hiddenSurvivor, false);
    // A zombie owned by the witch side should now exist in the entity list.
    assert.ok(state.entities.some(
      e => e.alive && e.type === EntityType.ZOMBIE && e.col === 4 && e.row === 3
    ));
  });

  test('moving adjacent to a building with a hidden survivor auto-zombifies', () => {
    const { state, brute } = bruteState(3, 3);
    soloLeader(state, brute); // keep the move's destination/path clear of stray units
    const adj = state.tiles.get(hexKey(5, 3));
    decomposeTileType(adj, TileType.BUILDING);
    adj.building = BuildingType.CHURCH;
    adj.hiddenSurvivor = true;
    adj.explored = false;
    clearFootprint(adj);
    const dest = state.tiles.get(hexKey(4, 3));
    decomposeTileType(dest, TileType.GRASS);
    dest.building = null;
    dest.hiddenSurvivor = false;
    clearFootprint(dest);
    // Clear stray hidden survivors elsewhere so the only discovery is the
    // adjacent building under test.
    for (const tile of state.tiles.values()) {
      if (tile.col === 5 && tile.row === 3) continue;
      tile.hiddenSurvivor = false;
    }

    const result = executeMove(state, brute, 4, 3);
    assert.equal(result.success, true);
    assert.ok(result.encounterSurvivor, 'a survivor should be discovered from adjacent building');
    assert.equal(result.encounterSurvivor.type, 'zombie');
    assert.equal(adj.hiddenSurvivor, false);
  });

  test('auto-zombify does NOT trigger for non-building tiles, even adjacent', () => {
    const { state, brute } = bruteState(3, 3);
    const adj = state.tiles.get(hexKey(5, 3));
    decomposeTileType(adj, TileType.GRASS);
    adj.building = null;
    adj.hiddenSurvivor = true;
    // Clear hidden-survivor flags on the path so the phase-random
    // reveal can't accidentally fire.
    for (const t of state.tiles.values()) {
      if (t.col === 5 && t.row === 3) continue;
      t.hiddenSurvivor = false;
    }

    const result = executeMove(state, brute, 4, 3);
    assert.equal(adj.hiddenSurvivor, true);
    assert.ok(!result.encounterSurvivor);
  });

  test('the witch (default night faction) does NOT get auto-zombify', () => {
    const state = freshState();
    state.witch.col = 3;
    state.witch.row = 3;
    const adj = state.tiles.get(hexKey(5, 3));
    decomposeTileType(adj, TileType.BUILDING);
    adj.building = BuildingType.INN;
    adj.hiddenSurvivor = true;
    adj.explored = false;
    clearFootprint(adj);
    const dest = state.tiles.get(hexKey(4, 3));
    decomposeTileType(dest, TileType.GRASS);
    dest.building = null;
    dest.hiddenSurvivor = false;
    clearFootprint(dest);

    executeMove(state, state.witch, 4, 3);
    // Witch's only chance to find the survivor is the existing
    // phase-random reveal on the destination tile, which we cleared.
    assert.equal(adj.hiddenSurvivor, true);
  });
});

// ── Splash blast — every-hit, scales with margin, knocks back, spares allies ─

describe('BruteFaction — splash blast configuration', () => {
  test('config flags: brute is the only faction with splash extras', () => {
    const b = getFaction('brute');
    assert.equal(b.crushSplashRadius(),      1);
    assert.equal(b.splashesOnEveryHit(),     true);
    assert.equal(b.splashSparesAllies(),     true);
    assert.equal(b.splashKnockback(),        true);
    assert.equal(b.splashScalesWithMargin(), true);
    for (const id of ['hero', 'rogue', 'captain', 'witch', 'necromancer']) {
      const f = getFaction(id);
      assert.equal(f.crushSplashRadius(),      0, `${id} should not splash`);
      assert.equal(f.splashesOnEveryHit(),     false);
      assert.equal(f.splashSparesAllies(),     false);
      assert.equal(f.splashKnockback(),        false);
      assert.equal(f.splashScalesWithMargin(), false);
    }
  });
});

// Place a neutral bystander (owner=null) on a neighbour of `targetPos`
// that's not co-located with the actor and not on a river. Neutral
// owner keeps the bystander out of both gang-up calculations and the
// brute's friendly-fire spare list, so we can read clean splash damage
// numbers.
function placeNeutralBystander(state, targetPos, actor, hp = 99) {
  const candidate = getNeighbors(targetPos.col, targetPos.row).find(n => {
    if (n.col === actor.col && n.row === actor.row) return false;
    const t = state.tiles.get(hexKey(n.col, n.row));
    if (!t || legacyTileType(t) === TileType.RIVER || isBuildingFootprint(t)) return false;
    return state.entities.every(e => !e.alive || e.col !== n.col || e.row !== n.row);
  });
  if (!candidate) return null;
  const m = createMinion(candidate.col, candidate.row);
  m.owner = null; // neutral — no gang-up bonus, not spared by friendly-fire-off
  m.maxHp = hp; m.hp = hp;
  state.entities.push(m);
  return m;
}

describe('BruteFaction — splash splashes on every hit, not just crushes', () => {
  test('a regular (non-crush) hit by the brute still splashes adjacent enemy hexes', () => {
    const { state, brute } = bruteState(5, 5);
    isolateArena(state, brute);
    const targetPos = getNeighbors(brute.col, brute.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'hero';
    target.maxHp = 99; target.hp = 99; // survives, so splash is attributable to the hit, not a kill
    state.entities.push(target);

    const bystander = placeNeutralBystander(state, targetPos, brute, 5);
    assert.ok(bystander, 'need an open neighbour hex of the target for the bystander');

    // Force a regular (non-crush) hit: atk=2 → 6 vs def=5 → 5. Hit, not crush.
    state.setForcedDice(2, 5);

    const r = executeBattle(state, brute, target);
    assert.equal(r.success, true);
    assert.equal(r.hit, true);
    assert.equal(r.killed, false, 'target survives — this exercises splash-on-every-hit');
    assert.ok(r.attackRoll < 2 * r.defenseRoll, 'should be a regular hit, not a crush');
    assert.ok(bystander.hp < 5,
      `bystander should take splash damage on a non-crush hit, hp=${bystander.hp}`);
  });

  test('a crush by a normal witch does NOT splash to neighbours (radius stays 0)', () => {
    const state = freshState();
    state.witch.col = 5; state.witch.row = 5;
    const witch = state.witch;

    const targetPos = getNeighbors(witch.col, witch.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'hero';
    state.entities.push(target);

    const bystanderPos = getNeighbors(targetPos.col, targetPos.row).find(n => {
      if (n.col === witch.col && n.row === witch.row) return false;
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t);
    });
    const bystander = createMinion(bystanderPos.col, bystanderPos.row);
    bystander.owner = 'witch';
    bystander.maxHp = 5; bystander.hp = 5;
    state.entities.push(bystander);

    state.setForcedDice(6, 6, 1);

    const r = executeBattle(state, witch, target);
    assert.equal(r.success, true);
    assert.equal(r.splashRadius, 0,
      'witch crushing blow should keep splash radius 0 (same-hex only)');
    assert.equal(bystander.hp, 5,
      'bystander on a neighbouring hex should NOT take splash from a witch crush');
  });
});

describe('BruteFaction — splash damage rolls tier d6 (variable, scales with margin)', () => {
  // Isolate the duel so the combat margin is fully determined by the forced
  // dice: clear stray entities (no gang-up advantage) and scrub the area to
  // grass (no terrain defence bonus). A fresh state is round 1 / DAWN, which
  // gives neither side a phase advantage. With atkNet = defNet = 0 the dice
  // order is atkPool(1) → defPool(1) → main 2d6 damage(2) → splash tier×d6, so
  // forcing the whole sequence pins both the margin and the splash roll.
  // Brute is unarmed (2d6), ATK 4, target DEF 0 → margin = atkDie + 4 - defDie.
  function setup() {
    const { state, brute } = bruteState(5, 5);
    isolateArena(state, brute);
    const targetPos = getNeighbors(brute.col, brute.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'hero'; target.maxHp = 99; target.hp = 99;
    state.entities.push(target);
    const bystander = placeNeutralBystander(state, targetPos, brute, 99);
    assert.ok(bystander, 'need an open neighbour hex for the bystander');
    return { state, brute, target, bystander };
  }

  test('tier = clamp(floor(margin/3),1,3) d6, rolled — not a fixed 7/14/21', () => {
    // The two main-damage dice are forced to 1,1 so the 99-HP target always
    // survives (splash still fires); the trailing dice are the splash roll.
    const splashOf = (...forced) => {
      const { state, brute, target, bystander } = setup();
      state.setForcedDice(...forced);
      const r = executeBattle(state, brute, target);
      assert.equal(r.hit, true);
      return { margin: r.margin, dmg: 99 - bystander.hp };
    };

    // margin 1 → tier 1 → 1d6 (splash die forced to 4)
    {
      const { margin, dmg } = splashOf(2, 5, 1, 1, 4);
      assert.equal(margin, 1);
      assert.equal(dmg, 4, 'tier 1 → 1d6 (forced 4)');
    }
    // margin 7 → tier 2 → 2d6 (splash dice forced to 3,5 → 8)
    {
      const { margin, dmg } = splashOf(4, 1, 1, 1, 3, 5);
      assert.equal(margin, 7);
      assert.equal(dmg, 8, 'tier 2 → 2d6 (forced 3+5)');
    }
    // margin 9 → tier 3 (cap) → 3d6 (splash dice forced to 2,3,6 → 11)
    {
      const { margin, dmg } = splashOf(6, 1, 1, 1, 2, 3, 6);
      assert.equal(margin, 9);
      assert.equal(dmg, 11, 'tier 3 → 3d6 (forced 2+3+6)');
    }
  });

  test('tier-3 splash is a variable 3d6 (rolls track the dice, 3..18) — not a fixed 21', () => {
    // margin 9 → tier 3 → 3d6 = sum of the three forced splash dice.
    const splashOf = (s1, s2, s3) => {
      const { state, brute, target, bystander } = setup();
      state.setForcedDice(6, 1, 1, 1, s1, s2, s3);
      const r = executeBattle(state, brute, target);
      assert.equal(r.margin, 9);
      return 99 - bystander.hp;
    };
    assert.equal(splashOf(1, 1, 1), 3,  'min 3d6 = 3');
    assert.equal(splashOf(6, 6, 6), 18, 'max 3d6 = 18');
    assert.equal(splashOf(2, 3, 6), 11, 'mid 3d6 = 11');
    // Distinct rolls → distinct damage: it is a variable roll, not a fixed value.
    assert.equal(new Set([3, 18, 11]).size, 3);
  });
});

describe('BruteFaction — splash spares allies (friendly-fire off)', () => {
  test('witch-side bystanders on splash hexes take NO damage from the brute\'s blast', () => {
    const { state, brute } = bruteState(5, 5);
    const targetPos = getNeighbors(brute.col, brute.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'hero';
    state.entities.push(target);

    // Friendly bystander on a hex adjacent to target. Owner=witch
    // means it grants the brute attacker gang-up advantage, but that's
    // fine — the test only cares that the ally takes no damage.
    const allyPos = getNeighbors(targetPos.col, targetPos.row).find(n => {
      if (n.col === brute.col && n.row === brute.row) return false;
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t);
    });
    const ally = createMinion(allyPos.col, allyPos.row);
    ally.owner = 'witch'; // attacker's side
    ally.maxHp = 5; ally.hp = 5;
    state.entities.push(ally);

    // Force a crushing blow. Pad dice for the gang-up advantage pool.
    state.setForcedDice(6, 6, 6, 6, 6, 1, 1, 1, 1, 1);

    const r = executeBattle(state, brute, target);
    assert.equal(r.success, true);
    assert.equal(ally.hp, 5, 'witch-side ally should be spared by the brute\'s splash');
    assert.ok(!r.splashHits.some(h => h.id === ally.id),
      'splashHits should not include witch-side allies');
  });
});

describe('BruteFaction — splash knocks bystanders outward', () => {
  test('a splashed enemy is pushed 1 hex away from the target', () => {
    const { state, brute } = bruteState(6, 6);
    // Scrub a 4-hex radius to plain GRASS so knockback always has an
    // open destination tile.
    state.entities = state.entities.filter(e => e === brute);
    for (const [, t] of state.tiles) {
      if (hexDistance(t.col, t.row, brute.col, brute.row) <= 4) {
        decomposeTileType(t, TileType.GRASS);
        t.building = null;
        t.fortifyLevel = 0;
        clearFootprint(t);
      }
    }

    const targetPos = getNeighbors(brute.col, brute.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'hero';
    target.maxHp = 99; target.hp = 99;
    state.entities.push(target);

    // Neutral bystander — keeps gang-up math out of it. High HP so it survives
    // the splash (≤6) and is knocked back rather than killed.
    const bystander = placeNeutralBystander(state, targetPos, brute, 99);
    assert.ok(bystander, 'need an open neighbour hex of the target');
    const startCol = bystander.col, startRow = bystander.row;

    // Regular hit. Margin 1 → tier 1 → 1d6 (≤6), bystander survives → knocked back.
    state.setForcedDice(2, 5);

    const r = executeBattle(state, brute, target);
    assert.equal(r.success, true);
    assert.equal(r.hit, true);
    assert.ok(bystander.col !== startCol || bystander.row !== startRow,
      `bystander should be knocked back from (${startCol},${startRow}); now at (${bystander.col},${bystander.row})`);
    const hit = r.splashHits.find(h => h.id === bystander.id);
    assert.ok(hit, 'splashHits should include the knocked-back bystander');
    assert.equal(hit.knockedBack, true);
    assert.equal(hit.fromCol, startCol);
    assert.equal(hit.fromRow, startRow);
    assert.equal(hit.col, bystander.col);
    assert.equal(hit.row, bystander.row);
    // Direction sanity: distance from target to bystander after knockback
    // should be 2 (one hex further than before).
    assert.equal(hexDistance(bystander.col, bystander.row, target.col, target.row), 2,
      'knockback should push exactly 1 hex outward from target');
  });

  test('an immobile catapult bystander is splashed but NOT knocked back (immobile means immobile)', () => {
    const { state, brute } = bruteState(6, 6);
    // Same open-arena scrub as the knockback test above, so a mobile unit in
    // the catapult's place WOULD be pushed — the only variable is the tag.
    state.entities = state.entities.filter(e => e === brute);
    for (const [, t] of state.tiles) {
      if (hexDistance(t.col, t.row, brute.col, brute.row) <= 4) {
        decomposeTileType(t, TileType.GRASS);
        t.building = null;
        t.fortifyLevel = 0;
        clearFootprint(t);
      }
    }

    const targetPos = getNeighbors(brute.col, brute.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'hero';
    target.maxHp = 99; target.hp = 99;
    state.entities.push(target);

    // Catapult on an open neighbour of the target. Neutral owner keeps
    // gang-up out of the dice math; high HP so it survives the splash.
    const catPos = getNeighbors(targetPos.col, targetPos.row).find(n => {
      if (n.col === brute.col && n.row === brute.row) return false;
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (!t || legacyTileType(t) === TileType.RIVER || isBuildingFootprint(t)) return false;
      return state.entities.every(e => !e.alive || e.col !== n.col || e.row !== n.row);
    });
    assert.ok(catPos, 'need an open neighbour hex of the target');
    const cat = createCatapult(catPos.col, catPos.row);
    cat.owner = null;
    cat.maxHp = 99; cat.hp = 99;
    state.entities.push(cat);

    state.setForcedDice(2, 5); // same margin-1 hit as the knockback test above

    const r = executeBattle(state, brute, target);
    assert.equal(r.success, true);
    assert.equal(r.hit, true);
    const hit = r.splashHits.find(h => h.id === cat.id);
    assert.ok(hit, 'the catapult is still caught in the blast (damage applies)');
    assert.equal(hit.knockedBack, false, 'immobile: the blast never shoves it');
    assert.equal(cat.col, catPos.col, 'catapult column unchanged');
    assert.equal(cat.row, catPos.row, 'catapult row unchanged');
  });
});

describe('Crushing blows wound the target — universal', () => {
  // Use the paladin (range 1, melee) for these tests — the witch is
  // ranged at range 2 and ranged attacks cannot crush by design.
  test('a crushing blow that does NOT kill applies the wounded effect', () => {
    const state = freshState();
    state.hero.col = 5; state.hero.row = 5;
    const paladin = state.hero;
    isolateArena(state, paladin);

    const targetPos = getNeighbors(paladin.col, paladin.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'witch';
    target.maxHp = 99; target.hp = 99;
    state.entities.push(target);

    state.setForcedDice(6, 1);
    const r = executeBattle(state, paladin, target);
    assert.equal(r.success, true);
    assert.ok(r.attackRoll >= 2 * r.defenseRoll, 'should be a crush');
    assert.equal(target.alive, true, 'target should survive the crush');
    assert.ok(target.effects.some(e => e.id === 'wounded'),
      `target should be wounded after a crush, effects=${JSON.stringify(target.effects)}`);
  });

  test('a regular (non-crush) hit does NOT apply wounded', () => {
    const state = freshState();
    state.hero.col = 5; state.hero.row = 5;
    const paladin = state.hero;
    isolateArena(state, paladin);

    const targetPos = getNeighbors(paladin.col, paladin.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'witch';
    target.maxHp = 99; target.hp = 99;
    state.entities.push(target);

    // Paladin ATK=3, target DEF=0. atk=2 → 5 vs def=4 → 4: hit, but
    // 5 < 2 × 4 = 8 (no crush).
    state.setForcedDice(2, 4);
    const r = executeBattle(state, paladin, target);
    assert.equal(r.hit, true);
    assert.ok(r.attackRoll < 2 * r.defenseRoll, 'should not be a crush');
    assert.ok(!target.effects.some(e => e.id === 'wounded'));
  });

  test('a crush that KILLS the target does not bother applying wounded', () => {
    const state = freshState();
    state.hero.col = 5; state.hero.row = 5;
    const paladin = state.hero;
    isolateArena(state, paladin);

    const targetPos = getNeighbors(paladin.col, paladin.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'witch';
    // Minion hp=14. Force a great crush with max damage dice (6,1 → crush;
    // 6,6 → 2D6=12, ×3 tier = 36) so the blow is lethal.
    state.entities.push(target);

    state.setForcedDice(6, 1, 6, 6);
    const r = executeBattle(state, paladin, target);
    assert.equal(r.killed, true);
    assert.equal(target.alive, false);
  });
});
