// Captain faction — troop commander on the day side.
// Covers: CALL REINFORCEMENTS (SUMMON of soldier pairs), MARCH (leader + every
// soldier within 1 hex move as one action, keeping formation), BUILD_SIEGE
// (catapult), the
// survivor-discovery penalty, the bigger action economy, the immobile-unit
// mechanic, and serialization round-trips for the new entity types.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { GameState, Phase, computeActions, computeActionsForPlayer } from '../src/game.js';
import {
  executeMove, executeMarch, executeSummon, executeBuildSiege, executeBattle,
  executeSoundHorn,
  findSiegeSpawnHex, survivorFindMultiplier, getValidActions, getReachableHexes,
  computeMarchPlacements, ActionType,
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
import { hexKey, getNeighbors, hexDistance, offsetToAxial, axialToOffset } from '../src/hex.js';
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
    assert.ok(!c.hasAbility('sound_horn'), 'captain has no horn training at all (UI cards and the horn-item grant both key off the ability)');
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
// The captain has NO horn: he drops the day-side `sound_horn` ability (so the
// champion card shows no horn chip and game.js never issues him the Horn item)
// AND the action is faction-vetoed via `canSoundHorn()` as defense-in-depth —
// even a looted horn stays silent. His food funds troops, not horn calls.

describe('Sound Horn — captain veto (canSoundHorn predicate)', () => {
  test('getValidActions never offers SOUND_HORN to the captain, even with horn + food', () => {
    const state = captainState();
    giveFood(state, 5);
    // The captain is never ISSUED a horn (no sound_horn ability), but one can
    // be looted from a building — simulate that and prove it stays unusable.
    if (!state.hero.hasItem('horn')) state.hero.addItem('horn');
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

  // A passable, entity-free tile normalized to full capacity (no footprint /
  // trees / hidden survivor). Returns the tile, or null if the hex is a river
  // or off-map.
  function normalizeHex(state, col, row) {
    const t = state.tiles.get(hexKey(col, row));
    if (!t || legacyTileType(t) === TileType.RIVER || isBuildingFootprint(t)) return null;
    clearFootprint(t);
    t.blockedSlots = [];
    t.hiddenSurvivor = false;
    return t;
  }

  test('soldiers ADJACENT to the captain march too (within 1 hex), keeping formation', () => {
    const { state, cap, s1, s2 } = marchFixture(); // s1, s2 co-located on the captain
    const dest = clearNeighbor(state, cap);
    assert.ok(dest);
    // Pick an adjacent hex (not the captain's, not dest) whose formation-shift
    // target is also a real, passable tile; normalize both so the shift lands
    // deterministically (map geometry is random, so search every neighbour).
    const V = {
      q: offsetToAxial(dest.col, dest.row).q - offsetToAxial(cap.col, cap.row).q,
      r: offsetToAxial(dest.col, dest.row).r - offsetToAxial(cap.col, cap.row).r,
    };
    let adj = null, shiftHex = null;
    for (const n of getNeighbors(cap.col, cap.row)) {
      if (n.col === dest.col && n.row === dest.row) continue;
      if (state.entities.some(e => e.alive && e.col === n.col && e.row === n.row)) continue;
      const a = offsetToAxial(n.col, n.row);
      const sh = axialToOffset(a.q + V.q, a.r + V.r);
      if (!normalizeHex(state, n.col, n.row) || !normalizeHex(state, sh.col, sh.row)) continue;
      adj = n; shiftHex = sh; break;
    }
    assert.ok(adj, 'fixture needs an adjacent hex with a passable shift target');
    s1.col = adj.col; s1.row = adj.row;

    const r = executeMarch(state, cap, dest.col, dest.row);
    assert.equal(r.success, true);
    const p1 = r.marchPassengers.find(p => p.id === s1.id);
    assert.ok(p1, 'the adjacent soldier marches');
    assert.deepEqual({ col: p1.col, row: p1.row }, { col: shiftHex.col, row: shiftHex.row },
      'the adjacent soldier keeps formation (shifts by the captain vector)');
    assert.ok(r.marchPassengers.some(p => p.id === s2.id), 'the co-located soldier marches too');
  });

  test('soldiers 2+ hexes from the captain are NOT carried', () => {
    const { state, cap, s1, s2 } = marchFixture();
    const dest = clearNeighbor(state, cap);
    assert.ok(dest);
    // Park s1 two hexes away — scan the whole 2-ring for a real tile that isn't
    // the destination (single-neighbour scans flake near the map edge).
    let far = null;
    for (const n1 of getNeighbors(cap.col, cap.row)) {
      for (const n2 of getNeighbors(n1.col, n1.row)) {
        if (hexDistance(n2.col, n2.row, cap.col, cap.row) === 2 &&
            state.tiles.get(hexKey(n2.col, n2.row)) &&
            !(n2.col === dest.col && n2.row === dest.row)) { far = n2; break; }
      }
      if (far) break;
    }
    assert.ok(far, 'fixture needs a hex two away');
    s1.col = far.col; s1.row = far.row;

    const r = executeMarch(state, cap, dest.col, dest.row);
    assert.equal(r.success, true);
    assert.ok(!r.marchPassengers.some(p => p.id === s1.id), 'the far soldier is not a passenger');
    assert.equal(s1.col, far.col, 'the far soldier holds position');
    assert.equal(s1.row, far.row);
    // s2 (still co-located) does march.
    assert.ok(r.marchPassengers.some(p => p.id === s2.id));
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

// ── MARCH placement rule (computeMarchPlacements) ────────────────────────────
// The shared, deterministic rule the resolver, plan ghost, and AI all run:
// formation shift → converge → hold. Tested on a synthetic all-grass board (a
// plain {col,row} object is a full-capacity grass tile).

describe('computeMarchPlacements — formation, convergence, hold', () => {
  function grid(cols = 9, rows = 9) {
    const tiles = new Map();
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) tiles.set(hexKey(c, r), { col: c, row: r });
    return { tiles, entities: [] };
  }
  let _n = 0;
  function put(state, over) {
    const e = { id: `e${_n++}`, alive: true, owner: 'captain', type: EntityType.SOLDIER, col: 0, row: 0, ...over };
    state.entities.push(e);
    return e;
  }
  const shiftOf = (col, row, C, D) => {
    const a = offsetToAxial(col, row);
    const c = offsetToAxial(C.col, C.row), d = offsetToAxial(D.col, D.row);
    return axialToOffset(a.q + (d.q - c.q), a.r + (d.r - c.r));
  };

  test('every nearby soldier shifts by the captain move vector (formation preserved)', () => {
    const state = grid();
    const C = { col: 4, row: 4 }, D = { col: 5, row: 4 };
    const cap = put(state, { id: 'cap', type: EntityType.CAPTAIN, col: C.col, row: C.row });
    const soldiers = [put(state, { col: C.col, row: C.row })]; // co-located
    for (const n of getNeighbors(C.col, C.row)) {
      if (n.col === D.col && n.row === D.row) continue;         // dest stays the captain's
      soldiers.push(put(state, { col: n.col, row: n.row }));    // adjacent on every side
    }
    const farSoldier = put(state, { col: C.col + 3, row: C.row }); // 3 hexes away — excluded
    const placements = computeMarchPlacements(state, cap, C.col, C.row, D.col, D.row);
    for (const s of soldiers) {
      const pl = placements.find(p => p.id === s.id);
      const want = shiftOf(s.col, s.row, C, D);
      assert.deepEqual({ col: pl.toCol, row: pl.toRow }, { col: want.col, row: want.row },
        `${s.id} keeps formation (translates by the captain's move vector)`);
    }
    assert.ok(!placements.some(p => p.id === farSoldier.id),
      'a soldier more than 1 hex away is not a passenger');
  });

  test('a soldier whose shifted hex is blocked converges toward the destination', () => {
    const state = grid();
    const C = { col: 4, row: 4 }, D = { col: 5, row: 4 };
    const cap = put(state, { id: 'cap', type: EntityType.CAPTAIN, col: C.col, row: C.row });
    // A neighbour of C that is also adjacent to D (a shared neighbour).
    const A = getNeighbors(C.col, C.row).find(n =>
      !(n.col === D.col && n.row === D.row) && hexDistance(n.col, n.row, D.col, D.row) === 1);
    assert.ok(A, 'grid geometry provides a shared neighbour');
    put(state, { id: 'sA', col: A.col, row: A.row });
    // Block the formation-shift target so the shift is illegal.
    const want = shiftOf(A.col, A.row, C, D);
    put(state, { id: 'enemy', owner: 'witch', type: EntityType.ZOMBIE, col: want.col, row: want.row });

    const pl = computeMarchPlacements(state, cap, C.col, C.row, D.col, D.row).find(p => p.id === 'sA');
    assert.ok(!(pl.toCol === want.col && pl.toRow === want.row), 'the blocked shift is not taken');
    assert.ok(pl.toCol !== A.col || pl.toRow !== A.row, 'the soldier converges rather than holding');
    assert.ok(hexDistance(pl.toCol, pl.toRow, D.col, D.row) < hexDistance(A.col, A.row, D.col, D.row),
      'the converge step gets strictly closer to the destination');
  });

  test('a soldier that can neither shift nor converge holds position', () => {
    const state = grid();
    const C = { col: 4, row: 4 }, D = { col: 5, row: 4 };
    const cap = put(state, { id: 'cap', type: EntityType.CAPTAIN, col: C.col, row: C.row });
    const s = put(state, { id: 'sC', col: C.col, row: C.row }); // co-located
    // Fill D: TILE_CAPACITY (7) − captain (1) = 6 non-soldier fillers → no room.
    // A co-located soldier's only closer hex is D itself, so it can't converge.
    for (let i = 0; i < 6; i++) put(state, { id: `f${i}`, type: EntityType.SURVIVOR, col: D.col, row: D.row });

    const pl = computeMarchPlacements(state, cap, C.col, C.row, D.col, D.row).find(p => p.id === s.id);
    assert.deepEqual({ col: pl.toCol, row: pl.toRow }, { col: C.col, row: C.row },
      'the soldier holds on its start hex');
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

  test('action cap 8 (re-tuned from 9 when the AI learned MARCH + catapults)', () => {
    const capState = captainState();
    for (let i = 0; i < 6; i++) {
      capState.entities.push(createSoldier(capState.hero.col, capState.hero.row, null, capState));
    }
    // 4 base + 1 phase + 5 units (bonus cap) + 3 nodes = 13 → capped at 8.
    // (Cap was 9 while soldiers walked one at a time; MARCH moves the stack
    // on one action, so the raised cap over-fed the captain's strong rounds —
    // see CaptainFaction.actionCap.)
    assert.equal(computeActions('hero', Phase.DAWN, capState.entities, 3), 8);

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
