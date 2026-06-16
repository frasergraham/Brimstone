// Phase C — XP award hooks wired into explore / fortify / combat.
//
// Verifies that executeExplore / executeFortify / executeBattle grant the right
// XP to the right units (with the 25% gang-up ally share), that kill/counter-
// kill REPLACE the hit/crush/counter grant rather than stacking, that splash
// kills grant the actor only (no ally share), and that every hook is a strict
// no-op outside campaign (state.isCampaign falsy). Also covers the awardXP
// Infinity/NaN guard and the hero level/xp round-trip through Campaign.
//
// Deterministic combat is driven with state.setForcedDice(): the dice are
// consumed atkPool-then-defPool (resolveCombat) then the damage roll. With
// zeroed stats and no weapon, attackRoll = picked atk die + gang-up flat and
// defenseRoll = picked def die + gang-up flat, so outcomes are exact. See the
// `duel` helper in tests/actions.test.js for the same technique.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import {
  Entity, EntityType, createSurvivor, createHero, awardXP,
} from '../src/entities.js';
import { executeBattle, executeExplore, executeFortify } from '../src/actions.js';
import {
  XP_PER_EXPLORE, XP_PER_FORTIFY_BASE, XP_PER_FORTIFY_LEVEL_BONUS,
  XP_PER_HIT, XP_PER_CRUSH, XP_PER_KILL, XP_PER_DEFEND, XP_PER_COUNTER,
  ALLY_XP_SHARE, hpForLevel,
} from '../src/balance.js';
import { TileType, ResourceType } from '../src/tiles.js';
import { hexKey, getNeighbors } from '../src/hex.js';

// localStorage shim — Campaign.save() touches it in the round-trip test below.
// Override unconditionally: Node 22+ ships a built-in localStorage global that
// throws without a backing file, so a `?? ` fallback wouldn't replace it.
const _store = {};
globalThis.localStorage = {
  getItem: (k) => _store[k] ?? null,
  setItem: (k, v) => { _store[k] = String(v); },
  removeItem: (k) => { delete _store[k]; },
  clear: () => { for (const k of Object.keys(_store)) delete _store[k]; },
};

const share = (amount) => Math.floor(amount * ALLY_XP_SHARE);

// A blank tile at (2,2): grass, no fort, no building footprint, nothing hidden.
// `new GameState(true, true)` generates an UNSEEDED random map, so whatever
// procedurally landed on (2,2) has to be scrubbed across every layer or the
// explore/fortify early-returns fire ~8.5% of the time and the test flakes:
//   - buildingFootprintOf (the real field — the old `footprintOf` never existed,
//     so the footprint guard in executeExplore/executeFortify was never cleared)
//   - path = null clears any river/bridge/road (executeFortify bails on isRiver)
//   - structure/building = null clears any building (explore loots it instead)
function clearTile(state, col, row) {
  const t = state.tiles.get(hexKey(col, row));
  t.base = TileType.GRASS;
  t.structure = null;          // no building (hasBuilding reads `structure`)
  t.path = null;               // no river / bridge / road
  t.building = null;
  t.buildingFootprintOf = null; // the real footprint back-pointer (see tiles.js)
  t.fortifyLevel = 0;
  t.explored = false;
  t.hiddenSurvivor = false;
  return t;
}

// Build a zeroed melee combatant of the given faction at (col,row).
function combatant(owner, col, row) {
  const e = new Entity(EntityType.SURVIVOR, owner, col, row);
  e.attack = 0; e.defense = 0; e.weapon = null; e.abilities = []; e.effects = [];
  e.xp = 0; e.level = 1;
  return e;
}

// Build a 1-on-1 melee at (2,2) with all flats zeroed. `attackerOwner` picks the
// attacker's faction ('hero' by default so the attacker-side XP assertions stay
// meaningful — after Phase C's owner gate only player-faction units earn XP);
// the defender (and its allies) is always the opposing faction. attackerAllies /
// defenderAllies place that many gang-up units on distinct neighbour hexes of the
// target (each grants +1 advantage die and +1 flat to its side); each ally
// matches its principal's faction. Faction choice never touches the dice math
// here: phase is DAY (getPhaseCombatBonus = 0 for BOTH sides), tiles are
// unfortified, a fresh defender has zero fatigue, and a plain survivor/minion
// resolves to the base-faction splash config (radius 0) on either side — so the
// forced-dice outcomes are identical whichever faction attacks. Only the OWNER
// of the entities (hence who clears the XP gate) changes.
function battleSetup({ isCampaign = true, attackerAllies = 0, defenderAllies = 0,
                       attackerHp = 300, defenderHp = 300,
                       attackerOwner = 'hero' } = {}) {
  const defenderOwner = attackerOwner === 'hero' ? 'witch' : 'hero';
  const state = new GameState(true, true);
  state.isCampaign = isCampaign;
  state.phase = Phase.DAY; // neutral — no phase bonus for either side
  clearTile(state, 2, 2);

  const attacker = combatant(attackerOwner, 2, 2);
  attacker.maxHp = attackerHp; attacker.hp = attackerHp;

  const defender = combatant(defenderOwner, 2, 2);
  defender.maxHp = defenderHp; defender.hp = defenderHp;

  const entities = [attacker, defender];
  const neighbors = getNeighbors(2, 2);
  const atkAllies = [];
  for (let i = 0; i < attackerAllies; i++) {
    const a = combatant(attackerOwner, neighbors[i].col, neighbors[i].row);
    atkAllies.push(a); entities.push(a);
  }
  const defAllies = [];
  for (let i = 0; i < defenderAllies; i++) {
    // place defender allies on the far neighbours so they never collide with
    // attacker allies sharing the same target ring.
    const n = neighbors[neighbors.length - 1 - i];
    const d = combatant(defenderOwner, n.col, n.row);
    defAllies.push(d); entities.push(d);
  }
  state.entities = entities;
  return { state, attacker, defender, atkAllies, defAllies, attackerOwner, defenderOwner };
}

describe('explore XP hook', () => {
  test('campaign: first explore grants XP_PER_EXPLORE to the actor', () => {
    const state = new GameState(true, true);
    state.isCampaign = true;
    clearTile(state, 2, 2);
    const actor = createSurvivor(2, 2, 'hero', state);
    actor.owner = 'hero';
    actor.xp = 0; actor.level = 1;
    const r = executeExplore(state, actor);
    assert.equal(r.success, true);
    assert.equal(actor.xp, XP_PER_EXPLORE);
  });

  test('non-campaign: explore grants no XP', () => {
    const state = new GameState(true, true);
    state.isCampaign = false;
    clearTile(state, 2, 2);
    const actor = createSurvivor(2, 2, 'hero', state);
    actor.owner = 'hero';
    actor.xp = 0; actor.level = 1;
    executeExplore(state, actor);
    assert.equal(actor.xp, 0);
  });

  test('already-explored tile grants no XP (no double-award)', () => {
    const state = new GameState(true, true);
    state.isCampaign = true;
    const t = clearTile(state, 2, 2);
    t.explored = true; // pre-explored
    const actor = createSurvivor(2, 2, 'hero', state);
    actor.owner = 'hero';
    actor.xp = 0; actor.level = 1;
    const r = executeExplore(state, actor);
    assert.equal(r.success, false);
    assert.equal(actor.xp, 0);
  });
});

describe('fortify XP hook', () => {
  function fortifyState(isCampaign, { wood = 0, metal = 0 } = {}) {
    const state = new GameState(true, true);
    state.isCampaign = isCampaign;
    clearTile(state, 2, 2);
    state.inventory.hero[ResourceType.WOOD] = { count: wood };
    state.inventory.hero[ResourceType.METAL] = { count: metal };
    const actor = createSurvivor(2, 2, 'hero', state);
    actor.owner = 'hero';
    actor.xp = 0; actor.level = 1; actor.abilities = [];
    return { state, actor };
  }

  test('campaign wood fortify: XP = base + bonus × new fort level (1)', () => {
    const { state, actor } = fortifyState(true, { wood: 1 });
    const r = executeFortify(state, actor);
    assert.equal(r.success, true);
    assert.equal(actor.xp, XP_PER_FORTIFY_BASE + XP_PER_FORTIFY_LEVEL_BONUS * 1);
  });

  test('campaign metal fortify: XP scales with the higher new fort level (2)', () => {
    const { state, actor } = fortifyState(true, { metal: 1 });
    const r = executeFortify(state, actor);
    assert.equal(r.success, true);
    assert.equal(actor.xp, XP_PER_FORTIFY_BASE + XP_PER_FORTIFY_LEVEL_BONUS * 2);
  });

  test('non-campaign fortify grants no XP', () => {
    const { state, actor } = fortifyState(false, { wood: 1 });
    executeFortify(state, actor);
    assert.equal(actor.xp, 0);
  });
});

describe('battle XP hooks — attacker side', () => {
  test('HIT grants XP_PER_HIT to the attacker', () => {
    const { state, attacker, defender } = battleSetup({});
    state.setForcedDice(3, 2, 3, 4); // atk 3 vs def 2 → hit, not crush; dmg 7, survives
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.hit, true);
    assert.equal(r.killed, false);
    assert.equal(attacker.xp, XP_PER_HIT);
  });

  test('CRUSH grants XP_PER_CRUSH to the attacker', () => {
    const { state, attacker, defender } = battleSetup({});
    state.setForcedDice(2, 1, 3, 4); // atk 2 vs def 1 → crush (2×); dmg 14, survives
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.killed, false);
    assert.equal(attacker.xp, XP_PER_CRUSH);
  });

  test('KILL grants XP_PER_KILL and REPLACES the hit/crush grant (not additive)', () => {
    const { state, attacker, defender } = battleSetup({ defenderHp: 5 });
    state.setForcedDice(3, 2, 3, 4); // hit, dmg 7 ≥ 5 → kill (tier 1, would-be hit)
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.killed, true);
    assert.equal(attacker.xp, XP_PER_KILL);           // exactly the kill value …
    assert.notEqual(attacker.xp, XP_PER_KILL + XP_PER_HIT); // … not kill + hit
  });

  test('non-campaign HIT grants no XP', () => {
    const { state, attacker, defender } = battleSetup({ isCampaign: false });
    state.setForcedDice(3, 2, 3, 4);
    executeBattle(state, attacker, defender);
    assert.equal(attacker.xp, 0);
  });

  test('gang-up: each attacker ally gets a floored 25% share of the hit XP', () => {
    const { state, attacker, defender, atkAllies } = battleSetup({ attackerAllies: 2 });
    // atkPool = 3 dice (net +2), then 1 def die, then 2 dmg dice.
    // atk dice all 1 → base 1 + gangup flat 2 = attackRoll 3; def 2 → hit, not crush.
    state.setForcedDice(1, 1, 1, 2, 3, 4);
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.hit, true);
    assert.equal(r.killed, false);
    assert.equal(attacker.xp, XP_PER_HIT);                    // attacker: full
    for (const ally of atkAllies) assert.equal(ally.xp, share(XP_PER_HIT)); // each ally: 25%
  });

  test('splash kill grants the actor kill XP with NO ally share', () => {
    // attacker + ally (hero); main target survives the great-crush; a 1-HP
    // bystander sharing the target hex dies to the radius-0 splash. The bystander
    // is a defender-side (witch) unit: an enemy of the hero attacker (so the
    // splash hits it) AND adjacent ally of the witch defender (so it adds the
    // +1 defender advantage the forced dice below assume).
    const { state, attacker, defender, atkAllies, defenderOwner } = battleSetup({ attackerAllies: 1 });
    const bystander = combatant(defenderOwner, 2, 2);
    bystander.maxHp = 1; bystander.hp = 1;
    state.entities.push(bystander);
    // atkPool 2 dice (net +1), defPool 2 dice (net +1 from the bystander defAlly),
    // then 2 dmg dice. atk [6,6]→6+1=7; def [1,1]→1+1=2 → great crush, target lives.
    state.setForcedDice(6, 6, 1, 1, 3, 4, 3, 3);
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.killed, false, 'main target survives the crush');
    assert.ok(!state.entities.find(e => e.id === bystander.id), 'bystander killed by splash');
    // attacker = crush (25) + splash kill (50); ally = crush share only (no splash share)
    assert.equal(attacker.xp, XP_PER_CRUSH + XP_PER_KILL);
    assert.equal(atkAllies[0].xp, share(XP_PER_CRUSH));
  });
});

describe('battle XP hooks — defender side', () => {
  // Defender-side hooks award the DEFENDER, so flip the setup: the witch attacks
  // and the HERO defends (only the hero clears the owner gate). The dice math is
  // unchanged from the attacker-side block — the faction swap is symmetric.
  test('DEFEND (miss, no counter) grants XP_PER_DEFEND to the defender', () => {
    const { state, attacker, defender } = battleSetup({ attackerOwner: 'witch' });
    state.setForcedDice(2, 2); // tie → miss; 2 < 2×2 → no counter
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.hit, false);
    assert.equal(defender.xp, XP_PER_DEFEND);
    assert.equal(attacker.xp, 0);
  });

  test('gang-up: each defender ally gets a 25% share of the defend XP', () => {
    const { state, attacker, defender, defAllies } = battleSetup({ attackerOwner: 'witch', defenderAllies: 2 });
    // atkPool 1 die, defPool 3 dice (net +2). atk 2 → attackRoll 2; def [1,1,1] →
    // base 1 + gangup flat 2 = defenseRoll 3 → miss; 3 < 2×2 → no counter.
    state.setForcedDice(2, 1, 1, 1);
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.hit, false);
    assert.equal(defender.xp, XP_PER_DEFEND);
    for (const ally of defAllies) assert.equal(ally.xp, share(XP_PER_DEFEND));
  });

  test('COUNTER (miss + counter, attacker survives) grants defend + counter XP', () => {
    const { state, attacker, defender } = battleSetup({ attackerOwner: 'witch', attackerHp: 300 });
    state.setForcedDice(1, 3, 3, 4); // atk 1 vs def 3 → miss, 3 ≥ 2×1 → counter; cdmg 7
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.hit, false);
    assert.equal(r.counterDmg > 0, true);
    assert.equal(state.entities.includes(attacker), true, 'attacker survives the counter');
    assert.equal(defender.xp, XP_PER_DEFEND + XP_PER_COUNTER);
  });

  test('COUNTER-KILL grants defend + kill XP, REPLACING the counter grant', () => {
    const { state, attacker, defender } = battleSetup({ attackerOwner: 'witch', attackerHp: 5 });
    state.setForcedDice(1, 3, 3, 4); // counter; cdmg 7 ≥ 5 → attacker slain
    const r = executeBattle(state, attacker, defender);
    assert.ok(!state.entities.find(e => e.id === attacker.id), 'attacker slain by counter');
    assert.equal(defender.xp, XP_PER_DEFEND + XP_PER_KILL);          // defend + kill …
    assert.notEqual(defender.xp, XP_PER_DEFEND + XP_PER_COUNTER + XP_PER_KILL); // … not + counter
  });

  test('non-campaign counter grants no XP', () => {
    const { state, attacker, defender } = battleSetup({ attackerOwner: 'witch', isCampaign: false, attackerHp: 300 });
    state.setForcedDice(1, 3, 3, 4);
    executeBattle(state, attacker, defender);
    assert.equal(defender.xp, 0);
  });
});

describe('owner gate — non-hero units earn nothing in campaign', () => {
  // Phase C: XP/veterancy is a hero-only mechanic. Witch units never persist
  // across missions (campaign saves heroStats + survivors only), so witch
  // levelling has no progression payoff and only drifts mission difficulty — it
  // is gated out at the awardXP chokepoint, not per call site.
  test('awardXP on a witch unit is a no-op even in campaign', () => {
    const w = combatant('witch', 0, 0);
    const r = awardXP(w, XP_PER_KILL, { isCampaign: true });
    assert.equal(w.xp, 0);
    assert.equal(w.level, 1);
    assert.deepEqual(r, { xpGained: 0, leveledUp: false, newLevel: 1 });
  });

  test('a witch attacker earns 0 XP from a landed hit (battle hook gated)', () => {
    const { state, attacker, defender } = battleSetup({ attackerOwner: 'witch' });
    state.setForcedDice(3, 2, 3, 4); // hit, not crush; defender survives
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.hit, true);
    assert.equal(r.killed, false);
    assert.equal(attacker.xp, 0); // witch attacker: gated out at awardXP
  });

  test('a witch attacker earns 0 XP from a kill', () => {
    const { state, attacker, defender } = battleSetup({ attackerOwner: 'witch', defenderHp: 5 });
    state.setForcedDice(3, 2, 3, 4); // hit, dmg 7 ≥ 5 → kill
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.killed, true);
    assert.equal(attacker.xp, 0); // witch attacker: no kill XP
  });
});

describe('awardXP Infinity / NaN guard (B nit #1)', () => {
  const campaign = { isCampaign: true };
  function fresh() { const e = new Entity(EntityType.SURVIVOR, 'hero', 0, 0); e.xp = 0; e.level = 1; return e; }

  test('Infinity is rejected (does not poison xp)', () => {
    const e = fresh();
    const r = awardXP(e, Infinity, campaign);
    assert.equal(e.xp, 0);
    assert.equal(r.xpGained, 0);
    assert.equal(e.level, 1);
  });

  test('-Infinity is rejected', () => {
    const e = fresh();
    awardXP(e, -Infinity, campaign);
    assert.equal(e.xp, 0);
  });

  test('NaN is rejected', () => {
    const e = fresh();
    awardXP(e, NaN, campaign);
    assert.equal(e.xp, 0);
  });

  test('a normal finite amount still works', () => {
    const e = fresh();
    awardXP(e, 50, campaign);
    assert.equal(e.xp, 50);
  });
});

describe('hero veterancy round-trip (B nit #3)', () => {
  test('applyMissionResult carries hero level + xp into Campaign.heroStats', async () => {
    const { getCampaignById } = await import('../src/campaign/campaign-registry.js');
    const { Campaign } = await import('../src/campaign/campaign.js');
    const def = getCampaignById('calebs_hollow_prologue');
    const campaign = new Campaign(def);
    const missionId = campaign.currentMission;
    campaign.applyMissionResult(missionId, {
      won: true,
      survivors: [],
      resources: {},
      heroStats: {
        hp: 80, maxHp: 120, attack: 4, defense: 3,
        level: 3, xp: 700, weapon: 'sword', items: {},
      },
      flags: {},
    });
    assert.equal(campaign.heroStats.level, 3);
    assert.equal(campaign.heroStats.xp, 700);
  });

  test('applyCarriedHeroLoadout re-applies level + xp onto the fresh hero', async () => {
    const { applyCarriedHeroLoadout } = await import('../src/campaign/campaign.js');
    const hero = createHero(0, 0);
    const baseMaxHp = hero.maxHp;
    applyCarriedHeroLoadout(hero, {
      hp: 50, maxHp: hpForLevel(baseMaxHp, 3), level: 3, xp: 700,
      weapon: 'sword', items: {},
    });
    assert.equal(hero.level, 3, 'level restored');
    assert.equal(hero.xp, 700, 'xp restored');
    assert.equal(hero.maxHp, hpForLevel(baseMaxHp, 3), 'maxHp recomputed off the L1 base');
  });

  test('applyCarriedHeroLoadout is a no-op at level 1 (pre-veterancy saves unchanged)', async () => {
    const { applyCarriedHeroLoadout } = await import('../src/campaign/campaign.js');
    const hero = createHero(0, 0);
    const baseMaxHp = hero.maxHp;
    applyCarriedHeroLoadout(hero, { hp: baseMaxHp, maxHp: baseMaxHp, level: 1, xp: 0, items: {} });
    assert.equal(hero.level, 1);
    assert.equal(hero.maxHp, baseMaxHp);
  });
});
