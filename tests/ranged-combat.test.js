// Ranged-attack behaviour coverage.
//
// The witch has range 2. Ranged attacks (attacker.range > 1):
//   - No gang-up bonus (attacker advantage dice + flat) or ally-defence bonus
//   - No crushing blows (damage capped at 1)
//   - No splash damage on crush or kill
//   - Forest tile grants defender +1 DEF
//   - Shooting at an adjacent enemy costs the attacker 1 disadvantage die
//
// These tests exercise Entity.resolveCombat, executeBattle, and
// getValidActions. Resolver-level range checks live in their own section.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState } from '../src/game.js';
import {
  executeBattle, getValidActions, ActionType,
} from '../src/actions.js';
import {
  Entity, EntityType,
  createHero, createWitch, createMinion,
} from '../src/entities.js';
import { TileType, PathType, StructureType, legacyTileType, decomposeTileType, isBuildingFootprint } from '../src/tiles.js';
import { hexKey, hexDistance, hexRange } from '../src/hex.js';
import { PlanActionType, snapEntity } from '../src/planner.js';
import { resolvePlans } from '../server/resolver.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

function freshState() {
  return new GameState(true, true);
}

// Place an entity at a specific hex, ensuring the GameState's tile map has it.
function placeAt(entity, col, row) {
  entity.col = col;
  entity.row = row;
}

// For ranged-visibility fixtures that rely on a clear sightline to an in-range
// target, scrub every line-of-sight blocker within `radius` of the observer:
// building footprints (a footprint cap-0 cell — new with the footprint rework)
// AND forest cover (a pre-existing LOS blocker). A random map can drop either
// between the observer and the target and silently hide it from fog visibility.
function clearSightlineAround(state, col, row, radius) {
  for (const h of hexRange(col, row, radius)) {
    const t = state.tiles.get(hexKey(h.col, h.row));
    if (!t) continue;
    t.buildingFootprintOf = null;
    t.footprintHexes = [];
    if (t.base === TileType.FOREST) t.base = TileType.GRASS; // clear forest LOS cover
  }
}

describe('unit range registry', () => {
  test('witch has range 2', () => {
    const w = createWitch(0, 0);
    assert.equal(w.getRange(), 2);
    assert.equal(w.range, 2);
  });

  test('hero and minion have range 1', () => {
    assert.equal(createHero(0, 0).getRange(), 1);
    assert.equal(createMinion(0, 0).getRange(), 1);
  });

  test('snapEntity includes range', () => {
    const w = createWitch(3, 4);
    const snap = snapEntity(w);
    assert.equal(snap.range, 2);
  });
});

describe('ranged attack — no gang-up, no ally-def', () => {
  test('witch shooting at dist 2 ignores adjacent allies on both sides', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    // Place them exactly 2 hexes apart on a straight line.
    placeAt(witch, 5, 5);
    placeAt(hero,  7, 5);
    // Add witch-side ally adjacent to the hero (would be gang-up if melee).
    const minion = createMinion(7, 6);
    state.entities.push(minion);
    // Add hero-side ally adjacent to the hero (would be defensive support).
    const survivor = createHero(8, 5);  // any hero-side entity works; reuse hero factory
    survivor.owner = 'hero';
    state.entities.push(survivor);

    // Force base dice to 3 for both sides so the numbers are predictable.
    state.setForcedDice(3, 3);
    const r = executeBattle(state, witch, hero);

    assert.equal(r.ranged, true, 'attack classified as ranged');
    assert.equal(r.breakdown.atkAdvantageDice, 0, 'no gang-up advantage dice');
    assert.equal(r.breakdown.atkGangupFlat, 0,    'no gang-up flat bonus');
    assert.equal(r.breakdown.defAdvantageDice, 0, 'no ally-defence advantage dice');
    assert.equal(r.breakdown.defGangupFlat, 0,    'no ally-defence flat bonus');
    // With forced dice both pools are single d6s.
    assert.equal(r.breakdown.atkPool.length, 1);
    assert.equal(r.breakdown.defPool.length, 1);
  });
});

describe('ranged attack — no counter', () => {
  test('defender with double the attacker\'s roll does NOT counter-attack a ranged shooter', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  7, 5);

    // Force atk=1 (miss) and def=6 → defenseRoll >= 2*attackRoll, would
    // counter if melee. Ranged should NOT counter — attacker unscathed.
    state.setForcedDice(1, 6);
    const witchHpBefore = witch.hp;
    const r = executeBattle(state, witch, hero);

    assert.equal(r.hit, false, 'attack missed');
    assert.equal(r.counterDmg, 0, 'ranged attack does NOT trigger a counter');
    assert.equal(witch.hp, witchHpBefore, 'ranged attacker takes no counter damage');
    assert.equal(r.defenseRoll >= 2 * r.attackRoll, true, 'margin would counter if melee');
  });
});

describe('ranged attack — no crush, no splash', () => {
  test('huge margin on a ranged hit still deals only 1 damage', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  7, 5);

    // Force atk=6 and def=1 → margin huge, would crush a melee attack.
    state.setForcedDice(6, 1);
    const heroHpBefore = hero.hp;
    const r = executeBattle(state, witch, hero);

    assert.equal(r.hit, true);
    assert.equal(r.damage, 1, 'ranged hit always deals exactly 1');
    assert.equal(hero.hp, heroHpBefore - 1);
    // No crush flag, no splash list.
    assert.equal(r.attackRoll >= 2 * r.defenseRoll, true, 'margin would crush if melee');
    assert.equal(r.splashKills.length, 0);
    assert.equal(r.splashHits.length,  0);
  });

  test('ranged kill does not splash onto other units on the target hex', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  7, 5);
    hero.hp = 1;   // one-shot kill

    // Bystander hero-side unit co-located with the hero.
    const bystander = createMinion(7, 5);
    bystander.owner = 'hero';
    state.entities.push(bystander);
    const bystanderHpBefore = bystander.hp;

    state.setForcedDice(6, 1);
    const r = executeBattle(state, witch, hero);

    assert.equal(r.killed, true, 'hero slain');
    assert.equal(r.splashHits.length, 0, 'no splash hits from a ranged kill');
    assert.equal(bystander.hp, bystanderHpBefore, 'bystander unscathed');
  });
});

describe('ranged attack — forest cover', () => {
  test('defender on a forest tile gains +1 DEF against ranged attacks', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  7, 5);

    // Paint the hero's hex as forest.
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    decomposeTileType(t, TileType.FOREST);

    state.setForcedDice(3, 3);
    const r = executeBattle(state, witch, hero);

    assert.equal(r.ranged, true);
    assert.equal(r.breakdown.forestCoverBonus, 1, 'forest cover +1 DEF');
    // Defence roll = base die + hero.defense + fortBonus(0) + forestCover(1).
    const expectedDef = r.breakdown.defBaseDie + hero.getDefense()
      + (r.breakdown.fortBonus || 0) + 1;
    assert.equal(r.defenseRoll, expectedDef);
  });

  // P4 locked behaviour change: forest cover is BASE-driven. A defender whose
  // tile has base=forest gets +1 DEF vs ranged EVEN IF a road or building sits
  // on top (previously laying a road cleared the forest type and removed cover).
  test('road-over-forest STILL grants ranged forest cover (+1 DEF) — new base-driven rule', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  7, 5);

    // Forest base with a road laid on top — derived tile.type === ROAD, but the
    // base material is still forest, so cover applies.
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.base = TileType.FOREST;
    t.path = PathType.ROAD;
    assert.equal(legacyTileType(t), TileType.ROAD, 'derived type is road (path wins)');

    state.setForcedDice(3, 3);
    const r = executeBattle(state, witch, hero);

    assert.equal(r.ranged, true);
    assert.equal(r.breakdown.forestCoverBonus, 1, 'base=forest still grants cover');
  });

  test('building-over-forest STILL grants ranged forest cover (+1 DEF)', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  7, 5);

    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.base = TileType.FOREST;
    t.path = null;
    t.structure = StructureType.BUILDING;
    assert.equal(legacyTileType(t), TileType.BUILDING, 'derived type is building');

    state.setForcedDice(3, 3);
    const r = executeBattle(state, witch, hero);

    assert.equal(r.ranged, true);
    assert.equal(r.breakdown.forestCoverBonus, 1, 'base=forest under a building still grants cover');
  });

  test('non-forest base (road over grass) grants NO forest cover', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  7, 5);

    const t = state.tiles.get(hexKey(hero.col, hero.row));
    t.base = TileType.GRASS;
    t.path = PathType.ROAD;

    state.setForcedDice(3, 3);
    const r = executeBattle(state, witch, hero);

    assert.equal(r.ranged, true);
    assert.equal(r.breakdown.forestCoverBonus, 0, 'grass base = no cover');
  });

  test('melee attacker gets no forest cover bonus (defender is already in the same trees)', () => {
    const state = freshState();
    const hero  = state.hero;
    const minion = createMinion(hero.col + 1, hero.row);
    state.entities.push(minion);
    const t = state.tiles.get(hexKey(hero.col, hero.row));
    decomposeTileType(t, TileType.FOREST);

    state.setForcedDice(3, 3);
    const r = executeBattle(state, minion, hero);

    assert.equal(r.ranged, false);
    assert.equal(r.breakdown.forestCoverBonus, 0);
  });
});

describe('ranged attack — close-range disadvantage', () => {
  test('witch shooting at an adjacent target takes 1 disadvantage die', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  6, 5);   // distance 1 — point-blank

    assert.equal(hexDistance(witch.col, witch.row, hero.col, hero.row), 1);
    state.setForcedDice(3, 3, 3);   // extra die for the disadvantage pool
    const r = executeBattle(state, witch, hero);

    assert.equal(r.ranged, true);
    assert.equal(r.closeRanged, true);
    assert.equal(r.breakdown.atkDisadvantageDice, 1);
    // With 1 disadvantage die the attack pool has 2 dice and picks the worst.
    assert.equal(r.breakdown.atkPool.length, 2);
  });
});

describe('getValidActions — ranged targeting', () => {
  test('witch lists battle targets within range 2', () => {
    const state = freshState();
    const witch = state.witch;
    placeAt(witch, 5, 5);
    // Drop a hero 2 hexes away — a melee unit wouldn't see this as a target.
    const hero = state.hero;
    placeAt(hero, 7, 5);
    assert.equal(hexDistance(witch.col, witch.row, hero.col, hero.row), 2);
    // Guarantee a clear sightline (fog visibility filters BATTLE targets by LOS).
    clearSightlineAround(state, witch.col, witch.row, 2);

    const actions = getValidActions(state, witch);
    const battle = actions.find(a => a.type === ActionType.BATTLE);
    assert.ok(battle, 'witch has a BATTLE action');
    assert.ok(battle.targets.some(t => t.id === hero.id),
      'hero at dist 2 appears in battle targets for the witch');
  });

  test('minion does not list targets beyond adjacency', () => {
    const state = freshState();
    const minion = createMinion(3, 3);
    state.entities.push(minion);
    const hero = state.hero;
    placeAt(hero, 5, 3);   // distance 2 from minion

    const actions = getValidActions(state, minion);
    const battle = actions.find(a => a.type === ActionType.BATTLE);
    // Adjacent targets only — the hero 2 hexes away should not appear.
    assert.ok(!battle || !battle.targets.some(t => t.id === hero.id),
      'melee minion cannot target hero at dist 2');
  });

  test('witch BATTLE_HEX candidates cover the full 2-hex radius', () => {
    const state = freshState();
    const witch = state.witch;
    placeAt(witch, 5, 5);

    const actions = getValidActions(state, witch);
    const battleHex = actions.find(a => a.type === ActionType.BATTLE_HEX);
    assert.ok(battleHex, 'witch has BATTLE_HEX action');
    // Every target hex must be within 2 of the witch, and at least one
    // dist-2 hex must appear to prove the range expanded.
    const maxDist = Math.max(
      ...battleHex.targets.map(t => hexDistance(witch.col, witch.row, t.col, t.row))
    );
    assert.equal(maxDist, 2);
  });
});

describe('resolver — ranged BATTLE_UNIT', () => {
  test('witch can BATTLE_UNIT at distance 2 (in range)', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  7, 5);

    const plan = [{
      type: PlanActionType.BATTLE_UNIT, entityId: witch.id,
      targetId: hero.id, targetCol: hero.col, targetRow: hero.row,
    }];
    state.setForcedDice(...Array(20).fill(3));
    const steps = resolvePlans(state, [], plan);
    const witchEvents = steps.flatMap(s => s.witchEvents ?? []);
    const battleEvents = witchEvents.filter(e => e.battleSnaps);
    assert.equal(battleEvents.length, 1, 'one ranged battle fired');
    assert.equal(battleEvents[0].battleSnaps.ranged, true);
    assert.ok(battleEvents[0].result, 'executeBattle returned a result');
  });

  test('witch BATTLE_UNIT at distance 3 is skipped (out of range)', () => {
    const state = freshState();
    const witch = state.witch;
    const hero  = state.hero;
    placeAt(witch, 5, 5);
    placeAt(hero,  8, 5);   // distance 3

    const plan = [{
      type: PlanActionType.BATTLE_UNIT, entityId: witch.id,
      targetId: hero.id, targetCol: hero.col, targetRow: hero.row,
    }];
    const steps = resolvePlans(state, [], plan);
    const witchEvents = steps.flatMap(s => s.witchEvents ?? []);
    const hadBattle = witchEvents.some(e => e.battleSnaps?.targetSnap);
    assert.equal(hadBattle, false, 'out-of-range target produces no battle');
  });
});

describe('state-sync — range round-trips', () => {
  test('witch.range survives serialization', () => {
    const state = freshState();
    const snap = serializeState(state);
    const witchSnap = snap.entities.find(e => e.type === EntityType.WITCH);
    assert.equal(witchSnap.range, 2);

    const restored = deserializeState(snap);
    const witchRestored = restored.entities.find(e => e.type === EntityType.WITCH);
    assert.equal(witchRestored.range, 2);
    assert.equal(typeof witchRestored.getRange, 'function');
    assert.equal(witchRestored.getRange(), 2);
  });

  test('legacy snapshot without range still hydrates to UNIT_TYPES default', () => {
    const state = freshState();
    const snap = serializeState(state);
    // Strip range from every entity to simulate a pre-ranged-attacks save.
    for (const e of snap.entities) delete e.range;

    const restored = deserializeState(snap);
    const witchRestored = restored.entities.find(e => e.type === EntityType.WITCH);
    const heroRestored  = restored.entities.find(e => e.type === EntityType.PALADIN);
    assert.equal(witchRestored.range, 2, 'witch default range restored from registry');
    assert.equal(heroRestored.range,  1, 'paladin default range restored from registry');
  });
});
