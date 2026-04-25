// Brute faction — tests for the distinct mechanics implemented in
// BruteFaction (no road movement bonus, minions-only summons, building
// survivor auto-zombify, crushing-blow blast splash on adjacent hexes).

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import {
  ActionType, getValidActions, executeMove, executeBattle, executeSummon,
  getReachableHexes,
} from '../src/actions.js';
import {
  EntityType, createMinion, createZombie,
} from '../src/entities.js';
import { TileType, ResourceType, BuildingType } from '../src/tiles.js';
import { hexKey, getNeighbors } from '../src/hex.js';
import { getFaction, BruteFaction, WitchFaction } from '../src/factions.js';

function freshState() {
  return new GameState(true, true);
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
    assert.equal(b.maxHp,   18);
    assert.equal(b.attack,   4);
    assert.equal(b.defense,  3);
    assert.equal(b.agility,  3);
    assert.equal(b.range,    1);
  });

  test('brute leader keeps the witch summon ability (innate)', () => {
    const b = getFaction('brute').createLeader(0, 0, 'p1');
    assert.equal(b.hasAbility('summon'), true);
    assert.equal(b.hasAbility('sound_horn'), false);
  });
});

// ── Lumbering — no road movement bonus ──────────────────────────────────────

describe('BruteFaction — lumbering movement', () => {
  test('lumbers() returns true for brute, false for hero/witch/rogue', () => {
    assert.equal(getFaction('brute').lumbers(),       true);
    assert.equal(getFaction('witch').lumbers(),       false);
    assert.equal(getFaction('hero').lumbers(),        false);
    assert.equal(getFaction('rogue').lumbers(),       false);
    assert.equal(getFaction('necromancer').lumbers(), false);
    assert.equal(getFaction('captain').lumbers(),     false);
  });

  test('brute walks 1 hex on a road (no discount); witch walks 2 on roads', () => {
    // Same starting state — switch only the leader faction and compare
    // reachable hex counts on a freshly-tiled corridor of roads.
    const layout = (state, col, row) => {
      // Build a horizontal corridor of road tiles.
      for (let dc = -3; dc <= 3; dc++) {
        const t = state.tiles.get(hexKey(col + dc, row));
        if (t) { t.type = TileType.ROAD; t.building = null; }
      }
    };

    const wState = freshState();
    layout(wState, wState.witch.col, wState.witch.row);
    const witchReach = getReachableHexes(wState, wState.witch, 1);

    const { state, brute } = bruteState();
    layout(state, brute.col, brute.row);
    const bruteReach = getReachableHexes(state, brute, 1);

    // Witch on roads can reach roughly 2 tiles in either direction along
    // the corridor (range 1 → budget 2; road cost 1). Brute lumbers, so
    // every road tile costs 2 — only adjacent tiles are reachable.
    assert.ok(witchReach.length > bruteReach.length,
      `witch should reach more hexes on roads than brute (witch: ${witchReach.length}, brute: ${bruteReach.length})`);
    // Check that no brute-reachable hex is more than 1 step away.
    for (const h of bruteReach) {
      const dc = Math.abs(h.col - brute.col);
      const dr = Math.abs(h.row - brute.row);
      assert.ok(dc + dr <= 2,
        `brute reach should be capped at 1 step on roads, got (${h.col},${h.row}) from (${brute.col},${brute.row})`);
    }
  });
});

// ── Summons — minions only ──────────────────────────────────────────────────

describe('BruteFaction — minions-only summons', () => {
  test('getSummonOptions returns only MINION when affordable', () => {
    const f = getFaction('brute');
    const inv = { wood: 2, metal: 2 };
    const opts = f.getSummonOptions(inv);
    assert.equal(opts.length, 1);
    assert.equal(opts[0].summonType, EntityType.MINION);
    assert.equal(opts[0].affordable, true);
  });

  test('getSummonOptions returns empty when total resources < 2', () => {
    const f = getFaction('brute');
    assert.deepEqual(f.getSummonOptions({ wood: 1 }), []);
    assert.deepEqual(f.getSummonOptions({}), []);
  });

  test('SUMMON action surfaces only the minion option for the brute', () => {
    const { state, brute } = bruteState();
    state.inventory.witch[ResourceType.METAL] = 4;
    state.inventory.witch[ResourceType.WOOD]  = 4;
    const summons = getValidActions(state, brute).filter(a => a.type === ActionType.SUMMON);
    assert.equal(summons.length, 1);
    assert.equal(summons[0].summonType, EntityType.MINION);
  });

  test('executeSummon with no requested type spawns a minion (not a golem)', () => {
    const { state, brute } = bruteState();
    state.inventory.witch[ResourceType.METAL] = 4;
    state.inventory.witch[ResourceType.WOOD]  = 4;
    const before = state.entities.length;
    const r = executeSummon(state, brute, null);
    assert.equal(r.success, true);
    const summoned = state.entities[state.entities.length - 1];
    assert.equal(state.entities.length, before + 1);
    assert.equal(summoned.type, EntityType.MINION);
  });

  test('executeSummon ignores a request for IRON_GOLEM and falls back to MINION', () => {
    const { state, brute } = bruteState();
    state.inventory.witch[ResourceType.METAL] = 4;
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
    const t = state.tiles.get(hexKey(4, 3));
    t.type = TileType.BUILDING;
    t.building = BuildingType.INN;
    t.hiddenSurvivor = true;
    t.explored = false;

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
    const adj = state.tiles.get(hexKey(5, 3));
    adj.type = TileType.BUILDING;
    adj.building = BuildingType.CHURCH;
    adj.hiddenSurvivor = true;
    adj.explored = false;
    const dest = state.tiles.get(hexKey(4, 3));
    dest.type = TileType.GRASS;
    dest.building = null;
    dest.hiddenSurvivor = false;

    const result = executeMove(state, brute, 4, 3);
    assert.equal(result.success, true);
    assert.ok(result.encounterSurvivor, 'a survivor should be discovered from adjacent building');
    assert.equal(result.encounterSurvivor.type, 'zombie');
    assert.equal(adj.hiddenSurvivor, false);
  });

  test('auto-zombify does NOT trigger for non-building tiles, even adjacent', () => {
    const { state, brute } = bruteState(3, 3);
    const adj = state.tiles.get(hexKey(5, 3));
    adj.type = TileType.GRASS;
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
    adj.type = TileType.BUILDING;
    adj.building = BuildingType.INN;
    adj.hiddenSurvivor = true;
    adj.explored = false;
    const dest = state.tiles.get(hexKey(4, 3));
    dest.type = TileType.GRASS;
    dest.building = null;
    dest.hiddenSurvivor = false;

    executeMove(state, state.witch, 4, 3);
    // Witch's only chance to find the survivor is the existing
    // phase-random reveal on the destination tile, which we cleared.
    assert.equal(adj.hiddenSurvivor, true);
  });
});

// ── Crush splash on neighbours ──────────────────────────────────────────────

describe('BruteFaction — crushing blow blast splash', () => {
  test('crushSplashRadius() returns 1 for brute, 0 for everyone else', () => {
    assert.equal(getFaction('brute').crushSplashRadius(),       1);
    assert.equal(getFaction('witch').crushSplashRadius(),       0);
    assert.equal(getFaction('hero').crushSplashRadius(),        0);
    assert.equal(getFaction('rogue').crushSplashRadius(),       0);
    assert.equal(getFaction('captain').crushSplashRadius(),     0);
    assert.equal(getFaction('necromancer').crushSplashRadius(), 0);
  });

  test('a crushing blow by the brute splashes 1 damage to adjacent hexes', () => {
    const { state, brute } = bruteState(5, 5);
    // Make sure no random hidden-survivor reveals or mid-walk encounters
    // disturb our placement: only the entities we add matter.
    const targetPos = getNeighbors(brute.col, brute.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'hero'; // make enemy
    state.entities.push(target);

    // Bystanders on hexes adjacent to the target — they should each take 1
    // splash damage when the brute crushes the target. Set them as witch
    // allies so they don't grant the defender gang-up advantage (which
    // would flood the dice pool and ruin the deterministic forced rolls).
    // Splash damage is indiscriminate — friendly fire is part of the design.
    const targetNeighbours = getNeighbors(targetPos.col, targetPos.row);
    const bystanders = [];
    for (const n of targetNeighbours) {
      if (n.col === brute.col && n.row === brute.row) continue;
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (!t || t.type === TileType.RIVER) continue;
      const m = createMinion(n.col, n.row);
      m.owner = 'witch'; // attacker-allied bystanders
      m.maxHp = 5; m.hp = 5;
      state.entities.push(m);
      bystanders.push(m);
    }
    assert.ok(bystanders.length >= 2, 'need at least 2 bystander hexes for this test');

    // Force a crushing blow. Pad the dice queue so we don't go random for
    // the attacker's gang-up advantage pool (atk_allies = bystanders here).
    state.setForcedDice(6, 6, 6, 6, 6, 1, 1, 1, 1, 1);

    const r = executeBattle(state, brute, target);
    assert.equal(r.success, true);
    assert.equal(r.hit, true);
    assert.equal(r.splashRadius, 1, 'brute attack should record splash radius 1');
    // Each bystander on a neighbouring hex should have taken exactly 1 splash damage.
    for (const b of bystanders) {
      assert.equal(b.hp, 4, `bystander at (${b.col},${b.row}) should take 1 splash damage`);
    }
    // splashHexes covers target + 6 neighbours.
    assert.equal(r.splashHexes.length, 7,
      'splashHexes should be target hex plus 6 neighbours');
  });

  test('a non-crushing hit from the brute does NOT splash to neighbours', () => {
    const { state, brute } = bruteState(5, 5);
    const targetPos = getNeighbors(brute.col, brute.row)[0];
    const target = createMinion(targetPos.col, targetPos.row);
    target.owner = 'hero';
    target.maxHp = 5; target.hp = 5;
    state.entities.push(target);

    const bystanderPos = getNeighbors(targetPos.col, targetPos.row).find(n => {
      if (n.col === brute.col && n.row === brute.row) return false;
      const t = state.tiles.get(hexKey(n.col, n.row));
      return t && t.type !== TileType.RIVER;
    });
    const bystander = createMinion(bystanderPos.col, bystanderPos.row);
    bystander.owner = 'witch';
    bystander.maxHp = 5; bystander.hp = 5;
    state.entities.push(bystander);

    // Brute ATK=4 vs Minion DEF=0. atk_die=2 → atk total 6; def_die=5 → def
    // total 5. 6 > 5 (hit) but 6 < 2 × 5 = 10 (no crush). Pad for the gang-up
    // advantage pool from the brute's bystander ally.
    state.setForcedDice(2, 2, 5);

    const r = executeBattle(state, brute, target);
    assert.equal(r.success, true);
    assert.equal(r.hit, true);
    assert.ok(r.attackRoll < 2 * r.defenseRoll, 'should be a regular hit, not a crush');
    assert.equal(bystander.hp, 5, 'bystander should NOT take splash damage on a non-crush hit');
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
      return t && t.type !== TileType.RIVER;
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
