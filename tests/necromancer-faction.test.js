// Necromancer faction — tests for the distinct mechanics implemented in
// NecromancerFaction: undead-only RAISE DEAD summons (skeleton conjuration on
// a seeded-random nearby hex / zombie raised at a recorded corpse), the
// death-location ledger feeding it (recorded at every kill path + serialized),
// POSSESS (control handoff, expiry, leader/range immunity), and TELEPORT
// (inaccurate warp into a clump, seeded determinism).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { GameState, Phase } from '../src/game.js';
import {
  ActionType, getValidActions, executeBattle, executeSummon,
  executePossess, executeTeleport, getTeleportClump, hasRaisableCorpse,
  RAISE_DEAD_RANGE, SKELETON_CONJURE_RANGE, POSSESS_RANGE, TELEPORT_RANGE,
} from '../src/actions.js';
import {
  EntityType, createSkeleton, createZombie, createSurvivor, createMinion,
} from '../src/entities.js';
import { applyEffect, hasEffect, tickEffects, possessorOf, canCommandEntity } from '../src/effects.js';
import { TileType, ResourceType, decomposeTileType } from '../src/tiles.js';
import { hexKey, hexDistance, hexRange, getNeighbors } from '../src/hex.js';
import { getFaction, NecromancerFaction, WitchFaction, isPlaceableTile } from '../src/factions.js';
import { PlanActionType, validatePlan, validatePlanAction } from '../src/planner.js';
import { resolvePlans } from '../server/resolver.js';
import { serializeState, deserializeState } from '../server/state-sync.js';
import { getItemCountOf, totalItemCount } from '../src/entities.js';

function freshState() {
  return new GameState(true, true);
}

function clearFootprint(tile) {
  if (!tile) return tile;
  tile.buildingFootprintOf = null;
  tile.footprintHexes = [];
  return tile;
}

// Remove every entity except `keep` and scrub surrounding tiles to plain
// grass so procedural-map noise (buildings, rivers, stray units) can't shift
// placement/summon/combat outcomes. Mirrors tests/brute-faction.test.js.
function isolateArena(state, keep, radius = 6) {
  state.entities = state.entities.filter(e => keep.includes(e));
  const center = keep[0];
  for (const [, t] of state.tiles) {
    if (hexDistance(t.col, t.row, center.col, center.row) <= radius) {
      decomposeTileType(t, TileType.GRASS);
      t.building = null; t.structure = null; t.fortifyLevel = 0;
      t.hiddenSurvivor = false;
      clearFootprint(t);
    }
  }
}

// Spawn a necromancer leader at (col, row) by swapping the night-side default.
function necroState(col = 6, row = 6) {
  const state = freshState();
  state.swapLeaderToFaction('night', 'necromancer');
  state.witch.col = col;
  state.witch.row = row;
  return { state, necro: state.witch };
}

function heroSurvivorAt(state, col, row, name = null) {
  const s = createSurvivor(col, row, 'hero', state, name);
  s.owner = 'hero';
  s.col = col; s.row = row;
  state.entities.push(s);
  return s;
}

// ── Faction class & registry ────────────────────────────────────────────────

describe('NecromancerFaction — class & registry', () => {
  test('getFaction("necromancer") returns a NecromancerFaction extending WitchFaction', () => {
    const f = getFaction('necromancer');
    assert.ok(f instanceof NecromancerFaction);
    assert.ok(f instanceof WitchFaction);
    assert.equal(f.id, 'necromancer');
    assert.equal(f.leaderType, EntityType.NECROMANCER);
  });

  test('necromancer is no longer a stub', () => {
    assert.equal(getFaction('necromancer').isStub(), false);
  });

  test('leader is born with summon + possess + teleport', () => {
    const { necro } = necroState();
    assert.ok(necro.hasAbility('summon'));
    assert.ok(necro.hasAbility('possess'));
    assert.ok(necro.hasAbility('teleport'));
  });

  test('unit roster is undead-only (zombie + skeleton)', () => {
    assert.deepEqual(getFaction('necromancer').getUnitTypes(),
      [EntityType.ZOMBIE, EntityType.SKELETON]);
  });

  test('getSummonOptions offers only zombie/skeleton — never golems or minions', () => {
    const rich = { wood: { count: 99 }, metal: { count: 99 } };
    const types = getFaction('necromancer').getSummonOptions(rich).map(o => o.summonType);
    assert.deepEqual(types.sort(), [EntityType.SKELETON, EntityType.ZOMBIE].sort());
    assert.ok(!types.includes(EntityType.IRON_GOLEM));
    assert.ok(!types.includes(EntityType.WOOD_GOLEM));
    assert.ok(!types.includes(EntityType.MINION));
  });

  test('getSummonOptions is empty when the pool cannot afford the cost', () => {
    assert.deepEqual(getFaction('necromancer').getSummonOptions({}), []);
    // Cheap bone tithe: 1 of any resource is enough (getMinionCost() === 1).
    assert.equal(getFaction('necromancer').getSummonOptions({ wood: { count: 1 } }).length, 2);
  });

  test('witch getSummonOptions is unchanged (golems + minion)', () => {
    const rich = { wood: { count: 99 }, metal: { count: 99 } };
    const types = getFaction('witch').getSummonOptions(rich).map(o => o.summonType);
    assert.deepEqual(types.sort(),
      [EntityType.IRON_GOLEM, EntityType.WOOD_GOLEM, EntityType.MINION].sort());
  });
});

// ── Skeleton unit ───────────────────────────────────────────────────────────

describe('Skeleton unit', () => {
  test('createSkeleton stats + tags (zombie/minion neighborhood, HP pre-scaled ×7)', () => {
    const state = freshState();
    const sk = createSkeleton(3, 3, 'witch', state);
    assert.equal(sk.type, EntityType.SKELETON);
    assert.equal(sk.owner, 'witch');
    assert.equal(sk.maxHp, 14);           // 2 logical HP × DAMAGE_SCALE(7), like the zombie
    assert.equal(sk.attack, 1);
    assert.equal(sk.defense, 1);
    assert.equal(sk.getAgility(), 4);
    assert.ok(sk.hasTag('undead'));
    assert.ok(sk.hasTag('summoned'));
    assert.equal(sk.displayName, 'Skeleton');
  });

  test('skeleton survives a serialize → deserialize round-trip with prototype + tags', () => {
    const state = freshState();
    const sk = createSkeleton(3, 3, 'witch', state);
    state.entities.push(sk);
    const restored = deserializeState(serializeState(state));
    const back = restored.entities.find(e => e.id === sk.id);
    assert.ok(back, 'skeleton restored');
    assert.equal(back.type, EntityType.SKELETON);
    assert.equal(typeof back.hasTag, 'function'); // prototype restored
    assert.ok(back.hasTag('undead'));
    assert.equal(back.getAgility(), 4);
  });
});

// ── Death-location ledger ───────────────────────────────────────────────────

describe('deathLocations — recorded at every kill path', () => {
  test('a battle kill records the victim grave (type/owner/ownerId/col/row/round)', () => {
    const { state, necro } = necroState(6, 6);
    const victim = heroSurvivorAt(state, 7, 6);
    isolateArena(state, [necro, victim]);
    victim.hp = 1;
    necro.attackBonus = 50; // guaranteed hit regardless of dice
    const r = executeBattle(state, necro, victim);
    assert.equal(r.killed, true);
    const grave = state.deathLocations.find(d => d.id === victim.id);
    assert.ok(grave, 'grave recorded');
    assert.equal(grave.type, EntityType.SURVIVOR);
    assert.equal(grave.owner, 'hero');
    assert.equal(grave.ownerId, 'hero');
    assert.equal(grave.col, 7);
    assert.equal(grave.row, 6);
    assert.equal(grave.round, state.round);
  });

  test('a counter kill records the slain ATTACKER', () => {
    const { state, necro } = necroState(6, 6);
    const attacker = createZombie(7, 6, 'witch', state);
    state.entities.push(attacker);
    const defender = heroSurvivorAt(state, 7, 7);
    isolateArena(state, [necro, attacker, defender]);
    attacker.hp = 1;
    defender.defenseBonus = 50; // guaranteed miss AND defense ≥ 2× attack → counter
    const r = executeBattle(state, attacker, defender);
    assert.equal(r.hit, false);
    assert.ok(r.counterDmg > 0, 'counter fired');
    const grave = state.deathLocations.find(d => d.id === attacker.id);
    assert.ok(grave, 'attacker grave recorded');
    assert.equal(grave.col, 7);
    assert.equal(grave.row, 6);
  });

  test('a splash kill records the bystander grave', () => {
    // Melee attacker — ranged attacks (the necromancer's magic bolt) never
    // splash, so the blast needs a zombie swinging fists.
    const { state, necro } = necroState(6, 6);
    const attacker = createZombie(7, 7, 'witch', state);
    state.entities.push(attacker);
    const target = heroSurvivorAt(state, 7, 6);
    const bystander = heroSurvivorAt(state, 7, 6);
    isolateArena(state, [necro, attacker, target, bystander]);
    target.hp = 1;
    bystander.hp = 1; // vanilla splash chip is 2d6 ≥ 2, always lethal at 1 HP
    attacker.attackBonus = 50;
    const r = executeBattle(state, attacker, target);
    assert.equal(r.killed, true);
    assert.ok(r.splashKills.some(k => k.id === bystander.id), 'bystander splashed dead');
    assert.ok(state.deathLocations.some(d => d.id === bystander.id), 'bystander grave recorded');
  });

  test('a DOT death (poison tick) records the grave', () => {
    const { state, necro } = necroState(6, 6);
    const victim = heroSurvivorAt(state, 8, 8);
    isolateArena(state, [necro, victim]);
    victim.hp = 1;
    applyEffect(victim, 'poisoned');
    tickEffects(state);
    assert.ok(!state.entities.some(e => e.id === victim.id), 'victim removed');
    const grave = state.deathLocations.find(d => d.id === victim.id);
    assert.ok(grave, 'DOT grave recorded');
    assert.equal(grave.col, 8);
    assert.equal(grave.row, 8);
  });

  test('graves are deduped by entity id', () => {
    const state = freshState();
    const z = createZombie(2, 2, 'witch', state);
    state.recordDeathLocation(z);
    state.recordDeathLocation(z);
    assert.equal(state.deathLocations.filter(d => d.id === z.id).length, 1);
  });

  test('deathLocations (incl. consumed flags) survive a serialize round-trip', () => {
    const state = freshState();
    state.deathLocations.push(
      { id: 'e900', type: 'survivor', owner: 'hero', ownerId: 'hero', col: 4, row: 5, round: 3 },
      { id: 'e901', type: 'zombie', owner: 'witch', ownerId: 'witch', col: 6, row: 5, round: 4, consumed: true },
    );
    const restored = deserializeState(serializeState(state));
    assert.equal(restored.deathLocations.length, 2);
    assert.deepEqual(restored.deathLocations[0],
      { id: 'e900', type: 'survivor', owner: 'hero', ownerId: 'hero', col: 4, row: 5, round: 3 });
    assert.equal(restored.deathLocations[1].consumed, true);
    // Legacy snapshot without the field → empty ledger, no crash.
    const snap = serializeState(state);
    delete snap.deathLocations;
    assert.deepEqual(deserializeState(snap).deathLocations, []);
  });
});

// ── RAISE DEAD (executeSummon) ──────────────────────────────────────────────

describe('RAISE DEAD — necromancer summons', () => {
  test('a fresh summon conjures a Skeleton on a seeded-random open hex within 2', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    // Recompute the executor's candidate list independently to pin the pick.
    const candidates = hexRange(necro.col, necro.row, SKELETON_CONJURE_RANGE).filter(h => {
      if (h.col === necro.col && h.row === necro.row) return false;
      if (!isPlaceableTile(state, h.col, h.row, necro.owner)) return false;
      return !state.entities.some(e => e.alive && e.col === h.col && e.row === h.row);
    });
    assert.ok(candidates.length >= 3, 'arena has open hexes');
    state.setForcedDice(3); // nextDie(candidates.length) → 3 → candidates[2]
    const r = executeSummon(state, necro, EntityType.SKELETON);
    assert.equal(r.success, true);
    assert.equal(r.summonedType, EntityType.SKELETON);
    assert.deepEqual({ col: r.spawnCol, row: r.spawnRow },
      { col: candidates[2].col, row: candidates[2].row });
    const sk = state.entities.find(e => e.type === EntityType.SKELETON);
    assert.ok(sk, 'skeleton on the board');
    assert.ok(hexDistance(necro.col, necro.row, sk.col, sk.row) <= SKELETON_CONJURE_RANGE);
    assert.equal(sk.ownerId, necro.ownerId);
    assert.equal(state.witchSummonCount, 1);
    // Necromancer economics: 1 of any resource per summon (cheap undead chaff).
    assert.equal(r.spent.reduce((s, e) => s + e.amount, 0), 1);
    assert.equal(totalItemCount(state.inventory.witch), 3); // started with 4
  });

  test('RAISE DEAD raises a corpse within 3 as a Zombie AT its death hex and consumes it', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    state.deathLocations.push({ id: 'e800', type: 'survivor', owner: 'hero', ownerId: 'hero', col: 8, row: 6, round: 2 });
    assert.ok(hasRaisableCorpse(state, necro));
    const r = executeSummon(state, necro, EntityType.ZOMBIE);
    assert.equal(r.success, true);
    assert.equal(r.summonedType, EntityType.ZOMBIE);
    assert.equal(r.raisedFromCorpse, true);
    assert.deepEqual({ col: r.spawnCol, row: r.spawnRow }, { col: 8, row: 6 });
    const z = state.entities.find(e => e.type === EntityType.ZOMBIE && e.col === 8 && e.row === 6);
    assert.ok(z, 'zombie stands on the grave');
    assert.equal(z.owner, 'witch');
    assert.equal(state.deathLocations[0].consumed, true, 'corpse consumed');
    // A second raise finds no corpse — a FRESH zombie claws up nearby instead.
    assert.equal(hasRaisableCorpse(state, necro), false);
    const r2 = executeSummon(state, necro, EntityType.ZOMBIE);
    assert.equal(r2.success, true);
    assert.equal(r2.summonedType, EntityType.ZOMBIE, 'a zombie summon no longer needs a corpse');
    assert.ok(!r2.raisedFromCorpse, 'flagged as a fresh summon, not a corpse raise');
    assert.ok(hexDistance(necro.col, necro.row, r2.spawnCol, r2.spawnRow) <= SKELETON_CONJURE_RANGE,
      'fresh zombie rises within conjure range of the necromancer');
  });

  test('a corpse-less ZOMBIE summon conjures fresh on a seeded-random open hex within 2, at skeleton cost', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    assert.equal(state.deathLocations.length, 0, 'fixture: no graves anywhere');
    // Recompute the executor's candidate list independently to pin the pick
    // (same enumeration as the skeleton-conjure test above).
    const candidates = hexRange(necro.col, necro.row, SKELETON_CONJURE_RANGE).filter(h => {
      if (h.col === necro.col && h.row === necro.row) return false;
      if (!isPlaceableTile(state, h.col, h.row, necro.owner)) return false;
      return !state.entities.some(e => e.alive && e.col === h.col && e.row === h.row);
    });
    assert.ok(candidates.length >= 3, 'arena has open hexes');
    state.setForcedDice(3); // nextDie(candidates.length) → 3 → candidates[2]
    const r = executeSummon(state, necro, EntityType.ZOMBIE);
    assert.equal(r.success, true);
    assert.equal(r.summonedType, EntityType.ZOMBIE);
    assert.ok(!r.raisedFromCorpse);
    assert.deepEqual({ col: r.spawnCol, row: r.spawnRow },
      { col: candidates[2].col, row: candidates[2].row },
      'fresh zombie rides the same seeded spawn pick as the skeleton path (state.nextDie, never Math.random)');
    const z = state.entities.find(e => e.type === EntityType.ZOMBIE);
    assert.ok(z, 'zombie on the board');
    assert.equal(z.ownerId, necro.ownerId);
    assert.equal(r.spent.reduce((s, e) => s + e.amount, 0), 1,
      'same 1-any-resource cost as a skeleton (getMinionCost)');
    assert.equal(state.witchSummonCount, 1);
  });

  test('corpses beyond RAISE_DEAD_RANGE and leader corpses are never raised — the zombie rises fresh instead', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    state.deathLocations.push(
      { id: 'e801', type: 'survivor', owner: 'hero', ownerId: 'hero', col: 6 + RAISE_DEAD_RANGE + 1, row: 6, round: 1 },
      { id: 'e802', type: 'paladin', owner: 'hero', ownerId: 'hero', col: 7, row: 6, round: 1 },
    );
    assert.equal(hasRaisableCorpse(state, necro), false);
    const r = executeSummon(state, necro, EntityType.ZOMBIE);
    assert.equal(r.success, true);
    assert.equal(r.summonedType, EntityType.ZOMBIE, 'fresh conjure — no grave in reach');
    assert.ok(!r.raisedFromCorpse);
    assert.ok(!state.deathLocations.some(d => d.consumed), 'no grave consumed');
    assert.ok(hexDistance(necro.col, necro.row, r.spawnCol, r.spawnRow) <= SKELETON_CONJURE_RANGE);
  });

  test('auto-pick (summonType null — the AI path) prefers a corpse raise, else skeleton', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    state.deathLocations.push({ id: 'e803', type: 'minion', owner: 'witch', ownerId: 'witch', col: 5, row: 6, round: 1 });
    const r1 = executeSummon(state, necro, null);
    assert.equal(r1.summonedType, EntityType.ZOMBIE, 'corpse available → zombie');
    const r2 = executeSummon(state, necro, null);
    assert.equal(r2.summonedType, EntityType.SKELETON, 'corpse spent → skeleton');
  });

  test('the necromancer can never summon golems or minions, even by request', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    const r = executeSummon(state, necro, EntityType.IRON_GOLEM);
    assert.equal(r.success, true);
    assert.notEqual(state.entities.some(e => e.type === EntityType.IRON_GOLEM), true);
    assert.equal(r.summonedType, EntityType.SKELETON, 'request degraded to an allowed type');
  });

  test('summon fails cleanly when the shared pool is empty', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    state.inventory.witch = {};
    const r = executeSummon(state, necro, EntityType.SKELETON);
    assert.equal(r.success, false);
    assert.match(r.log[0], /resource/i);
  });

  test('witch summons are unchanged by the rework (metal → iron golem)', () => {
    const state = freshState();
    const witch = state.witch;
    isolateArena(state, [witch]);
    const r = executeSummon(state, witch, EntityType.IRON_GOLEM);
    assert.equal(r.success, true);
    assert.ok(state.entities.some(e => e.type === EntityType.IRON_GOLEM));
    assert.deepEqual(r.spent, [{ type: ResourceType.METAL, amount: 2 }]);
  });
});

// ── POSSESS ─────────────────────────────────────────────────────────────────

describe('POSSESS — control for one round', () => {
  test('possessing an enemy unit applies the effect with the possessor as source', () => {
    const { state, necro } = necroState(6, 6);
    const victim = heroSurvivorAt(state, 7, 6);
    isolateArena(state, [necro, victim]);
    const r = executePossess(state, necro, victim.id);
    assert.equal(r.success, true);
    assert.ok(hasEffect(victim, 'possessed'));
    assert.equal(possessorOf(victim), necro.ownerId);
    assert.equal(r.targetId, victim.id);
    assert.equal(r.cost, 1);
  });

  test('leaders are immune; allies and out-of-range targets are rejected', () => {
    const { state, necro } = necroState(6, 6);
    const far = heroSurvivorAt(state, 6 + POSSESS_RANGE + 2, 6);
    const minion = createMinion(7, 6, 'witch', state);
    state.entities.push(minion);
    isolateArena(state, [necro, far, minion, state.hero]);
    state.hero.col = 7; state.hero.row = 7;
    assert.equal(executePossess(state, necro, state.hero.id).success, false, 'leader immune');
    assert.equal(executePossess(state, necro, minion.id).success, false, 'ally rejected');
    assert.equal(executePossess(state, necro, far.id).success, false, 'range rejected');
    assert.equal(executePossess(state, necro, 'nope').success, false, 'missing target rejected');
  });

  test('control handoff: validatePlan accepts the possessor and locks out the true owner', () => {
    const { state, necro } = necroState(6, 6);
    const victim = heroSurvivorAt(state, 7, 6);
    isolateArena(state, [necro, victim, state.hero]);
    executePossess(state, necro, victim.id);

    const plan = [{ type: PlanActionType.GUARD, entityId: victim.id }];
    // The possessor (offline synthetic playerId 'witch') may command it…
    assert.equal(validatePlan(state, 'witch', plan).valid, true);
    // …its true owner may NOT.
    const rejected = validatePlan(state, 'hero', plan);
    assert.equal(rejected.valid, false);
    assert.match(rejected.reason, /possessed/i);
    // canCommandEntity agrees for the offline faction path.
    assert.equal(canCommandEntity(state, victim, { faction: 'witch' }), true);
    assert.equal(canCommandEntity(state, victim, { faction: 'hero' }), false);
  });

  test('resolver executes the possessor\'s orders and fails the owner\'s', () => {
    const { state, necro } = necroState(6, 6);
    const victim = heroSurvivorAt(state, 7, 6);
    isolateArena(state, [necro, victim, state.hero]);
    state.hero.col = 12; state.hero.row = 12;
    executePossess(state, necro, victim.id);

    const guardsBefore = victim.guarding || 0;
    const steps = resolvePlans(
      state,
      [{ type: PlanActionType.GUARD, entityId: victim.id }],   // true owner tries…
      [{ type: PlanActionType.GUARD, entityId: victim.id }],   // …and so does the possessor
    );
    const heroEvents  = steps.flatMap(s => s.heroEvents);
    const witchEvents = steps.flatMap(s => s.witchEvents);
    assert.ok(heroEvents.some(ev => ev.type === 'action_fail' && /possessed/i.test(ev.reason)),
      'owner order failed with a possessed reason');
    assert.ok(witchEvents.some(ev => ev.type === 'action_ok'), 'possessor order executed');
    assert.equal(victim.guarding, guardsBefore + 1, 'exactly one guard applied');
  });

  test('possession expires after ONE full round in the possessor\'s hands', () => {
    const { state, necro } = necroState(6, 6);
    const victim = heroSurvivorAt(state, 7, 6);
    isolateArena(state, [necro, victim, state.hero]);
    state.hero.col = 12; state.hero.row = 12;
    executePossess(state, necro, victim.id);           // resolves in round N

    state.endRound();                                   // end of round N
    assert.ok(hasEffect(victim, 'possessed'), 'still possessed through round N+1');
    assert.equal(canCommandEntity(state, victim, { faction: 'witch' }), true);

    state.endRound();                                   // end of round N+1
    assert.equal(hasEffect(victim, 'possessed'), false, 'expired at the end of round N+1');
    assert.equal(canCommandEntity(state, victim, { faction: 'hero' }), true, 'owner regains control');
    assert.equal(canCommandEntity(state, victim, { faction: 'witch' }), false);
  });

  test('getValidActions offers POSSESS with enemy non-leaders in range', () => {
    const { state, necro } = necroState(6, 6);
    const near = heroSurvivorAt(state, 7, 6);
    isolateArena(state, [necro, near, state.hero]);
    state.hero.col = 7; state.hero.row = 6; // leader adjacent but must be excluded
    const acts = getValidActions(state, necro);
    const possess = acts.find(a => a.type === ActionType.POSSESS);
    assert.ok(possess, 'POSSESS offered');
    assert.ok(possess.targets.some(t => t.id === near.id));
    assert.ok(!possess.targets.some(t => t.id === state.hero.id), 'leader not offered');
  });
});

// ── TELEPORT ────────────────────────────────────────────────────────────────

describe('TELEPORT — inaccurate warp', () => {
  test('lands on a seeded clump member; clump = center + open neighbors', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    const center = { col: 8, row: 6 };
    const clump = getTeleportClump(state, necro, center.col, center.row);
    assert.ok(clump.length >= 3, 'open arena has a healthy clump');
    // Every clump hex is the center or one of its neighbors.
    const legal = new Set([hexKey(center.col, center.row),
      ...getNeighbors(center.col, center.row).map(n => hexKey(n.col, n.row))]);
    for (const h of clump) assert.ok(legal.has(hexKey(h.col, h.row)));

    state.setForcedDice(2); // → clump[1]
    const r = executeTeleport(state, necro, center.col, center.row);
    assert.equal(r.success, true);
    assert.deepEqual({ col: r.toCol, row: r.toRow }, { col: clump[1].col, row: clump[1].row });
    assert.deepEqual({ col: necro.col, row: necro.row }, { col: clump[1].col, row: clump[1].row });
    assert.equal(r.centerCol, center.col);
    assert.equal(r.fromCol, 6);
  });

  test('seeded determinism: same forced die → same arrival, different die → different member', () => {
    const mk = () => {
      const { state, necro } = necroState(6, 6);
      isolateArena(state, [necro]);
      return { state, necro };
    };
    const a = mk(); a.state.setForcedDice(1);
    const b = mk(); b.state.setForcedDice(1);
    const c = mk(); c.state.setForcedDice(3);
    const ra = executeTeleport(a.state, a.necro, 8, 6);
    const rb = executeTeleport(b.state, b.necro, 8, 6);
    const rc = executeTeleport(c.state, c.necro, 8, 6);
    assert.deepEqual({ col: ra.toCol, row: ra.toRow }, { col: rb.toCol, row: rb.toRow });
    assert.notDeepEqual({ col: ra.toCol, row: ra.toRow }, { col: rc.toCol, row: rc.toRow });
  });

  test('occupied and impassable hexes are excluded from the clump', () => {
    const { state, necro } = necroState(6, 6);
    const squatter = createZombie(8, 6, 'witch', state);
    state.entities.push(squatter);
    isolateArena(state, [necro, squatter]);
    // Make one neighbor a river too.
    const n0 = getNeighbors(8, 6)[0];
    decomposeTileType(state.tiles.get(hexKey(n0.col, n0.row)), TileType.RIVER);
    const clump = getTeleportClump(state, necro, 8, 6);
    assert.ok(!clump.some(h => h.col === 8 && h.row === 6), 'occupied center excluded');
    assert.ok(!clump.some(h => h.col === n0.col && h.row === n0.row), 'river excluded');
  });

  test('rejects a center beyond TELEPORT_RANGE and a fully-blocked clump', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    const far = executeTeleport(state, necro, 6 + TELEPORT_RANGE + 1, 6);
    assert.equal(far.success, false);
    // Drown the whole clump.
    const center = { col: 8, row: 6 };
    decomposeTileType(state.tiles.get(hexKey(center.col, center.row)), TileType.RIVER);
    for (const n of getNeighbors(center.col, center.row)) {
      const t = state.tiles.get(hexKey(n.col, n.row));
      if (t) decomposeTileType(t, TileType.RIVER);
    }
    const blocked = executeTeleport(state, necro, center.col, center.row);
    assert.equal(blocked.success, false);
    assert.match(blocked.log[0], /no safe ground/i);
  });

  test('plan validation: TELEPORT range-checked, POSSESS leader/ally-checked', () => {
    const { state, necro } = necroState(6, 6);
    const victim = heroSurvivorAt(state, 7, 6);
    isolateArena(state, [necro, victim, state.hero]);
    state.hero.col = 7; state.hero.row = 7;

    assert.equal(validatePlanAction(state,
      { type: PlanActionType.TELEPORT, entityId: necro.id, targetCol: 8, targetRow: 6 }).valid, true);
    assert.equal(validatePlanAction(state,
      { type: PlanActionType.TELEPORT, entityId: necro.id, targetCol: 6 + TELEPORT_RANGE + 1, targetRow: 6 }).valid, false);
    assert.equal(validatePlanAction(state,
      { type: PlanActionType.POSSESS, entityId: necro.id, targetId: victim.id }).valid, true);
    assert.equal(validatePlanAction(state,
      { type: PlanActionType.POSSESS, entityId: necro.id, targetId: state.hero.id }).valid, false);
  });

  test('getValidActions offers TELEPORT centers within range', () => {
    const { state, necro } = necroState(6, 6);
    isolateArena(state, [necro]);
    const acts = getValidActions(state, necro);
    const tp = acts.find(a => a.type === ActionType.TELEPORT);
    assert.ok(tp, 'TELEPORT offered');
    assert.ok(tp.targets.length > 0);
    for (const t of tp.targets) {
      assert.ok(hexDistance(necro.col, necro.row, t.col, t.row) <= TELEPORT_RANGE);
    }
  });
});
