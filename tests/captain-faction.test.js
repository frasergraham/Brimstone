// Captain faction — troop commander on the day side.
// Covers: CALL REINFORCEMENTS (SUMMON of soldier pairs), MARCH (leader +
// co-located soldiers move as one action), BUILD_SIEGE (catapult), the
// survivor-discovery penalty, the bigger action economy, the immobile-unit
// mechanic, and serialization round-trips for the new entity types.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase, computeActions, computeActionsForPlayer } from '../src/game.js';
import {
  executeMove, executeMarch, executeSummon, executeBuildSiege, executeBattle,
  executeSoundHorn,
  findSiegeSpawnHex, survivorFindMultiplier, getValidActions, getReachableHexes,
  ActionType,
} from '../src/actions.js';
import {
  HeroEnginePlanSimState, assessHeroBoard, genExplore, fillGapsHero,
} from '../src/hero-ai-engine.js';
import {
  Entity, EntityType, createSoldier, createCatapult, createZombie,
} from '../src/entities.js';
import { isImmobileType, UNIT_TYPES } from '../src/unit-types.js';
import {
  getFaction, CaptainFaction, HeroFaction,
  CAPTAIN_REINFORCEMENT_COST, CAPTAIN_REINFORCEMENT_COUNT,
  SIEGE_WOOD_COST, SIEGE_METAL_COST,
} from '../src/factions.js';
import { PlanActionType, computeGhostState, validatePlanAction, computeProjectedInventory } from '../src/planner.js';
import { ResourceType, TileType, legacyTileType, isBuildingFootprint, tileCapacityRemaining } from '../src/tiles.js';
import { hexKey, getNeighbors, hexDistance } from '../src/hex.js';
import { ITEMS } from '../src/items.js';
import { serializeState, deserializeState } from '../server/state-sync.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function captainState() {
  const state = new GameState(true, true);
  state.swapLeaderToFaction('day', 'captain');
  state.fogOfWar = 'none';
  return state;
}

function clearFootprint(tile) {
  if (!tile) return tile;
  tile.buildingFootprintOf = null;
  tile.footprintHexes = [];
  return tile;
}

// A passable, entity-free neighbor normalized to full capacity (no trees).
function clearNeighbor(state, entity) {
  const n = getNeighbors(entity.col, entity.row).find(nb => {
    const t = state.tiles.get(hexKey(nb.col, nb.row));
    if (!t || legacyTileType(t) === TileType.RIVER || isBuildingFootprint(t)) return false;
    return !state.entities.some(e => e.alive && e.col === nb.col && e.row === nb.row);
  }) ?? null;
  if (n) {
    const t = clearFootprint(state.tiles.get(hexKey(n.col, n.row)));
    t.blockedSlots = [];
    // Deterministic fixtures: no surprise survivor discovery eating a slot.
    t.hiddenSurvivor = false;
  }
  return n;
}

function giveFood(state, n) {
  state.inventory.hero[ResourceType.FOOD] = { count: n };
}

// ── Faction shape ────────────────────────────────────────────────────────────

describe('CaptainFaction — shape', () => {
  const captain = getFaction('captain');

  test('captain is a real (non-stub) day-side faction with the troop kit', () => {
    assert.ok(captain instanceof CaptainFaction);
    assert.ok(captain instanceof HeroFaction);
    assert.equal(captain.isStub(), false);
    assert.equal(captain.canSummon(), true);
    assert.equal(captain.canMarch(), true);
    assert.equal(captain.canBuildSiege(), true);
    // Other day factions keep the defaults.
    assert.equal(getFaction('hero').canSummon(), false);
    assert.equal(getFaction('hero').canMarch(), false);
    assert.equal(getFaction('hero').canBuildSiege(), false);
  });

  test('leader is personally weaker than the paladin but sword-armed and summon-trained', () => {
    const c = captain.createLeader(0, 0, 'p1');
    const p = getFaction('hero').createLeader(0, 0, 'p1');
    assert.ok(c.maxHp < p.maxHp, 'captain HP below paladin');
    assert.ok(c.getAttack() < p.getAttack(), 'captain effective ATK below paladin');
    assert.equal(c.getEquippedWeaponId(), 'sword');
    assert.ok(c.hasAbility('summon'), 'captain carries the summon ability');
    assert.ok(c.hasAbility('sound_horn'), 'captain keeps the day-side horn training');
    assert.equal(c.factionId, 'captain');
  });

  test('getSummonOptions offers exactly soldiers, keyed on food affordability', () => {
    const broke = captain.getSummonOptions({});
    assert.deepEqual(broke, [{ summonType: EntityType.SOLDIER, affordable: false }]);
    const rich = captain.getSummonOptions({ [ResourceType.FOOD]: { count: CAPTAIN_REINFORCEMENT_COST } });
    assert.deepEqual(rich, [{ summonType: EntityType.SOLDIER, affordable: true }]);
  });

  test('survivorFindMultiplier hook: captain 0.4, defaults 1.0', () => {
    assert.equal(captain.survivorFindMultiplier(), 0.4);
    assert.equal(getFaction('hero').survivorFindMultiplier(), 1.0);
    assert.equal(getFaction('witch').survivorFindMultiplier(), 1.0);
  });

  test('canSoundHorn(): captain vetoed, every other faction keeps the default', () => {
    assert.equal(captain.canSoundHorn(), false);
    assert.equal(getFaction('hero').canSoundHorn(), true);
    assert.equal(getFaction('witch').canSoundHorn(), true);
    assert.equal(getFaction('rogue').canSoundHorn(), true);
  });
});

// ── Sound Horn veto ──────────────────────────────────────────────────────────
// The captain stays horn-TRAINED (keeps the day-side `sound_horn` ability and
// the issued Horn item, so leader creation and campaign loadouts are stable)
// but the ACTION is faction-vetoed via `canSoundHorn()`: his food funds
// troops, not horn calls.

describe('Sound Horn — captain veto (canSoundHorn predicate)', () => {
  test('getValidActions never offers SOUND_HORN to the captain, even with horn + food', () => {
    const state = captainState();
    giveFood(state, 5);
    assert.ok(state.hero.hasItem('horn'), 'fixture: the captain still carries the Horn item');
    const acts = getValidActions(state, state.hero);
    assert.equal(acts.find(a => a.type === ActionType.SOUND_HORN), undefined,
      'no Sound Horn on the captain\'s action arc');

    // Control: the paladin (default day faction) keeps the action.
    const palState = new GameState(true, true);
    giveFood(palState, 5);
    assert.ok(getValidActions(palState, palState.hero).find(a => a.type === ActionType.SOUND_HORN),
      'the paladin\'s Sound Horn is untouched');
  });

  test('executeSoundHorn rejects the captain server-side without spending food', () => {
    const state = captainState();
    giveFood(state, 5);
    const r = executeSoundHorn(state, state.hero);
    assert.equal(r.success, false, 'a hand-crafted online SOUND_HORN plan cannot slip through');
    assert.equal(state.inventory.hero[ResourceType.FOOD].count, 5, 'no food spent');
    assert.ok(!state.heroRevealedByHorn, 'a vetoed horn never reveals the hero');
  });

  test('hero AI: captain plans call reinforcements at 2 food (horn reserve dropped), never a horn', () => {
    const state = captainState();
    giveFood(state, CAPTAIN_REINFORCEMENT_COST);   // exactly the summon cost — no horn reserve needed
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);
    const actions = genExplore(sim, board, 4);
    assert.equal(actions.find(a => a.type === PlanActionType.SOUND_HORN), undefined,
      'the AI never queues a doomed horn action as captain');
    const summon = actions.find(a => a.type === PlanActionType.SUMMON);
    assert.ok(summon, '2 food suffices for CALL REINFORCEMENTS once the 1-horn food reserve is dropped');
    assert.equal(summon.summonType, EntityType.SOLDIER);
  });

  test('hero AI gap-fill never queues a horn for the captain', () => {
    const state = captainState();
    giveFood(state, 5);
    const sim = new HeroEnginePlanSimState(state);
    const board = assessHeroBoard(sim);
    const heroEntity = sim.entities.find(e => e.id === board.hero.id);
    const plan = [];
    fillGapsHero(plan, sim, board, heroEntity, 3, new Map());
    assert.equal(plan.find(a => a.type === PlanActionType.SOUND_HORN), undefined);
  });
});

// ── CALL REINFORCEMENTS ──────────────────────────────────────────────────────

describe('CALL REINFORCEMENTS (executeSummon, soldier path)', () => {
  test('spawns 2 soldiers on/adjacent to the captain and deducts 2 food', () => {
    const state = captainState();
    giveFood(state, 3);

    const r = executeSummon(state, state.hero, EntityType.SOLDIER);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1);
    assert.equal(r.summonedIds.length, CAPTAIN_REINFORCEMENT_COUNT);
    assert.deepEqual(r.spent, [{ type: ResourceType.FOOD, amount: CAPTAIN_REINFORCEMENT_COST }]);
    assert.equal(state.inventory.hero[ResourceType.FOOD].count, 1, 'exactly 2 food consumed');

    const soldiers = state.entities.filter(e => e.type === EntityType.SOLDIER);
    assert.equal(soldiers.length, 2);
    for (const s of soldiers) {
      assert.equal(s.owner, 'hero');
      assert.ok(hexDistance(s.col, s.row, state.hero.col, state.hero.row) <= 1,
        'soldiers muster on or beside the captain');
    }
  });

  test('auto-pick (no requested type) resolves to soldiers for a day-side summoner', () => {
    const state = captainState();
    giveFood(state, 2);
    const r = executeSummon(state, state.hero, null);
    assert.equal(r.success, true);
    assert.equal(state.entities.filter(e => e.type === EntityType.SOLDIER).length, 2);
  });

  test('fails without spending when food is short', () => {
    const state = captainState();
    giveFood(state, CAPTAIN_REINFORCEMENT_COST - 1);
    const r = executeSummon(state, state.hero, EntityType.SOLDIER);
    assert.equal(r.success, false);
    assert.match(r.log[0], /food/i);
    assert.equal(state.inventory.hero[ResourceType.FOOD].count, CAPTAIN_REINFORCEMENT_COST - 1);
    assert.equal(state.entities.filter(e => e.type === EntityType.SOLDIER).length, 0);
  });

  test('the paladin cannot summon soldiers (empty allowed set)', () => {
    const state = new GameState(true, true);
    giveFood(state, 10);
    const r = executeSummon(state, state.hero, EntityType.SOLDIER);
    assert.equal(r.success, false);
    assert.equal(state.entities.filter(e => e.type === EntityType.SOLDIER).length, 0);
  });

  test('the tutorial witch-summon leash does not throttle the captain', () => {
    const state = captainState();
    state.maxWitchSummons = 0;   // learn-to-play leash — night-side only
    state.witchSummonCount = 5;
    giveFood(state, 2);
    const r = executeSummon(state, state.hero, EntityType.SOLDIER);
    assert.equal(r.success, true, 'day-side reinforcements ignore the witch leash');
  });

  test('getValidActions surfaces the soldier summon option for the captain only', () => {
    const state = captainState();
    giveFood(state, 2);
    const opts = getValidActions(state, state.hero).filter(a => a.type === ActionType.SUMMON);
    assert.deepEqual(opts.map(o => o.summonType), [EntityType.SOLDIER]);
    assert.equal(opts[0].affordable, true);

    const paladinState = new GameState(true, true);
    const none = getValidActions(paladinState, paladinState.hero).filter(a => a.type === ActionType.SUMMON);
    assert.equal(none.length, 0);
  });

  test('computeProjectedInventory charges soldier summons to the day-side food pool', () => {
    const state = captainState();
    giveFood(state, 4);
    const plan = [{ type: PlanActionType.SUMMON, entityId: state.hero.id, summonType: EntityType.SOLDIER }];
    const proj = computeProjectedInventory(state, plan);
    assert.equal(proj.hero[ResourceType.FOOD].count, 2);
  });
});

// ── MARCH ────────────────────────────────────────────────────────────────────

describe('MARCH (executeMarch)', () => {
  function marchFixture() {
    const state = captainState();
    const cap = state.hero;
    const s1 = createSoldier(cap.col, cap.row, cap.ownerId, state);
    const s2 = createSoldier(cap.col, cap.row, cap.ownerId, state);
    state.entities.push(s1, s2);
    return { state, cap, s1, s2 };
  }

  test('moves the captain and every soldier on his starting hex in one action', () => {
    const { state, cap, s1, s2 } = marchFixture();
    const dest = clearNeighbor(state, cap);
    assert.ok(dest, 'fixture needs a passable neighbor');

    const r = executeMarch(state, cap, dest.col, dest.row);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1, 'March costs a single action');
    assert.equal(cap.col, dest.col);
    assert.equal(cap.row, dest.row);
    assert.equal(r.marchPassengers.length, 2);
    for (const s of [s1, s2]) {
      assert.equal(s.col, dest.col, 'soldier marched with the captain');
      assert.equal(s.row, dest.row);
    }
    assert.deepEqual(r.marchLeftBehind, []);
  });

  test('soldiers on other hexes are not picked up', () => {
    const { state, cap, s1 } = marchFixture();
    const dest = clearNeighbor(state, cap);
    assert.ok(dest);
    // Move s1 off the captain's hex before the march.
    const elsewhere = getNeighbors(cap.col, cap.row).find(n => n.col !== dest.col || n.row !== dest.row);
    s1.col = elsewhere.col; s1.row = elsewhere.row;

    const r = executeMarch(state, cap, dest.col, dest.row);
    assert.equal(r.success, true);
    assert.equal(r.marchPassengers.length, 1, 'only the co-located soldier marches');
    assert.equal(s1.col, elsewhere.col, 'distant soldier holds position');
  });

  test('overflow passengers stay behind when the destination hex fills up', () => {
    const { state, cap, s1, s2 } = marchFixture();
    const dest = clearNeighbor(state, cap);
    assert.ok(dest);
    // Fill the destination so that exactly TWO slots stay free (captain +
    // one passenger): the first passenger fits, the second stays behind.
    // Capacity is tile-dependent (roads/buildings reserve slots), so derive
    // the filler count from the tile's actual free capacity.
    const destTile = state.tiles.get(hexKey(dest.col, dest.row));
    const free = tileCapacityRemaining(destTile, 0);
    assert.ok(free >= 3, `fixture: destination needs >=3 free slots (has ${free})`);
    for (let i = 0; i < free - 2; i++) {
      state.entities.push(new Entity(EntityType.SURVIVOR, 'hero', dest.col, dest.row, null, state));
    }
    const start = { col: cap.col, row: cap.row };

    const r = executeMarch(state, cap, dest.col, dest.row);
    assert.equal(r.success, true);
    assert.equal(r.marchPassengers.length, 1, 'one passenger fits');
    assert.equal(r.marchLeftBehind.length, 1, 'one passenger held back');
    const stayed = [s1, s2].find(s => r.marchLeftBehind.includes(s.id));
    assert.equal(stayed.col, start.col, 'overflow soldier remains on the start hex');
    assert.equal(stayed.row, start.row);
  });

  test('non-march factions cannot march', () => {
    const state = new GameState(true, true);
    const dest = clearNeighbor(state, state.hero);
    const r = executeMarch(state, state.hero, dest.col, dest.row);
    assert.equal(r.success, false);
  });

  test('getValidActions offers March only when a soldier shares the tile', () => {
    const { state, cap, s1, s2 } = marchFixture();
    const withTroops = getValidActions(state, cap);
    const march = withTroops.find(a => a.type === ActionType.MARCH);
    assert.ok(march, 'March surfaces with soldiers on the hex');
    assert.equal(march.passengers, 2);

    s1.hp = 0; s2.hp = 0;   // dead soldiers don't march
    const alone = getValidActions(state, cap);
    assert.equal(alone.find(a => a.type === ActionType.MARCH), undefined);
  });

  test('computeGhostState advances the passengers with the captain (multi-step planning)', () => {
    const { state, cap, s1, s2 } = marchFixture();
    const dest = clearNeighbor(state, cap);
    const plan = [{ type: PlanActionType.MARCH, entityId: cap.id, toCol: dest.col, toRow: dest.row }];
    const steps = computeGhostState(state, plan);
    assert.equal(steps.length, 1);
    for (const id of [cap.id, s1.id, s2.id]) {
      assert.deepEqual(steps[0].positions.get(id), { col: dest.col, row: dest.row },
        `ghost position of ${id} advanced to the march destination`);
    }
  });

  test('computeGhostState emits a plan arrow for the captain AND every marching passenger', () => {
    const { state, cap, s1, s2 } = marchFixture();
    const dest = clearNeighbor(state, cap);
    assert.ok(dest);
    const steps = computeGhostState(state,
      [{ type: PlanActionType.MARCH, entityId: cap.id, toCol: dest.col, toRow: dest.row }]);
    const step = steps[0];
    assert.equal(step.arrow.entityId, cap.id, 'the captain keeps the classic move arrow');
    const ids = (step.marchArrows ?? []).map(a => a.entityId).sort();
    assert.deepEqual(ids, [s1.id, s2.id].sort(), 'one passenger arrow per marching soldier');
    for (const a of step.marchArrows) {
      assert.deepEqual(
        { fromCol: a.fromCol, fromRow: a.fromRow, toCol: a.toCol, toRow: a.toRow },
        { fromCol: cap.col, fromRow: cap.row, toCol: dest.col, toRow: dest.row },
        'passenger arrows share the captain\'s from → to');
    }
    // A plain MOVE never carries passenger arrows.
    const moveSteps = computeGhostState(state,
      [{ type: PlanActionType.MOVE, entityId: cap.id, toCol: dest.col, toRow: dest.row }]);
    assert.equal(moveSteps[0].marchArrows, null);
  });

  test('overflow-stayers get no ghost arrow and their projected position holds the start hex', () => {
    const { state, cap, s1, s2 } = marchFixture();
    const dest = clearNeighbor(state, cap);
    assert.ok(dest);
    // Leave exactly TWO free slots at the destination (captain + one
    // passenger), mirroring the executeMarch overflow test above.
    const destTile = state.tiles.get(hexKey(dest.col, dest.row));
    const free = tileCapacityRemaining(destTile, 0);
    assert.ok(free >= 3, `fixture: destination needs >=3 free slots (has ${free})`);
    for (let i = 0; i < free - 2; i++) {
      state.entities.push(new Entity(EntityType.SURVIVOR, 'hero', dest.col, dest.row, null, state));
    }
    const steps = computeGhostState(state,
      [{ type: PlanActionType.MARCH, entityId: cap.id, toCol: dest.col, toRow: dest.row }]);
    const step = steps[0];
    assert.equal(step.marchArrows.length, 1, 'only the passenger that fits gets an arrow');
    // Passengers relocate in entity order (same rule as executeMarch): s1 fits.
    assert.equal(step.marchArrows[0].entityId, s1.id);
    assert.deepEqual(step.positions.get(s1.id), { col: dest.col, row: dest.row });
    assert.deepEqual(step.positions.get(s2.id), { col: cap.col, row: cap.row },
      'overflow soldier projected to hold the start hex');
  });

  test('validatePlanAction accepts a reachable MARCH and range-checks it like MOVE', () => {
    const { state, cap } = marchFixture();
    const reachable = getReachableHexes(state, cap, 1)[0];
    assert.ok(reachable);
    const ok = validatePlanAction(state, { type: PlanActionType.MARCH, entityId: cap.id, toCol: reachable.col, toRow: reachable.row });
    assert.equal(ok.valid, true);
    const far = validatePlanAction(state, { type: PlanActionType.MARCH, entityId: cap.id, toCol: cap.col + 9, toRow: cap.row + 9 });
    assert.equal(far.valid, false);
  });
});

// ── Survivor discovery penalty ───────────────────────────────────────────────

describe('survivorFindMultiplier — actor-keyed faction penalty', () => {
  test('captain finds survivors at 0.4×; paladin and no-actor calls are unchanged', () => {
    const state = captainState();
    assert.equal(survivorFindMultiplier(state), 1.0, 'no actor → base multiplier');
    assert.ok(Math.abs(survivorFindMultiplier(state, state.hero) - 0.4) < 1e-9);

    const paladinState = new GameState(true, true);
    assert.equal(survivorFindMultiplier(paladinState, paladinState.hero), 1.0);
  });

  test('faction penalty stacks multiplicatively with the active-survivor falloff', () => {
    const state = captainState();
    for (let i = 0; i < 5; i++) {
      const s = new Entity(EntityType.SURVIVOR, 'hero', 0, 0, null, state);
      state.entities.push(s);
    }
    // 5 active survivors → base 0.5; captain → ×0.4 = 0.2.
    assert.ok(Math.abs(survivorFindMultiplier(state, state.hero) - 0.2) < 1e-9);
  });
});

// ── Action economy ───────────────────────────────────────────────────────────

describe('Captain action budget', () => {
  test('+1 base budget over the paladin, resolved from the live leader', () => {
    const capState = captainState();
    const palState = new GameState(true, true);
    // DAWN: favorable phase for the day side (+1) — no units, no nodes.
    const capBudget = computeActions('hero', Phase.DAWN, capState.entities, 0);
    const palBudget = computeActions('hero', Phase.DAWN, palState.entities, 0);
    assert.equal(palBudget, 4);   // 3 base + 1 phase
    assert.equal(capBudget, 5);   // 4 base + 1 phase
  });

  test('action cap raised to 9 (paladin caps at 8)', () => {
    const capState = captainState();
    for (let i = 0; i < 6; i++) {
      capState.entities.push(createSoldier(capState.hero.col, capState.hero.row, null, capState));
    }
    // 4 base + 1 phase + 5 units (bonus cap) + 3 nodes = 13 → capped at 9.
    assert.equal(computeActions('hero', Phase.DAWN, capState.entities, 3), 9);

    const palState = new GameState(true, true);
    for (let i = 0; i < 6; i++) {
      const s = new Entity(EntityType.SURVIVOR, 'hero', 0, 0, null, palState);
      palState.entities.push(s);
    }
    assert.equal(computeActions('hero', Phase.DAWN, palState.entities, 3), 8);
  });

  test('per-player budget path honours the captain override too', () => {
    const capState = captainState();
    capState.hero.ownerId = 'player-1';
    const b = computeActionsForPlayer('player-1', 'hero', Phase.DAWN, capState.entities, 0);
    assert.equal(b, 5);
  });
});

// ── BUILD SIEGE ──────────────────────────────────────────────────────────────

describe('BUILD_SIEGE (executeBuildSiege)', () => {
  test('costs 4 wood + 1 metal and places a catapult on an adjacent hex', () => {
    const state = captainState();
    state.inventory.hero[ResourceType.WOOD]  = { count: SIEGE_WOOD_COST };
    state.inventory.hero[ResourceType.METAL] = { count: SIEGE_METAL_COST };

    const r = executeBuildSiege(state, state.hero);
    assert.equal(r.success, true);
    assert.equal(r.cost, 1);
    assert.equal((state.inventory.hero[ResourceType.WOOD]?.count ?? 0), 0);
    assert.equal((state.inventory.hero[ResourceType.METAL]?.count ?? 0), 0);

    const cat = state.entities.find(e => e.type === EntityType.CATAPULT);
    assert.ok(cat, 'catapult exists');
    assert.equal(cat.owner, 'hero');
    assert.equal(hexDistance(cat.col, cat.row, state.hero.col, state.hero.row), 1, 'adjacent to the captain');
    assert.equal(cat.getEquippedWeaponId(), 'catapult_stone');
    assert.equal(cat.getRange(), ITEMS.catapult_stone.range);
    assert.equal(r.built.id, cat.id);
  });

  test('fails without spending when resources are short', () => {
    const state = captainState();
    state.inventory.hero[ResourceType.WOOD]  = { count: SIEGE_WOOD_COST - 1 };
    state.inventory.hero[ResourceType.METAL] = { count: SIEGE_METAL_COST };
    const r = executeBuildSiege(state, state.hero);
    assert.equal(r.success, false);
    assert.equal(state.inventory.hero[ResourceType.WOOD].count, SIEGE_WOOD_COST - 1, 'nothing spent');
    assert.equal(state.inventory.hero[ResourceType.METAL].count, SIEGE_METAL_COST, 'nothing spent');
    assert.equal(state.entities.find(e => e.type === EntityType.CATAPULT), undefined);
  });

  test('non-captain leaders cannot build siege engines', () => {
    const state = new GameState(true, true);
    state.inventory.hero[ResourceType.WOOD]  = { count: 9 };
    state.inventory.hero[ResourceType.METAL] = { count: 9 };
    const r = executeBuildSiege(state, state.hero);
    assert.equal(r.success, false);
  });

  test('getValidActions surfaces Build Siege with an affordability flag', () => {
    const state = captainState();
    assert.ok(findSiegeSpawnHex(state, state.hero), 'fixture: a spawn hex exists');
    state.inventory.hero[ResourceType.WOOD]  = { count: 1 };
    state.inventory.hero[ResourceType.METAL] = { count: 0 };
    const broke = getValidActions(state, state.hero).find(a => a.type === ActionType.BUILD_SIEGE);
    assert.ok(broke, 'option surfaces even when unaffordable');
    assert.equal(broke.affordable, false);

    state.inventory.hero[ResourceType.WOOD]  = { count: SIEGE_WOOD_COST };
    state.inventory.hero[ResourceType.METAL] = { count: SIEGE_METAL_COST };
    const rich = getValidActions(state, state.hero).find(a => a.type === ActionType.BUILD_SIEGE);
    assert.equal(rich.affordable, true);
  });
});

// ── Immobile units ───────────────────────────────────────────────────────────

describe('Immobile units (catapult)', () => {
  test('the immobile tag is data-driven from UNIT_TYPES', () => {
    assert.equal(isImmobileType(EntityType.CATAPULT), true);
    assert.equal(isImmobileType(EntityType.SOLDIER), false);
    assert.equal(isImmobileType(EntityType.CAPTAIN), false);
    assert.ok(UNIT_TYPES.catapult.tags.includes('immobile'));
  });

  test('a catapult can never move — executeMove, plan validation, and the action list all refuse', () => {
    const state = captainState();
    const cat = createCatapult(state.hero.col, state.hero.row, null, state);
    state.entities.push(cat);
    const n = getNeighbors(cat.col, cat.row)[0];

    const r = executeMove(state, cat, n.col, n.row);
    assert.equal(r.success, false);

    const v = validatePlanAction(state, { type: PlanActionType.MOVE, entityId: cat.id, toCol: n.col, toRow: n.row });
    assert.equal(v.valid, false);

    const actions = getValidActions(state, cat);
    assert.equal(actions.find(a => a.type === ActionType.MOVE), undefined);
    assert.equal(actions.find(a => a.type === ActionType.MARCH), undefined);
  });

  test('a catapult shoots at weapon range (ranged targets in getValidActions + executeBattle)', () => {
    const state = captainState();
    const cat = createCatapult(state.hero.col, state.hero.row, null, state);
    state.entities.push(cat);
    // Plant a zombie 3 hexes out (within the stone's range-4 reach).
    let target = null;
    for (const [, t] of state.tiles) {
      if (hexDistance(t.col, t.row, cat.col, cat.row) === 3 &&
          legacyTileType(t) !== TileType.RIVER && !isBuildingFootprint(t)) {
        target = createZombie(t.col, t.row, null, state);
        state.entities.push(target);
        break;
      }
    }
    assert.ok(target, 'fixture: placed a zombie at distance 3');

    const battle = getValidActions(state, cat).find(a => a.type === ActionType.BATTLE);
    assert.ok(battle, 'catapult has battle targets');
    assert.ok(battle.targets.some(e => e.id === target.id), 'distant zombie is in range');

    const r = executeBattle(state, cat, target);
    assert.equal(r.success, true);
    assert.equal(r.ranged, true, 'catapult attack resolves as ranged');
  });

  test('a catapult is never offered EXPLORE, even on an unexplored tile', () => {
    const state = captainState();
    const cat = createCatapult(state.hero.col, state.hero.row, null, state);
    state.entities.push(cat);
    const t = clearFootprint(state.tiles.get(hexKey(cat.col, cat.row)));
    t.explored = false;

    const catActions = getValidActions(state, cat);
    assert.equal(catActions.find(a => a.type === ActionType.EXPLORE), undefined,
      'a stationary siege engine does not scout the ground it is bolted to');

    // Control: a mobile soldier on the SAME unexplored tile is offered
    // EXPLORE — the gate is the immobile tag, not the tile or the faction.
    const s = createSoldier(cat.col, cat.row, null, state);
    state.entities.push(s);
    assert.ok(getValidActions(state, s).find(a => a.type === ActionType.EXPLORE),
      'mobile units on the same tile still explore');
  });

  test('an immobile soldier-type could never be marched (passenger gate)', () => {
    // The passenger filter excludes immobile types even if a future immobile
    // unit carried the soldier type tag — executeMarch only carries mobile
    // SOLDIER entities. Guarded implicitly: a catapult on the captain's hex
    // never joins the march.
    const state = captainState();
    const cap = state.hero;
    const cat = createCatapult(cap.col, cap.row, null, state);
    state.entities.push(cat);
    const s = createSoldier(cap.col, cap.row, null, state);
    state.entities.push(s);
    const dest = clearNeighbor(state, cap);
    const r = executeMarch(state, cap, dest.col, dest.row);
    assert.equal(r.success, true);
    assert.equal(r.marchPassengers.length, 1, 'only the soldier marches');
    assert.equal(cat.col !== dest.col || cat.row !== dest.row, true, 'catapult stays put');
  });
});

// ── Serialization ────────────────────────────────────────────────────────────

describe('Serialization round-trip (soldier + catapult)', () => {
  test('a catapult survives serializeState → deserializeState with weapon, range, and tags', () => {
    const state = captainState();
    giveFood(state, 2);
    executeSummon(state, state.hero, EntityType.SOLDIER);
    state.inventory.hero[ResourceType.WOOD]  = { count: SIEGE_WOOD_COST };
    state.inventory.hero[ResourceType.METAL] = { count: SIEGE_METAL_COST };
    executeBuildSiege(state, state.hero);

    const snap = JSON.parse(JSON.stringify(serializeState(state)));
    const restored = deserializeState(snap);

    const cat = restored.entities.find(e => e.type === EntityType.CATAPULT);
    assert.ok(cat, 'catapult restored');
    assert.equal(cat.getEquippedWeaponId(), 'catapult_stone');
    assert.equal(cat.getRange(), ITEMS.catapult_stone.range);
    assert.ok(cat.hasTag('immobile'), 'immobile tag restored from UNIT_TYPES');
    assert.equal(isImmobileType(cat.type), true);

    const soldiers = restored.entities.filter(e => e.type === EntityType.SOLDIER);
    assert.equal(soldiers.length, 2, 'both soldiers restored');
    assert.ok(soldiers[0].alive, 'prototype getters work on restored soldiers');

    const leader = restored.entities.find(e => e.type === EntityType.CAPTAIN);
    assert.equal(leader.factionId, 'captain', 'concrete faction id survives the wire');
    // Budget override still resolves through the restored leader.
    assert.equal(computeActions('hero', Phase.DAWN, restored.entities, 0),
      4 + 1 + Math.min(3, 5), '4 base + 1 phase + 3 units (2 soldiers + catapult)');
  });
});
